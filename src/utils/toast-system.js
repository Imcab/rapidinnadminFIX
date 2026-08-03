//src/utils/toast-system

let toastContainer = null;

function initToastSystem() {
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toastContainer';
        toastContainer.className = 'toast-container';
        document.body.appendChild(toastContainer);
    }
}

/**
 * Muestra una notificación toast.
 * @param {string} message - Texto a mostrar.
 * @param {'success'|'error'|'warning'|'info'} type - Tipo de notificación.
 * @param {number} duration - Duración en milisegundos.
 */
export function showToast(message, type = 'info', duration = 3000) {
    initToastSystem();
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    const icon = {
        'success': '[OK]',
        'error': '[X]',
        'warning': '[!]',
        'info': '[i]'
    }[type] || '[i]';
    
    toast.innerHTML = `
        <span class="toast-icon">${icon}</span>
        <span class="toast-message">${message}</span>
    `;
    
    toastContainer.appendChild(toast);
    
    setTimeout(() => toast.classList.add('show'), 10);
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}