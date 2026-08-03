import { db, getDeviceId, log, warn } from './config.js';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { ensureAuth } from './auth-service.js';

export let isOnline = navigator.onLine;
export let onlineStatusCallback = null;
export let offlineQueue = [];
export let lastSyncError = null;

const COLL = 'motelData';
const OBSOLETE_QUEUE_KEYS = ['motelRoomRevenue', 'motelSales', 'motelExpenses'];

export function setOnlineStatusCallback(cb) { onlineStatusCallback = cb; }
export function setForceOnline(status) { isOnline = status; }

export function loadOfflineQueue() {
    try {
        const saved = localStorage.getItem('_offlineQueue');
        if (saved) {
            offlineQueue = JSON.parse(saved);
            if (!Array.isArray(offlineQueue)) offlineQueue = [];
            offlineQueue = offlineQueue.filter(item => !OBSOLETE_QUEUE_KEYS.includes(item.key));
        }
    } catch(e) { offlineQueue = []; }
}

export function saveOfflineQueue() {
    try { localStorage.setItem('_offlineQueue', JSON.stringify(offlineQueue)); } catch(e) {}
}

export function queueForOffline(key, data) {
    offlineQueue = offlineQueue.filter(item => item.key !== key);
    offlineQueue.push({ key, data, timestamp: Date.now() });
    saveOfflineQueue();
}

export function clearQueue() {
    const count = offlineQueue.length;
    offlineQueue = [];
    saveOfflineQueue();
    return count;
}

export async function processOfflineQueue(lastSavedContentMap) {
    if (!isOnline || offlineQueue.length === 0) return 0;
    const authOk = await ensureAuth();
    if (!authOk) return 0;

    log(`[Firebase] 🔄 Procesando ${offlineQueue.length} elementos de la cola offline...`);
    let processed = 0;
    const failed = [];
    const BATCH_SIZE = 5;

    for (let i = 0; i < offlineQueue.length; i += BATCH_SIZE) {
        const batch = offlineQueue.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (item) => {
            try {
                const serialized = JSON.stringify(item.data);
                await setDoc(doc(db, COLL, item.key), {
                    value: serialized,
                    timestamp: serverTimestamp(),
                    deviceId: getDeviceId(),
                    queuedAt: item.timestamp
                });
                if (lastSavedContentMap) lastSavedContentMap.set(item.key, serialized);
                processed++;
            } catch(e) {
                warn(`[Firebase] ⚠️ Error sincronizando ${item.key}:`, e.code);
                lastSyncError = { key: item.key, code: e.code || null, message: e.message || String(e) };
                
                const isOversized = e.code === 'invalid-argument' && /longer than|exceed|maximum/i.test(e.message || '');
                if (isOversized && item.key.startsWith('shard_')) {
                    warn(`[Firebase] Descartando ${item.key} por exceso de tamaño.`);
                } else {
                    failed.push(item);
                }
            }
        }));
        if (i + BATCH_SIZE < offlineQueue.length) await new Promise(resolve => setTimeout(resolve, 100));
    }
    offlineQueue = failed;
    saveOfflineQueue();
    return processed;
}

// Inicializar cola
loadOfflineQueue();

window.addEventListener('online', async () => {
    isOnline = true;
    const count = await processOfflineQueue();
    if (onlineStatusCallback) onlineStatusCallback(true, count);
});
window.addEventListener('offline', () => {
    isOnline = false;
    if (onlineStatusCallback) onlineStatusCallback(false, 0);
});