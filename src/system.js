import {
    users, currentUser, activityLog, rooms, roomRevenue, sales, inventory, expenses,
    shiftReports, reservations, staffMembers, announcements, shiftSnapshots,
    currentShiftStart, currentShiftType, deepCleanSchedules,
    setUsers, setActivityLog, setRooms, setRoomRevenue, setSales, setInventory, setExpenses,
    setShiftReports, setReservations, setStaffMembers, setAnnouncements, setHotWindowAnchorKey,
    setAppReady, setShiftSnapshots, setCurrentShiftStart, setCurrentShiftType, setShiftDataStale,
    setDeepCleanSchedules
} from './app.js';

import { rolloverHotWindowIfNeeded } from './utils/hot-window.js';

import { _reactivateRealtimeListeners, _subscribeHotWindowListeners, _subscribeRoomDocListeners, getHotWindowMonths } from './utils/hot-window.js';

import { renderAnnouncementsList } from './features/announcements.js';
import { renderAttendanceList } from './features/attendance.js';
import { loadDeepCleanSchedules, renderCleaningRooms } from './features/cleaning.js';
import { mergeInventoryFromCloud, mergeReservationsFromCloud } from './utils/cloud.js';
import { updateConnectionStatus } from './features/connection.js';
import { updateExpensesTotal } from './features/expenses.js';
import { _normalizeShiftType, showCustomAlert, showCustomConfirm } from './utils/formatters.js';
import { invalidateRevenueIndex } from './utils/revenue-index.js';
import { init } from './init.js';
import { closeSyncModal } from './features/modal-sync.js';
import { _markRoomsReconciled, createInitialRooms, mergeRoomsFromFirebase, renderReservationsSidebar, renderRooms } from './features/rooms.js';
import { renderInventory, renderSalesLog } from './features/sales.js';
import { _loadHotShardsFromFirebase, migrateToMonthlyShards, persistHotShards } from './utils/shards.js';
import { getShiftTimeRange, updateShiftControl, updateStatistics } from './features/shifts.js';
import { _saveDataImmediate, safeLocalStorageSet, saveData, MAX_SHARD_BYTES} from './utils/storage-utils.js';
import { showToast } from './utils/toast-system.js';
import { renderUsersList } from './features/users.js';

// ============ FIREBASE SYNC INIT ============
let _fbListening = false;
let _fbInitTime = 0;

// Handler único para cambios en tiempo real desde Firebase. Se usa tanto en
// initFirebaseSync() como al reconectar tras volver del background — antes
// existían DOS copias de esta lógica que se fueron desalineando con el
// tiempo: la copia "de background" no reenviaba a Firebase el resultado de
// un conflicto ganado localmente ni refrescaba updateStatistics() en un par
// de casos, así que cualquier celular que se bloqueara y desbloqueara una
// vez perdía esa resincronización por el resto de la sesión. Una sola
// función usada en ambos sitios elimina esa deriva.
export function handleFirebaseRealtimeUpdate(key, val) {
    if (val === null || val === undefined) {
        console.warn(`[Listener] ⚠️ Valor null para ${key}, ignorando`);
        return;
    }

    console.log(`[App] 🔄 Cambio detectado desde Firebase: ${key}`);

    switch (key) {
        case 'motelStaffMembers':
            if (Array.isArray(val)) {
                setStaffMembers(val);
                localStorage.setItem('motelStaffMembers', JSON.stringify(val));
                renderAttendanceList();
            }
            break;

        case 'motelRooms':
            // Autoritativo ahora es la colección por habitación (ver
            // _subscribeRoomDocListeners). Este caso solo agrega
            // habitaciones que falten localmente (no debería pasar nunca:
            // el set de 32 es fijo), sin tocar ninguna que ya exista.
            if (Array.isArray(val) && val.length > 0 && Array.isArray(rooms)) {
                const localIds = new Set(rooms.map(r => r && r.id));
                const missing = val.filter(r => r && r.id && !localIds.has(r.id));
                if (missing.length > 0) {
                    setRooms(rooms.concat(missing));
                    localStorage.setItem('motelRooms', JSON.stringify(rooms));
                    console.warn('[Sync] Habitaciones faltantes agregadas desde motelRooms:', missing.map(r => r.id));
                    if (currentUser && currentUser.role === 'limpieza') renderCleaningRooms();
                    else renderRooms();
                }
            }
            break;

        case 'motelAnnouncements':
            if (Array.isArray(val)) {
                setAnnouncements(val);
                localStorage.setItem('motelAnnouncements', JSON.stringify(val));
                renderAnnouncementsList();
            }
            break;

        // motelRoomRevenue/motelSales/motelExpenses ya no se sincronizan por
        // esta vía plana — ver sección SHARDING MENSUAL y
        // _subscribeHotWindowListeners(), que escuchan cada shard mensual
        // (revenue_{año}_{mes}, etc.) por separado vía listenKey().

        case 'motelInventory':
            if (Array.isArray(val)) {
                setInventory(mergeInventoryFromCloud(val, inventory));
                localStorage.setItem('motelInventory', JSON.stringify(inventory));
                renderInventory();
            }
            break;

        case 'motelReservations':
            if (Array.isArray(val)) {
                setReservations(mergeReservationsFromCloud(val, reservations));
                localStorage.setItem('motelReservations', JSON.stringify(reservations));
                renderReservationsSidebar();
            }
            break;

        case 'motelShiftReports':
            if (Array.isArray(val)) {
                setShiftReports(val);
                localStorage.setItem('motelShiftReports', JSON.stringify(val));
            }
            break;

        case 'motelShiftSnapshots':
            if (Array.isArray(val)) {
                setShiftSnapshots(val);
                localStorage.setItem('motelShiftSnapshots', JSON.stringify(val));
            }
            break;

        case 'motelActivityLog':
            if (Array.isArray(val)) {
                setActivityLog(val);
                localStorage.setItem('motelActivityLog', JSON.stringify(val));
            }
            break;

        case 'deepCleanSchedules':
            if (Array.isArray(val)) {
                setDeepCleanSchedules(val);
                localStorage.setItem('deepCleanSchedules', JSON.stringify(val));
            }
            break;

        case 'motelUsers':
            if (Array.isArray(val)) {
                setUsers(val);
                localStorage.setItem('motelUsers', JSON.stringify(val));
                if (currentUser && currentUser.role === 'director') renderUsersList();
            }
            break;

        case 'motelCurrentShiftStart':
            if (val && (!currentShiftStart || val > currentShiftStart)) {
                setCurrentShiftStart(val);
                localStorage.setItem('motelCurrentShiftStart', JSON.stringify(val));
                console.log('[Sync] currentShiftStart actualizado:', new Date(currentShiftStart));
                if (document.getElementById('shift-control-tab')?.classList.contains('active')) {
                    updateShiftControl();
                } else {
                    setShiftDataStale(true);
                }
                updateStatistics();
            }
            break;

        case 'motelCurrentShiftType':
            if (val) {
                setCurrentShiftType(_normalizeShiftType(val));
                localStorage.setItem('motelCurrentShiftType', currentShiftType);
                console.log('[Sync] currentShiftType actualizado:', currentShiftType);
                if (document.getElementById('shift-control-tab')?.classList.contains('active')) {
                    updateShiftControl();
                } else {
                    setShiftDataStale(true);
                }
                updateStatistics();
            }
            break;

        default:
            if (typeof key === 'string' && key.startsWith('_pwd_')) {
                localStorage.setItem(key, val);
                // Actualizar contraseña en memoria para que el login funcione sin recargar
                const role = key.replace('_pwd_', '');
                const userIdx = users.findIndex(u => u.username === role);
                if (userIdx !== -1) users[userIdx].password = val;
            }
            break;
    }
}

