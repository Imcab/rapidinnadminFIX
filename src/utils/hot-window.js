import { _pushAppDebug } from "./logger";
import { handleFirebaseRealtimeUpdate } from "../system";
import { _shardFirebaseKey } from "./shards";
import { _shardPartitionedCombos,
     rooms, _hotWindowAnchorKey,roomRevenue,
      sales, expenses,setExpenses, reservations, setHotWindowAnchorKey, setRoomRevenue, setSales
} from "../app";
import { getRecordMonth } from './time.js';
import { _coldMonthCache } from "./storage-utils";

// ============================================================================
// HOT WINDOW — ventana caliente de meses (revenue/sales/expenses) y la
// reactivación de listeners en tiempo real ligada a ella. Extraído de
// app.js (era el último grupo de infraestructura de sync que quedaba ahí).
// ============================================================================
const HOT_WINDOW_MONTHS = 3;

let _lastListenerReactivation = 0;
const LISTENER_REACTIVATION_MIN_GAP_MS = 5000;

export let _hotShardListenerKeys = [];

export function getHotWindowMonths(referenceDate = new Date()) {
    const months = [];
    for (let i = 0; i < HOT_WINDOW_MONTHS; i++) {
        const d = new Date(referenceDate.getFullYear(), referenceDate.getMonth() - i, 1);
        months.push({ year: d.getFullYear(), month: d.getMonth() });
    }
    return months;
}

export function _isInHotWindow(year, month) {
    return getHotWindowMonths().some(m => m.year === year && m.month === month);
}

export function getMonthRecords(year, month, type) {
    const hotArray = type === 'revenue' ? roomRevenue : (type === 'sales' ? sales : expenses);
    if (_isInHotWindow(year, month)) {
        return hotArray.filter(item => {
            const rm = getRecordMonth(item.timestamp);
            return rm.year === year && rm.month === month;
        });
    }
    const key = `${year}_${month}`;
    if (_coldMonthCache.key !== key) {
        console.warn(`[Shard] getMonthRecords(${key}, ${type}) llamado sin ensureMonthDataLoaded previo — devolviendo vacío`);
        return [];
    }
    return _coldMonthCache[type] || [];
}

export function _reactivateRealtimeListeners(reason) {
    const now = Date.now();
    if (now - _lastListenerReactivation < LISTENER_REACTIVATION_MIN_GAP_MS) {
        console.log(`[Sync] Reactivación de listeners (${reason}) omitida — ya se hizo hace <5s`);
        _pushAppDebug('reactivate-skipped', reason);
        return;
    }
    _lastListenerReactivation = now;
    console.log(`[Sync] Reactivando listeners en tiempo real (${reason})`);
    _pushAppDebug('reactivate', reason);
    if (window.FirebaseSync && window.FirebaseSync.listenAll) {
        window.FirebaseSync.listenAll(handleFirebaseRealtimeUpdate);
    }
    _subscribeHotWindowListeners();
    _subscribeRoomDocListeners();
}

export function _subscribeRoomDocListeners() {
    if (!window.FirebaseSync || !window.FirebaseSync.listenRoom || !Array.isArray(rooms)) return;
    rooms.forEach(r => {
        if (!r || !r.id) return;
        window.FirebaseSync.listenRoom(r.id, (roomId, incomingRoom) => {
            if (!incomingRoom || !incomingRoom.id) return;
            const idx = rooms.findIndex(x => x && x.id === incomingRoom.id);
            if (idx === -1) return;
            rooms[idx] = incomingRoom;
            try { localStorage.setItem('motelRooms', JSON.stringify(rooms)); } catch (e) {}

            if (currentUser && currentUser.role === 'limpieza') renderCleaningRooms();
            else renderRooms();
            renderReservationsSidebar();

            if (document.getElementById('shift-control-tab')?.classList.contains('active')) {
                updateShiftControl();
            } else {
                _shiftDataStale = true;
            }
            updateStatistics();
        });
    });
}

