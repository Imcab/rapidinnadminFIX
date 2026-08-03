import { db, getDeviceId, pushDebug, log, warn } from './config.js';
import { collection, onSnapshot, getDoc, doc } from 'firebase/firestore';
import { ensureAuth } from './auth-service.js';
import { isOnline, setForceOnline, processOfflineQueue, onlineStatusCallback, offlineQueue } from './offline-manager.js';

const COLL = 'motelData';
const ROOMS_COLL = 'motelRoomDocs';

export let collectionStop = null;
export let roomsCollectionStop = null;
export let keyHandlers = new Map(); 
export let roomKeyHandlers = new Map();
export let activeListeners = new Map();

export function subscribeCollectionResilientFor(collRef, onDocChange, label = '(colección completa)') {
    let liveUnsub = null;
    let retryTimer = null;
    let stopped = false;
    let backoff = 1000;
    const BACKOFF_CAP_MS = 15000;
    let attachedAt = 0;
    const MIN_STABLE_MS = 15000;

    async function attach() {
        if (stopped) return;
        const authOk = await ensureAuth();
        if (stopped) return;
        if (!authOk) {
            retryTimer = setTimeout(attach, backoff);
            backoff = Math.min(backoff * 1.5, BACKOFF_CAP_MS);
            return;
        }
        attachedAt = Date.now();
        liveUnsub = onSnapshot(collRef, 
            (snapshot) => {
                if (Date.now() - attachedAt > MIN_STABLE_MS) backoff = 2000;
                snapshot.docChanges().forEach(change => {
                    if (change.type === 'removed') return;
                    onDocChange(change.doc);
                });
            },
            (err) => {
                pushDebug('listen-error', `${label}: ${err.code || err.message}`);
                liveUnsub = null;
                if (!stopped) {
                    retryTimer = setTimeout(attach, err.code === 'resource-exhausted' ? 60000 : backoff);
                    if (err.code !== 'resource-exhausted') backoff = Math.min(backoff * 1.5, BACKOFF_CAP_MS);
                }
            }
        );
    }
    attach();

    return function stop() {
        stopped = true;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (liveUnsub) { liveUnsub(); liveUnsub = null; }
    };
}

export function ensureCollectionListener() {
    if (collectionStop) return; 
    collectionStop = subscribeCollectionResilientFor(collection(db, COLL), (docSnap) => {
        const handler = keyHandlers.get(docSnap.id);
        if (handler) handler(docSnap);
    });
}

export function ensureRoomsCollectionListener() {
    if (roomsCollectionStop) return;
    roomsCollectionStop = subscribeCollectionResilientFor(collection(db, ROOMS_COLL), (docSnap) => {
        const handler = roomKeyHandlers.get(docSnap.id);
        if (handler) handler(docSnap);
    }, '(habitaciones)');
}

export function registerKeyHandler(key, handler) {
    ensureCollectionListener();
    keyHandlers.set(key, handler);
    return () => { if (keyHandlers.get(key) === handler) keyHandlers.delete(key); };
}

export function registerRoomKeyHandler(roomId, handler) {
    ensureRoomsCollectionListener();
    roomKeyHandlers.set(roomId, handler);
    return () => { if (roomKeyHandlers.get(roomId) === handler) roomKeyHandlers.delete(roomId); };
}

export function forceReconnectAll() {
    if (collectionStop) { try { collectionStop(); } catch(e){} collectionStop = null; }
    if (roomsCollectionStop) { try { roomsCollectionStop(); } catch(e){} roomsCollectionStop = null; }
    ensureCollectionListener();
    ensureRoomsCollectionListener();
    pushDebug('force-reconnect-all');
}

export function startReconnectionSystem(lastSavedContentMap) {
    let reconnectionAttempts = 0;
    let quotaCooldownUntil = 0;
    setInterval(async () => {
        if (Date.now() < quotaCooldownUntil) return;
        if (!isOnline && navigator.onLine) {
            reconnectionAttempts++;
            try {
                await getDoc(doc(db, COLL, '_connection_test'));
                setForceOnline(true);
                reconnectionAttempts = 0;
                await processOfflineQueue(lastSavedContentMap);
            } catch (e) {
                if (e.code === 'resource-exhausted') quotaCooldownUntil = Date.now() + 300000;
                else if (reconnectionAttempts >= 5) reconnectionAttempts = 0;
            }
        } else if (isOnline && !navigator.onLine) {
            setForceOnline(false);
            if (onlineStatusCallback) onlineStatusCallback(false, offlineQueue.length);
        }
    }, 10000);
}