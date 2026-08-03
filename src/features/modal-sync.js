// ============================================================================
// SYNC MODAL — abrir/cerrar el modal de sincronización manual
// (subir/descargar datos hacia/desde Firebase).
// Extraído de app.js tal cual (sin convertir a módulo ES todavía).
// ============================================================================

export function openSyncModal() {
    const modal = document.getElementById('syncModal');
    if (modal) {
        modal.classList.add('show');
        document.getElementById('syncStatus').textContent = '';
    }
}

export function closeSyncModal() {
    const modal = document.getElementById('syncModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

window.closeSyncModal = closeSyncModal;