// Firestore no impone un límite de tiempo propio a sus llamadas — en una red
// mala (motel con internet débil/intermitente) un .get() puede quedar
// "colgado" mucho más de lo razonable esperando una respuesta que nunca
// llega o tarda minutos. Como la carga inicial de abajo se hace en cadena
// (await tras await) y el listener en tiempo real (el que de verdad
// sincroniza al instante) recién se activa DESPUÉS de que toda esa cadena
// termine, una sola llamada colgada retrasaba la apertura del canal en vivo
// tanto como tardara esa llamada en fallar — minutos, a veces bastante más.
// _withTimeout() deja de esperar un paso lento sin cancelar la petición real
// (que puede seguir resolviendo en segundo plano sin causar daño): el
// listener en tiempo real, que sí trae el estado completo y actualizado en
// su primer snapshot, arranca de todos modos y termina poniendo todo al día.
export function _withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => {
            console.warn(`[App] "${label}" superó ${ms}ms — se continúa sin esperarlo (el listener en tiempo real lo pondrá al día).`);
            resolve(null);
        }, ms))
    ]);
}

export async function initFirebaseSync() {
    if (!window.FirebaseSync || !window.FirebaseSync.ready || _fbListening) return;
    _fbListening = true;
    _fbInitTime = Date.now();
    setAppReady(true);

    // Configurar callback de estado de conexión
    window.FirebaseSync.onStatusChange((isOnline, syncedCount) => {
        updateConnectionStatus(isOnline, syncedCount);
    });
    
    // Actualizar estado inicial
    updateConnectionStatus(window.FirebaseSync.isOnline(), 0);

    // 🔥 LISTENER EN TIEMPO REAL — activado DE INMEDIATO, en paralelo con la
    // carga "fresca" de una sola vez de abajo, no después de que termine ni
    // con un delay artificial (antes 2s). Prioridad: sincronizar lo más
    // rápido posible sin importar el costo en lecturas — el usuario ya está
    // en plan Blaze y pidió explícitamente esto. Correr ambos caminos en
    // paralelo es seguro porque los dos aplican los datos con las mismas
    // funciones de fusión idempotentes (mergeRoomsFromFirebase,
    // mergeArraysById, etc.) — no hay corrupción posible por la carrera.
    if (window.FirebaseSync.listenAll) {
        console.log('[App] 🔥 Activando sincronización en tiempo real (selectiva)...');
        _reactivateRealtimeListeners('carga inicial');
        setHotWindowAnchorKey(`${new Date().getFullYear()}_${new Date().getMonth()}`); // evita que el rollover horario vuelva a disparar la suscripción que ya se acaba de hacer arriba
        console.log('[App] ✅ Sincronización en tiempo real ACTIVADA (selectiva)');
        if (window.FirebaseSync.startReconnectionSystem) {
            window.FirebaseSync.startReconnectionSystem();
            console.log('[App] 🔄 Sistema de reconexión automática iniciado');
        }
    }

    // Cargar datos desde Firebase (fuente de verdad, "mejor esfuerzo" con
    // límite de tiempo — ver _withTimeout): el listener de arriba ya está
    // trayendo el estado real por su cuenta, así que esto es un complemento,
    // no un bloqueante.
    try {
        // Procesar cola offline PRIMERO: subir cambios locales pendientes antes de leer
        // el estado "fresco" de Firebase. Sin esto, Firebase podría devolver datos
        // más viejos que los cambios que el usuario hizo mientras estaba sin conexión.
        if (window.FirebaseSync.syncPending) {
            try { await _withTimeout(window.FirebaseSync.syncPending(), 6000, 'syncPending'); } catch(_) {}
        }

        console.log('[App] Cargando datos frescos desde Firebase (servidor)...');
        const fbData = (await _withTimeout(window.FirebaseSync.loadAllFresh(), 8000, 'loadAllFresh')) || {};

        let dataLoaded = false;
        
        if (Array.isArray(fbData.motelRoomDocs) && fbData.motelRoomDocs.length > 0) {
            // mergeRoomsFromFirebase() en vez de un reemplazo ciego del
            // arreglo: si un listener en tiempo real (ya activo desde el
            // arranque de esta función) entregó una actualización real
            // MIENTRAS esta carga lenta estaba en vuelo, un reemplazo ciego
            // la pisaría al llegar después — mergeRoomsFromFirebase resuelve
            // por timestamp de estado, así que gana quien de verdad pasó
            // último, sin importar el orden de llegada.
            setRooms(mergeRoomsFromFirebase(fbData.motelRoomDocs, rooms));
            localStorage.setItem('motelRooms', JSON.stringify(rooms));
            dataLoaded = true;
        } else if (fbData.motelRooms && fbData.motelRooms.length > 0) {
            // Merge inteligente en lugar de reemplazar directo - previene pérdida de datos locales
            setRooms(mergeRoomsFromFirebase(fbData.motelRooms, rooms));
            localStorage.setItem('motelRooms', JSON.stringify(rooms));
            dataLoaded = true;
        }
        // rooms ya pasó por su mejor intento de reconciliación con la nube
        // (por cualquiera de las dos ramas de arriba, o ninguna si Firebase
        // no devolvió nada) — re-suscribir los listeners por habitación
        // (registrados en 'carga inicial' contra el `rooms` de localStorage,
        // posiblemente vacío/viejo) contra el set ya actualizado, y abrir la
        // puerta de broadcast por-habitación. Llamada DIRECTA (no vía
        // _reactivateRealtimeListeners) para no toparse con su debounce de
        // 5s — _subscribeRoomDocListeners() solo hace Map.set en memoria, no
        // vuelve a abrir ninguna conexión.
        _subscribeRoomDocListeners();
        _markRoomsReconciled('carga inicial');
        if (Array.isArray(fbData.motelInventory)) {
            setInventory(mergeInventoryFromCloud(fbData.motelInventory, inventory));
            localStorage.setItem('motelInventory', JSON.stringify(inventory));
            dataLoaded = true;
        }
        // Ceder el hilo al navegador antes de los merges pesados para no bloquear la UI
        await new Promise(r => (typeof requestIdleCallback !== 'undefined'
            ? requestIdleCallback(r)
            : setTimeout(r, 0)));

        // roomRevenue/sales/expenses ya no viven en fbData (ver sección
        // SHARDING MENSUAL): se migran una sola vez desde los documentos
        // planos viejos y luego se cargan/escuchan por shard mensual.
        await _withTimeout(migrateToMonthlyShards(), 8000, 'migrateToMonthlyShards');
        await _withTimeout(_loadHotShardsFromFirebase(), 8000, '_loadHotShardsFromFirebase');
        persistHotShards();
        dataLoaded = true;
        if (Array.isArray(fbData.motelShiftReports)) {
            setShiftReports(fbData.motelShiftReports);
            localStorage.setItem('motelShiftReports', JSON.stringify(shiftReports));
            dataLoaded = true;
        }
        if (Array.isArray(fbData.motelShiftSnapshots)) {
            setShiftSnapshots(fbData.motelShiftSnapshots);
            localStorage.setItem('motelShiftSnapshots', JSON.stringify(shiftSnapshots));
            dataLoaded = true;
        }
        if (fbData.motelCurrentShiftStart) {
            // Solo usar Firebase si es MÁS RECIENTE que el valor local
            // Protege contra sobrescritura de un turno recién iniciado en este dispositivo
            if (!currentShiftStart || fbData.motelCurrentShiftStart > currentShiftStart) {
                setCurrentShiftStart(fbData.motelCurrentShiftStart);
                localStorage.setItem('motelCurrentShiftStart', JSON.stringify(currentShiftStart));
            }
            dataLoaded = true;
        }
        if (fbData.motelCurrentShiftType) {
            setCurrentShiftType(_normalizeShiftType(fbData.motelCurrentShiftType));
            localStorage.setItem('motelCurrentShiftType', currentShiftType);
            dataLoaded = true;
        }
        if (Array.isArray(fbData.motelActivityLog)) {
            setActivityLog(fbData.motelActivityLog);
            localStorage.setItem('motelActivityLog', JSON.stringify(activityLog));
            dataLoaded = true;
        }
        if (Array.isArray(fbData.motelReservations)) {
            // Merge por ID para preservar reservas locales no sincronizadas aún
            setReservations(mergeReservationsFromCloud(fbData.motelReservations, reservations));
            localStorage.setItem('motelReservations', JSON.stringify(reservations));
            dataLoaded = true;
        }
        if (Array.isArray(fbData.deepCleanSchedules)) {
            setDeepCleanSchedules(fbData.deepCleanSchedules);
            localStorage.setItem('deepCleanSchedules', JSON.stringify(deepCleanSchedules));
            dataLoaded = true;
        }
        if (Array.isArray(fbData.motelStaffMembers)) {
            setStaffMembers(fbData.motelStaffMembers);
            localStorage.setItem('motelStaffMembers', JSON.stringify(staffMembers));
            dataLoaded = true;
        }
        if (Array.isArray(fbData.motelAnnouncements)) {
            setAnnouncements(fbData.motelAnnouncements);
            localStorage.setItem('motelAnnouncements', JSON.stringify(announcements));
            dataLoaded = true;
        }
        if (Array.isArray(fbData.motelUsers)) {
            setUsers(fbData.motelUsers);
            localStorage.setItem('motelUsers', JSON.stringify(users));
            dataLoaded = true;
        }
        
        // Cargar contraseñas
        const pwdKeys = ['_pwd_supervisor', '_pwd_director', '_pwd_recepcion', '_pwd_limpieza'];
        pwdKeys.forEach(key => {
            if (fbData[key]) {
                localStorage.setItem(key, fbData[key]);
            }
        });
        
        if (dataLoaded) {
            console.log('[App] ✓ Datos cargados desde Firebase exitosamente');
        } else {
            console.log('[App] ⚠ No hay datos en Firebase, inicializando habitaciones por defecto');
            // Si Firebase está vacío, crear habitaciones iniciales SOLO UNA VEZ
            if (rooms.length === 0) {
                setRooms(createInitialRooms());
                console.log('[App] ✓ Habitaciones iniciales creadas');
            }
        }
        
        // Ahora que los datos están cargados, verificar currentShiftStart
        if (!currentShiftStart || currentShiftStart === 0) {
            setCurrentShiftStart(getShiftTimeRange().shiftStart);
            console.log('[App] currentShiftStart inicializado después de cargar Firebase');
        }
        
        // Inicializar currentShiftType si no existe
        if (!currentShiftType) {
            const now = new Date();
            const hour = now.getHours();
            setCurrentShiftType((hour >= 6 && hour < 18) ? 'day' : 'night');
            localStorage.setItem('motelCurrentShiftType', currentShiftType);
            console.log('[App] currentShiftType inicializado:', currentShiftType);
        }
        
        // Guardar datos iniciales solo si se cargó algo desde Firebase o si no hay habitaciones locales
        if (dataLoaded || rooms.length === 0) {
            saveData();
        } else {
            console.warn('[Firebase] No se guardaron datos locales automáticamente porque no se detectó estado remoto válido');
        }
        
        // Sincronizar contraseñas locales a Firebase (si faltan)
        await syncLocalPasswordsToFirebase();
        
        // Re-renderizar interfaces
        if (currentUser) {
            if (currentUser.role === 'limpieza') {
                renderCleaningRooms();
            } else {
                renderRooms();
            }
            renderReservationsSidebar();
            renderInventory();
            renderSalesLog();
            updateExpensesTotal();
            updateStatistics();
            if (currentUser.role === 'director') {
                renderUsersList();
            }
        }
        
        await loadDeepCleanSchedules();
        
    } catch (err) {
        console.error('[App] Error cargando desde Firebase:', err);
        console.log('[App] Usando datos de localStorage como fallback');
        showToast('⚠️ Error cargando datos de la nube, usando datos locales', 'warning');
    }
}

