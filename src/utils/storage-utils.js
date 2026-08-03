import {
    // Variables de estado
    isSaving, _pendingFirebaseSave, roomRevenue, sales, expenses, inventory, staffMembers, announcements,
    currentUser, rooms, shiftReports, shiftSnapshots, currentShiftStart, currentShiftType, activityLog, 
    reservations, deepCleanSchedules, users,
    
    // Setters
    setIsSaving, setPendingFirebaseSave, setRoomRevenue, setSales, setExpenses, setInventory,
    setStaffMembers, setAnnouncements, _roomsReconciledWithCloud
} from '../app.js';

import { throttle } from './formatters.js';
import { invalidateRevenueIndex } from './revenue-index.js';
import { getRecordMonth } from './time.js';
import { getHotWindowMonths, _isInHotWindow } from './hot-window.js';
import { _shardStorageKey, loadMonthShard, persistHotShards } from './shards.js';
import { updateConnectionStatus } from '../features/connection.js';

// Recorta los arrays más grandes EN MEMORIA (no solo el string crudo de
// localStorage) para liberar espacio de emergencia cuando un guardado falla
// por cuota excedida. Siempre preserva los registros del turno actual.
// ANTES este recorte solo reescribía el string de localStorage sin tocar el
// arreglo en memoria (roomRevenue/sales/expenses seguían con todos sus
// registros) — el siguiente autoguardado, segundos después, volvía a
// serializar el arreglo completo y deshacía el recorte por completo, así
// que esta "válvula de emergencia" nunca funcionaba realmente.
function _pruneOldStorageRecords() {
    const shiftStart = currentShiftStart || 0;
    const EMERGENCY_CAP = 500;
    let trimmed = 0;

    function trim(arr) {
        if (!Array.isArray(arr) || arr.length <= EMERGENCY_CAP) return arr;
        const keep = arr.filter(r => (r.timestamp || 0) >= shiftStart);
        const extra = arr.filter(r => (r.timestamp || 0) < shiftStart).slice(-Math.max(0, EMERGENCY_CAP - keep.length));
        trimmed += arr.length - (keep.length + extra.length);
        return [...extra, ...keep];
    }

    setRoomRevenue(trim(roomRevenue));
    invalidateRevenueIndex();
    setSales(trim(sales));
    setExpenses(trim(expenses));

    if (trimmed > 0) {
        console.warn(`[Storage] Recortados ${trimmed} registros históricos antiguos (turno actual preservado) para liberar espacio de emergencia.`);
    }
    return trimmed;
}

// Avisa al usuario cuando localStorage supera el 90% del límite típico (5 MB).
// NO recorta datos automáticamente aquí: qué tanto historial conservar para
// reportes mensuales es una decisión de negocio, no algo para decidir en
// silencio. Solo informa — la limpieza real de emergencia ocurre en
// safeLocalStorageSet() si un guardado llega a fallar por cuota excedida.
export function checkStorageCapacity() {
    try {
        let usedBytes = 0;
        for (const k in localStorage) {
            if (Object.prototype.hasOwnProperty.call(localStorage, k)) {
                usedBytes += (k.length + localStorage[k].length) * 2;
            }
        }
        const usedMB = usedBytes / (1024 * 1024);
        if (usedMB > 4.5) {
            console.warn(`[Storage] ⚠️ localStorage al ${usedMB.toFixed(2)} MB (~90 % del límite típico de 5 MB)`);
            if (typeof showToast === 'function') {
                showToast(`⚠️ Almacenamiento casi lleno (${usedMB.toFixed(1)} MB). Esto es historial de ventas/gastos/ingresos acumulado — contacta al administrador para revisar cuánto conservar.`, 'warning');
            }
        }
        return usedMB;
    } catch (e) { return 0; }
}

export function safeLocalStorageGet(key, fallback = null) {
    try {
        const value = localStorage.getItem(key);
        if (value) return safeJSONParse(value, fallback);
    } catch (e) {}
    try {
        const value = sessionStorage.getItem(key);
        if (value) return safeJSONParse(value, fallback);
    } catch (e) {}
    if (window._memStorage && window._memStorage[key] !== undefined) {
        return safeJSONParse(window._memStorage[key], fallback);
    }
    return fallback;
}

