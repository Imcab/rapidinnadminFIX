// Sistema de notificaciones Toast
let toastContainer = null;

function initToastSystem() {
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toastContainer';
        toastContainer.className = 'toast-container';
        document.body.appendChild(toastContainer);
    }
}

function showToast(message, type = 'info', duration = 3000) {
    initToastSystem();
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    // FIXED: Emojis reemplazados por ASCII seguros para Safari
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
    
    // Animación de entrada
    setTimeout(() => toast.classList.add('show'), 10);
    
    // Remover después del tiempo especificado
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}
