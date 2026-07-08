// ============ FIREBASE SYNC v5.9.30 - OPTIMIZADO ============
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

// Registro de eventos de sincronización visible en pantalla (ver botón 🩺 en
// el header, openSyncDebugModal() en app.js). Existe porque diagnosticar un
// problema de sincronización en un celular sin Mac/cable (sin acceso a la
// consola real de Safari) era imposible — este log vive SIEMPRE, sin
// importar DEBUG_MODE, así el propio empleado puede copiarlo y mandarlo por
// WhatsApp/mensaje para diagnóstico remoto.
const _syncDebugLog = [];
const SYNC_DEBUG_LOG_MAX = 150;
function _pushDebug(event, detail) {
    try {
        _syncDebugLog.push({ t: Date.now(), event, detail: detail || '' });
        if (_syncDebugLog.length > SYNC_DEBUG_LOG_MAX) _syncDebugLog.shift();
    } catch (e) {}
}

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

// El canal 'Listen' de Firestore usa WebChannel sobre QUIC/HTTP3 por
// defecto. En ciertas redes (móviles, algunos routers/ISP, antivirus con
// inspección SSL, VPNs corporativas) el navegador rompe QUIC a mitad de
// stream (net::ERR_QUIC_PROTOCOL_ERROR) o el proxy corta el canal con un
// 400, y el listener en tiempo real queda "transport errored" en bucle.
// Esto es intermitente por dispositivo/red — por eso un dispositivo
// sincroniza normal y otro se queda desactualizado en silencio (la carga
// inicial con .get() funciona por HTTP normal, pero el listener onSnapshot
// nunca vuelve a recibir cambios). experimentalAutoDetectLongPolling hace
// una prueba de conectividad rápida al iniciar y cae a long-polling
// automáticamente en las redes donde el WebChannel falla, sin penalizar a
// las que sí funcionan bien. useFetchStreams:false evita el modo de
// streaming por fetch() que dispara el mismo problema en algunos
// navegadores/proxies.
_db.settings({
    experimentalAutoDetectLongPolling: true,
    useFetchStreams: false
});

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
        _pushDebug('auth-ok');
        return true;
    } catch (e) {
        _authRetries++;
        error('[Firebase] ❌ Error de autenticación (intento ' + _authRetries + '):', e.code);
        _pushDebug('auth-fail', `intento ${_authRetries}: ${e.code || e.message}`);

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

// Claves planas de antes del sharding mensual (ver app.js, sección SHARDING
// MENSUAL). El código actual ya NUNCA vuelve a guardar bajo estas claves —
// todo vive en documentos shard_{revenue|sales|expenses}_{año}_{mes}. Un
// ítem de la cola offline bajo una de estas claves es forzosamente de antes
// de esa migración: si en su momento falló (típicamente por exceder el
// tamaño máximo de un documento de Firestore, con todo el historial en un
// solo blob), va a seguir fallando para siempre — nada en la app de hoy
// puede "corregirlo" reintentando. Por eso se descarta al cargar la cola, en
// vez de quedar reintentándose sin fin (esto es lo que causaba el badge de
// sincronización atorado en "1 pendiente" de forma permanente).
const _OBSOLETE_QUEUE_KEYS = ['motelRoomRevenue', 'motelSales', 'motelExpenses'];

function _loadOfflineQueue() {
    try {
        const saved = localStorage.getItem('_offlineQueue');
        if (saved) {
            _offlineQueue = JSON.parse(saved);
            if (!Array.isArray(_offlineQueue)) _offlineQueue = [];
            const before = _offlineQueue.length;
            _offlineQueue = _offlineQueue.filter(item => !_OBSOLETE_QUEUE_KEYS.includes(item.key));
            if (_offlineQueue.length !== before) {
                warn(`[Firebase] Descartados ${before - _offlineQueue.length} ítem(s) obsoletos de la cola offline (de antes del sharding mensual).`);
                _saveOfflineQueue();
            }
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

// Último contenido que se confirmó guardado con éxito para cada clave —
// evita reescribir un documento cuyo valor no cambió desde el último
// guardado real. Sin esto, cualquier caller que llame a save()/saveAll()
// repetidamente (p.ej. varias ventas de habitación seguidas, cada una
// disparando un guardado inmediato de motelRooms/motelInventory y de los 3
// meses de shards de ingresos aunque solo el mes actual haya cambiado)
// manda decenas de escrituras redundantes a Firestore en poco tiempo — eso
// es lo que agota la cola de escritura del cliente (FirebaseError
// resource-exhausted: "Write stream exhausted maximum allowed queued
// writes").
const _lastSavedContent = new Map();

async function _fbSave(key, data) {
    const serialized = JSON.stringify(data);
    if (_lastSavedContent.get(key) === serialized) {
        log(`[Firebase] ⏭️ ${key} sin cambios desde el último guardado, se omite`);
        return;
    }

    log(`[Firebase] 💾 Intentando guardar: ${key}`);

    const authResult = await _ensureAuth();
    if (!authResult) {
        warn(`[Firebase] ⚠️ No autenticado, guardando en cola offline: ${key}`);
        _queueForOffline(key, data);
        _pushDebug('save-queued-offline', key + ' (sin auth)');
        return;
    }

    if (!_isOnline) {
        log(`[Firebase] 📴 Offline, agregando ${key} a cola`);
        _queueForOffline(key, data);
        _pushDebug('save-queued-offline', key + ' (sin red)');
        return;
    }

    try {
        log(`[Firebase] 🔄 Guardando ${key} en Firestore...`);
        await _db.collection(_COLL).doc(key).set({
            value: serialized,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: Date.now(), // FIXED: Agregar campo updatedAt para comparación de versiones
            deviceId: (function(){ try { return localStorage.getItem('_deviceId'); } catch(e){} return (window._memStorage&&window._memStorage['_deviceId'])||'unknown'; })() // Identificar dispositivo
        });
        _lastSavedContent.set(key, serialized); // recién AHORA que se confirmó — no antes
        log(`[Firebase] ✅ ${key} guardado exitosamente`);
        _pushDebug('save-ok', key);
    } catch(e) {
        error(`[Firebase] ❌ Error guardando ${key}:`, e.code || e.message);
        _pushDebug('save-fail', `${key}: ${e.code || e.message}`);

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

// ============ LISTENER ÚNICO SOBRE TODA LA COLECCIÓN ============
// REDISEÑO DE FONDO (no otro parche): la versión anterior abría un
// onSnapshot() POR DOCUMENTO — motelRooms, motelInventory, cada shard
// mensual de ingresos/ventas/gastos, contraseñas, etc. — hasta ~24 listeners
// independientes. Cada vez que algo disparaba una "reactivación" (carga
// inicial, volver de background, un reintento) esos ~24 listeners se volvían
// a registrar casi simultáneamente, y Firestore rechazaba el registro
// duplicado del mismo canal con errores "already-exists" que dejaban ese
// dispositivo sordo — a veces para motelRooms, a veces para los shards de
// ingresos, dependiendo de en qué orden ganara la carrera. Un debounce
// (ver _reactivateRealtimeListeners en app.js) redujo la frecuencia de
// colisiones pero no eliminó la causa: seguía habiendo docenas de targets
// que registrar cada vez.
//
// La solución de raíz es no tener docenas de targets que re-registrar: UN
// SOLO listener sobre la colección completa (`_db.collection(_COLL)`)
// recibe TODOS los cambios de documentos en un único stream, sin importar
// cuántas claves nos interesen. "Reactivar" ya no significa volver a hablar
// con Firestore — significa solo actualizar qué callbacks en memoria
// procesan qué documentos, que es instantáneo y no puede chocar consigo
// mismo. Esto también es más barato en lecturas: un solo stream en vez de
// ~24.
let _collectionStop = null;
let _keyHandlers = new Map(); // docId -> callback(doc)

function _ensureCollectionListener() {
    if (_collectionStop) return; // ya hay un stream vivo (o reconectándose) — no hay nada que volver a registrar
    _collectionStop = _subscribeCollectionResilient((doc) => {
        const handler = _keyHandlers.get(doc.id);
        if (handler) handler(doc);
    });
}

// Registra (o reemplaza) el callback para UN documento dentro del stream
// compartido. Devuelve una función para des-registrarlo. No hace ninguna
// llamada de red — toda suscripción real ya está viva en _collectionStop.
function _registerKeyHandler(key, handler) {
    _ensureCollectionListener();
    _keyHandlers.set(key, handler);
    return function stop() {
        if (_keyHandlers.get(key) === handler) _keyHandlers.delete(key);
    };
}

// Igual que la suscripción resiliente por documento que reemplaza, pero para
// TODA la colección: espera la autenticación antes de llamar a onSnapshot()
// (las reglas de Firestore exigen request.auth != null) y se reconecta solo
// con backoff si el stream muere.
function _subscribeCollectionResilient(onDocChange) {
    let liveUnsub = null;
    let retryTimer = null;
    let stopped = false;
    let backoff = 2000;

    async function attach() {
        if (stopped) return;
        const authOk = await _ensureAuth();
        if (stopped) return;
        if (!authOk) {
            retryTimer = setTimeout(attach, backoff);
            backoff = Math.min(backoff * 1.5, 30000);
            return;
        }
        backoff = 2000;
        liveUnsub = _db.collection(_COLL).onSnapshot(
            (snapshot) => {
                snapshot.docChanges().forEach(change => {
                    if (change.type === 'removed') return;
                    onDocChange(change.doc);
                });
            },
            (err) => {
                error('[Firebase] Error en listener de colección:', err.code || err.message);
                _pushDebug('listen-error', `(colección completa): ${err.code || err.message}`);
                liveUnsub = null;
                if (!stopped) {
                    retryTimer = setTimeout(attach, backoff);
                    backoff = Math.min(backoff * 1.5, 30000);
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

let _lastSyncError = null; // { key, code, message } del último ítem que falló, para diagnóstico en UI

async function _processOfflineQueue() {
    if (!_isOnline || _offlineQueue.length === 0) return 0;

    // A diferencia de _fbSave(), este flujo no esperaba a que la
    // autenticación anónima estuviera lista antes de escribir directo en
    // Firestore. initFirebaseSync() llama a esto MUY temprano en el arranque
    // (antes incluso de cargar los datos), momento en el que el sign-in
    // anónimo todavía puede estar en curso — los guardados fallaban por falta
    // de auth, se volvían a encolar, y como esto se repite en cada recarga,
    // el badge de "pendientes" nunca terminaba de quedar en cero aunque el
    // botón manual (que el usuario dispara ya con la sesión completamente
    // lista) sí funcionara.
    const authOk = await _ensureAuth();
    if (!authOk) return 0;

    log(`[Firebase] 🔄 Procesando ${_offlineQueue.length} elementos de la cola offline...`);
    let processed = 0;
    const failed = [];

    // Procesar en lotes de 5 para no sobrecargar
    const BATCH_SIZE = 5;
    for (let i = 0; i < _offlineQueue.length; i += BATCH_SIZE) {
        const batch = _offlineQueue.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (item) => {
            try {
                const serialized = JSON.stringify(item.data);
                await _db.collection(_COLL).doc(item.key).set({
                    value: serialized,
                    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                    deviceId: (function(){ try { return localStorage.getItem('_deviceId'); } catch(e){} return (window._memStorage&&window._memStorage['_deviceId'])||'unknown'; })(),
                    queuedAt: item.timestamp // Timestamp de cuando se agregó a la cola
                });
                _lastSavedContent.set(item.key, serialized); // igual que en _fbSave: evita reescribirlo de nuevo si nada cambió
                processed++;
                log(`[Firebase] ✅ Sincronizado desde cola: ${item.key}`);
            } catch(e) {
                warn(`[Firebase] ⚠️ Error sincronizando ${item.key}:`, e.code);
                _lastSyncError = { key: item.key, code: e.code || null, message: e.message || String(e) };

                // Un documento "shard_*" (historial mensual de ventas/gastos/ingresos)
                // que falla por exceder el tamaño máximo de un documento de Firestore
                // NUNCA se va a poder guardar reintentando con el mismo payload viejo
                // — se quedaría "pendiente" para siempre. La app (app.js) ya vuelve a
                // guardar ese mismo shard de forma particionada en cada ciclo normal
                // de guardado, así que es seguro descartar este intento obsoleto en
                // vez de dejarlo atorado en la cola.
                const isOversized = e.code === 'invalid-argument' && /longer than|exceed|maximum/i.test(e.message || '');
                if (isOversized && item.key.startsWith('shard_')) {
                    warn(`[Firebase] Descartando ${item.key} de la cola offline: documento demasiado grande; la app lo reguardará particionado.`);
                } else {
                    failed.push(item);
                }
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
    getLastSyncError: () => _lastSyncError,
    onStatusChange: (cb) => { _onlineStatusCallback = cb; },
    // Para el panel de diagnóstico en pantalla (ver openSyncDebugModal en
    // app.js) — permite ver en el propio celular, sin devtools, si la
    // autenticación está lista y qué eventos de sincronización ocurrieron.
    getDebugLog: () => _syncDebugLog.slice().reverse(),
    isAuthReady: () => _authReady && !!firebase.auth().currentUser,
    getDeviceId: () => { try { return localStorage.getItem('_deviceId'); } catch(e) {} return (window._memStorage&&window._memStorage['_deviceId'])||'unknown'; },
    isCollectionListenerActive: () => !!_collectionStop,
    getWatchedKeyCount: () => _keyHandlers.size,
    save: (key, data) => _fbSave(key, data),
    load: (key, fallback) => _fbLoad(key, fallback),
    // FIXED: Paralelizar carga de Firebase con Promise.allSettled
    loadAll: async () => {
        // NOTA: motelSales/motelRoomRevenue/motelExpenses ya NO viven aquí — se
        // guardan por mes bajo claves shard_{revenue|sales|expenses}_{año}_{mes}
        // (ver migrateToMonthlyShards/loadMonthShard en app.js). Los 3 documentos
        // planos viejos se dejan de leer/escribir pero NO se borran de Firestore
        // (quedan como respaldo).
        const keys = ['motelRooms','motelInventory','motelShiftReports','motelShiftSnapshots','motelCurrentShiftStart','motelCurrentShiftType','motelActivityLog','motelReservations','deepCleanSchedules','motelStaffMembers','motelAnnouncements','motelUsers','_pwd_supervisor','_pwd_director','_pwd_recepcion','_pwd_limpieza'];
        
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
        
        // NOTA: motelSales/motelRoomRevenue/motelExpenses ya NO viven aquí — ver
        // comentario en loadAll(). Sus shards mensuales se escuchan por separado
        // vía listenKey()/unlistenKey() (ver rolloverHotWindowIfNeeded en app.js).
        const keys = ['motelRooms','motelInventory','motelShiftReports','motelShiftSnapshots','motelCurrentShiftStart','motelCurrentShiftType','motelActivityLog','motelReservations','deepCleanSchedules','motelStaffMembers','motelAnnouncements','motelUsers','_pwd_supervisor','_pwd_director','_pwd_recepcion','_pwd_limpieza'];

        let batchTimeout = null;
        let batchKeys = new Set();
        
        for (const key of keys) {
            const stop = _registerKeyHandler(key, (doc) => {
                if (!doc.exists || !doc.data().value) return;

                let parsed, docData, deviceId, myDeviceId;
                try {
                    parsed = JSON.parse(doc.data().value);
                    docData = doc.data();
                    deviceId = docData.deviceId || 'unknown';
                    myDeviceId = (function(){ try { return localStorage.getItem('_deviceId'); } catch(e){} return (window._memStorage&&window._memStorage['_deviceId'])||'unknown'; })();
                } catch(e) {
                    console.error('[Firebase] Error parseando', key, e);
                    _pushDebug('parse-error', key + ': ' + e.message);
                    return;
                }

                // Ignorar cambios que vienen de este mismo dispositivo
                if (deviceId === myDeviceId) {
                    log(`[Firebase] 🔄 Cambio de este dispositivo ignorado: ${key}`);
                    _pushDebug('own-change-ignored', key);
                    return;
                }

                log(`[Firebase] 📥 Cambio detectado desde otro dispositivo: ${key}`);
                _pushDebug('change-received', key);

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

                // callback() en su PROPIO try/catch — separado del de parseo
                // de arriba — para no mezclar un error de renderizado del
                // lado de app.js con un error de parseo, y para no dejar que
                // esa excepción escape hacia el código interno del SDK de
                // Firestore que despacha el snapshot.
                try {
                    callback(key, parsed);
                } catch(e) {
                    console.error('[Firebase] Error en callback de listener', key, e);
                    _pushDebug('callback-error', key + ': ' + e.message);
                }
            });
            _activeListeners.set(key, stop);
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
    // Igual que saveMrData/loadMrData pero para los shards mensuales de
    // roomRevenue/sales/expenses (ver migrateToMonthlyShards/loadMonthShard
    // en app.js) — mismo patrón de "un documento por clave dinámica" que ya
    // se usaba para el Reporte Mensual, solo con prefijo distinto.
    saveShardData: (key, data) => _fbSave('shard_'+key, data),
    loadShardData: (key, fallback) => _fbLoad('shard_'+key, fallback),
    // Listener para una clave específica (claves dinámicas como MR data)
    listenKey: (key, callback) => {
        if (_activeListeners.has(key)) {
            _activeListeners.get(key)();
            _activeListeners.delete(key);
        }
        const getDevId = () => { try { return localStorage.getItem('_deviceId'); } catch(e) {} return (window._memStorage&&window._memStorage['_deviceId'])||'unknown'; };
        const stop = _registerKeyHandler(key, (doc) => {
            if (!doc.exists) return;
            const d = doc.data();
            if (!d || !d.value) return;
            if (d.deviceId === getDevId()) { _pushDebug('own-change-ignored', key); return; } // ignorar cambios propios
            _pushDebug('change-received', key);
            let parsed;
            try {
                parsed = JSON.parse(d.value);
            } catch(e) {
                error('[Firebase] Error parseando', key, e);
                _pushDebug('parse-error', key + ': ' + e.message);
                return;
            }
            // callback() en su PROPIO try/catch, separado del de parseo de
            // arriba: si el handler del caller (app.js) lanza una excepción
            // al refrescar la UI, antes quedaba etiquetada como "Error
            // parsing" (apuntando al lugar equivocado) y — más grave — sin
            // esta captura, esa excepción escaparía hacia el código interno
            // del SDK de Firestore que despacha el snapshot, arriesgando
            // dejarlo en un estado raro para ese listener.
            try {
                callback(key, parsed);
            } catch(e) {
                error('[Firebase] Error en callback de listener', key, e);
                _pushDebug('callback-error', key + ': ' + e.message);
            }
        });
        _activeListeners.set(key, stop);
        return stop;
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
        // NOTA: ver comentario en loadAll() — sales/roomRevenue/expenses se
        // recargan por shard mensual, no aquí.
        const keys = ['motelRooms','motelInventory','motelShiftReports','motelShiftSnapshots','motelCurrentShiftStart','motelCurrentShiftType','motelActivityLog','motelReservations','deepCleanSchedules','motelStaffMembers','motelAnnouncements','motelUsers','_pwd_supervisor','_pwd_director','_pwd_recepcion','_pwd_limpieza'];
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

log('[Firebase] ✅ Sistema listo (optimizado v5.9.26)');