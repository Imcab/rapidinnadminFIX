import { users, currentUser, activityLog, setActivityLog } from '../app.js';

import { getRoleName } from '../utils/formatters.js';
import { safeLocalStorageSet } from '../utils/storage-utils.js';
import { showToast } from '../utils/toast-system.js';
import { renderUsersList, saveUsers } from './users.js';

// Verificar contraseña
export async function verifyPassword(inputPassword, storedPassword) {
    return inputPassword === storedPassword;
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


/**
 * Confirmar cambio de contraseña (VERSIÓN CORREGIDA)
 */
export async function confirmChangePassword() {
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
            setActivityLog(activityLog.slice(-100));
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
 * Alternar visibilidad de contraseña
 */
export function togglePasswordVisibility(username, event) {
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
 * Abrir modal de cambio de contraseña
 */
export function openChangePasswordModal(username) {
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
export function closeChangePasswordModal() {
    const modal = document.getElementById('changePasswordModal');
    if (modal) {
        modal.classList.remove('show');
    }
}


/**
 * Cargar contraseña real del usuario
 */
export async function loadUserPassword(username) {
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


window.togglePasswordVisibility = togglePasswordVisibility;
window.openChangePasswordModal = openChangePasswordModal;
window.confirmChangePassword = confirmChangePassword;

window.closeChangePasswordModal = closeChangePasswordModal;