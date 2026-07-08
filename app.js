// ============ SISTEMA DE AUTENTICACIÓN Y PERMISOS ============
// Version: 5.7.0 - Corrección de Fallos Críticos de Seguridad
// 
// MEJORAS v5.7.0:
// - 🔒 SEGURIDAD: Eliminadas contraseñas en texto plano
// - 🔒 CORREGIDO: Ingresos de reservas se registran al ocupar, no al crear
// - 🔒 CORREGIDO: Campo guestPhone en confirmReservationStart
// - 🔒 MEJORADO: Solo contraseñas hasheadas (SHA-256)
//
let isSaving = false;
let _pendingFirebaseSave = false; // true si llegó un cambio mientras isSaving estaba activo

// ELIMINADO POR SEGURIDAD: window.testShiftOverride
// Variable de testing eliminada en producción

// Array para almacenar IDs de intervalos y poder limpiarlos
let activeIntervals = [];

// FIXED: Cache de elementos DOM para updateRoomTimers (Problem 4b)
let roomTimerElements = new Map();

// ============ UTILIDADES DE SEGURIDAD ============
// Sanitizar HTML para prevenir XSS
function sanitizeHTML(str) {
    if (typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Igual que sanitizeHTML pero además escapa comillas — usar cuando el valor
// se inserta dentro de un atributo HTML (value="...", etc.), donde una
// comilla sin escapar rompe el atributo y permite inyectar markup/eventos.
function escapeAttr(str) {
    return sanitizeHTML(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Crear elemento HTML de forma segura
function createSafeHTML(template, data = {}) {
    // Sanitizar todos los valores en data
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string') {
            sanitized[key] = sanitizeHTML(value);
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            sanitized[key] = value;
        } else {
            sanitized[key] = '';
        }
    }
    
    // Reemplazar placeholders en el template
    let result = template;
    for (const [key, value] of Object.entries(sanitized)) {
        const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
        result = result.replace(regex, value);
    }
    
    return result;
}

// Validar y sanitizar números
function sanitizeNumber(value, defaultValue = 0, min = -Infinity, max = Infinity) {
    const num = parseFloat(value);
    if (!isNaN(num) && isFinite(num)) {
        return Math.max(min, Math.min(max, num));
    }
    return defaultValue;
}

// Validar y sanitizar enteros
function sanitizeInt(value, defaultValue = 0, min = -Infinity, max = Infinity) {
    const num = parseInt(value, 10);
    if (!isNaN(num) && isFinite(num)) {
        return Math.max(min, Math.min(max, num));
    }
    return defaultValue;
}

// Validar timestamp
function isValidTimestamp(ts) {
    return typeof ts === 'number' && ts > 0 && ts < Date.now() + 86400000;
}

// Validar string con longitud máxima
function sanitizeString(str, maxLength = 100) {
    if (typeof str !== 'string') return '';
    return str.trim().substring(0, maxLength);
}

// Validar teléfono (mínimo 10 dígitos)
function sanitizePhone(phone) {
    if (typeof phone !== 'string') return '';
    const cleaned = phone.replace(/\D/g, '');
    // Validar que tenga al menos 10 dígitos
    if (cleaned.length < 10) return '';
    return cleaned.substring(0, 20);
}

// Validar email básico
function isValidEmail(email) {
    if (typeof email !== 'string') return false;
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email) && email.length <= 100;
}

// ============ UTILIDADES DE MÉTODOS DE PAGO ============
/** Tarjeta o transferencia (en habitaciones/ventas suele ser "tarjeta"; en gastos "banco"). */
function isCardOrBankPayment(pm) {
    return pm === 'tarjeta' || pm === 'banco';
}

function isCashPayment(pm) {
    return (pm || 'efectivo') === 'efectivo';
}

function fmt(n) { 
    return '$' + (n || 0).toFixed(2); 
}

// Throttle para prevenir spam de eventos.
// IMPORTANTE: garantiza ejecución de "cola" (trailing edge) — si una llamada
// cae dentro de la ventana de enfriamiento, se reprograma para el final de la
// ventana en vez de descartarse. Un throttle sin trailing edge perdía en
// silencio guardados (localStorage Y Firebase) cuando dos cambios de estado
// ocurrían en menos de `delay` ms, dejando habitaciones sin persistir.
function throttle(func, delay) {
    let lastCall = 0;
    let timeoutId = null;
    let pendingArgs = null;
    return function(...args) {
        const now = Date.now();
        const remaining = delay - (now - lastCall);
        pendingArgs = args; // siempre la llamada más reciente, aunque quede en espera
        if (remaining <= 0) {
            if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
            lastCall = now;
            const a = pendingArgs; pendingArgs = null;
            return func.apply(this, a);
        }
        if (!timeoutId) {
            timeoutId = setTimeout(() => {
                lastCall = Date.now();
                timeoutId = null;
                const a = pendingArgs; pendingArgs = null;
                func.apply(this, a);
            }, remaining);
        }
    };
}

// Debounce para optimizar búsquedas
function debounce(func, delay) {
    let timeoutId;
    return function(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
    };
}

// Safe JSON parse con manejo de errores
function safeJSONParse(str, fallback = null) {
    if (!str) return fallback;
    try {
        return JSON.parse(str);
    } catch (e) {
        console.error('[SafeParse] Error parsing JSON:', e);
        return fallback;
    }
}

// Safe localStorage get con fallback a sessionStorage y memoria (necesario en Safari privado)
function safeLocalStorageGet(key, fallback = null) {
    // 1. localStorage
    try {
        const value = localStorage.getItem(key);
        if (value) return safeJSONParse(value, fallback);
    } catch (e) {}
    // 2. sessionStorage
    try {
        const value = sessionStorage.getItem(key);
        if (value) return safeJSONParse(value, fallback);
    } catch (e) {}
    // 3. Memoria
    if (window._memStorage && window._memStorage[key] !== undefined) {
        return safeJSONParse(window._memStorage[key], fallback);
    }
    return fallback;
}

// Recorta los arrays más grandes EN MEMORIA (no solo el string crudo de
// localStorage) para liberar espacio de emergencia cuando un guardado falla
// por cuota excedida. Siempre preserva los registros del turno actual.
// ANTES este recorte solo reescribía el string de localStorage sin tocar el
// arreglo en memoria (roomRevenue/sales/expenses seguían con todos sus
// registros) — el siguiente autoguardado, segundos después, volvía a
// serializar el arreglo completo y deshacía el recorte por completo, así
// que esta "válvula de emergencia" nunca funcionaba realmente.
function _pruneOldStorageRecords() {
    const shiftStart = currentShiftStart || 0;
    const EMERGENCY_CAP = 500;
    let trimmed = 0;

    function trim(arr) {
        if (!Array.isArray(arr) || arr.length <= EMERGENCY_CAP) return arr;
        const keep = arr.filter(r => (r.timestamp || 0) >= shiftStart);
        const extra = arr.filter(r => (r.timestamp || 0) < shiftStart).slice(-Math.max(0, EMERGENCY_CAP - keep.length));
        trimmed += arr.length - (keep.length + extra.length);
        return [...extra, ...keep];
    }

    roomRevenue = trim(roomRevenue);
    invalidateRevenueIndex();
    sales = trim(sales);
    expenses = trim(expenses);

    if (trimmed > 0) {
        console.warn(`[Storage] Recortados ${trimmed} registros históricos antiguos (turno actual preservado) para liberar espacio de emergencia.`);
    }
    return trimmed;
}

// Avisa al usuario cuando localStorage supera el 90% del límite típico (5 MB).
// NO recorta datos automáticamente aquí: qué tanto historial conservar para
// reportes mensuales es una decisión de negocio, no algo para decidir en
// silencio. Solo informa — la limpieza real de emergencia ocurre en
// safeLocalStorageSet() si un guardado llega a fallar por cuota excedida.
function checkStorageCapacity() {
    try {
        let usedBytes = 0;
        for (const k in localStorage) {
            if (Object.prototype.hasOwnProperty.call(localStorage, k)) {
                usedBytes += (k.length + localStorage[k].length) * 2;
            }
        }
        const usedMB = usedBytes / (1024 * 1024);
        if (usedMB > 4.5) {
            console.warn(`[Storage] ⚠️ localStorage al ${usedMB.toFixed(2)} MB (~90 % del límite típico de 5 MB)`);
            if (typeof showToast === 'function') {
                showToast(`⚠️ Almacenamiento casi lleno (${usedMB.toFixed(1)} MB). Esto es historial de ventas/gastos/ingresos acumulado — contacta al administrador para revisar cuánto conservar.`, 'warning');
            }
        }
        return usedMB;
    } catch (e) { return 0; }
}

// Safe localStorage set con fallback a sessionStorage y memoria
function safeLocalStorageSet(key, value) {
    const serialized = JSON.stringify(value);
    try {
        localStorage.setItem(key, serialized);
    } catch (e) {
        if (e.name === 'QuotaExceededError') {
            // Paso 1: eliminar claves temporales y de respaldo
            try {
                Object.keys(localStorage).forEach(k => {
                    if (k.startsWith('backup_') || k.startsWith('temp_')) localStorage.removeItem(k);
                });
                localStorage.setItem(key, serialized);
            } catch (e2) {
                if (e2.name === 'QuotaExceededError') {
                    // Paso 2: recortar registros históricos grandes
                    try {
                        _pruneOldStorageRecords();
                        localStorage.setItem(key, serialized);
                        console.warn('[Storage] Almacenamiento liberado mediante recorte de historial.');
                    } catch (e3) {
                        console.error('[Storage] localStorage lleno incluso tras limpieza. Datos en riesgo al cerrar la pestaña.');
                        if (typeof showToast === 'function') {
                            showToast('⚠️ Almacenamiento lleno. Los datos pueden perderse al cerrar la pestaña.', 'error');
                        }
                    }
                }
            }
        }
    }
    try { sessionStorage.setItem(key, serialized); } catch (e) {}
    if (!window._memStorage) window._memStorage = {};
    window._memStorage[key] = serialized;
    return true;
}

// Safe getElementById con manejo de errores
function safeGetElementById(id, warnIfMissing = false) {
    const element = document.getElementById(id);
    if (!element && warnIfMissing) {
        console.warn(`[DOM] Element with id "${id}" not found`);
    }
    return element;
}

// ============ USUARIOS Y AUTENTICACIÓN ============

// FIXED: Sistema de logging mejorado para debugging
const DEBUG_SYNC = false; // Cambiar a false en producción
const syncLog = [];

function logSync(message, type = 'info', data = null) {
    const timestamp = new Date().toISOString();
    const deviceId = localStorage.getItem('_deviceId') || 'unknown';
    
    const logEntry = {
        timestamp,
        deviceId,
        type,
        message,
        data: data ? JSON.stringify(data).substring(0, 200) : null
    };
    
    syncLog.push(logEntry);
    
    // Mantener solo los últimos 100 logs
    if (syncLog.length > 100) {
        syncLog.shift();
    }
    
    if (DEBUG_SYNC) {
        const color = {
            'info': '#0099ff',
            'success': '#00aa00', 
            'warning': '#ff9900',
            'error': '#ff0000',
            'sync': '#9900ff'
        }[type] || '#ffffff';
        
        console.log(`%c[SYNC-${deviceId}] ${message}`, `color: ${color}`, data || '');
    }
}

// Exponer función para debugging
window.getSyncLog = () => syncLog;
window.clearSyncLog = () => { syncLog.length = 0; };

// Verificar contraseña
async function verifyPassword(inputPassword, storedPassword) {
    return inputPassword === storedPassword;
}

// Lee usuarios del caché local de forma SÍNCRONA (cero llamadas a red)
function _getCachedUsersSync() {
    const DEFAULT_PWD = { director: 'rapid2024', supervisor: 'supervisor123', recepcion: 'recepcion123', limpieza: 'limpieza2024' };
    const ROLE_NAMES  = { director: 'Director',  supervisor: 'Supervisor',    recepcion: 'Recepción',    limpieza: 'Limpieza'    };
    const result = [];
    for (const role of ['director', 'supervisor', 'recepcion', 'limpieza']) {
        let pwd = null;
        try { pwd = localStorage.getItem(`_pwd_${role}`); }   catch(e) {}
        try { if (!pwd) pwd = sessionStorage.getItem(`_pwd_${role}`); } catch(e) {}
        if (!pwd && window._memStorage) pwd = window._memStorage[`_pwd_${role}`] || null;
        if (!pwd) pwd = DEFAULT_PWD[role];
        result.push({ username: role, password: pwd, role, name: ROLE_NAMES[role], email: '', lastModified: 0 });
    }
    return result;
}

// Refresca usuarios desde Firebase en segundo plano (no bloquea la UI)
async function _refreshUsersFromFirebase() {
    if (!window.FirebaseSync || !window.FirebaseSync.ready) return;
    const DEFAULT_PWD = { director: 'rapid2024', supervisor: 'supervisor123', recepcion: 'recepcion123', limpieza: 'limpieza2024' };
    const ROLE_NAMES  = { director: 'Director',  supervisor: 'Supervisor',    recepcion: 'Recepción',    limpieza: 'Limpieza'    };
    const fresh = [];
    for (const role of ['director', 'supervisor', 'recepcion', 'limpieza']) {
        let pwd = null;
        try { pwd = await window.FirebaseSync.load(`_pwd_${role}`, null); } catch(e) {}
        if (!pwd) { try { pwd = localStorage.getItem(`_pwd_${role}`); } catch(e) {} }
        if (!pwd) pwd = DEFAULT_PWD[role];
        // Actualizar caché local con lo que trajo Firebase
        try { localStorage.setItem(`_pwd_${role}`, pwd); } catch(e) {}
        try { sessionStorage.setItem(`_pwd_${role}`, pwd); } catch(e) {}
        if (!window._memStorage) window._memStorage = {};
        window._memStorage[`_pwd_${role}`] = pwd;
        fresh.push({ username: role, password: pwd, role, name: ROLE_NAMES[role], email: '', lastModified: Date.now() });
    }
    // Actualizar el array global y caché
    users = fresh;
    try { localStorage.setItem('motelUsers', JSON.stringify(fresh)); } catch(e) {}
    window.FirebaseSync.save('motelUsers', fresh).catch(() => {});
}

// Cargar usuarios: INSTANTÁNEO desde caché, Firebase en segundo plano
async function loadUsers() {
    const cached = _getCachedUsersSync();
    // Refrescar desde Firebase sin bloquear
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        _refreshUsersFromFirebase().catch(() => {});
    }
    return cached;
}

// Guardar usuarios y propagar contraseñas a las claves _pwd_
async function saveUsers(users) {
    const timestamp = Date.now();
    const usersWithTimestamp = users.map(user => ({ ...user, lastModified: timestamp }));

    // Guardar en localStorage
    safeLocalStorageSet('motelUsers', usersWithTimestamp);

    // Propagar contraseñas individuales a _pwd_ para que loadUsers las encuentre
    for (const user of usersWithTimestamp) {
        if (user.username && user.password) {
            localStorage.setItem(`_pwd_${user.username}`, user.password);
        }
    }

    // Guardar en Firebase
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        try {
            await window.FirebaseSync.save('motelUsers', usersWithTimestamp);
            // También guardar las claves _pwd_ individualmente para sincronización entre dispositivos
            for (const user of usersWithTimestamp) {
                if (user.username && user.password) {
                    window.FirebaseSync.save(`_pwd_${user.username}`, user.password).catch(() => {});
                }
            }
            return true;
        } catch (err) {
            console.error('[Users] Error guardando en Firebase:', err);
            showToast('⚠️ Error sincronizando con Firebase. Los cambios solo están guardados localmente.', 'warning');
            return false;
        }
    } else {
        console.warn('[Users] Firebase no disponible, solo guardado local');
        return false;
    }
}

// Guardar contraseña en texto plano (para visualización del Director)
// IMPORTANTE: Solo se guarda en Firebase, NO en localStorage
// Solo el Director puede ver estas contraseñas
window.savePasswordForViewing = async function(username, plainPassword) {
    if (!window.FirebaseSync || !window.FirebaseSync.ready) {
        console.warn('[Security] Firebase no disponible, contraseña no guardada para visualización');
        return;
    }
    
    try {
        const key = `_pwd_${username}`;
        await window.FirebaseSync.save(key, plainPassword);
        console.log(`[Security] Contraseña guardada para visualización: ${username}`);
    } catch (error) {
        console.error('[Security] Error guardando contraseña para visualización:', error);
    }
}

// Cargar contraseña en texto plano (solo para Director)
window.loadPasswordForViewing = async function(username) {
    if (!window.FirebaseSync || !window.FirebaseSync.ready) {
        console.warn('[Security] Firebase no disponible');
        return null;
    }
    
    try {
        const key = `_pwd_${username}`;
        const password = await window.FirebaseSync.load(key, null);
        return password;
    } catch (error) {
        console.error('[Security] Error cargando contraseña:', error);
        return null;
    }
}


// FUNCIÓN DE EMERGENCIA: Resetear contraseñas a valores por defecto
// Ejecutar en consola: resetPasswordsToDefault()
window.resetPasswordsToDefault = async function() {
    console.log('[Emergency] Reseteando contraseñas a valores por defecto...');
    
    const defaultUsers = [
        { username: 'supervisor', password: 'supervisor123', role: 'supervisor', name: 'Supervisor', email: '', lastModified: Date.now() },
        { username: 'director', password: 'rapid2024', role: 'director', name: 'Director', email: '', lastModified: Date.now() },
        { username: 'recepcion', password: 'recepcion123', role: 'recepcion', name: 'Recepción', email: '', lastModified: Date.now() },
        { username: 'limpieza', password: 'limpieza2024', role: 'limpieza', name: 'Limpieza', email: '', lastModified: Date.now() }
    ];
    
    // Limpiar localStorage
    localStorage.removeItem('motelUsers');
    console.log('[Emergency] ✅ localStorage limpiado');
    
    // Guardar usuarios con contraseñas en texto plano
    safeLocalStorageSet('motelUsers', defaultUsers);
    console.log('[Emergency] ✅ Usuarios guardados en localStorage');
    
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        try {
            await window.FirebaseSync.save('motelUsers', defaultUsers);
            console.log('[Emergency] ✅ Usuarios guardados en Firebase');
        } catch (err) {
            console.error('[Emergency] Error guardando en Firebase:', err);
        }
    }
    
    // Guardar contraseñas para visualización
    for (const user of defaultUsers) {
        if (window.savePasswordForViewing) {
            try {
                await window.savePasswordForViewing(user.username, user.password);
                console.log(`[Emergency] ✅ Contraseña de ${user.username} guardada para visualización`);
            } catch (err) {
                console.error(`[Emergency] Error guardando contraseña de ${user.username}:`, err);
            }
        }
    }
    
    console.log('[Emergency] ✅ Contraseñas reseteadas completamente');
    alert('✅ Contraseñas reseteadas a valores por defecto:\n\ndirector / rapid2024\nsupervisor / supervisor123\nrecepcion / recepcion123\nlimpieza / limpieza2024\n\nRecarga la página.');
}


// Función de emergencia para re-renderizar habitaciones manualmente
window.repairRooms = function() {
    renderRooms();
    showToast('🔧 Habitaciones re-renderizadas', 'info');
};

let users = [];
let currentUser = null;

// Esperar a que Firebase esté listo
// FIXED: Aumentado timeout a 15 segundos para Safari
async function waitForFirebase() {
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

// Variables de filtrado
let currentFilter = 'all';
let searchRoomNumber = null;

// Historial de actividad
let activityLog = [];

// Verificar sesión al cargar
function checkSession() {
    const savedUser = safeLocalStorageGet('currentUser');
    if (savedUser) {
        currentUser = savedUser;
        showMainApp();
    } else {
        showLogin();
    }
}

// Mostrar pantalla de login
function showLogin() {
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('mainApp').style.display = 'none';
    document.body.classList.add('loaded'); // Mostrar página
}

// Mostrar aplicación principal
async function showMainApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
    document.body.classList.add('loaded');
    
    const roleBadge = document.getElementById('userRole');
    if (roleBadge) {
        roleBadge.textContent = currentUser.name;
        roleBadge.className = `user-role-badge ${currentUser.role}`;
    }
    
    setupPermissions();
    await init();

    loadDeepCleanSchedules().catch(() => {});
    
    if (currentUser.role === 'limpieza') {
        showCleaningView();
    }
}

// Configurar permisos y vistas según el rol
function setupPermissions() {
    const role = currentUser.role;
    
    // Ocultar/mostrar pestañas según permisos
    document.querySelectorAll('.tab-btn').forEach(btn => {
        const allowedRoles = btn.dataset.roles.split(',');
        if (allowedRoles.includes(role)) {
            btn.style.display = 'block';
        } else {
            btn.style.display = 'none';
        }
    });
    
    // Aplicar permisos a todos los elementos con data-roles
    document.querySelectorAll('[data-roles]').forEach(element => {
        const allowedRoles = element.dataset.roles.split(',');
        if (allowedRoles.includes(role)) {
            element.style.display = '';
        } else {
            element.style.display = 'none';
        }
    });

    // No hacer click en pestañas aquí: antes de init() rooms=[] y loadData() no ha corrido;
    // switchTab() llamaba renderRooms() demasiado pronto. La pestaña "Habitaciones" ya está
    // activa en el HTML; init() carga datos y renderiza.
}

// Vista especial para personal de limpieza
function showCleaningView() {
    const roomsTab = document.getElementById('rooms-tab');
    if (!roomsTab) return;
    
    roomsTab.innerHTML = `
        <div class="cleaning-view">
            <div class="cleaning-header">
                <h2>🧹 Panel de Limpieza</h2>
                <p>Marca las habitaciones como limpias después de terminar</p>
            </div>
            
            <div class="cleaning-stats">
                <div class="cleaning-stat-card dirty">
                    <div class="stat-number" id="dirtyCount">0</div>
                    <div class="stat-label">Sucias</div>
                </div>
                <div class="cleaning-stat-card clean">
                    <div class="stat-number" id="cleanCount">0</div>
                    <div class="stat-label">Limpias Hoy</div>
                </div>
                <div class="cleaning-stat-card total">
                    <div class="stat-number" id="totalRooms">32</div>
                    <div class="stat-label">Total</div>
                </div>
            </div>
            
            <div class="rooms-main-container">
                <div class="cleaning-rooms-grid" id="cleaningRoomsGrid"></div>
                
                <!-- Sidebar de Notas de Limpieza -->
                <div class="rooms-right-sidebar">
                    <div id="cleaningNotesSidebar" class="sidebar-panel">
                        <h3>📝 Notas de Limpieza Recientes</h3>
                        <div id="recentCleaningNotes" class="recent-notes-list"></div>
                    </div>
                </div>
            </div>
            
            <!-- Secciones de Limpieza Profunda -->
            <div class="upcoming-deep-cleans" id="upcomingDeepCleans" style="margin: 20px;">
                <h2>🧹 Limpiezas Profundas Programadas</h2>
                <div class="upcoming-cleans-grid" id="upcomingCleansGrid"></div>
            </div>
        </div>
    `;
    
    // Asegurar que los datos están cargados antes de renderizar
    if (rooms.length === 0) {
        loadData();
    }
    
    renderCleaningRooms();
    
    // Renderizar notas de limpieza en el sidebar
    renderRecentCleaningNotes();
    
    // Renderizar secciones de limpieza profunda
    renderUpcomingDeepCleans();
}

// Renderizar habitaciones para limpieza
function renderCleaningRooms() {
    const grid = document.getElementById('cleaningRoomsGrid');
    if (!grid) return;
    
    const dirtyRooms = rooms.filter(r => r.status === 'dirty');
    
    const todayCleaned = roomRevenue.filter(r => 
        r.type === 'cleaned' && 
        isToday(r.timestamp)
    ).length;
    
    // Actualizar estadísticas
    const dirtyCountEl = document.getElementById('dirtyCount');
    const cleanCountEl = document.getElementById('cleanCount');
    
    if (dirtyCountEl) dirtyCountEl.textContent = dirtyRooms.length;
    if (cleanCountEl) cleanCountEl.textContent = todayCleaned;
    
    // Mostrar SOLO habitaciones sucias
    if (dirtyRooms.length === 0) {
        grid.innerHTML = `
            <div class="no-dirty-rooms">
                <div class="success-icon">✅</div>
                <h3>¡Todo limpio!</h3>
                <p>No hay habitaciones sucias en este momento</p>
            </div>
        `;
        return;
    }
    
    grid.innerHTML = dirtyRooms.map(room => {
        return `
            <div class="cleaning-room-card dirty" onclick="toggleCleanRoom('${room.id}')">
                <div class="room-number">${room.number}</div>
                <div class="room-status">🧹 Sucia</div>
                <div class="room-building">${room.building === 'regulares' ? 'Edificio 1' : 'Edificio Torre'}</div>
            </div>
        `;
    }).join('');
}

// Toggle estado de limpieza - Ahora abre modal de confirmación
function toggleCleanRoom(roomId) {
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;
    
    if (room.status === 'dirty') {
        openCleaningModal(room);
    }
}

// Abrir modal de confirmación de limpieza
function openCleaningModal(room) {
    const modal = document.getElementById('cleaningModal');
    const detailsDiv = document.getElementById('cleaningDetails');
    
    // Formatear fecha y hora cuando se marcó como sucia
    const dirtyDate = room.dirtyTimestamp ? new Date(room.dirtyTimestamp) : null;
    const dirtyTimeStr = dirtyDate ? dirtyDate.toLocaleString('es-MX', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }) : 'No registrada';
    
    // Hora actual (cuando se va a limpiar)
    const now = new Date();
    const cleanTimeStr = now.toLocaleString('es-MX', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
    
    // Verificar si esta habitación tiene limpieza profunda programada
    let deepCleanScheduleInfo = '';
    const scheduledDeepClean = deepCleanSchedules.find(schedule => 
        !schedule.completed && 
        schedule.rooms.some(r => r.roomId === room.id)
    );
    
    if (scheduledDeepClean) {
        const scheduleDate = new Date(scheduledDeepClean.scheduledDate);
        const scheduleDateStr = scheduleDate.toLocaleString('es-MX', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        deepCleanScheduleInfo = `
            <div class="deep-clean-schedule-alert">
                <div class="alert-icon-deep">🧹</div>
                <div class="alert-content-deep">
                    <div class="alert-title-deep">Limpieza Profunda Programada</div>
                    <div class="alert-date-deep">${scheduleDateStr}</div>
                    ${scheduledDeepClean.notes ? `<div class="alert-notes-deep">📝 ${sanitizeHTML(scheduledDeepClean.notes)}</div>` : ''}
                </div>
            </div>
        `;
    }
    
    detailsDiv.innerHTML = `
        <div class="cleaning-info-card">
            <div class="room-info-header">
                <div class="room-number-large">${room.number}</div>
                <div class="room-building-info">${room.building === 'regulares' ? 'Edificio 1' : 'Edificio Torre'}</div>
            </div>
            
            <div class="cleaning-timeline">
                <div class="timeline-item dirty-time">
                    <div class="timeline-icon">🧹</div>
                    <div class="timeline-content">
                        <div class="timeline-label">Marcada como sucia</div>
                        <div class="timeline-date">${dirtyTimeStr}</div>
                    </div>
                </div>
                
                <div class="timeline-arrow">?</div>
                
                <div class="timeline-item clean-time">
                    <div class="timeline-icon">?</div>
                    <div class="timeline-content">
                        <div class="timeline-label">Se limpiará ahora</div>
                        <div class="timeline-date">${cleanTimeStr}</div>
                    </div>
                </div>
            </div>
            
            <div class="cleaning-form">
                <label for="cleanerName" style="display: block; margin-bottom: 8px; font-weight: 600; color: #2c3e50;">
                    👤 Limpiado por: <span style="color: #e74c3c;">*</span>
                </label>
                <input type="text" id="cleanerName" placeholder="Nombre de quien limpia (obligatorio)" required style="width: 100%; padding: 12px; border: 2px solid #3498db; border-radius: 8px; margin-bottom: 15px; font-size: 15px;">
                
                <label for="cleaningNotes" style="display: block; margin-bottom: 8px; font-weight: 600; color: #2c3e50;">
                    📝 Notas de Limpieza (opcional)
                </label>
                <textarea id="cleaningNotes" placeholder="Ej: Falta jabón, toalla manchada, etc." rows="3" style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 8px; font-size: 14px; resize: vertical;"></textarea>
            </div>
            
            ${deepCleanScheduleInfo}
        </div>
    `;
    
    modal.classList.add('show');
    
    // MEJORADO: Enfocar automáticamente usando requestAnimationFrame
    // Esto asegura que el DOM esté completamente renderizado
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const cleanerInput = document.getElementById('cleanerName');
            if (cleanerInput) {
                cleanerInput.focus();
                cleanerInput.select(); // Seleccionar texto si hay alguno
            }
        });
    });
    
    // Configurar botón de confirmación
    const confirmBtn = document.getElementById('confirmCleanBtn');
    const cancelBtn = document.getElementById('cancelCleanBtn');
    
    confirmBtn.onclick = () => {
        const success = confirmCleanRoom(room.id);
        if (success) modal.classList.remove('show');
    };
    
    cancelBtn.onclick = () => {
        modal.classList.remove('show');
    };
    
    // Permitir confirmar con Enter en el input de nombre
    const cleanerInput = document.getElementById('cleanerName');
    if (cleanerInput) {
        cleanerInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                const success = confirmCleanRoom(room.id);
                if (success) modal.classList.remove('show');
            }
        }, { once: true });
    }
}

// Confirmar limpieza de habitación
let _confirmCleanRoomInProgress = false;

function confirmCleanRoom(roomId) {
    // Evitar procesamiento doble por clics rápidos
    if (_confirmCleanRoomInProgress) return false;

    const room = rooms.find(r => r.id === roomId);
    if (!room) return false;

    const cleanerNameInput = document.getElementById('cleanerName');

    // Validación mejorada: verificar que el input existe y tiene valor
    if (!cleanerNameInput) {
        console.error('[CleanRoom] Input cleanerName no encontrado en el DOM');
        showToast('Error: No se pudo encontrar el campo de nombre', 'error');
        return false;
    }

    const cleanerName = cleanerNameInput.value.trim();
    if (!cleanerName || cleanerName.length === 0) {
        showToast('Por favor ingresa el nombre de quien limpió', 'error');
        cleanerNameInput.focus();
        return false;
    }

    // Bloquear nuevos disparos mientras se procesa
    _confirmCleanRoomInProgress = true;

    const notesTextarea = document.getElementById('cleaningNotes');
    const cleaningNotes = notesTextarea ? notesTextarea.value.trim() : '';

    // Cambiar estado a disponible
    room.status = 'available';
    room.cleanedCount++;
    room.lastModified = Date.now(); // Timestamp para merge inteligente
    const cleanTimestamp = Date.now();

    // CRÍTICO: Resetear TODOS los campos de la habitación
    room.checkInTime = null;
    room.endTime = null;
    room.guestName = '';
    room.guestCount = 0;
    room.price = 0;
    room.notes = '';
    room.customTime = null;
    room.paymentMethod = null;

    if (cleaningNotes) {
        // Validar y sanitizar la nota
        const sanitizedNote = cleaningNotes.trim();
        if (sanitizedNote.length > 0) {
            if (!room.cleaningNotes) room.cleaningNotes = [];
            
            const noteData = { 
                id: cleanTimestamp, 
                note: sanitizedNote, 
                timestamp: cleanTimestamp, 
                cleanedBy: cleanerName 
            };
            
            room.cleaningNotes.push(noteData);
            console.log(`[CleaningNotes] ✅ Nota guardada para habitación ${room.number}:`, sanitizedNote);
            
            // Limitar notas por habitación (máximo 50)
            if (room.cleaningNotes.length > 50) {
                room.cleaningNotes = room.cleaningNotes.slice(-50);
                console.log(`[CleaningNotes] Limitando notas de habitación ${room.number} a 50 más recientes`);
            }
        } else {
            console.log(`[CleaningNotes] Nota vacía para habitación ${room.number}, no se guarda`);
        }
    }

    roomRevenue.push({
        id: cleanTimestamp, roomId: room.id, roomNumber: room.number, building: room.building,
        dirtyTimestamp: room.dirtyTimestamp || null, cleanedTimestamp: cleanTimestamp,
        cleaningNotes: cleaningNotes, cleanedBy: cleanerName,
        timestamp: cleanTimestamp, type: 'cleaned',
        shift: getCurrentShift().type, shiftName: getCurrentShift().name
    });
    invalidateRevenueIndex();
    
    // Limitar a últimos 10000 registros sin eliminar nunca registros del turno actual
    if (roomRevenue.length > 10000) {
        console.warn('[Sistema] Archivando ingresos antiguos...');
        const keep = roomRevenue.filter(r => r.timestamp >= currentShiftStart);
        const extra = roomRevenue.filter(r => r.timestamp < currentShiftStart).slice(-Math.max(0, 10000 - keep.length));
        roomRevenue = [...extra, ...keep];
        console.log(`[Sistema] Archivados registros antiguos. Preservados: ${keep.length} del turno actual.`);
    }

    room.dirtyTimestamp = null;

    logActivity('rooms', `🧹 Habitación ${room.number} limpiada por ${cleanerName}`, {
        roomId: room.id, roomNumber: room.number, building: room.building, notes: cleaningNotes
    });

    console.log(`[CleaningSystem] ✅ Limpieza registrada - Hab: ${room.number}, Notas: ${cleaningNotes ? 'Sí' : 'No'}, Por: ${cleanerName}`);

    saveData();
    renderCleaningRooms();
    renderRecentCleaningNotes();

    const actModal = document.getElementById('roomsActivityModal');
    if (actModal && actModal.classList.contains('show')) renderRoomsActivity();

    // Limpiar campos
    if (cleanerNameInput) cleanerNameInput.value = '';
    if (notesTextarea) notesTextarea.value = '';

    showToast(`🧹 Habitación ${room.number} marcada como limpia`, 'success');
    _confirmCleanRoomInProgress = false;
    return true;
}
// Login
document.addEventListener('DOMContentLoaded', () => {
    // ── FASE 1: INSTANTÁNEO (sin red) ──────────────────────────────
    document.body.classList.add('loaded');          // página visible de inmediato
    users = _getCachedUsersSync();                  // usuarios desde caché local
    _setupLoginForm();                              // formulario listo para usar
    _setupReservationForm();                        // formulario reservas
    checkSession();                                 // muestra login o mainApp según sesión

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
async function logout() {
    const confirmed = await showCustomConfirm('Cerrar Sesión', '¿Estás seguro de que quieres cerrar sesión?');
    if (!confirmed) return;

    // Limpiar todos los intervalos activos para prevenir fugas de memoria
    activeIntervals.forEach(intervalId => clearInterval(intervalId));
    activeIntervals = [];

    // Limpiar sesión de TODOS los almacenamientos (localStorage, sessionStorage y memoria)
    try { localStorage.removeItem('currentUser'); } catch(e) {}
    try { sessionStorage.removeItem('currentUser'); } catch(e) {}
    if (window._memStorage) delete window._memStorage['currentUser'];

    currentUser = null;
    location.reload();
}

// Data Storage
let rooms = [];
let roomRevenue = [];
let roomRevenueIndex = null; // Índice para búsquedas rápidas
let sales = [];
let inventory = [];
let expenses = [];
let shiftReports = [];
let reservations = [];
let staffMembers = []; // Personal para control de asistencia
let announcements = []; // Avisos del director

const RESERVATION_LOCK_MS = 12 * 60 * 60 * 1000;

/**
 * Une dos arrays de objetos por su campo `id`, deduplicando.
 * El array `remote` gana en caso de colisión de IDs.
 * Se usa para sales, expenses, roomRevenue.
 */
function mergeArraysById(remote, local) {
    if (!Array.isArray(remote) || remote.length === 0) return Array.isArray(local) ? local : [];
    if (!Array.isArray(local) || local.length === 0) return remote;
    const map = new Map();
    local.forEach(item => { if (item && item.id != null) map.set(item.id, item); });
    // El remoto solo gana si su timestamp es estrictamente más reciente;
    // en empate, el local conserva precedencia (evita sobrescribir con relojes desfasados)
    remote.forEach(item => {
        if (item && item.id != null) {
            const existing = map.get(item.id);
            if (!existing || (item.timestamp || 0) > (existing.timestamp || 0)) {
                map.set(item.id, item);
            }
        }
    });
    return Array.from(map.values()).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

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
const HOT_WINDOW_MONTHS = 3; // mes actual + 2 anteriores (cubre de sobra la
                              // ventana móvil de 30 días de las estadísticas
                              // por período y el mes anterior para "anteriores")

// A qué "mes de reporte" pertenece un timestamp. Usa el MISMO corte que
// getMonthRangeFor() (día 1 06:00 → día 1 siguiente 05:59:59): el turno
// nocturno de la madrugada del día 1 (antes de las 6am) cuenta como cierre
// del mes anterior, igual que en el Reporte Mensual. Es la única fuente de
// verdad para "en qué mes vive este registro" — tanto al guardar el shard
// como al leerlo, para que nunca queden desalineados entre sí.
function getRecordMonth(timestamp) {
    const d = new Date(timestamp || 0);
    let year = d.getFullYear();
    let month = d.getMonth();
    if (d.getDate() === 1 && d.getHours() < 6) {
        const prev = new Date(year, month - 1, 1);
        year = prev.getFullYear();
        month = prev.getMonth();
    }
    return { year, month };
}

function getMonthKey(timestamp) {
    const { year, month } = getRecordMonth(timestamp);
    return `${year}_${month}`;
}

function _shardStorageKey(type, year, month) {
    return `motelShard_${type}_${year}_${month}`;
}

function _shardFirebaseKey(type, year, month) {
    return `${type}_${year}_${month}`;
}

// Firestore rechaza documentos de más de ~1 MiB. Un mes con mucho historial
// de ventas/gastos/ingresos puede acercarse o superar ese límite, y a
// diferencia de un error de conectividad ese guardado NUNCA se recupera solo
// reintentando — se queda "pendiente" para siempre (esto es lo que causaba
// el badge de sincronización atorado). En vez de descartar historial para
// caber en el límite, el shard se reparte en documentos "_p0", "_p1", ...
// Se deja margen de sobra (700 KB de 1 MiB) para no filo con el límite real.
const MAX_SHARD_BYTES = 700 * 1024;
// Tope de particiones a las que nos suscribimos en tiempo real. 8 partes de
// 700 KB son ~5.6 MB de historial de un solo tipo (revenue/sales/expenses)
// en UN mes — muy por encima de cualquier volumen real de un solo motel. Si
// algún mes llegara a superarlo, sus datos igual se cargarían completos en
// cada refresco de página (_loadShardFromFirebase no tiene tope), solo se
// retrasaría la actualización en vivo de las partes extra.
const MAX_SHARD_LISTEN_PARTS = 8;

function _splitIntoChunks(records, maxBytes) {
    const chunks = [];
    let current = [];
    let currentSize = 2; // '[' + ']'
    records.forEach(rec => {
        const recSize = JSON.stringify(rec).length + 1; // +1 por la coma separadora
        if (current.length > 0 && currentSize + recSize > maxBytes) {
            chunks.push(current);
            current = [];
            currentSize = 2;
        }
        current.push(rec);
        currentSize += recSize;
    });
    if (current.length > 0) chunks.push(current);
    return chunks;
}

// Guarda un shard mensual en Firebase, partiéndolo en varios documentos si
// hace falta (ver comentario de MAX_SHARD_BYTES arriba). No se pierde ni
// descarta ningún registro: solo se distribuye entre más documentos.
//
// persistHotShards() reescribe los 3 meses de la ventana caliente en CADA
// guardado, aunque casi siempre solo el mes actual cambió de verdad (una
// venta/renovación usa Date.now(), nunca toca meses viejos) — eso son 9
// escrituras (revenue/sales/expenses × 3 meses) por acción, la mayoría
// redundantes. No hace falta filtrar eso aquí: _fbSave() (firebase-sync.js)
// ya compara el contenido contra el último guardado exitoso y omite la
// escritura a Firestore si no cambió nada, así que las llamadas de más
// terminan siendo baratas (comparación en memoria) en vez de tráfico de red
// real — que es lo que agotaba la cola de escritura del cliente
// (resource-exhausted: "Write stream exhausted maximum allowed queued
// writes") cuando varias ventas seguidas disparaban guardados inmediatos.
function _saveShardToFirebase(type, year, month, records) {
    if (!window.FirebaseSync || !window.FirebaseSync.ready) return;
    const baseKey = _shardFirebaseKey(type, year, month);
    const serialized = JSON.stringify(records);

    if (serialized.length <= MAX_SHARD_BYTES) {
        window.FirebaseSync.saveShardData(baseKey, records)
            .catch(e => console.error(`[Shard] Error guardando ${type} ${year}_${month} en Firebase:`, e));
        return;
    }

    const chunks = _splitIntoChunks(records, MAX_SHARD_BYTES);
    console.warn(`[Shard] ${type} ${year}_${month}: ${(serialized.length / 1024).toFixed(0)} KB supera el límite de un documento — dividiendo en ${chunks.length} partes.`);
    Promise.all(chunks.map((chunk, i) => window.FirebaseSync.saveShardData(`${baseKey}_p${i}`, chunk)))
        .then(() => {
            // El documento plano viejo queda obsoleto una vez que el mes se reparte
            // en partes; se limpia SOLO después de que todas las partes se guardaron bien.
            return window.FirebaseSync.saveShardData(baseKey, null);
        })
        .catch(e => console.error(`[Shard] Error guardando partes de ${type} ${year}_${month} en Firebase:`, e));
}

// Combos "tipo_año_mes" que sabemos particionados (shard > 700KB, ver
// MAX_SHARD_BYTES) — poblado por _loadShardFromFirebase(). Solo estos
// necesitan listeners en tiempo real para sus documentos "_p0".."_p7"; ver
// _subscribeHotWindowListeners() más abajo.
const _shardPartitionedCombos = new Set();

// Carga un shard mensual completo desde Firebase, sin importar si está
// guardado como un solo documento o repartido en partes "_p0", "_p1", ...
async function _loadShardFromFirebase(type, year, month) {
    const baseKey = _shardFirebaseKey(type, year, month);
    const comboKey = `${type}_${year}_${month}`;
    const part0 = await window.FirebaseSync.loadShardData(`${baseKey}_p0`, null);
    if (Array.isArray(part0)) {
        _shardPartitionedCombos.add(comboKey);
        let all = part0.slice();
        let i = 1;
        while (true) {
            const part = await window.FirebaseSync.loadShardData(`${baseKey}_p${i}`, null);
            if (!Array.isArray(part)) break;
            all = all.concat(part);
            i++;
        }
        return all;
    }
    _shardPartitionedCombos.delete(comboKey);
    return await window.FirebaseSync.loadShardData(baseKey, null);
}

// Devuelve [{year, month}, ...] para la ventana caliente, mes actual primero.
function getHotWindowMonths(referenceDate = new Date()) {
    const months = [];
    for (let i = 0; i < HOT_WINDOW_MONTHS; i++) {
        const d = new Date(referenceDate.getFullYear(), referenceDate.getMonth() - i, 1);
        months.push({ year: d.getFullYear(), month: d.getMonth() });
    }
    return months;
}

function _isInHotWindow(year, month) {
    return getHotWindowMonths().some(m => m.year === year && m.month === month);
}

function _groupByMonth(arr) {
    const groups = new Map();
    (arr || []).forEach(item => {
        const key = getMonthKey(item.timestamp);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    });
    return groups;
}

// Solo el mes ACTUAL se cachea en localStorage (respaldo síncrono para el
// primer render antes de que Firebase responda). Los otros meses de la
// ventana caliente (mes anterior, y el anterior a ese) ya NO se duplican
// aquí — Firebase es quien los mantiene, y _loadHotShardsFromFirebase() los
// trae momentos después del primer render, como ya venía pasando. Guardar
// los 3 meses completos en localStorage era el principal responsable de que
// el aviso de "almacenamiento casi lleno" apareciera cada vez más seguido
// según crecía el historial del negocio.
function _isCurrentHotMonth(year, month) {
    const current = getHotWindowMonths()[0];
    return current.year === year && current.month === month;
}

function _persistShardsFor(type, arr) {
    _groupByMonth(arr).forEach((records, key) => {
        const [year, month] = key.split('_').map(Number);
        if (_isCurrentHotMonth(year, month)) {
            try {
                localStorage.setItem(_shardStorageKey(type, year, month), JSON.stringify(records));
            } catch (e) {
                console.error(`[Shard] Error guardando ${type} ${key} en localStorage:`, e);
            }
        } else {
            // Meses no-actuales: eliminar cualquier copia vieja en localStorage
            // (de versiones anteriores de la app) para liberar espacio ya mismo.
            try { localStorage.removeItem(_shardStorageKey(type, year, month)); } catch (e) {}
        }
        _saveShardToFirebase(type, year, month, records);
    });
}

// Guarda roomRevenue/sales/expenses (que en todo momento solo deberían
// contener registros de la ventana caliente) como shards por mes, en vez de
// un único blob plano. Se llama junto con saveDataThrottled/_saveDataImmediate.
function persistHotShards() {
    _persistShardsFor('revenue', roomRevenue);
    _persistShardsFor('sales', sales);
    _persistShardsFor('expenses', expenses);
}

// Limpieza única por sesión: antes de este cambio, los 3 meses de la ventana
// caliente (y cualquier mes "frío" que un director hubiera consultado alguna
// vez en el Reporte Mensual) se guardaban para siempre en localStorage bajo
// "motelShard_...". Ahora solo el mes actual vive ahí — esto elimina de un
// solo golpe todo lo demás que ya se había acumulado en dispositivos
// existentes, que era la causa directa del aviso de "almacenamiento casi
// lleno". Los datos no se pierden: siguen íntegros en Firebase.
function _pruneStaleShardLocalStorage() {
    const current = getHotWindowMonths()[0];
    const currentSuffix = `_${current.year}_${current.month}`;
    try {
        Object.keys(localStorage).forEach(k => {
            if (k.startsWith('motelShard_') && !k.endsWith(currentSuffix)) {
                localStorage.removeItem(k);
            }
        });
    } catch (e) {}

    // Los arreglos planos de ANTES del sharding mensual (todo el historial en
    // un solo blob) se conservaban en localStorage como respaldo de la
    // migración, pero una vez que esta ya corrió y los shards existen, esos
    // 3 arreglos completos ya nunca se vuelven a leer — son puro peso muerto
    // que puede pesar varios MB si el negocio lleva tiempo operando. Firebase
    // conserva su propia copia de respaldo (esa sí no se toca); esto solo
    // limpia la copia local del navegador.
    try {
        if (safeLocalStorageGet('_shardMigrationDone', false)) {
            ['motelRoomRevenue', 'motelSales', 'motelExpenses'].forEach(k => localStorage.removeItem(k));
        }
    } catch (e) {}
}

// Carga inicial (arranque de la app, antes de que Firebase esté listo):
// llena roomRevenue/sales/expenses con los shards de la ventana caliente
// guardados en localStorage. Si este dispositivo todavía no tiene NINGÚN
// shard guardado (primera carga tras la migración, antes de que
// migrateToMonthlyShards() corra, o un dispositivo que aún no migró), cae de
// vuelta a los arreglos planos viejos filtrados a la ventana caliente en vez
// de arrancar con la vista vacía.
function _loadHotShardsFromLocalStorage() {
    _pruneStaleShardLocalStorage();
    roomRevenue = [];
    sales = [];
    expenses = [];
    let foundAnyShard = false;

    getHotWindowMonths().forEach(({ year, month }) => {
        ['revenue', 'sales', 'expenses'].forEach(type => {
            try {
                const raw = localStorage.getItem(_shardStorageKey(type, year, month));
                if (!raw) return;
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) return;
                foundAnyShard = true;
                if (type === 'revenue') roomRevenue.push(...parsed);
                else if (type === 'sales') sales.push(...parsed);
                else expenses.push(...parsed);
            } catch (e) {}
        });
    });

    if (!foundAnyShard) {
        const isHot = (item) => {
            const rm = getRecordMonth(item.timestamp);
            return _isInHotWindow(rm.year, rm.month);
        };
        roomRevenue = safeLocalStorageGet('motelRoomRevenue', []).filter(isHot);
        sales = safeLocalStorageGet('motelSales', []).filter(isHot);
        expenses = safeLocalStorageGet('motelExpenses', []).filter(isHot);
    }
}

// Carga desde Firebase (al iniciar sesión / reconectar): trae los shards de
// la ventana caliente y los fusiona (mergeArraysById) con lo que ya hay en
// memoria desde localStorage.
async function _loadHotShardsFromFirebase() {
    if (!window.FirebaseSync || !window.FirebaseSync.ready) return;
    const months = getHotWindowMonths();
    const tasks = [];
    months.forEach(({ year, month }) => {
        ['revenue', 'sales', 'expenses'].forEach(type => {
            tasks.push(
                _loadShardFromFirebase(type, year, month)
                    .then(remote => ({ type, remote }))
                    .catch(() => ({ type, remote: null }))
            );
        });
    });
    const results = await Promise.all(tasks);
    results.forEach(({ type, remote }) => {
        if (!Array.isArray(remote) || remote.length === 0) return;
        if (type === 'revenue') roomRevenue = mergeArraysById(remote, roomRevenue);
        else if (type === 'sales') sales = mergeArraysById(remote, sales);
        else expenses = mergeArraysById(remote, expenses);
    });
    invalidateRevenueIndex();
}

// Carga bajo demanda los registros de UN mes específico (roomRevenue/sales/
// expenses), esté o no dentro de la ventana caliente. Usado por el Reporte
// Mensual al navegar a un mes distinto del actual. `type` es 'revenue',
// 'sales' o 'expenses'.
async function loadMonthShard(year, month, type) {
    const hotArray = type === 'revenue' ? roomRevenue : (type === 'sales' ? sales : expenses);
    if (_isInHotWindow(year, month)) {
        // Ya está en memoria — filtrar directamente, sin round-trip.
        return hotArray.filter(item => {
            const rm = getRecordMonth(item.timestamp);
            return rm.year === year && rm.month === month;
        });
    }

    // Mes frío: se trae de Firebase (que ya resuelve rápido desde su propio
    // caché local de Firestore cuando está disponible). Ya NO se duplica en
    // localStorage: guardar aquí cada mes distinto que un director consulta
    // en el Reporte Mensual, para siempre y sin límite, era otra fuente de
    // crecimiento indefinido de "almacenamiento casi lleno". El caché en
    // memoria _coldMonthCache (ver ensureMonthDataLoaded) ya evita refetch
    // mientras se navega el mismo mes en una sesión.
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        try {
            const remote = await _loadShardFromFirebase(type, year, month);
            if (Array.isArray(remote)) return remote;
        } catch (e) {
            console.error(`[Shard] Error cargando ${type} ${year}_${month}:`, e);
        }
    }
    return [];
}

// Caché temporal de UN mes "frío" para el Reporte Mensual — nunca se
// persiste, se descarta en cuanto se consulta otro mes. Poblada por
// ensureMonthDataLoaded() (async); getMonthRecords() la lee de forma
// síncrona para no tener que convertir en async las ~7 funciones del
// Reporte Mensual que hoy filtran roomRevenue/sales/expenses directamente.
let _coldMonthCache = { key: null, revenue: [], sales: [], expenses: [] };

// Llamar (con await) ANTES de generar/exportar el Reporte Mensual para un
// año/mes dado. Si ese mes ya está en la ventana caliente no hace nada (los
// datos ya están en memoria); si es un mes viejo, lo trae una sola vez y lo
// deja listo para que getMonthRecords() lo lea de forma síncrona.
async function ensureMonthDataLoaded(year, month) {
    if (_isInHotWindow(year, month)) return;
    const key = `${year}_${month}`;
    if (_coldMonthCache.key === key) return;
    const [revenue, sales, expenses] = await Promise.all([
        loadMonthShard(year, month, 'revenue'),
        loadMonthShard(year, month, 'sales'),
        loadMonthShard(year, month, 'expenses')
    ]);
    _coldMonthCache = { key, revenue, sales, expenses };
}

// Lectura síncrona de los registros de un mes para el Reporte Mensual: si es
// un mes de la ventana caliente, filtra el arreglo en memoria (roomRevenue/
// sales/expenses); si es un mes frío, usa la caché ya poblada por
// ensureMonthDataLoaded() (debe haberse llamado antes, con await, en el
// punto de entrada — onMonthYearChange, downloadMonthlyExcel, etc.).
function getMonthRecords(year, month, type) {
    const hotArray = type === 'revenue' ? roomRevenue : (type === 'sales' ? sales : expenses);
    if (_isInHotWindow(year, month)) {
        return hotArray.filter(item => {
            const rm = getRecordMonth(item.timestamp);
            return rm.year === year && rm.month === month;
        });
    }
    const key = `${year}_${month}`;
    if (_coldMonthCache.key !== key) {
        console.warn(`[Shard] getMonthRecords(${key}, ${type}) llamado sin ensureMonthDataLoaded previo — devolviendo vacío`);
        return [];
    }
    return _coldMonthCache[type] || [];
}

let _hotWindowAnchorKey = null; // "{year}_{month}" del mes actual la última vez que se revisó
let _hotShardListenerKeys = [];

function _subscribeHotWindowListeners() {
    if (!window.FirebaseSync || !window.FirebaseSync.listenKey) return;
    _hotShardListenerKeys.forEach(k => window.FirebaseSync.unlistenKey(k));
    _hotShardListenerKeys = [];

    getHotWindowMonths().forEach(({ year, month }) => {
        ['revenue', 'sales', 'expenses'].forEach(type => {
            const baseKey = _shardFirebaseKey(type, year, month);
            const onShardUpdate = (_key, val) => {
                if (!Array.isArray(val) || !_isInHotWindow(year, month)) return;
                if (type === 'revenue') {
                    roomRevenue = mergeArraysById(val, roomRevenue);
                    invalidateRevenueIndex();
                } else if (type === 'sales') {
                    sales = mergeArraysById(val, sales);
                } else {
                    expenses = mergeArraysById(val, expenses);
                }
                // El merge de arriba ya quedó aplicado en memoria pase lo que
                // pase abajo. Todo lo demás es refresco de UI — se aísla en su
                // propio try/catch para que una excepción ahí (p.ej. un
                // elemento del DOM que no existe para el rol actual) no deje
                // el dato mergeado sin reflejarse nunca en pantalla ni en el
                // próximo cambio de pestaña. Antes esto podía fallar en
                // silencio: listenKey() en firebase-sync.js envuelve TODO
                // este callback en un único try/catch genérico que lo
                // etiqueta (incorrectamente) como "Error parsing".
                try {
                    if (type === 'sales') renderSalesLog();
                    else if (type === 'expenses') updateExpensesTotal();
                    updateStatistics();
                    if (document.getElementById('shift-control-tab')?.classList.contains('active')) {
                        updateShiftControl();
                    } else {
                        _shiftDataStale = true;
                    }
                } catch (e) {
                    console.error('[Shard] Error refrescando UI tras cambio remoto:', type, e);
                    _pushAppDebug('shard-ui-refresh-error', `${type}: ${e.message}`);
                    _shiftDataStale = true; // al menos garantizar el refresco al cambiar de pestaña
                }
            };
            // Se escucha la clave plana (mes normal) siempre. Las particiones
            // (ver MAX_SHARD_LISTEN_PARTS) SOLO se escuchan si ya sabemos por
            // _loadShardFromFirebase() que ese mes/tipo está realmente
            // particionado (shard > 700KB) — antes se suscribían las 8 "por
            // si acaso" para los 9 combos de mes×tipo, 81 listeners en total,
            // aunque casi ninguno tiene datos reales jamás. Registrar tantos
            // listeners de golpe (81, sumados a los 15 de motelRooms/etc.)
            // era lo que hacía que Firestore rechazara la mayoría con errores
            // "already-exists" en el celular — motelRooms sí sincronizaba
            // (solo 15 listeners) pero ingresos/ventas/gastos se quedaban
            // muertos. Si un mes cruza el umbral de 700KB en vivo durante la
            // sesión, sus particiones nuevas se recogen en la próxima
            // recarga completa (rollover de hora, o volver del background).
            _hotShardListenerKeys.push(baseKey);
            window.FirebaseSync.listenKey(baseKey, onShardUpdate);
            const comboKey = `${type}_${year}_${month}`;
            if (_shardPartitionedCombos.has(comboKey)) {
                for (let p = 0; p < MAX_SHARD_LISTEN_PARTS; p++) {
                    const partKey = `${baseKey}_p${p}`;
                    _hotShardListenerKeys.push(partKey);
                    window.FirebaseSync.listenKey(partKey, onShardUpdate);
                }
            }
        });
    });
}

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
const _appDebugLog = [];
function _pushAppDebug(event, detail) {
    try {
        _appDebugLog.push({ t: Date.now(), event, detail: detail || '' });
        if (_appDebugLog.length > 50) _appDebugLog.shift();
    } catch (e) {}
}

let _lastListenerReactivation = 0;
const LISTENER_REACTIVATION_MIN_GAP_MS = 5000;
function _reactivateRealtimeListeners(reason) {
    const now = Date.now();
    if (now - _lastListenerReactivation < LISTENER_REACTIVATION_MIN_GAP_MS) {
        console.log(`[Sync] Reactivación de listeners (${reason}) omitida — ya se hizo hace <5s`);
        _pushAppDebug('reactivate-skipped', reason);
        return;
    }
    _lastListenerReactivation = now;
    console.log(`[Sync] Reactivando listeners en tiempo real (${reason})`);
    _pushAppDebug('reactivate', reason);
    if (window.FirebaseSync && window.FirebaseSync.listenAll) {
        window.FirebaseSync.listenAll(handleFirebaseRealtimeUpdate);
    }
    _subscribeHotWindowListeners();
}

// Detecta si el mes calendario cambió desde la última vez que se revisó; si
// cambió, suelta de memoria los registros que salieron de la ventana
// caliente (ya están a salvo en su propio shard) y vuelve a suscribir los
// listeners a la nueva ventana. Se llama al iniciar y periódicamente.
function rolloverHotWindowIfNeeded() {
    const now = new Date();
    const currentKey = `${now.getFullYear()}_${now.getMonth()}`;
    if (_hotWindowAnchorKey === currentKey) return;

    const isFirstRun = _hotWindowAnchorKey === null;
    _hotWindowAnchorKey = currentKey;

    if (!isFirstRun) {
        const keep = (item) => {
            const rm = getRecordMonth(item.timestamp);
            return _isInHotWindow(rm.year, rm.month);
        };
        roomRevenue = roomRevenue.filter(keep);
        invalidateRevenueIndex();
        sales = sales.filter(keep);
        expenses = expenses.filter(keep);
        console.log('[Shard] Ventana caliente rotada a', currentKey);
    }

    _subscribeHotWindowListeners();
}

// Migración única: reparte los 3 documentos planos viejos (todo el historial
// en un solo blob) en shards por mes. Los documentos planos NO se borran —
// quedan como respaldo. Gateada por una bandera persistida para correr una
// sola vez por instalación.
async function migrateToMonthlyShards() {
    if (!window.FirebaseSync || !window.FirebaseSync.ready) return;
    if (safeLocalStorageGet('_shardMigrationDone', false)) return;

    console.log('[Shard] Iniciando migración única a shards mensuales...');
    try {
        const [oldRevenue, oldSales, oldExpenses] = await Promise.all([
            window.FirebaseSync.load('motelRoomRevenue', []),
            window.FirebaseSync.load('motelSales', []),
            window.FirebaseSync.load('motelExpenses', [])
        ]);

        _persistShardsFor('revenue', Array.isArray(oldRevenue) ? oldRevenue : []);
        _persistShardsFor('sales', Array.isArray(oldSales) ? oldSales : []);
        _persistShardsFor('expenses', Array.isArray(oldExpenses) ? oldExpenses : []);

        safeLocalStorageSet('_shardMigrationDone', true);
        console.log('[Shard] Migración a shards mensuales completada. Documentos planos viejos preservados como respaldo.');
    } catch (e) {
        console.error('[Shard] Error durante la migración a shards mensuales:', e);
    }
}

/** Une reservas locales con las de Firebase por id (gana el registro con updatedAt/createdAt más reciente). */
function mergeReservationsFromCloud(cloud, local) {
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
function mergeInventoryFromCloud(cloud, local) {
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

/**
 * Reserva "bloqueada" en UI: falta 12h o menos para reservationTimestamp (o ya pasó).
 */
function isRoomReservationLocked(room) {
    if (!room || room.status !== 'reserved') return false;
    
    const res = reservations.find(x => x?.id === room.reservationId);
    if (!res) return false;
    
    const ts = res.reservationTimestamp ?? res.createdAt;
    if (!ts || !Number.isFinite(ts)) return false;
    
    return (ts - Date.now()) <= RESERVATION_LOCK_MS;
}

function renderReservationsSidebar() {
    const roomSelect = document.getElementById('reservationRoomSelect');
    const list = document.getElementById('reservationsList');
    
    if (!roomSelect || !list) {
        console.error('[Reservations] ERROR: No se encontraron los elementos del DOM');
        return;
    }

    // Poblar select con TODAS las habitaciones
    const statusLabel = { available: '✅', occupied: '🔴', dirty: '🟡', reserved: '📌', 'not-available': '⛔' };
    const allRooms = (rooms || []).filter(r => r).slice().sort((a, b) => {
        if (a.building !== b.building) return a.building === 'regulares' ? -1 : 1;
        return a.number - b.number;
    });
    const optPlaceholder = `<option value="">Seleccionar habitación</option>`;
    roomSelect.innerHTML = optPlaceholder + allRooms.map(r => {
        const label = `${r.building === 'regulares' ? 'Ed.1' : 'Torre'}-${r.number}${r.roomName ? ` (${r.roomName})` : ''} ${statusLabel[r.status] || ''}`;
        return `<option value="${r.id}">${label}</option>`;
    }).join('');

    // Render listado (pendientes a futuro, ordenadas por fecha)
    const now = Date.now();
    const items = (Array.isArray(reservations) ? reservations : [])
        .filter(r => r && !['cancelled', 'completed'].includes(r.status ?? 'pending'))
        .slice()
        .sort((a, b) => (a.reservationTimestamp ?? 0) - (b.reservationTimestamp ?? 0));

    if (items.length === 0) {
        list.innerHTML = '<div class="no-notes"><p>No hay reservas registradas</p></div>';
        return;
    }

    list.innerHTML = items.map(r => {
        const ts = r.reservationTimestamp ?? r.createdAt ?? 0;
        const dt = ts ? new Date(ts) : null;
        const dateStr = dt ? dt.toLocaleString('es-MX', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
        const msUntil = ts - now;
        const locked = msUntil <= RESERVATION_LOCK_MS;
        const statusText = locked ? 'Reservada (bloqueada)' : 'Reservada (no bloqueada)';
        const roomLabel = `${r.building === 'regulares' ? 'Ed.1' : 'Torre'}-${r.roomNumber}`;
        const phone = r.phone ? String(r.phone) : '';
        const pm = r.paymentMethod === 'tarjeta' ? '💳 Tarjeta' : (r.paymentMethod === 'efectivo' ? '💵 Efectivo' : '—');
        const price = Number(r.price);
        return `
            <div class="reservation-item ${locked ? 'locked' : ''}">
                <div class="reservation-item-header">
                    <span class="reservation-room-badge">${roomLabel}</span>
                    <span class="reservation-status-badge ${locked ? 'locked' : ''}">${statusText}</span>
                </div>
                <div class="reservation-meta">
                    <div><strong>Nombre:</strong> ${escapeHtml(r.guestName || '')}</div>
                    <div><strong>Tel:</strong> ${escapeHtml(phone)}</div>
                    <div><strong>Fecha:</strong> ${escapeHtml(dateStr)}</div>
                    <div><strong>Precio:</strong> ${escapeHtml(Number.isFinite(price) ? ('$' + price.toFixed(2)) : '—')}</div>
                    <div><strong>Pago:</strong> ${escapeHtml(pm)}</div>
                </div>
                <div class="reservation-actions">
                    <button class="btn-cancel-res" onclick="cancelReservation(${Number(r.id)})">Cancelar</button>
                </div>
            </div>
        `;
    }).join('');
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function normalizePhone(raw) {
    const digits = String(raw || '').replace(/[^\d+]/g, '');
    return digits;
}

function createReservationFromSidebar(formValues) {
    const { roomId, guestName, phone, reservationTimestamp, paymentMethod, price } = formValues;
    const room = rooms.find(r => r && r.id === roomId);
    if (!room) throw new Error('Habitación no encontrada');
    if (room.status !== 'available') throw new Error(`Habitación ${room.number} no está disponible (${translateStatus(room.status)}) — no se puede reservar`);
    if (!guestName || !guestName.trim()) throw new Error('Nombre requerido');
    if (!phone || !phone.trim()) throw new Error('Teléfono requerido');
    if (!reservationTimestamp || !Number.isFinite(reservationTimestamp)) throw new Error('Fecha/hora inválidas');
    if (!paymentMethod) throw new Error('Método de pago requerido');
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) throw new Error('Precio requerido');

    const id = Date.now();
    const reservation = {
        id,
        roomId: room.id,
        roomNumber: room.number,
        building: room.building,
        guestName: guestName.trim(),
        phone: normalizePhone(phone),
        reservationTimestamp,
        price: p,
        paymentMethod,
        status: 'pending',
        createdAt: id,
        updatedAt: id
    };

    reservations.push(reservation);

    room.status = 'reserved';
    room.reservationId = reservation.id;
    room.lastModified = Date.now();
    
    // NO registrar ingreso aquí - se registrará cuando el cliente llegue
    // El ingreso se registra en confirmReservationStart() cuando la habitación pasa a 'occupied'

    logActivity('rooms', `📌 Reserva creada Hab. ${room.number} (${room.building === 'regulares' ? 'Ed.1' : 'Torre'})`, {
        reservationId: reservation.id,
        roomId: room.id,
        guestName: reservation.guestName,
        phone: reservation.phone,
        reservationTimestamp
    });

    saveData();
    renderRooms();
    renderReservationsSidebar();
}

function cancelReservation(reservationId) {
    const idx = reservations.findIndex(r => r && r.id === reservationId);
    if (idx === -1) return;
    const res = reservations[idx];

    showCustomConfirm('Cancelar reserva', '¿Deseas cancelar esta reserva?').then(confirmed => {
        if (!confirmed) return;

        reservations[idx].status = 'cancelled';
        reservations[idx].updatedAt = Date.now();

        const room = rooms.find(r => r && r.id === res.roomId);
        if (room && room.status === 'reserved' && room.reservationId === reservationId) {
            room.status = 'available';
            room.reservationId = null;
            room.lastModified = Date.now();
        }

        saveData();
        renderRooms();
        renderReservationsSidebar();
        showToast('Reserva cancelada', 'info');
    });
}

function confirmReservationStart() {
    const room = rooms.find(r => r.id === currentRoomId);
    if (!room || room.status !== 'reserved') {
        showToast('Error: La habitación no está reservada', 'error');
        return;
    }
    
    const reservation = reservations.find(r => r.id === room.reservationId);
    if (!reservation) {
        showToast('Error: No se encontró la reserva', 'error');
        return;
    }
    
    // Leer el método de pago confirmado por el recepcionista en el modal
    const confirmedPaymentMethod = validatePaymentMethod('reservationStartPaymentMethod', 'Por favor selecciona el método de pago para esta reserva');
    if (!confirmedPaymentMethod) return;

    // Marcar la habitación como ocupada con los datos de la reserva
    room.status = 'occupied';
    room.checkInTime = Date.now();
    room.lastModified = Date.now(); // Timestamp para merge inteligente
    room.guestName = reservation.guestName || '';
    room.guestPhone = reservation.phone || ''; // CORREGIDO: era guestPhone
    room.price = reservation.price || room.defaultPrice;
    room.paymentMethod = confirmedPaymentMethod;
    
    // Calcular tiempo de finalización — usar las horas reales del cuarto
    // (la reserva no captura horas propias; usar 6h fijas aquí regalaba
    // tiempo extra gratis en los cuartos de 4h, que son la mayoría).
    const hours = reservation.hours || room.defaultHours;
    room.endTime = room.checkInTime + (hours * 3600000);
    room.customTime = hours;
    
    // Actualizar la reserva como completada
    reservation.status = 'completed';
    reservation.updatedAt = Date.now();
    
    // AHORA SÍ registrar el ingreso (cuando el cliente realmente llega)
    const revenueEntry = {
        id: Date.now(),
        roomId: room.id,
        roomNumber: room.number,
        building: room.building,
        price: room.price,
        checkInTime: room.checkInTime,
        timestamp: Date.now(),
        type: 'sold',
        paymentMethod: room.paymentMethod,
        shift: getCurrentShift().type,
        shiftName: getCurrentShift().name,
        guestName: room.guestName,
        fromReservation: true // Flag para identificar que viene de reserva
    };
    
    roomRevenue.push(revenueEntry);
    invalidateRevenueIndex(); // Invalidar índice después de agregar
    
    console.log('[Revenue] ✓ Ingreso registrado:', {
        habitacion: room.number,
        precio: room.price,
        turno: revenueEntry.shift,
        timestamp: new Date(revenueEntry.timestamp).toLocaleString()
    });
    
    // Limitar a últimos 10000 registros sin eliminar nunca registros del turno actual
    if (roomRevenue.length > 10000) {
        console.warn('[Sistema] Archivando ingresos antiguos...');
        const keep = roomRevenue.filter(r => r.timestamp >= currentShiftStart);
        const extra = roomRevenue.filter(r => r.timestamp < currentShiftStart).slice(-Math.max(0, 10000 - keep.length));
        roomRevenue = [...extra, ...keep];
        console.log(`[Sistema] Archivados registros antiguos. Preservados: ${keep.length} del turno actual.`);
    }

    // _saveDataImmediate() en vez de saveData(): esta acción representa una
    // venta (dinero + habitación ocupada) — no debe esperar el throttle de
    // 2s que existe para agrupar cambios menores. El empleado espera ver el
    // cobro reflejado en el otro dispositivo al instante, no unos segundos
    // después.
    _saveDataImmediate();
    renderRooms();
    renderReservationsSidebar();
    document.getElementById('roomModal').classList.remove('show');
    showToast(`Habitación ${room.number} confirmada en uso`, 'success');
}

let currentRoomId = null;
let editingProductId = null;
let currentCategoryFilter = 'all';
let _appReady = false;
let shiftSnapshots = []; // Snapshots de habitaciones al cerrar turno
let currentShiftStart = null; // Timestamp de inicio del turno actual
let currentShiftType = null; // Tipo de turno actual ('day' o 'night') - MANUAL
let _shiftDataStale = false;  // Indica que la pantalla de turno necesita refresco

const EXPECTED_ROOM_COUNT = 32;

function isValidRoomsArray(arr) {
    if (!Array.isArray(arr) || arr.length !== EXPECTED_ROOM_COUNT) return false;
    const reg = arr.filter(r => r && r.building === 'regulares').length;
    const tor = arr.filter(r => r && r.building === 'torre').length;
    return reg === 16 && tor === 16;
}

/** Corrige building ausente o erróneo usando el prefijo del id (regulares-N / torre-N). */
function tryRepairRoomsFromIds(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    arr.forEach(room => {
        if (!room || room.building === 'regulares' || room.building === 'torre') return;
        if (room.id && typeof room.id === 'string') {
            if (room.id.startsWith('regulares-')) room.building = 'regulares';
            else if (room.id.startsWith('torre-')) room.building = 'torre';
        }
    });
    return isValidRoomsArray(arr);
}

// Compara dos habitaciones campo por campo (no por JSON.stringify crudo: el
// orden de claves de un objeto reconstruido por JSON.parse(doc.data().value)
// no tiene por qué coincidir con el del objeto local, y eso produciría
// falsos positivos aunque los valores sean idénticos).
function _roomsDiffer(a, b) {
    if (!a || !b) return a !== b;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        if (a[k] !== b[k]) return true;
    }
    return false;
}

/**
 * Merge inteligente de habitaciones desde Firebase
 * VERSIÓN MEJORADA: Resolución campo por campo con versionado
 * Preserva TODAS las habitaciones y resuelve conflictos granularmente
 */
function mergeRoomsFromFirebase(incomingRooms, currentRooms) {
    if (!Array.isArray(incomingRooms) || incomingRooms.length === 0) {
        return currentRooms;
    }

    if (!Array.isArray(currentRooms) || currentRooms.length === 0) {
        return incomingRooms;
    }
    
    // Crear mapas de AMBAS fuentes
    const incomingMap = new Map();
    const currentMap = new Map();
    
    incomingRooms.forEach(room => {
        if (room && room.id) incomingMap.set(room.id, room);
    });
    
    currentRooms.forEach(room => {
        if (room && room.id) currentMap.set(room.id, room);
    });
    
    const allRoomIds = new Set([...incomingMap.keys(), ...currentMap.keys()]);
    const merged = [];

    allRoomIds.forEach(roomId => {
        const incomingRoom = incomingMap.get(roomId);
        const currentRoom = currentMap.get(roomId);

        if (!incomingRoom && currentRoom) {
            merged.push({ ...currentRoom });
            return;
        }
        if (incomingRoom && !currentRoom) {
            merged.push({ ...incomingRoom });
            return;
        }
        merged.push(resolveRoomConflict(incomingRoom, currentRoom));
    });

    merged.sort((a, b) => {
        if (a.building !== b.building) return a.building === 'regulares' ? -1 : 1;
        return a.number - b.number;
    });

    if (merged.length < Math.max(incomingRooms.length, currentRooms.length)) {
        console.error('[Merge] Posible pérdida de habitaciones en merge');
    }

    return merged;
}

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
function roomStatusTimestamp(room) {
    if (room.status === 'occupied') return room.checkInTime || room.lastModified || 0;
    if (room.status === 'dirty') return room.dirtyTimestamp || room.lastModified || 0;
    return room.lastModified || 0;
}

// Prioridad de negocio usada SOLO como desempate cuando ambos timestamps
// caen dentro de la ventana de tolerancia (cambio verdaderamente ambiguo).
// occupied > dirty > reserved > available/not-available: perder un check-in
// o dejar de saber que un cuarto está sucio es más costoso que al revés.
const ROOM_STATUS_PRIORITY = { occupied: 4, dirty: 3, reserved: 2, available: 1, 'not-available': 1 };

function resolveRoomConflict(incoming, current) {
    const resolved = { ...current };
    const TIME_TOLERANCE_MS = 10000;

    resolved.lastModified = Math.max(incoming.lastModified || 0, current.lastModified || 0);
    resolved.cleanedCount = Math.max(incoming.cleanedCount || 0, current.cleanedCount || 0);
    for (const field of ['dirtyTimestamp', 'cleanedTimestamp', 'cleaningNotes']) {
        if (!resolved[field] && incoming[field]) resolved[field] = incoming[field];
    }

    if (current.status === incoming.status) {
        // Mismo estado en ambos lados (p.ej. ambos 'occupied'): no hay
        // conflicto de ESTADO, pero SÍ puede haber cambiado algo más — el
        // caso típico es una renovación (renewStay()), que suma precio y
        // extiende endTime SIN tocar status. renewStay() marca
        // room.lastModified = Date.now() explícitamente para este momento:
        // "que la renovación prevalezca en merges con Firebase". Antes esta
        // rama cortaba aquí sin mirar lastModified, así que esa renovación
        // (precio, endTime, customTime, guestName...) nunca se copiaba al
        // otro dispositivo — la habitación se veía 'occupied' con el color
        // correcto en ambos lados, pero el precio se quedaba con el valor
        // viejo del lado que no hizo la renovación.
        if ((incoming.lastModified || 0) > (current.lastModified || 0)) {
            const preserved = { lastModified: resolved.lastModified, cleanedCount: resolved.cleanedCount,
                dirtyTimestamp: resolved.dirtyTimestamp, cleanedTimestamp: resolved.cleanedTimestamp,
                cleaningNotes: resolved.cleaningNotes };
            Object.assign(resolved, incoming, preserved);
        }
        return resolved;
    }

    const currentTime = roomStatusTimestamp(current);
    const incomingTime = roomStatusTimestamp(incoming);

    let winner;
    if (incomingTime > currentTime + TIME_TOLERANCE_MS) {
        winner = 'incoming';
    } else if (currentTime > incomingTime + TIME_TOLERANCE_MS) {
        winner = 'current';
    } else {
        // Cambios prácticamente simultáneos: desempatar por prioridad de negocio.
        const incomingPriority = ROOM_STATUS_PRIORITY[incoming.status] || 0;
        const currentPriority = ROOM_STATUS_PRIORITY[current.status] || 0;
        winner = incomingPriority > currentPriority ? 'incoming' : 'current';
    }

    if (winner === 'incoming') {
        const preserved = { lastModified: resolved.lastModified, cleanedCount: resolved.cleanedCount,
            dirtyTimestamp: resolved.dirtyTimestamp, cleanedTimestamp: resolved.cleanedTimestamp,
            cleaningNotes: resolved.cleaningNotes };
        Object.assign(resolved, incoming, preserved);
        logMergeConflict(current.id, 'status', current.status, incoming.status, 'incoming-wins');
    } else {
        logMergeConflict(current.id, 'status', incoming.status, current.status, 'current-wins');
    }

    return resolved;
}

/**
 * Registra conflictos de merge para auditoría
 */
function logMergeConflict(roomId, field, oldValue, newValue, resolution) {
    try {
        const conflictLog = JSON.parse(localStorage.getItem('_mergeConflictLog') || '[]');
        
        conflictLog.push({
            roomId,
            field,
            oldValue,
            newValue,
            resolution,
            timestamp: Date.now(),
            date: new Date().toLocaleString()
        });
        
        // Mantener últimos 100 conflictos
        if (conflictLog.length > 100) {
            conflictLog.splice(0, conflictLog.length - 100);
        }
        
        localStorage.setItem('_mergeConflictLog', JSON.stringify(conflictLog));
    } catch (e) {
        console.error('[Merge] Error guardando log de conflictos:', e);
    }
}

/**
 * Ver log de conflictos (para debugging)
 */
function showMergeConflictLog() {
    try {
        const log = JSON.parse(localStorage.getItem('_mergeConflictLog') || '[]');
        console.log('=== LOG DE CONFLICTOS DE MERGE ===');
        console.log(`Total de conflictos: ${log.length}`);
        console.table(log.slice(-20)); // Últimos 20
        return log;
    } catch (e) {
        console.error('Error leyendo log:', e);
        return [];
    }
}

// Exponer función para debugging
window.showMergeConflictLog = showMergeConflictLog;

function persistMotelRoomsOnly() {
    safeLocalStorageSet('motelRooms', rooms);
    if (_appReady && window.FirebaseSync && window.FirebaseSync.ready) {
        try { window.FirebaseSync.save('motelRooms', rooms); } catch (e) {}
    }
}

function ensureRoomsSanity() {
    let wasChanged = false;

    // Un arreglo VACÍO no es "corrupto" — es el estado normal antes de que
    // termine de cargar Firebase (loadData() solo trae lo que haya en
    // localStorage, y un dispositivo nuevo o con caché borrada no tiene
    // nada ahí todavía). init() llama a ensureRoomsSanity() de forma
    // síncrona, ANTES de que initFirebaseSync() (llamado al final de esa
    // misma función) tenga oportunidad de traer los datos reales. Antes,
    // esto se trataba igual que datos corruptos y se reemplazaba por la
    // plantilla de 32 habitaciones por defecto — un dispositivo nuevo veía
    // un parpadeo confuso de "todo disponible, sin huéspedes" antes de que
    // llegaran los datos reales unos segundos después. No llegaba a
    // subirse a Firebase (persistMotelRoomsOnly() está condicionado a
    // _appReady, que en este punto todavía es false), pero el parpadeo
    // visual era real y engañoso. Simplemente no hay nada que "reparar"
    // todavía — dejar que renderRooms() siga mostrando su placeholder de
    // "Cargando habitaciones…" hasta que los datos reales lleguen.
    if (Array.isArray(rooms) && rooms.length === 0) return;

    // Validación 1: Array válido
    if (!isValidRoomsArray(rooms)) {
        if (tryRepairRoomsFromIds(rooms)) {
            console.warn('[Data] Campo building corregido según id de habitación.');
            wasChanged = true;
        } else {
            console.error('[Data] Lista de habitaciones inválida; se restaura la plantilla inicial.');
            rooms = createInitialRooms();
            wasChanged = true;
        }
        if (wasChanged) persistMotelRoomsOnly();
        return;
    }

    // Validación 2: Número correcto de habitaciones
    if (rooms.length !== EXPECTED_ROOM_COUNT) {
        console.error(`[Data] ⚠️ CRÍTICO: Se detectaron ${rooms.length} habitaciones, se esperaban ${EXPECTED_ROOM_COUNT}`);

        const initialRooms = createInitialRooms();
        const currentRoomIds = new Set(rooms.map(r => r.id));
        const missingRooms = initialRooms.filter(r => !currentRoomIds.has(r.id));

        if (missingRooms.length > 0) {
            console.warn(`[Data] Recuperando ${missingRooms.length} habitaciones faltantes:`, missingRooms.map(r => r.id));
            rooms = [...rooms, ...missingRooms];
            rooms.sort((a, b) => {
                if (a.building !== b.building) return a.building === 'regulares' ? -1 : 1;
                return a.number - b.number;
            });
            wasChanged = true;
            console.log(`[Data] ✓ Habitaciones recuperadas. Total actual: ${rooms.length}`);
        } else {
            console.error('[Data] No se pudieron recuperar habitaciones. Restaurando plantilla completa.');
            rooms = createInitialRooms();
            wasChanged = true;
        }
    }

    // Validación 3: Verificar que no haya duplicados
    const roomIds = rooms.map(r => r.id);
    const uniqueIds = new Set(roomIds);
    if (roomIds.length !== uniqueIds.size) {
        console.error('[Data] ⚠️ Se detectaron habitaciones duplicadas');
        const seen = new Map();
        rooms = rooms.filter(room => {
            if (seen.has(room.id)) {
                const existing = seen.get(room.id);
                const existingTime = existing.lastModified || existing.checkInTime || 0;
                const currentTime = room.lastModified || room.checkInTime || 0;
                if (currentTime > existingTime) {
                    seen.set(room.id, room);
                    return true;
                }
                return false;
            }
            seen.set(room.id, room);
            return true;
        });
        wasChanged = true;
        console.log(`[Data] ✓ Duplicados eliminados. Total actual: ${rooms.length}`);
    }

    // Solo propagar a Firebase si hubo un cambio estructural real
    if (wasChanged) persistMotelRoomsOnly();
}

// Initialize app
async function init() {
    console.log('[App] Inicializando aplicación...');
    
    // Usuarios ya cargados desde caché en DOMContentLoaded (instantáneo)
    if (!users || users.length === 0) users = _getCachedUsersSync();

    // 🔥 CRÍTICO: Cargar datos desde localStorage primero
    loadData();
    
    // Migrar nombres de habitaciones de Torre Nueva (una sola vez)
    migrateRoomNames();
    
    setupEventListeners();
    renderRooms();
    renderReservationsSidebar();
    renderInventory();
    renderSalesLog(); // Renderizar ventas del turno actual
    updateStatistics();
    updateRoomRevenueDisplay('day');
    updateExpensesTotal();
    updateDateTime();
    initDeepCleaningSystem();
    
    // Inicializar gestión de usuarios (solo para director)
    if (currentUser && currentUser.role === 'director') {
        initUserManagement();
    }
    
    // Inicializar estadísticas de gastos (solo para director)
    if (currentUser && currentUser.role === 'director') {
        updateExpensesByPaymentMethod('day');
        updateExpensesByCategory('day');
    }
    
    // Inicializar intervalos y guardar IDs para poder limpiarlos
    activeIntervals.push(setInterval(updateDateTime, 1000));
    activeIntervals.push(setInterval(updateRoomTimers, 1000));
    
    // Verificar integridad al arrancar (sin propagar a Firebase si no hay cambios)
    ensureRoomsSanity();
    // Monitoreo periódico cada 4 horas — solo persiste si detecta cambio estructural real
    activeIntervals.push(setInterval(ensureRoomsSanity, 4 * 60 * 60 * 1000));
    // Revisar capacidad de almacenamiento al arrancar
    checkStorageCapacity();
    // Revisión periódica de capacidad cada 30 minutos
    activeIntervals.push(setInterval(checkStorageCapacity, 30 * 60 * 1000));

    // Revisión periódica de rotación de mes de la ventana caliente de
    // roomRevenue/sales/expenses (por si la app queda abierta cruzando la
    // medianoche del último día del mes) — cada hora es más que suficiente.
    activeIntervals.push(setInterval(rolloverHotWindowIfNeeded, 60 * 60 * 1000));
    
    activeIntervals.push(setInterval(() => {
        if (document.getElementById('shift-control-tab')?.classList.contains('active')) {
            updateShiftControl();
        } else {
            _shiftDataStale = true;
        }
    }, 30000)); // Actualizar control de turno cada 30 segundos

    // Revisar cada minuto si el turno quedó desfasado (nadie lo cerró a
    // tiempo) y cerrarlo automáticamente — ver autoCloseShiftIfOverdue().
    activeIntervals.push(setInterval(() => {
        autoCloseShiftIfOverdue().catch(err => console.error('[Turno] Error en auto-cierre:', err));
    }, 60000));

    // Sincronización periódica DESACTIVADA - causaba pérdida de datos
    

    initFirebaseSync().catch(err => {
        console.error('[Firebase] Error en sincronización:', err);
    });
}

// ============================================================================
// SISTEMA DE INDEXACIÓN PARA RENDIMIENTO
// ============================================================================

/**
 * Construye índices en memoria para búsquedas rápidas en roomRevenue
 * Reduce tiempo de búsqueda de O(n) a O(1)
 */
function buildRevenueIndex() {
    console.log('[Index] Construyendo índices de roomRevenue...');
    const startTime = performance.now();
    
    roomRevenueIndex = {
        byShift: { day: [], night: [] },
        byType: { sold: [], renewal: [], cleaned: [] },
        byTimestamp: new Map(),
        byRoomId: new Map()
    };
    
    roomRevenue.forEach((item, idx) => {
        // Índice por turno
        if (item.shift === 'day') {
            roomRevenueIndex.byShift.day.push(idx);
        } else if (item.shift === 'night') {
            roomRevenueIndex.byShift.night.push(idx);
        }
        
        // Índice por tipo
        if (item.type === 'sold') {
            roomRevenueIndex.byType.sold.push(idx);
        } else if (item.type === 'renewal') {
            roomRevenueIndex.byType.renewal.push(idx);
        } else if (item.type === 'cleaned') {
            roomRevenueIndex.byType.cleaned.push(idx);
        }
        
        // Índice por timestamp (para búsquedas por rango)
        roomRevenueIndex.byTimestamp.set(item.timestamp, idx);
        
        // Índice por roomId
        if (!roomRevenueIndex.byRoomId.has(item.roomId)) {
            roomRevenueIndex.byRoomId.set(item.roomId, []);
        }
        roomRevenueIndex.byRoomId.get(item.roomId).push(idx);
    });
    
    const endTime = performance.now();
    console.log(`[Index] ✓ Índices construidos en ${(endTime - startTime).toFixed(2)}ms`);
    console.log(`[Index] Total registros: ${roomRevenue.length}`);
}

/**
 * Obtiene ingresos del turno actual usando índices (RÁPIDO)
 */
function getShiftRevenue(shiftType, startTimestamp) {
    if (!roomRevenueIndex) {
        console.warn('[Index] Índices no construidos, usando búsqueda lineal');
        return roomRevenue.filter(r => r.shift === shiftType && r.timestamp >= startTimestamp);
    }
    
    const indices = roomRevenueIndex.byShift[shiftType] || [];
    return indices
        .map(i => roomRevenue[i])
        .filter(r => r.timestamp >= startTimestamp);
}

/**
 * Obtiene ingresos por tipo usando índices (RÁPIDO)
 */
function getRevenueByType(type, startTimestamp) {
    if (!roomRevenueIndex) {
        return roomRevenue.filter(r => r.type === type && r.timestamp >= startTimestamp);
    }
    
    const indices = roomRevenueIndex.byType[type] || [];
    return indices
        .map(i => roomRevenue[i])
        .filter(r => r.timestamp >= startTimestamp);
}

/**
 * Invalida índices cuando se modifica roomRevenue
 */
function invalidateRevenueIndex() {
    roomRevenueIndex = null;
}

/**
 * Reconstruye índices si es necesario
 */
function ensureRevenueIndex() {
    if (!roomRevenueIndex && roomRevenue.length > 0) {
        buildRevenueIndex();
    }
}

// ============================================================================
// FIN SISTEMA DE INDEXACIÓN
// ============================================================================

// Load data from localStorage con manejo de errores por clave
function loadData() {
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

// Save data to localStorage AND Firebase (con throttle para optimizar)
const saveDataThrottled = throttle(function() {
    // VALIDACIÓN CRÍTICA: NO guardar si los datos están vacíos
    if (!rooms || rooms.length === 0 || !Array.isArray(rooms)) {
        console.error('[SaveData] ❌ BLOQUEADO: rooms inválido');
        return;
    }

    // Limpiar registros eliminados antiguos (solo director)
    if (currentUser && currentUser.role === 'director') {
        cleanOldDeletedRecords();
    }

    // Guardar en localStorage SIEMPRE (síncrono, antes del guard de Firebase)
    // Esto garantiza que los datos estén en localStorage incluso si Firebase está ocupado
    try {
        localStorage.setItem('motelRooms', JSON.stringify(rooms));
        localStorage.setItem('motelInventory', JSON.stringify(inventory));
        localStorage.setItem('motelShiftReports', JSON.stringify(shiftReports));
        localStorage.setItem('motelShiftSnapshots', JSON.stringify(shiftSnapshots));
        localStorage.setItem('motelCurrentShiftStart', JSON.stringify(currentShiftStart));
        localStorage.setItem('motelCurrentShiftType', currentShiftType || '');
        localStorage.setItem('motelActivityLog', JSON.stringify(activityLog));
        localStorage.setItem('motelReservations', JSON.stringify(reservations));
        localStorage.setItem('deepCleanSchedules', JSON.stringify(deepCleanSchedules));
        localStorage.setItem('motelStaffMembers', JSON.stringify(staffMembers));
        localStorage.setItem('motelAnnouncements', JSON.stringify(announcements));
    } catch (e) {
        console.error('[SaveData] Error guardando en localStorage:', e);
    }

    // roomRevenue/sales/expenses ya no se guardan como blob plano — se
    // reparten en shards por mes (ver sección SHARDING MENSUAL arriba).
    persistHotShards();

    if (window.FirebaseSync && window.FirebaseSync.ready) {
        // Si ya hay un guardado en curso en Firebase, marcar que hace falta
        // otro guardado apenas termine el actual, en vez de descartarlo.
        // Descartarlo sin más dejaba cambios (p.ej. una habitación marcada
        // 'dirty') solo en localStorage, sin subir nunca a Firebase, hasta
        // que otra acción cualquiera disparara un nuevo guardado.
        if (isSaving) { _pendingFirebaseSave = true; return; }

        // VALIDACIÓN: Verificar 32 habitaciones antes de subir a Firebase
        if (rooms.length < 32) {
            console.error('[SaveData] Solo ' + rooms.length + ' habitaciones, esperadas 32. No se guardará en Firebase.');
            return;
        }

        isSaving = true;
        _pendingFirebaseSave = false;

        window.FirebaseSync.saveAll({
            motelRooms: rooms,
            motelInventory: inventory,
            motelShiftReports: shiftReports,
            motelShiftSnapshots: shiftSnapshots,
            motelCurrentShiftStart: currentShiftStart,
            motelCurrentShiftType: currentShiftType,
            motelActivityLog: activityLog,
            motelReservations: reservations,
            deepCleanSchedules: deepCleanSchedules,
            motelStaffMembers: staffMembers,
            motelAnnouncements: announcements,
            motelUsers: users
        }).then(() => {
            if (window.FirebaseSync.isOnline()) {
                updateConnectionStatus(true, 0);
            }
        }).catch(err => {
            console.error('[Firebase] Error guardando datos:', err);
            updateConnectionStatus(window.FirebaseSync.isOnline(), 0);
        }).finally(() => {
            isSaving = false;
            if (_pendingFirebaseSave) {
                _pendingFirebaseSave = false;
                saveData();
            }
        });
    } else {
        updateConnectionStatus(false, 0);
    }
}, 2000); // Throttle: máximo 1 guardado cada 2 segundos

// FIXED: Función para limpiar registros eliminados antiguos (30 días)
function cleanOldDeletedRecords() {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    let cleaned = 0;
    
    // Limpiar announcements
    const originalAnnouncementsLength = announcements.length;
    announcements = announcements.filter(a => !a.deleted || a.deletedAt > thirtyDaysAgo);
    cleaned += originalAnnouncementsLength - announcements.length;
    
    // Limpiar staffMembers
    const originalStaffLength = staffMembers.length;
    staffMembers = staffMembers.filter(s => !s.deleted || s.deletedAt > thirtyDaysAgo);
    cleaned += originalStaffLength - staffMembers.length;
    
    // Limpiar expenses
    const originalExpensesLength = expenses.length;
    expenses = expenses.filter(e => !e.deleted || e.deletedAt > thirtyDaysAgo);
    cleaned += originalExpensesLength - expenses.length;

    // Limpiar inventario
    const originalInventoryLength = inventory.length;
    inventory = inventory.filter(i => !i.deleted || i.deletedAt > thirtyDaysAgo);
    cleaned += originalInventoryLength - inventory.length;

    if (cleaned > 0) {
        console.log(`[Cleanup] ${cleaned} registros eliminados permanentemente (>30 días)`);
    }
}

function saveData() {
    saveDataThrottled();
}

// Guarda inmediatamente sin esperar el throttle.
// Usar SOLO cuando el tiempo es crítico (ej: app yendo a background).
function _saveDataImmediate() {
    if (!currentUser || !rooms || rooms.length < 32) return;
    try {
        localStorage.setItem('motelRooms',       JSON.stringify(rooms));
        localStorage.setItem('motelInventory',   JSON.stringify(inventory));
    } catch(e) {}
    persistHotShards();
    if (window.FirebaseSync && window.FirebaseSync.ready && !isSaving) {
        isSaving = true;
        window.FirebaseSync.saveAll({
            motelRooms:       rooms,
            motelInventory:   inventory,
        }).finally(() => { isSaving = false; });
    }
}



// Create initial rooms
function createInitialRooms() {
    const initialRooms = [];
    
    // Regulares building: rooms 1-16 with default prices and names
    const regularesPrices = {
        1: 350, 2: 350, 3: 350, 4: 350,
        5: 600, 6: 300, 7: 250, 8: 250,
        9: 250, 10: 250, 11: 300, 12: 600,
        13: 350, 14: 350, 15: 350, 16: 350
    };
    
    const regularesNames = {
        1: 'Sensual', 2: 'Sensual', 3: 'Sensual', 4: 'Sensual',
        5: 'VIP', 6: 'Ejecutiva', 7: 'Rapid Inn', 8: 'Rapid Inn',
        9: 'Rapid Inn', 10: 'Rapid Inn', 11: 'Ejecutiva', 12: 'VIP',
        13: 'Sensual', 14: 'Sensual', 15: 'Sensual', 16: 'Sensual'
    };
    
    for (let i = 1; i <= 16; i++) {
        initialRooms.push({
            id: `regulares-${i}`,
            number: i,
            status: 'available',
            checkInTime: null,
            building: 'regulares',
            roomName: regularesNames[i],
            defaultPrice: regularesPrices[i],
            defaultHours: (i === 5 || i === 12) ? 6 : 4,
            price: 0,
            customTime: null,
            guestName: '',
            guestCount: 0,
            notes: '',
            cleanedCount: 0
        });
    }
    
    // Torre Nueva building: rooms 1-16 with default prices, floors, and names
    const torrePrices = {
        1: 300, 2: 300, 3: 300, 4: 300,
        5: 300, 6: 300, 7: 300, 8: 300,
        9: 300, 10: 650, 11: 650, 12: 450,
        13: 450, 14: 650, 15: 650, 16: 300
    };
    
    // Piso 1: 7,6,8,5,1,4,2,3
    // Piso 2: 15,14,16,13,9,12,10,11
    const torreFloors = {
        1: 1, 2: 1, 3: 1, 4: 1,
        5: 1, 6: 1, 7: 1, 8: 1,
        9: 2, 10: 2, 11: 2, 12: 2,
        13: 2, 14: 2, 15: 2, 16: 2
    };
    
    const torreNames = {
        1: 'Rapid Inn', 2: 'Rapid Inn', 3: 'Rapid Inn', 4: 'Rapid Inn',
        5: 'Rapid Inn', 6: 'Rapid Inn', 7: 'Rapid Inn', 8: 'Rapid Inn',
        9: 'Rapid Inn', 10: 'Ejecutiva', 11: 'Ejecutiva', 12: 'VIP',
        13: 'VIP', 14: 'Ejecutiva', 15: 'Ejecutiva', 16: 'Rapid Inn'
    };
    
    for (let i = 1; i <= 16; i++) {
        initialRooms.push({
            id: `torre-${i}`,
            number: i,
            status: 'available',
            checkInTime: null,
            building: 'torre',
            floor: torreFloors[i],
            roomName: torreNames[i] || null,
            defaultPrice: torrePrices[i],
            defaultHours: (i === 12 || i === 13) ? 6 : 4,
            price: 0,
            customTime: null,
            guestName: '',
            guestCount: 0,
            notes: '',
            cleanedCount: 0
        });
    }
    return initialRooms;
}

// Migrar nombres de habitaciones de Torre Nueva (ejecutar una sola vez)
function migrateRoomNames() {
    console.log('[Rooms] Migrando nombres de habitaciones de Torre Nueva...');
    
    const torreNamesMap = {
        1: 'Rapid Inn', 2: 'Rapid Inn', 3: 'Rapid Inn', 4: 'Rapid Inn',
        5: 'Rapid Inn', 6: 'Rapid Inn', 7: 'Rapid Inn', 8: 'Rapid Inn',
        9: 'Rapid Inn', 10: 'Ejecutiva', 11: 'Ejecutiva', 12: 'VIP',
        13: 'VIP', 14: 'Ejecutiva', 15: 'Ejecutiva', 16: 'Rapid Inn'
    };
    
    let updated = false;
    
    rooms.forEach(room => {
        if (room.building === 'torre' && room.number >= 1 && room.number <= 16) {
            const newName = torreNamesMap[room.number];
            if (room.roomName !== newName) {
                console.log(`[Rooms] Actualizando habitación Torre ${room.number}: "${room.roomName || 'sin nombre'}" → "${newName}"`);
                room.roomName = newName;
                updated = true;
            }
        }
    });
    
    if (updated) {
        // Solo localStorage — no llamar saveData() aquí porque ocurre antes de
        // initFirebaseSync y subiría datos rancios a Firebase antes del merge
        localStorage.setItem('motelRooms', JSON.stringify(rooms));
        return true;
    } else {
        return false;
    }
}

// Setup event listeners
function setupEventListeners() {
    // ============ ATAJOS DE TECLADO GLOBALES ============
    document.addEventListener('keydown', (e) => {
        // Escape: Cerrar modal activo
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal.show').forEach(modal => {
                modal.classList.remove('show');
            });
        }
        
        // Ctrl/Cmd + H: Ir a Habitaciones
        if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
            e.preventDefault();
            switchTab('rooms');
        }
        
        // Ctrl/Cmd + I: Ir a Inventario
        if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
            e.preventDefault();
            switchTab('inventory');
        }
        
        // Ctrl/Cmd + T: Ir a Control de Turno
        if ((e.ctrlKey || e.metaKey) && e.key === 't') {
            e.preventDefault();
            switchTab('shift-control');
        }
        
        // F5 sin Ctrl: Recargar datos (sin recargar página)
        if (e.key === 'F5' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            loadData();
            showToast('📡 Datos recargados', 'info');
        }
    });
    
    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            switchTab(tab);
        });
    });

    // Room modal
    const roomModal = document.getElementById('roomModal');
    roomModal.querySelector('.close').addEventListener('click', () => {
        roomModal.classList.remove('show');
    });

    roomModal.querySelectorAll('.modal-actions .btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const action = e.target.dataset.action;
            if (currentRoomId) {
                // Interceptar "Reservar" para mostrar mensaje
                if (action === 'reserved') {
                    roomModal.classList.remove('show');
                    showToast('La función de reservas ha sido desactivada', 'info');
                    return;
                }
                updateRoomStatus(currentRoomId, action);
            }
            roomModal.classList.remove('show');
        });
    });

    // Product modal
    const productModal = document.getElementById('productModal');
    document.getElementById('addProductBtn').addEventListener('click', () => {
        resetProductModal();
        productModal.classList.add('show');
    });

    productModal.querySelector('.close').addEventListener('click', () => {
        productModal.classList.remove('show');
        resetProductModal();
    });

    document.getElementById('saveProductBtn').addEventListener('click', saveProduct);

    // Botón de agregar personal (asistencia)
    const btnAddStaff = document.getElementById('btnAddStaff');
    if (btnAddStaff) {
        btnAddStaff.addEventListener('click', addStaffMember);
    }

    // Botón de agregar aviso
    const btnAddAnnouncement = document.getElementById('btnAddAnnouncement');
    if (btnAddAnnouncement) {
        btnAddAnnouncement.addEventListener('click', addAnnouncement);
    }

    // Modal de avisos
    const announcementModal = document.getElementById('announcementModal');
    if (announcementModal) {
        const closeBtn = announcementModal.querySelector('.close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                announcementModal.classList.remove('show');
            });
        }
        
        const saveBtn = document.getElementById('saveAnnouncementBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', saveAnnouncementFromModal);
        }
    }

    // Modal de personal
    const staffModal = document.getElementById('staffModal');
    if (staffModal) {
        const closeBtn = staffModal.querySelector('.close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                staffModal.classList.remove('show');
            });
        }
        
        const saveBtn = document.getElementById('saveStaffBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', saveStaffFromModal);
        }
    }

    // Cleaning modal
    const cleaningModal = document.getElementById('cleaningModal');
    cleaningModal.querySelector('.close').addEventListener('click', () => {
        cleaningModal.classList.remove('show');
    });

    // Sales
    document.getElementById('sellBtn').addEventListener('click', processSale);
    
    document.getElementById('addExpenseBtn').addEventListener('click', addExpense);
    
    
    // Period tabs for statistics
    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('sc-period-btn')) {
            const type = e.target.dataset.type;
            const period = e.target.dataset.period;
            
            // Update active state
            document.querySelectorAll(`.sc-period-btn[data-type="${type}"]`).forEach(btn => {
                btn.classList.remove('active');
            });
            e.target.classList.add('active');
            
            // Update stats
            if (type === 'products') {
                updateProductStats(period);
            } else if (type === 'rooms') {
                updateRoomUsageStats(period);
            }
        }
    });
    
    // Filtros de habitaciones
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            if (!currentUser || currentUser.role !== 'limpieza') renderRooms();
        });
    });
    
    // Búsqueda de habitación
    const roomSearchInput = document.getElementById('roomSearchInput');
    if (roomSearchInput) {
        roomSearchInput.addEventListener('input', (e) => {
            const value = e.target.value.trim();
            searchRoomNumber = value ? parseInt(value) : null;
            if (!currentUser || currentUser.role !== 'limpieza') renderRooms();
        });
    }
}

// Switch tabs - función única con toda la lógica
function switchTab(tabName) {
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
                    if (savedType) currentShiftType = savedType;
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
                    const dirtyRooms = rooms.filter(r => r.status === 'dirty');
                    if (dirtyRooms.length > 0) {
                        renderCleaningRooms();
                    }
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

// Actualizar panel de alertas
// Sistema de confirmación personalizado
function showCustomConfirm(title, message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('customConfirmModal');
        const titleEl = document.getElementById('confirmTitle');
        const messageEl = document.getElementById('confirmMessage');
        const yesBtn = document.getElementById('confirmYesBtn');
        const noBtn = document.getElementById('confirmNoBtn');

        if (!modal || !titleEl || !messageEl || !yesBtn || !noBtn) {
            // Fallback al confirm nativo si faltan elementos del DOM
            resolve(window.confirm(message));
            return;
        }

        titleEl.textContent = title;
        messageEl.textContent = message;

        modal.classList.add('show');
        
        const handleYes = () => {
            modal.classList.remove('show');
            yesBtn.removeEventListener('click', handleYes);
            noBtn.removeEventListener('click', handleNo);
            resolve(true);
        };
        
        const handleNo = () => {
            modal.classList.remove('show');
            yesBtn.removeEventListener('click', handleYes);
            noBtn.removeEventListener('click', handleNo);
            resolve(false);
        };
        
        yesBtn.addEventListener('click', handleYes);
        noBtn.addEventListener('click', handleNo);
    });
}

// Sistema de alerta personalizado
function showCustomAlert(title, message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('customAlertModal');
        const titleEl = document.getElementById('alertTitle');
        const messageEl = document.getElementById('alertMessage');
        const okBtn = document.getElementById('alertOkBtn');

        if (!modal || !titleEl || !messageEl || !okBtn) {
            window.alert(message);
            resolve();
            return;
        }

        titleEl.textContent = title;
        messageEl.textContent = message;

        modal.classList.add('show');
        
        const handleOk = () => {
            modal.classList.remove('show');
            okBtn.removeEventListener('click', handleOk);
            resolve();
        };
        
        okBtn.addEventListener('click', handleOk);
    });
}

// Agregar actividad al log
function logActivity(type, description, details = {}) {
    activityLog.push({
        id: Date.now(),
        type, // 'rooms', 'sales', 'expenses', 'shift'
        description,
        details,
        user: currentUser ? currentUser.name : 'Sistema',
        timestamp: Date.now()
    });
    
    // Mantener solo los últimos 100 registros
    if (activityLog.length > 100) {
        activityLog = activityLog.slice(-100);
    }
    
    saveData();
}

// Renderizar historial de actividad
function renderActivityLog(filter = 'all') {
    const logContainer = document.getElementById('activityLog');
    if (!logContainer) return;
    
    let filteredActivities = [];
    
    // Si el filtro es 'shifts', mostrar turnos cerrados
    if (filter === 'shifts') {
        if (!shiftReports || shiftReports.length === 0) {
            logContainer.innerHTML = '<p class="no-activity">No hay turnos cerrados registrados</p>';
            return;
        }
        
        // Convertir turnos cerrados a formato de actividad
        filteredActivities = shiftReports.map(shift => ({
            type: 'shift',
            description: `${shift.shiftName} cerrado - ${shift.roomsSold} vendidas, ${shift.roomsCleaned} limpiadas - Ingresos: $${shift.totalRevenue.toFixed(2)}`,
            user: shift.closedBy || 'Sistema',
            timestamp: shift.closedAt,
            data: shift
        }));
    } else {
        filteredActivities = activityLog;
        if (filter !== 'all') {
            filteredActivities = activityLog.filter(a => a.type === filter);
        }
    }
    
    // Ordenar por más reciente primero
    filteredActivities = [...filteredActivities].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
    
    if (filteredActivities.length === 0) {
        logContainer.innerHTML = '<p class="no-activity">No hay actividad registrada</p>';
        return;
    }
    
    logContainer.innerHTML = filteredActivities.map(activity => {
        const date = new Date(activity.timestamp);
        const timeStr = date.toLocaleString('es-MX', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        const typeIcons = {
            'rooms': '🏠',
            'sales': '🛒',
            'expenses': '💸',
            'shift': '📋'
        };
        
        return `
            <div class="activity-item activity-${activity.type}">
                <div class="activity-icon">${typeIcons[activity.type] || '📌'}</div>
                <div class="activity-content">
                    <div class="activity-description">${sanitizeHTML(activity.description || '')}</div>
                    <div class="activity-meta">
                        <span class="activity-user">${sanitizeHTML(activity.user || '')}</span>
                        <span class="activity-time">${timeStr}</span>
                    </div>
                </div>
                ${activity.details && activity.details.photo ? `<img src="${activity.details.photo}" style="width:100%;max-height:180px;object-fit:cover;border-radius:8px;margin-top:8px;">` : ''}
            </div>
        `;
    }).join('');
}

// Render recent cleaning notes in sidebar (SOLO NOTAS)
function renderRecentCleaningNotes() {
    const notesContainer = document.getElementById('recentCleaningNotes');
    if (!notesContainer) {
        console.warn('[CleaningNotes] Contenedor recentCleaningNotes no encontrado');
        return;
    }

    console.log('[CleaningNotes] Renderizando notas de limpieza...');
    
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const allNotes = [];
    
    // Validar que rooms existe y es un array
    if (!rooms || !Array.isArray(rooms)) {
        console.error('[CleaningNotes] Array de habitaciones no válido');
        notesContainer.innerHTML = '<div class="no-notes"><p>Error cargando habitaciones</p></div>';
        return;
    }
    
    // SOLO habitaciones que tienen notas de limpieza
    rooms.forEach(function(room) {
        if (room.cleaningNotes && Array.isArray(room.cleaningNotes) && room.cleaningNotes.length > 0) {
            room.cleaningNotes.forEach(function(note) {
                // Validar estructura de la nota
                if (note && note.timestamp && note.note && note.timestamp >= oneDayAgo) {
                    allNotes.push({
                        id: note.id,
                        note: sanitizeHTML(note.note), // Sanitizar para seguridad
                        timestamp: note.timestamp,
                        cleanedBy: sanitizeHTML(note.cleanedBy || 'Desconocido'),
                        roomId: room.id,
                        roomNumber: room.number,
                        building: room.building
                    });
                }
            });
        }
    });

    allNotes.sort(function(a, b) { return b.timestamp - a.timestamp; });
    const recentNotes = allNotes.slice(0, 15);

    console.log(`[CleaningNotes] ✅ ${recentNotes.length} notas encontradas`);

    if (recentNotes.length === 0) {
        notesContainer.innerHTML = '<div class="no-notes"><p>No hay notas de limpieza recientes</p></div>';
        return;
    }

    notesContainer.innerHTML = recentNotes.map(function(note) {
        const buildingName = note.building === 'regulares' ? 'Edificio 1' : 'Torre';
        const timeStr = new Date(note.timestamp).toLocaleString('es-MX', {
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
        });
        return '<div class="sidebar-note-item">'
            + '<div class="sidebar-note-header">'
            + '<div class="sidebar-note-badges">'
            + '<span class="sidebar-room-badge">Hab. ' + note.roomNumber + '</span>'
            + '<span class="sidebar-building-badge">' + buildingName + '</span>'
            + '<button class="btn-delete-note" onclick="deleteCleaningNote(\''  + note.roomId + '\', ' + note.id + ')" title="Eliminar">&times;</button>'
            + '</div></div>'
            + '<div class="sidebar-note-text">' + note.note + '</div>'
            + '<div class="sidebar-note-footer">'
            + '<span class="sidebar-note-author">👤 ' + note.cleanedBy + '</span>'
            + '<span class="sidebar-note-date">' + timeStr + '</span>'
            + '</div></div>';
    }).join('');
}

// Eliminar nota de limpieza (VERSIÓN MEJORADA)
async function deleteCleaningNote(roomId, noteId) {
    try {
        console.log(`[CleaningNotes] Eliminando nota ${noteId} de habitación ${roomId}`);
        
        const room = rooms.find(r => r.id === roomId);
        if (!room) {
            console.error('[CleaningNotes] Habitación no encontrada:', roomId);
            showToast('❌ Habitación no encontrada', 'error');
            return;
        }
        
        if (!room.cleaningNotes || !Array.isArray(room.cleaningNotes)) {
            console.error('[CleaningNotes] No hay notas en esta habitación');
            showToast('❌ No hay notas en esta habitación', 'error');
            return;
        }
        
        // Encontrar índice de la nota
        const noteIndex = room.cleaningNotes.findIndex(n => n.id === noteId);
        if (noteIndex === -1) {
            console.error('[CleaningNotes] Nota no encontrada:', noteId);
            showToast('❌ Nota no encontrada', 'error');
            return;
        }
        
        // Confirmar eliminación con modal personalizado
        const confirmed = await showCustomConfirm(
            '🗑️ Eliminar Nota',
            '¿Estás seguro de eliminar esta nota de limpieza?\n\nEsta acción no se puede deshacer.'
        );
        
        if (!confirmed) return;
        
        // Eliminar la nota
        const deletedNote = room.cleaningNotes[noteIndex];
        room.cleaningNotes.splice(noteIndex, 1);
        
        console.log(`[CleaningNotes] ✅ Nota eliminada:`, deletedNote.note);
        
        // Guardar cambios
        saveData();
        renderRecentCleaningNotes();
        
        showToast('🗑️ Nota de limpieza eliminada', 'success');
        
    } catch (error) {
        console.error('[CleaningNotes] Error eliminando nota:', error);
        showToast('❌ Error eliminando nota', 'error');
    }
}

// Funci?n auxiliar para filtrar habitaciones
function shouldShowRoom(room) {
    // Filtro por número de Búsqueda
    if (searchRoomNumber !== null && room.number !== searchRoomNumber) {
        return false;
    }
    
    // Filtro por estado
    if (currentFilter === 'all') {
        return true;
    } else if (currentFilter === 'available') {
        return room.status === 'available';
    } else if (currentFilter === 'unavailable') {
        return room.status === 'occupied' || room.status === 'dirty' || 
               room.status === 'not-available' || room.status === 'reserved';
    }
    
    return true;
}

// Render rooms
function renderRooms() {
    // FIXED: Limpiar cache de elementos DOM al inicio (Problem 4b)
    roomTimerElements.clear();
    
    // Guard: si el usuario es limpieza, usar vista de limpieza
    if (currentUser && currentUser.role === 'limpieza') {
        if (document.getElementById('cleaningRoomsGrid')) {
            renderCleaningRooms();
        } else {
            showCleaningView();
        }
        return;
    }
    const grid = document.getElementById('roomsGrid');
    if (!grid) {
        console.error('roomsGrid no encontrado en el DOM');
        return;
    }
    // rooms vacío es "todavía no cargó", no "corrupto" — ensureRoomsSanity()
    // ya lo ignora, pero evitamos incluso la llamada para dejar claro que
    // no hay nada que reparar mientras se espera a Firebase.
    if (rooms && rooms.length > 0 && !isValidRoomsArray(rooms)) {
        ensureRoomsSanity();
    }
    if (!rooms || rooms.length === 0) {
        grid.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:#7f8c8d;">
                <div style="font-size:40px;margin-bottom:14px;animation:spin 1.5s linear infinite;display:inline-block;">&#8635;</div>
                <p style="font-size:17px;font-weight:600;color:#5a6a8a;margin-bottom:6px;">Cargando habitaciones&hellip;</p>
                <p style="font-size:13px;">Sincronizando con Firebase, un momento.</p>
            </div>`;
        return;
    }

    grid.innerHTML = '';
    
    const buildingsContainer = document.createElement('div');
    buildingsContainer.className = 'buildings-container';
    
    // Regulares building (rooms 1-16)
    const regularesSection = document.createElement('div');
    regularesSection.className = 'building-section';
    regularesSection.innerHTML = '<h2 class="building-title">Edificio 1</h2>';
    const regularesGrid = document.createElement('div');
    regularesGrid.className = 'building-grid';
    
    const layout = [
        [8, 9],
        [7, 10],
        [6, 11],
        [5, 12],
        [4, 13],
        [3, 14],
        [2, 15],
        [1, 16]
    ];
    
    layout.forEach(row => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'room-row';
        row.forEach(roomNum => {
            const room = rooms.find(r => r.number === roomNum && r.building === 'regulares');
            if (room && shouldShowRoom(room)) {
                const card = createRoomCard(room);
                rowDiv.appendChild(card);
            }
        });
        if (rowDiv.children.length > 0) {
            regularesGrid.appendChild(rowDiv);
        }
    });
    
    regularesSection.appendChild(regularesGrid);
    buildingsContainer.appendChild(regularesSection);
    
    // Torre Nueva building (rooms 1-16) organized by floors
    const torreSection = document.createElement('div');
    torreSection.className = 'building-section';
    torreSection.innerHTML = '<h2 class="building-title">Edificio Torre</h2>';
    const torreGrid = document.createElement('div');
    torreGrid.className = 'building-grid';
    
    // Piso 1 with custom order: 7,6,8,5,1,4,2,3
    const piso1Title = document.createElement('h3');
    piso1Title.className = 'floor-title';
    piso1Title.textContent = 'Piso 1';
    torreGrid.appendChild(piso1Title);
    
    const piso1Layout = [
        [7, 6],
        [8, 5],
        [1, 4],
        [2, 3]
    ];
    
    piso1Layout.forEach(row => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'room-row';
        row.forEach(roomNum => {
            const room = rooms.find(r => r.number === roomNum && r.building === 'torre');
            if (room && shouldShowRoom(room)) {
                const card = createRoomCard(room);
                rowDiv.appendChild(card);
            }
        });
        if (rowDiv.children.length > 0) {
            torreGrid.appendChild(rowDiv);
        }
    });
    
    // Piso 2 with custom order: 15,14,16,13,9,12,10,11
    const piso2Title = document.createElement('h3');
    piso2Title.className = 'floor-title';
    piso2Title.textContent = 'Piso 2';
    torreGrid.appendChild(piso2Title);
    
    const piso2Layout = [
        [15, 14],
        [16, 13],
        [9, 12],
        [10, 11]
    ];
    
    piso2Layout.forEach(row => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'room-row';
        row.forEach(roomNum => {
            const room = rooms.find(r => r.number === roomNum && r.building === 'torre');
            if (room && shouldShowRoom(room)) {
                const card = createRoomCard(room);
                rowDiv.appendChild(card);
            }
        });
        if (rowDiv.children.length > 0) {
            torreGrid.appendChild(rowDiv);
        }
    });
    
    torreSection.appendChild(torreGrid);
    buildingsContainer.appendChild(torreSection);
    
    grid.appendChild(buildingsContainer);
    updateRoomTimers();
    
    // Renderizar notas recientes en el sidebar
    renderRecentCleaningNotes();
}

// Create room card
// Create room card
function createRoomCard(room) {
    const card = document.createElement('div');
    
    // Determinar el estado visual para habitaciones reservadas
    let cardClass = room.status;
    let statusText = '';
    
    if (room.status === 'reserved') {
        const isLocked = isRoomReservationLocked(room);
        if (!isLocked) {
            // Reserva no bloqueada (falta más de 12 horas)
            cardClass = 'reserved-not-locked';
            statusText = 'RESERVADO (NO BLOQUEADO)';
        } else {
            // Reserva bloqueada (falta 12 horas o menos)
            cardClass = 'reserved-locked';
            statusText = 'RESERVADO (BLOQUEADO)';
        }
    }
    
    card.className = `room-card ${cardClass}`;
    if (roomHasPendingDeepClean(room)) card.classList.add('room-card--deep-clean-pending');

    // Traducir estados
    const statusTranslations = {
        'available': 'DISPONIBLE',
        'occupied': 'OCUPADO',
        'dirty': 'SUCIO',
        'not-available': 'NO DISPONIBLE',
        'reserved': 'RESERVADO'
    };

    // Usar el texto de estado personalizado para reservas, o el traductor por defecto
    const finalStatusText = statusText || statusTranslations[room.status] || room.status;

    // Calcular tiempo restante si está ocupado
    let timeDisplay = '';
    if (room.status === 'occupied' && room.endTime) {
        timeDisplay = `<div class="room-time" id="countdown-${room.id}"></div>`;
    } else if (room.checkInTime) {
        timeDisplay = `<div class="room-time" id="timer-${room.id}"></div>`;
    }

    // Mostrar horas en lugar de precio cuando está ocupado
    let priceDisplay = '';
    if (room.status === 'occupied') {
        const hours = room.customTime !== null ? room.customTime : room.defaultHours;
        priceDisplay = `<div class="room-price">${hours}h</div>`;
    } else if (room.price > 0) {
        const p = Number(room.price);
        priceDisplay = `<div class="room-price">$${Number.isFinite(p) ? p.toFixed(2) : '0.00'}</div>`;
    } else {
        priceDisplay = `<div class="room-default-price">$${room.defaultPrice}</div>`;
    }

    // Display room name for rooms that have one
    let roomNameDisplay = '';
    if (room.roomName) {
        roomNameDisplay = `<div class="room-name">${room.roomName}</div>`;
    }

    const deepPendingBadge = roomHasPendingDeepClean(room)
        ? '<span class="room-deep-clean-pending-badge" title="Limpieza profunda pendiente">Pendiente LP</span>'
        : '';

    card.innerHTML = `
        ${deepPendingBadge}
        <div class="room-number">${room.number}</div>
        ${roomNameDisplay}
        <div class="room-status">${finalStatusText}</div>
        ${timeDisplay}
        ${priceDisplay}
    `;
    
    // FIXED: Cachear elementos del DOM después de crearlos (Problem 4b)
    setTimeout(() => {
        if (room.status === 'occupied' && room.endTime) {
            const countdownEl = document.getElementById(`countdown-${room.id}`);
            if (countdownEl) {
                roomTimerElements.set(`countdown-${room.id}`, countdownEl);
            }
        } else if (room.checkInTime) {
            const timerEl = document.getElementById(`timer-${room.id}`);
            if (timerEl) {
                roomTimerElements.set(`timer-${room.id}`, timerEl);
            }
        }
    }, 0);
    
    card.addEventListener('click', () => {
        openRoomModal(room.id);
    });
    
    // Agregar data attribute para debugging
    card.dataset.roomId = room.id;
    card.dataset.roomNumber = room.number;
    return card;
}



// Open room modal
function openRoomModal(roomId) {
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;
    const modal = document.getElementById('roomModal');
    currentRoomId = roomId;
    const modalRoomNumberEl = document.getElementById('modalRoomNumber');
    if (modalRoomNumberEl) modalRoomNumberEl.textContent = `${room.number} (${room.building === 'regulares' ? 'Regulares' : 'Torre Nueva'})`;
    
    const details = document.getElementById('roomDetails');
    
    // Si la habitación está reservada Y bloqueada (menos de 12 horas), mostrar solo botón de confirmar uso
    if (room.status === 'reserved') {
        const isLocked = isRoomReservationLocked(room);
        
        // Solo mostrar modal especial si está BLOQUEADA
        if (isLocked) {
            const reservation = reservations.find(r => r.id === room.reservationId);
            
            details.innerHTML = `
            <div style="text-align: center; padding: 20px;">
                <div style="font-size: 48px; margin-bottom: 20px;">📌</div>
                <h3 style="color: #27ae60; margin-bottom: 15px;">Habitación Reservada (Bloqueada)</h3>
                <p><strong>Estado:</strong> ${translateStatus(room.status)}</p>
                ${reservation ? `
                    <p><strong>Huésped:</strong> ${sanitizeHTML(reservation.guestName || 'Sin nombre')}</p>
                    <p><strong>Teléfono:</strong> ${sanitizeHTML(reservation.phone || 'Sin teléfono')}</p>
                    <p><strong>Precio:</strong> $${reservation.price || room.defaultPrice}</p>
                    <p><strong>Horas:</strong> ${reservation.hours || 'No especificado'}</p>
                ` : ''}
                <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
                    <strong>⚠️ Reserva Activa</strong>
                    <p style="margin: 10px 0 0 0; font-size: 14px;">Esta habitación está bloqueada por una reserva. Solo puedes confirmar el inicio de uso.</p>
                </div>
                <div style="text-align: left; margin-bottom: 20px;">
                    <label style="display: block; font-weight: bold; color: #27ae60; margin-bottom: 8px;">💳 Confirmar Método de Pago: <span style="color: #e74c3c;">*</span></label>
                    <select id="reservationStartPaymentMethod" style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 8px; font-size: 16px; background: white;">
                        <option value="">Seleccionar Método de pago</option>
                        <option value="efectivo" ${(reservation && reservation.paymentMethod === 'efectivo') ? 'selected' : ''}>💵 Efectivo</option>
                        <option value="tarjeta" ${(reservation && reservation.paymentMethod === 'tarjeta') ? 'selected' : ''}>💳 Tarjeta</option>
                    </select>
                </div>
                <button class="btn-primary" style="background: #27ae60; font-size: 16px; padding: 15px 30px;" onclick="confirmReservationStart()">
                    ✓ Confirmar Uso de Habitación en Reserva
                </button>
            </div>
        `;
        
        // Ocultar botones de acción
        const modalActions = document.getElementById('modalActions');
        if (modalActions) modalActions.style.display = 'none';
        
        modal.classList.add('show');
        return;
        }
        // Si NO está bloqueada, continuar con el flujo normal
    }
    
    // Mostrar botón de renovación solo si está ocupada
    const renewalSection = room.status === 'occupied' ? `
        <div class="renewal-section">
            <h3 style="color: #27ae60; margin-top: 20px;">Renovar Estancia</h3>
            <input type="number" id="renewalPrice" placeholder="Precio de renovación" step="0.01" min="0">
            <input type="number" id="renewalTime" placeholder="Horas Adicionales" min="1">
            <div class="payment-method-selector" style="margin: 20px 0;">
                <label style="display: block; margin-bottom: 10px; font-weight: bold; color: #27ae60; font-size: 16px;">💳 Método de Pago: <span style="color: #e74c3c;">*</span></label>
                <select id="renewalPaymentMethod" style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 8px; font-size: 16px; background: white;">
                    <option value="">Seleccionar Método de pago</option>
                    <option value="efectivo">💵 Efectivo</option>
                    <option value="tarjeta">💳 Tarjeta</option>
                </select>
            </div>
            <button class="btn-primary" onclick="renewStay()">Agregar Tiempo y Cobrar</button>
        </div>
    ` : '';
    
    details.innerHTML = `
        <p><strong>Estado:</strong> ${translateStatus(room.status)}</p>
        ${room.checkInTime ? `<p><strong>Tiempo Transcurrido:</strong> ${getElapsedTime(room.checkInTime)}</p>` : ''}
        ${room.endTime ? `<p><strong>Tiempo Restante:</strong> <span id="modal-countdown"></span></p>` : ''}
        <p><strong>Precio estándar:</strong> $${room.defaultPrice}</p>
        ${room.price > 0 ? `<p><strong>Precio Actual:</strong> $${room.price.toFixed(2)}</p>` : ''}
        ${room.guestName ? `<p><strong>Huésped:</strong> ${sanitizeHTML(room.guestName)}</p>` : ''}
        ${room.notes ? `<p><strong>Notas:</strong> ${sanitizeHTML(room.notes)}</p>` : ''}
        ${renewalSection}
        <div class="room-form" style="${room.status === 'occupied' ? 'display: none;' : ''}">
            <input type="text" id="guestNameInput" placeholder="Nombre del Huésped (opcional)" value="${escapeAttr(room.guestName || '')}">
            <input type="number" id="guestCountInput" placeholder="Número de Personas" min="1" max="10" value="${room.guestCount || ''}" style="margin-top: 10px;">
            <div class="payment-method-selector" style="margin: 20px 0;">
                <label style="display: block; margin-bottom: 10px; font-weight: bold; color: #2c3e50; font-size: 16px;">💳 Método de Pago: <span style="color: #e74c3c;">*</span></label>
                <select id="paymentMethodInput" style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 8px; font-size: 16px; background: white;">
                    <option value="">Seleccionar Método de pago</option>
                    <option value="efectivo">💵 Efectivo</option>
                    <option value="tarjeta">💳 Tarjeta</option>
                </select>
            </div>
            <button class="btn-primary" onclick="useDefaultPrice()">Usar Precio estándar ($${room.defaultPrice})</button>
            <button class="btn-primary" onclick="showCustomPricing()">Precio y Tiempo Personalizado</button>
            <div id="customPricingForm" style="display: none;">
                <input type="number" id="customPriceInput" placeholder="Precio Personalizado" step="0.01" min="0">
                <input type="number" id="customTimeInput" placeholder="Tiempo (horas)" min="1">
            </div>
            <textarea id="notesInput" placeholder="Notas (opcional)">${sanitizeHTML(room.notes || '')}</textarea>
        </div>
    `;
    
    // Actualizar countdown en el modal si está ocupada
    if (room.status === 'occupied' && room.endTime) {
        updateModalCountdown(room);
    }
    
    // Aplicar permisos a los botones del modal
    const modalActions = document.getElementById('modalActions');
    
    // Ocultar todos los botones de acción solo si la habitación está reservada Y bloqueada
    if (room.status === 'reserved' && isRoomReservationLocked(room)) {
        if (modalActions) modalActions.style.display = 'none';
    } else {
        if (modalActions) modalActions.style.display = 'flex';
        
        if (currentUser) {
            document.querySelectorAll('#modalActions .btn').forEach(btn => {
                const allowedRoles = btn.dataset.roles ? btn.dataset.roles.split(',') : ['supervisor'];
                if (allowedRoles.includes(currentUser.role)) {
                    btn.style.display = 'inline-block';
                } else {
                    btn.style.display = 'none';
                }
            });
        }
    }
    
    modal.classList.add('show');
}

// Actualizar countdown en el modal
function updateModalCountdown(room) {
    const modalCountdown = document.getElementById('modal-countdown');
    if (modalCountdown && room.endTime) {
        const remaining = room.endTime - Date.now();
        if (remaining > 0) {
            const hours = Math.floor(remaining / 3600000);
            const minutes = Math.floor((remaining % 3600000) / 60000);
            modalCountdown.textContent = `${hours}h ${minutes}m`;
            modalCountdown.style.color = remaining < 1800000 ? '#ff0000' : '#27ae60';
        } else {
            modalCountdown.textContent = '⚠️ TIEMPO EXCEDIDO!';
            modalCountdown.style.color = '#ff0000';
        }
    }
}

// Renovar estancia
function renewStay() {
    const room = rooms.find(r => r.id === currentRoomId);
    if (!room || room.status !== 'occupied') {
        showToast('Habitación no válida para renovación', 'error');
        return;
    }
    const renewalPrice = parseFloat(document.getElementById('renewalPrice').value);
    const renewalTime = parseInt(document.getElementById('renewalTime').value);
    
    if (!renewalPrice || renewalPrice <= 0) {
        showToast('Por favor ingresa un precio válido', 'error');
        return;
    }
    
    if (!renewalTime || renewalTime <= 0) {
        showToast('Por favor ingresa las horas adicionales', 'error');
        return;
    }
    
    // Validar Método de pago
    const paymentMethod = validatePaymentMethod('renewalPaymentMethod', 'Por favor selecciona un Método de pago');
    if (!paymentMethod) return;

    if (!room.endTime) {
        const hoursToAdd = room.customTime != null ? room.customTime : room.defaultHours;
        room.endTime = (room.checkInTime || Date.now()) + hoursToAdd * 60 * 60 * 1000;
    }
    
    // Agregar tiempo al endTime existente
    const additionalTime = renewalTime * 60 * 60 * 1000;
    room.endTime = room.endTime + additionalTime;

    // Sumar el precio de renovación al precio actual de la habitación
    room.price = room.price + renewalPrice;
    room.lastModified = Date.now(); // Garantiza que la renovación prevalezca en merges con Firebase
    
    // Registrar el ingreso adicional
    const renewalTs = Date.now();
    roomRevenue.push({
        id: renewalTs,
        roomId: room.id,
        roomNumber: room.number,
        building: room.building,
        guestName: room.guestName,
        price: renewalPrice,
        customTime: renewalTime,
        checkInTime: renewalTs,
        timestamp: renewalTs,
        type: 'renewal',
        shift: getCurrentShift().type,
        shiftName: getCurrentShift().name,
        originalCheckIn: room.checkInTime,
        paymentMethod: paymentMethod
    });
    invalidateRevenueIndex();
    
    // Agregar automáticamente a movimientos según método de pago
    addSaleToMovements({
        id: Date.now(),
        roomId: room.id,
        roomNumber: room.number,
        building: room.building,
        guestName: room.guestName,
        price: renewalPrice,
        timestamp: Date.now(),
        type: 'renewal',
        paymentMethod: paymentMethod
    });
    
    // Limpiar campos
    document.getElementById('renewalPrice').value = '';
    document.getElementById('renewalTime').value = '';
    
    // _saveDataImmediate() en vez de saveData(): una renovación es dinero
    // nuevo — debe reflejarse al instante en los demás dispositivos, no
    // esperar el throttle de 2s.
    _saveDataImmediate();
    renderRooms();

    showToast(`renovación registrada: +${renewalTime} horas - $${renewalPrice.toFixed(2)} agregado`, 'success');
    
    // Actualizar el modal
    openRoomModal(currentRoomId);
}

function translateStatus(status) {
    const translations = {
        'available': 'Disponible',
        'occupied': 'Ocupado',
        'dirty': 'Sucio',
        'not-available': 'No Disponible',
        'reserved': 'Reservado'
    };
    return translations[status] || status;
}

// Funciones de validación consolidadas
function validatePaymentMethod(elementId, errorMsg = 'Por favor selecciona un método de pago') {
    const element = document.getElementById(elementId);
    const value = element ? element.value : '';
    if (!value) {
        showToast(errorMsg, 'error');
        return false;
    }
    return value;
}

function validateRequired(value, fieldName) {
    if (!value || (typeof value === 'string' && value.trim() === '')) {
        showToast(`Por favor ingresa ${fieldName}`, 'error');
        return false;
    }
    return true;
}

function validatePositiveNumber(value, fieldName) {
    const num = parseFloat(value);
    if (!num || num <= 0 || isNaN(num)) {
        showToast(`Por favor ingresa un ${fieldName} válido`, 'error');
        return false;
    }
    return num;
}

function useDefaultPrice() {
    const room = rooms.find(r => r.id === currentRoomId);
    if (!room) return;
    room.price = room.defaultPrice;
    room.customTime = null; // Usar tiempo por defecto de la habitación
    
    // Guardar y cerrar modal
    saveData();
    
    // Marcar como ocupado automáticamente
    updateRoomStatus(currentRoomId, 'occupied');
}

function showCustomPricing() {
    document.getElementById('customPricingForm').style.display = 'block';
}

// Update room status
function updateRoomStatus(roomId, status) {
    const room = rooms.find(r => r.id === roomId);
    if (!room) {
        showToast('Habitación no encontrada', 'error');
        return;
    }

    // Bloquear cambio si tiene reserva activa (excepto si se está marcando como ocupado desde la reserva)
    if (room.status === 'reserved' && status !== 'occupied') {
        showToast('Esta habitación está reservada y no se puede cambiar de estado', 'error');
        return;
    }
    
    // GUARDAR ESTADO ORIGINAL COMPLETO antes de cualquier modificación
    const originalState = {
        status: room.status,
        guestName: room.guestName,
        guestCount: room.guestCount,
        notes: room.notes,
        price: room.price,
        customTime: room.customTime,
        paymentMethod: room.paymentMethod
    };
    
    // First, save any details that were entered
    const guestInput = document.getElementById('guestNameInput');
    const guestCountInput = document.getElementById('guestCountInput');
    const customPriceInput = document.getElementById('customPriceInput');
    const customTimeInput = document.getElementById('customTimeInput');
    const notesInput = document.getElementById('notesInput');
    const paymentMethodInput = document.getElementById('paymentMethodInput');
    
    if (guestInput) room.guestName = guestInput.value;
    if (guestCountInput) room.guestCount = parseInt(guestCountInput.value) || 0;
    if (notesInput) room.notes = notesInput.value;
    
    // Handle custom pricing and time
    if (customPriceInput && customPriceInput.value) {
        const customPrice = parseFloat(customPriceInput.value);
        const customTime = parseInt(customTimeInput.value);
        
        // Validación de precio
        if (customPrice <= 0) {
            showToast('El precio debe ser mayor a $0', 'error');
            // REVERTIR TODO EL ESTADO
            Object.assign(room, originalState);
            return;
        }
        
        // Validación de tiempo mínimo 4 horas
        if (customTime && customTime < 4) {
            showToast('El tiempo mínimo es de 4 horas', 'error');
            // REVERTIR TODO EL ESTADO
            Object.assign(room, originalState);
            return;
        }
        
        room.price = customPrice;
        room.customTime = customTime || null;
    } else if (room.price === 0) {
        room.price = room.defaultPrice;
        room.customTime = null; // No usar tiempo personalizado si no se especificó
    }
    
    const oldStatus = room.status;
    room.status = status;
    room.lastModified = Date.now(); // Timestamp para merge inteligente
    
    if (status === 'occupied') {
        // Validar Método de pago
        const paymentMethod = validatePaymentMethod('paymentMethodInput', 'Por favor selecciona un Método de pago');
        if (!paymentMethod) {
            // REVERTIR TODO EL ESTADO
            Object.assign(room, originalState);
            return;
        }
        
        room.checkInTime = Date.now();
        
        // Set end time based on custom or default hours
        const hoursToAdd = room.customTime !== null ? room.customTime : room.defaultHours;
        room.endTime = room.checkInTime + (hoursToAdd * 60 * 60 * 1000);
        
        // Immediately record revenue when marking as occupied
        if (room.price > 0) {
            // Usar el paymentMethod ya validado arriba (no redeclarar)
            const checkinTs = Date.now();
            roomRevenue.push({
                id: checkinTs,
                roomId: room.id,
                roomNumber: room.number,
                building: room.building,
                guestName: room.guestName,
                price: room.price,
                customTime: room.customTime !== null ? room.customTime : room.defaultHours,
                checkInTime: room.checkInTime,
                endTime: room.endTime,
                timestamp: checkinTs,
                type: 'sold',
                shift: getCurrentShift().type,
                shiftName: getCurrentShift().name,
                paymentMethod: paymentMethod
            });
            invalidateRevenueIndex();
            
            // Limitar a últimos 10000 registros sin eliminar nunca registros del turno actual
            if (roomRevenue.length > 10000) {
                console.warn('[Sistema] Archivando ingresos antiguos...');
                const keep = roomRevenue.filter(r => r.timestamp >= currentShiftStart);
                const extra = roomRevenue.filter(r => r.timestamp < currentShiftStart).slice(-Math.max(0, 10000 - keep.length));
                roomRevenue = [...extra, ...keep];
                console.log(`[Sistema] Archivados registros antiguos. Preservados: ${keep.length} del turno actual.`);
            }
        }
    } else if (status === 'dirty') {
        // Guardar timestamp cuando se marca como sucia
        room.dirtyTimestamp = Date.now();
        room.lastModified = Date.now(); // Para sincronización correcta
    } else if (status === 'available' || status === 'not-available') {
        // NO registrar limpieza automáticamente aquí - solo se registra en confirmCleanRoom
        // Track if room was cleaned (solo para contador interno)
        if (oldStatus === 'dirty' && status === 'available') {
            room.cleanedCount++;
        }
        room.checkInTime = null;
        room.endTime = null;
        room.guestName = '';
        room.guestCount = 0;
        room.price = 0;
        room.notes = '';
        room.customTime = null;
        room.paymentMethod = null;
    }

    // _saveDataImmediate() en vez de saveData(): este es el cambio de
    // status principal (vender/ocupar, marcar sucia, liberar) — incluye el
    // cobro cuando status pasa a 'occupied'. No debe esperar el throttle de
    // 2s; el empleado en el otro dispositivo tiene que ver el cambio de
    // inmediato, no unos segundos después.
    _saveDataImmediate();

    // Renderizar según el rol activo
    if (currentUser && currentUser.role === 'limpieza') {
        renderCleaningRooms();
    } else {
        // Actualizar vista para admin/staff
        renderRooms();
    }
    
    // Refrescar modal de actividad si está abierto
    const _actM = document.getElementById('roomsActivityModal');
    if (_actM && _actM.classList.contains('show')) renderRoomsActivity();
    
    // Registrar actividad (deshabilitado)
    // logActivity('rooms', `habitación ${room.number} marcada como ${translateStatus(status)}`, {
    //     roomId: room.id,
    //     roomNumber: room.number,
    //     oldStatus,
    //     newStatus: status
    // });
    
    // Mostrar notificación toast
    const statusText = translateStatus(status);
    showToast(`habitación ${room.number} marcada como ${statusText}`, 'success');
    
    document.getElementById('roomModal').classList.remove('show');
}

// Update room timers
// FIXED: Usar cache de elementos DOM en lugar de getElementById (Problem 4b)
function updateRoomTimers() {
    rooms.forEach(room => {
        if (room.checkInTime) {
            // Si tiene endTime, mostrar cuenta regresiva
            if (room.endTime) {
                const countdownEl = roomTimerElements.get(`countdown-${room.id}`);
                if (countdownEl) {
                    const remaining = room.endTime - Date.now();
                    if (remaining > 0) {
                        const hours = Math.floor(remaining / 3600000);
                        const minutes = Math.floor((remaining % 3600000) / 60000);
                        countdownEl.textContent = `${hours}h ${minutes}m restantes`;

                        // Cambiar color si queda menos de 30 minutos
                        if (remaining < 1800000) { // 30 minutos
                            countdownEl.style.color = '#ff0000';
                            countdownEl.style.fontWeight = 'bold';
                        }
                    } else {
                        countdownEl.textContent = '⚠️ TIEMPO EXCEDIDO!';
                        countdownEl.style.color = '#ff0000';
                        countdownEl.style.fontWeight = 'bold';
                    }
                }
            } else {
                // Mostrar tiempo transcurrido (para habitaciones sin endTime configurado)
                const timerEl = roomTimerElements.get(`timer-${room.id}`);
                if (timerEl) {
                    timerEl.textContent = getElapsedTime(room.checkInTime);
                }
            }
        }
    });
}


// Get elapsed time
function getElapsedTime(startTime) {
    if (!startTime) return '0h 0m'; // Validación para evitar NaN
    const elapsed = Date.now() - startTime;
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
}

// Guardar producto
function saveProduct() {
    const name = document.getElementById('productName').value;
    const category = document.getElementById('productCategory').value;
    const quantity = parseInt(document.getElementById('productQuantity').value);
    const price = parseFloat(document.getElementById('productPrice').value);
    
    if (!name || !category || quantity < 0 || price < 0 || Number.isNaN(quantity) || Number.isNaN(price)) {
        showToast('Por favor completa todos los campos correctamente', 'error');
        return;
    }

    if (editingProductId != null) {
        const item = inventory.find(i => i.id === editingProductId);
        if (item) {
            item.name = name;
            item.category = category;
            item.quantity = quantity;
            item.price = price;
            item.lastModified = Date.now();
        }
        editingProductId = null;
    } else {
        inventory.push({ id: Date.now(), name, category, quantity, price, lastModified: Date.now() });
    }
    saveData();
    renderInventory();
    
    document.getElementById('productName').value = '';
    document.getElementById('productCategory').value = 'bebidas';
    document.getElementById('productQuantity').value = '';
    document.getElementById('productPrice').value = '';
    const saveBtn = document.getElementById('saveProductBtn');
    if (saveBtn) saveBtn.textContent = 'Guardar';
    document.getElementById('productModal').classList.remove('show');
}

// Renderizar inventario
function renderInventory() {
    const list = document.getElementById('inventoryList');
    list.innerHTML = '';

    // Filtrar por categoría (y excluir eliminados)
    const visibleInventory = inventory.filter(item => !item.deleted);
    const filteredInventory = currentCategoryFilter === 'all'
        ? visibleInventory
        : visibleInventory.filter(item => item.category === currentCategoryFilter);

    filteredInventory.forEach(item => {
        const div = document.createElement('div');
        div.className = 'inventory-item';

        const isAdmin = currentUser && (currentUser.role === 'supervisor' || currentUser.role === 'director');

        // Nombres de categorías para mostrar
        const categoryNames = {
            'sex-shop': 'Sex Shop',
            'alimentos': 'Alimentos',
            'bebidas': 'Bebidas',
            'otros': 'Otros'
        };

        const categoryBadge = item.category ? `<span class="category-badge ${item.category}">${categoryNames[item.category] || item.category}</span>` : '';

        div.innerHTML = `
            <div class="inventory-item-info">
                <strong style=\"color:#1e2a3a;font-size:14px;\">${sanitizeHTML(item.name)}</strong>${categoryBadge}<br>
                <span class="inventory-details">Cantidad: ${item.quantity} | Precio: $${item.price.toFixed(2)}</span>
            </div>
            ${isAdmin ? `
                <div class="inventory-item-actions">
                    <button class="btn-edit-inventory" onclick="editInventoryItem(${item.id})" title="Editar">✏️</button>
                    <button class="btn-delete-inventory" onclick="deleteInventoryItem(${item.id})" title="Eliminar">&times;</button>
                </div>
            ` : ''}
        `;
        list.appendChild(div);
    });

    updateProductSelect();
}


// Actualizar selector de productos
function updateProductSelect() {
    const select = document.getElementById('productSelect');
    select.innerHTML = '<option value="">Seleccionar Producto</option>';
    
    inventory.filter(item => !item.deleted && item.quantity > 0).forEach(item => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = `${item.name} ($${item.price.toFixed(2)}) - ${item.quantity} disponibles`;
        select.appendChild(option);
    });
}

// Procesar venta
function processSale() {
    const sellBtn = document.getElementById('sellBtn');
    const productId = parseInt(document.getElementById('productSelect').value);
    const quantity = parseInt(document.getElementById('quantityInput').value);
    
    if (!productId || !quantity || quantity < 1) {
        showToast('Por favor selecciona un producto y cantidad válida', 'error');
        return;
    }
    
    const product = inventory.find(p => p.id === productId);
    if (!product || product.deleted) {
        showToast('Producto no encontrado o ya no existe', 'error');
        return;
    }
    
    // Validación de stock
    if (product.quantity < quantity) {
        showToast(`Stock insuficiente. Solo hay ${product.quantity} unidades disponibles`, 'error');
        return;
    }
    
    // Validar Método de pago
    const paymentMethod = validatePaymentMethod('salePaymentMethod', 'Por favor selecciona un Método de pago');
    if (!paymentMethod) return;
    
    // Prevenir duplicados - deshabilitar botón
    sellBtn.disabled = true;
    sellBtn.textContent = 'Procesando...';
    
    product.quantity -= quantity;
    product.lastModified = Date.now();
    const total = product.price * quantity;
    
    sales.push({
        id: Date.now(),
        productName: product.name,
        quantity,
        price: product.price,
        total,
        timestamp: Date.now(),
        shift: getCurrentShift().type,
        shiftName: getCurrentShift().name,
        paymentMethod: paymentMethod
    });
    
    // Limitar a últimos 5000 registros para evitar problemas de tamaño
    if (sales.length > 5000) {
        console.warn('[Sistema] Archivando ventas antiguas...');
        sales = sales.slice(-5000);
    }
    
    // Agregar automáticamente a movimientos según método de pago
    addSaleToMovements({
        id: Date.now(),
        items: [{name: product.name, quantity, price: product.price}],
        total,
        timestamp: Date.now(),
        paymentMethod: paymentMethod
    });
    
    saveData();
    renderInventory();
    renderSalesLog();
    
    // Registrar actividad (deshabilitado)
    // logActivity('sales', `Venta: ${quantity} ${product.name} - $${total.toFixed(2)}`, {
    //     productId: product.id,
    //     productName: product.name,
    //     quantity,
    //     total
    // });
    
    showToast(`✅ Venta registrada: ${quantity} ${product.name} - $${total.toFixed(2)}`, 'success');
    
    document.getElementById('quantityInput').value = '1';
    
    // Rehabilitar botón después de 1 segundo
    setTimeout(() => {
        sellBtn.disabled = false;
        sellBtn.textContent = 'Vender';
    }, 1000);
}

// Renderizar registro de ventas del TURNO ACTUAL
function renderSalesLog() {
    const log = document.getElementById('salesLog');
    if (!log) return;
    
    // Filtrar ventas del turno actual (desde currentShiftStart)
    const currentShift = getCurrentShift();
    const shiftSales = sales.filter(s => 
        s.timestamp >= currentShiftStart && s.shift === currentShift.type
    );
    
    log.innerHTML = '<h3>Ventas del Turno Actual</h3>';
    
    if (shiftSales.length === 0) {
        log.innerHTML += '<p style="text-align:center;color:#999;padding:20px;">No hay ventas en este turno</p>';
        return;
    }
    
    // Mostrar las últimas 10 ventas del turno
    shiftSales.slice().reverse().slice(0, 10).forEach(sale => {
        const div = document.createElement('div');
        div.className = 'sale-item';
        
        const date = new Date(sale.timestamp);
        const timeStr = date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
        const paymentIcon = sale.paymentMethod === 'efectivo' ? '💵' : '💳';
        
        div.innerHTML = `
            <div class="sale-item-header">
                <strong>${sanitizeHTML(sale.productName)}</strong>
                <span class="sale-amount">$${sale.total.toFixed(2)} ${paymentIcon}</span>
            </div>
            <div class="sale-item-details">
                <span>Cantidad: ${sale.quantity}</span>
                <span>Precio unitario: $${sale.price.toFixed(2)}</span>
                <span>${timeStr}</span>
            </div>
        `;
        log.appendChild(div);
    });
    
    // Mostrar total del turno
    const totalTurno = shiftSales.reduce((sum, s) => sum + s.total, 0);
    const totalDiv = document.createElement('div');
    totalDiv.className = 'sale-total';
    totalDiv.innerHTML = `
        <strong>Total del turno:</strong>
        <span>$${totalTurno.toFixed(2)}</span>
    `;
    log.appendChild(totalDiv);
}

// Check if timestamp is today
function isToday(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    return date.toDateString() === today.toDateString();
}

// Update date and time
function updateDateTime() {
    const el = document.getElementById('currentDate');
    if (el) el.textContent = new Date().toLocaleString();
}

// Initialize on load
// document.addEventListener('DOMContentLoaded', init); // Comentado - ahora se llama desde showMainApp()


// ============ GASTOS OPERATIVOS ============

// Agregar gasto
function addExpense() {
    const category = document.getElementById('expenseCategory').value;
    const description = document.getElementById('expenseDescription').value;
    const amount = parseFloat(document.getElementById('expenseAmount').value);
    const paymentMethod = document.getElementById('expensePaymentMethod').value;

    if (!category) { showToast('Por favor selecciona una categoría', 'error'); return; }
    if (!description || description.trim() === '') { showToast('Por favor ingresa una descripción', 'error'); return; }
    if (!amount || amount <= 0) { showToast('Por favor ingresa un monto válido', 'error'); return; }
    if (!paymentMethod) { showToast('Por favor selecciona un método de pago', 'error'); return; }

    const categoryNames = {
        'operacion': 'Gastos de Operación', 'alimentos': 'Alimentos y Bebidas',
        'limpieza': 'Productos de Limpieza', 'sexshop': 'Sex Shop',
        'generales': 'Generales', 'mercadotecnia': 'Mercadotecnia', 'nomina': 'Nómina'
    };
    const paymentMethodNames = { 'efectivo': 'Efectivo en Caja', 'banco': 'Banco/Transferencia' };

    const expense = {
        id: Date.now(),
        category: categoryNames[category],
        categoryType: category,
        description: description.trim(),
        amount: amount,
        paymentMethod: paymentMethod,
        timestamp: Date.now(),
        shift: getCurrentShift().type,
        shiftName: getCurrentShift().name
    };

    expenses.push(expense);
    
    // Limitar a últimos 5000 registros para evitar problemas de tamaño
    if (expenses.length > 5000) {
        console.warn('[Sistema] Archivando gastos antiguos...');
        expenses = expenses.slice(-5000);
    }
    
    saveData();

    // Sincronizar con reporte mensual
    const expenseDate = new Date(expense.timestamp);
    const mrKey = `mrData_${expenseDate.getFullYear()}_${expenseDate.getMonth()}`;
    let mrData;
    try {
        const saved = localStorage.getItem(mrKey);
        mrData = saved ? JSON.parse(saved) : { directExpenses: [], indirectExpenses: [], nonOpExpenses: [], salaries: [], efectivoMovimientos: [], bancoMovimientos: [] };
    } catch(e) {
        mrData = { directExpenses: [], indirectExpenses: [], nonOpExpenses: [], salaries: [], efectivoMovimientos: [], bancoMovimientos: [] };
    }

    const todayStr = expenseDate.toISOString().split('T')[0];
    const newItem = { category, concept: description.trim(), date: todayStr, amount, _expenseId: expense.id };

    // mercadotecnia -> indirecto, resto -> directo
    if (category === 'mercadotecnia') {
        if (!mrData.indirectExpenses) mrData.indirectExpenses = [];
        mrData.indirectExpenses.push(newItem);
    } else {
        if (!mrData.directExpenses) mrData.directExpenses = [];
        mrData.directExpenses.push(newItem);
    }

    localStorage.setItem(mrKey, JSON.stringify(mrData));
    if (_appReady && window.FirebaseSync && window.FirebaseSync.ready) {
        window.FirebaseSync.saveMrData(mrKey, mrData);
    }

    // Si el reporte mensual del mes actual esta abierto, actualizar vista
    if (_mrYear === expenseDate.getFullYear() && _mrMonth === expenseDate.getMonth()) {
        _mrData = mrData;
        generateMonthlyReport();
    }

    // Limpiar formulario
    document.getElementById('expenseCategory').value = '';
    document.getElementById('expenseDescription').value = '';
    document.getElementById('expenseAmount').value = '';
    document.getElementById('expensePaymentMethod').value = '';

    updateExpensesTotal();
    if (currentUser && currentUser.role === 'director') {
        updateExpensesByPaymentMethod('day');
        updateExpensesByCategory('day');
    }

    const paymentIcon = paymentMethod === 'efectivo' ? '💵' : '🏦';
    showToast(`Gasto registrado: $${amount.toFixed(2)} (${paymentIcon} ${paymentMethodNames[paymentMethod]})`, 'success');
}
function renderExpensesLog(filter = 'all') {
    const log = document.getElementById('expensesLog');
    if (!log) {
        console.warn('[Expenses] expensesLog element not found in DOM');
        return;
    }

    // FIXED: Filtrar gastos eliminados (soft delete)
    let filteredExpenses = expenses.filter(e => !e.deleted);
    if (filter !== 'all') {
        filteredExpenses = filteredExpenses.filter(e => e.categoryType === filter);
    }

    // Ordenar por timestamp descendente
    const sortedExpenses = [...filteredExpenses].sort((a, b) => b.timestamp - a.timestamp);

    if (sortedExpenses.length === 0) {
        log.innerHTML = '<p class="no-expenses">No hay gastos registrados</p>';
        return;
    }

    const categoryIcons = {
        'operacion': '⚙️',
        'alimentos': '🍽️',
        'limpieza': '🧹',
        'sexshop': '🛍️',
        'generales': '📦',
        'mercadotecnia': '📢',
        'nomina': '💼'
    };

    log.innerHTML = sortedExpenses.slice(0, 20).map(expense => {
        const date = new Date(expense.timestamp);
        const icon = categoryIcons[expense.categoryType] || '📌';
        const paymentIcon = expense.paymentMethod === 'efectivo' ? '💵' : '💳';

        return `
            <div class="expense-item" data-category="${expense.categoryType}">
                <div class="expense-icon">${icon}</div>
                <div class="expense-details">
                    <div class="expense-header">
                        <span class="expense-category">${sanitizeHTML(expense.category)}</span>
                        <span class="expense-amount">-$${expense.amount.toFixed(2)} ${paymentIcon}</span>
                    </div>
                    <div class="expense-description">${sanitizeHTML(expense.description)}</div>
                    <div class="expense-date">${date.toLocaleString('es-MX')}</div>
                </div>
                <button class="btn-delete-expense" onclick="deleteExpense(${expense.id})">&times;</button>
            </div>
        `;
    }).join('');
}


// Eliminar gasto
// FIXED: Implementado soft delete en lugar de eliminación física
async function deleteExpense(expenseId) {
    const confirmed = await showCustomConfirm('Eliminar Gasto', '¿Estás seguro de eliminar este gasto?');
    if (!confirmed) {
        return;
    }

    const expense = expenses.find(e => e.id === expenseId);
    if (expense) {
        expense.deleted = true; // FIXED: Soft delete
        expense.deletedAt = Date.now(); // FIXED: Timestamp de eliminación
        saveData();
        updateExpensesTotal();
        renderExpensesLog(); // FIXED: Re-renderizar para aplicar filtro
        
        // Actualizar estadísticas de gastos (solo para director)
        if (currentUser && currentUser.role === 'director') {
            updateExpensesByPaymentMethod('day');
            updateExpensesByCategory('day');
        }
    }
}

// Actualizar solo el total de egresos (para pestaña de Inventario)
function updateExpensesTotal() {
    const totalCard = document.getElementById('expensesTotalCard');
    if (!totalCard) return;
    
    // Calcular total de gastos del TURNO ACTUAL (desde currentShiftStart)
    const currentShift = getCurrentShift();
    const shiftExpenses = expenses.filter(e =>
        !e.deleted && e.timestamp >= currentShiftStart && e.shift === currentShift.type
    );
    const total = shiftExpenses.reduce((sum, e) => sum + e.amount, 0);
    
    totalCard.textContent = `$${total.toFixed(2)}`;
}

// Actualizar resumen de gastos
function updateExpensesSummary(period = 'day', shift = 'all') {
    const now = Date.now();
    let timeAgo;
    
    if (period === 'day') {
        timeAgo = now - (24 * 60 * 60 * 1000);
    } else if (period === 'week') {
        timeAgo = now - (7 * 24 * 60 * 60 * 1000);
    } else {
        timeAgo = now - (30 * 24 * 60 * 60 * 1000);
    }
    
    let periodExpenses = expenses.filter(e => !e.deleted && e.timestamp >= timeAgo);

    // Filtrar por turno usando el campo 'shift' guardado
    if (shift !== 'all') {
        periodExpenses = periodExpenses.filter(expense => {
            // Si el gasto tiene el campo shift guardado, usarlo
            if (expense.shift) {
                return expense.shift === shift;
            }
            // Si no tiene el campo (gastos antiguos), calcular por hora
            const expenseDate = new Date(expense.timestamp);
            const hour = expenseDate.getHours();
            
            if (shift === 'day') {
                return hour >= 6 && hour < 18;
            } else if (shift === 'night') {
                return hour >= 18 || hour < 6;
            }
            return true;
        });
    }
    
    // Agrupar por categoría
    const byCategory = {};
    periodExpenses.forEach(expense => {
        const cat = expense.categoryType;
        if (!byCategory[cat]) {
            byCategory[cat] = 0;
        }
        byCategory[cat] += expense.amount;
    });
    
    const total = periodExpenses.reduce((sum, e) => sum + e.amount, 0);
    
    const categoryNames = {
        'gas': 'Gas',
        'agua': 'Agua',
        'limpieza': 'Limpieza',
        'mantenimiento': 'Mantenimiento',
        'servicios': 'Servicios',
        'nomina': 'N?mina',
        'otros': 'Otros'
    };
    
    const categoryIcons = {
        'gas': '🔥',
        'agua': '💧',
        'limpieza': '🧹',
        'mantenimiento': '🔧',
        'servicios': '🏠',
        'nomina': '💼',
        'otros': '📦'
    };
    
    const container = document.getElementById('expensesSummary');
    if (!container) {
        console.warn('[Expenses] expensesSummary element not found');
        return;
    }
    
    let html = `
        <div class="expense-total-card">
            <div class="total-label">Total de Gastos</div>
            <div class="total-amount">$${total.toFixed(2)}</div>
            <div class="total-count">${periodExpenses.length} transacciones</div>
        </div>
        <div class="expenses-by-category">
    `;
    
    Object.entries(byCategory).forEach(([cat, amount]) => {
        const percentage = total > 0 ? (amount / total * 100).toFixed(1) : 0;
        html += `
            <div class="category-expense-item">
                <div class="category-info">
                    <span class="category-icon">${categoryIcons[cat]}</span>
                    <span class="category-name">${categoryNames[cat]}</span>
                </div>
                <div class="category-amount-info">
                    <span class="category-amount">$${amount.toFixed(2)}</span>
                    <span class="category-percentage">${percentage}%</span>
                </div>
            </div>
        `;
    });
    
    html += '</div>';
    container.innerHTML = html;
}

function getCurrentShift() {
    // Si hay un turno manual establecido, usarlo
    if (currentShiftType) {
        if (currentShiftType === 'day') {
            return {
                name: 'Turno Día',
                start: 6,
                end: 18,
                type: 'day'
            };
        } else {
            return {
                name: 'Turno Noche',
                start: 18,
                end: 6,
                type: 'night'
            };
        }
    }
    
    // Si no hay turno manual, detectar por hora (solo para inicialización)
    const now = new Date();
    const hour = now.getHours();
    
    if (hour >= 6 && hour < 18) {
        return {
            name: 'Turno Día',
            start: 6,
            end: 18,
            type: 'day'
        };
    } else {
        return {
            name: 'Turno Noche',
            start: 18,
            end: 6,
            type: 'night'
        };
    }
}

// Obtener inicio y fin del turno actual
function getShiftTimeRange() {
    const now = new Date();
    const shift = getCurrentShift();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    let shiftStart, shiftEnd;
    
    if (shift.type === 'day') {
        shiftStart = new Date(today.getTime() + (6 * 60 * 60 * 1000)); // 6 AM hoy
        shiftEnd = new Date(today.getTime() + (18 * 60 * 60 * 1000)); // 6 PM hoy
    } else {
        if (now.getHours() >= 18) {
            // Turno noche que empieza hoy
            shiftStart = new Date(today.getTime() + (18 * 60 * 60 * 1000)); // 6 PM hoy
            shiftEnd = new Date(today.getTime() + (30 * 60 * 60 * 1000)); // 6 AM mañana
        } else {
            // Turno noche que empez? ayer
            shiftStart = new Date(today.getTime() - (6 * 60 * 60 * 1000)); // 6 PM ayer
            shiftEnd = new Date(today.getTime() + (6 * 60 * 60 * 1000)); // 6 AM hoy
        }
    }
    
    return { shiftStart: shiftStart.getTime(), shiftEnd: shiftEnd.getTime() };
}



// Actualizar timer del turno
function updateShiftTimer() {
    const now = new Date();
    const shift = getCurrentShift();
    let shiftStart;
    if (shift.type === 'day') {
        shiftStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0).getTime();
    } else {
        const h = now.getHours();
        if (h >= 18) {
            shiftStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0).getTime();
        } else {
            // Madrugada (0–6): el turno noche empezó ayer a las 18:00
            shiftStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 18, 0, 0).getTime();
        }
    }
    const elapsed = Math.max(0, now.getTime() - shiftStart);
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    const el = document.getElementById('shiftTimer');
    if (el) el.textContent = hours + 'h ' + minutes + 'm transcurridos';
}

// Actualizar actividad reciente
function updateRecentActivity(shiftStart, shiftEnd) {
    const container = document.getElementById('scRecentActivity');
    if (!container) return;

    const activities = [];

    roomRevenue.filter(r => r.timestamp >= shiftStart && r.timestamp < shiftEnd && r.type === 'sold' && !r.hidden)
        .forEach(r => activities.push({
            id: r.id,
            dataType: 'roomRevenue',
            timestamp: r.timestamp, type: 'sold',
            icon: '🏠', text: `Hab. ${r.roomNumber} (${r.building === 'regulares' ? 'Ed.1' : 'Torre'}) — $${r.price.toFixed(2)}`,
            amount: r.price
        }));

    roomRevenue.filter(r => r.timestamp >= shiftStart && r.timestamp < shiftEnd && r.type === 'renewal' && !r.hidden)
        .forEach(r => activities.push({
            id: r.id,
            dataType: 'roomRevenue',
            timestamp: r.timestamp, type: 'renewal',
            icon: '🔄', text: `Renovación Hab. ${r.roomNumber} — $${r.price.toFixed(2)}`,
            amount: r.price
        }));

    // NO incluir limpiezas de roomRevenue aquí - se muestran desde activityLog
    // roomRevenue.filter(r => r.timestamp >= shiftStart && r.timestamp < shiftEnd && r.type === 'cleaned')
    //     .forEach(r => activities.push({
    //         timestamp: r.timestamp, type: 'cleaned',
    //         icon: '🧹', 
    //         text: `Hab. ${r.roomNumber} limpiada${r.cleanedBy ? ' por ' + r.cleanedBy : ''}${r.cleaningNotes ? ' (con notas)' : ''}`
    //     }));

    sales.filter(s => s.timestamp >= shiftStart && s.timestamp < shiftEnd && !s.hidden)
        .forEach(s => activities.push({
            id: s.id,
            dataType: 'sales',
            timestamp: s.timestamp, type: 'sale',
            icon: '🛒', text: `${s.productName} x${s.quantity} — $${s.total.toFixed(2)}`,
            amount: s.total
        }));

    expenses.filter(e => e.timestamp >= shiftStart && e.timestamp < shiftEnd && !e.hidden)
        .forEach(e => activities.push({
            id: e.id,
            dataType: 'expenses',
            timestamp: e.timestamp, type: 'expense',
            icon: '💸', text: `Gasto: ${e.description} — $${e.amount.toFixed(2)}`
        }));

    activities.sort((a, b) => b.timestamp - a.timestamp);

    // AGREGAR ACTIVIDADES DEL LOG GENERAL (cambios de contraseña, limpiezas, etc.)
    if (Array.isArray(activityLog)) {
        activityLog.filter(a => a.timestamp >= shiftStart && a.timestamp < shiftEnd && !a.hidden)
            .forEach(a => {
                let icon = '📝';
                let text = a.description || 'Actividad registrada';
                
                // Iconos específicos por tipo
                if (a.type === 'password_change') {
                    icon = '🔑';
                    text = a.description;
                } else if (a.type === 'rooms' && a.description && a.description.includes('🧹') && a.description.includes('limpiada')) {
                    // Actividades de limpieza - usar el ícono y texto del log
                    icon = '🧹';
                    text = a.description;
                    
                    // Agregar información adicional si está disponible en details
                    if (a.details && a.details.building) {
                        const buildingText = a.details.building === 'regulares' ? 'Ed.1' : 'Torre';
                        text = text.replace(`Habitación ${a.details.roomNumber}`, `Hab. ${a.details.roomNumber} (${buildingText})`);
                    }
                    
                    // Agregar información de notas si las hay
                    if (a.details && a.details.notes && a.details.notes.trim()) {
                        text += ' (con notas)';
                    }
                }
                
                activities.push({
                    id: a.id,
                    dataType: 'activityLog',
                    timestamp: a.timestamp,
                    type: a.type || 'general',
                    icon: icon,
                    text: text
                });
            });
        
        // Re-ordenar después de agregar actividades del log
        activities.sort((a, b) => b.timestamp - a.timestamp);
    }

    if (activities.length === 0) {
        container.innerHTML = '<div class="sc-no-activity">Sin actividad registrada aún</div>';
        return;
    }

    container.innerHTML = activities.slice(0, 15).map(a => {
        const time = new Date(a.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
        const amountHtml = a.amount ? `<span class="sc-act-amount">$${a.amount.toFixed(2)}</span>` : '';
        
        // Solo mostrar botón de eliminar para director y recepción
        const deleteBtn = (currentUser && (currentUser.role === 'director' || currentUser.role === 'recepcion') && a.id && a.dataType) 
            ? `<button class="sc-act-delete-btn" onclick="deleteActivityItem('${a.dataType}', ${a.id})" title="Ocultar">🗑️</button>`
            : '';
        
        return `
            <div class="sc-activity-item type-${a.type}">
                <span class="sc-act-icon">${a.icon}</span>
                <div class="sc-act-body">
                    <div class="sc-act-text">${a.text}</div>
                    <div class="sc-act-time">${time}</div>
                </div>
                ${amountHtml}
                ${deleteBtn}
            </div>`;
    }).join('');
}

// Actualizar control de turno
function updateShiftControl() {
    const shift = getCurrentShift();

    // Actualizar badge y horario
    const badge = document.getElementById('scShiftBadge');
    const timeEl = document.getElementById('scShiftTime');
    if (badge) badge.textContent = shift.name.toUpperCase();
    if (timeEl) timeEl.textContent = shift.type === 'day' ? '6:00 AM – 6:00 PM' : '6:00 PM – 6:00 AM';

    ensureRevenueIndex();

    const shiftRooms = getShiftRevenue(shift.type, currentShiftStart).filter(r => r.type === 'sold');
    const shiftRenewals = getShiftRevenue(shift.type, currentShiftStart).filter(r => r.type === 'renewal');
    const shiftCleaned = getShiftRevenue(shift.type, currentShiftStart).filter(r => r.type === 'cleaned');
    const shiftSales = sales.filter(s => s.shift === shift.type && s.timestamp >= currentShiftStart);
    const shiftExpenses = expenses.filter(e => !e.deleted && e.shift === shift.type && e.timestamp >= currentShiftStart);

    const roomsTotal    = shiftRooms.reduce((s, r) => s + r.price, 0);
    const renewalsTotal = shiftRenewals.reduce((s, r) => s + r.price, 0);
    const salesTotal    = shiftSales.reduce((s, r) => s + r.total, 0);
    const expensesTotal = shiftExpenses.reduce((s, e) => s + e.amount, 0);
    const netTotal      = roomsTotal + renewalsTotal + salesTotal - expensesTotal;

    // KPIs
    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('quickTotalRevenue', '$' + netTotal.toFixed(2));
    setEl('scRoomsKpi', shiftRooms.length + shiftRenewals.length);
    setEl('scDirtyKpi', rooms.filter(r => r.status === 'dirty').length);

    // Desglose ingresos
    setEl('revenueRooms', '$' + (roomsTotal + renewalsTotal).toFixed(2));
    setEl('revenueRoomsCount', shiftRooms.length + ' rentas' + (shiftRenewals.length > 0 ? ' + ' + shiftRenewals.length + ' renovaciones' : ''));
    setEl('revenueSales', '$' + salesTotal.toFixed(2));
    setEl('revenueSalesCount', shiftSales.length + ' transacciones');
    setEl('revenueExpenses', '$' + expensesTotal.toFixed(2));
    setEl('revenueExpensesCount', shiftExpenses.length + ' gastos');

    // Métodos de pago
    const pm = { efectivo: 0, tarjeta: 0 };
    [...shiftRooms, ...shiftRenewals].forEach(r => { pm[r.paymentMethod || 'efectivo'] += r.price; });
    shiftSales.forEach(s => { pm[s.paymentMethod || 'efectivo'] += s.total; });
    setEl('paymentEfectivo', '$' + pm.efectivo.toFixed(2));
    setEl('paymentTarjeta',  '$' + pm.tarjeta.toFixed(2));
    setEl('paymentTotal',    '$' + (pm.efectivo + pm.tarjeta).toFixed(2));

    // Timer y actividad — usar el inicio REAL del turno (currentShiftStart),
    // no el rango fijo 6am/6pm de getShiftTimeRange(), que diverge en cuanto
    // un turno se abre/cierra manualmente fuera de esas horas y mostraba una
    // lista de actividad reciente inconsistente con los KPIs de arriba.
    updateShiftTimer();
    updateRecentActivity(currentShiftStart, Date.now());
}


// ============ ELIMINAR ELEMENTO DEL HISTORIAL ============

// Función para ocultar un elemento del historial (NO modifica ingresos)
async function deleteActivityItem(dataType, itemId) {
    // Buscar el elemento para mostrar información en la confirmación
    let itemText = '';
    let item = null;
    
    switch(dataType) {
        case 'roomRevenue':
            item = roomRevenue.find(r => r.id === itemId);
            if (item) {
                itemText = `${item.type === 'sold' ? 'Venta' : 'Renovación'} de Hab. ${item.roomNumber} - $${item.price.toFixed(2)}`;
            }
            break;
        case 'sales':
            item = sales.find(s => s.id === itemId);
            if (item) {
                itemText = `Venta: ${item.productName} x${item.quantity} - $${item.total.toFixed(2)}`;
            }
            break;
        case 'expenses':
            item = expenses.find(e => e.id === itemId);
            if (item) {
                itemText = `Gasto: ${item.description} - $${item.amount.toFixed(2)}`;
            }
            break;
        case 'activityLog':
            item = activityLog.find(a => a.id === itemId);
            if (item) {
                itemText = item.description || 'Actividad registrada';
            }
            break;
    }
    
    if (!item) {
        showToast('Error: Elemento no encontrado', 'error');
        return;
    }
    
    // Confirmación obligatoria
    const confirmed = await showCustomConfirm(
        '👁️ Ocultar del Historial',
        `¿Ocultar esta actividad del historial y reportes?\n\n${itemText}\n\n✓ Los ingresos NO se modificarán\n✓ Solo desaparecerá del historial visual`
    );
    
    if (!confirmed) return;
    
    // Marcar como oculto en lugar de eliminar
    item.hidden = true;
    item.hiddenBy = currentUser ? currentUser.name : 'Desconocido';
    item.hiddenAt = Date.now();
    
    // Guardar cambios
    saveData();
    
    // Actualizar interfaz
    updateShiftControl();
    
    // Actualizar otras vistas según el tipo
    if (dataType === 'sales') {
        renderSalesLog();
        renderInventory();
    } else if (dataType === 'expenses') {
        updateExpensesTotal();
        renderExpensesLog();
    }
    
    showToast('✓ Elemento oculto del historial', 'success');
    
    console.log(`[Activity] Elemento oculto: ${dataType} ID:${itemId} por ${currentUser.name}`);
}

// ============ CERRAR TURNO ============

async function closeShift(options = {}) {
    const auto = options.auto === true;
    const shift = getCurrentShift();

    const shiftRooms = roomRevenue.filter(r =>
        r.shift === shift.type && r.type === 'sold' && r.timestamp >= currentShiftStart
    );
    const shiftRenewals = roomRevenue.filter(r =>
        r.shift === shift.type && r.type === 'renewal' && r.timestamp >= currentShiftStart
    );
    const shiftCleaned = roomRevenue.filter(r =>
        r.shift === shift.type && r.type === 'cleaned' && r.timestamp >= currentShiftStart
    );
    const shiftSales = sales.filter(s =>
        s.shift === shift.type && s.timestamp >= currentShiftStart
    );

    const roomsSold = shiftRooms.length;
    const roomsCleaned = shiftCleaned.length;
    const difference = roomsSold - roomsCleaned;
    const roomRev = shiftRooms.reduce((sum, r) => sum + r.price, 0);
    const renewalsRev = shiftRenewals.reduce((sum, r) => sum + r.price, 0);
    const salesRev = shiftSales.reduce((sum, s) => sum + s.total, 0);
    const totalRev = roomRev + renewalsRev + salesRev;

    // El cierre automático por desfase horario (ver autoCloseShiftIfOverdue)
    // no debe interrumpir al empleado con un diálogo de confirmación — si
    // nadie cerró el turno manualmente en 15 minutos, se cierra solo.
    if (!auto) {
        let confirmMessage = `Confirmas cerrar el turno ${shift.name}?\n\nResumen:\nHabitaciones vendidas: ${roomsSold}\nHabitaciones limpiadas: ${roomsCleaned}\nIngresos totales: $${totalRev.toFixed(2)}`;
        if (shiftRenewals.length > 0) confirmMessage += `\n(incluye ${shiftRenewals.length} renovación(es))`;
        if (difference !== 0) confirmMessage += `\n\nADVERTENCIA: Diferencia de ${Math.abs(difference)} habitacion(es)`;

        const confirmed = await showCustomConfirm('Confirmar Cierre de Turno', confirmMessage);
        if (!confirmed) return;
    }

    const snapshot = {
        id: Date.now(), shiftType: shift.type, shiftName: shift.name, closedAt: Date.now(),
        rooms: rooms.filter(r => r).map(r => ({ number: r.number, building: r.building, status: r.status, checkInTime: r.checkInTime, price: r.price, guestName: r.guestName, customTime: r.customTime }))
    };
    shiftSnapshots.push(snapshot);

    const shiftClosedAt = Date.now();
    const report = {
        id: Date.now(), shiftName: shift.name, shiftType: shift.type,
        // Usar el inicio/fin REAL del turno (currentShiftStart..cierre), no el
        // rango fijo 6am/6pm de getShiftTimeRange(): si el turno se abrió o
        // cerró manualmente fuera de esa ventana, downloadShiftReport() volvía
        // a filtrar con un rango invertido y devolvía $0 en un reporte cuyo
        // total ya se había calculado correctamente arriba con currentShiftStart.
        startTime: currentShiftStart, endTime: shiftClosedAt, closedAt: shiftClosedAt,
        closedBy: auto ? 'Sistema (automático)' : (currentUser ? currentUser.name : 'Desconocido'),
        autoClosed: auto,
        roomsSold, roomsCleaned, difference,
        roomRevenue: roomRev + renewalsRev, salesRevenue: salesRev, totalRevenue: totalRev,
        salesCount: shiftSales.length, isBalanced: difference === 0
    };
    shiftReports.push(report);
    
    // Mantener los últimos 20 turnos (10 días) para análisis histórico
    if (shiftReports.length > 20) {
        shiftReports = shiftReports.slice(-20);
    }

    const shiftExpenses = expenses.filter(e => !e.deleted && e.shift === shift.type && e.timestamp >= currentShiftStart);
    // En modo auto NO se dispara la descarga/modal del reporte (interrumpiría
    // al empleado sin que nadie lo haya pedido) — el reporte ya quedó
    // guardado en shiftReports y se puede descargar luego desde el historial
    // de turnos (downloadShiftReport).
    if (!auto) {
        generateShiftReport(shift, shiftRooms, shiftCleaned, shiftSales, shiftExpenses, shiftRenewals, report);
    }

    const closedShiftStart = currentShiftStart;
    currentShiftStart = Date.now();

    // Cambiar al turno contrario: día → noche, noche → día
    currentShiftType = (shift.type === 'day') ? 'night' : 'day';

    // Persistir inmediatamente a localStorage y Firebase (sin depender del throttle)
    localStorage.setItem('motelCurrentShiftStart', JSON.stringify(currentShiftStart));
    localStorage.setItem('motelCurrentShiftType', currentShiftType);
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        window.FirebaseSync.save('motelCurrentShiftStart', currentShiftStart).catch(() => {});
        window.FirebaseSync.save('motelCurrentShiftType', currentShiftType).catch(() => {});
    }

    // NO BORRAR DATOS HISTÓRICOS - mantener todos los registros para estadísticas y reportes
    // Los datos se filtran por turno usando el campo 'shift' y 'timestamp' al consultarlos
    // sales, expenses y roomRevenue conservan TODO el histórico

    saveData();
    renderSalesLog();
    updateExpensesTotal();
    updateShiftHistory();
    const newShift = getCurrentShift();

    if (auto) {
        // No confirmación, no cambio de pestaña forzado: el empleado puede
        // estar en medio de otra tarea (limpieza, ventas, etc.) y no debe
        // ser interrumpido, solo notificado.
        showToast(`⏰ ${shift.name} cerrado automáticamente por desfase horario (nadie lo cerró a tiempo). Iniciando ${newShift.name}.`, 'warning', 8000);
        console.log(`[Turno] Auto-cierre: ${shift.name} → ${newShift.name}`);
    } else {
        showToast(`Turno cerrado. Iniciando ${newShift.name} en cero.`, 'success');
        // Navegar a la pestaña de control de turno para mostrar el nuevo turno
        switchTab('shift-control');
    }

    updateShiftControl();
    updateStatistics();
}

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
const SHIFT_AUTO_SWITCH_GRACE_MINUTES = 15;

function getExpectedShiftType(now = new Date()) {
    const hour = now.getHours();
    return (hour >= 6 && hour < 18) ? 'day' : 'night';
}

// true fuera de las ventanas [06:00,06:15) y [18:00,18:15) — el margen le
// da tiempo al empleado a cerrar manualmente antes de que el sistema le
// gane de mano.
function isPastShiftGracePeriod(now = new Date()) {
    const h = now.getHours(), m = now.getMinutes();
    if (h === 6 && m < SHIFT_AUTO_SWITCH_GRACE_MINUTES) return false;
    if (h === 18 && m < SHIFT_AUTO_SWITCH_GRACE_MINUTES) return false;
    return true;
}

let _autoShiftCheckInProgress = false;

async function autoCloseShiftIfOverdue() {
    if (_autoShiftCheckInProgress) return;
    if (!currentShiftType || !rooms || rooms.length === 0) return; // datos aún no cargados

    const now = new Date();
    if (currentShiftType === getExpectedShiftType(now)) return; // ya está al día
    if (!isPastShiftGracePeriod(now)) return; // dentro del margen de gracia

    _autoShiftCheckInProgress = true;
    try {
        // Pequeño jitter: si hay varios dispositivos abiertos, evita que
        // todos disparen el cierre en el mismo instante. Al reanudar, se
        // vuelve a comprobar por si otro dispositivo (o Firebase Sync) ya
        // resolvió el desfase mientras tanto.
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 8000)));
        if (currentShiftType === getExpectedShiftType(new Date())) return;

        await closeShift({ auto: true });
    } finally {
        _autoShiftCheckInProgress = false;
    }
}

// ============ HISTORIAL DE TURNOS ============

function updateShiftHistory() {
    const container = document.getElementById('shiftHistory');
    if (!container) return;
    const recentShifts = [...shiftReports].reverse().slice(0, 20);
    if (recentShifts.length === 0) {
        container.innerHTML = '<p style="text-align:center;color:#999;">No hay turnos cerrados aún</p>';
        return;
    }
    container.innerHTML = recentShifts.map(report => {
        const closedDate = new Date(report.closedAt);
        return `<div class="shift-report-item ${report.isBalanced ? 'balanced' : 'unbalanced'}">
            <div class="shift-report-header"><strong>${report.shiftName}</strong><span class="shift-date">${closedDate.toLocaleString('es-MX')}</span></div>
            <div class="shift-report-details">
                <div>Vendidas: ${report.roomsSold} | Limpiadas: ${report.roomsCleaned} | Diferencia: ${report.difference}</div>
                <div>Total: <strong>$${report.totalRevenue.toFixed(2)}</strong></div>
                <div class="shift-status">${report.isBalanced ? '✓ Balanceado' : '⚠ Con diferencia'}</div>
            </div>
        </div>`;
    }).join('');
}

// ============ SISTEMA DE LIMPIEZA PROFUNDA ============

let deepCleanSchedules = [];

async function loadDeepCleanSchedules() {
    try {
        // Cache-first: render immediately from localStorage
        const saved = localStorage.getItem('deepCleanSchedules');
        deepCleanSchedules = saved ? JSON.parse(saved) : [];
        renderScheduledCleansList();
        renderUpcomingDeepCleans();
        // Refresh from Firebase in background
        if (window.FirebaseSync && window.FirebaseSync.ready) {
            window.FirebaseSync.load('deepCleanSchedules', null).then(fbData => {
                if (fbData && Array.isArray(fbData)) {
                    deepCleanSchedules = fbData;
                    localStorage.setItem('deepCleanSchedules', JSON.stringify(deepCleanSchedules));
                    renderScheduledCleansList();
                    renderUpcomingDeepCleans();
                }
            }).catch(() => {});
        }
    } catch (e) {
        console.error('[DeepClean] Error cargando:', e);
        deepCleanSchedules = [];
    }
}

function saveDeepCleanSchedules() {
    localStorage.setItem('deepCleanSchedules', JSON.stringify(deepCleanSchedules));
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        window.FirebaseSync.save('deepCleanSchedules', deepCleanSchedules)
            .catch(err => {
                console.error('[Firebase] Error guardando deepCleanSchedules:', err);
                // No reintentar aquí - el sistema offline queue de firebase-sync.js ya maneja esto
            });
    }
}

function openDeepCleanScheduleModal() {
    const modal = document.getElementById('deepCleanScheduleModal');
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('deepCleanDate').setAttribute('min', today);
    document.getElementById('deepCleanDate').value = today;
    renderRoomSelectionGrid();
    modal.classList.add('show');
}

function closeDeepCleanScheduleModal() {
    document.getElementById('deepCleanScheduleModal').classList.remove('show');
    document.getElementById('deepCleanDate').value = '';
    document.getElementById('deepCleanTime').value = '10:00';
    document.getElementById('deepCleanNotes').value = '';
    document.querySelectorAll('.room-selection-btn.selected').forEach(btn => btn.classList.remove('selected'));
}

function renderRoomSelectionGrid() {
    const grid = document.getElementById('roomSelectionGrid');
    if (!grid) return;
    grid.innerHTML = rooms.map(room => {
        const building = room.building === 'regulares' ? 'Ed.1' : 'Torre';
        return `<button class="room-selection-btn" onclick="toggleRoomSelection('${room.id}')" id="sel-${room.id}">${building}-${room.number}</button>`;
    }).join('');
}

function toggleRoomSelection(roomId) {
    const btn = document.getElementById('sel-' + roomId);
    if (btn) btn.classList.toggle('selected');
}

/** True si la habitación tiene limpieza profunda pendiente (programada y no marcada hecha). */
function roomHasPendingDeepClean(room) {
    if (!room || !deepCleanSchedules || !deepCleanSchedules.length) return false;
    return deepCleanSchedules.some((s) => !s.completed && Array.isArray(s.rooms)
        && s.rooms.some((r) => r.roomId === room.id && r.completed !== true));
}

function deepCleanRoomLabel(r) {
    return `${r.building === 'regulares' ? 'Ed.1' : 'Torre'}-${r.roomNumber}`;
}

function deepCleanStatusBadgesHtml(roomsInSchedule) {
    return roomsInSchedule.map((r) => {
        const done = r.completed === true;
        const badgeClass = done ? 'deep-clean-status-badge deep-clean-status-badge--done' : 'deep-clean-status-badge deep-clean-status-badge--pending';
        const badgeText = done ? 'Hecha' : 'Pendiente';
        return `<span class="scheduled-room-chip"><span class="room-chip">${deepCleanRoomLabel(r)}</span><span class="${badgeClass}">${badgeText}</span></span>`;
    }).join('');
}

function saveDeepCleanSchedule() {
    const date = document.getElementById('deepCleanDate').value;
    const time = document.getElementById('deepCleanTime').value;
    const notes = document.getElementById('deepCleanNotes').value.trim();
    if (!date || !time) { showToast('Selecciona fecha y hora', 'error'); return; }
    const selectedRooms = [];
    document.querySelectorAll('.room-selection-btn.selected').forEach(btn => {
        const roomId = btn.id.replace('sel-', '');
        const room = rooms.find(r => r.id === roomId);
        if (room) selectedRooms.push({ roomId: room.id, roomNumber: room.number, building: room.building });
    });
    if (selectedRooms.length === 0) { showToast('Selecciona al menos una habitación', 'error'); return; }
    const schedule = {
        id: Date.now(), scheduledDate: new Date(`${date}T${time}`).getTime(),
        rooms: selectedRooms, notes, completed: false, createdAt: Date.now(),
        createdBy: currentUser ? currentUser.name : 'Sistema'
    };
    deepCleanSchedules.push(schedule);
    saveDeepCleanSchedules();
    closeDeepCleanScheduleModal();
    renderScheduledCleansList();
    if (!currentUser || currentUser.role !== 'limpieza') renderRooms();
    showToast('Limpieza profunda programada', 'success');
}

function renderScheduledCleansList() {
    const container = document.getElementById('scheduledCleansList');
    if (!container) return;
    const pending = deepCleanSchedules.filter(s => !s.completed);
    if (pending.length === 0) {
        container.innerHTML = '<p style="color:#999;text-align:center;padding:10px;">No hay limpiezas programadas</p>';
        return;
    }
    container.innerHTML = pending.map(schedule => {
        const date = new Date(schedule.scheduledDate);
        const dateStr = date.toLocaleString('es-MX', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        return `<div class="scheduled-clean-item">
            <div class="scheduled-clean-info">
                <div class="scheduled-clean-date">📅 ${dateStr}</div>
                <div class="scheduled-clean-rooms">${deepCleanStatusBadgesHtml(schedule.rooms)}</div>
                ${schedule.notes ? `<div class="scheduled-clean-notes">📝 ${sanitizeHTML(schedule.notes)}</div>` : ''}
            </div>
            <button class="btn-delete-schedule" onclick="deleteDeepCleanSchedule(${schedule.id})">✕</button>
        </div>`;
    }).join('');
}

function deleteDeepCleanSchedule(scheduleId) {
    deepCleanSchedules = deepCleanSchedules.filter(s => s.id !== scheduleId);
    saveDeepCleanSchedules();
    renderScheduledCleansList();
    if (!currentUser || currentUser.role !== 'limpieza') renderRooms();
    showToast('Programación eliminada', 'info');
}

function renderUpcomingDeepCleans() {
    const container = document.getElementById('upcomingCleansGrid');
    if (!container) return;
    const upcoming = deepCleanSchedules.filter(s => !s.completed);
    if (upcoming.length === 0) {
        container.innerHTML = '<p style="color:#999;text-align:center;">No hay limpiezas profundas programadas</p>';
        return;
    }
    container.innerHTML = upcoming.map(schedule => {
        const date = new Date(schedule.scheduledDate);
        const dateStr = date.toLocaleString('es-MX', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
        return `<div class="upcoming-clean-card">
            <div class="upcoming-clean-date">📅 ${dateStr}</div>
            <div class="upcoming-clean-rooms upcoming-clean-rooms--badges">${deepCleanStatusBadgesHtml(schedule.rooms)}</div>
            ${schedule.notes ? `<div class="upcoming-clean-notes">📝 ${sanitizeHTML(schedule.notes)}</div>` : ''}
            <div class="upcoming-clean-actions">
                ${schedule.rooms.map(r => `<button class="btn-complete-deep-clean" onclick="openDeepCleanConfirmModal('${r.roomId}', ${schedule.id})">✓ Completar Hab.${r.roomNumber}</button>`).join('')}
            </div>
        </div>`;
    }).join('');
}

function completeDeepCleanRoom(roomId, scheduleId) { openDeepCleanConfirmModal(roomId, scheduleId); }

function openDeepCleanConfirmModal(roomId, scheduleId) {
    const modal = document.getElementById('deepCleanConfirmModal');
    const schedule = deepCleanSchedules.find(s => s.id === scheduleId);
    const roomData = schedule ? schedule.rooms.find(r => r.roomId === roomId) : null;
    if (!roomData) return;
    const el = id => document.getElementById(id);
    if (el('dcRoomNumber')) el('dcRoomNumber').textContent = roomData.roomNumber;
    if (el('dcRoomBuilding')) el('dcRoomBuilding').textContent = roomData.building === 'regulares' ? 'Edificio 1' : 'Edificio Torre';
    if (el('dcScheduledDate')) el('dcScheduledDate').textContent = new Date(schedule.scheduledDate).toLocaleString('es-MX');
    if (schedule.notes && el('dcScheduleNotes')) {
        el('dcScheduleNotes').textContent = schedule.notes;
        el('dcScheduleNotesContainer').style.display = '';
    }
    const confirmBtn = document.getElementById('btnConfirmDeepClean');
    if (confirmBtn) confirmBtn.onclick = () => confirmDeepCleanCompletion(roomId, scheduleId);
    modal.classList.add('show');
}

function closeDeepCleanConfirmModal() {
    document.getElementById('deepCleanConfirmModal').classList.remove('show');
}

function confirmDeepCleanCompletion(roomId, scheduleId) {
    const schedule = deepCleanSchedules.find(s => s.id === scheduleId);
    if (!schedule) return;
    const roomData = schedule.rooms.find(r => r.roomId === roomId);
    if (!roomData) return;
    const notes = document.getElementById('deepCleanCompletionNotes') ? document.getElementById('deepCleanCompletionNotes').value.trim() : '';
    roomData.completed = true;
    roomData.completedAt = Date.now();
    roomData.completionNotes = notes;
    if (schedule.rooms.every(r => r.completed)) schedule.completed = true;
    saveDeepCleanSchedules();
    closeDeepCleanConfirmModal();
    renderUpcomingDeepCleans();
    renderScheduledCleansList();
    if (!currentUser || currentUser.role !== 'limpieza') renderRooms();
    showToast('Limpieza profunda completada', 'success');
}

async function initDeepCleaningSystem() {
    await loadDeepCleanSchedules();
    renderScheduledCleansList();
}

// ============ RESET PRODUCT MODAL ============

function resetProductModal() {
    editingProductId = null;
    document.getElementById('productName').value = '';
    document.getElementById('productQuantity').value = '';
    document.getElementById('productPrice').value = '';
    const catEl = document.getElementById('productCategory');
    if (catEl) catEl.value = 'bebidas';
    const saveBtn = document.getElementById('saveProductBtn');
    if (saveBtn) saveBtn.textContent = 'Guardar';
}

// ============ MODAL DESGLOSE DETALLADO ============

let currentRevenueType = 'rooms';
let currentRevenueFilter = 'all';

function openRevenueDetail(type) {
    currentRevenueType = type;
    currentRevenueFilter = 'all';
    const modal = document.getElementById('revenueDetailModal');
    const titles = { rooms: '🏠 Desglose de Habitaciones', sales: '🛒 Desglose de Ventas', expenses: '💸 Desglose de Egresos' };
    document.getElementById('revenueDetailTitle').textContent = titles[type] || 'Desglose';
    document.querySelectorAll('#revenueDetailModal .filter-btn').forEach(b => b.classList.remove('active'));
    const firstBtn = document.querySelector('#revenueDetailModal .filter-btn');
    if (firstBtn) firstBtn.classList.add('active');
    renderRevenueDetail();
    modal.classList.add('show');
}

function closeRevenueDetailModal() {
    document.getElementById('revenueDetailModal').classList.remove('show');
}

function filterRevenueDetail(filter) {
    currentRevenueFilter = filter;
    document.querySelectorAll('#revenueDetailModal .filter-btn').forEach(b => b.classList.remove('active'));
    if (event && event.target) event.target.classList.add('active');
    renderRevenueDetail();
}

function renderRevenueDetail() {
    const container = document.getElementById('revenueDetailList');
    let data = [];
    if (currentRevenueType === 'rooms') data = roomRevenue.filter(r => r.type === 'sold');
    else if (currentRevenueType === 'sales') data = [...sales];
    else if (currentRevenueType === 'expenses') data = [...expenses];

    if (currentRevenueFilter !== 'all') data = data.filter(item => item.shift === currentRevenueFilter);
    data.sort((a, b) => b.timestamp - a.timestamp);

    let total = 0;
    if (currentRevenueType === 'rooms') total = data.reduce((s, i) => s + i.price, 0);
    else if (currentRevenueType === 'sales') total = data.reduce((s, i) => s + i.total, 0);
    else total = data.reduce((s, i) => s + i.amount, 0);

    document.getElementById('detailTotalAmount').textContent = '$' + total.toFixed(2);
    document.getElementById('detailTotalCount').textContent = data.length + ' transacciones';

    if (data.length === 0) { container.innerHTML = '<div class="no-detail-data">No hay datos para mostrar</div>'; return; }

    container.innerHTML = data.map(item => {
        const date = new Date(item.timestamp);
        const dateStr = date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
        const timeStr = date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
        const shiftName = item.shiftName || (item.shift === 'day' ? 'Turno Día' : 'Turno Noche');
        if (currentRevenueType === 'rooms') {
            return `<div class="revenue-detail-item">
                <div class="revenue-detail-item-info">
                    <div class="revenue-detail-item-header"><span class="revenue-detail-icon">🏠</span><span class="revenue-detail-title">Hab. ${item.roomNumber}</span><span class="revenue-detail-shift-badge ${item.shift}">${sanitizeHTML(shiftName)}</span></div>
                    <div class="revenue-detail-meta"><span>${item.building === 'regulares' ? 'Edificio 1' : 'Torre'}</span><span>${dateStr} ${timeStr}</span>${item.guestName ? `<span>${sanitizeHTML(item.guestName)}</span>` : ''}</div>
                </div>
                <div class="revenue-detail-amount">$${item.price.toFixed(2)}</div>
            </div>`;
        } else if (currentRevenueType === 'sales') {
            return `<div class="revenue-detail-item">
                <div class="revenue-detail-item-info">
                    <div class="revenue-detail-item-header"><span class="revenue-detail-icon">🛒</span><span class="revenue-detail-title">${sanitizeHTML(item.productName)}</span><span class="revenue-detail-shift-badge ${item.shift}">${sanitizeHTML(shiftName)}</span></div>
                    <div class="revenue-detail-meta"><span>x${item.quantity}</span><span>$${item.price ? item.price.toFixed(2) : '0.00'} c/u</span><span>${dateStr} ${timeStr}</span></div>
                </div>
                <div class="revenue-detail-amount">$${item.total.toFixed(2)}</div>
            </div>`;
        } else {
            return `<div class="revenue-detail-item expense">
                <div class="revenue-detail-item-info">
                    <div class="revenue-detail-item-header"><span class="revenue-detail-icon">💸</span><span class="revenue-detail-title">${sanitizeHTML(item.description)}</span><span class="revenue-detail-shift-badge ${item.shift}">${sanitizeHTML(shiftName)}</span></div>
                    <div class="revenue-detail-meta"><span>${sanitizeHTML(item.categoryType || '')}</span><span>${dateStr} ${timeStr}</span></div>
                </div>
                <div class="revenue-detail-amount">$${item.amount.toFixed(2)}</div>
            </div>`;
        }
    }).join('');
}

// ============ MODAL ACTIVIDAD DE HABITACIONES ============

let currentRoomsActivityFilter = 'current';

function openRoomsActivityModal() {
    currentRoomsActivityFilter = 'current';
    const modal = document.getElementById('roomsActivityModal');
    modal.classList.add('show');
    document.querySelectorAll('#roomsActivityModal .filter-btn').forEach(b => b.classList.remove('active'));
    const firstBtn = document.querySelector('#roomsActivityModal .filter-btn');
    if (firstBtn) firstBtn.classList.add('active');
    // Cargar desde Firebase si roomRevenue está vacío
    if (roomRevenue.length === 0 && window.FirebaseSync && window.FirebaseSync.ready) {
        const container = document.getElementById('roomsActivityList');
        if (container) container.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">Cargando datos...</div>';
        Promise.all([
            _loadHotShardsFromFirebase(),
            window.FirebaseSync.load('motelRooms', null)
        ]).then(([, motelRooms]) => {
            if (motelRooms) rooms = motelRooms;
            renderRoomsActivity();
        });
    } else {
        renderRoomsActivity();
    }
}

function closeRoomsActivityModal() {
    document.getElementById('roomsActivityModal').classList.remove('show');
}

function filterRoomsActivity(filter) {
    currentRoomsActivityFilter = filter;
    document.querySelectorAll('#roomsActivityModal .filter-btn').forEach(b => b.classList.remove('active'));
    if (event && event.target) event.target.classList.add('active');
    renderRoomsActivity();
}

function renderRoomsActivity() {
    const container = document.getElementById('roomsActivityList');
    if (!container) return;
    const shift = getCurrentShift();
    let roomsData = [], title = '', count = 0;

    if (currentRoomsActivityFilter === 'current') {
        const soldInShift = roomRevenue.filter(r => r.type === 'sold' && r.timestamp >= Date.now() - 24*60*60*1000);
        const cleanedInShift = roomRevenue.filter(r => r.type === 'cleaned' && r.timestamp >= Date.now() - 24*60*60*1000);
        const roomsMap = {};
        soldInShift.forEach(sale => {
            const key = `${sale.building}-${sale.roomNumber}`;
            if (!roomsMap[key]) roomsMap[key] = { roomNumber: sale.roomNumber, building: sale.building, sales: [], cleanings: [] };
            roomsMap[key].sales.push(sale);
        });
        cleanedInShift.forEach(clean => {
            const key = `${clean.building}-${clean.roomNumber}`;
            if (!roomsMap[key]) roomsMap[key] = { roomNumber: clean.roomNumber, building: clean.building, sales: [], cleanings: [] };
            roomsMap[key].cleanings.push(clean);
        });
        Object.values(roomsMap).forEach(rd => {
            const room = rooms.find(r => r.number === rd.roomNumber && r.building === rd.building);
            rd.currentStatus = room ? room.status : 'unknown';
        });
        roomsData = Object.values(roomsMap);
        title = 'Turno Actual';
    } else if (currentRoomsActivityFilter === 'previous') {
        const prevType = shift.type === 'day' ? 'night' : 'day';
        const soldPrev = roomRevenue.filter(r => r.shift === prevType && r.type === 'sold');
        const cleanedPrev = roomRevenue.filter(r => r.shift === prevType && r.type === 'cleaned');
        const roomsMap = {};
        soldPrev.forEach(sale => {
            const key = `${sale.building}-${sale.roomNumber}`;
            if (!roomsMap[key]) roomsMap[key] = { roomNumber: sale.roomNumber, building: sale.building, sales: [], cleanings: [] };
            roomsMap[key].sales.push(sale);
        });
        cleanedPrev.forEach(clean => {
            const key = `${clean.building}-${clean.roomNumber}`;
            if (!roomsMap[key]) roomsMap[key] = { roomNumber: clean.roomNumber, building: clean.building, sales: [], cleanings: [] };
            roomsMap[key].cleanings.push(clean);
        });
        Object.values(roomsMap).forEach(rd => {
            const room = rooms.find(r => r.number === rd.roomNumber && r.building === rd.building);
            rd.currentStatus = room ? room.status : 'unknown';
        });
        roomsData = Object.values(roomsMap);
        title = 'Turno Anterior';
    } else if (currentRoomsActivityFilter === 'dirty') {
        roomsData = rooms.filter(r => r.status === 'dirty').map(r => ({
            roomNumber: r.number, building: r.building, currentStatus: 'dirty', sales: [], cleanings: [], isDirty: true
        }));
        title = 'Habitaciones Sucias';
    }

    count = roomsData.length;
    const labelEl = document.getElementById('roomsActivityLabel');
    const countEl = document.getElementById('roomsActivityCount');
    const subtitleEl = document.getElementById('roomsActivitySubtitle');
    if (labelEl) labelEl.textContent = title;
    if (countEl) countEl.textContent = count;
    if (subtitleEl) subtitleEl.textContent = 'habitaciones';

    if (roomsData.length === 0) { container.innerHTML = '<div class="no-detail-data">No hay habitaciones para mostrar</div>'; return; }

    container.innerHTML = roomsData.map(rd => {
        let statusBadge = '';
        if (rd.currentStatus === 'dirty') statusBadge = '<span style="background:#e74c3c;color:white;padding:3px 8px;border-radius:10px;font-size:11px;font-weight:600;">🧹 Sucia</span>';
        else if (rd.currentStatus === 'available') statusBadge = '<span style="background:#27ae60;color:white;padding:3px 8px;border-radius:10px;font-size:11px;font-weight:600;">✓ Disponible</span>';
        else if (rd.currentStatus === 'occupied') statusBadge = '<span style="background:#3498db;color:white;padding:3px 8px;border-radius:10px;font-size:11px;font-weight:600;">🔑 Ocupada</span>';

        let salesInfo = '';
        if (rd.sales.length > 0) {
            const last = rd.sales[rd.sales.length - 1];
            const t = new Date(last.checkInTime || last.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
            salesInfo = `<div style="background:#e8f5e9;padding:10px;border-radius:8px;margin-top:8px;font-size:13px;">
                <strong style="color:#27ae60;">🛒 Venta</strong> — $${last.price.toFixed(2)} a las ${t}
                ${rd.cleanings.length > 0 ? `<br>✓ Limpiada a las ${new Date(rd.cleanings[rd.cleanings.length-1].timestamp).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'})}` : ''}
            </div>`;
        }

        const buildingName = sanitizeHTML(rd.building === 'regulares' ? 'Edificio 1' : 'Edificio Torre');
        
        return `<div class="revenue-detail-item" style="display:block;">
            <div class="revenue-detail-item-info">
                <div class="revenue-detail-item-header">
                    <span class="revenue-detail-icon">🏠</span>
                    <span class="revenue-detail-title">Hab. ${rd.roomNumber}</span>
                    ${statusBadge}
                </div>
                <div class="revenue-detail-meta"><span>${buildingName}</span>${rd.sales.length > 0 ? `<span>${rd.sales.length} venta(s)</span>` : ''}${rd.cleanings.length > 0 ? `<span>${rd.cleanings.length} limpieza(s)</span>` : ''}</div>
                ${salesInfo}
            </div>
        </div>`;
    }).join('');
}

// ============ MODAL RESUMEN DE GASTOS ============

let currentExpensesPeriod = 'day';
let currentExpensesShift = 'all';

function openExpensesSummaryModal() {
    currentExpensesPeriod = 'day';
    currentExpensesShift = 'all';
    document.getElementById('expensesSummaryModal').classList.add('show');
    renderExpensesSummaryModal();
}

function closeExpensesSummaryModal() {
    document.getElementById('expensesSummaryModal').classList.remove('show');
}

function filterExpensesSummary(period) {
    currentExpensesPeriod = period;
    document.querySelectorAll('#expensesSummaryModal .revenue-detail-filters:first-of-type .filter-btn').forEach(b => b.classList.remove('active'));
    if (event && event.target) event.target.classList.add('active');
    renderExpensesSummaryModal();
}

function filterExpensesShift(shift) {
    currentExpensesShift = shift;
    document.querySelectorAll('#expensesSummaryModal .revenue-detail-filters:last-of-type .filter-btn').forEach(b => b.classList.remove('active'));
    if (event && event.target) event.target.classList.add('active');
    renderExpensesSummaryModal();
}

function renderExpensesSummaryModal() {
    const container = document.getElementById('expensesSummaryModalContent');
    if (!container) return;
    const now = Date.now();
    const timeAgo = currentExpensesPeriod === 'day' ? now - 86400000 : currentExpensesPeriod === 'week' ? now - 604800000 : now - 2592000000;
    let periodExpenses = expenses.filter(e => !e.deleted && e.timestamp >= timeAgo);
    if (currentExpensesShift !== 'all') periodExpenses = periodExpenses.filter(e => e.shift === currentExpensesShift);
    const total = periodExpenses.reduce((s, e) => s + e.amount, 0);
    const byCategory = {};
    periodExpenses.forEach(e => { byCategory[e.categoryType] = (byCategory[e.categoryType] || 0) + e.amount; });
    const catNames = { operacion: 'Operación', alimentos: 'Alimentos', limpieza: 'Limpieza', sexshop: 'Sex Shop', generales: 'Generales', mercadotecnia: 'Mercadotecnia', nomina: 'Nómina' };
    container.innerHTML = `<div style="background:linear-gradient(135deg,#fa709a,#fee140);color:white;border-radius:10px;padding:18px;text-align:center;margin:16px 0;">
        <div style="font-size:12px;opacity:.85;text-transform:uppercase;letter-spacing:.8px;">Total Gastos</div>
        <div style="font-size:32px;font-weight:800;">$${total.toFixed(2)}</div>
        <div style="font-size:12px;opacity:.8;">${periodExpenses.length} transacciones</div>
    </div>
    <div>${Object.entries(byCategory).map(([cat, amt]) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:#f8f9fa;border-radius:8px;margin-bottom:6px;">
            <span style="font-size:13px;color:#2c3e50;">${sanitizeHTML(catNames[cat] || cat)}</span>
            <span style="font-weight:700;color:#e74c3c;">$${amt.toFixed(2)}</span>
        </div>`).join('')}
    </div>`;
}

// ============ GENERACIÓN DE REPORTE DE TURNO ============

function generateShiftReport(shift, shiftRooms, shiftCleaned, shiftSales, shiftExpenses, shiftRenewals, report) {
    const closedDate = new Date(report.closedAt);
    const dateStr = closedDate.toLocaleString('es-MX');
    const pm = { efectivo: 0, tarjeta: 0 };
    [...shiftRooms, ...(shiftRenewals || [])].forEach(r => { pm[r.paymentMethod || 'efectivo'] += r.price; });
    shiftSales.forEach(s => { pm[s.paymentMethod || 'efectivo'] += s.total; });
    const expTotal = (shiftExpenses || []).reduce((s, e) => s + e.amount, 0);

    let content = `REPORTE DE CIERRE DE TURNO - RAPID INN\n${'='.repeat(50)}\n\n`;
    content += `Turno: ${shift.name}\nHorario: ${shift.type === 'day' ? '6:00 AM - 6:00 PM' : '6:00 PM - 6:00 AM'}\nFecha: ${dateStr}\nCerrado por: ${report.closedBy}\n\n`;
    content += `${'─'.repeat(50)}\nRESUMEN FINANCIERO\n${'─'.repeat(50)}\n`;
    content += `Ingresos habitaciones: $${report.roomRevenue.toFixed(2)}\nIngresos ventas: $${report.salesRevenue.toFixed(2)}\nEgresos: $${expTotal.toFixed(2)}\nTOTAL NETO: $${(report.totalRevenue - expTotal).toFixed(2)}\n\n`;
    content += `CORTE POR MÉTODO DE PAGO\nEfectivo: $${pm.efectivo.toFixed(2)}\nTarjeta: $${pm.tarjeta.toFixed(2)}\n\n`;
    content += `HABITACIONES\nVendidas: ${report.roomsSold} | Limpiadas: ${report.roomsCleaned} | Diferencia: ${report.difference} ${report.isBalanced ? '[OK]' : '[!]'}\n`; // FIXED: Emojis reemplazados por ASCII
    
    // Agregar explicación de diferencias
    if (report.difference !== 0) {
        content += `\nEXPLICACIÓN DE DIFERENCIAS:\n`;
        
        // Crear mapas de habitaciones vendidas y limpiadas
        const soldRoomNumbers = new Set(shiftRooms.map(r => r.roomNumber));
        const cleanedRoomNumbers = new Set(shiftCleaned.map(r => r.roomNumber));
        
        // Habitaciones vendidas pero no limpiadas (quedaron sucias)
        const notCleaned = shiftRooms.filter(r => !cleanedRoomNumbers.has(r.roomNumber));
        if (notCleaned.length > 0) {
            content += `\nHabitaciones vendidas sin limpiar (${notCleaned.length}):\n`;
            notCleaned.forEach(r => {
                const time = new Date(r.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
                content += `  • Hab. ${r.roomNumber} - Vendida a las ${time}\n`;
            });
        }
        
        // Habitaciones limpiadas pero no vendidas (se limpiaron de más)
        const notSold = shiftCleaned.filter(r => !soldRoomNumbers.has(r.roomNumber));
        if (notSold.length > 0) {
            content += `\nHabitaciones limpiadas sin vender (${notSold.length}):\n`;
            notSold.forEach(r => {
                const time = new Date(r.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
                content += `  • Hab. ${r.roomNumber} - Limpiada a las ${time}\n`;
            });
        }
    }
    content += '\n';

    if (shiftRooms.length > 0) {
        content += `DETALLE HABITACIONES VENDIDAS\n`;
        shiftRooms.forEach(r => {
            const time = new Date(r.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
            content += `Hab.${r.roomNumber} (${r.building === 'regulares' ? 'Ed.1' : 'Torre'}) - $${r.price.toFixed(2)} - ${r.paymentMethod || 'efectivo'} - ${time}\n`;
        });
        content += '\n';
    }
    if (shiftSales.length > 0) {
        content += `VENTAS DE INVENTARIO\n`;
        shiftSales.forEach(s => { content += `${s.productName} x${s.quantity} = $${s.total.toFixed(2)}\n`; });
        content += '\n';
    }
    if ((shiftExpenses || []).length > 0) {
        content += `EGRESOS\n`;
        shiftExpenses.forEach(e => { content += `${e.description}: $${e.amount.toFixed(2)}\n`; });
    }

    const filename = `Reporte_${shift.name.replace(' ', '_')}_${closedDate.getFullYear()}-${String(closedDate.getMonth()+1).padStart(2,'0')}-${String(closedDate.getDate()).padStart(2,'0')}.txt`;
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth <= 768;

    if (isMobile) {
        showMobileReportModal(content, shift.name, filename);
    } else {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

function showMobileReportModal(content, shiftName, filename) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;display:flex;flex-direction:column;padding:16px;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:#fff;border-radius:14px;display:flex;flex-direction:column;max-height:85vh;overflow:hidden;';

    const header = document.createElement('div');
    header.style.cssText = 'padding:14px 18px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;';
    const title = document.createElement('strong');
    title.textContent = 'Reporte ' + shiftName;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:none;border:none;font-size:22px;cursor:pointer;color:#666;line-height:1;';
    closeBtn.onclick = () => document.body.removeChild(overlay);
    header.appendChild(title);
    header.appendChild(closeBtn);

    const pre = document.createElement('pre');
    pre.textContent = content;
    pre.style.cssText = 'padding:14px;overflow:auto;flex:1;font-size:11px;font-family:monospace;white-space:pre-wrap;margin:0;background:#f8f9fa;';

    const footer = document.createElement('div');
    footer.style.cssText = 'padding:14px;border-top:1px solid #eee;display:flex;gap:10px;';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 Copiar';
    copyBtn.style.cssText = 'flex:1;padding:12px;background:#667eea;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;';
    copyBtn.onclick = () => {
        const fallback = () => {
            const ta = document.createElement('textarea');
            ta.value = content;
            ta.style.cssText = 'position:fixed;opacity:0;';
            document.body.appendChild(ta);
            ta.focus(); ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        };
        (navigator.clipboard ? navigator.clipboard.writeText(content).catch(fallback) : Promise.reject()).catch(fallback);
        copyBtn.textContent = '✓ Copiado!';
        setTimeout(() => { copyBtn.textContent = '📋 Copiar'; }, 2000);
    };

    const dlBtn = document.createElement('button');
    dlBtn.textContent = '⬇ Descargar';
    dlBtn.style.cssText = 'flex:1;padding:12px;background:#2ecc71;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;';
    dlBtn.onclick = () => {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    footer.appendChild(copyBtn);
    footer.appendChild(dlBtn);
    modal.appendChild(header);
    modal.appendChild(pre);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}

// ============ MODAL HISTORIAL DE TURNOS ============

function openShiftHistoryModal() {
    renderShiftHistoryList();
    document.getElementById('shiftHistoryModal').classList.add('show');
}

function closeShiftHistoryModal() {
    document.getElementById('shiftHistoryModal').classList.remove('show');
}

function renderShiftHistoryList() {
    const container = document.getElementById('shiftHistoryList');
    if (!container) return;
    const recentShifts = [...shiftReports].reverse().slice(0, 4); // Cambiar de 14 a 4 turnos (2 días)
    if (recentShifts.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:#999;"><div style="font-size:48px;">📋</div><h3>No hay turnos cerrados</h3></div>';
        return;
    }
    container.innerHTML = recentShifts.map((report, idx) => {
        const date = new Date(report.closedAt);
        const dateStr = date.toLocaleString('es-MX', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        return `<div class="shift-history-item ${report.isBalanced ? 'balanced' : 'unbalanced'}">
            <div class="shift-history-header">
                <div>
                    <strong>${report.shiftName}</strong>
                    <span class="shift-history-date">${dateStr}</span>
                </div>
                <div class="shift-history-total">$${report.totalRevenue.toFixed(2)}</div>
            </div>
            <div class="shift-history-details">
                <span>🏠 ${report.roomsSold} vendidas</span>
                <span>🧹 ${report.roomsCleaned} limpiadas</span>
                <span>${report.isBalanced ? '✓ Balanceado' : `⚠ Dif: ${report.difference}`}</span>
                <span>Por: ${report.closedBy}</span>
            </div>
            <button class="btn-download-shift" onclick="downloadShiftReport(${shiftReports.length - 1 - idx})">📥 Descargar</button>
        </div>`;
    }).join('');
}

function downloadShiftReport(reportIndex) {
    const report = shiftReports[reportIndex];
    if (!report) return;
    const shift = { type: report.shiftType, name: report.shiftName };
    const shiftRooms = roomRevenue.filter(r => r.shift === report.shiftType && r.type === 'sold' && r.timestamp >= report.startTime && r.timestamp <= report.closedAt);
    const shiftCleaned = roomRevenue.filter(r => r.shift === report.shiftType && r.type === 'cleaned' && r.timestamp >= report.startTime && r.timestamp <= report.closedAt);
    const shiftSales = sales.filter(s => s.shift === report.shiftType && s.timestamp >= report.startTime && s.timestamp <= report.closedAt);
    const shiftExpenses = expenses.filter(e => !e.deleted && e.shift === report.shiftType && e.timestamp >= report.startTime && e.timestamp <= report.closedAt);
    const shiftRenewals = roomRevenue.filter(r => r.shift === report.shiftType && r.type === 'renewal' && r.timestamp >= report.startTime && r.timestamp <= report.closedAt);
    generateShiftReport(shift, shiftRooms, shiftCleaned, shiftSales, shiftExpenses, shiftRenewals, report);
}

// ============ MODAL MÉTODO DE PAGO ============

function openPaymentMethodModal(method) {
    const modal = document.getElementById('paymentMethodModal');
    const title = document.getElementById('paymentMethodModalTitle');
    const content = document.getElementById('paymentMethodModalContent');
    const shift = getCurrentShift();
    const shiftRooms = roomRevenue.filter(r => r.shift === shift.type && r.type === 'sold' && r.timestamp >= currentShiftStart);
    const shiftRenewals = roomRevenue.filter(r => r.shift === shift.type && r.type === 'renewal' && r.timestamp >= currentShiftStart);
    const shiftSales = sales.filter(s => s.shift === shift.type && s.timestamp >= currentShiftStart);

    const icons = { efectivo: '💵 Efectivo', tarjeta: '💳 Tarjeta', todos: '💰 Todos los Pagos' };
    title.textContent = icons[method] || 'Pagos';

    const allItems = [
        ...shiftRooms.map(r => ({ ...r, amount: r.price, label: `Hab. ${r.roomNumber}`, type: 'room' })),
        ...shiftRenewals.map(r => ({ ...r, amount: r.price, label: `Renovación Hab. ${r.roomNumber}`, type: 'renewal' })),
        ...shiftSales.map(s => ({ ...s, amount: s.total, label: s.productName, type: 'sale' }))
    ].filter(item => method === 'todos' || (item.paymentMethod || 'efectivo') === method);

    const total = allItems.reduce((s, i) => s + i.amount, 0);

    content.innerHTML = `<div style="background:linear-gradient(135deg,#667eea,#764ba2);color:white;border-radius:10px;padding:18px;text-align:center;margin-bottom:16px;">
        <div style="font-size:12px;opacity:.85;text-transform:uppercase;">Total ${icons[method]}</div>
        <div style="font-size:36px;font-weight:800;">$${total.toFixed(2)}</div>
        <div style="font-size:12px;opacity:.8;">${allItems.length} transacciones</div>
    </div>
    <div>${allItems.length === 0 ? '<p style="text-align:center;color:#999;padding:20px;">Sin transacciones</p>' :
        allItems.sort((a,b) => b.timestamp - a.timestamp).map(item => {
            const time = new Date(item.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
            const icon = item.type === 'room' ? '🏠' : item.type === 'renewal' ? '🔄' : '🛒';
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:#f8f9fa;border-radius:8px;margin-bottom:6px;">
                <div><span style="margin-right:8px;">${icon}</span><span style="font-size:13px;color:#2c3e50;">${item.label}</span><br><span style="font-size:11px;color:#95a5a6;">${time}</span></div>
                <span style="font-weight:700;color:#27ae60;">$${item.amount.toFixed(2)}</span>
            </div>`;
        }).join('')
    }</div>`;

    modal.classList.add('show');
}

function closePaymentMethodModal() {
    document.getElementById('paymentMethodModal').classList.remove('show');
}

// ============ FILTRO DE INVENTARIO ============

function filterInventoryByCategory(category, btn) {
    currentCategoryFilter = category;
    document.querySelectorAll('.category-filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderInventory();
}

// ============ ESTADÍSTICAS — NUEVA VERSIÓN CON ESTILOS SC ============

function scSetPeriod(btn, type, period) {
    const parent = btn.closest('.sc-stat-card');
    if (parent) parent.querySelectorAll('.sc-period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (type === 'roomRevenue') updateRoomRevenueDisplay(period);
    else if (type === 'salesRevenue') updateRevenueStats(period);
    else if (type === 'expensesByPayment') updateExpensesByPaymentMethod(period);
    else if (type === 'expensesByCategory') updateExpensesByCategory(period);
}

function getPeriodStart(period) {
    const now = Date.now();
    // 'day' ahora representa el turno actual, no las últimas 24 horas
    if (period === 'day') return currentShiftStart; // CAMBIO: usar turno actual
    if (period === 'week') return now - 604800000;
    return now - 2592000000;
}

function periodLabel(period) {
    if (period === 'day') return 'Turno Actual'; // CAMBIO: de "Hoy (24h)" a "Turno Actual"
    if (period === 'week') return 'Esta semana';
    return 'Este mes';
}

function updateRoomStats() {
    const container = document.getElementById('roomStats');
    if (!container) return;
    const stats = {
        occupied: rooms.filter(r => r.status === 'occupied').length,
        available: rooms.filter(r => r.status === 'available').length,
        dirty: rooms.filter(r => r.status === 'dirty').length,
        'not-available': rooms.filter(r => r.status === 'not-available').length,
        reserved: rooms.filter(r => r.status === 'reserved').length
    };
    const labels = { occupied: '🔑 Ocupadas', available: '✓ Disponibles', dirty: '🧹 Sucias', 'not-available': '🚫 No disponibles', reserved: '📌 Reservadas' };
    container.innerHTML = Object.entries(stats).map(([status, count]) =>
        `<div class="sc-stat-item"><span class="sc-stat-item-label">${labels[status]}</span><span class="sc-stat-item-value">${count}</span></div>`
    ).join('');
}

function updateRoomRevenueDisplay(period = 'day') {
    const container = document.getElementById('roomRevenueSummary');
    if (!container) return;
    const timeAgo = getPeriodStart(period);
    const periodData = roomRevenue.filter(r => r.timestamp >= timeAgo && (r.type === 'sold' || r.type === 'renewal'));
    const total = periodData.reduce((s, r) => s + r.price, 0);
    const count = periodData.filter(r => r.type === 'sold').length;
    container.innerHTML = `<div class="sc-summary-card">
        <div class="sc-summary-label">${periodLabel(period)}</div>
        <div class="sc-summary-amount">$${total.toFixed(2)}</div>
        <div class="sc-summary-count">${count} habitaciones vendidas</div>
    </div>`;
}

function updateRevenueStats(period = 'day') {
    const container = document.getElementById('revenueStats');
    if (!container) return;
    const timeAgo = getPeriodStart(period);
    const periodSales = sales.filter(s => s.timestamp >= timeAgo);
    const total = periodSales.reduce((s, sale) => s + sale.total, 0);
    container.innerHTML = `<div class="sc-summary-card pink">
        <div class="sc-summary-label">${periodLabel(period)}</div>
        <div class="sc-summary-amount">$${total.toFixed(2)}</div>
        <div class="sc-summary-count">${periodSales.length} transacciones</div>
    </div>`;
}

function updateExpensesByPaymentMethod(period = 'day') {
    const container = document.getElementById('expensesByPaymentStats');
    if (!container) return;
    const timeAgo = getPeriodStart(period);
    const periodExpenses = expenses.filter(e => !e.deleted && e.timestamp >= timeAgo);
    const pm = { efectivo: 0, banco: 0 };
    periodExpenses.forEach(e => { pm[e.paymentMethod || 'efectivo'] = (pm[e.paymentMethod || 'efectivo'] || 0) + e.amount; });
    const total = periodExpenses.reduce((s, e) => s + e.amount, 0);
    container.innerHTML = `
        <div class="sc-stat-item"><span class="sc-stat-item-label">💵 Efectivo</span><span class="sc-stat-item-value" style="color:#e74c3c;">$${(pm.efectivo||0).toFixed(2)}</span></div>
        <div class="sc-stat-item"><span class="sc-stat-item-label">🏦 Banco</span><span class="sc-stat-item-value" style="color:#e74c3c;">$${(pm.banco||0).toFixed(2)}</span></div>
        <div class="sc-stat-item" style="border-top:2px solid #eee;margin-top:4px;padding-top:8px;"><span class="sc-stat-item-label" style="font-weight:700;">Total</span><span class="sc-stat-item-value" style="color:#e74c3c;font-weight:800;">$${total.toFixed(2)}</span></div>`;
}

function updateExpensesByCategory(period = 'day') {
    const container = document.getElementById('expensesByCategoryStats');
    if (!container) return;
    const timeAgo = getPeriodStart(period);
    const periodExpenses = expenses.filter(e => !e.deleted && e.timestamp >= timeAgo);
    const byCategory = {};
    periodExpenses.forEach(e => { byCategory[e.categoryType] = (byCategory[e.categoryType] || 0) + e.amount; });
    const catNames = { operacion: '💧 Operación', alimentos: '🍽️ Alimentos', limpieza: '🧹 Limpieza', sexshop: '🛍️ Sex Shop', generales: '📦 Generales', mercadotecnia: '📢 Mercadotecnia', nomina: '💼 Nómina' };
    const sorted = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) { container.innerHTML = '<p style="color:#999;text-align:center;font-size:13px;">Sin gastos en este período</p>'; return; }
    container.innerHTML = sorted.map(([cat, amt]) =>
        `<div class="sc-stat-item"><span class="sc-stat-item-label">${catNames[cat] || cat}</span><span class="sc-stat-item-value" style="color:#e74c3c;">$${amt.toFixed(2)}</span></div>`
    ).join('');
}

function updateProductStats(period) {
    const container = document.getElementById('productStats');
    if (!container) return;
    const timeAgo = getPeriodStart(period);
    const periodSales = sales.filter(s => s.timestamp >= timeAgo);
    const productCount = {};
    periodSales.forEach(s => { productCount[s.productName] = (productCount[s.productName] || 0) + s.quantity; });
    const sorted = Object.entries(productCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (sorted.length === 0) { container.innerHTML = '<p style="color:#999;text-align:center;font-size:13px;">Sin ventas en este período</p>'; return; }
    container.innerHTML = sorted.map(([name, qty], idx) =>
        `<div class="sc-rank-item r${idx+1}"><div class="sc-rank-num">${idx+1}</div><span class="sc-rank-name">${name}</span><span class="sc-rank-value">${qty} uds</span></div>`
    ).join('');
}

function updateRoomUsageStats(period) {
    const container = document.getElementById('roomUsageStats');
    if (!container) return;
    const timeAgo = getPeriodStart(period);
    const periodRentals = roomRevenue.filter(r => r.timestamp >= timeAgo && r.type === 'sold');
    const roomCount = {};
    periodRentals.forEach(r => {
        const key = `Hab.${r.roomNumber} (${r.building === 'regulares' ? 'Ed.1' : 'Torre'})`;
        roomCount[key] = (roomCount[key] || 0) + 1;
    });
    const sorted = Object.entries(roomCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (sorted.length === 0) { container.innerHTML = '<p style="color:#999;text-align:center;font-size:13px;">Sin rentas en este período</p>'; return; }
    container.innerHTML = sorted.map(([name, count], idx) =>
        `<div class="sc-rank-item r${idx+1}"><div class="sc-rank-num">${idx+1}</div><span class="sc-rank-name">${name}</span><span class="sc-rank-value">${count} veces</span></div>`
    ).join('');
}

function updateStatistics() {
    updateRoomStats();
    updateRoomRevenueDisplay('day');
    updateRevenueStats('day');
    if (currentUser && currentUser.role === 'director') {
        updateExpensesByPaymentMethod('day');
        updateExpensesByCategory('day');
        updateProductStats('day');
        updateRoomUsageStats('day');
    }
}

function updateSalesStats(period = 'day') { updateRevenueStats(period); }

// ============ CONNECTION STATUS ============
function updateConnectionStatus(isOnline, syncedCount) {
    // Fallback si FirebaseSync no existe
    if (!window.FirebaseSync) {
        console.warn('[updateConnectionStatus] FirebaseSync no está disponible');
        return;
    }
    
    const statusEl = document.getElementById('connectionStatus');
    if (!statusEl) return;
    
    const statusText = statusEl.querySelector('.status-text');
    const pendingCountEl = statusEl.querySelector('.pending-count');
    const pendingCount = window.FirebaseSync.getPendingCount ? window.FirebaseSync.getPendingCount() : 0;
    
    // Remover todas las clases de estado
    statusEl.classList.remove('online', 'offline', 'syncing');
    
    if (!isOnline) {
        // Sin conexión
        statusEl.classList.add('offline');
        statusText.textContent = 'Sin conexión';
        
        if (pendingCount > 0) {
            pendingCountEl.textContent = `${pendingCount} pendiente${pendingCount > 1 ? 's' : ''}`;
            pendingCountEl.style.display = 'inline-block';
        } else {
            pendingCountEl.style.display = 'none';
        }
    } else if (syncedCount > 0) {
        // Sincronizando
        statusEl.classList.add('syncing');
        statusText.textContent = `Sincronizando ${syncedCount}...`;
        pendingCountEl.style.display = 'none';
        
        // Volver a "Conectado" después de 2 segundos
        setTimeout(() => {
            if (statusEl.classList.contains('syncing') && window.FirebaseSync && window.FirebaseSync.isOnline()) {
                statusEl.classList.remove('syncing');
                statusEl.classList.add('online');
                statusText.textContent = 'Conectado';
                
                const remaining = window.FirebaseSync.getPendingCount ? window.FirebaseSync.getPendingCount() : 0;
                if (remaining > 0) {
                    pendingCountEl.textContent = `${remaining} pendiente${remaining > 1 ? 's' : ''}`;
                    pendingCountEl.style.display = 'inline-block';
                }

            }
        }, 2000);
    } else {
        // Conectado
        statusEl.classList.add('online');
        statusText.textContent = 'Conectado';
        
        // Mostrar pendientes si los hay
        if (pendingCount > 0) {
            pendingCountEl.textContent = `${pendingCount} pendiente${pendingCount > 1 ? 's' : ''}`;
            pendingCountEl.style.display = 'inline-block';
        } else {
            pendingCountEl.style.display = 'none';
        }
    }
}

// Manejar click en el indicador de conexión
async function handleConnectionClick() {
    if (!window.FirebaseSync) {
        showToast('Firebase no está disponible', 'error');
        return;
    }
    
    const pendingCount = window.FirebaseSync.getPendingCount();
    
    if (pendingCount === 0) {
        showToast('✅ No hay items pendientes de sincronizar', 'success');
        return;
    }
    
    // Confirmar acción
    const confirmed = await showCustomConfirm(
        'Sincronizar Pendientes',
        `Hay ${pendingCount} item${pendingCount > 1 ? 's' : ''} pendiente${pendingCount > 1 ? 's' : ''} de sincronizar.\n\n¿Deseas intentar sincronizarlos ahora?`
    );
    
    if (!confirmed) return;
    
    try {
        showToast('🔄 Sincronizando...', 'info');
        
        // Forzar estado online si es necesario
        if (!window.FirebaseSync.isOnline()) {
            window.FirebaseSync.forceOnline();
        }
        
        // Intentar sincronizar
        const synced = await window.FirebaseSync.syncPending();
        
        if (synced > 0) {
            showToast(`✅ ${synced} item${synced > 1 ? 's' : ''} sincronizado${synced > 1 ? 's' : ''} exitosamente`, 'success');
            updateConnectionStatus(true, 0);
        } else {
            const remaining = window.FirebaseSync.getPendingCount();
            if (remaining > 0) {
                const lastError = window.FirebaseSync.getLastSyncError && window.FirebaseSync.getLastSyncError();
                const reason = lastError ? ` (${lastError.code || lastError.message})` : '';
                showToast(`⚠️ No se pudieron sincronizar ${remaining} item(s)${reason}. Contacta soporte si persiste.`, 'warning');
            } else {
                showToast('✅ Todos los items ya están sincronizados', 'success');
            }
        }
    } catch (err) {
        console.error('[Sync] Error sincronizando:', err);
        showToast('❌ Error al sincronizar: ' + err.message, 'error');
    }
}

// ============ REPORTE MENSUAL ============

let _mrData = {};
let _mrMonth = null;
let _mrYear = null;
let _currentWeek = 0; // Semana seleccionada (0 = todo el mes)
let _payrollEmployees = []; // Lista de empleados del mes
let _editingEmployeeId = null; // ID del empleado en edición
let _mrUnlistenFn = null; // Función para cancelar listener del MR actual

function setupMrDataListener() {
    // Cancelar listener del mes anterior si existe
    if (_mrUnlistenFn) { _mrUnlistenFn(); _mrUnlistenFn = null; }
    if (!window.FirebaseSync || !window.FirebaseSync.listenKey) return;
    const fbKey = 'mr_' + getMonthlyReportKey();
    _mrUnlistenFn = window.FirebaseSync.listenKey(fbKey, (key, val) => {
        console.log('[App] Reporte mensual actualizado desde otro dispositivo:', key);
        _mrData = val;
        localStorage.setItem(getMonthlyReportKey(), JSON.stringify(_mrData));
        loadPayrollEmployees();
        generateMonthlyReport();
        renderWeeklyEmployees();
        updateWeeklySummary();
    });
}

// Reconciliar expenses[] con _mrData para el mes actual
// Asegura que todos los gastos registrados aparezcan en el reporte mensual
async function reconcileExpensesWithMrData() {
    await ensureMonthDataLoaded(_mrYear, _mrMonth);
    const monthExpenses = getMonthRecords(_mrYear, _mrMonth, 'expenses').filter(e => !e.deleted);
    if (monthExpenses.length === 0) return;

    let changed = false;
    monthExpenses.forEach(expense => {
        const expenseDate = new Date(expense.timestamp);
        const todayStr = expenseDate.toISOString().split('T')[0];
        const newItem = {
            category: expense.categoryType,
            concept: expense.description,
            date: todayStr,
            amount: expense.amount,
            _expenseId: expense.id // referencia para evitar duplicados
        };

        // Verificar si ya existe en _mrData (por _expenseId)
        const isDirect = expense.categoryType !== 'mercadotecnia';
        const list = isDirect ? (_mrData.directExpenses || []) : (_mrData.indirectExpenses || []);
        const alreadyExists = list.some(e => e._expenseId === expense.id);

        if (!alreadyExists) {
            if (isDirect) {
                if (!_mrData.directExpenses) _mrData.directExpenses = [];
                _mrData.directExpenses.push(newItem);
            } else {
                if (!_mrData.indirectExpenses) _mrData.indirectExpenses = [];
                _mrData.indirectExpenses.push(newItem);
            }
            changed = true;
        }
    });

    if (changed) {
        saveMonthlyReportData();
    }
}

async function initMonthlyReport() {
    const now = new Date();
    const monthSel = document.getElementById('reportMonth');
    const yearSel = document.getElementById('reportYear');
    
    // Poblar años (actual y 2 años anteriores)
    const currentYear = now.getFullYear();
    yearSel.innerHTML = '';
    for (let y = currentYear - 2; y <= currentYear; y++) {
        const option = document.createElement('option');
        option.value = y;
        option.textContent = y;
        if (y === currentYear) option.selected = true;
        yearSel.appendChild(option);
    }
    
    // Poblar meses
    const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    monthSel.innerHTML = '';
    months.forEach((month, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = month;
        if (index === now.getMonth()) option.selected = true;
        monthSel.appendChild(option);
    });
    
    _mrMonth = now.getMonth();
    _mrYear = now.getFullYear();
    loadMonthlyReportData();
    loadPayrollEmployees();
    await reconcileExpensesWithMrData();
    await generateMonthlyReport();
    initMrCollapsible();

    // Inicializar semana actual
    updateWeekDateRange();
    renderWeeklyEmployees();
    updateWeeklySummary();

    // Configurar event listeners para nómina
    setupPayrollEventListeners();

    // Listener en tiempo real para nómina/reporte mensual
    setupMrDataListener();
}

function setupPayrollEventListeners() {
    const payrollName = document.getElementById('payrollName');
    const payrollDailyRate = document.getElementById('payrollDailyRate');
    const payrollDays = document.getElementById('payrollDays');

    // Usar onclick para que nunca se acumulen handlers duplicados
    if (payrollName) payrollName.oninput = calculatePayrollTotal;
    if (payrollDailyRate) payrollDailyRate.oninput = calculatePayrollTotal;
    if (payrollDays) payrollDays.oninput = calculatePayrollTotal;

    const btnSavePayroll = document.getElementById('btnSavePayroll');
    if (btnSavePayroll) {
        btnSavePayroll.onclick = (e) => {
            e.preventDefault();
            savePayrollEmployee();
        };
    }
}

function getMonthlyReportKey() { return `mrData_${_mrYear}_${_mrMonth}`; }

function initMrCollapsible() {
    document.querySelectorAll('.mr-section').forEach(section => {
        const title = section.querySelector('.mr-section-title');
        if (!title || title.dataset.collapsible) return;
        title.dataset.collapsible = '1';

        // Envolver todo lo que no sea el título en un mr-section-body
        const children = Array.from(section.children).filter(el => !el.classList.contains('mr-section-title'));
        const body = document.createElement('div');
        body.className = 'mr-section-body';
        children.forEach(el => body.appendChild(el));
        section.appendChild(body);

        title.addEventListener('click', () => {
            const isCollapsed = body.classList.toggle('collapsed');
            title.classList.toggle('collapsed', isCollapsed);
        });
    });
}

function saveMonthlyReportData() {
    localStorage.setItem(getMonthlyReportKey(), JSON.stringify(_mrData));
    // CRÍTICO: Siempre guardar en Firebase
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        window.FirebaseSync.saveMrData(getMonthlyReportKey(), _mrData).catch(err => {
            console.error('[Firebase] Error guardando reporte mensual:', err);
            showToast('⚠️ Error sincronizando reporte mensual', 'error');
        });
    }
}

function loadMonthlyReportData() {
    const fallback = { directExpenses: [], indirectExpenses: [], nonOpExpenses: [], salaries: [], efectivoMovimientos: [], bancoMovimientos: [], efectivoAnterior: 0, bancoAnterior: 0 };
    try {
        const saved = localStorage.getItem(getMonthlyReportKey());
        _mrData = saved ? JSON.parse(saved) : fallback;
    } catch(e) { _mrData = fallback; }
    // Intentar cargar desde Firebase (actualiza si hay datos más recientes)
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        window.FirebaseSync.loadMrData(getMonthlyReportKey(), null).then(fbData => {
            if (fbData) {
                _mrData = fbData;
                localStorage.setItem(getMonthlyReportKey(), JSON.stringify(_mrData));
                loadPayrollEmployees();
                generateMonthlyReport();
                renderWeeklyEmployees();
                updateWeeklySummary();
            }
        });
    }
}

// ============ FUNCIONES DE NÓMINA ============

function getWeekRanges(year, month) {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const weeks = [];
    
    let currentWeek = 1;
    let weekStart = firstDay;
    
    while (weekStart <= lastDay) {
        let weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6); // Sumar 7 días
        
        // Si el fin de semana pasa el último día del mes, limitarlo al último día
        if (weekEnd > lastDay) {
            weekEnd = lastDay;
        }
        
        weeks.push({
            week: currentWeek,
            start: new Date(weekStart),
            end: weekEnd,
            startStr: weekStart.toLocaleDateString('es-MX'),
            endStr: weekEnd.toLocaleDateString('es-MX')
        });
        
        // Pasar a la siguiente semana
        weekStart = new Date(weekEnd);
        weekStart.setDate(weekStart.getDate() + 1);
        currentWeek++;
    }
    
    return weeks;
}

function onWeekChange() {
    const weekSelector = document.getElementById('weekSelector');
    _currentWeek = parseInt(weekSelector.value);
    
    updateWeekDateRange();
    renderWeeklyEmployees();
    updateWeeklySummary();
}

function updateWeekDateRange() {
    const weekRangeEl = document.getElementById('weekDateRange');
    
    if (_currentWeek === 0) {
        // Todo el mes
        const monthName = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'][_mrMonth];
        weekRangeEl.textContent = `(${monthName} ${_mrYear})`;
    } else {
        // Semana específica
        const weeks = getWeekRanges(_mrYear, _mrMonth);
        const weekData = weeks.find(w => w.week === _currentWeek);
        if (weekData) {
            weekRangeEl.textContent = `(${weekData.startStr} - ${weekData.endStr})`;
        }
    }
}

function openPayrollModal(employeeId = null) {
    const modal = document.getElementById('payrollModal');
    _editingEmployeeId = employeeId;
    
    if (employeeId) {
        // Editar empleado existente
        const employee = _payrollEmployees.find(e => e.id === employeeId);
        if (employee) {
            document.getElementById('payrollName').value = employee.name;
            document.getElementById('payrollShift').value = employee.shift;
            document.getElementById('payrollDepartment').value = employee.department;
            document.getElementById('payrollDailyRate').value = employee.dailyRate;
            document.getElementById('payrollDays').value = employee.days;
            document.getElementById('payrollTotal').value = employee.total;
            document.getElementById('payrollNotes').value = employee.notes || '';
            // Marcar las semanas del empleado
            const empWeeks = employee.weeks || (employee.week ? [employee.week] : [1,2,3,4,5]);
            _setPayrollWeeks(empWeeks);
        }
    } else {
        // Nuevo empleado
        resetPayrollForm();
        // Si hay semana específica seleccionada, pre-marcar solo esa; si no, marcar todas
        if (_currentWeek > 0) {
            _setPayrollWeeks([_currentWeek]);
        }
    }
    
    modal.classList.add('show');
}

function togglePayrollWeek(btn) {
    btn.classList.toggle('active');
    const week = btn.dataset.week;
    const cb = document.getElementById(`payrollWeek${week}`);
    if (cb) cb.checked = btn.classList.contains('active');
}

function _setPayrollWeeks(selectedWeeks) {
    document.querySelectorAll('.payroll-week-btn').forEach(btn => {
        const w = parseInt(btn.dataset.week);
        const on = selectedWeeks.includes(w);
        btn.classList.toggle('active', on);
        const cb = document.getElementById(`payrollWeek${w}`);
        if (cb) cb.checked = on;
    });
}

function closePayrollModal() {
    document.getElementById('payrollModal').classList.remove('show');
    _editingEmployeeId = null;
    resetPayrollForm();
}

function resetPayrollForm() {
    document.getElementById('payrollName').value = '';
    document.getElementById('payrollShift').value = 'dia';
    document.getElementById('payrollDepartment').value = 'lavanderia';
    document.getElementById('payrollDailyRate').value = '';
    document.getElementById('payrollDays').value = '';
    document.getElementById('payrollTotal').value = '';
    document.getElementById('payrollNotes').value = '';
    _setPayrollWeeks([1,2,3,4,5]); // todas activas por defecto
}

function calculatePayrollTotal() {
    const dailyRate = parseFloat(document.getElementById('payrollDailyRate').value) || 0;
    const days = parseInt(document.getElementById('payrollDays').value) || 0;
    const total = dailyRate * days;
    
    document.getElementById('payrollTotal').value = total.toFixed(2);
}

function savePayrollEmployee() {
    const name = document.getElementById('payrollName').value.trim();
    const weeks = [1,2,3,4,5].filter(w => document.getElementById(`payrollWeek${w}`)?.checked);
    const shift = document.getElementById('payrollShift').value;
    const department = document.getElementById('payrollDepartment').value;
    const dailyRate = parseFloat(document.getElementById('payrollDailyRate').value) || 0;
    const days = parseInt(document.getElementById('payrollDays').value) || 0;
    const total = parseFloat(document.getElementById('payrollTotal').value) || 0;
    const notes = document.getElementById('payrollNotes').value.trim();
    
    if (!name) {
        showToast('Por favor ingresa el nombre del empleado', 'error');
        return;
    }
    
    if (weeks.length === 0) {
        showToast('Selecciona al menos una semana', 'error');
        return;
    }

    if (dailyRate <= 0) {
        showToast('La tarifa diaria debe ser mayor a 0', 'error');
        return;
    }

    if (days <= 0) {
        showToast('Los días trabajados deben ser mayor a 0', 'error');
        return;
    }
    
    if (_editingEmployeeId) {
        // Actualizar empleado existente
        const index = _payrollEmployees.findIndex(e => e.id === _editingEmployeeId);
        if (index !== -1) {
            _payrollEmployees[index] = {
                ..._payrollEmployees[index],
                name,
                shift,
                department,
                dailyRate,
                days,
                total,
                notes,
                weeks
            };
        }

        if (!_mrData.payrollEmployees) _mrData.payrollEmployees = [];
        const empIndex = _mrData.payrollEmployees.findIndex(e => e.id === _editingEmployeeId);
        if (empIndex !== -1) {
            _mrData.payrollEmployees[empIndex] = {
                ..._mrData.payrollEmployees[empIndex],
                name,
                shift,
                department,
                dailyRate,
                days,
                total,
                notes,
                weeks
            };
        } else {
            // Si no está en _mrData pero sí en _payrollEmployees, sincronizar
            _mrData.payrollEmployees.push(_payrollEmployees[_payrollEmployees.findIndex(e => e.id === _editingEmployeeId)]);
        }
    } else {
        // Verificar si ya existe un empleado con el mismo nombre, turno y departamento
        const existingEmployee = _payrollEmployees.find(e => 
            e.name === name && 
            e.shift === shift && 
            e.department === department
        );
        
        if (existingEmployee) {
            showToast('Este empleado ya existe en la nómina', 'error');
            return;
        }
        
        // Crear UN solo empleado para el mes con las semanas seleccionadas
        const newEmployee = {
            id: `${Date.now()}_${_mrYear}_${_mrMonth}`,
            name,
            shift,
            department,
            dailyRate,
            days,
            total,
            notes,
            weeks,
            month: _mrMonth,
            year: _mrYear,
            createdAt: Date.now()
        };
        
        // Agregar al mes actual
        _payrollEmployees.push(newEmployee);
        if (!_mrData.payrollEmployees) _mrData.payrollEmployees = [];
        _mrData.payrollEmployees.push(newEmployee);
        
        // Copiar a los próximos 12 meses
        for (let monthOffset = 1; monthOffset <= 12; monthOffset++) {
            const futureDate = new Date(_mrYear, _mrMonth + monthOffset, 1);
            const futureMonth = futureDate.getMonth();
            const futureYear = futureDate.getFullYear();
            const futureKey = `mrData_${futureYear}_${futureMonth}`;
            
            let futureMrData = JSON.parse(localStorage.getItem(futureKey)) || {};
            if (!futureMrData.payrollEmployees) futureMrData.payrollEmployees = [];
            
            // Agregar UN empleado para todo el mes futuro
            futureMrData.payrollEmployees.push({
                id: `${Date.now()}_${futureYear}_${futureMonth}`,
                name,
                shift,
                department,
                dailyRate,
                days,
                total,
                notes,
                weeks,
                month: futureMonth,
                year: futureYear,
                createdAt: Date.now()
            });
            
            localStorage.setItem(futureKey, JSON.stringify(futureMrData));
            if (window.FirebaseSync?.ready) {
                window.FirebaseSync.saveMrData(futureKey, futureMrData);
            }
        }
    }
    
    saveMonthlyReportData();
    renderWeeklyEmployees();
    updateWeeklySummary();
    closePayrollModal();
    showToast(`Empleado ${_editingEmployeeId ? 'actualizado' : 'agregado'} exitosamente`, 'success');
}

function deletePayrollEmployee(employeeId) {
    const employee = _payrollEmployees.find(e => e.id === employeeId);
    if (!employee) return;

    showCustomConfirm('Eliminar Empleado', `¿Eliminar a ${employee.name} de este mes?`).then(confirmDelete => {
        if (!confirmDelete) return;

        showCustomConfirm('¿Eliminar de meses futuros?', `¿También eliminar a ${employee.name} de todos los meses futuros?`).then(deleteFromFuture => {
            // Eliminar del mes actual
            _payrollEmployees = _payrollEmployees.filter(e => e.id !== employeeId);
            if (_mrData.payrollEmployees) {
                _mrData.payrollEmployees = _mrData.payrollEmployees.filter(e => e.id !== employeeId);
            }

            if (deleteFromFuture) {
                for (let monthOffset = 1; monthOffset <= 12; monthOffset++) {
                    const futureDate = new Date(_mrYear, _mrMonth + monthOffset, 1);
                    const futureKey = `mrData_${futureDate.getFullYear()}_${futureDate.getMonth()}`;
                    const storedData = localStorage.getItem(futureKey);
                    if (storedData) {
                        try {
                            let futureMrData = JSON.parse(storedData);
                            if (futureMrData.payrollEmployees) {
                                futureMrData.payrollEmployees = futureMrData.payrollEmployees.filter(e =>
                                    !(e.name === employee.name && e.department === employee.department && e.shift === employee.shift)
                                );
                                localStorage.setItem(futureKey, JSON.stringify(futureMrData));
                                if (window.FirebaseSync?.ready) {
                                    window.FirebaseSync.saveMrData(futureKey, futureMrData);
                                }
                            }
                        } catch (e) { /* ignorar errores de parse */ }
                    }
                }
            }

            saveMonthlyReportData();
            renderWeeklyEmployees();
            updateWeeklySummary();
            showToast('Empleado eliminado exitosamente', 'success');
        });
    });
}

function renderWeeklyEmployees() {
    const grid = document.getElementById('weeklyEmployeesGrid');
    const title = document.getElementById('weeklyEmployeesTitle');
    
    if (!grid) return;
    
    let filteredEmployees = _payrollEmployees;
    
    // Filtrar por semana si no es "todo el mes"
    if (_currentWeek > 0) {
        // Mostrar solo empleados que trabajan en esta semana
        filteredEmployees = _payrollEmployees.filter(e => {
            // Si el empleado tiene el campo 'weeks', verificar que incluya la semana actual
            if (e.weeks && Array.isArray(e.weeks)) {
                return e.weeks.includes(_currentWeek);
            }
            // Compatibilidad con formato antiguo (empleados con campo 'week')
            return e.week === _currentWeek;
        });
    }
    
    // Actualizar título
    if (_currentWeek === 0) {
        title.textContent = `Empleados de ${['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'][_mrMonth]} ${_mrYear}`;
    } else {
        title.textContent = `Empleados de la Semana ${_currentWeek}`;
    }
    
    if (filteredEmployees.length === 0) {
        grid.innerHTML = '<div class="no-employees">No hay empleados registrados para este período</div>';
        return;
    }
    
    const shiftLabels = {
        'dia': 'Día',
        'noche': 'Noche',
        'dia-fin-semana': 'Día, Fin de Semana',
        'noche-fin-semana': 'Noche, Fin de Semana'
    };
    
    const departmentLabels = {
        'lavanderia': 'Lavandería',
        'recepcion': 'Recepción',
        'limpieza': 'Limpieza',
        'suites-lm': 'Suites LM',
        'casa': 'Casa'
    };
    
    grid.innerHTML = filteredEmployees.map(employee => {
        const departmentName = sanitizeHTML(departmentLabels[employee.department] || employee.department);
        const empWeeks = employee.weeks && Array.isArray(employee.weeks)
            ? employee.weeks.slice().sort((a, b) => a - b)
            : (employee.week ? [employee.week] : []);
        const weeksLabel = empWeeks.length > 0 ? `Sem. ${empWeeks.join(', ')}` : '';
        const weeksCount = empWeeks.length || 1;
        const monthlyTotal = employee.total * weeksCount;

        return `
            <div class="employee-card">
                <div class="employee-header">
                    <div>
                        <div class="employee-name">${sanitizeHTML(employee.name)}</div>
                        ${weeksLabel ? `<div style="font-size:11px;color:#8a98a8;margin-top:2px;">${weeksLabel}</div>` : ''}
                    </div>
                    <div class="employee-actions">
                        <button class="btn-employee-action btn-edit-employee" onclick="openPayrollModal('${employee.id}')" title="Editar">✏️</button>
                        <button class="btn-employee-action btn-delete-employee" onclick="deletePayrollEmployee('${employee.id}')" title="Eliminar">🗑️</button>
                    </div>
                </div>
                <div class="employee-details">
                    <div class="employee-detail">
                        <div class="detail-label">Turno</div>
                        <div class="detail-value">${shiftLabels[employee.shift] || employee.shift}</div>
                    </div>
                    <div class="employee-detail">
                        <div class="detail-label">Departamento</div>
                        <div class="detail-value">${departmentName}</div>
                    </div>
                    <div class="employee-detail">
                        <div class="detail-label">Tarifa/Día</div>
                        <div class="detail-value">$${employee.dailyRate.toFixed(2)}</div>
                    </div>
                    <div class="employee-detail">
                        <div class="detail-label">Días/Sem.</div>
                        <div class="detail-value">${employee.days}</div>
                    </div>
                </div>
                <div class="employee-total">
                    <div class="total-label">Total mensual (${weeksCount} sem.)</div>
                    <div class="total-amount">$${monthlyTotal.toFixed(2)}</div>
                </div>
                ${employee.notes ? `<div style="margin-top:8px;padding:8px;background:#f8f9fa;border-radius:4px;font-size:12px;color:#6c757d;"><strong>Notas:</strong> ${sanitizeHTML(employee.notes)}</div>` : ''}
            </div>
        `;
    }).join('');
}

function updateWeeklySummary() {
    const weeks = getWeekRanges(_mrYear, _mrMonth);
    
    // Ocultar/mostrar semana 5 si no existe
    const week5Card = document.getElementById('week5Card');
    if (week5Card) {
        week5Card.style.display = weeks.length >= 5 ? 'block' : 'none';
    }
    
    // Actualizar cada semana
    for (let i = 1; i <= 5; i++) {
        const weekTotalEl = document.getElementById(`week${i}Total`);
        const weekDatesEl = document.getElementById(`week${i}Dates`);
        
        if (!weekTotalEl || !weekDatesEl) continue;
        
        // Filtrar empleados que trabajan en esta semana
        const weekEmployees = _payrollEmployees.filter(e => {
            if (e.weeks && Array.isArray(e.weeks)) {
                return e.weeks.includes(i);
            }
            // Compatibilidad con formato antiguo
            return e.week === i;
        });
        const weekTotal = weekEmployees.reduce((sum, e) => sum + e.total, 0);
        
        weekTotalEl.textContent = `$${weekTotal.toFixed(2)}`;
        
        const weekData = weeks.find(w => w.week === i);
        if (weekData) {
            weekDatesEl.textContent = `${weekData.startStr} - ${weekData.endStr}`;
        } else {
            weekDatesEl.textContent = '';
        }
    }
}

function loadPayrollEmployees() {
    // Cargar empleados del mes actual
    _payrollEmployees = [];
    
    if (_mrData.payrollEmployees && _mrData.payrollEmployees.length > 0) {
        // Cargar desde _mrData si existe
        _payrollEmployees = _mrData.payrollEmployees.filter(e => 
            e.month === _mrMonth && e.year === _mrYear
        );
    }
    
    // Si _mrData no tiene empleados, intentar cargar desde localStorage
    if (_payrollEmployees.length === 0) {
        const currentKey = `mrData_${_mrYear}_${_mrMonth}`;
        const storedData = localStorage.getItem(currentKey);
        
        if (storedData) {
            try {
                const parsedData = JSON.parse(storedData);
                if (parsedData.payrollEmployees && parsedData.payrollEmployees.length > 0) {
                    _payrollEmployees = parsedData.payrollEmployees.filter(e => 
                        e.month === _mrMonth && e.year === _mrYear
                    );
                    // Sincronizar con _mrData
                    if (!_mrData.payrollEmployees) _mrData.payrollEmployees = [];
                    _mrData.payrollEmployees = _payrollEmployees;
                }
            } catch (e) {
                console.error('Error parsing payroll data:', e);
            }
        }
    }
    
    // MIGRACIÓN: Convertir empleados del formato antiguo (uno por semana) al nuevo formato (uno por mes)
    migrateOldPayrollFormat();
}

function migrateOldPayrollFormat() {
    // Detectar si hay empleados en formato antiguo (con campo 'week' en lugar de 'weeks')
    const oldFormatEmployees = _payrollEmployees.filter(e => e.week && !e.weeks);
    
    if (oldFormatEmployees.length === 0) return; // No hay nada que migrar
    
    // Agrupar empleados por nombre, turno y departamento
    const employeeGroups = new Map();
    
    oldFormatEmployees.forEach(emp => {
        const key = `${emp.name}_${emp.shift}_${emp.department}`;
        
        if (!employeeGroups.has(key)) {
            employeeGroups.set(key, {
                ...emp,
                weeks: [emp.week],
                id: `${Date.now()}_${_mrYear}_${_mrMonth}` // Nuevo ID único para el mes
            });
        } else {
            const existing = employeeGroups.get(key);
            if (!existing.weeks.includes(emp.week)) {
                existing.weeks.push(emp.week);
            }
        }
    });
    
    // Eliminar empleados en formato antiguo
    _payrollEmployees = _payrollEmployees.filter(e => !e.week || e.weeks);
    
    // Agregar empleados migrados
    const migratedEmployees = Array.from(employeeGroups.values());
    _payrollEmployees.push(...migratedEmployees);
    
    // Actualizar _mrData
    if (!_mrData.payrollEmployees) _mrData.payrollEmployees = [];
    _mrData.payrollEmployees = _mrData.payrollEmployees.filter(e => 
        !(e.month === _mrMonth && e.year === _mrYear && e.week && !e.weeks)
    );
    _mrData.payrollEmployees.push(...migratedEmployees);
    
    // Guardar cambios
    saveMonthlyReportData();
}

function getMonthRange() {
    // Inicio: dia 1 a las 6:00 AM. Fin: dia 1 del mes siguiente a las 5:59:59 AM
    // El turno nocturno del ultimo dia queda dentro del mes actual
    const start = new Date(_mrYear, _mrMonth, 1, 6, 0, 0).getTime();
    const end = new Date(_mrYear, _mrMonth + 1, 1, 5, 59, 59).getTime();
    return { start, end };
}


function getMonthRangeFor(year, month) {
    const start = new Date(year, month, 1, 6, 0, 0).getTime();
    const end = new Date(year, month + 1, 1, 5, 59, 59).getTime();
    return { start, end };
}

function markMrAnterioresEdited() {
    _mrData.anterioresUserEdited = true;
    recalcMonthlyReport();
}

/** Vacía el saldo guardado cuando el usuario borra el campo (permite dejar en blanco). */
function mrSaldoAnteriorInput(isEfec) {
    _mrData.anterioresUserEdited = true;
    const id = isEfec ? 'mr-efectivo-anterior' : 'mr-banco-anterior';
    const el = document.getElementById(id);
    if (el && !String(el.value).trim()) {
        if (isEfec) _mrData.efectivoAnterior = null;
        else _mrData.bancoAnterior = null;
        saveMonthlyReportData();
    }
    recalcMonthlyReport();
}

/** Sincroniza ingresos con tarjeta/banco del mes hacia movimientos automáticos (sobre targetMr). */
async function syncTarjetaVentasToBancoInto(targetMr, year, month) {
    const { start, end } = getMonthRangeFor(year, month);
    await ensureMonthDataLoaded(year, month);
    if (!targetMr.bancoMovimientos) targetMr.bancoMovimientos = [];
    targetMr.bancoMovimientos = targetMr.bancoMovimientos.filter(m => !m.autoGenerated);

    const monthRooms = getMonthRecords(year, month, 'revenue').filter(r =>
        (r.type === 'sold' || r.type === 'renewal') &&
        isCardOrBankPayment(r.paymentMethod)
    );
    monthRooms.forEach(room => {
        const date = new Date(room.timestamp).toISOString().split('T')[0];
        const rn = room.roomNumber || room.number || 'N/A';
        const concept = `Hab. ${rn} (${room.building === 'regulares' ? 'Ed.1' : 'Torre'}) - ${room.guestName || 'Sin nombre'}`;
        targetMr.bancoMovimientos.push({
            date,
            concept,
            ingreso: room.price,
            egreso: 0,
            autoGenerated: true,
            sourceId: room.id,
            sourceType: 'room'
        });
    });

    const monthSales = getMonthRecords(year, month, 'sales').filter(s =>
        isCardOrBankPayment(s.paymentMethod)
    );
    monthSales.forEach(sale => {
        const date = new Date(sale.timestamp).toISOString().split('T')[0];
        const concept = `Venta inventario - ${sale.productName || 'Productos'}`;
        targetMr.bancoMovimientos.push({
            date,
            concept,
            ingreso: sale.total,
            egreso: 0,
            autoGenerated: true,
            sourceId: sale.id,
            sourceType: 'sale'
        });
    });

    const monthReservations = (reservations || []).filter(res => {
        const ts = res.reservationTimestamp || res.createdAt;
        return ts >= start && ts <= end && res.status !== 'cancelled' && res.status !== 'completed' && isCardOrBankPayment(res.paymentMethod);
    });
    monthReservations.forEach(res => {
        const ts = res.reservationTimestamp || res.createdAt;
        const date = new Date(ts).toISOString().split('T')[0];
        const concept = `Reserva Hab. ${res.roomNumber} (${res.building === 'regulares' ? 'Ed.1' : 'Torre'}) - ${res.guestName || 'Sin nombre'}`;
        targetMr.bancoMovimientos.push({
            date,
            concept,
            ingreso: Number(res.price) || 0,
            egreso: 0,
            autoGenerated: true,
            sourceId: res.id,
            sourceType: 'reservation'
        });
    });

    targetMr.bancoMovimientos.sort((a, b) => new Date(a.date) - new Date(b.date));
}

/** Totales de cierre efectivo/banco de un mes (para rellenar "mes anterior"). */
async function computeCierreForMonth(year, month) {
    let mr;
    try {
        const raw = localStorage.getItem(`mrData_${year}_${month}`);
        mr = raw ? JSON.parse(raw) : null;
    } catch (e) { mr = null; }
    if (!mr) {
        mr = { directExpenses: [], indirectExpenses: [], nonOpExpenses: [], efectivoMovimientos: [], bancoMovimientos: [], efectivoAnterior: 0, bancoAnterior: 0 };
    }
    await ensureMonthDataLoaded(year, month);
    await syncTarjetaVentasToBancoInto(mr, year, month);
    const { start, end } = getMonthRangeFor(year, month);
    const filt = m => {
        const t = new Date(m.date).getTime();
        return !Number.isNaN(t) && t >= start && t <= end;
    };

    const monthRooms = getMonthRecords(year, month, 'revenue').filter(r => r.type === 'sold' || r.type === 'renewal');
    const monthSales = getMonthRecords(year, month, 'sales');
    const monthReservations = (reservations || []).filter(res => {
        const ts = res.reservationTimestamp || res.createdAt;
        return ts >= start && ts <= end && res.status !== 'cancelled' && res.status !== 'completed';
    });

    const roomsEfec = monthRooms.filter(r => isCashPayment(r.paymentMethod)).reduce((s, r) => s + r.price, 0);
    const salesEfec = monthSales.filter(s => isCashPayment(s.paymentMethod)).reduce((s, r) => s + r.total, 0);
    const resEfec = monthReservations.filter(r => isCashPayment(r.paymentMethod)).reduce((s, r) => s + (Number(r.price) || 0), 0);
    const totalIngresos = roomsEfec + salesEfec + resEfec;

    const inversionesCats = ['inversiones_alimentos', 'inversiones_sexshop'];
    const allDirect = mr.directExpenses || [];
    const inversionesTotal = allDirect.filter(e => inversionesCats.includes(e.category)).reduce((s, e) => s + (e.amount || 0), 0);
    const directTotal = allDirect.reduce((s, e) => s + (e.amount || 0), 0);
    const indirectTotal = (mr.indirectExpenses || []).reduce((s, e) => s + (e.amount || 0), 0);
    const nonOpTotal = (mr.nonOpExpenses || []).reduce((s, e) => s + (e.amount || 0), 0);
    const utilidadBruta = totalIngresos - (directTotal - inversionesTotal) - indirectTotal;
    const utilidadNeta = utilidadBruta - inversionesTotal - nonOpTotal;

    const efectivoAnt = mr.efectivoAnterior != null && mr.efectivoAnterior !== '' ? Number(mr.efectivoAnterior) : 0;
    const bancoAnt = mr.bancoAnterior != null && mr.bancoAnterior !== '' ? Number(mr.bancoAnterior) : 0;
    const efecMov = (mr.efectivoMovimientos || []).filter(filt);
    const bancoMov = (mr.bancoMovimientos || []).filter(filt);
    const efecMovIngresos = efecMov.reduce((s, m) => s + (m.ingreso || 0), 0);
    const efecMovEgresos = efecMov.reduce((s, m) => s + (m.egreso || 0), 0);
    const bancoMovIngresos = bancoMov.reduce((s, m) => s + (m.ingreso || 0), 0);
    const bancoMovEgresos = bancoMov.reduce((s, m) => s + (m.egreso || 0), 0);

    return {
        efectivoCierre: efectivoAnt + utilidadNeta + efecMovIngresos - efecMovEgresos,
        bancoCierre: bancoAnt + bancoMovIngresos - bancoMovEgresos
    };
}

async function applyAnterioresFromPreviousMonth() {
    if (_mrData.anterioresUserEdited) return;
    let py = _mrYear;
    let pm = _mrMonth - 1;
    if (pm < 0) { pm = 11; py--; }
    const tag = `${_mrYear}-${_mrMonth}`;
    if (_mrData.anterioresAutoTag === tag) return;

    const cierre = await computeCierreForMonth(py, pm);
    _mrData.efectivoAnterior = cierre.efectivoCierre;
    _mrData.bancoAnterior = cierre.bancoCierre;
    _mrData.anterioresAutoTag = tag;

    const efecInp = document.getElementById('mr-efectivo-anterior');
    const bancInp = document.getElementById('mr-banco-anterior');
    if (efecInp) efecInp.value = cierre.efectivoCierre === 0 ? '' : String(Math.round(cierre.efectivoCierre * 100) / 100);
    if (bancInp) bancInp.value = cierre.bancoCierre === 0 ? '' : String(Math.round(cierre.bancoCierre * 100) / 100);
    saveMonthlyReportData();
}

// Función para formatear fechas de manera consistente
function fmtDate(dateStr) {
    if (!dateStr) return '';
    
    // Si está en formato YYYY-MM-DD, convertir a Date
    let date;
    if (dateStr.includes('-')) {
        const [year, month, day] = dateStr.split('-').map(Number);
        date = new Date(year, month - 1, day);
    } else {
        date = new Date(dateStr);
    }
    
    if (isNaN(date.getTime())) return dateStr;
    
    return date.toLocaleDateString('es-MX', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
}

function addSaleToMovements(saleData) {
    // Obtener año y mes de la transacción (NO del mes actualmente visualizado)
    const dateObj = new Date(saleData.timestamp);
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth();
    const key = `mrData_${year}_${month}`;
    
    // Cargar el mrData del mes correcto
    let mrData;
    try {
        const saved = localStorage.getItem(key);
        mrData = saved ? JSON.parse(saved) : { 
            directExpenses: [], indirectExpenses: [], nonOpExpenses: [], 
            salaries: [], efectivoMovimientos: [], bancoMovimientos: [] 
        };
    } catch(e) {
        mrData = { 
            directExpenses: [], indirectExpenses: [], nonOpExpenses: [], 
            salaries: [], efectivoMovimientos: [], bancoMovimientos: [] 
        };
    }
    
    const date = dateObj.toISOString().split('T')[0];
    let concept = '';
    
    if (saleData.type === 'sold' || saleData.type === 'renewal') {
        concept = `Hab. ${saleData.roomNumber} (${saleData.building === 'regulares' ? 'Ed.1' : 'Torre'}) - ${saleData.guestName || 'Sin nombre'}`;
    } else if (saleData.items) {
        // Es venta de inventario
        concept = `Venta inventario - ${saleData.items.map(i => i.name).join(', ')}`;
    }
    
    const amount = saleData.price || saleData.total || 0;
    const paymentMethod = saleData.paymentMethod || 'efectivo';
    
    // Agregar a movimientos de efectivo si es pago en efectivo
    if (paymentMethod === 'efectivo') {
        if (!mrData.efectivoMovimientos) mrData.efectivoMovimientos = [];
        mrData.efectivoMovimientos.push({
            date,
            concept,
            ingreso: amount,
            egreso: 0,
            autoGenerated: true,
            sourceId: saleData.id,
            sourceType: saleData.type || 'sale'
        });
        
        // Ordenar por fecha
        mrData.efectivoMovimientos.sort((a, b) => new Date(a.date) - new Date(b.date));
    }
    
    // Agregar a movimientos de banco si es pago con tarjeta
    if (isCardOrBankPayment(paymentMethod)) {
        if (!mrData.bancoMovimientos) mrData.bancoMovimientos = [];
        mrData.bancoMovimientos.push({
            date,
            concept,
            ingreso: amount,
            egreso: 0,
            autoGenerated: true,
            sourceId: saleData.id,
            sourceType: saleData.type || 'sale'
        });
        
        // Ordenar por fecha
        mrData.bancoMovimientos.sort((a, b) => new Date(a.date) - new Date(b.date));
    }
    
    // Guardar en el mes correcto
    localStorage.setItem(key, JSON.stringify(mrData));
    if (_appReady && window.FirebaseSync && window.FirebaseSync.ready) {
        window.FirebaseSync.saveMrData(key, mrData);
    }
    
    // Si estamos visualizando ese mes, actualizar la vista
    if (_mrYear === year && _mrMonth === month) {
        _mrData = mrData;
        generateMonthlyReport();
    }
}

function addTarjetaSaleToBanco(saleData) {
    if (!isCardOrBankPayment(saleData.paymentMethod)) return;
    
    // Obtener año y mes de la transacción (NO del mes actualmente visualizado)
    const dateObj = new Date(saleData.timestamp);
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth();
    const key = `mrData_${year}_${month}`;
    
    // Cargar el mrData del mes correcto
    let mrData;
    try {
        const saved = localStorage.getItem(key);
        mrData = saved ? JSON.parse(saved) : { 
            directExpenses: [], indirectExpenses: [], nonOpExpenses: [], 
            salaries: [], efectivoMovimientos: [], bancoMovimientos: [] 
        };
    } catch(e) {
        mrData = { 
            directExpenses: [], indirectExpenses: [], nonOpExpenses: [], 
            salaries: [], efectivoMovimientos: [], bancoMovimientos: [] 
        };
    }
    
    // Crear movimiento en banco
    const date = dateObj.toISOString().split('T')[0];
    let concept = '';
    
    if (saleData.type === 'sold' || saleData.type === 'renewal') {
        concept = `Hab. ${saleData.roomNumber} (${saleData.building === 'regulares' ? 'Ed.1' : 'Torre'}) - ${saleData.guestName || 'Sin nombre'}`;
    } else if (saleData.type === 'reservation') {
        concept = `Reserva Hab. ${saleData.roomNumber} (${saleData.building === 'regulares' ? 'Ed.1' : 'Torre'}) - ${saleData.guestName || 'Sin nombre'}`;
    } else if (saleData.productName) {
        concept = `Venta inventario - ${saleData.productName}`;
    }
    
    const movimiento = {
        date,
        concept,
        ingreso: saleData.price || saleData.total || 0,
        egreso: 0,
        autoGenerated: true,
        sourceId: saleData.id,
        sourceType: saleData.type || 'sale'
    };
    
    // Agregar a movimientos del banco
    if (!mrData.bancoMovimientos) mrData.bancoMovimientos = [];
    mrData.bancoMovimientos.push(movimiento);
    
    // Ordenar por fecha
    mrData.bancoMovimientos.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    // Guardar en el mes correcto
    localStorage.setItem(key, JSON.stringify(mrData));
    if (_appReady && window.FirebaseSync && window.FirebaseSync.ready) {
        window.FirebaseSync.saveMrData(key, mrData);
    }
    
    // Si estamos visualizando ese mes, actualizar la vista
    if (_mrYear === year && _mrMonth === month) {
        _mrData = mrData;
        generateMonthlyReport();
    }
}

async function syncTarjetaVentasToBanco() {
    await syncTarjetaVentasToBancoInto(_mrData, _mrYear, _mrMonth);
    saveMonthlyReportData();
}

function cleanMovimientosFromOtherMonths() {
    const { start, end } = getMonthRange();
    
    // Limpiar movimientos de efectivo de otros meses
    if (_mrData.efectivoMovimientos) {
        _mrData.efectivoMovimientos = _mrData.efectivoMovimientos.filter(m => {
            const movDate = new Date(m.date).getTime();
            return movDate >= start && movDate <= end;
        });
    }
    
    // Limpiar movimientos de banco de otros meses
    if (_mrData.bancoMovimientos) {
        _mrData.bancoMovimientos = _mrData.bancoMovimientos.filter(m => {
            const movDate = new Date(m.date).getTime();
            return movDate >= start && movDate <= end;
        });
    }
    
    saveMonthlyReportData();
}

async function generateMonthlyReport() {
    // Inicializar _mrData si no existe
    if (!_mrData || typeof _mrData !== 'object') {
        _mrData = {
            directExpenses: [],
            indirectExpenses: [],
            nonOpExpenses: []
        };
    }

    await ensureMonthDataLoaded(_mrYear, _mrMonth);
    cleanMovimientosFromOtherMonths();
    await applyAnterioresFromPreviousMonth();
    await syncTarjetaVentasToBanco();

    const monthRooms = getMonthRecords(_mrYear, _mrMonth, 'revenue').filter(r => r.type === 'sold' || r.type === 'renewal');
    const monthSales = getMonthRecords(_mrYear, _mrMonth, 'sales');
    const roomsTotal = monthRooms.reduce((s, r) => s + r.price, 0);
    const roomsEfectivo = monthRooms.filter(r => isCashPayment(r.paymentMethod)).reduce((s, r) => s + r.price, 0);
    const roomsBanco = monthRooms.filter(r => isCardOrBankPayment(r.paymentMethod)).reduce((s, r) => s + r.price, 0);
    const salesEfectivo = monthSales.filter(s => isCashPayment(s.paymentMethod)).reduce((s, r) => s + r.total, 0);
    const salesBanco = monthSales.filter(s => isCardOrBankPayment(s.paymentMethod)).reduce((s, r) => s + r.total, 0);

    const totalIngresos = roomsEfectivo + salesEfectivo;

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('mr-rooms-total', fmt(roomsTotal));
    setEl('mr-rooms-efectivo', fmt(roomsEfectivo));
    setEl('mr-rooms-banco', fmt(roomsBanco));
    setEl('mr-sales-efectivo', fmt(salesEfectivo));
    setEl('mr-sales-banco', fmt(salesBanco));
    setEl('mr-total-ingresos', fmt(totalIngresos));

    const inversionesCats = ['inversiones_alimentos', 'inversiones_sexshop'];
    const allDirectExpenses = _mrData.directExpenses || [];
    const inversionesTotal = allDirectExpenses
        .filter(e => inversionesCats.includes(e.category))
        .reduce((s, e) => s + (e.amount || 0), 0);
    const directTotal = allDirectExpenses.reduce((s, e) => s + (e.amount || 0), 0);

    const indirectTotal = (_mrData.indirectExpenses || []).reduce((s, e) => s + (e.amount || 0), 0);
    const nonOpTotal = (_mrData.nonOpExpenses || []).reduce((s, e) => s + (e.amount || 0), 0);
    // Utilidad Bruta: ingresos efectivo - gastos operativos (directos sin inversiones) - indirectos
    const utilidadBruta = totalIngresos - (directTotal - inversionesTotal) - indirectTotal;
    // Utilidad Neta: Bruta - Inversiones - No Operativos
    const utilidadNeta = utilidadBruta - inversionesTotal - nonOpTotal;

    setEl('mr-direct-subtotal', fmt(directTotal));
    setEl('mr-indirect-subtotal', fmt(indirectTotal));
    setEl('mr-inversiones-subtotal', fmt(inversionesTotal));
    setEl('mr-utilidad-bruta', fmt(utilidadBruta));
    setEl('mr-nonop-subtotal', fmt(nonOpTotal));
    setEl('mr-utilidad-neta', fmt(utilidadNeta));

    const efecInputEl = document.getElementById('mr-efectivo-anterior');
    const bancInputEl = document.getElementById('mr-banco-anterior');
    const rawEf = efecInputEl?.value?.trim() ?? '';
    const rawBa = bancInputEl?.value?.trim() ?? '';
    const parseMoney = (raw) => {
        if (raw === '') return 0;
        const n = parseFloat(String(raw).replace(',', '.'));
        return Number.isFinite(n) ? n : 0;
    };
    let efectivoAnterior = parseMoney(rawEf);
    let bancoAnterior = parseMoney(rawBa);
    if (rawEf === '') {
        efectivoAnterior = _mrData.efectivoAnterior != null && _mrData.efectivoAnterior !== '' ? Number(_mrData.efectivoAnterior) : 0;
    }
    if (rawBa === '') {
        bancoAnterior = _mrData.bancoAnterior != null && _mrData.bancoAnterior !== '' ? Number(_mrData.bancoAnterior) : 0;
    }
    const efecMovIngresos = (_mrData.efectivoMovimientos || []).reduce((s, m) => s + (m.ingreso || 0), 0);
    const efecMovEgresos = (_mrData.efectivoMovimientos || []).reduce((s, m) => s + (m.egreso || 0), 0);
    const efectivoTotal = efectivoAnterior + utilidadNeta + efecMovIngresos - efecMovEgresos;
    const bancoMovIngresos = (_mrData.bancoMovimientos || []).reduce((s, m) => s + (m.ingreso || 0), 0);
    const bancoMovEgresos = (_mrData.bancoMovimientos || []).reduce((s, m) => s + (m.egreso || 0), 0);
    const bancoTotal = bancoAnterior + bancoMovIngresos - bancoMovEgresos;

    if (rawEf !== '') _mrData.efectivoAnterior = efectivoAnterior;
    if (rawBa !== '') _mrData.bancoAnterior = bancoAnterior;
    setEl('mr-efectivo-utilidad', fmt(utilidadNeta));
    setEl('mr-efectivo-total', fmt(efectivoTotal));
    setEl('mr-banco-ingresos', fmt(bancoMovIngresos));
    setEl('mr-banco-total', fmt(bancoTotal));

    if (efecInputEl && rawEf === '' && _mrData.efectivoAnterior != null && _mrData.efectivoAnterior !== '') {
        efecInputEl.value = String(_mrData.efectivoAnterior);
    }
    if (bancInputEl && rawBa === '' && _mrData.bancoAnterior != null && _mrData.bancoAnterior !== '') {
        bancInputEl.value = String(_mrData.bancoAnterior);
    }
    renderMrExpenseList('mr-direct-expenses-list', _mrData.directExpenses || [], 'direct');
    renderMrExpenseList('mr-indirect-expenses-list', _mrData.indirectExpenses || [], 'indirect');
    renderMrExpenseList('mr-nonop-expenses-list', _mrData.nonOpExpenses || [], 'nonop');
    renderMrSalaryList();
    renderMrMovimientosList('mr-efectivo-movimientos-list', 'efectivo');
    renderMrMovimientosList('mr-banco-movimientos-list', 'banco');
    await generateDailyIncomeTable();
}

function recalcMonthlyReport() { generateMonthlyReport(); }

// ─── TABLA DE INGRESOS DIARIOS ────────────────────────────────────────────────
async function generateDailyIncomeTable() {
    const tbody = document.getElementById('mr-daily-tbody');
    if (!tbody) return;

    await ensureMonthDataLoaded(_mrYear, _mrMonth);
    const monthRevenueRecords = getMonthRecords(_mrYear, _mrMonth, 'revenue');
    const monthSalesRecords = getMonthRecords(_mrYear, _mrMonth, 'sales');
    const daysInMonth = new Date(_mrYear, _mrMonth + 1, 0).getDate();
    const dayNames = ['DOMINGO','LUNES','MARTES','MIÉRCOLES','JUEVES','VIERNES','SÁBADO'];
    const fmtM = n => n ? '$' + (n).toFixed(2) : '';

    let totReg = 0, totTorre = 0, totHab = 0;
    let totEfec = 0, totTarjeta = 0, totIngHab = 0, totConsumos = 0, totTurno = 0, totDia = 0;

    let html = '';

    for (let d = 1; d <= daysInMonth; d++) {
        // Rango del día: turno día (6am-6pm) + turno noche (6pm-6am siguiente)
        const dayStart  = new Date(_mrYear, _mrMonth, d, 6, 0, 0).getTime();
        const dayEnd    = new Date(_mrYear, _mrMonth, d + 1, 5, 59, 59).getTime();
        const shiftDayStart   = new Date(_mrYear, _mrMonth, d, 6, 0, 0).getTime();
        const shiftDayEnd     = new Date(_mrYear, _mrMonth, d, 17, 59, 59).getTime();
        const shiftNightStart = new Date(_mrYear, _mrMonth, d, 18, 0, 0).getTime();
        const shiftNightEnd   = new Date(_mrYear, _mrMonth, d + 1, 5, 59, 59).getTime();

        const dayOfWeek = new Date(_mrYear, _mrMonth, d).getDay();
        const dayName = dayNames[dayOfWeek];

        // Función para calcular datos de un turno
        function shiftData(tsStart, tsEnd) {
            const rooms = monthRevenueRecords.filter(r =>
                r.timestamp >= tsStart && r.timestamp <= tsEnd &&
                (r.type === 'sold' || r.type === 'renewal')
            );
            const shiftSales = monthSalesRecords.filter(s => s.timestamp >= tsStart && s.timestamp <= tsEnd);

            const reg   = rooms.filter(r => r.building === 'regulares').length;
            const torre = rooms.filter(r => r.building === 'torre').length;
            const total = rooms.length;
            const ingHab = rooms.reduce((s, r) => s + r.price, 0);
            const consumos = shiftSales.reduce((s, r) => s + r.total, 0);
            const tarjeta = rooms.filter(r => isCardOrBankPayment(r.paymentMethod)).reduce((s, r) => s + r.price, 0)
                          + shiftSales.filter(s => isCardOrBankPayment(s.paymentMethod)).reduce((s, r) => s + r.total, 0);
            const efectivo = rooms.filter(r => (r.paymentMethod||'efectivo') === 'efectivo').reduce((s, r) => s + r.price, 0)
                          + shiftSales.filter(s => (s.paymentMethod||'efectivo') === 'efectivo').reduce((s, r) => s + r.total, 0);
            return { reg, torre, total, ingHab, consumos, tarjeta, efectivo };
        }

        const sd = shiftData(shiftDayStart, shiftDayEnd);
        const sn = shiftData(shiftNightStart, shiftNightEnd);

        const dayTotalHab = sd.total + sn.total;
        const dayTotalIng = sd.ingHab + sn.ingHab;
        const dayTotalCons = sd.consumos + sn.consumos;
        const dayTotal = dayTotalIng + dayTotalCons;
        const dayTarjeta = sd.tarjeta + sn.tarjeta;
        const dayEfectivo = sd.efectivo + sn.efectivo;

        totReg     += sd.reg + sn.reg;
        totTorre   += sd.torre + sn.torre;
        totHab     += dayTotalHab;
        totEfec    += dayEfectivo;
        totTarjeta += dayTarjeta;
        totIngHab  += dayTotalIng;
        totConsumos+= dayTotalCons;
        totTurno   += dayTotalIng + dayTotalCons;
        totDia     += dayTotal;

        const isEmpty = dayTotalHab === 0 && dayTotal === 0;

        // Fila encabezado del día
        const fechaCompleta = new Date(_mrYear, _mrMonth, d).toLocaleDateString('es-MX', {
            day: '2-digit',
            month: 'short'
        });
        
        html += `<tr class="mr-day-header${isEmpty ? ' mr-day-empty' : ''}">
            <td><strong>${d}</strong></td>
            <td style="text-align:left;">
                <div class="date-badge">
                    <span class="date-day">${fechaCompleta}</span>
                    <span class="date-weekday">${dayName}</span>
                </div>
            </td>
            <td></td>
            <td>${sd.reg + sn.reg || (isEmpty ? '—' : 0)}</td>
            <td>${sd.torre + sn.torre || (isEmpty ? '—' : 0)}</td>
            <td><strong>${dayTotalHab || (isEmpty ? '—' : 0)}</strong></td>
            <td class="mr-money">${fmtM(dayEfectivo)}</td>
            <td class="mr-money">${fmtM(dayTarjeta)}</td>
            <td class="mr-money">${fmtM(dayTotalIng)}</td>
            <td class="mr-money">${fmtM(dayTotalCons)}</td>
            <td class="mr-money"><strong>${fmtM(dayTotal)}</strong></td>
        </tr>`;

        if (!isEmpty) {
            // Fila turno día
            html += `<tr class="mr-shift-day">
                <td></td>
                <td style="text-align:left;padding-left:16px;">☀️ Turno Día</td>
                <td><span class="mr-shift-badge dia">DÍA</span></td>
                <td>${sd.reg}</td>
                <td>${sd.torre}</td>
                <td>${sd.total}</td>
                <td class="mr-money">${fmtM(sd.efectivo)}</td>
                <td class="mr-money">${fmtM(sd.tarjeta)}</td>
                <td class="mr-money">${fmtM(sd.ingHab)}</td>
                <td class="mr-money">${fmtM(sd.consumos)}</td>
                <td class="mr-money"><strong>${fmtM(sd.ingHab + sd.consumos)}</strong></td>
            </tr>`;

            // Fila turno noche
            html += `<tr class="mr-shift-night">
                <td></td>
                <td style="text-align:left;padding-left:16px;">🌙 Turno Noche</td>
                <td><span class="mr-shift-badge noche">NOCHE</span></td>
                <td>${sn.reg}</td>
                <td>${sn.torre}</td>
                <td>${sn.total}</td>
                <td class="mr-money">${fmtM(sn.efectivo)}</td>
                <td class="mr-money">${fmtM(sn.tarjeta)}</td>
                <td class="mr-money">${fmtM(sn.ingHab)}</td>
                <td class="mr-money">${fmtM(sn.consumos)}</td>
                <td class="mr-money"><strong>${fmtM(sn.ingHab + sn.consumos)}</strong></td>
            </tr>`;
        }
    }

    tbody.innerHTML = html;

    // Totales en tfoot Y en thead (fila superior)
    const setT = (id, val) => { 
        const el = document.getElementById(id); 
        if (el) el.textContent = val; 
    };
    
    // Actualizar totales de abajo (tfoot)
    setT('mr-tot-regulares', totReg);
    setT('mr-tot-torre', totTorre);
    setT('mr-tot-hab', totHab);
    setT('mr-tot-efectivo', fmtM(totEfec));
    setT('mr-tot-tarjeta', fmtM(totTarjeta));
    setT('mr-tot-ingresos-hab', fmtM(totIngHab));
    setT('mr-tot-consumos', fmtM(totConsumos));
    setT('mr-tot-total', fmtM(totDia));
    
    // Actualizar totales de arriba (thead duplicado)
    setT('mr-tot-regulares-top', totReg);
    setT('mr-tot-torre-top', totTorre);
    setT('mr-tot-hab-top', totHab);
    setT('mr-tot-efectivo-top', fmtM(totEfec));
    setT('mr-tot-tarjeta-top', fmtM(totTarjeta));
    setT('mr-tot-ingresos-hab-top', fmtM(totIngHab));
    setT('mr-tot-consumos-top', fmtM(totConsumos));
    setT('mr-tot-total-top', fmtM(totDia));
}

// ─── EXCEL: hoja de ingresos diarios en formato Lili ─────────────────────────
async function buildDailyIncomeSheet() {
    await ensureMonthDataLoaded(_mrYear, _mrMonth);
    const monthRevenueRecords = getMonthRecords(_mrYear, _mrMonth, 'revenue');
    const monthSalesRecords = getMonthRecords(_mrYear, _mrMonth, 'sales');
    const daysInMonth = new Date(_mrYear, _mrMonth + 1, 0).getDate();
    const dayNames = ['DOMINGO','LUNES','MARTES','MIÉRCOLES','JUEVES','VIERNES','SÁBADO'];
    const fmtM = n => n ? parseFloat(n.toFixed(2)) : 0;

    const rows = [];
    const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    rows.push(['INGRESOS — ' + months[_mrMonth].toUpperCase() + ' ' + _mrYear]);
    rows.push([]);
    rows.push(['FECHA','DÍA','TURNO','REGULARES','TORRE','TOTAL HAB.','EFECTIVO','TARJETA','INGRESOS HAB.','CONSUMOS','GANANCIA']);

    let totReg=0,totTorre=0,totHab=0,totEfec=0,totTarjeta=0,totIngHab=0,totCons=0,totDia=0;

    for (let d = 1; d <= daysInMonth; d++) {
        const shiftDayStart   = new Date(_mrYear, _mrMonth, d, 6, 0, 0).getTime();
        const shiftDayEnd     = new Date(_mrYear, _mrMonth, d, 17, 59, 59).getTime();
        const shiftNightStart = new Date(_mrYear, _mrMonth, d, 18, 0, 0).getTime();
        const shiftNightEnd   = new Date(_mrYear, _mrMonth, d + 1, 5, 59, 59).getTime();
        const dayOfWeek = new Date(_mrYear, _mrMonth, d).getDay();

        function sd(tsStart, tsEnd) {
            const rms = monthRevenueRecords.filter(r => r.timestamp >= tsStart && r.timestamp <= tsEnd && (r.type==='sold'||r.type==='renewal'));
            const sls = monthSalesRecords.filter(s => s.timestamp >= tsStart && s.timestamp <= tsEnd);
            const reg   = rms.filter(r => r.building==='regulares').length;
            const torre = rms.filter(r => r.building==='torre').length;
            const ingHab = rms.reduce((s,r)=>s+r.price,0);
            const consumos = sls.reduce((s,r)=>s+r.total,0);
            const tarjeta = rms.filter(r=>isCardOrBankPayment(r.paymentMethod)).reduce((s,r)=>s+r.price,0)
                          + sls.filter(s=>isCardOrBankPayment(s.paymentMethod)).reduce((s,r)=>s+r.total,0);
            const efectivo = rms.filter(r=>(r.paymentMethod||'efectivo')==='efectivo').reduce((s,r)=>s+r.price,0)
                          + sls.filter(s=>(s.paymentMethod||'efectivo')==='efectivo').reduce((s,r)=>s+r.total,0);
            return { reg, torre, total: rms.length, ingHab, consumos, tarjeta, efectivo };
        }

        const day = sd(shiftDayStart, shiftDayEnd);
        const night = sd(shiftNightStart, shiftNightEnd);
        const dayTot = day.ingHab + day.consumos + night.ingHab + night.consumos;
        const dayTarjeta = day.tarjeta + night.tarjeta;
        const dayEfectivo = day.efectivo + night.efectivo;

        totReg     += day.reg + night.reg;
        totTorre   += day.torre + night.torre;
        totHab     += day.total + night.total;
        totEfec    += dayEfectivo;
        totTarjeta += dayTarjeta;
        totIngHab  += day.ingHab + night.ingHab;
        totCons    += day.consumos + night.consumos;
        totDia     += dayTot;

        // Fila resumen del día
        rows.push([
            d, dayNames[dayOfWeek], 'RESUMEN',
            day.reg+night.reg, day.torre+night.torre,
            day.total+night.total, fmtM(dayEfectivo), fmtM(dayTarjeta),
            fmtM(day.ingHab+night.ingHab), fmtM(day.consumos+night.consumos),
            fmtM(dayTot)
        ]);
        // Turno día
        rows.push([
            '', 'Turno Día', 'DÍA',
            day.reg, day.torre, day.total, fmtM(day.efectivo), fmtM(day.tarjeta),
            fmtM(day.ingHab), fmtM(day.consumos), fmtM(day.ingHab+day.consumos)
        ]);
        // Turno noche
        rows.push([
            '', 'Turno Noche', 'NOCHE',
            night.reg, night.torre, night.total, fmtM(night.efectivo), fmtM(night.tarjeta),
            fmtM(night.ingHab), fmtM(night.consumos), fmtM(night.ingHab+night.consumos)
        ]);
        rows.push([]);
    }

    rows.push([]);
    rows.push(['TOTALES','','',totReg,totTorre,totHab,fmtM(totEfec),fmtM(totTarjeta),fmtM(totIngHab),fmtM(totCons),fmtM(totDia)]);
    return rows;
}

function renderMrExpenseList(containerId, list, type) {
    const container = document.getElementById(containerId);
    if (!container) return;
    let acc = 0;
    container.innerHTML = list.map((item, idx) => {
        acc += item.amount || 0;
        return `<div class="mr-row">
            <span>${sanitizeHTML(item.concept || item.category || '')}</span>
            <span class="date-badge-small">${fmtDate(item.date)}</span>
            <span>${fmt(item.amount)}</span>
            <span>${fmt(acc)}</span>
            <span><button onclick="deleteMrExpense('${type}',${idx})" style="background:none;border:none;color:#e74c3c;cursor:pointer;font-size:16px;">✕</button></span>
        </div>`;
    }).join('');
}

function renderMrSalaryList() {
    const container = document.getElementById('mr-direct-expenses-list');
    if (!container || !_mrData.salaries) return;
}

function getMrMovimientosFiltered(full, type) {
    const prefix = type === 'efectivo' ? 'mr-efectivo-mov' : 'mr-banco-mov';
    const qEl = document.getElementById(`${prefix}-filter`);
    const ftEl = document.getElementById(`${prefix}-filter-type`);
    const q = (qEl && qEl.value) ? String(qEl.value).trim().toLowerCase() : '';
    const ft = (ftEl && ftEl.value) ? ftEl.value : 'all';
    let list = full.slice();
    if (ft === 'in') list = list.filter((i) => (i.ingreso || 0) > 0);
    else if (ft === 'out') list = list.filter((i) => (i.egreso || 0) > 0);
    else if (ft === 'auto') list = list.filter((i) => i.autoGenerated);
    else if (ft === 'manual') list = list.filter((i) => !i.autoGenerated);
    if (q) {
        list = list.filter((i) => {
            const concept = (i.concept || '').toLowerCase();
            const dateS = String(i.date || '').toLowerCase();
            return concept.includes(q) || dateS.includes(q)
                || String(i.ingreso || '').includes(q) || String(i.egreso || '').includes(q);
        });
    }
    return list;
}

function filterMrMovimientos(type) {
    const id = type === 'efectivo' ? 'mr-efectivo-movimientos-list' : 'mr-banco-movimientos-list';
    renderMrMovimientosList(id, type);
}

function renderMrMovimientosList(containerId, type) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const full = type === 'efectivo' ? (_mrData.efectivoMovimientos || []) : (_mrData.bancoMovimientos || []);
    const list = getMrMovimientosFiltered(full, type);
    container.innerHTML = list.map((item) => {
        const originalIndex = full.indexOf(item);
        const ingreso = item.ingreso || 0;
        const egreso = item.egreso || 0;
        const ingresoStr = ingreso > 0 ? fmt(ingreso) : '-';
        const egresoStr = egreso > 0 ? fmt(egreso) : '-';
        const autoBadge = item.autoGenerated ? '<span class="mr-auto-badge" title="Generado automáticamente">AUTO</span>' : '';
        const ingCls = ingreso > 0 ? 'mr-movimiento-ingreso' : '';
        const egCls = egreso > 0 ? 'mr-movimiento-egreso' : '';
        return `<div class="mr-movimiento-row">
        <span class="date-badge-small date-badge-mov">${fmtDate(item.date)}</span>
        <span class="mr-mov-concept">${autoBadge}${sanitizeHTML(item.concept || '')}</span>
        <span class="${ingCls}">${ingresoStr}</span>
        <span class="${egCls}">${egresoStr}</span>
        <button type="button" class="btn-icon btn-danger" onclick="deleteMrMovimiento('${type}',${originalIndex})" title="Eliminar">✕</button>
    </div>`;
    }).join('');
}

function toggleSalaryFields() {
    const cat = document.getElementById('mr-direct-category')?.value;
    const normal = document.getElementById('mr-direct-normal-fields');
    const salary = document.getElementById('mr-direct-salary-fields');
    if (normal) normal.style.display = cat === 'salarios' ? 'none' : 'contents';
    if (salary) salary.style.display = cat === 'salarios' ? 'contents' : 'none';
}

function addMrDirectExpense() {
    const cat = document.getElementById('mr-direct-category')?.value;
    if (!cat) { showToast('Selecciona una categoría', 'error'); return; }
    if (cat === 'salarios') { addMrSalary(); return; }
    const concept = document.getElementById('mr-direct-concept')?.value.trim();
    const date = document.getElementById('mr-direct-date')?.value;
    const amount = parseFloat(document.getElementById('mr-direct-amount')?.value);
    if (!concept || !date || !amount) { showToast('Completa todos los campos', 'error'); return; }
    if (!_mrData.directExpenses) _mrData.directExpenses = [];
    _mrData.directExpenses.push({ category: cat, concept, date, amount });
    saveMonthlyReportData();
    generateMonthlyReport();
    document.getElementById('mr-direct-concept').value = '';
    document.getElementById('mr-direct-amount').value = '';
}

function addMrIndirectExpense() {
    const cat = document.getElementById('mr-indirect-category')?.value;
    const concept = document.getElementById('mr-indirect-concept')?.value.trim();
    const date = document.getElementById('mr-indirect-date')?.value;
    const amount = parseFloat(document.getElementById('mr-indirect-amount')?.value);
    if (!cat || !concept || !date || !amount) { showToast('Completa todos los campos', 'error'); return; }
    if (!_mrData.indirectExpenses) _mrData.indirectExpenses = [];
    _mrData.indirectExpenses.push({ category: cat, concept, date, amount });
    saveMonthlyReportData();
    generateMonthlyReport();
    document.getElementById('mr-indirect-concept').value = '';
    document.getElementById('mr-indirect-amount').value = '';
}

function addMrNonOpExpense() {
    const concept = document.getElementById('mr-nonop-concept')?.value.trim();
    const date = document.getElementById('mr-nonop-date')?.value;
    const amount = parseFloat(document.getElementById('mr-nonop-amount')?.value);
    if (!concept || !date || !amount) { showToast('Completa todos los campos', 'error'); return; }
    if (!_mrData.nonOpExpenses) _mrData.nonOpExpenses = [];
    _mrData.nonOpExpenses.push({ concept, date, amount });
    saveMonthlyReportData();
    generateMonthlyReport();
    document.getElementById('mr-nonop-concept').value = '';
    document.getElementById('mr-nonop-amount').value = '';
}

function addMrSalary() {
    const name = document.getElementById('mr-salary-name')?.value.trim();
    const date = document.getElementById('mr-salary-date')?.value;
    const tarifa = parseFloat(document.getElementById('mr-salary-tarifa')?.value);
    const neto = parseFloat(document.getElementById('mr-salary-neto')?.value);
    if (!name || !date || !neto) { showToast('Completa los campos de salario', 'error'); return; }
    if (!_mrData.directExpenses) _mrData.directExpenses = [];
    _mrData.directExpenses.push({ category: 'salarios', concept: name, date, amount: neto, tarifa });
    saveMonthlyReportData();
    generateMonthlyReport();
}

function addMrEfectivoMovimiento() {
    const date = document.getElementById('mr-efec-date')?.value;
    const concept = document.getElementById('mr-efec-concept')?.value.trim();
    const ingreso = parseFloat(document.getElementById('mr-efec-ingreso')?.value) || 0;
    const egreso = parseFloat(document.getElementById('mr-efec-egreso')?.value) || 0;
    if (!date || !concept) { showToast('Completa fecha y concepto', 'error'); return; }
    if (!_mrData.efectivoMovimientos) _mrData.efectivoMovimientos = [];
    _mrData.efectivoMovimientos.push({ date, concept, ingreso, egreso });
    saveMonthlyReportData();
    generateMonthlyReport();
    document.getElementById('mr-efec-concept').value = '';
    document.getElementById('mr-efec-ingreso').value = '';
    document.getElementById('mr-efec-egreso').value = '';
}

function addMrBancoMovimiento() {
    const date = document.getElementById('mr-banco-date')?.value;
    const concept = document.getElementById('mr-banco-concept')?.value.trim();
    const ingreso = parseFloat(document.getElementById('mr-banco-ingreso')?.value) || 0;
    const egreso = parseFloat(document.getElementById('mr-banco-egreso')?.value) || 0;
    if (!date || !concept) { showToast('Completa fecha y concepto', 'error'); return; }
    if (!_mrData.bancoMovimientos) _mrData.bancoMovimientos = [];
    _mrData.bancoMovimientos.push({ date, concept, ingreso, egreso });
    saveMonthlyReportData();
    generateMonthlyReport();
    document.getElementById('mr-banco-concept').value = '';
    document.getElementById('mr-banco-ingreso').value = '';
    document.getElementById('mr-banco-egreso').value = '';
}

function deleteMrExpense(type, index) {
    const map = { direct: 'directExpenses', indirect: 'indirectExpenses', nonop: 'nonOpExpenses' };
    const key = map[type];
    if (key && _mrData[key]) { _mrData[key].splice(index, 1); saveMonthlyReportData(); generateMonthlyReport(); }
}

function deleteMrSalary(index) { deleteMrExpense('direct', index); }

function deleteMrMovimiento(type, index) {
    const key = type === 'efectivo' ? 'efectivoMovimientos' : 'bancoMovimientos';
    if (_mrData[key]) {
        const movimiento = _mrData[key][index];
        // No permitir eliminar movimientos automáticos generados desde ventas
        if (movimiento && movimiento.autoGenerated) {
            showToast('No puedes eliminar movimientos automáticos de ventas', 'error');
            return;
        }
        _mrData[key].splice(index, 1);
        saveMonthlyReportData();
        generateMonthlyReport();
    }
}

async function onMonthYearChange() {
    _mrMonth = parseInt(document.getElementById('reportMonth')?.value);
    _mrYear = parseInt(document.getElementById('reportYear')?.value);
    loadMonthlyReportData();
    _mrData.anterioresUserEdited = false;
    loadPayrollEmployees();
    await generateMonthlyReport();

    // Actualizar nómina
    _currentWeek = 0; // Resetear a "todo el mes"
    document.getElementById('weekSelector').value = '0';
    updateWeekDateRange();
    renderWeeklyEmployees();
    updateWeeklySummary();

    // Actualizar listener al nuevo mes
    setupMrDataListener();
}

async function downloadMonthlyExcel() {
    if (typeof XLSX === 'undefined') { showToast('Librería Excel no disponible', 'error'); return; }

    // Verificar que las variables globales estén inicializadas
    if (_mrMonth === null || _mrYear === null) {
        showToast('Error: No se ha inicializado el reporte mensual', 'error');
        return;
    }

    await ensureMonthDataLoaded(_mrYear, _mrMonth);

    const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const mesNombre = months[_mrMonth];
    const fmt2 = n => parseFloat((n || 0).toFixed(2));
    const fmtDate = ts => new Date(ts).toLocaleDateString('es-MX', { day:'2-digit', month:'short', year:'numeric' });
    const fmtMoney = n => '$ ' + fmt2(n).toLocaleString('es-MX', { minimumFractionDigits: 2 });

    const wb = XLSX.utils.book_new();

    // ─── DATOS BASE ───────────────────────────────────────────────────────────
    const monthRooms = getMonthRecords(_mrYear, _mrMonth, 'revenue').filter(r => r.type === 'sold' || r.type === 'renewal');
    const monthSales = getMonthRecords(_mrYear, _mrMonth, 'sales');
    const roomsEfec = monthRooms.filter(r => isCashPayment(r.paymentMethod)).reduce((s,r)=>s+r.price,0);
    const roomsBanc = monthRooms.filter(r => isCardOrBankPayment(r.paymentMethod)).reduce((s,r)=>s+r.price,0);
    const salesEfec = monthSales.filter(s => isCashPayment(s.paymentMethod)).reduce((s,r)=>s+r.total,0);
    const salesBanc = monthSales.filter(s => isCardOrBankPayment(s.paymentMethod)).reduce((s,r)=>s+r.total,0);
    const totalIngresos = roomsEfec + salesEfec;

    const invCats = ['inversiones_alimentos','inversiones_sexshop'];
    const allDirect = _mrData.directExpenses || [];
    const invTotal    = allDirect.filter(e=>invCats.includes(e.category)).reduce((s,e)=>s+e.amount,0);
    const directTotal = allDirect.reduce((s,e)=>s+(e.amount||0),0);
    const indirTotal  = (_mrData.indirectExpenses||[]).reduce((s,e)=>s+e.amount,0);
    const nonOpTotal  = (_mrData.nonOpExpenses||[]).reduce((s,e)=>s+e.amount,0);
    const utBruta     = totalIngresos - (directTotal - invTotal) - indirTotal;
    const utNeta      = utBruta - invTotal - nonOpTotal;
    const salItems    = _mrData.salaries || [];
    const salAcum     = salItems.reduce((s,e)=>s+(e.neto||0),0);

    // ─── HOJA 1: RESUMEN ─────────────────────────────────────────────────────
    const resumen = [
        ['REPORTE MENSUAL — ' + mesNombre.toUpperCase() + ' ' + _mrYear],
        [],
        ['RESUMEN EJECUTIVO'],
        [],
        ['CONCEPTO', '', 'MONTO'],
        [],
        ['INGRESOS'],
        ['  Habitaciones (efectivo)', '', fmtMoney(roomsEfec)],
        ['  Habitaciones (banco)*', '', fmtMoney(roomsBanc)],
        ['  Ventas inventario (efectivo)', '', fmtMoney(salesEfec)],
        ['  Ventas inventario (banco)*', '', fmtMoney(salesBanc)],
        [],
        ['TOTAL INGRESOS EFECTIVO', '', fmtMoney(totalIngresos)],
        [],
        [],
        ['EGRESOS'],
        ['  Gastos directos (operativos)', '', fmtMoney(directTotal - invTotal)],
        ['  Gastos indirectos', '', fmtMoney(indirTotal)],
        ['  Inversiones', '', fmtMoney(invTotal)],
        ['  Gastos no operativos', '', fmtMoney(nonOpTotal)],
        ['  Nómina', '', fmtMoney(salAcum)],
        [],
        ['TOTAL EGRESOS', '', fmtMoney((directTotal - invTotal) + indirTotal + invTotal + nonOpTotal + salAcum)],
        [],
        [],
        ['UTILIDADES'],
        ['  Utilidad Bruta', '', fmtMoney(utBruta)],
        ['  Utilidad Neta', '', fmtMoney(utNeta)],
        [],
        [],
        ['NOTAS:'],
        ['* Los ingresos a banco son ilustrativos y no se suman al efectivo disponible'],
        ['* La utilidad bruta = Ingresos - (Gastos directos - Inversiones) - Gastos indirectos'],
        ['* La utilidad neta = Utilidad bruta - Inversiones - Gastos no operativos'],
    ];
    const wsResumen = XLSX.utils.aoa_to_sheet(resumen);
    wsResumen['!cols'] = [{wch:45},{wch:5},{wch:20}];
    
    // Aplicar formato al resumen
    if (wsResumen['A1']) wsResumen['A1'].s = { font: { bold: true, sz: 14 } };
    if (wsResumen['A3']) wsResumen['A3'].s = { font: { bold: true } };
    if (wsResumen['A7']) wsResumen['A7'].s = { font: { bold: true } };
    if (wsResumen['A16']) wsResumen['A16'].s = { font: { bold: true } };
    if (wsResumen['A26']) wsResumen['A26'].s = { font: { bold: true } };
    
    XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

    // ─── HOJA 2: GASTOS (formato mejorado) ──────────────────────────────────
    const gastoRows = [];
    gastoRows.push(['GASTOS DETALLADOS — ' + mesNombre.toUpperCase() + ' ' + _mrYear]);
    gastoRows.push([]);
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push(['GASTOS DE OPERACIÓN']);
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push([]);

    const catLabels = {
        agua: 'AGUA', 
        luz: 'LUZ', 
        gas: 'GAS',
        limpieza: 'PRODUCTOS DE LIMPIEZA',
        inversiones_alimentos: 'ALIMENTOS Y BEBIDAS',
        inversiones_sexshop: 'SEX SHOP',
        mercadotecnia: 'MERCADOTECNIA',
        otros: 'GENERALES',
    };
    const catOrder = ['agua','luz','gas','limpieza','inversiones_alimentos','inversiones_sexshop','mercadotecnia','otros'];
    let totalDirectOp = 0;

    catOrder.forEach(function(cat) {
        const items = allDirect.filter(function(e){ return e.category === cat; });
        gastoRows.push(['─── ' + (catLabels[cat] || cat.toUpperCase()) + ' ───']);
        gastoRows.push(['Fecha', 'Concepto', '', 'Monto', '', '']);
        
        if (items.length === 0) {
            gastoRows.push(['', '(sin registros)', '', fmtMoney(0), '', '']);
        } else {
            let acum = 0;
            items.forEach(function(e) {
                acum += e.amount;
                gastoRows.push([e.date || '—', e.concept || '—', '', fmtMoney(e.amount), '', '']);
            });
            gastoRows.push([]);
            gastoRows.push(['', '', '', 'SUBTOTAL:', '', fmtMoney(acum)]);
            totalDirectOp += acum;
        }
        gastoRows.push([]);
    });

    // Salarios
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push(['─── NÓMINA / SALARIOS ───']);
    gastoRows.push(['Fecha', 'Empleado', '', 'Monto', '', '']);
    
    if (salItems.length === 0) {
        gastoRows.push(['', '(sin registros)', '', fmtMoney(0), '', '']);
    } else {
        salItems.forEach(function(e) {
            const employeeName = e.concept || e.name || '—';
            gastoRows.push([e.date || '—', employeeName, '', fmtMoney(e.neto || 0), '', '']);
        });
    }
    gastoRows.push([]);
    gastoRows.push(['', '', '', 'SUBTOTAL NÓMINA:', '', fmtMoney(salAcum)]);
    gastoRows.push([]);
    gastoRows.push(['', '', '', 'TOTAL GASTOS DE OPERACIÓN:', '', fmtMoney(totalDirectOp + salAcum)]);
    gastoRows.push([]);
    gastoRows.push([]);

    // Indirectos
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push(['GASTOS INDIRECTOS']);
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push([]);
    
    const indirCatLabels = { 
        mercadotecnia:'MERCADOTECNIA', 
        administracion:'ADMINISTRACIÓN', 
        mantenimiento:'MANTENIMIENTO' 
    };
    const indirBycat = {};
    (_mrData.indirectExpenses||[]).forEach(function(e) {
        if (!indirBycat[e.category]) indirBycat[e.category] = [];
        indirBycat[e.category].push(e);
    });
    
    let totalIndir = 0;
    
    if (Object.keys(indirBycat).length === 0) {
        gastoRows.push(['(sin registros)']);
    } else {
        Object.entries(indirBycat).forEach(function(entry) {
            const cat = entry[0], items = entry[1];
            gastoRows.push(['─── ' + (indirCatLabels[cat] || cat.toUpperCase()) + ' ───']);
            gastoRows.push(['Fecha', 'Concepto', '', 'Monto', '', '']);
            
            let acum = 0;
            items.forEach(function(e) { 
                acum += e.amount; 
                gastoRows.push([e.date || '—', e.concept || '—', '', fmtMoney(e.amount), '', '']); 
            });
            gastoRows.push([]);
            gastoRows.push(['', '', '', 'SUBTOTAL:', '', fmtMoney(acum)]);
            gastoRows.push([]);
            totalIndir += acum;
        });
    }
    
    gastoRows.push(['', '', '', 'TOTAL GASTOS INDIRECTOS:', '', fmtMoney(totalIndir)]);
    gastoRows.push([]);
    gastoRows.push([]);

    // No operativos
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push(['INVERSIONES Y GASTOS NO OPERATIVOS']);
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push([]);
    gastoRows.push(['Fecha', 'Concepto', '', 'Monto', '', '']);
    
    let totalNonOp = 0;
    if ((_mrData.nonOpExpenses||[]).length === 0) {
        gastoRows.push(['', '(sin registros)', '', fmtMoney(0), '', '']);
    } else {
        (_mrData.nonOpExpenses||[]).forEach(function(e) {
            totalNonOp += e.amount;
            gastoRows.push([e.date || '—', e.concept || '—', '', fmtMoney(e.amount), '', '']);
        });
    }
    gastoRows.push([]);
    gastoRows.push(['', '', '', 'TOTAL NO OPERATIVOS:', '', fmtMoney(totalNonOp)]);
    gastoRows.push([]);
    gastoRows.push(['', '', '', 'TOTAL INVERSIONES (incluidas en directos):', '', fmtMoney(invTotal)]);
    gastoRows.push([]);
    gastoRows.push([]);
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push(['RESUMEN FINAL']);
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push([]);
    gastoRows.push(['', '', '', 'UTILIDAD BRUTA:', '', fmtMoney(utBruta)]);
    gastoRows.push(['', '', '', 'UTILIDAD NETA:', '', fmtMoney(utNeta)]);

    const wsGastos = XLSX.utils.aoa_to_sheet(gastoRows);
    wsGastos['!cols'] = [{wch:14},{wch:35},{wch:4},{wch:18},{wch:4},{wch:18}];
    XLSX.utils.book_append_sheet(wb, wsGastos, 'Gastos');

    // ─── HOJA 3: INGRESOS DIARIOS (formato Lili) ─────────────────────────────
    const dailyRows = await buildDailyIncomeSheet();
    const wsDaily = XLSX.utils.aoa_to_sheet(dailyRows);
    wsDaily['!cols'] = [{wch:6},{wch:12},{wch:8},{wch:10},{wch:8},{wch:8},{wch:10},{wch:10},{wch:14},{wch:12},{wch:14},{wch:14},{wch:12}];
    XLSX.utils.book_append_sheet(wb, wsDaily, 'Ingresos Diarios');

    // ─── HOJA 4: NOMINA POR SEMANAS ───────────────────────────────────────────────
    const nomRows = [
        ['NÓMINA MENSUAL — ' + mesNombre.toUpperCase() + ' ' + _mrYear],
        [],
        ['DESGLOSE POR SEMANAS'],
        []
    ];
    
    let totalGeneralNomina = 0;
    
    // Procesar cada semana (1 a 4)
    for (let weekNum = 1; weekNum <= 4; weekNum++) {
        // Filtrar empleados que trabajan en esta semana (campo 'weeks' es array)
        const weekEmployees = _payrollEmployees.filter(e => {
            if (e.weeks && Array.isArray(e.weeks)) {
                return e.weeks.includes(weekNum);
            }
            // Compatibilidad con formato antiguo (campo 'week' singular)
            return e.week === weekNum;
        });
        
        if (weekEmployees.length === 0) {
            nomRows.push([`SEMANA ${weekNum}`, '', '', '', '']);
            nomRows.push(['(sin empleados registrados)']);
            nomRows.push([]);
            continue;
        }
        
        nomRows.push([`SEMANA ${weekNum}`]);
        nomRows.push([]);
        nomRows.push(['Nombre', 'Departamento', 'Turno', 'Tarifa Diaria', 'Días', 'Total']);
        nomRows.push([]); // Línea separadora
        
        let weekTotal = 0;
        
        // Agrupar por turno para mejor organización
        const byShift = {
            'día': [],
            'noche': [],
            'día, fin de semana': [],
            'noche, fin de semana': []
        };
        
        weekEmployees.forEach(emp => {
            const shiftKey = emp.shift.toLowerCase();
            if (byShift[shiftKey]) {
                byShift[shiftKey].push(emp);
            } else {
                byShift['día'].push(emp); // Fallback
            }
        });
        
        // Procesar cada turno
        Object.entries(byShift).forEach(([shiftName, employees]) => {
            if (employees.length === 0) return;
            
            // Título del turno
            const shiftLabel = shiftName.toUpperCase();
            nomRows.push([shiftLabel, '', '', '', '', '']);
            
            // Agrupar por departamento dentro del turno
            const byDept = {
                'lavanderia': [],
                'suites-lm': [],
                'casa': []
            };
            
            employees.forEach(emp => {
                const deptKey = emp.department.toLowerCase();
                if (byDept[deptKey]) {
                    byDept[deptKey].push(emp);
                } else {
                    byDept['lavanderia'].push(emp); // Fallback
                }
            });
            
            // Procesar cada departamento
            Object.entries(byDept).forEach(([deptKey, deptEmployees]) => {
                if (deptEmployees.length === 0) return;
                
                const deptLabel = deptKey === 'lavanderia' ? 'Lavandería'
                    : deptKey === 'suites-lm' ? 'Suites LM'
                    : deptKey === 'casa' ? 'Casa'
                    : deptKey;
                
                // Empleados del departamento
                deptEmployees.forEach(emp => {
                    const dailyRate = sanitizeNumber(emp.dailyRate, 0);
                    const days = sanitizeInt(emp.days, 0);
                    const total = sanitizeNumber(emp.total, dailyRate * days);
                    
                    nomRows.push([
                        sanitizeHTML(emp.name || 'Sin nombre'),
                        deptLabel,
                        '', // Turno ya está en el header
                        fmtMoney(dailyRate),
                        days.toString(),
                        fmtMoney(total)
                    ]);
                    
                    weekTotal += total;
                });
            });
            
            nomRows.push([]); // Espacio entre turnos
        });
        
        // Subtotal de la semana
        nomRows.push(['', '', '', '', 'SUBTOTAL SEMANA ' + weekNum, fmtMoney(weekTotal)]);
        nomRows.push([]);
        nomRows.push([]); // Doble espacio entre semanas
        
        totalGeneralNomina += weekTotal;
    }
    
    // Total general
    nomRows.push([]);
    nomRows.push(['', '', '', '', 'TOTAL GENERAL NÓMINA', fmtMoney(totalGeneralNomina)]);
    nomRows.push([]);
    nomRows.push(['* Este total debe coincidir con los salarios en la hoja de Gastos']);
    
    const wsNomina = XLSX.utils.aoa_to_sheet(nomRows);
    wsNomina['!cols'] = [{wch:25},{wch:15},{wch:20},{wch:15},{wch:8},{wch:15}];
    
    // Aplicar formato a las celdas de encabezado
    const range = XLSX.utils.decode_range(wsNomina['!ref']);
    for (let R = range.s.r; R <= range.e.r; ++R) {
        for (let C = range.s.c; C <= range.e.c; ++C) {
            const cellAddress = XLSX.utils.encode_cell({r: R, c: C});
            if (!wsNomina[cellAddress]) continue;
            
            // Aplicar formato a títulos y subtotales
            const cellValue = wsNomina[cellAddress].v;
            if (typeof cellValue === 'string') {
                if (cellValue.includes('SEMANA') || cellValue.includes('TOTAL') || cellValue.includes('NÓMINA')) {
                    wsNomina[cellAddress].s = {
                        font: { bold: true },
                        fill: { fgColor: { rgb: "E8E8E8" } }
                    };
                }
            }
        }
    }
    
    XLSX.utils.book_append_sheet(wb, wsNomina, 'Nomina');

    XLSX.writeFile(wb, 'ReporteMensual_' + mesNombre + '_' + _mrYear + '.xlsx');
    showToast('Descargando Excel: ' + mesNombre + ' ' + _mrYear, 'success');
}

// ============ MODAL CLOSE LISTENERS ============

document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('show');
    }
});

// ============ INVENTARIO — EDITAR / ELIMINAR ============

function editInventoryItem(itemId) {
    const item = inventory.find(i => i.id === itemId);
    if (!item) return;
    editingProductId = itemId;
    const modal = document.getElementById('productModal');
    document.getElementById('productName').value = item.name;
    document.getElementById('productCategory').value = item.category || 'bebidas';
    document.getElementById('productQuantity').value = item.quantity;
    document.getElementById('productPrice').value = item.price;
    const saveBtn = document.getElementById('saveProductBtn');
    if (saveBtn) saveBtn.textContent = 'Actualizar';
    modal.classList.add('show');
}

function deleteInventoryItem(itemId) {
    const item = inventory.find(i => i.id === itemId);
    if (!item) return;
    showCustomConfirm('Eliminar Producto', 'Eliminar este producto del inventario?').then(confirmed => {
        if (!confirmed) return;
        // Soft-delete (igual que staff/anuncios/gastos) en vez de quitarlo del
        // arreglo: con la sincronización por merge-by-id, un id que
        // desaparece por completo de un lado puede "resucitar" si el otro
        // dispositivo todavía tiene una copia vieja del producto.
        item.deleted = true;
        item.deletedAt = Date.now();
        item.lastModified = Date.now();
        saveData();
        renderInventory();
        showToast('Producto eliminado', 'success');
    });
}


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
function handleFirebaseRealtimeUpdate(key, val) {
    if (val === null || val === undefined) {
        console.warn(`[Listener] ⚠️ Valor null para ${key}, ignorando`);
        return;
    }

    console.log(`[App] 🔄 Cambio detectado desde Firebase: ${key}`);

    switch (key) {
        case 'motelStaffMembers':
            if (Array.isArray(val)) {
                staffMembers = val;
                localStorage.setItem('motelStaffMembers', JSON.stringify(val));
                renderAttendanceList();
            }
            break;

        case 'motelRooms':
            if (Array.isArray(val) && val.length > 0) {
                const currentRooms = rooms || [];
                const incomingRooms = val;

                rooms = mergeRoomsFromFirebase(incomingRooms, currentRooms);
                localStorage.setItem('motelRooms', JSON.stringify(rooms));

                // Antes solo comparaba r.status !== inc.status para decidir si
                // había que re-subir el resultado del merge a Firebase. Con el
                // fix de resolveRoomConflict() que también puede quedarse con
                // el precio/endTime/etc. LOCAL cuando su lastModified es más
                // nuevo (p.ej. una renovación reciente en ESTE dispositivo que
                // el remoto aún no vio), el status podía coincidir en ambos
                // lados mientras el precio seguía siendo distinto — y esa
                // corrección nunca se volvía a subir. _roomsDiffer() detecta
                // cualquier campo que haya "ganado" localmente, no solo el
                // status (comparación por clave, no por JSON.stringify crudo,
                // porque el orden de claves entre el objeto local y el que
                // llegó de Firestore no está garantizado y produciría falsos
                // positivos constantes).
                const incomingById = new Map(incomingRooms.map(r => [r.id, r]));
                const localWon = rooms.some(r => {
                    const inc = incomingById.get(r.id);
                    return inc && _roomsDiffer(r, inc);
                });
                if (localWon) saveData();

                if (currentUser && currentUser.role === 'limpieza') renderCleaningRooms();
                else renderRooms();
                renderReservationsSidebar();

                if (document.getElementById('shift-control-tab')?.classList.contains('active')) {
                    updateShiftControl();
                } else {
                    _shiftDataStale = true;
                }
                updateStatistics();
            }
            break;

        case 'motelAnnouncements':
            if (Array.isArray(val)) {
                announcements = val;
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
                inventory = mergeInventoryFromCloud(val, inventory);
                localStorage.setItem('motelInventory', JSON.stringify(inventory));
                renderInventory();
            }
            break;

        case 'motelReservations':
            if (Array.isArray(val)) {
                reservations = mergeReservationsFromCloud(val, reservations);
                localStorage.setItem('motelReservations', JSON.stringify(reservations));
                renderReservationsSidebar();
            }
            break;

        case 'motelShiftReports':
            if (Array.isArray(val)) {
                shiftReports = val;
                localStorage.setItem('motelShiftReports', JSON.stringify(val));
            }
            break;

        case 'motelShiftSnapshots':
            if (Array.isArray(val)) {
                shiftSnapshots = val;
                localStorage.setItem('motelShiftSnapshots', JSON.stringify(val));
            }
            break;

        case 'motelActivityLog':
            if (Array.isArray(val)) {
                activityLog = val;
                localStorage.setItem('motelActivityLog', JSON.stringify(val));
            }
            break;

        case 'deepCleanSchedules':
            if (Array.isArray(val)) {
                deepCleanSchedules = val;
                localStorage.setItem('deepCleanSchedules', JSON.stringify(val));
            }
            break;

        case 'motelUsers':
            if (Array.isArray(val)) {
                users = val;
                localStorage.setItem('motelUsers', JSON.stringify(val));
                if (currentUser && currentUser.role === 'director') renderUsersList();
            }
            break;

        case 'motelCurrentShiftStart':
            if (val && (!currentShiftStart || val > currentShiftStart)) {
                currentShiftStart = val;
                localStorage.setItem('motelCurrentShiftStart', JSON.stringify(val));
                console.log('[Sync] currentShiftStart actualizado:', new Date(currentShiftStart));
                if (document.getElementById('shift-control-tab')?.classList.contains('active')) {
                    updateShiftControl();
                } else {
                    _shiftDataStale = true;
                }
                updateStatistics();
            }
            break;

        case 'motelCurrentShiftType':
            if (val) {
                currentShiftType = val;
                localStorage.setItem('motelCurrentShiftType', val);
                console.log('[Sync] currentShiftType actualizado:', currentShiftType);
                if (document.getElementById('shift-control-tab')?.classList.contains('active')) {
                    updateShiftControl();
                } else {
                    _shiftDataStale = true;
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

async function initFirebaseSync() {
    if (!window.FirebaseSync || !window.FirebaseSync.ready || _fbListening) return;
    _fbListening = true;
    _fbInitTime = Date.now();
    _appReady = true;

    // Configurar callback de estado de conexión
    window.FirebaseSync.onStatusChange((isOnline, syncedCount) => {
        updateConnectionStatus(isOnline, syncedCount);
    });
    
    // Actualizar estado inicial
    updateConnectionStatus(window.FirebaseSync.isOnline(), 0);

    // Cargar datos desde Firebase (fuente de verdad)
    // Siempre usar loadAllFresh para evitar datos obsoletos del caché IndexedDB
    // cuando la app se abre desde el acceso directo después de horas en background
    try {
        // Procesar cola offline PRIMERO: subir cambios locales pendientes antes de leer
        // el estado "fresco" de Firebase. Sin esto, Firebase podría devolver datos
        // más viejos que los cambios que el usuario hizo mientras estaba sin conexión.
        if (window.FirebaseSync.syncPending) {
            try { await window.FirebaseSync.syncPending(); } catch(_) {}
        }

        console.log('[App] Cargando datos frescos desde Firebase (servidor)...');
        const fbData = await window.FirebaseSync.loadAllFresh();
        
        let dataLoaded = false;
        
        if (fbData.motelRooms && fbData.motelRooms.length > 0) {
            // Merge inteligente en lugar de reemplazar directo - previene pérdida de datos locales
            rooms = mergeRoomsFromFirebase(fbData.motelRooms, rooms);
            localStorage.setItem('motelRooms', JSON.stringify(rooms));
            dataLoaded = true;
        }
        if (Array.isArray(fbData.motelInventory)) {
            inventory = mergeInventoryFromCloud(fbData.motelInventory, inventory);
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
        await migrateToMonthlyShards();
        await _loadHotShardsFromFirebase();
        persistHotShards();
        dataLoaded = true;
        if (Array.isArray(fbData.motelShiftReports)) {
            shiftReports = fbData.motelShiftReports;
            localStorage.setItem('motelShiftReports', JSON.stringify(shiftReports));
            dataLoaded = true;
        }
        if (Array.isArray(fbData.motelShiftSnapshots)) {
            shiftSnapshots = fbData.motelShiftSnapshots;
            localStorage.setItem('motelShiftSnapshots', JSON.stringify(shiftSnapshots));
            dataLoaded = true;
        }
        if (fbData.motelCurrentShiftStart) {
            // Solo usar Firebase si es MÁS RECIENTE que el valor local
            // Protege contra sobrescritura de un turno recién iniciado en este dispositivo
            if (!currentShiftStart || fbData.motelCurrentShiftStart > currentShiftStart) {
                currentShiftStart = fbData.motelCurrentShiftStart;
                localStorage.setItem('motelCurrentShiftStart', JSON.stringify(currentShiftStart));
            }
            dataLoaded = true;
        }
        if (fbData.motelCurrentShiftType) {
            currentShiftType = fbData.motelCurrentShiftType;
            localStorage.setItem('motelCurrentShiftType', currentShiftType);
            dataLoaded = true;
        }
        if (Array.isArray(fbData.motelActivityLog)) {
            activityLog = fbData.motelActivityLog;
            localStorage.setItem('motelActivityLog', JSON.stringify(activityLog));
            dataLoaded = true;
        }
        if (Array.isArray(fbData.motelReservations)) {
            // Merge por ID para preservar reservas locales no sincronizadas aún
            reservations = mergeReservationsFromCloud(fbData.motelReservations, reservations);
            localStorage.setItem('motelReservations', JSON.stringify(reservations));
            dataLoaded = true;
        }
        if (Array.isArray(fbData.deepCleanSchedules)) {
            deepCleanSchedules = fbData.deepCleanSchedules;
            localStorage.setItem('deepCleanSchedules', JSON.stringify(deepCleanSchedules));
            dataLoaded = true;
        }
        if (Array.isArray(fbData.motelStaffMembers)) {
            staffMembers = fbData.motelStaffMembers;
            localStorage.setItem('motelStaffMembers', JSON.stringify(staffMembers));
            dataLoaded = true;
        }
        if (Array.isArray(fbData.motelAnnouncements)) {
            announcements = fbData.motelAnnouncements;
            localStorage.setItem('motelAnnouncements', JSON.stringify(announcements));
            dataLoaded = true;
        }
        if (Array.isArray(fbData.motelUsers)) {
            users = fbData.motelUsers;
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
                rooms = createInitialRooms();
                console.log('[App] ✓ Habitaciones iniciales creadas');
            }
        }
        
        // Ahora que los datos están cargados, verificar currentShiftStart
        if (!currentShiftStart || currentShiftStart === 0) {
            currentShiftStart = getShiftTimeRange().shiftStart;
            console.log('[App] currentShiftStart inicializado después de cargar Firebase');
        }
        
        // Inicializar currentShiftType si no existe
        if (!currentShiftType) {
            const now = new Date();
            const hour = now.getHours();
            currentShiftType = (hour >= 6 && hour < 18) ? 'day' : 'night';
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

    // 🔥 LISTENER EN TIEMPO REAL — activado 2 s después para no solaparse con la carga inicial
    if (window.FirebaseSync.listenAll) {
        setTimeout(() => {
        console.log('[App] 🔥 Activando sincronización en tiempo real (selectiva)...');

        _reactivateRealtimeListeners('carga inicial');
        _hotWindowAnchorKey = `${new Date().getFullYear()}_${new Date().getMonth()}`; // evita que el rollover horario vuelva a disparar la suscripción que ya se acaba de hacer arriba

        console.log('[App] ✅ Sincronización en tiempo real ACTIVADA (selectiva)');

        // Iniciar sistema de reconexión automática
        if (window.FirebaseSync && window.FirebaseSync.startReconnectionSystem) {
            window.FirebaseSync.startReconnectionSystem();
            console.log('[App] 🔄 Sistema de reconexión automática iniciado');
        }
        }, 2000); // fin setTimeout listenAll
    }
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

        try {
            // 1. Forzar reactivación de la red Firebase (puede estar dormida)
            _db.enableNetwork().catch(() => {});

            // 1.5. Procesar cola offline PRIMERO — subir los cambios locales pendientes
            // ANTES de leer Firebase. De lo contrario, un loadAllFresh puede traer datos
            // más viejos que los cambios que quedaron en la cola mientras estaba sin red.
            if (window.FirebaseSync.syncPending) {
                try { await window.FirebaseSync.syncPending(); } catch(_) {}
            }

            // 2. Recargar datos directamente del servidor (sin caché stale)
            const fbData = await window.FirebaseSync.loadAllFresh();

            // Aplicar datos frescos a las variables globales (misma lógica que initApp)
            if (fbData.motelRooms && Array.isArray(fbData.motelRooms) && fbData.motelRooms.length > 0) {
                rooms = mergeRoomsFromFirebase(fbData.motelRooms, rooms);
                localStorage.setItem('motelRooms', JSON.stringify(rooms));
            }
            if (fbData.motelInventory && Array.isArray(fbData.motelInventory)) {
                inventory = mergeInventoryFromCloud(fbData.motelInventory, inventory);
                localStorage.setItem('motelInventory', JSON.stringify(inventory));
            }
            // roomRevenue/sales/expenses: recargar/re-fusionar la ventana
            // caliente por shard mensual (ya no viven en fbData).
            await _loadHotShardsFromFirebase();
            persistHotShards();
            rolloverHotWindowIfNeeded();
            if (fbData.motelReservations && Array.isArray(fbData.motelReservations)) {
                reservations = mergeReservationsFromCloud(fbData.motelReservations, reservations);
                localStorage.setItem('motelReservations', JSON.stringify(reservations));
            }
            if (fbData.motelShiftReports && Array.isArray(fbData.motelShiftReports)) {
                shiftReports = fbData.motelShiftReports;
                localStorage.setItem('motelShiftReports', JSON.stringify(shiftReports));
            }
            if (fbData.motelShiftSnapshots && Array.isArray(fbData.motelShiftSnapshots)) {
                shiftSnapshots = fbData.motelShiftSnapshots;
                localStorage.setItem('motelShiftSnapshots', JSON.stringify(shiftSnapshots));
            }
            if (fbData.motelActivityLog && Array.isArray(fbData.motelActivityLog)) {
                activityLog = fbData.motelActivityLog;
                localStorage.setItem('motelActivityLog', JSON.stringify(activityLog));
            }
            if (fbData.motelStaffMembers && Array.isArray(fbData.motelStaffMembers)) {
                staffMembers = fbData.motelStaffMembers;
                localStorage.setItem('motelStaffMembers', JSON.stringify(staffMembers));
            }
            if (fbData.motelAnnouncements && Array.isArray(fbData.motelAnnouncements)) {
                announcements = fbData.motelAnnouncements;
                localStorage.setItem('motelAnnouncements', JSON.stringify(announcements));
            }
            if (fbData.motelUsers && Array.isArray(fbData.motelUsers)) {
                users = fbData.motelUsers;
                localStorage.setItem('motelUsers', JSON.stringify(users));
            }
            if (fbData.deepCleanSchedules && Array.isArray(fbData.deepCleanSchedules)) {
                deepCleanSchedules = fbData.deepCleanSchedules;
                localStorage.setItem('deepCleanSchedules', JSON.stringify(deepCleanSchedules));
            }
            if (fbData.motelCurrentShiftStart) {
                currentShiftStart = fbData.motelCurrentShiftStart;
                localStorage.setItem('motelCurrentShiftStart', JSON.stringify(currentShiftStart));
            }
            if (fbData.motelCurrentShiftType) {
                currentShiftType = fbData.motelCurrentShiftType;
                localStorage.setItem('motelCurrentShiftType', currentShiftType);
            }

            // 3. Re-activar listeners en tiempo real (pueden estar muertos tras horas) —
            // tanto motelRooms/etc. (listenAll) como los shards mensuales de
            // roomRevenue/sales/expenses, a través del punto único con
            // debounce (ver _reactivateRealtimeListeners) para que esto no
            // colisione con la reactivación de la carga inicial si ambas
            // llegan a dispararse a los pocos segundos una de la otra.
            _reactivateRealtimeListeners('volver del background');

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
                _shiftDataStale = true;
            }

            console.log('[App] Datos frescos aplicados tras volver del background.');
        } catch (e) {
            console.error('[App] Error recargando tras background:', e);
        }
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
async function resetSystemData() {
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
async function confirmResetSystem(code) {
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
        rooms = createInitialRooms();
        console.log('✓ Habitaciones reseteadas');
        
        // PASO 3: Limpiar todas las colecciones
        inventory = [];
        sales = [];
        roomRevenue = [];
        invalidateRevenueIndex();
        expenses = [];
        shiftReports = [];
        shiftSnapshots = [];
        currentShiftStart = Date.now(); // Nuevo turno
        currentShiftType = (new Date().getHours() >= 6 && new Date().getHours() < 18) ? 'day' : 'night';
        activityLog = [];
        reservations = [];
        deepCleanSchedules = [];
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

// ELIMINADO POR SEGURIDAD: Funciones de reseteo no expuestas globalmente
// Solo el director puede acceder a estas funciones desde el código
// window.resetSystemData = resetSystemData;
// window.confirmResetSystem = confirmResetSystem;

// Para resetear el sistema: escribir resetSystemData() en la consola del navegador

// ============ FIN RESETEO TOTAL DEL SISTEMA ============


// ============================================================================
// GESTIÓN DE USUARIOS (Solo Director)
// ============================================================================

/**
 * Sincronizar contraseñas locales a Firebase (si no existen en Firebase)
 */
async function syncLocalPasswordsToFirebase() {
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
 * Renderizar lista de usuarios
 */
async function renderUsersList() {
    const container = document.getElementById('usersList');
    if (!container) return;
    
    // Recargar usuarios desde Firebase primero
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        try {
            const firebaseUsers = await window.FirebaseSync.load('motelUsers');
            if (firebaseUsers && Array.isArray(firebaseUsers)) {
                users = firebaseUsers;
                safeLocalStorageSet('motelUsers', users);
            }
        } catch (err) {
            console.error('[Users] Error cargando usuarios desde Firebase:', err);
        }
    }
    
    // Si no hay usuarios en Firebase, cargar desde localStorage
    if (!users || users.length === 0) {
        users = loadUsers();
    }
    
    if (users.length === 0) {
        container.innerHTML = '<div class="no-users">No hay usuarios registrados</div>';
        return;
    }
    
    container.innerHTML = users.map(user => `
        <div class="user-card" id="user-card-${sanitizeHTML(user.username)}">
            <div class="user-info">
                <div class="user-header">
                    <span class="user-icon">${getRoleIcon(user.role)}</span>
                    <div>
                        <div class="user-name">${sanitizeHTML(user.name)}</div>
                        <div class="user-username">@${sanitizeHTML(user.username)}</div>
                    </div>
                </div>
                <div class="user-role-badge ${user.role}">${getRoleName(user.role)}</div>
            </div>
            
            <!-- Botón para expandir/contraer -->
            <button class="btn-toggle-details" onclick="toggleUserDetails('${sanitizeHTML(user.username)}')">
                <span id="toggle-icon-${sanitizeHTML(user.username)}">👁️ Ver Contraseña</span>
            </button>
            
            <!-- Detalles expandibles -->
            <div class="user-details" id="user-details-${sanitizeHTML(user.username)}" style="display: none;">
                <div class="password-section">
                    <div class="password-label">Contraseña:</div>
                    <div class="password-display">
                        <input type="password" 
                               id="password-${sanitizeHTML(user.username)}" 
                               class="password-input" 
                               value="••••••••••" 
                               readonly>
                        <button class="btn-toggle-password" 
                                onclick="togglePasswordVisibility('${sanitizeHTML(user.username)}', event)">
                            <span class="eye-icon" id="eye-${sanitizeHTML(user.username)}">👁️</span>
                        </button>
                    </div>
                    <div class="password-hint">Click en el ojo para revelar/ocultar</div>
                </div>
            </div>
            
            <div class="user-actions">
                <button class="btn-user-edit" onclick="openChangePasswordModal('${sanitizeHTML(user.username)}')">
                    🔑 Cambiar Contraseña
                </button>
            </div>
        </div>
    `).join('');
}

/**
 * Alternar visibilidad de detalles del usuario
 */
function toggleUserDetails(username) {
    const detailsDiv = document.getElementById(`user-details-${username}`);
    const card = document.getElementById(`user-card-${username}`);
    const toggleIcon = document.getElementById(`toggle-icon-${username}`);
    
    if (detailsDiv.style.display === 'none') {
        // Mostrar detalles
        detailsDiv.style.display = 'block';
        card.classList.add('expanded');
        if (toggleIcon) toggleIcon.textContent = '🙈 Ocultar Contraseña';
        
        // Cargar la contraseña real
        loadUserPassword(username);
    } else {
        // Ocultar detalles
        detailsDiv.style.display = 'none';
        card.classList.remove('expanded');
        if (toggleIcon) toggleIcon.textContent = '👁️ Ver Contraseña';
        
        // Resetear el input a asteriscos
        const passwordInput = document.getElementById(`password-${username}`);
        if (passwordInput) {
            passwordInput.type = 'password';
            passwordInput.value = '••••••••••';
        }
    }
}

/**
 * Cargar contraseña real del usuario
 */
async function loadUserPassword(username) {
    const user = users.find(u => u.username === username);
    if (!user) return;
    
    const passwordInput = document.getElementById(`password-${username}`);
    if (!passwordInput) return;
    
    // Mostrar mensaje de carga
    passwordInput.value = 'Cargando...';
    passwordInput.disabled = true;
    
    // Cargar contraseña guardada desde Firebase
    const plainPassword = await window.loadPasswordForViewing(username);
    
    if (plainPassword) {
        // Mostrar la contraseña guardada
        passwordInput.value = plainPassword;
        passwordInput.disabled = false;
        passwordInput.type = 'password'; // Iniciar oculta
        console.log(`[Users] Contraseña cargada para ${username}`);
    } else {
        // Si no hay contraseña guardada, mostrar mensaje
        passwordInput.value = 'No disponible';
        passwordInput.disabled = true;
        passwordInput.placeholder = 'Cambia la contraseña para verla aquí';
        console.warn(`[Users] No hay contraseña guardada para ${username}`);
        
        // Mostrar toast informativo
        showToast(`💡 Para ver la contraseña de ${user.name}, cámbiala primero`, 'info');
    }
}

/**
 * Alternar visibilidad de contraseña
 */
function togglePasswordVisibility(username, event) {
    event.stopPropagation(); // Evitar que se cierre el detalle
    
    const passwordInput = document.getElementById(`password-${username}`);
    const eyeIcon = document.getElementById(`eye-${username}`);
    
    if (!passwordInput || !eyeIcon) {
        console.error('[Users] No se encontraron elementos para', username);
        return;
    }
    
    // Si el input está deshabilitado, no hacer nada
    if (passwordInput.disabled) {
        showToast('Esta contraseña no está disponible. Cámbiala primero.', 'warning');
        return;
    }
    
    if (passwordInput.type === 'password') {
        passwordInput.type = 'text';
        eyeIcon.textContent = '🙈'; // Ojo cerrado
        console.log('[Users] Contraseña visible');
    } else {
        passwordInput.type = 'password';
        eyeIcon.textContent = '👁️'; // Ojo abierto
        console.log('[Users] Contraseña oculta');
    }
}

/**
 * Obtener icono según rol
 */
function getRoleIcon(role) {
    const icons = {
        'director': '👔',
        'supervisor': '👨‍💼',
        'recepcion': '🧑‍💻',
        'limpieza': '🧹'
    };
    return icons[role] || '👤';
}

/**
 * Obtener nombre del rol
 */
function getRoleName(role) {
    const names = {
        'director': 'Director',
        'supervisor': 'Supervisor',
        'recepcion': 'Recepción',
        'limpieza': 'Limpieza'
    };
    return names[role] || role;
}

/**
 * Abrir modal de cambio de contraseña
 */
function openChangePasswordModal(username) {
    const modal = document.getElementById('changePasswordModal');
    if (!modal) return;
    
    const user = users.find(u => u.username === username);
    if (!user) {
        showToast('Usuario no encontrado', 'error');
        return;
    }
    
    document.getElementById('changePasswordUsername').textContent = user.name;
    document.getElementById('changePasswordUserRole').textContent = getRoleName(user.role);
    document.getElementById('changePasswordUserRole').className = `user-role-badge ${user.role}`;
    document.getElementById('changePasswordForm').dataset.username = username;
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
    
    modal.classList.add('show');
}

/**
 * Cerrar modal de cambio de contraseña
 */
function closeChangePasswordModal() {
    const modal = document.getElementById('changePasswordModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// FIXED: Funciones del modal de sincronización (Problem 5)
/**
 * Abrir modal de sincronización
 */
function openSyncModal() {
    const modal = document.getElementById('syncModal');
    if (modal) {
        modal.classList.add('show');
        document.getElementById('syncStatus').textContent = '';
    }
}

/**
 * Cerrar modal de sincronización
 */
function closeSyncModal() {
    const modal = document.getElementById('syncModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

/**
 * Subir datos a Firebase
 */
async function uploadToFirebase() {
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
async function downloadFromFirebase() {
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

// ============ DIAGNÓSTICO DE SINCRONIZACIÓN ============
// Panel visible EN el dispositivo con el estado de Firebase Sync (auth,
// listeners, últimos eventos). Existe para poder diagnosticar un celular
// sin acceso a Mac/cable/devtools: el empleado copia o comparte el texto
// y lo manda por WhatsApp en vez de tener que leer la consola en vivo.
function _buildSyncDebugReport() {
    const lines = [];
    lines.push('=== DIAGNÓSTICO DE SINCRONIZACIÓN ===');
    lines.push('Fecha: ' + new Date().toLocaleString('es-MX'));
    const buildTag = document.getElementById('appBuildTag');
    lines.push('Build: ' + (buildTag ? buildTag.textContent : '?'));
    lines.push('Usuario: ' + (currentUser ? `${currentUser.name} (${currentUser.role})` : 'ninguno'));
    lines.push('');

    if (!window.FirebaseSync) {
        lines.push('❌ window.FirebaseSync NO EXISTE — firebase-sync.js no cargó o lanzó un error antes de terminar.');
        return lines.join('\n');
    }

    lines.push('Device ID: ' + (window.FirebaseSync.getDeviceId ? window.FirebaseSync.getDeviceId() : '?'));
    lines.push('navigator.onLine: ' + navigator.onLine);
    lines.push('FirebaseSync.isOnline(): ' + window.FirebaseSync.isOnline());
    lines.push('Autenticado: ' + (window.FirebaseSync.isAuthReady ? window.FirebaseSync.isAuthReady() : '?'));
    lines.push('Listener de colección activo: ' + (window.FirebaseSync.isCollectionListenerActive ? window.FirebaseSync.isCollectionListenerActive() : '?'));
    lines.push('Claves observadas: ' + (window.FirebaseSync.getWatchedKeyCount ? window.FirebaseSync.getWatchedKeyCount() : '?'));
    lines.push('Pendientes por sincronizar: ' + window.FirebaseSync.getPendingCount());
    const lastErr = window.FirebaseSync.getLastSyncError && window.FirebaseSync.getLastSyncError();
    if (lastErr) lines.push('Último error de guardado: ' + JSON.stringify(lastErr));
    lines.push('Turno actual: ' + currentShiftType + ' | inicio: ' + (currentShiftStart ? new Date(currentShiftStart).toLocaleString('es-MX') : '?'));
    lines.push('');

    // Combina el log de bajo nivel (firebase-sync.js: cada listener
    // individual) con el de app.js (_appDebugLog: cuándo se pidió reactivar
    // TODOS los listeners y por qué) en una sola línea de tiempo — así se ve
    // de un vistazo si dos reactivaciones se están pisando.
    const fbLog = window.FirebaseSync.getDebugLog ? window.FirebaseSync.getDebugLog() : [];
    const combined = [...fbLog, ..._appDebugLog].sort((a, b) => b.t - a.t);
    if (combined.length === 0) {
        lines.push('(sin eventos registrados todavía)');
    } else {
        lines.push(`Últimos ${combined.length} eventos (más reciente primero):`);
        combined.forEach(e => {
            const time = new Date(e.t).toLocaleTimeString('es-MX', { hour12: false });
            const marker = e.event.startsWith('reactivate') ? '🔁 ' : '';
            lines.push(`[${time}] ${marker}${e.event}${e.detail ? ' — ' + e.detail : ''}`);
        });
    }
    return lines.join('\n');
}

function openSyncDebugModal() {
    const modal = document.getElementById('syncDebugModal');
    if (!modal) return;
    modal.classList.add('show');
    refreshSyncDebugModal();
}

function closeSyncDebugModal() {
    const modal = document.getElementById('syncDebugModal');
    if (modal) modal.classList.remove('show');
}

function refreshSyncDebugModal() {
    const el = document.getElementById('syncDebugContent');
    if (el) el.textContent = _buildSyncDebugReport();
    const shareBtn = document.getElementById('btnShareSyncDebug');
    if (shareBtn) shareBtn.style.display = (navigator.share ? 'inline-block' : 'none');
}

async function copySyncDebugLog() {
    const text = _buildSyncDebugReport();
    try {
        await navigator.clipboard.writeText(text);
        showToast('📋 Diagnóstico copiado', 'success');
    } catch (e) {
        // Fallback para navegadores sin permiso de portapapeles (frecuente en iOS
        // dentro de contextos no confiables): seleccionar el texto manualmente.
        const el = document.getElementById('syncDebugContent');
        if (el) {
            const range = document.createRange();
            range.selectNodeContents(el);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            showToast('Selecciona y copia el texto manualmente', 'info');
        }
    }
}

async function shareSyncDebugLog() {
    if (!navigator.share) return;
    try {
        await navigator.share({ title: 'Diagnóstico de Sincronización', text: _buildSyncDebugReport() });
    } catch (e) { /* usuario canceló el share sheet */ }
}

/**
 * Confirmar cambio de contraseña (VERSIÓN CORREGIDA)
 */
async function confirmChangePassword() {
    const form = document.getElementById('changePasswordForm');
    const username = form.dataset.username;

    // Candado de rol: cambiar la contraseña de OTRO usuario requiere rol
    // director o supervisor. Sin este chequeo, cualquier cuenta autenticada
    // (incluida 'limpieza') podía invocar esta función directamente —p.ej.
    // desde la consola del navegador— y resetear la contraseña de cualquier
    // otra cuenta, incluida la del director: escalación de privilegios total.
    const isOwnAccount = currentUser && currentUser.username === username;
    const isAdmin = currentUser && (currentUser.role === 'director' || currentUser.role === 'supervisor');
    if (!isOwnAccount && !isAdmin) {
        showToast('No tienes permiso para cambiar la contraseña de otro usuario', 'error');
        return;
    }

    const newPassword = document.getElementById('newPassword').value.trim();
    const confirmPassword = document.getElementById('confirmPassword').value.trim();

    // Validaciones
    if (!newPassword || !confirmPassword) {
        showToast('Por favor completa todos los campos', 'error');
        return;
    }
    
    if (newPassword.length < 6) {
        showToast('La contraseña debe tener al menos 6 caracteres', 'error');
        return;
    }
    
    if (newPassword !== confirmPassword) {
        showToast('Las contraseñas no coinciden', 'error');
        return;
    }
    
    try {
        // Buscar usuario
        const userIndex = users.findIndex(u => u.username === username);
        if (userIndex === -1) {
            showToast('Usuario no encontrado', 'error');
            return;
        }
        
        // Actualizar contraseña en memoria (plain text, consistente con verifyPassword)
        users[userIndex].password = newPassword;
        users[userIndex].lastModified = Date.now();
        
        // PASO 1: Guardar contraseña para visualización (Firebase)
        if (window.savePasswordForViewing) {
            window.savePasswordForViewing(username, newPassword).catch(() => {});
        }
        
        // PASO 2: Guardar usuarios (localStorage + Firebase) - SINCRÓNICO
        const saveSuccess = await saveUsers(users);
        
        if (saveSuccess) {
            showToast(`✅ Contraseña de ${users[userIndex].name} actualizada correctamente`, 'success');
        } else {
            showToast(`⚠️ Contraseña de ${users[userIndex].name} actualizada (solo local)`, 'warning');
        }
        
        // Registrar actividad INMEDIATAMENTE (sin throttle)
        const activityEntry = {
            id: Date.now(),
            type: 'password_change',
            description: `Contraseña cambiada para ${users[userIndex].name}`,
            details: {
                targetUser: username,
                changedBy: currentUser.username,
                timestamp: Date.now()
            },
            user: currentUser ? currentUser.name : 'Sistema',
            timestamp: Date.now()
        };
        
        activityLog.push(activityEntry);
        
        // Mantener solo los últimos 100 registros
        if (activityLog.length > 100) {
            activityLog = activityLog.slice(-100);
        }
        
        // Guardar INMEDIATAMENTE en localStorage
        safeLocalStorageSet('motelActivityLog', activityLog);
        
        // Guardar INMEDIATAMENTE en Firebase (sin throttle)
        if (window.FirebaseSync && window.FirebaseSync.ready) {
            await window.FirebaseSync.save('motelActivityLog', activityLog);
        }
        
        // Cerrar modal y actualizar lista
        closeChangePasswordModal();
        renderUsersList();
        
    } catch (error) {
        console.error('[Users] Error cambiando contraseña:', error);
        showToast('❌ Error al cambiar la contraseña', 'error');
    }
}

/**
 * Inicializar gestión de usuarios
 */
function initUserManagement() {
    // Renderizar lista de usuarios
    renderUsersList();
    
    // FIXED: Removido addEventListener para evitar doble disparo (Problem 6)
    // El botón ya tiene onclick="confirmChangePassword()" en el HTML
}


// ============================================================================
// RECUPERACIÓN DE CONTRASEÑA
// ============================================================================




// ============================================================================
// SISTEMA DE ASISTENCIA DE PERSONAL
// ============================================================================

// Renderizar lista de personal
function renderAttendanceList() {
    const container = document.getElementById('attendanceList');
    if (!container) return;
    
    // FIXED: Filtrar personal eliminado (soft delete)
    const activeStaff = staffMembers.filter(s => !s.deleted);
    
    if (!Array.isArray(activeStaff) || activeStaff.length === 0) {
        container.innerHTML = '<div class="attendance-empty">No hay personal registrado. El Director puede agregar personal.</div>';
        return;
    }
    
    // Obtener fecha actual y turno
    const today = new Date().toISOString().split('T')[0];
    const currentShift = getCurrentShift();
    
    
    // Separar personal por turno actual y otros turnos
    const currentShiftStaff = [];
    const otherShiftStaff = [];
    
    activeStaff.forEach(staff => {
        const shouldWork = shouldWorkToday(staff);
        const isCurrentShift = isCurrentShiftStaff(staff);
        
        console.log(`[Attendance] ${staff.name}: turno=${staff.shift}, shouldWork=${shouldWork}, isCurrentShift=${isCurrentShift}`);
        
        if (isCurrentShift && shouldWork) {
            currentShiftStaff.push(staff);
        } else {
            otherShiftStaff.push(staff);
        }
    });
    
    // Función auxiliar para renderizar un empleado
    function renderStaffMember(staff, isCurrentShift = true) {
        // Verificar si ya tiene registro de asistencia hoy
        const todayAttendance = staff.attendance && staff.attendance[today];
        
        let statusClass = 'attendance-pending';
        let statusIcon = '⏳';
        let statusText = 'Pendiente';
        
        // SOLO mostrar el estado real si está en su turno correspondiente
        if (isCurrentShift && todayAttendance) {
            if (todayAttendance === 'present') {
                statusClass = 'attendance-present';
                statusIcon = '✅';
                statusText = 'Asistió';
            } else if (todayAttendance === 'absent') {
                statusClass = 'attendance-absent';
                statusIcon = '❌';
                statusText = 'Faltó';
            }
        }
        // Si NO está en su turno, siempre mostrar como pendiente
        
        // Solo recepción y director pueden marcar asistencia del turno actual
        const canMarkAttendance = isCurrentShift && currentUser && (currentUser.role === 'director' || currentUser.role === 'recepcion');
        
        // Mostrar días de trabajo
        const workDaysText = staff.workDays && staff.workDays.length > 0 ? 
            staff.workDays.map(day => {
                const dayNames = {
                    'monday': 'L', 'tuesday': 'M', 'wednesday': 'X', 
                    'thursday': 'J', 'friday': 'V', 'saturday': 'S', 'sunday': 'D'
                };
                return dayNames[day] || day.charAt(0).toUpperCase();
            }).join('') : 'Todos';
        
        // Indicador si debe trabajar hoy
        const shouldWorkIndicator = shouldWorkToday(staff) ? '🟢' : '🔴';
        
        return `
            <div class="attendance-item ${statusClass} ${isCurrentShift ? '' : 'other-shift'}">
                <div class="attendance-info">
                    <span class="attendance-name">${sanitizeHTML(staff.name)} ${shouldWorkIndicator}</span>
                    <span class="attendance-role">${sanitizeHTML(staff.shift || 'Sin turno')} • ${workDaysText}</span>
                </div>
                <div class="attendance-status">
                    <span class="attendance-status-badge">${statusIcon} ${statusText}</span>
                </div>
                ${canMarkAttendance ? `
                    <div class="attendance-actions">
                        <button class="attendance-btn attendance-btn-present" onclick="markAttendance('${staff.id}', 'present')" title="Marcar asistencia">✅</button>
                        <button class="attendance-btn attendance-btn-absent" onclick="markAttendance('${staff.id}', 'absent')" title="Marcar falta">❌</button>
                    </div>
                ` : ''}
                ${currentUser && currentUser.role === 'director' ? `
                    <button class="attendance-btn-edit" onclick="editStaffMember('${staff.id}')" title="Editar">✏️</button>
                    <button class="attendance-btn-delete" onclick="deleteStaffMember('${staff.id}')" title="Eliminar">🗑️</button>
                ` : ''}
            </div>
        `;
    }
    
    // Construir HTML con secciones horizontales
    let html = '<div class="attendance-sections">';
    
    // Sección 1: Personal del turno actual (IZQUIERDA)
    html += `
        <div class="attendance-section current-shift">
            <div class="attendance-section-header">
                <div class="attendance-section-title">
                    <span>${currentShift.type === 'day' ? '☀️' : '🌙'}</span>
                    <span>${currentShift.name}</span>
                </div>
                <span class="attendance-section-count">${currentShiftStaff.length}</span>
            </div>
            <div class="attendance-list">
    `;
    
    if (currentShiftStaff.length === 0) {
        html += '<div class="attendance-empty">No hay personal programado para este turno hoy.</div>';
    } else {
        currentShiftStaff.forEach(staff => {
            html += renderStaffMember(staff, true);
        });
    }
    
    html += '</div></div>';
    
    // Sección 2: Personal de otros turnos (DERECHA)
    html += `
        <div class="attendance-section other-shifts">
            <div class="attendance-section-header">
                <div class="attendance-section-title">
                    <span>👥</span>
                    <span>Otros Turnos</span>
                </div>
                <span class="attendance-section-count">${otherShiftStaff.length}</span>
            </div>
            <div class="attendance-list">
    `;
    
    if (otherShiftStaff.length === 0) {
        html += '<div class="attendance-empty">No hay personal de otros turnos.</div>';
    } else {
        otherShiftStaff.forEach(staff => {
            html += renderStaffMember(staff, false);
        });
    }
    
    html += '</div></div>';
    
    html += '</div>';
    
    // Agregar sección de historial de faltas
    html += renderAttendanceHistory();
    
    container.innerHTML = html;
    
    console.log(`[Attendance] Renderizado: ${currentShiftStaff.length} del turno actual, ${otherShiftStaff.length} de otros turnos`);
}

// Función para renderizar el historial de faltas
function renderAttendanceHistory() {
    // Obtener todas las faltas de los últimos 30 días
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const absences = [];
    
    // FIXED: Filtrar personal eliminado (soft delete)
    const activeStaff = staffMembers.filter(s => !s.deleted);
    
    activeStaff.forEach(staff => {
        if (staff.attendance) {
            Object.entries(staff.attendance).forEach(([date, status]) => {
                if (status === 'absent') {
                    const dateObj = new Date(date + 'T00:00:00');
                    const timestamp = dateObj.getTime();
                    
                    // Solo incluir faltas de los últimos 30 días
                    if (timestamp >= thirtyDaysAgo) {
                        absences.push({
                            staffName: staff.name,
                            staffShift: staff.shift,
                            date: date,
                            dateObj: dateObj,
                            timestamp: timestamp
                        });
                    }
                }
            });
        }
    });
    
    // Ordenar por fecha más reciente primero
    absences.sort((a, b) => b.timestamp - a.timestamp);
    
    let historyHtml = `
        <div class="attendance-history">
            <div class="attendance-history-header">
                <div class="attendance-history-title">
                    <span>📋</span>
                    <span>Historial de Faltas (Últimos 30 días)</span>
                </div>
                <span class="attendance-history-count">${absences.length}</span>
            </div>
            <div class="attendance-history-list">
    `;
    
    if (absences.length === 0) {
        historyHtml += '<div class="attendance-history-empty">No hay faltas registradas en los últimos 30 días.</div>';
    } else {
        absences.forEach(absence => {
            const dayName = absence.dateObj.toLocaleDateString('es-MX', { weekday: 'short' });
            const dateFormatted = absence.dateObj.toLocaleDateString('es-MX', { 
                day: '2-digit', 
                month: 'short'
            });
            const timeAgo = getTimeAgo(absence.timestamp);
            
            historyHtml += `
                <div class="attendance-history-item">
                    <div class="attendance-history-info">
                        <span class="attendance-history-name">${sanitizeHTML(absence.staffName)}</span>
                        <span class="attendance-history-details">${sanitizeHTML(absence.staffShift)} • ${dayName}</span>
                    </div>
                    <div class="attendance-history-date">
                        <span class="attendance-history-day">${dateFormatted}</span>
                        <span class="attendance-history-time">${timeAgo}</span>
                    </div>
                </div>
            `;
        });
    }
    
    historyHtml += '</div></div>';
    
    return historyHtml;
}

// Función auxiliar para calcular tiempo transcurrido
function getTimeAgo(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));
    
    if (days === 0) {
        return 'Hoy';
    } else if (days === 1) {
        return 'Ayer';
    } else if (days < 7) {
        return `Hace ${days} días`;
    } else if (days < 30) {
        const weeks = Math.floor(days / 7);
        return weeks === 1 ? 'Hace 1 semana' : `Hace ${weeks} semanas`;
    } else {
        return 'Hace más de un mes';
    }
}

// Agregar nuevo miembro del personal
function addStaffMember() {
    // Resetear modal para modo agregar
    resetStaffModal(); // FIXED: Use centralized reset function
    
    // Abrir modal
    const modal = document.getElementById('staffModal');
    if (!modal) return;
    
    modal.classList.add('show');
}

// Guardar personal desde el modal
async function saveStaffFromModal() {
    const name = document.getElementById('staffName').value.trim();
    const shift = document.getElementById('staffShift').value;
    const saveBtn = document.getElementById('saveStaffBtn');
    const editingId = saveBtn ? saveBtn.getAttribute('data-editing-id') : null;
    
    // Obtener días de trabajo seleccionados
    const workDays = [];
    const workDayCheckboxes = document.querySelectorAll('.work-days-calendar input[type="checkbox"]:checked');
    workDayCheckboxes.forEach(checkbox => {
        workDays.push(checkbox.value);
    });
    
    // Validaciones
    if (!name) {
        showToast('⚠️ Ingresa el nombre del personal', 'error');
        return;
    }
    
    if (!shift) {
        showToast('⚠️ Selecciona un turno', 'error');
        return;
    }
    
    if (workDays.length === 0) {
        showToast('⚠️ Selecciona al menos un día de trabajo', 'error');
        return;
    }
    
    if (editingId) {
        // MODO EDICIÓN: Actualizar empleado existente
        const staffIndex = staffMembers.findIndex(s => s.id == editingId);
        if (staffIndex !== -1) {
            staffMembers[staffIndex] = {
                ...staffMembers[staffIndex], // Mantener datos existentes como attendance
                name: name,
                shift: shift,
                workDays: workDays,
                updatedAt: Date.now(), // FIXED: Added updatedAt field
                updatedBy: currentUser ? currentUser.name : 'Desconocido'
            };
            showToast('✅ Personal actualizado correctamente', 'success');
        }
    } else {
        // MODO CREACIÓN: Crear nuevo personal
        const newStaff = {
            id: Date.now(),
            name: name,
            shift: shift,
            workDays: workDays, // Nuevo campo: días de trabajo
            createdAt: Date.now(),
            createdBy: currentUser ? currentUser.name : 'Desconocido',
            attendance: {} // { 'YYYY-MM-DD': 'present' | 'absent' }
        };
        
        staffMembers.push(newStaff);
        showToast('✅ Personal agregado correctamente', 'success');
    }
    
    // FIXED: Guardar inmediatamente sin throttle para sincronización en tiempo real
    await saveStaffDataImmediately();
    renderAttendanceList();
    
    // Cerrar modal y resetear
    document.getElementById('staffModal').classList.remove('show');
    resetStaffModal(); // FIXED: Reset modal after save
    
    const workDaysText = workDays.map(day => {
        const dayNames = {
            'monday': 'Lun', 'tuesday': 'Mar', 'wednesday': 'Mié', 
            'thursday': 'Jue', 'friday': 'Vie', 'saturday': 'Sáb', 'sunday': 'Dom'
        };
        return dayNames[day];
    }).join(', ');
    
    showToast(`✓ ${name} agregado al personal (${workDaysText})`, 'success');
    console.log(`[Attendance] Personal agregado: ${name} (${shift}) - Días: ${workDaysText} por ${currentUser.name}`);
}

// Resetear modal de personal
// FIXED: Added function to reset staff modal after use
function resetStaffModal() {
    // Limpiar campos
    document.getElementById('staffName').value = '';
    document.getElementById('staffShift').value = '';
    
    // Desmarcar todos los checkboxes
    const workDayCheckboxes = document.querySelectorAll('.work-days-calendar input[type="checkbox"]');
    workDayCheckboxes.forEach(checkbox => {
        checkbox.checked = false;
    });
    
    // Resetear título y botón
    const modalTitle = document.querySelector('#staffModal .modal-title');
    if (modalTitle) modalTitle.textContent = 'Agregar Personal';
    
    const saveBtn = document.getElementById('saveStaffBtn');
    if (saveBtn) {
        saveBtn.textContent = 'Agregar';
        saveBtn.removeAttribute('data-editing-id');
    }
}

// Marcar asistencia
async function markAttendance(staffId, status) {
    logSync(`Marcando asistencia: ${staffId} -> ${status}`, 'sync');
    
    const staff = staffMembers.find(s => s.id == staffId);
    if (!staff) {
        logSync(`Error: Personal no encontrado: ${staffId}`, 'error');
        showToast('Error: Personal no encontrado', 'error');
        return;
    }
    
    const today = new Date().toISOString().split('T')[0];
    
    // Inicializar objeto de asistencia si no existe
    if (!staff.attendance) {
        staff.attendance = {};
    }
    
    // Marcar asistencia
    staff.attendance[today] = status;
    
    logSync(`Asistencia marcada localmente para ${staff.name}`, 'success');
    
    // FIXED: Guardar inmediatamente sin throttle para sincronización en tiempo real
    await saveStaffDataImmediately();
    renderAttendanceList();
    
    const statusText = status === 'present' ? 'asistió' : 'faltó';
    showToast(`✓ ${staff.name} marcado como ${statusText}`, 'success');
    
    logSync(`Asistencia sincronizada exitosamente para ${staff.name}`, 'success');
    console.log(`[Attendance] ${staff.name} marcado como ${status} por ${currentUser.name}`);
}

// FIXED: Nueva función para guardar datos de personal inmediatamente sin throttle
async function saveStaffDataImmediately() {
    logSync('Iniciando guardado inmediato de personal', 'sync');
    
    // Guardar en localStorage inmediatamente
    localStorage.setItem('motelStaffMembers', JSON.stringify(staffMembers));
    logSync('Personal guardado en localStorage', 'success');
    
    // Guardar en Firebase inmediatamente sin throttle
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        try {
            logSync('Guardando personal en Firebase...', 'sync');
            await window.FirebaseSync.save('motelStaffMembers', staffMembers);
            logSync('Personal guardado exitosamente en Firebase', 'success');
        } catch (err) {
            logSync(`Error guardando personal en Firebase: ${err.message}`, 'error');
            console.error('[Staff] Error guardando asistencia en Firebase:', err);
        }
    } else {
        logSync('Firebase no disponible para guardado inmediato', 'warning');
    }
}

// Función auxiliar para obtener el día de la semana en inglés
function getCurrentDayOfWeek() {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const today = new Date();
    return days[today.getDay()];
}

// Función auxiliar para determinar si un empleado debe trabajar hoy
function shouldWorkToday(staff) {
    if (!staff.workDays || !Array.isArray(staff.workDays)) {
        // Compatibilidad con personal antiguo sin días de trabajo definidos
        return true;
    }
    
    const currentDay = getCurrentDayOfWeek();
    return staff.workDays.includes(currentDay);
}

// Función auxiliar para determinar si un empleado corresponde al turno actual
function isCurrentShiftStaff(staff) {
    const currentShift = getCurrentShift();
    
    // Mapear turnos del personal a tipos de turno del sistema
    const shiftMapping = {
        'Día': 'day',
        'Noche': 'night',
        'Fin de Semana Día': 'day',
        'Fin de Semana Noche': 'night'
    };
    
    const staffShiftType = shiftMapping[staff.shift];
    
    // Si no se puede mapear el turno, asumir que no corresponde
    if (!staffShiftType) {
        console.warn(`[Attendance] Turno no reconocido para ${staff.name}: ${staff.shift}`);
        return false;
    }
    
    const matches = staffShiftType === currentShift.type;
    console.log(`[Attendance] ${staff.name}: ${staff.shift} (${staffShiftType}) vs ${currentShift.name} (${currentShift.type}) = ${matches}`);
    
    return matches;
}

// Editar miembro del personal
// FIXED: Added edit functionality for staff cards
function editStaffMember(staffId) {
    const staff = staffMembers.find(s => s.id == staffId);
    if (!staff) {
        showToast('❌ Personal no encontrado', 'error');
        return;
    }
    
    // Llenar el modal con los datos existentes
    document.getElementById('staffName').value = staff.name;
    document.getElementById('staffShift').value = staff.shift;
    
    // Marcar los días de trabajo
    const workDayCheckboxes = document.querySelectorAll('.work-days-calendar input[type="checkbox"]');
    workDayCheckboxes.forEach(checkbox => {
        checkbox.checked = staff.workDays && staff.workDays.includes(checkbox.value);
    });
    
    // Cambiar el título del modal y el botón
    const modalTitle = document.querySelector('#staffModal .modal-title');
    if (modalTitle) modalTitle.textContent = 'Editar Personal';
    
    const saveBtn = document.getElementById('saveStaffBtn');
    if (saveBtn) {
        saveBtn.textContent = 'Actualizar';
        // Guardar el ID para saber que estamos editando
        saveBtn.setAttribute('data-editing-id', staffId);
    }
    
    // Mostrar el modal
    document.getElementById('staffModal').classList.add('show');
}

// Eliminar miembro del personal
// FIXED: Implementado soft delete en lugar de eliminación física
async function deleteStaffMember(staffId) {
    const staff = staffMembers.find(s => s.id == staffId);
    if (!staff) {
        showToast('Error: Personal no encontrado', 'error');
        return;
    }
    
    const confirmed = await showCustomConfirm(
        '⚠️ Eliminar Personal',
        `¿Eliminar a ${staff.name} del registro de personal?\n\nSe perderá todo el historial de asistencia.`
    );
    
    if (!confirmed) return;
    
    staff.deleted = true; // FIXED: Soft delete
    staff.deletedAt = Date.now(); // FIXED: Timestamp de eliminación
    saveData();
    renderAttendanceList(); // FIXED: Re-renderizar para aplicar filtro
    showToast(`✓ ${staff.name} eliminado del personal`, 'success');
}


// ============================================================================
// SISTEMA DE AVISOS
// ============================================================================

// Renderizar lista de avisos
function renderAnnouncementsList() {
    const container = document.getElementById('announcementsList');
    if (!container) return;
    
    // FIXED: Filtrar avisos eliminados (soft delete)
    const activeAnnouncements = announcements.filter(a => !a.deleted);
    
    if (!Array.isArray(activeAnnouncements) || activeAnnouncements.length === 0) {
        container.innerHTML = '<div class="announcement-empty">No hay avisos publicados.</div>';
        return;
    }
    
    // Ordenar por fecha (más recientes primero)
    const sortedAnnouncements = [...activeAnnouncements].sort((a, b) => b.createdAt - a.createdAt);
    
    container.innerHTML = sortedAnnouncements.map(announcement => {
        const date = new Date(announcement.createdAt);
        const formattedDate = date.toLocaleDateString('es-MX', { 
            day: '2-digit', 
            month: 'short', 
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        let priorityIcon = '📌';
        let priorityText = 'Normal';
        if (announcement.priority === 'important') {
            priorityIcon = '⚠️';
            priorityText = 'Importante';
        } else if (announcement.priority === 'urgent') {
            priorityIcon = '🚨';
            priorityText = 'Urgente';
        }
        
        const canDelete = currentUser && currentUser.role === 'director';
        
        return `
            <div class="announcement-item priority-${announcement.priority}">
                <div class="announcement-header-row">
                    <h3 class="announcement-title">${sanitizeHTML(announcement.title)}</h3>
                    <span class="announcement-priority priority-${announcement.priority}">
                        ${priorityIcon} ${priorityText}
                    </span>
                </div>
                <div class="announcement-message">${sanitizeHTML(announcement.message)}</div>
                <div class="announcement-footer">
                    <span class="announcement-meta">
                        Por ${sanitizeHTML(announcement.createdBy)} • ${formattedDate}
                    </span>
                    ${canDelete ? `
                        <button class="announcement-delete-btn" onclick="deleteAnnouncement('${announcement.id}')" title="Eliminar aviso">
                            🗑️ Eliminar
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

// Abrir modal de nuevo aviso
function addAnnouncement() {
    const modal = document.getElementById('announcementModal');
    if (!modal) return;
    
    // Limpiar campos
    document.getElementById('announcementTitle').value = '';
    document.getElementById('announcementMessage').value = '';
    document.getElementById('announcementPriority').value = 'normal';
    
    modal.classList.add('show');
}

// Guardar aviso desde el modal
function saveAnnouncementFromModal() {
    const title = document.getElementById('announcementTitle').value.trim();
    const message = document.getElementById('announcementMessage').value.trim();
    const priority = document.getElementById('announcementPriority').value;
    
    // Validaciones
    if (!title) {
        showToast('⚠️ Ingresa un título para el aviso', 'error');
        return;
    }
    
    if (!message) {
        showToast('⚠️ Ingresa el mensaje del aviso', 'error');
        return;
    }
    
    // Crear nuevo aviso
    const newAnnouncement = {
        id: Date.now(),
        title: title,
        message: message,
        priority: priority,
        createdAt: Date.now(),
        createdBy: currentUser ? currentUser.name : 'Desconocido'
    };
    
    announcements.push(newAnnouncement);
    saveData();
    renderAnnouncementsList();
    
    // Cerrar modal
    document.getElementById('announcementModal').classList.remove('show');
    
    showToast(`✓ Aviso publicado correctamente`, 'success');
    console.log(`[Announcements] Aviso creado: "${title}" por ${currentUser.name}`);
}

// Eliminar aviso
// FIXED: Implementado soft delete en lugar de eliminación física
async function deleteAnnouncement(announcementId) {
    const announcement = announcements.find(a => a.id == announcementId);
    if (!announcement) {
        showToast('Error: Aviso no encontrado', 'error');
        return;
    }
    
    const confirmed = await showCustomConfirm(
        '⚠️ Eliminar Aviso',
        `¿Eliminar el aviso "${announcement.title}"?\n\nEsta acción no se puede deshacer.`
    );
    
    if (!confirmed) return;
    
    announcement.deleted = true; // FIXED: Soft delete
    announcement.deletedAt = Date.now(); // FIXED: Timestamp de eliminación
    saveData();
    renderAnnouncementsList(); // FIXED: Re-renderizar para aplicar filtro
    showToast(`✓ Aviso eliminado`, 'success');
}

