// Efecto secundario: este import es lo que hace `window.FirebaseSync = ...`
// (antes lo hacía cargar firebase-sync.js como <script> suelto en index.html
// antes que app.js; con Vite hay que importarlo explícitamente).
import './core/firebase/index.js';

import { checkSession, showMainApp } from './features/session.js';
import { openSyncDebugModal } from './features/sync-debug.js';
import { waitForFirebase, initFirebaseSync } from './system.js';
import { _getCachedUsersSync, _refreshUsersFromFirebase } from './features/users.js';
import { verifyPassword } from './features/password.js';
import { createReservationFromSidebar } from './features/rooms.js';
import { safeLocalStorageSet, safeLocalStorageGet, _loadHotShardsFromLocalStorage, safeJSONParse} from './utils/storage-utils.js';
import { showToast } from './utils/toast-system.js';
import { _markRoomsReconciled } from './features/rooms.js';
import { showMergeConflictLog } from './utils/logger.js';
import { getShiftTimeRange, getCurrentShift } from './features/shifts.js';
import { renderInventory } from './features/sales.js';
import { initMonthlyReport } from './features/monthly-report.js';
import { _normalizeShiftType } from './utils/formatters.js';
import { renderAnnouncementsList } from './features/announcements.js';
import { updateShiftControl } from './features/shifts.js';
import { renderSalesLog } from './features/sales.js';
import { renderExpensesLog } from './features/expenses.js';
import { renderRooms } from './features/rooms.js';
import { updateExpensesTotal } from './features/expenses.js';
import { renderScheduledCleansList } from './features/cleaning.js';
import { updateStatistics } from './features/shifts.js';
import { updateRoomRevenueDisplay } from './features/rooms.js';
import { renderAttendanceList } from './features/attendance.js';
import { renderAttendanceHistory } from './features/attendance.js';
import { downloadMonthlyExcel } from './features/excel-export.js';

// Mostrar en el header qué build de app.js corre ESTE dispositivo — para
// comparar a simple vista entre celular y PC antes de diagnosticar un
// problema de sincronización como si fuera de red/Firebase.
// __BUILD_TIME__ lo reemplaza Vite en build time (ver vite.config.js).
const _buildTagEl = document.getElementById('appBuildTag');
if (_buildTagEl) _buildTagEl.textContent = 'build ' + __BUILD_TIME__;


// ============ SISTEMA DE AUTENTICACIÓN Y PERMISOS ============
// Version: 5.7.0 - Corrección de Fallos Críticos de Seguridad
// 
// MEJORAS v5.7.0:
// - 🔒 SEGURIDAD: Eliminadas contraseñas en texto plano
// - 🔒 CORREGIDO: Ingresos de reservas se registran al ocupar, no al crear
// - 🔒 CORREGIDO: Campo guestPhone en confirmReservationStart
// - 🔒 MEJORADO: Solo contraseñas hasheadas (SHA-256)
//
export let isSaving = false;
export let _pendingFirebaseSave = false; // true si llegó un cambio mientras isSaving estaba activo

// ELIMINADO POR SEGURIDAD: window.testShiftOverride
// Variable de testing eliminada en producción

// Array para almacenar IDs de intervalos y poder limpiarlos
export let activeIntervals = [];

// FIXED: Cache de elementos DOM para updateRoomTimers (Problem 4b)
export let roomTimerElements = new Map();

// FIXED: Sistema de logging mejorado para debugging
export const DEBUG_SYNC = false; // Cambiar a false en producción
export const syncLog = [];


// Exponer función para debugging
window.getSyncLog = () => syncLog;
window.clearSyncLog = () => { syncLog.length = 0; };

// Función de emergencia para re-renderizar habitaciones manualmente
/* movida a su nuevo módulo: repairRooms */;

export let users = [];
export let currentUser = null;

// Variables de filtrado
export let currentFilter = 'all';
export let searchRoomNumber = null;

// Historial de actividad
export let activityLog = [];

// Verificar sesión al cargar
/* movida a su nuevo módulo: checkSession */

// Mostrar pantalla de login
/* movida a su nuevo módulo: showLogin */

// Mostrar aplicación principal
/* movida a su nuevo módulo: showMainApp */

// Configurar permisos y vistas según el rol
/* movida a su nuevo módulo: setupPermissions */

// Vista especial para personal de limpieza
/* movida a su nuevo módulo: showCleaningView */

// Renderizar habitaciones para limpieza
/* movida a su nuevo módulo: renderCleaningRooms */

// Toggle estado de limpieza - Ahora abre modal de confirmación
/* movida a su nuevo módulo: toggleCleanRoom */

// Abrir modal de confirmación de limpieza
/* movida a su nuevo módulo: openCleaningModal */

// Confirmar limpieza de habitación
export let _confirmCleanRoomInProgress = false;