let _freshReloadInProgress = false;

export async function _loadAllFreshWithRetry(reason, maxAttempts = 4) {
    if (_freshReloadInProgress) {
        console.log(`[App] Recarga fresca ya en curso, se ignora solicitud (${reason})`);
        return null;
    }
    _freshReloadInProgress = true;

    let delay = 1500;
    try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                console.log(`[App] Recarga fresca (${reason}) — intento ${attempt}/${maxAttempts}`);
                // Con límite de tiempo: sin esto, un intento colgado en mala
                // red nunca llegaba al finally de abajo, y _freshReloadInProgress
                // quedaba en true para siempre — todo resync futuro se
                // ignoraba silenciosamente hasta recargar la página entera.
                const fbData = await _withTimeout(window.FirebaseSync.loadAllFresh(), 10000, `loadAllFresh (${reason}, intento ${attempt})`);
                if (fbData && Object.keys(fbData).length > 0) {
                    return fbData;
                }
                throw new Error('loadAllFresh devolvió vacío o superó el límite de tiempo');
            } catch (e) {
                console.warn(`[App] Intento ${attempt} de recarga fresca falló (${reason}):`, e.message);
                if (attempt === maxAttempts) {
                    console.error('[App] Recarga fresca falló tras todos los reintentos:', e.message);
                    return null;
                }
                await new Promise(r => setTimeout(r, delay));
                delay = Math.min(delay * 2, 12000);
            }
        }
    } finally {
        _freshReloadInProgress = false;
    }
    return null;
}

