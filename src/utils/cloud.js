/** Une reservas locales con las de Firebase por id (gana el registro con updatedAt/createdAt más reciente). */
export function mergeReservationsFromCloud(cloud, local) {
    const byId = new Map();
    
    // Procesar locales primero
    local.filter(r => r?.id).forEach(r => byId.set(r.id, r));
    
    // El remoto solo gana si es estrictamente más reciente; en empate, el local prevalece
    cloud.filter(r => r?.id).forEach(r => {
        const existing = byId.get(r.id);
        if (!existing || (r.updatedAt ?? r.createdAt ?? 0) > (existing.updatedAt ?? existing.createdAt ?? 0)) {
            byId.set(r.id, r);
        }
    });
    
    return Array.from(byId.values());
}


/**
 * Une el inventario local con el de Firebase por id (gana el registro con
 * lastModified más reciente). El inventario antes se sincronizaba como
 * sobrescritura completa del arreglo (`inventory = val`): si dos
 * dispositivos vendían el mismo o distinto producto casi al mismo tiempo,
 * el que guardara último en Firestore borraba en silencio el descuento de
 * stock del otro. Fusionar por id evita que un snapshot desactualizado de
 * un dispositivo pise ediciones más recientes de otro.
 */
export function mergeInventoryFromCloud(cloud, local) {
    const byId = new Map();
    (Array.isArray(local) ? local : []).filter(i => i?.id != null).forEach(i => byId.set(i.id, i));
    (Array.isArray(cloud) ? cloud : []).filter(i => i?.id != null).forEach(i => {
        const existing = byId.get(i.id);
        if (!existing || (i.lastModified || 0) > (existing.lastModified || 0)) {
            byId.set(i.id, i);
        }
    });
    return Array.from(byId.values());
}