/* movida a su nuevo módulo: confirmCleanRoom */
// Login
document.addEventListener('DOMContentLoaded', () => {
    // ── FASE 1: INSTANTÁNEO (sin red) ──────────────────────────────
    document.body.classList.add('loaded');          // página visible de inmediato
    users = _getCachedUsersSync();                  // usuarios desde caché local
    _setupLoginForm();                              // formulario listo para usar
    _setupReservationForm();                        // formulario reservas
    checkSession();                                 // muestra login o mainApp según sesión

    // Acceso al panel de diagnóstico (openSyncDebugModal) sin necesidad de
    // devtools: el botón se quitó del header (ya no hace falta a la vista),
    // pero sigue siendo la única forma práctica de ver el estado de
    // sincronización EN un celular real — visitar la URL con #debug lo abre.
    if (location.hash === '#debug') {
        setTimeout(() => { try { openSyncDebugModal(); } catch (e) {} }, 800);
    }
    // Agregar "#debug" a una pestaña YA ABIERTA, sin recargar, solo cambia
    // el fragmento de la URL — no dispara una navegación completa. Es la
    // única forma de inspeccionar una sesión que lleva rato viva (p.ej. un
    // listener que se quedó "muerto" en silencio) tal como está, sin
    // resetear justo el estado que se quiere diagnosticar.
    window.addEventListener('hashchange', () => {
        if (location.hash === '#debug') { try { openSyncDebugModal(); } catch (e) {} }
    });

    // ── FASE 2: SEGUNDO PLANO (con red) ───────────────────────────
    waitForFirebase().then(async (firebaseReady) => {
        if (!firebaseReady) {
            console.warn('[App] Firebase no disponible, trabajando sin sincronización');
            return;
        }
        // Refrescar usuarios con contraseñas actualizadas desde Firebase
        await _refreshUsersFromFirebase().catch(() => {});
        // Si hay sesión activa, sincronizar datos (initFirebaseSync evita doble ejecución con _fbListening)
        if (currentUser) {
            await initFirebaseSync().catch(() => {});
        }
    }).catch(() => {});

    // PLACEHOLDER - los formularios se configuran abajo
    function _setupLoginForm() {
    const loginForm = document.getElementById('loginForm');
    if (!loginForm) return;
    let _loginInProgress = false;
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (_loginInProgress) return;
        _loginInProgress = true;

        const submitBtn = loginForm.querySelector('button[type="submit"]');
        const originalText = submitBtn ? submitBtn.textContent : '';
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Iniciando...'; }

        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const errorDiv = document.getElementById('loginError');
        errorDiv.style.display = 'none';

        try {
            // Asegurarse de tener usuarios (caché o Firebase)
            if (!users || users.length === 0) users = _getCachedUsersSync();

            const user = users.find(u => u.username === username);
            if (user) {
                const isValid = await verifyPassword(password, user.password);
                if (isValid) {
                    currentUser = user;
                    safeLocalStorageSet('currentUser', user);
                    errorDiv.style.display = 'none';
                    showMainApp();
                    return;
                }
            }
            // Si las contraseñas locales fallan, intentar refrescar desde Firebase y reintentar
            if (window.FirebaseSync && window.FirebaseSync.ready) {
                await _refreshUsersFromFirebase().catch(() => {});
                const freshUser = users.find(u => u.username === username);
                if (freshUser) {
                    const isValid2 = await verifyPassword(password, freshUser.password);
                    if (isValid2) {
                        currentUser = freshUser;
                        safeLocalStorageSet('currentUser', freshUser);
                        errorDiv.style.display = 'none';
                        showMainApp();
                        return;
                    }
                }
            }
            errorDiv.textContent = 'Usuario o contraseña incorrectos';
            errorDiv.style.display = 'block';
        } catch (err) {
            console.error('[Login] Error:', err);
            errorDiv.textContent = 'Error al iniciar sesión. Intenta de nuevo.';
            errorDiv.style.display = 'block';
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalText; }
            _loginInProgress = false;
        }
    });
    }

    function _setupReservationForm() {
    const reservationForm = document.getElementById('reservationForm');
    if (reservationForm) {
        reservationForm.addEventListener('submit', (e) => {
            e.preventDefault();
            try {
                const roomId = document.getElementById('reservationRoomSelect')?.value || '';
                const guestName = document.getElementById('reservationName')?.value || '';
                const phone = document.getElementById('reservationPhone')?.value || '';
                const date = document.getElementById('reservationDate')?.value || '';
                const time = document.getElementById('reservationTime')?.value || '';
                const priceRaw = document.getElementById('reservationPrice')?.value || '';
                const paymentMethod = document.getElementById('reservationPaymentMethod')?.value || '';

                if (!date || !time) throw new Error('Selecciona fecha y hora');
                const ts = new Date(`${date}T${time}`).getTime();
                if (!Number.isFinite(ts)) throw new Error('Fecha u hora inválidas');
                const price = Number(priceRaw);
                if (!Number.isFinite(price) || price <= 0) throw new Error('Ingresa un precio válido');

                createReservationFromSidebar({
                    roomId,
                    guestName,
                    phone,
                    reservationTimestamp: ts,
                    paymentMethod,
                    price
                });

                reservationForm.reset();
                showToast('Reserva guardada', 'success');
            } catch (err) {
                showToast(err?.message || 'No se pudo guardar la reserva', 'error');
            }
        });
    }
    } // end _setupReservationForm
}); // end DOMContentLoaded

// Logout
/* movida a su nuevo módulo: logout */

// Data Storage
export let rooms = [];
export let roomRevenue = [];
export let roomRevenueIndex = null; // Índice para búsquedas rápidas
export let sales = [];
export let inventory = [];
export let expenses = [];
export let shiftReports = [];
export let reservations = [];
export let staffMembers = []; // Personal para control de asistencia
export let announcements = []; // Avisos del director

export const RESERVATION_LOCK_MS = 12 * 60 * 60 * 1000;

// ============================================================================
// SHARDING MENSUAL DE roomRevenue / sales / expenses
// ============================================================================
// Estos 3 arreglos representan solo una VENTANA CALIENTE de 3 meses
// calendario (el actual + los 2 anteriores) en vez de todo el historial desde
// siempre. Antes se guardaban como un único documento gigante por arreglo
// (motelRoomRevenue/motelSales/motelExpenses), lo que chocaba tarde o
// temprano contra el límite de localStorage del navegador (~5-10MB) y el
// límite duro de 1MB por documento de Firestore. Ahora se persisten en un
// documento separado POR MES (uno por cada combinación mes+tipo), igual que
// ya se hacía para el Reporte Mensual (_mrData). Los meses fuera de la
// ventana caliente se cargan bajo demanda (loadMonthShard) cuando el Reporte
// Mensual navega hacia atrás — nunca quedan residentes en memoria.
export const HOT_WINDOW_MONTHS = 3; // mes actual + 2 anteriores (cubre de sobra la
                              // ventana móvil de 30 días de las estadísticas
                              // por período y el mes anterior para "anteriores")