// ============ SINCRONIZACIÓN AL VOLVER DEL BACKGROUND ============
// Cuando el usuario reabre el acceso directo o desbloquea el dispositivo,
// los listeners de Firebase pueden estar muertos (se cortan tras ~30 min en background).
// Este bloque detecta ese momento y fuerza una recarga fresca + reconexión de listeners.
(function() {
    let hiddenSince = 0;
    const STALE_THRESHOLD_MS = 60 * 1000; // si estuvo oculto > 1 min, recargar

    document.addEventListener('visibilitychange', async () => {
        if (document.hidden) {
            hiddenSince = Date.now();
            // Guardar estado INMEDIATAMENTE antes de que el SO pueda pausar el JS.
            // El throttle de 2 s puede no alcanzar a dispararse si la pantalla se bloquea.
            _saveDataImmediate();
            return;
        }

        // La página volvió a ser visible. Si nunca registramos que se ocultó
        // (hiddenSince sigue en 0), NO es un regreso real de background — es
        // un 'visibilitychange' espontáneo, algo que los navegadores móviles
        // disparan de vez en cuando sin que la pestaña haya estado oculta de
        // verdad (p.ej. al abrir la PWA, o al mostrar un permiso del
        // sistema). La versión anterior trataba ese caso como "Infinity ms
        // en background" y disparaba una recarga completa + resuscripción de
        // TODOS los listeners — que podía solaparse con la suscripción
        // inicial que ya estaba en curso y producir el registro duplicado
        // que Firestore rechaza con errores "already-exists" (ver
        // _reactivateRealtimeListeners).
        if (hiddenSince === 0) return;
        const hiddenMs = Date.now() - hiddenSince;
        hiddenSince = 0;

        if (hiddenMs < STALE_THRESHOLD_MS) return; // estuvo poco tiempo, no hace falta

        if (!window.FirebaseSync || !window.FirebaseSync.ready) return;

        console.log('[App] Volviendo del background — recargando datos frescos de Firebase...');
        try { showToast('Sincronizando datos…', 'info', 4000); } catch (e) {}

        try {
            // 1. Forzar reactivación de la red Firebase (puede estar dormida)
            //_db.enableNetwork().catch(() => {}); //COMENTADA 

            // 1.1. Reconexión DURA de los streams compartidos, ADEMÁS de (no
            // en vez de) la reactivación barata habitual — un celular
            // suspendido por el sistema operativo mucho tiempo puede dejar
            // el stream "zombie" (deja de entregar datos para siempre sin
            // disparar nunca su callback de error, así que el backoff/retry
            // normal nunca se activa). Volver de background tras rato oculto
            // es EXACTAMENTE el escenario de riesgo — forzar reconexión real
            // acá en vez de esperar a que el usuario note que algo quedó
            // desactualizado y tenga que recargar la página a mano.
            if (window.FirebaseSync.forceReconnectAll) {
                window.FirebaseSync.forceReconnectAll();
            }
            _reactivateRealtimeListeners('volver del background');

            // 1.5. Procesar cola offline PRIMERO — subir los cambios locales pendientes
            // ANTES de leer Firebase. De lo contrario, un loadAllFresh puede traer datos
            // más viejos que los cambios que quedaron en la cola mientras estaba sin red.
            if (window.FirebaseSync.syncPending) {
                try { await _withTimeout(window.FirebaseSync.syncPending(), 6000, 'syncPending (background)'); } catch(_) {}
            }

            // 2. Recargar datos directamente del servidor (sin caché stale),
            // con reintentos y backoff (ver _loadAllFreshWithRetry): en mala
            // red, un solo intento fallido dejaba la recarga sin aplicar
            // hasta el próximo regreso de background. El listener en tiempo
            // real ya se reactivó arriba en paralelo, así que esto es un
            // complemento — si falla tras todos los reintentos, se mantienen
            // los datos actuales en vez de aplicar un objeto vacío.
            const fbData = await _loadAllFreshWithRetry('volver del background');
            if (!fbData) {
                console.warn('[App] No se pudo recargar tras volver del background, se mantienen datos actuales');
                return;
            }

            // Aplicar datos frescos a las variables globales (misma lógica que initApp).
            // Prioridad a motelRoomDocs (colección dedicada, autoritativa) —
            // igual que en initFirebaseSync: mergeRoomsFromFirebase() sobre el
            // motelRooms plano compara por timestamp de reloj y podría
            // revertir un cambio reciente que ya está resuelto correctamente
            // vía la colección por habitación.
            if (Array.isArray(fbData.motelRoomDocs) && fbData.motelRoomDocs.length > 0) {
                // mergeRoomsFromFirebase() en vez del reemplazo ciego — ver
                // comentario largo en initFirebaseSync sobre por qué.
                setRooms(mergeRoomsFromFirebase(fbData.motelRoomDocs, rooms));
                localStorage.setItem('motelRooms', JSON.stringify(rooms));
            } else if (fbData.motelRooms && Array.isArray(fbData.motelRooms) && fbData.motelRooms.length > 0) {
                setRooms(mergeRoomsFromFirebase(fbData.motelRooms, rooms));
                localStorage.setItem('motelRooms', JSON.stringify(rooms));
            }
            // _reactivateRealtimeListeners('volver del background') ya se
            // llamó arriba, ANTES de que `rooms` se actualizara acá — los
            // listeners por habitación que registró en ese momento pueden
            // haber quedado contra un `rooms` desactualizado. Re-suscribir
            // ahora que `rooms` ya está reconciliado (llamada directa, sin
            // costo de red — ver comentario en initFirebaseSync).
            _subscribeRoomDocListeners();
            _markRoomsReconciled('volver del background');
            if (fbData.motelInventory && Array.isArray(fbData.motelInventory)) {
                setInventory(mergeInventoryFromCloud(fbData.motelInventory, inventory));
                localStorage.setItem('motelInventory', JSON.stringify(inventory));
            }
            // roomRevenue/sales/expenses: recargar/re-fusionar la ventana
            // caliente por shard mensual (ya no viven en fbData).
            await _withTimeout(_loadHotShardsFromFirebase(), 8000, '_loadHotShardsFromFirebase (background)');
            persistHotShards();
            rolloverHotWindowIfNeeded();
            if (fbData.motelReservations && Array.isArray(fbData.motelReservations)) {
                setReservations(mergeReservationsFromCloud(fbData.motelReservations, reservations));
                localStorage.setItem('motelReservations', JSON.stringify(reservations));
            }
            if (fbData.motelShiftReports && Array.isArray(fbData.motelShiftReports)) {
                setShiftReports(fbData.motelShiftReports);
                localStorage.setItem('motelShiftReports', JSON.stringify(shiftReports));
            }
            if (fbData.motelShiftSnapshots && Array.isArray(fbData.motelShiftSnapshots)) {
                setShiftSnapshots(fbData.motelShiftSnapshots);
                localStorage.setItem('motelShiftSnapshots', JSON.stringify(shiftSnapshots));
            }
            if (fbData.motelActivityLog && Array.isArray(fbData.motelActivityLog)) {
                setActivityLog(fbData.motelActivityLog);
                localStorage.setItem('motelActivityLog', JSON.stringify(activityLog));
            }
            if (fbData.motelStaffMembers && Array.isArray(fbData.motelStaffMembers)) {
                setStaffMembers(fbData.motelStaffMembers);
                localStorage.setItem('motelStaffMembers', JSON.stringify(staffMembers));
            }
            if (fbData.motelAnnouncements && Array.isArray(fbData.motelAnnouncements)) {
                setAnnouncements(fbData.motelAnnouncements);
                localStorage.setItem('motelAnnouncements', JSON.stringify(announcements));
            }
            if (fbData.motelUsers && Array.isArray(fbData.motelUsers)) {
                setUsers(fbData.motelUsers);
                localStorage.setItem('motelUsers', JSON.stringify(users));
            }
            if (fbData.deepCleanSchedules && Array.isArray(fbData.deepCleanSchedules)) {
                setDeepCleanSchedules(fbData.deepCleanSchedules);
                localStorage.setItem('deepCleanSchedules', JSON.stringify(deepCleanSchedules));
            }
            if (fbData.motelCurrentShiftStart) {
                setCurrentShiftStart(fbData.motelCurrentShiftStart);
                localStorage.setItem('motelCurrentShiftStart', JSON.stringify(currentShiftStart));
            }
            if (fbData.motelCurrentShiftType) {
                setCurrentShiftType(_normalizeShiftType(fbData.motelCurrentShiftType));
                localStorage.setItem('motelCurrentShiftType', currentShiftType);
            }

            // 4. Re-renderizar vistas críticas
            if (currentUser) {
                if (currentUser.role === 'limpieza') renderCleaningRooms();
                else renderRooms();
                renderReservationsSidebar();
                updateStatistics();
                renderSalesLog();
                renderInventory();
                renderAnnouncementsList();
                updateExpensesTotal();
                if (currentUser.role === 'director') renderUsersList();
            }

            if (document.getElementById('shift-control-tab')?.classList.contains('active')) {
                updateShiftControl();
            } else {
                setShiftDataStale(true);
            }

            console.log('[App] Datos frescos aplicados tras volver del background.');
            updateConnectionStatus(window.FirebaseSync.isOnline(), 0);
        } catch (e) {
            console.error('[App] Error recargando tras background:', e);
            updateConnectionStatus(window.FirebaseSync.isOnline(), 0);
        }
    });

    window.addEventListener('online', async () => {
        console.log('[App] Evento online detectado, recargando datos frescos...');
        const fbData = await _loadAllFreshWithRetry('evento online');
        if (!fbData || !window.FirebaseSync || !window.FirebaseSync.ready) return;

        if (Array.isArray(fbData.motelRoomDocs) && fbData.motelRoomDocs.length > 0) {
            // mergeRoomsFromFirebase() en vez del reemplazo ciego — ver
            // comentario largo en initFirebaseSync sobre por qué.
            setRooms(mergeRoomsFromFirebase(fbData.motelRoomDocs, rooms));
            localStorage.setItem('motelRooms', JSON.stringify(rooms));
        } else if (fbData.motelRooms && Array.isArray(fbData.motelRooms) && fbData.motelRooms.length > 0) {
            setRooms(mergeRoomsFromFirebase(fbData.motelRooms, rooms));
            localStorage.setItem('motelRooms', JSON.stringify(rooms));
        }
        if (fbData.motelInventory && Array.isArray(fbData.motelInventory)) {
            setInventory(mergeInventoryFromCloud(fbData.motelInventory, inventory));
            localStorage.setItem('motelInventory', JSON.stringify(inventory));
        }

        // El navegador acaba de recuperar conexión — el stream compartido
        // pudo haber quedado zombie mientras estuvo sin red (ver
        // forceReconnectAll en firebase-sync.js). Reconexión dura ADEMÁS de
        // la reactivación barata habitual, mismo motivo que en el handler
        // de volver de background.
        if (window.FirebaseSync.forceReconnectAll) {
            window.FirebaseSync.forceReconnectAll();
        }
        _reactivateRealtimeListeners('evento online');
        _markRoomsReconciled('evento online');

        if (currentUser) {
            if (currentUser.role === 'limpieza') renderCleaningRooms();
            else renderRooms();
            renderReservationsSidebar();
            updateStatistics();
        }

        console.log('[App] Datos aplicados tras evento online.');
    });

})();
// ============ FIN SINCRONIZACIÓN AL VOLVER DEL BACKGROUND ============

