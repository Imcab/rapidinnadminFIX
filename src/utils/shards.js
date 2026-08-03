import { roomRevenue, sales, expenses, setRoomRevenue, setSales, setExpenses, _shardPartitionedCombos } from '../app.js';

import { safeLocalStorageGet, safeLocalStorageSet, _saveDataImmediate, _splitIntoChunks, ensureMonthDataLoaded, MAX_SHARD_BYTES } from './storage-utils.js';
import { mergeArraysById } from './formatters.js';
import { invalidateRevenueIndex } from './revenue-index.js';
import { _groupByMonth, _isCurrentHotMonth, getRecordMonth } from './time.js';
import { getHotWindowMonths, _isInHotWindow } from './hot-window.js';

export function _shardStorageKey(type, year, month) {
    return `motelShard_${type}_${year}_${month}`;
}

export function _shardFirebaseKey(type, year, month) {
    return `${type}_${year}_${month}`;
}

export async function _loadShardFromFirebase(type, year, month) {
    const baseKey = _shardFirebaseKey(type, year, month);
    const comboKey = `${type}_${year}_${month}`;
    const part0 = await window.FirebaseSync.loadShardData(`${baseKey}_p0`, null);
    if (Array.isArray(part0)) {
        _shardPartitionedCombos.add(comboKey);
        let all = part0.slice();
        let i = 1;
        while (true) {
            const part = await window.FirebaseSync.loadShardData(`${baseKey}_p${i}`, null);
            if (!Array.isArray(part)) break;
            all = all.concat(part);
            i++;
        }
        return all;
    }
    _shardPartitionedCombos.delete(comboKey);
    return await window.FirebaseSync.loadShardData(baseKey, null);
}

export function _persistShardsFor(type, arr) {
    _groupByMonth(arr).forEach((records, key) => {
        const [year, month] = key.split('_').map(Number);
        if (_isCurrentHotMonth(year, month)) {
            try {
                localStorage.setItem(_shardStorageKey(type, year, month), JSON.stringify(records));
            } catch (e) {
                console.error(`[Shard] Error guardando ${type} ${key} en localStorage:`, e);
            }
        } else {
            // Meses no-actuales: eliminar cualquier copia vieja en localStorage
            // (de versiones anteriores de la app) para liberar espacio ya mismo.
            try { localStorage.removeItem(_shardStorageKey(type, year, month)); } catch (e) {}
        }
        _saveShardToFirebase(type, year, month, records);
    });
}


// Carga bajo demanda los registros de UN mes específico (roomRevenue/sales/
// expenses), esté o no dentro de la ventana caliente. Usado por el Reporte
// Mensual al navegar a un mes distinto del actual. `type` es 'revenue',
// 'sales' o 'expenses'.
export async function loadMonthShard(year, month, type) {
    const hotArray = type === 'revenue' ? roomRevenue : (type === 'sales' ? sales : expenses);
    if (_isInHotWindow(year, month)) {
        // Ya está en memoria — filtrar directamente, sin round-trip.
        return hotArray.filter(item => {
            const rm = getRecordMonth(item.timestamp);
            return rm.year === year && rm.month === month;
        });
    }

    // Mes frío: se trae de Firebase (que ya resuelve rápido desde su propio
    // caché local de Firestore cuando está disponible). Ya NO se duplica en
    // localStorage: guardar aquí cada mes distinto que un director consulta
    // en el Reporte Mensual, para siempre y sin límite, era otra fuente de
    // crecimiento indefinido de "almacenamiento casi lleno". El caché en
    // memoria _coldMonthCache (ver ensureMonthDataLoaded) ya evita refetch
    // mientras se navega el mismo mes en una sesión.
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        try {
            const remote = await _loadShardFromFirebase(type, year, month);
            if (Array.isArray(remote)) return remote;
        } catch (e) {
            console.error(`[Shard] Error cargando ${type} ${year}_${month}:`, e);
        }
    }
    return [];
}

// Carga desde Firebase (al iniciar sesión / reconectar): trae los shards de
// la ventana caliente y los fusiona (mergeArraysById) con lo que ya hay en
// memoria desde localStorage.
export async function _loadHotShardsFromFirebase() {
    if (!window.FirebaseSync || !window.FirebaseSync.ready) return;
    const months = getHotWindowMonths();
    const tasks = [];
    months.forEach(({ year, month }) => {
        ['revenue', 'sales', 'expenses'].forEach(type => {
            tasks.push(
                _loadShardFromFirebase(type, year, month)
                    .then(remote => ({ type, remote }))
                    .catch(() => ({ type, remote: null }))
            );
        });
    });
    const results = await Promise.all(tasks);
    results.forEach(({ type, remote }) => {
        if (!Array.isArray(remote) || remote.length === 0) return;
        if (type === 'revenue') setRoomRevenue(mergeArraysById(remote, roomRevenue));
        else if (type === 'sales') setSales(mergeArraysById(remote, sales));
        else setExpenses(mergeArraysById(remote, expenses));
    });
    invalidateRevenueIndex();
}