// Combos "tipo_año_mes" que sabemos particionados (shard > 700KB, ver
// MAX_SHARD_BYTES) — poblado por _loadShardFromFirebase(). Solo estos
// necesitan listeners en tiempo real para sus documentos "_p0".."_p7"; ver
// _subscribeHotWindowListeners() más abajo.
export const _shardPartitionedCombos = new Set();

// Carga un shard mensual completo desde Firebase, sin importar si está
// guardado como un solo documento o repartido en partes "_p0", "_p1", ...


// Devuelve [{year, month}, ...] para la ventana caliente, mes actual primero.
/* movida a src/utils/hot-window.js: getHotWindowMonths */

/* movida a src/utils/hot-window.js: _isInHotWindow */

// Lectura síncrona de los registros de un mes para el Reporte Mensual: si es
// un mes de la ventana caliente, filtra el arreglo en memoria (roomRevenue/
// sales/expenses); si es un mes frío, usa la caché ya poblada por
// ensureMonthDataLoaded() (debe haberse llamado antes, con await, en el
// punto de entrada — onMonthYearChange, downloadMonthlyExcel, etc.).
/* movida a src/utils/hot-window.js: getMonthRecords */

/* movida a src/utils/hot-window.js: _subscribeHotWindowListeners */

// Punto ÚNICO para (re)activar los listeners en tiempo real (motelRooms/etc.
// vía listenAll + los shards de roomRevenue/sales/expenses vía
// _subscribeHotWindowListeners). Antes había varios disparadores
// independientes llamando a listenAll()/_subscribeHotWindowListeners()
// directamente (carga inicial, volver del background, reintentos): si dos
// de ellos se disparaban a los pocos segundos uno del otro — algo que SÍ
// pasa en celulares, donde el evento 'visibilitychange' puede dispararse
// espontáneamente aunque la página nunca estuvo realmente oculta — cada uno
// tiraba abajo y volvía a crear el mismo lote de ~20 listeners casi
// simultáneamente. Eso es lo que produce los errores "already-exists" en
// cascada del panel de diagnóstico: dos registros del mismo listener
// pisándose en la capa de persistencia de Firestore, dejando ese canal
// muerto. Este debounce asegura que solo una reactivación real ocurra cada
// pocos segundos, sin importar cuántos disparadores se activen a la vez.
// Log visible en el panel 🩺 (ver _buildSyncDebugReport) de este nivel de la
// app — el de firebase-sync.js solo ve listeners individuales, no CUÁNTAS
// veces ni desde dónde se dispara la reactivación completa, que es
// justamente lo que hace falta ver para confirmar si el debounce de abajo
// está evitando colisiones.

/* movida a src/utils/hot-window.js: _reactivateRealtimeListeners */

// Suscribe UN listener por habitación — todos comparten el mismo stream de
// la colección motelRoomDocs, así que registrar los 32 no cuesta 32
// conexiones reales. Al llegar un cambio real de OTRO dispositivo para una
// habitación, se reemplaza DIRECTO en el arreglo local: Firestore ya decidió
// del lado del servidor cuál escritura es la vigente para ese documento.
/* movida a src/utils/hot-window.js: _subscribeRoomDocListeners */

// Detecta si el mes calendario cambió desde la última vez que se revisó; si
// cambió, suelta de memoria los registros que salieron de la ventana
// caliente (ya están a salvo en su propio shard) y vuelve a suscribir los
// listeners a la nueva ventana. Se llama al iniciar y periódicamente.
/* movida a src/utils/hot-window.js: rolloverHotWindowIfNeeded */

/**
 * Reserva "bloqueada" en UI: falta 12h o menos para reservationTimestamp (o ya pasó).
 */
/* movida a su nuevo módulo: isRoomReservationLocked */

/* movida a su nuevo módulo: renderReservationsSidebar */


/* movida a su nuevo módulo: createReservationFromSidebar */

/* movida a su nuevo módulo: cancelReservation */

/* movida a su nuevo módulo: confirmReservationStart */

export let currentRoomId = null;
export let editingProductId = null;
export let currentCategoryFilter = 'all';
export let _appReady = false;

// Puerta que evita reenviar el arreglo `rooms` completo a la colección
// motelRoomDocs (ver saveDataThrottled/_saveDataImmediate) ANTES de que este
// dispositivo haya reconciliado su copia de `rooms` con la nube al menos una
// vez en la sesión. Sin esto: un dispositivo recién reabierto arranca con
// `rooms` de localStorage (posiblemente desactualizado — no vio un check-in
// hecho en otro dispositivo mientras estaba cerrado), activa los listeners
// de inmediato, pero la carga fresca tarda unos segundos en resolver. Si el
// usuario toca CUALQUIER OTRA habitación en esa ventana, el guardado
// reenvía la copia vieja de la habitación NO tocada, pisando el estado real
// en Firestore — el bug de "se marca ocupada y luego aparece disponible
// sola". Mientras la puerta está cerrada, localStorage y el documento plano
// motelRooms (con su propia cola offline y fallback de fusión por
// timestamp) se siguen guardando exactamente igual — no se pierde nada,
// solo se retrasa el broadcast por-habitación hasta que la puerta abra.
export let _roomsReconciledWithCloud = false;
/* movida a su nuevo módulo: _markRoomsReconciled */
// Respaldo: si por algún motivo initFirebaseSync() nunca llega a reconciliar
// (Firebase caído, error inesperado), no dejar el guardado por-habitación
// bloqueado indefinidamente — abrir la puerta de todos modos tras 15s.
setTimeout(() => _markRoomsReconciled('watchdog 15s'), 15000);

export let shiftSnapshots = []; // Snapshots de habitaciones al cerrar turno
export let currentShiftStart = null; // Timestamp de inicio del turno actual
export let currentShiftType = null; // Tipo de turno actual ('day' o 'night') - MANUAL
export let _shiftDataStale = false;  // Indica que la pantalla de turno necesita refresco