// ============ DATOS DE PRUEBA (CIERRE DE MES) ============
// ELIMINADO POR SEGURIDAD: loadDummyData() y clearDummyData()
// Estas funciones permitían manipular datos desde la consola
// Si necesitas datos de prueba, contacta al administrador del sistema
// ============ FIN DATOS DE PRUEBA ============

// ============ RESETEO TOTAL DEL SISTEMA ============
// SOLO PARA DIRECTOR - Borra TODOS los datos de prueba de forma coordinada
// Para usar: Abre consola (F12) y escribe: resetSystemData()

/**
 * Resetea COMPLETAMENTE el sistema borrando todos los datos
 * Solo disponible para el director
 * Requiere confirmación con código especial
 */
export async function resetSystemData() {
    // Verificar que sea director
    if (!currentUser || currentUser.role !== 'director') {
        console.error('❌ ACCESO DENEGADO: Solo el director puede resetear el sistema');
        showToast('Acceso denegado: Solo el director puede usar esta función', 'error');
        return;
    }
    
    console.log('🔒 RESETEO TOTAL DEL SISTEMA');
    console.log('Esta función borrará TODOS los datos del sistema de forma permanente.');
    console.log('');
    console.log('Para confirmar, escribe en la consola:');
    console.log('  confirmResetSystem("BORRAR_TODO_2024")');
    console.log('');
    console.log('⚠️ ADVERTENCIA: Esta acción NO se puede deshacer');
}

