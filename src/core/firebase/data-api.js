import { db, getDeviceId, log, pushDebug, warn, SYNC_KEYS } from './config.js';
import { doc, setDoc, getDoc, getDocFromServer, getDocs, getDocsFromServer, collection, serverTimestamp } from 'firebase/firestore';
import { ensureAuth } from './auth-service.js';
import { isOnline, queueForOffline, setForceOnline, onlineStatusCallback, offlineQueue } from './offline-manager.js';

const COLL = 'motelData';
const ROOMS_COLL = 'motelRoomDocs';
export const lastSavedContent = new Map();
export const lastSavedRoomContent = new Map();

function fetchWithTimeout(promise, ms = 8000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);
}

export async function fbSave(key, data) {
    const serialized = JSON.stringify(data);
    if (lastSavedContent.get(key) === serialized) return;
    const authResult = await ensureAuth();
    if (!authResult || !isOnline) { queueForOffline(key, data); pushDebug('save-queued-offline', key); return; }
    try {
        await setDoc(doc(db, COLL, key), { value: serialized, timestamp: serverTimestamp(), updatedAt: Date.now(), deviceId: getDeviceId() });
        lastSavedContent.set(key, serialized);
        pushDebug('save-ok', key);
    } catch(e) {
        pushDebug('save-fail', `${key}: ${e.code || e.message}`);
        if (e.code === 'unauthenticated') ensureAuth();
        queueForOffline(key, data);
        if (onlineStatusCallback) onlineStatusCallback(false, offlineQueue.length);
    }
}

export async function fbLoad(key, fallback) {
    await ensureAuth();
    try {
        const docSnap = await getDoc(doc(db, COLL, key));
        if (docSnap.exists()) {
            const data = docSnap.data();
            if (data && typeof data.value === 'string') return JSON.parse(data.value);
            return data ? data.value : fallback;
        }
    } catch(e) {
        if (e.code && e.code.startsWith('auth/')) {
            setForceOnline(false);
            if (onlineStatusCallback) onlineStatusCallback(false, 0);
        }
    }
    return fallback;
}

// CORREGIDO: getDocFromServer (no getDoc con un 2do argumento, que no existe en v9)
export async function fbLoadFresh(key, fallback) {
    await ensureAuth();
    try {
        const docSnap = await fetchWithTimeout(getDocFromServer(doc(db, COLL, key)), 8000);
        if (docSnap.exists()) {
            const data = docSnap.data();
            if (data && typeof data.value === 'string') return JSON.parse(data.value);
            return data ? data.value : fallback;
        }
    } catch(e) {
        warn(`[Firebase] Error en carga fresca de ${key}:`, e.code || e.message);
    }
    return fallback;
}

export async function saveRoomDoc(roomId, room) {
    const serialized = JSON.stringify(room);
    if (lastSavedRoomContent.get(roomId) === serialized) return;
    const authOk = await ensureAuth();
    if (!authOk || !isOnline) return;
    try {
        await setDoc(doc(db, ROOMS_COLL, roomId), { value: serialized, timestamp: serverTimestamp(), updatedAt: Date.now(), deviceId: getDeviceId() });
        lastSavedRoomContent.set(roomId, serialized);
        pushDebug('save-room-ok', roomId);
    } catch (e) {
        pushDebug('save-room-fail', `${roomId}: ${e.code || e.message}`);
    }
}

// CORREGIDO: getDocsFromServer (no getDocs con un 2do argumento, que no existe en v9)
export async function loadAllRoomDocs() {
    try {
        const querySnapshot = await fetchWithTimeout(
            getDocsFromServer(collection(db, ROOMS_COLL)),
            8000
        );
        const rooms = [];
        querySnapshot.forEach((docSnapshot) => {
            const d = docSnapshot.data();
            if (!d || typeof d.value !== 'string') return;
            try { rooms.push(JSON.parse(d.value)); } catch (e) {}
        });
        return rooms;
    } catch (e) { return []; }
}

// CORREGIDO: getDocFromServer + SYNC_KEYS importado de config.js (antes era una
// variable global que no existía en este archivo -> ReferenceError en runtime)
export async function loadAllFreshData() {
    const keys = SYNC_KEYS;
    await ensureAuth();
    const promises = keys.map(async (k) => {
        try {
            const docSnap = await fetchWithTimeout(getDocFromServer(doc(db, COLL, k)), 8000);
            if (docSnap && docSnap.exists()) {
                const d = docSnap.data();
                return [k, d && typeof d.value === 'string' ? JSON.parse(d.value) : (d ? d.value : null)];
            }
        } catch(e) {}
        return [k, null];
    });
    const results = await Promise.allSettled(promises);
    const data = {};
    results.forEach(r => { if (r.status === 'fulfilled' && r.value) data[r.value[0]] = r.value[1]; });
    data.motelRoomDocs = await loadAllRoomDocs();
    return data;
}