// Safe localStorage set con fallback a sessionStorage y memoria
export function safeLocalStorageSet(key, value) {
    const serialized = JSON.stringify(value);
    try {
        localStorage.setItem(key, serialized);
    } catch (e) {
        if (e.name === 'QuotaExceededError') {
            // Paso 1: eliminar claves temporales y de respaldo
            try {
                Object.keys(localStorage).forEach(k => {
                    if (k.startsWith('backup_') || k.startsWith('temp_')) localStorage.removeItem(k);
                });
                localStorage.setItem(key, serialized);
            } catch (e2) {
                if (e2.name === 'QuotaExceededError') {
                    // Paso 2: recortar registros históricos grandes
                    try {
                        _pruneOldStorageRecords();
                        localStorage.setItem(key, serialized);
                        console.warn('[Storage] Almacenamiento liberado mediante recorte de historial.');
                    } catch (e3) {
                        console.error('[Storage] localStorage lleno incluso tras limpieza. Datos en riesgo al cerrar la pestaña.');
                        if (typeof showToast === 'function') {
                            showToast('⚠️ Almacenamiento lleno. Los datos pueden perderse al cerrar la pestaña.', 'error');
                        }
                    }
                }
            }
        }
    }
    try { sessionStorage.setItem(key, serialized); } catch (e) {}
    if (!window._memStorage) window._memStorage = {};
    window._memStorage[key] = serialized;
    return true;
}

export function safeJSONParse(str, fallback = null) {
    if (!str) return fallback;
    try {
        return JSON.parse(str);
    } catch (e) {
        console.error('[SafeParse] Error parsing JSON:', e);
        return fallback;
    }
}


export function safeGetElementById(id, warnIfMissing = false) {
    const element = document.getElementById(id);
    if (!element && warnIfMissing) {
        console.warn(`[DOM] Element with id "${id}" not found`);
    }
    return element;
}

// Limpieza única por sesión: antes de este cambio, los 3 meses de la ventana
// caliente (y cualquier mes "frío" que un director hubiera consultado alguna
// vez en el Reporte Mensual) se guardaban para siempre en localStorage bajo
// "motelShard_...". Ahora solo el mes actual vive ahí — esto elimina de un
// solo golpe todo lo demás que ya se había acumulado en dispositivos
// existentes, que era la causa directa del aviso de "almacenamiento casi
// lleno". Los datos no se pierden: siguen íntegros en Firebase.
export function _pruneStaleShardLocalStorage() {
    const current = getHotWindowMonths()[0];
    const currentSuffix = `_${current.year}_${current.month}`;
    try {
        Object.keys(localStorage).forEach(k => {
            if (k.startsWith('motelShard_') && !k.endsWith(currentSuffix)) {
                localStorage.removeItem(k);
            }
        });
    } catch (e) {}

    // Los arreglos planos de ANTES del sharding mensual (todo el historial en
    // un solo blob) se conservaban en localStorage como respaldo de la
    // migración, pero una vez que esta ya corrió y los shards existen, esos
    // 3 arreglos completos ya nunca se vuelven a leer — son puro peso muerto
    // que puede pesar varios MB si el negocio lleva tiempo operando. Firebase
    // conserva su propia copia de respaldo (esa sí no se toca); esto solo
    // limpia la copia local del navegador.
    try {
        if (safeLocalStorageGet('_shardMigrationDone', false)) {
            ['motelRoomRevenue', 'motelSales', 'motelExpenses'].forEach(k => localStorage.removeItem(k));
        }
    } catch (e) {}
}

