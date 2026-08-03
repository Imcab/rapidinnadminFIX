import { log, warn, error } from '../core/firebase/config.js';

const RELEVANT_PREFIXES = ['motel', '_pwd_', '_offlineQueue'];

function isRelevantKey(key) {
    return !!key && RELEVANT_PREFIXES.some(p => key.startsWith(p));
}

export async function clearAppCache(fullReset = false) {
    try {
        log('[Storage Utils] Iniciando limpieza de caché y almacenamiento...');

        if (fullReset) {
            localStorage.clear();
            try { sessionStorage.clear(); } catch (e) {}
            window._memStorage = {};
            log('[Storage Utils] LocalStorage, sessionStorage y memoria completamente purgados.');
        } else {
            const deviceId = localStorage.getItem('_deviceId');

            // localStorage
            const lsKeysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (isRelevantKey(key)) lsKeysToRemove.push(key);
            }
            lsKeysToRemove.forEach(k => localStorage.removeItem(k));

            // sessionStorage — antes no se tocaba, y safeLocalStorageGet() cae
            // acá si no encuentra la clave en localStorage, así que dejar esto
            // sin limpiar hacía que "datos viejos" resucitaran tras el reset.
            try {
                const ssKeysToRemove = [];
                for (let i = 0; i < sessionStorage.length; i++) {
                    const key = sessionStorage.key(i);
                    if (isRelevantKey(key)) ssKeysToRemove.push(key);
                }
                ssKeysToRemove.forEach(k => sessionStorage.removeItem(k));
            } catch (e) {}

            // window._memStorage — el último fallback de safeLocalStorageGet()
            if (window._memStorage) {
                Object.keys(window._memStorage).forEach(key => {
                    if (isRelevantKey(key)) delete window._memStorage[key];
                });
            }

            if (deviceId) {
                localStorage.setItem('_deviceId', deviceId);
            }
            log('[Storage Utils] Caché de datos locales limpiada en los 3 niveles (Device ID preservado).');
        }

        if (window.indexedDB && indexedDB.databases) {
            try {
                const dbs = await indexedDB.databases();
                for (const db of dbs) {
                    if (db.name && (db.name.includes('firestore') || db.name.includes('firebase'))) {
                        indexedDB.deleteDatabase(db.name);
                        log(`[Storage Utils] Base de datos IndexedDB eliminada: ${db.name}`);
                    }
                }
            } catch (e) {
                warn('[Storage Utils] No se pudo listar IndexedDB automáticamente:', e);
            }
        }

        if ('caches' in window) {
            const cacheNames = await caches.keys();
            await Promise.all(
                cacheNames.map(name => {
                    log(`[Storage Utils] Eliminando caché del navegador: ${name}`);
                    return caches.delete(name);
                })
            );
        }

        log('[Storage Utils] Limpieza de caché completada con éxito.');
        return true;
    } catch (e) {
        error('[Storage Utils] Error crítico limpiando la caché:', e);
        return false;
    }
}

export async function purgeAndReload() {
    const confirmed = window.confirm('¿Estás seguro de limpiar la caché y reiniciar la aplicación? Esto descartará cambios pendientes no sincronizados.');
    if (confirmed) {
        await clearAppCache(false);
        window.location.reload();
    }
}