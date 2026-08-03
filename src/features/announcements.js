import { sanitizeHTML, showCustomConfirm } from '../utils/formatters.js';
import { saveData } from '../utils/storage-utils.js';
import { showToast } from '../utils/toast-system.js';
import { announcements, currentUser } from '../app.js';

// ============================================================================
// SISTEMA DE AVISOS
// ============================================================================

// Renderizar lista de avisos
export function renderAnnouncementsList() {
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
export function addAnnouncement() {
    const modal = document.getElementById('announcementModal');
    if (!modal) return;
    
    // Limpiar campos
    document.getElementById('announcementTitle').value = '';
    document.getElementById('announcementMessage').value = '';
    document.getElementById('announcementPriority').value = 'normal';
    
    modal.classList.add('show');
}

// Guardar aviso desde el modal
export function saveAnnouncementFromModal() {
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
    console.log(`[Announcements] Aviso creado: "${title}" por ${currentUser ? currentUser.name : 'Desconocido'}`);
}

// Eliminar aviso
// FIXED: Implementado soft delete en lugar de eliminación física
export async function deleteAnnouncement(announcementId) {
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
window.deleteAnnouncement = deleteAnnouncement;