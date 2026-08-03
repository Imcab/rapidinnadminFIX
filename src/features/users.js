import { users, setUsers } from '../app.js';

import { getRoleIcon, getRoleName, sanitizeHTML } from '../utils/formatters.js';
import { safeLocalStorageSet } from '../utils/storage-utils.js';
import { showToast } from '../utils/toast-system.js';
import { loadUserPassword } from './password.js';

// Lee usuarios del caché local de forma SÍNCRONA (cero llamadas a red)
export function _getCachedUsersSync() {
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
export async function _refreshUsersFromFirebase() {
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
    setUsers(fresh);
    try { localStorage.setItem('motelUsers', JSON.stringify(fresh)); } catch(e) {}
    window.FirebaseSync.save('motelUsers', fresh).catch(() => {});
}

// Cargar usuarios: INSTANTÁNEO desde caché, Firebase en segundo plano
export async function loadUsers() {
    const cached = _getCachedUsersSync();
    // Refrescar desde Firebase sin bloquear
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        _refreshUsersFromFirebase().catch(() => {});
    }
    return cached;
}

// Guardar usuarios y propagar contraseñas a las claves _pwd_
export async function saveUsers(users) {
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

/**
 * Renderizar lista de usuarios
 */
export async function renderUsersList() {
    const container = document.getElementById('usersList');
    if (!container) return;
    
    // Recargar usuarios desde Firebase primero
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        try {
            const firebaseUsers = await window.FirebaseSync.load('motelUsers');
            if (firebaseUsers && Array.isArray(firebaseUsers)) {
                setUsers(firebaseUsers);
                safeLocalStorageSet('motelUsers', users);
            }
        } catch (err) {
            console.error('[Users] Error cargando usuarios desde Firebase:', err);
        }
    }
    
    // Si no hay usuarios en Firebase, cargar desde localStorage
    if (!users || users.length === 0) {
        setUsers(await loadUsers());
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
export function toggleUserDetails(username) {
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


window.toggleUserDetails = toggleUserDetails;