export function _subscribeHotWindowListeners() {
    if (!window.FirebaseSync || !window.FirebaseSync.listenKey) return;
    _hotShardListenerKeys.forEach(k => window.FirebaseSync.unlistenKey(k));
    _hotShardListenerKeys = [];

    getHotWindowMonths().forEach(({ year, month }) => {
        ['revenue', 'sales', 'expenses'].forEach(type => {
            const baseKey = _shardFirebaseKey(type, year, month);
            const onShardUpdate = (_key, val) => {
                if (!Array.isArray(val) || !_isInHotWindow(year, month)) return;
                if (type === 'revenue') {
                    setRoomRevenue(mergeArraysById(val, roomRevenue));
                    invalidateRevenueIndex();
                } else if (type === 'sales') {
                    setSales(mergeArraysById(val, sales));
                } else {
                    setExpenses(mergeArraysById(val, expenses));
                }
                // El merge de arriba ya quedó aplicado en memoria pase lo que
                // pase abajo. Todo lo demás es refresco de UI — se aísla en su
                // propio try/catch para que una excepción ahí (p.ej. un
                // elemento del DOM que no existe para el rol actual) no deje
                // el dato mergeado sin reflejarse nunca en pantalla ni en el
                // próximo cambio de pestaña. Antes esto podía fallar en
                // silencio: listenKey() en firebase-sync.js envuelve TODO
                // este callback en un único try/catch genérico que lo
                // etiqueta (incorrectamente) como "Error parsing".
                try {
                    if (type === 'sales') renderSalesLog();
                    else if (type === 'expenses') updateExpensesTotal();
                    updateStatistics();
                    if (document.getElementById('shift-control-tab')?.classList.contains('active')) {
                        updateShiftControl();
                    } else {
                        _shiftDataStale = true;
                    }
                } catch (e) {
                    console.error('[Shard] Error refrescando UI tras cambio remoto:', type, e);
                    _pushAppDebug('shard-ui-refresh-error', `${type}: ${e.message}`);
                    _shiftDataStale = true; // al menos garantizar el refresco al cambiar de pestaña
                }
            };
            // Se escucha la clave plana (mes normal) siempre. Las particiones
            // (ver MAX_SHARD_LISTEN_PARTS) SOLO se escuchan si ya sabemos por
            // _loadShardFromFirebase() que ese mes/tipo está realmente
            // particionado (shard > 700KB) — antes se suscribían las 8 "por
            // si acaso" para los 9 combos de mes×tipo, 81 listeners en total,
            // aunque casi ninguno tiene datos reales jamás. Registrar tantos
            // listeners de golpe (81, sumados a los 15 de motelRooms/etc.)
            // era lo que hacía que Firestore rechazara la mayoría con errores
            // "already-exists" en el celular — motelRooms sí sincronizaba
            // (solo 15 listeners) pero ingresos/ventas/gastos se quedaban
            // muertos. Si un mes cruza el umbral de 700KB en vivo durante la
            // sesión, sus particiones nuevas se recogen en la próxima
            // recarga completa (rollover de hora, o volver del background).
            //
            // IMPORTANTE: saveShardData()/loadShardData() (firebase-sync.js)
            // anteponen el prefijo "shard_" al nombre real del documento en
            // Firestore — igual que saveMrData/loadMrData anteponen "mr_"
            // (ver setupMrDataListener, que sí arma la clave completa antes
            // de llamar a listenKey). Aquí faltaba anteponer ese mismo
            // prefijo antes de llamar a listenKey(), así que el listener se
            // registraba bajo un doc.id que Firestore nunca iba a emitir
            // (p.ej. "revenue_2026_6" en vez de "shard_revenue_2026_6") — el
            // callback jamás se disparaba con datos reales, en ningún
            // dispositivo, todo el tiempo. Ingresos/ventas/gastos solo se
            // veían actualizados tras un reload completo (que sí usa el
            // prefijo correcto vía _loadShardFromFirebase), nunca en vivo.
            const listenBaseKey = 'shard_' + baseKey;
            _hotShardListenerKeys.push(listenBaseKey);
            window.FirebaseSync.listenKey(listenBaseKey, onShardUpdate);
            const comboKey = `${type}_${year}_${month}`;
            if (_shardPartitionedCombos.has(comboKey)) {
                for (let p = 0; p < MAX_SHARD_LISTEN_PARTS; p++) {
                    const partKey = `${listenBaseKey}_p${p}`;
                    _hotShardListenerKeys.push(partKey);
                    window.FirebaseSync.listenKey(partKey, onShardUpdate);
                }
            }
        });
    });
}

export function rolloverHotWindowIfNeeded() {
    const now = new Date();
    const currentKey = `${now.getFullYear()}_${now.getMonth()}`;
    if (_hotWindowAnchorKey === currentKey) return;

    const isFirstRun = _hotWindowAnchorKey === null;
    setHotWindowAnchorKey(currentKey);

    if (!isFirstRun) {
        const keep = (item) => {
            const rm = getRecordMonth(item.timestamp);
            return _isInHotWindow(rm.year, rm.month);
        };
        setRoomRevenue(roomRevenue.filter(keep));
        invalidateRevenueIndex();
        setSales(sales.filter(keep));
        setExpenses(expenses.filter(keep));
        console.log('[Shard] Ventana caliente rotada a', currentKey);
    }

    _subscribeHotWindowListeners();
}