// Carga inicial (arranque de la app, antes de que Firebase esté listo):
// llena roomRevenue/sales/expenses con los shards de la ventana caliente
// guardados en localStorage. Si este dispositivo todavía no tiene NINGÚN
// shard guardado (primera carga tras la migración, antes de que
// migrateToMonthlyShards() corra, o un dispositivo que aún no migró), cae de
// vuelta a los arreglos planos viejos filtrados a la ventana caliente en vez
// de arrancar con la vista vacía.
export function _loadHotShardsFromLocalStorage() {
    _pruneStaleShardLocalStorage();
    setRoomRevenue([]);
    setSales([]);
    setExpenses([]);
    let foundAnyShard = false;

    getHotWindowMonths().forEach(({ year, month }) => {
        ['revenue', 'sales', 'expenses'].forEach(type => {
            try {
                const raw = localStorage.getItem(_shardStorageKey(type, year, month));
                if (!raw) return;
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) return;
                foundAnyShard = true;
                if (type === 'revenue') roomRevenue.push(...parsed);
                else if (type === 'sales') sales.push(...parsed);
                else expenses.push(...parsed);
            } catch (e) {}
        });
    });

    if (!foundAnyShard) {
        const isHot = (item) => {
            const rm = getRecordMonth(item.timestamp);
            return _isInHotWindow(rm.year, rm.month);
        };
        setRoomRevenue(safeLocalStorageGet('motelRoomRevenue', []).filter(isHot));
        setSales(safeLocalStorageGet('motelSales', []).filter(isHot));
        setExpenses(safeLocalStorageGet('motelExpenses', []).filter(isHot));
    }
}


// FIXED: Función para limpiar registros eliminados antiguos (30 días)
export function cleanOldDeletedRecords() {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    let cleaned = 0;
    
    // Limpiar announcements
    const originalAnnouncementsLength = announcements.length;
    setAnnouncements(announcements.filter(a => !a.deleted || a.deletedAt > thirtyDaysAgo));
    cleaned += originalAnnouncementsLength - announcements.length;
    
    // Limpiar staffMembers
    const originalStaffLength = staffMembers.length;
    setStaffMembers(staffMembers.filter(s => !s.deleted || s.deletedAt > thirtyDaysAgo));
    cleaned += originalStaffLength - staffMembers.length;
    
    // Limpiar expenses
    const originalExpensesLength = expenses.length;
    setExpenses(expenses.filter(e => !e.deleted || e.deletedAt > thirtyDaysAgo));
    cleaned += originalExpensesLength - expenses.length;

    // Limpiar inventario
    const originalInventoryLength = inventory.length;
    setInventory(inventory.filter(i => !i.deleted || i.deletedAt > thirtyDaysAgo));
    cleaned += originalInventoryLength - inventory.length;

    if (cleaned > 0) {
        console.log(`[Cleanup] ${cleaned} registros eliminados permanentemente (>30 días)`);
    }
}