export const EXPECTED_ROOM_COUNT = 32;

/* movida a su nuevo módulo: isValidRoomsArray */

/** Corrige building ausente o erróneo usando el prefijo del id (regulares-N / torre-N). */
/* movida a su nuevo módulo: tryRepairRoomsFromIds */

// Compara dos habitaciones campo por campo (no por JSON.stringify crudo: el
// orden de claves de un objeto reconstruido por JSON.parse(doc.data().value)
// no tiene por qué coincidir con el del objeto local, y eso produciría
// falsos positivos aunque los valores sean idénticos).
/* movida a su nuevo módulo: _roomsDiffer */

/**
 * Merge inteligente de habitaciones desde Firebase
 * VERSIÓN MEJORADA: Resolución campo por campo con versionado
 * Preserva TODAS las habitaciones y resuelve conflictos granularmente
 */
/* movida a su nuevo módulo: mergeRoomsFromFirebase */

/**
 * Resuelve conflictos entre dos versiones de la misma habitación.
 *
 * Regla única: gana el lado cuyo CAMBIO DE ESTADO sea genuinamente más
 * reciente (con tolerancia de reloj), sin importar si ese estado es
 * 'occupied', 'dirty', 'available', etc. Esto evita el bug donde una
 * habitación recién marcada 'dirty' (o 'occupied') era revertida segundos
 * después por un push de otro dispositivo con datos obsoletos en memoria:
 * las reglas anteriores daban prioridad incondicional a 'occupied' sin
 * comparar timestamps, así que un dato viejo podía pisar un cambio nuevo.
 *
 * El "timestamp de estado" de cada lado es el momento en que ESE estado
 * concreto se estableció (checkInTime para occupied, dirtyTimestamp para
 * dirty, lastModified para el resto) — no basta con lastModified global
 * porque un push completo del arreglo de habitaciones desde otro
 * dispositivo puede traer lastModified reciente sin que ese estado en
 * particular haya cambiado realmente.
 */
// Reloj usado para los timestamps de ESTADO de habitación (lastModified,
// checkInTime, dirtyTimestamp). Date.now() crudo asume que los relojes de
// todos los dispositivos están sincronizados entre sí — si el celular de
// recepción tiene el reloj atrasado respecto al de la PC, sus cambios
// pierden SIEMPRE la comparación de conflicto sin importar cuál pasó
// realmente antes. getCorrectedNow() (si existe en FirebaseSync) corrige
// ese desfase; si no existe todavía, cae a Date.now() sin romper nada.
/* movida a su nuevo módulo: _roomSyncNow */

/* movida a su nuevo módulo: roomStatusTimestamp */

// Prioridad de negocio usada SOLO como desempate cuando ambos timestamps
// caen dentro de la ventana de tolerancia (cambio verdaderamente ambiguo).
// occupied > dirty > reserved > available/not-available: perder un check-in
// o dejar de saber que un cuarto está sucio es más costoso que al revés.
export const ROOM_STATUS_PRIORITY = { occupied: 4, dirty: 3, reserved: 2, available: 1, 'not-available': 1 };

/* movida a su nuevo módulo: resolveRoomConflict */


export let _hotWindowAnchorKey = null; // "{year}_{month}" del mes actual la última vez que se revisó

// Exponer función para debugging
window.showMergeConflictLog = showMergeConflictLog;

/* movida a su nuevo módulo: persistMotelRoomsOnly */

/* movida a su nuevo módulo: ensureRoomsSanity */

// Load data from localStorage con manejo de errores por clave

// ============================================================================
// SETTERS DE ESTADO COMPARTIDO
// Los módulos externos NO pueden reasignar un `import` directamente (solo
// leerlo) — cualquier archivo que necesite REEMPLAZAR una de estas variables
// (no solo mutarla con .push()/.filter() en sitio) debe llamar a su setter.
// ============================================================================

export function setIsSaving(value) { isSaving = value; }
export function setPendingFirebaseSave(value) { _pendingFirebaseSave = value; }
export function setActiveIntervals(value) { activeIntervals = value; }
export function setUsers(value) { users = value; }
export function setCurrentUser(value) { currentUser = value; }
export function setCurrentFilter(value) { currentFilter = value; }
export function setSearchRoomNumber(value) { searchRoomNumber = value; }
export function setActivityLog(value) { activityLog = value; }
export function setConfirmCleanRoomInProgress(value) { _confirmCleanRoomInProgress = value; }
export function setRooms(value) { rooms = value; }
export function setRoomRevenue(value) { roomRevenue = value; }
export function setRoomRevenueIndex(value) { roomRevenueIndex = value; }
export function setSales(value) { sales = value; }
export function setInventory(value) { inventory = value; }
export function setExpenses(value) { expenses = value; }
export function setShiftReports(value) { shiftReports = value; }
export function setReservations(value) { reservations = value; }
export function setStaffMembers(value) { staffMembers = value; }
export function setAnnouncements(value) { announcements = value; }
export function setHotWindowAnchorKey(value) { _hotWindowAnchorKey = value; }
export function setCurrentRoomId(value) { currentRoomId = value; }
export function setEditingProductId(value) { editingProductId = value; }
export function setCurrentCategoryFilter(value) { currentCategoryFilter = value; }
export function setAppReady(value) { _appReady = value; }
export function setRoomsReconciledWithCloud(value) { _roomsReconciledWithCloud = value; }
export function setShiftSnapshots(value) { shiftSnapshots = value; }
export function setCurrentShiftStart(value) { currentShiftStart = value; }
export function setCurrentShiftType(value) { currentShiftType = value; }
export function setShiftDataStale(value) { _shiftDataStale = value; }
export function setAutoShiftCheckInProgress(value) { _autoShiftCheckInProgress = value; }
export function setDeepCleanSchedules(value) { deepCleanSchedules = value; }
export function setCurrentRevenueType(value) { currentRevenueType = value; }
export function setCurrentRevenueFilter(value) { currentRevenueFilter = value; }
export function setCurrentRoomsActivityFilter(value) { currentRoomsActivityFilter = value; }
export function setCurrentExpensesPeriod(value) { currentExpensesPeriod = value; }
export function setCurrentExpensesShift(value) { currentExpensesShift = value; }
export function setMrData(value) { _mrData = value; }
export function setMrMonth(value) { _mrMonth = value; }
export function setMrYear(value) { _mrYear = value; }
export function setCurrentWeek(value) { _currentWeek = value; }
export function setPayrollEmployees(value) { _payrollEmployees = value; }
export function setEditingEmployeeId(value) { _editingEmployeeId = value; }
export function setMrUnlistenFn(value) { _mrUnlistenFn = value; }

