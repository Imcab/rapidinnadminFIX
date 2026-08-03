import { sanitizeHTML } from '../utils/formatters.js';

// ============================================================================
// ACTIVITY LOG — render del historial de actividad (pestaña de bitácora).
// Sale de partir log.js.
// ============================================================================

// Renderizar historial de actividad
export function renderActivityLog(filter = 'all') {
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