// Guarda un shard mensual en Firebase, partiéndolo en varios documentos si
// hace falta (ver comentario de MAX_SHARD_BYTES arriba). No se pierde ni
// descarta ningún registro: solo se distribuye entre más documentos.
//
// persistHotShards() reescribe los 3 meses de la ventana caliente en CADA
// guardado, aunque casi siempre solo el mes actual cambió de verdad (una
// venta/renovación usa Date.now(), nunca toca meses viejos) — eso son 9
// escrituras (revenue/sales/expenses × 3 meses) por acción, la mayoría
// redundantes. No hace falta filtrar eso aquí: _fbSave() (firebase-sync.js)
// ya compara el contenido contra el último guardado exitoso y omite la
// escritura a Firestore si no cambió nada, así que las llamadas de más
// terminan siendo baratas (comparación en memoria) en vez de tráfico de red
// real — que es lo que agotaba la cola de escritura del cliente
// (resource-exhausted: "Write stream exhausted maximum allowed queued
// writes") cuando varias ventas seguidas disparaban guardados inmediatos.
export function _saveShardToFirebase(type, year, month, records) {
    if (!window.FirebaseSync || !window.FirebaseSync.ready) return;
    const baseKey = _shardFirebaseKey(type, year, month);
    const serialized = JSON.stringify(records);

    if (serialized.length <= MAX_SHARD_BYTES) {
        window.FirebaseSync.saveShardData(baseKey, records)
            .catch(e => console.error(`[Shard] Error guardando ${type} ${year}_${month} en Firebase:`, e));
        return;
    }

    const chunks = _splitIntoChunks(records, MAX_SHARD_BYTES);
    console.warn(`[Shard] ${type} ${year}_${month}: ${(serialized.length / 1024).toFixed(0)} KB supera el límite de un documento — dividiendo en ${chunks.length} partes.`);
    Promise.all(chunks.map((chunk, i) => window.FirebaseSync.saveShardData(`${baseKey}_p${i}`, chunk)))
        .then(() => {
            // El documento plano viejo queda obsoleto una vez que el mes se reparte
            // en partes; se limpia SOLO después de que todas las partes se guardaron bien.
            return window.FirebaseSync.saveShardData(baseKey, null);
        })
        .catch(e => console.error(`[Shard] Error guardando partes de ${type} ${year}_${month} en Firebase:`, e));
}

// Guarda roomRevenue/sales/expenses (que en todo momento solo deberían
// contener registros de la ventana caliente) como shards por mes, en vez de
// un único blob plano. Se llama junto con saveDataThrottled/_saveDataImmediate.
export function persistHotShards() {
    _persistShardsFor('revenue', roomRevenue);
    _persistShardsFor('sales', sales);
    _persistShardsFor('expenses', expenses);
}


// Migración única: reparte los 3 documentos planos viejos (todo el historial
// en un solo blob) en shards por mes. Los documentos planos NO se borran —
// quedan como respaldo. Gateada por una bandera persistida para correr una
// sola vez por instalación.
export async function migrateToMonthlyShards() {
    if (!window.FirebaseSync || !window.FirebaseSync.ready) return;
    if (safeLocalStorageGet('_shardMigrationDone', false)) return;

    console.log('[Shard] Iniciando migración única a shards mensuales...');
    try {
        const [oldRevenue, oldSales, oldExpenses] = await Promise.all([
            window.FirebaseSync.load('motelRoomRevenue', []),
            window.FirebaseSync.load('motelSales', []),
            window.FirebaseSync.load('motelExpenses', [])
        ]);

        _persistShardsFor('revenue', Array.isArray(oldRevenue) ? oldRevenue : []);
        _persistShardsFor('sales', Array.isArray(oldSales) ? oldSales : []);
        _persistShardsFor('expenses', Array.isArray(oldExpenses) ? oldExpenses : []);

        safeLocalStorageSet('_shardMigrationDone', true);
        console.log('[Shard] Migración a shards mensuales completada. Documentos planos viejos preservados como respaldo.');
    } catch (e) {
        console.error('[Shard] Error durante la migración a shards mensuales:', e);
    }
}