export function loadData() {
    const parseKey = (key, fallback) => safeLocalStorageGet(key, fallback);

    rooms            = parseKey('motelRooms', []);
    inventory        = parseKey('motelInventory', []);
    _loadHotShardsFromLocalStorage(); // llena roomRevenue/sales/expenses (ventana caliente de 3 meses)
    shiftReports     = parseKey('motelShiftReports', []);
    shiftSnapshots   = parseKey('motelShiftSnapshots', []);
    activityLog      = parseKey('motelActivityLog', []);
    reservations     = parseKey('motelReservations', []);
    deepCleanSchedules = parseKey('deepCleanSchedules', []);
    staffMembers     = parseKey('motelStaffMembers', []);
    announcements    = parseKey('motelAnnouncements', []);

    // currentShiftStart guardado como número serializado
    const rawShiftStart = localStorage.getItem('motelCurrentShiftStart');
    currentShiftStart = rawShiftStart ? (Number(safeJSONParse(rawShiftStart, 0)) || 0) : 0;

    // Si currentShiftStart es 0 (primer uso o localStorage limpio), inicializar con el
    // inicio del turno actual para que los filtros de ventas/gastos no devuelvan todo el historial
    if (!currentShiftStart || currentShiftStart === 0) {
        currentShiftStart = getShiftTimeRange().shiftStart;
        localStorage.setItem('motelCurrentShiftStart', JSON.stringify(currentShiftStart));
    }

    currentShiftType = localStorage.getItem('motelCurrentShiftType') || null;

    // Construir índices si hay suficientes datos
    if (roomRevenue.length > 100) {
        buildRevenueIndex();
    }
}

// Create initial rooms
/* movida a su nuevo módulo: createInitialRooms */

// Migrar nombres de habitaciones de Torre Nueva (ejecutar una sola vez)
/* movida a su nuevo módulo: migrateRoomNames */

// Switch tabs - función única con toda la lógica
export function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    const tabBtn = document.querySelector(`[data-tab="${tabName}"]`);
    const tabContent = document.getElementById(`${tabName}-tab`);
    if (tabBtn) tabBtn.classList.add('active');
    if (tabContent) tabContent.classList.add('active');
    
    // Reaplicar permisos después de cambiar de pestaña
    if (currentUser) {
        const role = currentUser.role;
        document.querySelectorAll('[data-roles]').forEach(element => {
            const allowedRoles = element.dataset.roles.split(',');
            element.style.display = allowedRoles.includes(role) ? '' : 'none';
        });
    }
    
    // FIXED: Envolver llamadas pesadas en setTimeout para liberar UI thread (Problem 4a)
    if (tabName === 'statistics') {
        setTimeout(() => {
            // FIXED: Verificar que la pestaña sigue activa (Problem 4c)
            if (document.getElementById('statistics-tab')?.classList.contains('active')) {
                updateStatistics();
                updateRoomRevenueDisplay('day');
                updateRevenueStats('day');
                if (currentUser && currentUser.role === 'director') {
                    updateExpensesByPaymentMethod('day');
                    updateExpensesByCategory('day');
                }
            }
        }, 0);
    }
    
    if (tabName === 'shift-control') {
        setTimeout(() => {
            if (document.getElementById('shift-control-tab')?.classList.contains('active')) {
                if (_shiftDataStale) {
                    _shiftDataStale = false;
                    console.log('[Tab] Refrescando turno por datos obsoletos');
                    const savedStart = localStorage.getItem('motelCurrentShiftStart');
                    if (savedStart) currentShiftStart = Number(JSON.parse(savedStart));
                    const savedType = localStorage.getItem('motelCurrentShiftType');
                    if (savedType) currentShiftType = _normalizeShiftType(savedType);
                }
                updateShiftControl();
                updateStatistics();
                updateRoomRevenueDisplay('day');
            }
        }, 0);
    }
    
    if (tabName === 'inventory') {
        setTimeout(() => {
            // FIXED: Verificar que la pestaña sigue activa (Problem 4c)
            if (document.getElementById('inventory-tab')?.classList.contains('active')) {
                renderInventory();
                renderSalesLog();
                updateExpensesTotal();
                renderExpensesLog();
            }
        }, 0);
    }
    
    if (tabName === 'rooms') {
        setTimeout(() => {
            // FIXED: Verificar que la pestaña sigue activa (Problem 4c)
            if (document.getElementById('rooms-tab')?.classList.contains('active')) {
                if (currentUser && (currentUser.role === 'supervisor' || currentUser.role === 'director' || currentUser.role === 'recepcion')) {
                    renderRooms();
                    renderScheduledCleansList();
                } else if (currentUser && currentUser.role === 'recepcion') {
                    renderRooms();
                } else if (currentUser && currentUser.role === 'limpieza') {
                    // Sin condicionar al conteo actual de sucias: si ese
                    // conteo está mal por un listener desincronizado, volver
                    // a tocar esta pestaña es la recuperación manual natural
                    // que probaría un empleado — condicionar el re-render al
                    // mismo dato que podría estar mal bloqueaba esa recuperación.
                    renderCleaningRooms();
                    renderUpcomingDeepCleans();
                }
            }
        }, 0);
    }
    
    if (tabName === 'announcements') {
        setTimeout(() => {
            // FIXED: Verificar que la pestaña sigue activa (Problem 4c)
            if (document.getElementById('announcements-tab')?.classList.contains('active')) {
                renderAnnouncementsList();
                renderAttendanceList();
            }
        }, 0);
    }
    
    if (tabName === 'monthly-report') {
        setTimeout(() => {
            // FIXED: Verificar que la pestaña sigue activa (Problem 4c)
            if (document.getElementById('monthly-report-tab')?.classList.contains('active')) {
                initMonthlyReport();
            }
        }, 0);
    }
}


