import { roomRevenue, setRoomRevenueIndex, roomRevenueIndex } from '../app.js';

// ============================================================================
// REVENUE INDEX (ex index.js) — índices en memoria de roomRevenue para
// búsquedas O(1) en vez de O(n). Renombrado para no chocar con la idea de
// "archivo de entrada" (ya existe src/core/firebase/index.js).
// ============================================================================

/**
 * Construye índices en memoria para búsquedas rápidas en roomRevenue
 * Reduce tiempo de búsqueda de O(n) a O(1)
 */
export function buildRevenueIndex() {
    console.log('[Index] Construyendo índices de roomRevenue...');
    const startTime = performance.now();
    
    setRoomRevenueIndex({
        byShift: { day: [], night: [] },
        byType: { sold: [], renewal: [], cleaned: [] },
        byTimestamp: new Map(),
        byRoomId: new Map()
    });
    
    roomRevenue.forEach((item, idx) => {
        // Índice por turno
        if (item.shift === 'day') {
            roomRevenueIndex.byShift.day.push(idx);
        } else if (item.shift === 'night') {
            roomRevenueIndex.byShift.night.push(idx);
        }
        
        // Índice por tipo
        if (item.type === 'sold') {
            roomRevenueIndex.byType.sold.push(idx);
        } else if (item.type === 'renewal') {
            roomRevenueIndex.byType.renewal.push(idx);
        } else if (item.type === 'cleaned') {
            roomRevenueIndex.byType.cleaned.push(idx);
        }
        
        // Índice por timestamp (para búsquedas por rango)
        roomRevenueIndex.byTimestamp.set(item.timestamp, idx);
        
        // Índice por roomId
        if (!roomRevenueIndex.byRoomId.has(item.roomId)) {
            roomRevenueIndex.byRoomId.set(item.roomId, []);
        }
        roomRevenueIndex.byRoomId.get(item.roomId).push(idx);
    });
    
    const endTime = performance.now();
    console.log(`[Index] ✓ Índices construidos en ${(endTime - startTime).toFixed(2)}ms`);
    console.log(`[Index] Total registros: ${roomRevenue.length}`);
}

/**
 * Obtiene ingresos del turno actual usando índices (RÁPIDO)
 */
export function getShiftRevenue(shiftType, startTimestamp) {
    if (!roomRevenueIndex) {
        console.warn('[Index] Índices no construidos, usando búsqueda lineal');
        return roomRevenue.filter(r => r.shift === shiftType && r.timestamp >= startTimestamp);
    }
    
    const indices = roomRevenueIndex.byShift[shiftType] || [];
    return indices
        .map(i => roomRevenue[i])
        .filter(r => r.timestamp >= startTimestamp);
}

/**
 * Obtiene ingresos por tipo usando índices (RÁPIDO)
 */
export function getRevenueByType(type, startTimestamp) {
    if (!roomRevenueIndex) {
        return roomRevenue.filter(r => r.type === type && r.timestamp >= startTimestamp);
    }
    
    const indices = roomRevenueIndex.byType[type] || [];
    return indices
        .map(i => roomRevenue[i])
        .filter(r => r.timestamp >= startTimestamp);
}

/**
 * Invalida índices cuando se modifica roomRevenue
 */
export function invalidateRevenueIndex() {
    setRoomRevenueIndex(null);
}

/**
 * Reconstruye índices si es necesario
 */
export function ensureRevenueIndex() {
    if (!roomRevenueIndex && roomRevenue.length > 0) {
        buildRevenueIndex();
    }
}