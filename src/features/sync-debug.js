import { getAppDebugLog } from '../utils/logger.js';
import { showToast } from '../utils/toast-system.js';
import { currentUser, currentShiftType, currentShiftStart } from '../app.js';

// ============================================================================
// SYNC DEBUG — panel visible en pantalla con el estado de Firebase Sync
// (auth, listeners, últimos eventos), para diagnosticar un celular sin
// acceso a devtools. Sale de partir debug.js
// ============================================================================

export function _buildSyncDebugReport() {
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
    const combined = [...fbLog, ...getAppDebugLog()].sort((a, b) => b.t - a.t);
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

export function openSyncDebugModal() {
    const modal = document.getElementById('syncDebugModal');
    if (!modal) return;
    modal.classList.add('show');
    refreshSyncDebugModal();
}

export function closeSyncDebugModal() {
    const modal = document.getElementById('syncDebugModal');
    if (modal) modal.classList.remove('show');
}

export function refreshSyncDebugModal() {
    const el = document.getElementById('syncDebugContent');
    if (el) el.textContent = _buildSyncDebugReport();
    const shareBtn = document.getElementById('btnShareSyncDebug');
    if (shareBtn) shareBtn.style.display = (navigator.share ? 'inline-block' : 'none');
}

export async function copySyncDebugLog() {
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

export async function shareSyncDebugLog() {
    if (!navigator.share) return;
    try {
        await navigator.share({ title: 'Diagnóstico de Sincronización', text: _buildSyncDebugReport() });
    } catch (e) { /* usuario canceló el share sheet */ }
}

window.closeSyncDebugModal = closeSyncDebugModal;
window.copySyncDebugLog = copySyncDebugLog;
window.refreshSyncDebugModal = refreshSyncDebugModal;
window.shareSyncDebugLog = shareSyncDebugLog;