// Save data to localStorage AND Firebase (con throttle para optimizar)
export const saveDataThrottled = throttle(async function() {
    // VALIDACIÓN CRÍTICA: NO guardar si los datos están vacíos
    if (!rooms || rooms.length === 0 || !Array.isArray(rooms)) {
        console.error('[SaveData] ❌ BLOQUEADO: rooms inválido');
        return;
    }

    // Limpiar registros eliminados antiguos (solo director)
    if (currentUser && currentUser.role === 'director') {
        cleanOldDeletedRecords();
    }

    // Guardar en localStorage SIEMPRE (síncrono, antes del guard de Firebase)
    // Esto garantiza que los datos estén en localStorage incluso si Firebase está ocupado
    try {
        localStorage.setItem('motelRooms', JSON.stringify(rooms));
        localStorage.setItem('motelInventory', JSON.stringify(inventory));
        localStorage.setItem('motelShiftReports', JSON.stringify(shiftReports));
        localStorage.setItem('motelShiftSnapshots', JSON.stringify(shiftSnapshots));
        localStorage.setItem('motelCurrentShiftStart', JSON.stringify(currentShiftStart));
        localStorage.setItem('motelCurrentShiftType', currentShiftType || '');
        localStorage.setItem('motelActivityLog', JSON.stringify(activityLog));
        localStorage.setItem('motelReservations', JSON.stringify(reservations));
        localStorage.setItem('deepCleanSchedules', JSON.stringify(deepCleanSchedules));
        localStorage.setItem('motelStaffMembers', JSON.stringify(staffMembers));
        localStorage.setItem('motelAnnouncements', JSON.stringify(announcements));
    } catch (e) {
        console.error('[SaveData] Error guardando en localStorage:', e);
    }

    // roomRevenue/sales/expenses ya no se guardan como blob plano — se
    // reparten en shards por mes (ver sección SHARDING MENSUAL arriba).
    persistHotShards();

    // Guarda cada habitación como su PROPIO documento en Firestore (ver
    // "COLECCIÓN DEDICADA" en firebase-sync.js). _fbSave/saveRoom ya tienen
    // su propio caché de "sin cambios desde el último guardado", así que
    // llamar esto en cada ciclo de guardado (aunque solo 1 de 32 habitaciones
    // haya cambiado de verdad) no genera 32 escrituras reales. Solo se hace
    // una vez que `rooms` ya se reconcilió con la nube (ver
    // _roomsReconciledWithCloud) — antes de eso, reenviar la copia local
    // (posiblemente desactualizada) podía pisar un cambio real hecho en otro
    // dispositivo mientras este estaba cerrado.
    if (_roomsReconciledWithCloud && window.FirebaseSync && window.FirebaseSync.saveRoom && Array.isArray(rooms)) {
        rooms.forEach(r => { if (r && r.id) window.FirebaseSync.saveRoom(r.id, r); });
    }

    if (window.FirebaseSync && window.FirebaseSync.ready) {
        // Si ya hay un guardado en curso en Firebase, marcar que hace falta
        // otro guardado apenas termine el actual, en vez de descartarlo.
        // Descartarlo sin más dejaba cambios (p.ej. una habitación marcada
        // 'dirty') solo en localStorage, sin subir nunca a Firebase, hasta
        // que otra acción cualquiera disparara un nuevo guardado.
        if (isSaving) { setPendingFirebaseSave(true); return; }

        setIsSaving(true);
        setPendingFirebaseSave(false);

        // VALIDACIÓN: Verificar 32 habitaciones antes de subir a Firebase
        if (rooms.length < 32) {
            console.error('[SaveData] Solo ' + rooms.length + ' habitaciones, esperadas 32. No se guardará en Firebase.');
            setIsSaving(false);
            return;
        }

        window.FirebaseSync.saveAll({
            motelRooms: rooms,
            motelInventory: inventory,
            motelShiftReports: shiftReports,
            motelShiftSnapshots: shiftSnapshots,
            motelCurrentShiftStart: currentShiftStart,
            motelCurrentShiftType: currentShiftType,
            motelActivityLog: activityLog,
            motelReservations: reservations,
            deepCleanSchedules: deepCleanSchedules,
            motelStaffMembers: staffMembers,
            motelAnnouncements: announcements,
            motelUsers: users
        }).then(() => {
            if (window.FirebaseSync.isOnline()) {
                updateConnectionStatus(true, 0);
            }
        }).catch(err => {
            console.error('[Firebase] Error guardando datos:', err);
            updateConnectionStatus(window.FirebaseSync.isOnline(), 0);
        }).finally(() => {
            setIsSaving(false);
            if (_pendingFirebaseSave) {
                setPendingFirebaseSave(false);
                saveData();
            }
        });
    } else {
        updateConnectionStatus(false, 0);
    }
}, 2000); // Throttle: máximo 1 guardado cada 2 segundos


export function saveData() {
    saveDataThrottled();
}