/**
 * Confirmación del reseteo con código de seguridad
 */
export async function confirmResetSystem(code) {
    // Verificar código de seguridad
    if (code !== 'BORRAR_TODO_2024') {
        console.error('❌ Código incorrecto');
        showToast('Código de confirmación incorrecto', 'error');
        return;
    }
    
    // Verificar que sea director
    if (!currentUser || currentUser.role !== 'director') {
        console.error('❌ ACCESO DENEGADO');
        showToast('Acceso denegado', 'error');
        return;
    }
    
    // Confirmación final con modal
    const confirmed = await showCustomConfirm(
        '⚠️ RESETEO TOTAL DEL SISTEMA',
        '¿Estás COMPLETAMENTE seguro de borrar TODOS los datos?\n\n' +
        'Esto incluye:\n' +
        '• Todas las habitaciones (se resetearán a estado inicial)\n' +
        '• Todo el inventario\n' +
        '• Todas las ventas\n' +
        '• Todos los ingresos de habitaciones\n' +
        '• Todos los gastos\n' +
        '• Todos los reportes de turno\n' +
        '• Todas las reservas\n' +
        '• Todo el historial de actividad\n' +
        '• Todas las programaciones de limpieza\n' +
        '• Todos los reportes mensuales\n\n' +
        'Esta acción NO se puede deshacer y se sincronizará con TODOS los dispositivos.'
    );
    
    if (!confirmed) {
        console.log('❌ Reseteo cancelado por el usuario');
        showToast('Reseteo cancelado', 'info');
        return;
    }
    
    console.log('🔄 Iniciando reseteo total del sistema...');
    showToast('🔄 Reseteando sistema...', 'info');
    
    try {
        // PASO 0: Limpiar cola offline PRIMERO para evitar que se restauren datos
        if (window.FirebaseSync) {
            console.log('🔄 Limpiando cola offline...');
            try {
                // Limpiar cola offline del sistema
                localStorage.removeItem('_offlineQueue');
                console.log('✓ Cola offline limpiada');
            } catch (e) {
                console.warn('⚠️ Error limpiando cola offline:', e);
            }
        }
        
        // PASO 1: Borrar en FIREBASE PRIMERO (para que otros dispositivos no restauren)
        if (window.FirebaseSync && window.FirebaseSync.ready) {
            console.log('🔄 Borrando datos en Firebase (nube) PRIMERO...');
            
            // Datos vacíos para Firebase
            const emptyData = {
                motelRooms: createInitialRooms(),
                motelInventory: [],
                motelShiftReports: [],
                motelShiftSnapshots: [],
                motelCurrentShiftStart: Date.now(),
                motelActivityLog: [],
                motelReservations: [],
                deepCleanSchedules: []
            };
            
            await window.FirebaseSync.saveAll(emptyData);
            console.log('✓ Datos borrados en Firebase');
            
            // Esperar 2 segundos para que Firebase procese
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        // PASO 2: Resetear habitaciones a estado inicial
        setRooms(createInitialRooms());
        console.log('✓ Habitaciones reseteadas');
        
        // PASO 3: Limpiar todas las colecciones
        setInventory([]);
        setSales([]);
        setRoomRevenue([]);
        invalidateRevenueIndex();
        setExpenses([]);
        setShiftReports([]);
        setShiftSnapshots([]);
        setCurrentShiftStart(Date.now()); // Nuevo turno
        setCurrentShiftType((new Date().getHours() >= 6 && new Date().getHours() < 18) ? 'day' : 'night');
        setActivityLog([]);
        setReservations([]);
        setDeepCleanSchedules([]);
        console.log('✓ Colecciones limpiadas');
        
        // PASO 4: Limpiar reportes mensuales y shards financieros de TODOS
        // los meses guardados EN ESTE DISPOSITIVO. Igual que ya pasaba con
        // los reportes mensuales antes de este cambio: solo se limpia la
        // copia local de este navegador; los documentos correspondientes en
        // Firestore para meses fuera de la ventana caliente actual (más de
        // 2 meses atrás) no se enumeran ni se borran (no hay un índice de
        // qué meses tienen shard). Es una limitación ya aceptada para los
        // reportes mensuales; el reseteo total es una herramienta de
        // emergencia rara, no una operación cotidiana.
        const allKeys = Object.keys(localStorage);
        const mrKeys = allKeys.filter(key => key.startsWith('mr_') || key.startsWith('mrData_'));
        const shardKeys = allKeys.filter(key => key.startsWith('motelShard_'));
        [...mrKeys, ...shardKeys].forEach(key => {
            localStorage.removeItem(key);
        });
        console.log(`✓ ${mrKeys.length} reportes mensuales y ${shardKeys.length} shards financieros eliminados (local)`);

        // PASO 5: Guardar en localStorage
        safeLocalStorageSet('motelRooms', rooms);
        safeLocalStorageSet('motelInventory', inventory);
        safeLocalStorageSet('motelShiftReports', shiftReports);
        safeLocalStorageSet('motelShiftSnapshots', shiftSnapshots);
        safeLocalStorageSet('motelCurrentShiftStart', currentShiftStart);
        safeLocalStorageSet('motelActivityLog', activityLog);
        safeLocalStorageSet('motelReservations', reservations);
        safeLocalStorageSet('deepCleanSchedules', deepCleanSchedules);
        console.log('✓ Datos guardados en localStorage');
        
        // PASO 6: Sincronizar con Firebase NUEVAMENTE (por si acaso)
        if (window.FirebaseSync && window.FirebaseSync.ready) {
            console.log('🔄 Sincronizando con Firebase nuevamente...');
            
            await window.FirebaseSync.saveAll({
            motelRooms: rooms,
            motelInventory: inventory,
                motelShiftReports: shiftReports,
                motelShiftSnapshots: shiftSnapshots,
                motelCurrentShiftStart: currentShiftStart,
                motelActivityLog: activityLog,
                motelReservations: reservations,
                deepCleanSchedules: deepCleanSchedules
            });
            
            console.log('✓ Datos sincronizados con Firebase');
            
            // PASO 7: Limpiar reportes mensuales en Firebase
            console.log('🔄 Limpiando reportes mensuales en Firebase...');
            let mrCleaned = 0;
            for (const key of mrKeys) {
                try {
                    // Limpiar tanto mr_ como mrData_
                    const firebaseKey = key.startsWith('mr_') ? key.replace('mr_', '') : key;
                    await window.FirebaseSync.saveMrData(firebaseKey, null);
                    mrCleaned++;
                } catch (e) {
                    console.warn(`⚠️ No se pudo limpiar ${key} en Firebase:`, e.message);
                }
            }
            console.log(`✓ ${mrCleaned} reportes mensuales limpiados en Firebase`);

            // PASO 7b: Limpiar en Firebase los shards financieros conocidos por
            // este dispositivo (ventana caliente actual). Shards de meses más
            // viejos que nunca se cargaron en este dispositivo no se enumeran
            // aquí (misma limitación aceptada que en PASO 7 para reportes
            // mensuales de otros dispositivos).
            let shardsCleaned = 0;
            for (const key of shardKeys) {
                try {
                    const shardFbKey = key.replace('motelShard_', '');
                    await window.FirebaseSync.saveShardData(shardFbKey, null);
                    // Si ese mes se había dividido en partes (ver MAX_SHARD_BYTES),
                    // limpiar también las particiones "_p0", "_p1", ...
                    for (let p = 0; p < MAX_SHARD_LISTEN_PARTS; p++) {
                        await window.FirebaseSync.saveShardData(`${shardFbKey}_p${p}`, null);
                    }
                    shardsCleaned++;
                } catch (e) {
                    console.warn(`⚠️ No se pudo limpiar ${key} en Firebase:`, e.message);
                }
            }
            console.log(`✓ ${shardsCleaned} shards financieros limpiados en Firebase`);
        } else {
            console.warn('⚠️ Firebase no disponible - datos solo limpiados localmente');
        }
        
        // PASO 8: Datos reseteados exitosamente
        console.log('✓ Sistema reseteado completamente');
        
        // PASO 9: Registrar actividad del reseteo
        activityLog.push({
            id: Date.now(),
            type: 'system',
            description: '🔄 Sistema reseteado completamente',
            details: { resetBy: currentUser.name, timestamp: Date.now() },
            user: currentUser.name,
            timestamp: Date.now()
        });
        saveData();
        
        // PASO 10: Re-renderizar toda la interfaz
        if (currentUser.role === 'limpieza') {
            renderCleaningRooms();
        } else {
            renderRooms();
        }
        renderReservationsSidebar();
        renderInventory();
        renderSalesLog();
        updateExpensesTotal();
        updateStatistics();
        
        console.log('');
        console.log('✅ RESETEO COMPLETADO EXITOSAMENTE');
        console.log('');
        console.log('⚠️ IMPORTANTE: Ahora debes hacer lo siguiente en TODOS los dispositivos:');
        console.log('1. Abre la página en cada dispositivo (computadora, teléfono, tablet)');
        console.log('2. Presiona Ctrl + Shift + R (o Cmd + Shift + R en Mac)');
        console.log('3. Esto limpiará el caché y cargará los datos limpios desde Firebase');
        console.log('');
        console.log('Si no haces esto, los dispositivos pueden restaurar datos antiguos.');
        console.log('');
        
        showToast('✅ Sistema reseteado - REFRESCA TODOS LOS DISPOSITIVOS', 'success');
        
        // Mostrar modal de confirmación con instrucciones
        await showCustomAlert(
            '✅ Sistema Reseteado',
            'El sistema ha sido reseteado completamente.\n\n' +
            '⚠️ IMPORTANTE: Ahora debes hacer esto en TODOS los dispositivos:\n\n' +
            '1. Abre la página en cada dispositivo\n' +
            '2. Presiona Ctrl + Shift + R (limpia caché)\n' +
            '3. Verifica que los datos estén limpios\n\n' +
            'Si no refrescas todos los dispositivos, pueden restaurar datos antiguos.\n\n' +
            'Puedes comenzar a ingresar datos reales ahora.'
        );
        
    } catch (error) {
        console.error('❌ ERROR durante el reseteo:', error);
        showToast('❌ Error durante el reseteo: ' + error.message, 'error');
        
        // Intentar recargar datos desde Firebase si algo salió mal
        console.log('🔄 Recargando datos desde Firebase...');
        if (window.FirebaseSync && window.FirebaseSync.isOnline()) {
            try {
                await window.FirebaseSync.loadAllData();
                console.log('✓ Datos recargados desde Firebase');
                showToast('⚠️ Error en reseteo - datos recargados desde Firebase', 'warning');
            } catch (e) {
                console.error('❌ Error recargando desde Firebase:', e);
                showToast('❌ Error crítico - contacta al administrador', 'error');
            }
        }
    }
}

/**
 * Sincronizar contraseñas locales a Firebase (si no existen en Firebase)
 */
export async function syncLocalPasswordsToFirebase() {
    if (!window.FirebaseSync || !window.FirebaseSync.ready) return;
    
    const passwordKeys = ['supervisor', 'director', 'recepcion', 'limpieza'];
    
    for (const username of passwordKeys) {
        const localPassword = localStorage.getItem(`_pwd_${username}`);
        
        if (localPassword) {
            try {
                const firebasePassword = await window.FirebaseSync.load(`_pwd_${username}`);
                
                if (!firebasePassword) {
                    await window.FirebaseSync.save(`_pwd_${username}`, localPassword);
                }
            } catch (err) {
                console.error(`[Firebase] Error sincronizando contraseña de ${username}:`, err);
            }
        }
    }
}


/**
 * Subir datos a Firebase
 */
export async function uploadToFirebase() {
    const statusEl = document.getElementById('syncStatus');
    statusEl.textContent = '⏳ Subiendo datos a Firebase...';
    
    try {
        await saveData(); // Forzar guardado
        
        // Esperar un momento para que se complete
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        statusEl.textContent = '✅ Datos subidos exitosamente a Firebase';
        showToast('✅ Datos sincronizados con Firebase', 'success');
    } catch (error) {
        console.error('[Sync] Error subiendo a Firebase:', error);
        statusEl.textContent = '❌ Error subiendo datos';
        showToast('❌ Error sincronizando con Firebase', 'error');
    }
}

/**
 * Descargar datos desde Firebase
 */
export async function downloadFromFirebase() {
    const statusEl = document.getElementById('syncStatus');
    statusEl.textContent = '⏳ Descargando datos desde Firebase...';
    
    try {
        await initFirebaseSync(); // Recargar datos desde Firebase
        
        // Recargar interfaz
        if (currentUser) {
            await init();
            switchTab('rooms'); // Volver a la pestaña de habitaciones
        }
        
        statusEl.textContent = '✅ Datos descargados y aplicados exitosamente';
        showToast('✅ Datos sincronizados desde Firebase', 'success');
        
        // Cerrar modal después de 2 segundos
        setTimeout(() => closeSyncModal(), 2000);
    } catch (error) {
        console.error('[Sync] Error descargando desde Firebase:', error);
        statusEl.textContent = '❌ Error descargando datos';
        showToast('❌ Error sincronizando desde Firebase', 'error');
    }
}


// Esperar a que Firebase esté listo
// FIXED: Aumentado timeout a 15 segundos para Safari
export async function waitForFirebase() {
    return new Promise((resolve) => {
        if (window.FirebaseSync && window.FirebaseSync.ready) {
            resolve(true);
            return;
        }
        
        let attempts = 0;
        const maxAttempts = 150; // 15 segundos (150 * 100ms)
        
        const checkFirebase = () => {
            attempts++;
            if (window.FirebaseSync && window.FirebaseSync.ready) {
                resolve(true);
            } else if (attempts >= maxAttempts) {
                console.error('[Firebase] Timeout después de 15 segundos');
                resolve(false); // FIXED: Resolver con false en lugar de quedar colgado
            } else {
                setTimeout(checkFirebase, 100);
            }
        };
        
        checkFirebase();
    });
}

window.downloadFromFirebase = downloadFromFirebase;
window.uploadToFirebase = uploadToFirebase;