// Render recent cleaning notes in sidebar (SOLO NOTAS)
/* movida a su nuevo módulo: renderRecentCleaningNotes */

// Eliminar nota de limpieza (VERSIÓN MEJORADA)
/* movida a su nuevo módulo: deleteCleaningNote */

// Funci?n auxiliar para filtrar habitaciones
/* movida a su nuevo módulo: shouldShowRoom */

// Render rooms
/* movida a su nuevo módulo: renderRooms */

// Create room card
// Create room card
/* movida a su nuevo módulo: createRoomCard */



// Open room modal
/* movida a su nuevo módulo: openRoomModal */

// Actualizar countdown en el modal
/* movida a su nuevo módulo: updateModalCountdown */

// Renovar estancia
/* movida a su nuevo módulo: renewStay */

// Funciones de validación consolidadas
/* movida a su nuevo módulo: validatePaymentMethod */

/* movida a su nuevo módulo: validateRequired */

/* movida a su nuevo módulo: validatePositiveNumber */

/* movida a su nuevo módulo: useDefaultPrice */

/* movida a su nuevo módulo: showCustomPricing */

// Update room status
/* movida a su nuevo módulo: updateRoomStatus */

// Update room timers
// FIXED: Usar cache de elementos DOM en lugar de getElementById (Problem 4b)
/* movida a su nuevo módulo: updateRoomTimers */

// Guardar producto
/* movida a su nuevo módulo: saveProduct */

// Renderizar inventario
/* movida a su nuevo módulo: renderInventory */


// Actualizar selector de productos
/* movida a su nuevo módulo: updateProductSelect */

// Procesar venta
/* movida a su nuevo módulo: processSale */

// Renderizar registro de ventas del TURNO ACTUAL
/* movida a su nuevo módulo: renderSalesLog */


// ============ GASTOS OPERATIVOS ============

// Agregar gasto
/* movida a su nuevo módulo: addExpense */
/* movida a su nuevo módulo: renderExpensesLog */


// Eliminar gasto
// FIXED: Implementado soft delete en lugar de eliminación física
/* movida a su nuevo módulo: deleteExpense */

// Actualizar solo el total de egresos (para pestaña de Inventario)
/* movida a su nuevo módulo: updateExpensesTotal */

// Actualizar resumen de gastos
/* movida a su nuevo módulo: updateExpensesSummary */

/* movida a su nuevo módulo: getCurrentShift */

// Obtener inicio y fin del turno actual
/* movida a su nuevo módulo: getShiftTimeRange */



// Actualizar timer del turno
/* movida a su nuevo módulo: updateShiftTimer */

// Actualizar actividad reciente
/* movida a su nuevo módulo: updateRecentActivity */

// Actualizar control de turno
/* movida a su nuevo módulo: updateShiftControl */


// ============ ELIMINAR ELEMENTO DEL HISTORIAL ============

// Función para ocultar un elemento del historial (NO modifica ingresos)
/* movida a su nuevo módulo: deleteActivityItem */

// ============ CERRAR TURNO ============

/* movida a su nuevo módulo: closeShift */

// ============ AUTO-CIERRE DE TURNO POR DESFASE HORARIO ============
// Los turnos son fijos por reloj: día 06:00–18:00, noche 18:00–06:00. Si un
// empleado olvida presionar "Cerrar turno", el sistema sigue registrando
// ventas/habitaciones bajo el turno viejo aunque ya haya cambiado la hora
// real, y el turno entrante arranca "desfasado" (mezclado con el anterior)
// hasta que alguien lo note y cierre manualmente — a veces horas después.
//
// Para evitarlo: 15 minutos después de cada límite de turno (06:15 y
// 18:15), si el turno guardado (currentShiftType) todavía no coincide con
// el que corresponde por la hora, se cierra solo — mismo flujo que el botón
// manual (genera reporte, snapshot y reinicia contadores), sin diálogo de
// confirmación.
export const SHIFT_AUTO_SWITCH_GRACE_MINUTES = 15;

/* movida a su nuevo módulo: getExpectedShiftType */

// true fuera de las ventanas [06:00,06:15) y [18:00,18:15) — el margen le
// da tiempo al empleado a cerrar manualmente antes de que el sistema le
// gane de mano.
/* movida a su nuevo módulo: isPastShiftGracePeriod */

export let _autoShiftCheckInProgress = false;

/* movida a su nuevo módulo: autoCloseShiftIfOverdue */

// ============ HISTORIAL DE TURNOS ============

/* movida a su nuevo módulo: updateShiftHistory */

// ============ SISTEMA DE LIMPIEZA PROFUNDA ============

export let deepCleanSchedules = [];

/* movida a su nuevo módulo: loadDeepCleanSchedules */

/* movida a su nuevo módulo: saveDeepCleanSchedules */

/* movida a su nuevo módulo: openDeepCleanScheduleModal */

/* movida a su nuevo módulo: closeDeepCleanScheduleModal */

/* movida a su nuevo módulo: renderRoomSelectionGrid */

/* movida a su nuevo módulo: toggleRoomSelection */

/** True si la habitación tiene limpieza profunda pendiente (programada y no marcada hecha). */
/* movida a su nuevo módulo: roomHasPendingDeepClean */

