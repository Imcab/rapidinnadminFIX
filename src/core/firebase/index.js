// src/core/firebase/index.js
import { getDeviceId, getDebugLog, log, SYNC_KEYS } from './config.js';
import { ensureAuth, isAuthReady } from './auth-service.js';
import { 
    isOnline, offlineQueue, lastSyncError, setOnlineStatusCallback, 
    clearQueue, processOfflineQueue, setForceOnline 
} from './offline-manager.js';
import { 
    fbSave, fbLoad, saveRoomDoc, loadAllFreshData, lastSavedContent 
} from './data-api.js';
import { 
    activeListeners, registerKeyHandler, registerRoomKeyHandler, 
    forceReconnectAll, startReconnectionSystem, collectionStop, keyHandlers, roomsCollectionStop 
} from './sync-engine.js';

import { initConnectivityWatchdog } from './connectivity-watchdog.js';

const FirebaseSync = {
    ready: true, // Propiedad vital para app.js
    isOnline: () => isOnline,
    getPendingCount: () => offlineQueue.length,
    getLastSyncError: () => lastSyncError,
    onStatusChange: setOnlineStatusCallback,
    getDebugLog: getDebugLog,
    isAuthReady: () => isAuthReady,
    getDeviceId: getDeviceId,
    isCollectionListenerActive: () => !!collectionStop,
    getWatchedKeyCount: () => keyHandlers.size,
    
    // Almacenamiento Flat
    save: (key, data) => fbSave(key, data),
    load: (key, fallback) => fbLoad(key, fallback),
    loadFresh: async (key, fallback) => fbLoad(key, fallback), // Redirige a load normal en V9

    // Métodos Masivos
    loadAll: async () => loadAllFreshData(),
    saveAll: async (data) => {
        log('[Firebase] 💾 Guardando todas las claves...');
        const promises = Object.entries(data).map(([k, v]) => fbSave(k, v));
        try {
            await Promise.all(promises);
            return { success: true, count: promises.length };
        } catch (err) {
            return { success: false, error: err.message };
        }
    },

    // Escuchas Masivas e Individuales
    listenAll: (callback, onBatchComplete) => {
        for (const [key, unsubscribe] of activeListeners.entries()) {
            unsubscribe();
            activeListeners.delete(key);
        }

        const keys = SYNC_KEYS;
        let batchTimeout = null;
        let batchKeys = new Set();
        
        for (const key of keys) {
            const stop = registerKeyHandler(key, (docSnap) => {
                if (!docSnap.exists() || !docSnap.data().value) return;
                let parsed, docData = docSnap.data();
                if (docData.deviceId === getDeviceId()) return; 
                try { parsed = JSON.parse(docData.value); } catch(e) { return; }
                
                if (onBatchComplete) {
                    batchKeys.add(key);
                    if (batchTimeout) clearTimeout(batchTimeout);
                    batchTimeout = setTimeout(() => {
                        if (batchKeys.size > 0) {
                            onBatchComplete(Array.from(batchKeys));
                            batchKeys.clear();
                        }
                    }, 500);
                }
                try { callback(key, parsed); } catch(e) {}
            });
            activeListeners.set(key, stop);
        }
        return () => {
            for (const [key, unsubscribe] of activeListeners.entries()) {
                unsubscribe();
                activeListeners.delete(key);
            }
            if (batchTimeout) clearTimeout(batchTimeout);
        };
    },
    
    // Shards y Reportes Mensuales
    saveMrData: (key, data) => fbSave('mr_'+key, data),
    loadMrData: (key, fallback) => fbLoad('mr_'+key, fallback),
    saveShardData: (key, data) => fbSave('shard_'+key, data),
    loadShardData: (key, fallback) => fbLoad('shard_'+key, fallback),
    
    listenKey: (key, callback) => {
        if (activeListeners.has(key)) {
            activeListeners.get(key)();
            activeListeners.delete(key);
        }
        const stop = registerKeyHandler(key, (docSnap) => {
            if (!docSnap.exists()) return;
            const d = docSnap.data();
            if (!d || !d.value || d.deviceId === getDeviceId()) return;
            try { callback(key, JSON.parse(d.value)); } catch(e) {}
        });
        activeListeners.set(key, stop);
        return stop;
    },
    unlistenKey: (key) => {
        if (activeListeners.has(key)) {
            activeListeners.get(key)();
            activeListeners.delete(key);
        }
    },

    // Métodos de Habitaciones (Colección separada)
    saveRoom: (roomId, room) => saveRoomDoc(roomId, room),
    listenRoom: (roomId, callback) => {
        return registerRoomKeyHandler(roomId, (docSnap) => {
            if (!docSnap.exists()) return;
            const d = docSnap.data();
            if (!d || !d.value || d.deviceId === getDeviceId()) return;
            try { callback(roomId, JSON.parse(d.value)); } catch(e) {}
        });
    },
    isRoomsCollectionListenerActive: () => !!roomsCollectionStop,

    // Carga de Emergencia y Reconexión
    forceReconnectAll: forceReconnectAll,
    loadAllFresh: loadAllFreshData,

    // Gestión Offline y de Conexión
    syncPending: async () => await processOfflineQueue(lastSavedContent),
    clearQueue: clearQueue,
    startReconnectionSystem: () => startReconnectionSystem(lastSavedContent),
    forceOnline: () => setForceOnline(true),
    // wathcdog
    initConnectivityWatchdog: (onStaleReturn) => initConnectivityWatchdog(onStaleReturn)
};

log('[Firebase] ✅ Módulos Vite inyectados como Shim Legacy');

window.FirebaseSync = FirebaseSync;
export default FirebaseSync;