import { showCustomConfirm } from '../utils/formatters.js';
import { showToast } from '../utils/toast-system.js';

// ============================================================================
// CONNECTION — indicador visual de estado de conexión (online/offline/
// sincronizando) y su acción al hacer click (forzar reconexión/ver pendientes).
// Extraído de app.js tal cual (sin convertir a módulo ES todavía).
// ============================================================================

export function updateConnectionStatus(isOnline, syncedCount) {
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

export async function handleConnectionClick() {
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

window.handleConnectionClick = handleConnectionClick;