/* movida a su nuevo módulo: deepCleanRoomLabel */

/* movida a su nuevo módulo: deepCleanStatusBadgesHtml */

/* movida a su nuevo módulo: saveDeepCleanSchedule */

/* movida a su nuevo módulo: renderScheduledCleansList */

/* movida a su nuevo módulo: deleteDeepCleanSchedule */

/* movida a su nuevo módulo: renderUpcomingDeepCleans */

/* movida a su nuevo módulo: completeDeepCleanRoom */

/* movida a su nuevo módulo: openDeepCleanConfirmModal */

/* movida a su nuevo módulo: closeDeepCleanConfirmModal */

/* movida a su nuevo módulo: confirmDeepCleanCompletion */

/* movida a su nuevo módulo: initDeepCleaningSystem */

// ============ RESET PRODUCT MODAL ============

/* movida a su nuevo módulo: resetProductModal */

// ============ MODAL DESGLOSE DETALLADO ============

export let currentRevenueType = 'rooms';
export let currentRevenueFilter = 'all';

/* movida a su nuevo módulo: openRevenueDetail */

/* movida a su nuevo módulo: closeRevenueDetailModal */

/* movida a su nuevo módulo: filterRevenueDetail */

/* movida a su nuevo módulo: renderRevenueDetail */

// ============ MODAL ACTIVIDAD DE HABITACIONES ============

export let currentRoomsActivityFilter = 'current';

/* movida a su nuevo módulo: openRoomsActivityModal */

/* movida a su nuevo módulo: closeRoomsActivityModal */

/* movida a su nuevo módulo: filterRoomsActivity */

/* movida a su nuevo módulo: renderRoomsActivity */

// ============ MODAL RESUMEN DE GASTOS ============

export let currentExpensesPeriod = 'day';
export let currentExpensesShift = 'all';

/* movida a su nuevo módulo: openExpensesSummaryModal */

/* movida a su nuevo módulo: closeExpensesSummaryModal */

/* movida a su nuevo módulo: filterExpensesSummary */

/* movida a su nuevo módulo: filterExpensesShift */

/* movida a su nuevo módulo: renderExpensesSummaryModal */

// ============ GENERACIÓN DE REPORTE DE TURNO ============

/* movida a su nuevo módulo: generateShiftReport */

/* movida a su nuevo módulo: showMobileReportModal */

// ============ MODAL HISTORIAL DE TURNOS ============

/* movida a su nuevo módulo: openShiftHistoryModal */

/* movida a su nuevo módulo: closeShiftHistoryModal */

/* movida a su nuevo módulo: renderShiftHistoryList */

/* movida a su nuevo módulo: downloadShiftReport */

// Botón de descarga por turno en la tabla de Reporte Mensual (generateDailyIncomeTable),
// junto a "Turno Día"/"Turno Noche". A diferencia de downloadShiftReport()
// (que lee de shiftReports, solo turnos ya cerrados con snapshot guardado),
// esta fila se arma directo de los registros de roomRevenue/sales/expenses
// del mes — funciona para cualquier turno del historial, tenga o no un
// reporte de cierre guardado.
/* movida a su nuevo módulo: downloadShiftDayReport */

// ============ MODAL MÉTODO DE PAGO ============

/* movida a su nuevo módulo: openPaymentMethodModal */

/* movida a su nuevo módulo: closePaymentMethodModal */

// ============ FILTRO DE INVENTARIO ============

/* movida a su nuevo módulo: filterInventoryByCategory */

// ============ ESTADÍSTICAS — NUEVA VERSIÓN CON ESTILOS SC ============

/* movida a su nuevo módulo: scSetPeriod */

/* movida a su nuevo módulo: getPeriodStart */

/* movida a su nuevo módulo: periodLabel */

/* movida a su nuevo módulo: updateRoomStats */

/* movida a su nuevo módulo: updateRoomRevenueDisplay */

/* movida a su nuevo módulo: updateRevenueStats */

/* movida a su nuevo módulo: updateExpensesByPaymentMethod */

/* movida a su nuevo módulo: updateExpensesByCategory */

/* movida a su nuevo módulo: updateProductStats */

/* movida a su nuevo módulo: updateRoomUsageStats */

/* movida a su nuevo módulo: updateStatistics */

/* movida a su nuevo módulo: updateSalesStats */

// ============ CONNECTION STATUS ============
/* movida a su nuevo módulo: updateConnectionStatus */

// Manejar click en el indicador de conexión
/* movida a su nuevo módulo: handleConnectionClick */

// ============ REPORTE MENSUAL ============

export let _mrData = {};
export let _mrMonth = null;
export let _mrYear = null;
export let _currentWeek = 0; // Semana seleccionada (0 = todo el mes)
export let _payrollEmployees = []; // Lista de empleados del mes
export let _editingEmployeeId = null; // ID del empleado en edición
export let _mrUnlistenFn = null; // Función para cancelar listener del MR actual

/* movida a su nuevo módulo: setupMrDataListener */

// Reconciliar expenses[] con _mrData para el mes actual
// Asegura que todos los gastos registrados aparezcan en el reporte mensual
/* movida a su nuevo módulo: reconcileExpensesWithMrData */

/* movida a su nuevo módulo: initMonthlyReport */

/* movida a su nuevo módulo: setupPayrollEventListeners */

/* movida a su nuevo módulo: getMonthlyReportKey */

/* movida a su nuevo módulo: initMrCollapsible */

/* movida a su nuevo módulo: saveMonthlyReportData */

/* movida a su nuevo módulo: loadMonthlyReportData */

// ============ FUNCIONES DE NÓMINA ============



/* movida a su nuevo módulo: onWeekChange */


/* movida a su nuevo módulo: openPayrollModal */

/* movida a su nuevo módulo: togglePayrollWeek */

/* movida a su nuevo módulo: _setPayrollWeeks */