// Guarda inmediatamente sin esperar el throttle.
// Usar SOLO cuando el tiempo es crítico (ej: app yendo a background).
export function _saveDataImmediate() {
    if (!currentUser || !rooms || rooms.length < 32) return;
    try {
        localStorage.setItem('motelRooms',       JSON.stringify(rooms));
        localStorage.setItem('motelInventory',   JSON.stringify(inventory));
    } catch(e) {}
    persistHotShards();
    // Guarda cada habitación como su PROPIO documento en Firestore (ver
    // "COLECCIÓN DEDICADA" en firebase-sync.js). Mismo guard de
    // _roomsReconciledWithCloud que saveDataThrottled — ver comentario ahí.
    if (_roomsReconciledWithCloud && window.FirebaseSync && window.FirebaseSync.saveRoom && Array.isArray(rooms)) {
        rooms.forEach(r => { if (r && r.id) window.FirebaseSync.saveRoom(r.id, r); });
    }
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        // Igual que en saveDataThrottled: si ya hay un guardado en curso, no
        // descartar este cambio — marcarlo pendiente para que se reintente
        // apenas termine el guardado actual. Antes esto se descartaba sin
        // más, dejando ocupaciones/precios varados solo en localStorage
        // hasta que otra acción cualquiera disparara un nuevo guardado.
        if (isSaving) { setPendingFirebaseSave(true); return; }

        setIsSaving(true);
        setPendingFirebaseSave(false);
        window.FirebaseSync.saveAll({
            motelRooms:       rooms,
            motelInventory:   inventory,
        }).finally(() => {
            setIsSaving(false);
            if (_pendingFirebaseSave) {
                setPendingFirebaseSave(false);
                saveData();
            }
        });
    }
}



// Firestore rechaza documentos de más de ~1 MiB. Un mes con mucho historial
// de ventas/gastos/ingresos puede acercarse o superar ese límite, y a
// diferencia de un error de conectividad ese guardado NUNCA se recupera solo
// reintentando — se queda "pendiente" para siempre (esto es lo que causaba
// el badge de sincronización atorado). En vez de descartar historial para
// caber en el límite, el shard se reparte en documentos "_p0", "_p1", ...
// Se deja margen de sobra (700 KB de 1 MiB) para no filo con el límite real.
export const MAX_SHARD_BYTES = 700 * 1024;
// Tope de particiones a las que nos suscribimos en tiempo real. 8 partes de
// 700 KB son ~5.6 MB de historial de un solo tipo (revenue/sales/expenses)
// en UN mes — muy por encima de cualquier volumen real de un solo motel. Si
// algún mes llegara a superarlo, sus datos igual se cargarían completos en
// cada refresco de página (_loadShardFromFirebase no tiene tope), solo se
// retrasaría la actualización en vivo de las partes extra.
export const MAX_SHARD_LISTEN_PARTS = 8;

export function _splitIntoChunks(records, maxBytes) {
    const chunks = [];
    let current = [];
    let currentSize = 2; // '[' + ']'
    records.forEach(rec => {
        const recSize = JSON.stringify(rec).length + 1; // +1 por la coma separadora
        if (current.length > 0 && currentSize + recSize > maxBytes) {
            chunks.push(current);
            current = [];
            currentSize = 2;
        }
        current.push(rec);
        currentSize += recSize;
    });
    if (current.length > 0) chunks.push(current);
    return chunks;
}

// Caché temporal de UN mes "frío" para el Reporte Mensual — nunca se
// persiste, se descarta en cuanto se consulta otro mes. Poblada por
// ensureMonthDataLoaded() (async); getMonthRecords() la lee de forma
// síncrona para no tener que convertir en async las ~7 funciones del
// Reporte Mensual que hoy filtran roomRevenue/sales/expenses directamente.
export let _coldMonthCache = { key: null, revenue: [], sales: [], expenses: [] };

// Llamar (con await) ANTES de generar/exportar el Reporte Mensual para un
// año/mes dado. Si ese mes ya está en la ventana caliente no hace nada (los
// datos ya están en memoria); si es un mes viejo, lo trae una sola vez y lo
// deja listo para que getMonthRecords() lo lea de forma síncrona.
export async function ensureMonthDataLoaded(year, month) {
    if (_isInHotWindow(year, month)) return;
    const key = `${year}_${month}`;
    if (_coldMonthCache.key === key) return;
    const [revenue, sales, expenses] = await Promise.all([
        loadMonthShard(year, month, 'revenue'),
        loadMonthShard(year, month, 'sales'),
        loadMonthShard(year, month, 'expenses')
    ]);
    _coldMonthCache = { key, revenue, sales, expenses };
}