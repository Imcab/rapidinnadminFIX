import { activeIntervals, currentUser, setActiveIntervals, setCurrentUser, inventory} from '../app.js';

import { loadDeepCleanSchedules, showCleaningView } from './cleaning.js';
import { showCustomConfirm } from '../utils/formatters.js';
import { init } from '../init.js';
import { safeLocalStorageGet } from '../utils/storage-utils.js';

// ============================================================================
// SESSION / AUTH — login, sesión activa, permisos por rol y logout.
// Extraído de app.js tal cual (sin convertir a módulo ES todavía).
// ============================================================================

export function checkSession() {
    const savedUser = safeLocalStorageGet('currentUser');
    if (savedUser) {
        setCurrentUser(savedUser);
        showMainApp();
    } else {
        showLogin();
    }
}

export function showLogin() {
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('mainApp').style.display = 'none';
    document.body.classList.add('loaded'); // Mostrar página
}

export async function showMainApp() {
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

export function setupPermissions() {
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

export async function logout() {
    const confirmed = await showCustomConfirm('Cerrar Sesión', '¿Estás seguro de que quieres cerrar sesión?');
    if (!confirmed) return;

    // Limpiar todos los intervalos activos para prevenir fugas de memoria
    activeIntervals.forEach(intervalId => clearInterval(intervalId));
    setActiveIntervals([]);

    // Limpiar sesión de TODOS los almacenamientos (localStorage, sessionStorage y memoria)
    try { localStorage.removeItem('currentUser'); } catch(e) {}
    try { sessionStorage.removeItem('currentUser'); } catch(e) {}
    if (window._memStorage) delete window._memStorage['currentUser'];

    setCurrentUser(null);
    location.reload();
}

window.logout = logout;