/* movida a su nuevo módulo: closePayrollModal */

/* movida a su nuevo módulo: resetPayrollForm */

/* movida a su nuevo módulo: calculatePayrollTotal */

/* movida a su nuevo módulo: savePayrollEmployee */

/* movida a su nuevo módulo: deletePayrollEmployee */

/* movida a su nuevo módulo: renderWeeklyEmployees */

/* movida a su nuevo módulo: updateWeeklySummary */

/* movida a su nuevo módulo: loadPayrollEmployees */

/* movida a su nuevo módulo: migrateOldPayrollFormat */

/* movida a su nuevo módulo: getMonthRange */


/* movida a su nuevo módulo: getMonthRangeFor */

/* movida a su nuevo módulo: markMrAnterioresEdited */

/** Vacía el saldo guardado cuando el usuario borra el campo (permite dejar en blanco). */
/* movida a su nuevo módulo: mrSaldoAnteriorInput */

/** Sincroniza ingresos con tarjeta/banco del mes hacia movimientos automáticos (sobre targetMr). */
/* movida a su nuevo módulo: syncTarjetaVentasToBancoInto */

/** Totales de cierre efectivo/banco de un mes (para rellenar "mes anterior"). */
/* movida a su nuevo módulo: computeCierreForMonth */

/* movida a su nuevo módulo: applyAnterioresFromPreviousMonth */

// Función para formatear fechas de manera consistente
/* movida a su nuevo módulo: fmtDate */

/* movida a su nuevo módulo: addSaleToMovements */

/* movida a su nuevo módulo: addTarjetaSaleToBanco */

/* movida a su nuevo módulo: syncTarjetaVentasToBanco */

/* movida a su nuevo módulo: cleanMovimientosFromOtherMonths */

/* movida a su nuevo módulo: generateMonthlyReport */

/* movida a su nuevo módulo: recalcMonthlyReport */

// ─── TABLA DE INGRESOS DIARIOS ────────────────────────────────────────────────
/* movida a su nuevo módulo: generateDailyIncomeTable */

// ─── EXCEL: hoja de ingresos diarios en formato Lili ─────────────────────────
/* movida a su nuevo módulo: buildDailyIncomeSheet */

/* movida a su nuevo módulo: renderMrExpenseList */

/* movida a su nuevo módulo: renderMrSalaryList */

/* movida a su nuevo módulo: getMrMovimientosFiltered */

/* movida a su nuevo módulo: filterMrMovimientos */

/* movida a su nuevo módulo: renderMrMovimientosList */

/* movida a su nuevo módulo: toggleSalaryFields */

/* movida a su nuevo módulo: addMrDirectExpense */

/* movida a su nuevo módulo: addMrIndirectExpense */

/* movida a su nuevo módulo: addMrNonOpExpense */

/* movida a su nuevo módulo: addMrSalary */

/* movida a su nuevo módulo: addMrEfectivoMovimiento */

/* movida a su nuevo módulo: addMrBancoMovimiento */

/* movida a su nuevo módulo: deleteMrExpense */

/* movida a su nuevo módulo: deleteMrSalary */

/* movida a su nuevo módulo: deleteMrMovimiento */

/* movida a su nuevo módulo: onMonthYearChange */

// ============ MODAL CLOSE LISTENERS ============

document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('show');
    }
});

// ============ INVENTARIO — EDITAR / ELIMINAR ============

/* movida a su nuevo módulo: editInventoryItem */

/* movida a su nuevo módulo: deleteInventoryItem */



// ELIMINADO POR SEGURIDAD: Funciones de reseteo no expuestas globalmente
// Solo el director puede acceder a estas funciones desde el código
// window.resetSystemData = resetSystemData;
// window.confirmResetSystem = confirmResetSystem;

// Para resetear el sistema: escribir resetSystemData() en la consola del navegador

// ============ FIN RESETEO TOTAL DEL SISTEMA ============


// ============================================================================
// GESTIÓN DE USUARIOS (Solo Director)
// ============================================================================

// FIXED: Funciones del modal de sincronización (Problem 5)
/**
 * Abrir modal de sincronización
 */
/* movida a su nuevo módulo: openSyncModal */

/**
 * Cerrar modal de sincronización
 */
/* movida a su nuevo módulo: closeSyncModal */

/**
 * Inicializar gestión de usuarios
 */
/* movida a su nuevo módulo: initUserManagement */

// ============================================================================
// SISTEMA DE ASISTENCIA DE PERSONAL
// ============================================================================

// Renderizar lista de personal
/* movida a su nuevo módulo: renderAttendanceList */

// Función para renderizar el historial de faltas
/* movida a su nuevo módulo: renderAttendanceHistory */

// Agregar nuevo miembro del personal
/* movida a su nuevo módulo: addStaffMember */

// Guardar personal desde el modal
/* movida a su nuevo módulo: saveStaffFromModal */

// Resetear modal de personal
// FIXED: Added function to reset staff modal after use
/* movida a su nuevo módulo: resetStaffModal */

// Marcar asistencia
/* movida a su nuevo módulo: markAttendance */

// FIXED: Nueva función para guardar datos de personal inmediatamente sin throttle
/* movida a su nuevo módulo: saveStaffDataImmediately */

// Función auxiliar para obtener el día de la semana en inglés
/* movida a su nuevo módulo: getCurrentDayOfWeek */

// Función auxiliar para determinar si un empleado debe trabajar hoy
/* movida a su nuevo módulo: shouldWorkToday */

// Función auxiliar para determinar si un empleado corresponde al turno actual
/* movida a su nuevo módulo: isCurrentShiftStaff */

// Editar miembro del personal
// FIXED: Added edit functionality for staff cards
/* movida a su nuevo módulo: editStaffMember */

// Eliminar miembro del personal
// FIXED: Implementado soft delete en lugar de eliminación física
/* movida a su nuevo módulo: deleteStaffMember */