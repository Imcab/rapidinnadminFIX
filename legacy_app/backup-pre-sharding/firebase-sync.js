// ============ FIREBASE SYNC v5.5.0 - OPTIMIZADO ============
// Sistema de sincronización en tiempo real con Firebase
// Logging reducido para producción

const firebaseConfig = {
    apiKey: "AIzaSyAGb15OXMpcx7YaI4eyCgpbfzonc9biujQ",
    authDomain: "rapid-inn-deploy.firebaseapp.com",
    projectId: "rapid-inn-deploy",
    storageBucket: "rapid-inn-deploy.firebasestorage.app",
    messagingSenderId: "695733542726",
    appId: "1:695733542726:web:53f5b5a9e8e15c161d0f47",
    measurementId: "G-BQ1RM6BSH4"
};

// Modo debug (cambiar a false en producción)
const DEBUG_MODE = false;
const log = DEBUG_MODE ? console.log.bind(console) : () => {};
const warn = console.warn.bind(console);
const error = console.error.bind(console);

// Generar ID único de dispositivo si no existe (con fallback para Safari privado)
(function() {
    try {
        if (!localStorage.getItem('_deviceId')) {
            const deviceId = 'device_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('_deviceId', deviceId);
            log('[Firebase] 🆔 ID de dispositivo generado:', deviceId);
        } else {
            log('[Firebase] 🆔 ID de dispositivo:', localStorage.getItem('_deviceId'));
        }
    } catch (e) {
        // Safari privado u otros entornos donde localStorage no está disponible
        if (!window._memStorage) window._memStorage = {};
        if (!window._memStorage['_deviceId']) {
            window._memStorage['_deviceId'] = 'device_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        }
        warn('[Firebase] ⚠️ localStorage no disponible para deviceId, usando memoria');
    }
})();

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const _db = firebase.firestore();
const _COLL = 'motelData';

// Habilitar persistencia offline (IndexedDB) para cargas rápidas en visitas posteriores
_db.enablePersistence({ synchronizeTabs: true }).catch(e => {
    if (e.code === 'failed-precondition') {
        warn('[Firebase] Persistencia no habilitada: múltiples pestañas abiertas');
    } else if (e.code !== 'unimplemented') {
        warn('[Firebase] Error habilitando persistencia:', e.code);
    }
});

// Configurar Firestore para mejor manejo offline
_db.enableNetwork().catch(e => {
    warn('[Firebase] Error habilitando red:', e);
    // Continuar de todos modos, el sistema funcionará offline
});

// Autenticación anónima con reintentos.
// IMPORTANTE: _authReady significa "AUTENTICADO", nunca "ya no vamos a intentar".
// La versión anterior ponía _authReady = true incluso cuando la autenticación
// fallaba tras agotar los reintentos, y como _ensureAuth() devuelve true de
// inmediato si _authReady es true, TODAS las llamadas futuras en esa sesión
// (_fbSave incluido) creían estar autenticadas sin estarlo: los guardados
// pasaban de largo la cola offline, Firestore los rechazaba por falta de
// auth, y el dispositivo quedaba con la sincronización rota en silencio
// hasta que se recargaba la página. Esto producía divergencia permanente
// entre dispositivos (uno guardando de verdad, otro creyendo que guardaba).
let _authReady = false;
let _authRetries = 0;
let _authCooldownUntil = 0;
const MAX_AUTH_RETRIES = 3;
const AUTH_RETRY_COOLDOWN_MS = 30000;

async function _ensureAuth() {
    if (_authReady && firebase.auth().currentUser) return true;
    if (_authReady && !firebase.auth().currentUser) _authReady = false; // sesión perdida

    if (Date.now() < _authCooldownUntil) return false; // en cooldown tras fallos repetidos

    if (firebase.auth().currentUser) {
        _authReady = true;
        log('[Firebase] ✅ Usuario ya autenticado');
        return true;
    }

    try {
        log('[Firebase] 🔄 Iniciando autenticación anónima...');
        await firebase.auth().signInAnonymously();
        _authReady = true;
        _authRetries = 0;
        log('[Firebase] ✅ Autenticación anónima exitosa');
        return true;
    } catch (e) {
        _authRetries++;
        error('[Firebase] ❌ Error de autenticación (intento ' + _authRetries + '):', e.code);

        if (_authRetries < MAX_AUTH_RETRIES) {
            log('[Firebase] 🔄 Reintentando en 2 segundos...');
            setTimeout(() => _ensureAuth(), 2000);
        } else {
            error('[Firebase] ❌ Falló autenticación tras ' + MAX_AUTH_RETRIES + ' intentos, reintentando en ' + (AUTH_RETRY_COOLDOWN_MS / 1000) + 's');
            _authCooldownUntil = Date.now() + AUTH_RETRY_COOLDOWN_MS;
            _authRetries = 0;
        }
        return false;
    }
}
_ensureAuth();

let _offlineQueue = [];
let _isOnline = navigator.onLine;
let _onlineStatusCallback = null;

function _loadOfflineQueue() {
    try {
        const saved = localStorage.getItem('_offlineQueue');
        if (saved) {
            _offlineQueue = JSON.parse(saved);
            if (!Array.isArray(_offlineQueue)) _offlineQueue = [];
        }
    } catch(e) { _offlineQueue = []; }
}
_loadOfflineQueue();

function _saveOfflineQueue() {
    try {
        localStorage.setItem('_offlineQueue', JSON.stringify(_offlineQueue));
    } catch(e) {}
}

// Encola un guardado pendiente, reemplazando cualquier entrada previa para
// la misma clave. Sin este dedup, varios guardados offline seguidos para la
// misma clave (p.ej. "motelRooms") se apilaban como entradas independientes;
// al reconectar se enviaban en paralelo (Promise.all) sin garantía de orden,
// y si una fallaba y se reintentaba más tarde podía sobreescribir con datos
// viejos un valor más nuevo que ya se había guardado con éxito.
function _queueForOffline(key, data) {
    _offlineQueue = _offlineQueue.filter(item => item.key !== key);
    _offlineQueue.push({ key, data, timestamp: Date.now() });
    _saveOfflineQueue();
}

async function _fbSave(key, data) {
    log(`[Firebase] 💾 Intentando guardar: ${key}`);
    
    const authResult = await _ensureAuth();
    if (!authResult) {
        warn(`[Firebase] ⚠️ No autenticado, guardando en cola offline: ${key}`);
        _queueForOffline(key, data);
        return;
    }

    if (!_isOnline) {
        log(`[Firebase] 📴 Offline, agregando ${key} a cola`);
        _queueForOffline(key, data);
        return;
    }
    
    try {
        log(`[Firebase] 🔄 Guardando ${key} en Firestore...`);
        await _db.collection(_COLL).doc(key).set({ 
            value: JSON.stringify(data),
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: Date.now(), // FIXED: Agregar campo updatedAt para comparación de versiones
            deviceId: (function(){ try { return localStorage.getItem('_deviceId'); } catch(e){} return (window._memStorage&&window._memStorage['_deviceId'])||'unknown'; })() // Identificar dispositivo
        });
        log(`[Firebase] ✅ ${key} guardado exitosamente`);
    } catch(e) {
        error(`[Firebase] ❌ Error guardando ${key}:`, e.code || e.message);
        
        // Manejar diferentes tipos de errores
        if (e.code) {
            switch(e.code) {
                case 'unavailable':
                case 'deadline-exceeded':
                case 'resource-exhausted':
                case 'cancelled':
                    warn('[Firebase] ⚠️ Error de conectividad, guardando offline');
                    _isOnline = false;
                    break;
                case 'permission-denied':
                    error('[Firebase] ❌ Sin permisos, verificar reglas de Firestore');
                    // No marcar como offline, es un problema de permisos
                    break;
                case 'unauthenticated':
                    warn('[Firebase] ⚠️ No autenticado, reintentando autenticación...');
                    _authReady = false;
                    _authRetries = 0; // Resetear contador
                    _ensureAuth();
                    break;
                default:
                    error(`[Firebase] ❌ Error desconocido: ${e.code} - ${e.message}`);
            }
        }
        
        // Guardar en cola offline para reintentar después
        _queueForOffline(key, data);

        // Actualizar estado offline
        if (_onlineStatusCallback) _onlineStatusCallback(false, _offlineQueue.length);
    }
}

async function _fbLoad(key, fallback) {
    await _ensureAuth();
    try {
        // Intentar caché local primero (rápido si enablePersistence está activo)
        try {
            const cached = await _db.collection(_COLL).doc(key).get({ source: 'cache' });
            if (cached.exists) {
                const d = cached.data();
                if (d && typeof d.value === 'string') return JSON.parse(d.value);
                if (d) return d.value;
            }
        } catch (_) { /* cache miss o persistencia no disponible, continuar con servidor */ }

        const doc = await _db.collection(_COLL).doc(key).get();
        if (doc.exists) {
            const data = doc.data();
            if (data && typeof data.value === 'string') {
                return JSON.parse(data.value);
            }
            return data ? data.value : fallback;
        }
    } catch(e) {
        console.error(`[Firebase] Error cargando ${key}:`, e.message || e);
        if (e.code && e.code.startsWith('auth/')) {
            console.warn('[Firebase] ⚠️ Error de autenticación de Firebase detectado, marcando estado offline');
            _isOnline = false;
            if (_onlineStatusCallback) _onlineStatusCallback(false, 0);
        }
    }
    return fallback;
}

async function _processOfflineQueue() {
    if (!_isOnline || _offlineQueue.length === 0) return 0;
    
    log(`[Firebase] 🔄 Procesando ${_offlineQueue.length} elementos de la cola offline...`);
    let processed = 0;
    const failed = [];
    
    // Procesar en lotes de 5 para no sobrecargar
    const BATCH_SIZE = 5;
    for (let i = 0; i < _offlineQueue.length; i += BATCH_SIZE) {
        const batch = _offlineQueue.slice(i, i + BATCH_SIZE);
        
        await Promise.all(batch.map(async (item) => {
            try {
                await _db.collection(_COLL).doc(item.key).set({ 
                    value: JSON.stringify(item.data),
                    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                    deviceId: (function(){ try { return localStorage.getItem('_deviceId'); } catch(e){} return (window._memStorage&&window._memStorage['_deviceId'])||'unknown'; })(),
                    queuedAt: item.timestamp // Timestamp de cuando se agregó a la cola
                });
                processed++;
                log(`[Firebase] ✅ Sincronizado desde cola: ${item.key}`);
            } catch(e) {
                warn(`[Firebase] ⚠️ Error sincronizando ${item.key}:`, e.code);
                failed.push(item);
            }
        }));
        
        // Pequeña pausa entre lotes para no saturar
        if (i + BATCH_SIZE < _offlineQueue.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    _offlineQueue = failed;
    _saveOfflineQueue();
    
    if (processed > 0) {
        log(`[Firebase] ✅ ${processed} elementos sincronizados, ${failed.length} fallidos`);
    }
    
    return processed;
}

window.addEventListener('online', async () => {
    _isOnline = true;
    const count = await _processOfflineQueue();
    if (_onlineStatusCallback) _onlineStatusCallback(true, count);
});
window.addEventListener('offline', () => {
    _isOnline = false;
    if (_onlineStatusCallback) _onlineStatusCallback(false, 0);
});

// Mapa de listeners activos
let _activeListeners = new Map();

window.FirebaseSync = {
    ready: true,
    isOnline: () => _isOnline,
    getPendingCount: () => _offlineQueue.length,
    onStatusChange: (cb) => { _onlineStatusCallback = cb; },
    save: (key, data) => _fbSave(key, data),
    load: (key, fallback) => _fbLoad(key, fallback),
    // FIXED: Paralelizar carga de Firebase con Promise.allSettled
    loadAll: async () => {
        const keys = ['motelRooms','motelInventory','motelSales','motelRoomRevenue','motelExpenses','motelShiftReports','motelShiftSnapshots','motelCurrentShiftStart','motelCurrentShiftType','motelActivityLog','motelReservations','deepCleanSchedules','motelStaffMembers','motelAnnouncements','motelUsers','_pwd_supervisor','_pwd_director','_pwd_recepcion','_pwd_limpieza'];
        
        // Crear array de promesas para cargar en paralelo
        const promises = keys.map(k => _fbLoad(k, null));
        
        // Usar Promise.allSettled para que si una falla no bloquee las demás
        const results = await Promise.allSettled(promises);
        
        // Mapear resultados a objeto de retorno
        const data = {};
        results.forEach((result, index) => {
            const key = keys[index];
            if (result.status === 'fulfilled') {
                data[key] = result.value;
            } else {
                console.error(`[Firebase] Error cargando ${key}:`, result.reason);
                data[key] = null;
            }
        });
        
        return data;
    },
    saveAll: async (data) => {
        log('[Firebase] 💾 Guardando todas las claves...');
        const promises = [];
        const keys = Object.keys(data);
        
        for (const [k,v] of Object.entries(data)) {
            promises.push(_fbSave(k, v));
        }
        
        try {
            await Promise.all(promises);
            log(`[Firebase] ✅ Todas las claves guardadas exitosamente (${keys.length})`);
            return { success: true, count: keys.length };
        } catch (err) {
            error(`[Firebase] ❌ Error guardando algunas claves:`, err);
            return { success: false, error: err.message };
        }
    },
    // 🔥 LISTENER EN TIEMPO REAL SIMPLIFICADO
    listenAll: (callback, onBatchComplete) => {
        // Limpiar listeners anteriores si existen
        for (const [key, unsubscribe] of _activeListeners.entries()) {
            unsubscribe();
            _activeListeners.delete(key);
        }
        
        const keys = ['motelRooms','motelInventory','motelSales','motelRoomRevenue','motelExpenses','motelShiftReports','motelShiftSnapshots','motelCurrentShiftStart','motelCurrentShiftType','motelActivityLog','motelReservations','deepCleanSchedules','motelStaffMembers','motelAnnouncements','motelUsers','_pwd_supervisor','_pwd_director','_pwd_recepcion','_pwd_limpieza'];
        
        let batchTimeout = null;
        let batchKeys = new Set();
        
        for (const key of keys) {
            const unsubscribe = _db.collection(_COLL).doc(key).onSnapshot(
                (doc) => {
                    if (doc.exists && doc.data().value) {
                        try {
                            const parsed = JSON.parse(doc.data().value);
                            const docData = doc.data();
                            const deviceId = docData.deviceId || 'unknown';
                            const myDeviceId = (function(){ try { return localStorage.getItem('_deviceId'); } catch(e){} return (window._memStorage&&window._memStorage['_deviceId'])||'unknown'; })();
                            
                            // Ignorar cambios que vienen de este mismo dispositivo
                            if (deviceId === myDeviceId) {
                                log(`[Firebase] 🔄 Cambio de este dispositivo ignorado: ${key}`);
                                return;
                            }
                            
                            log(`[Firebase] 📥 Cambio detectado desde otro dispositivo: ${key}`);
                            
                            // Marcar para batch si se requiere
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
                            
                            callback(key, parsed);
                        } catch(e) { 
                            console.error('[Firebase] Error parsing', key, e); 
                        }
                    }
                },
                (error) => {
                    console.error(`[Firebase] Error en listener de ${key}:`, error);
                }
            );
            _activeListeners.set(key, unsubscribe);
        }
        
        log('[Firebase] ✅ Listeners activados para', keys.length, 'colecciones');
        
        // Devolver función para cancelar todos los listeners
        return () => {
            for (const [key, unsubscribe] of _activeListeners.entries()) {
                unsubscribe();
                _activeListeners.delete(key);
            }
            if (batchTimeout) clearTimeout(batchTimeout);
        };
    },
    saveMrData: (key, data) => _fbSave('mr_'+key, data),
    loadMrData: (key, fallback) => _fbLoad('mr_'+key, fallback),
    // Listener para una clave específica (claves dinámicas como MR data)
    listenKey: (key, callback) => {
        if (_activeListeners.has(key)) {
            _activeListeners.get(key)();
            _activeListeners.delete(key);
        }
        const getDevId = () => { try { return localStorage.getItem('_deviceId'); } catch(e) {} return (window._memStorage&&window._memStorage['_deviceId'])||'unknown'; };
        const unsub = _db.collection(_COLL).doc(key).onSnapshot(
            (doc) => {
                if (!doc.exists) return;
                const d = doc.data();
                if (!d || !d.value) return;
                if (d.deviceId === getDevId()) return; // ignorar cambios propios
                try { callback(key, JSON.parse(d.value)); } catch(e) { error('[Firebase] Error parsing', key, e); }
            },
            (err) => error(`[Firebase] Error en listener de ${key}:`, err)
        );
        _activeListeners.set(key, unsub);
        return unsub;
    },
    unlistenKey: (key) => {
        if (_activeListeners.has(key)) {
            _activeListeners.get(key)();
            _activeListeners.delete(key);
        }
    },
    // Carga directamente del servidor, ignorando caché IndexedDB
    // Usar cuando la app vuelve del background después de horas
    loadAllFresh: async () => {
        const keys = ['motelRooms','motelInventory','motelSales','motelRoomRevenue','motelExpenses','motelShiftReports','motelShiftSnapshots','motelCurrentShiftStart','motelCurrentShiftType','motelActivityLog','motelReservations','deepCleanSchedules','motelStaffMembers','motelAnnouncements','motelUsers','_pwd_supervisor','_pwd_director','_pwd_recepcion','_pwd_limpieza'];
        await _ensureAuth();
        const promises = keys.map(async (k) => {
            try {
                const doc = await _db.collection(_COLL).doc(k).get({ source: 'server' });
                if (doc.exists) {
                    const d = doc.data();
                    return [k, d && typeof d.value === 'string' ? JSON.parse(d.value) : (d ? d.value : null)];
                }
            } catch(e) {
                warn(`[Firebase] Error carga fresca ${k}:`, e.code || e.message);
            }
            return [k, null];
        });
        const results = await Promise.allSettled(promises);
        const data = {};
        results.forEach(r => {
            if (r.status === 'fulfilled' && r.value) data[r.value[0]] = r.value[1];
        });
        return data;
    },
    syncPending: async () => {
        log('[Firebase] Forzando sincronización...');
        return await _processOfflineQueue();
    },
    clearQueue: () => {
        const count = _offlineQueue.length;
        _offlineQueue = [];
        _saveOfflineQueue();
        return count;
    },
    
    // Sistema de reconexión automática mejorado
    startReconnectionSystem: () => {
        let reconnectionAttempts = 0;
        const MAX_RECONNECTION_ATTEMPTS = 5;
        
        setInterval(async () => {
            // Solo intentar reconectar si el navegador dice que hay internet pero Firebase está offline
            if (!_isOnline && navigator.onLine) {
                reconnectionAttempts++;
                console.log(`[Firebase] 🔄 Intento de reconexión ${reconnectionAttempts}/${MAX_RECONNECTION_ATTEMPTS}...`);
                
                try {
                    // Verificar conectividad con una operación simple
                    await _db.collection(_COLL).doc('_connection_test').get();
                    console.log('[Firebase] ✅ Reconectado exitosamente');
                    _isOnline = true;
                    reconnectionAttempts = 0; // Resetear contador
                    
                    // Procesar cola offline
                    const processed = await _processOfflineQueue();
                    if (_onlineStatusCallback) _onlineStatusCallback(true, _offlineQueue.length);
                    
                    if (processed > 0) {
                        console.log(`[Firebase] ✅ ${processed} elementos sincronizados tras reconexión`);
                    }
                } catch (e) {
                    if (reconnectionAttempts >= MAX_RECONNECTION_ATTEMPTS) {
                        warn(`[Firebase] ⚠️ Máximo de intentos de reconexión alcanzado. Esperando...`);
                        reconnectionAttempts = 0; // Resetear para intentar de nuevo después
                    } else {
                        warn(`[Firebase] ⚠️ Aún sin conexión: ${e.code || e.message}`);
                    }
                }
            } else if (_isOnline && !navigator.onLine) {
                // El navegador perdió conexión, marcar como offline
                console.log('[Firebase] 📴 Conexión perdida detectada por el navegador');
                _isOnline = false;
                if (_onlineStatusCallback) _onlineStatusCallback(false, _offlineQueue.length);
            }
        }, 10000); // Verificar cada 10 segundos
        
        log('[Firebase] 🔄 Sistema de reconexión automática iniciado');
    },
    forceOnline: () => { _isOnline = true; }
};

log('[Firebase] ✅ Sistema listo (optimizado v5.5.0)');