import { sanitizeHTML, showCustomConfirm } from '../utils/formatters.js';
import { logSync } from '../utils/logger.js';
import { getCurrentShift } from './shifts.js';
import { saveData } from '../utils/storage-utils.js';
import { getTimeAgo } from '../utils/time.js';
import { showToast } from '../utils/toast-system.js';
import { renderUsersList } from './users.js';
import { staffMembers, currentUser } from '../app.js';

// ============================================================================
// ATTENDANCE — gestión de personal y asistencia (alta/edición/baja de
// empleados, marcar asistencia, historial, y helpers de día/turno).
// Extraído de app.js tal cual (sin convertir a módulo ES todavía).
// ============================================================================

export function initUserManagement() {
    // Renderizar lista de usuarios
    renderUsersList();
    
    // FIXED: Removido addEventListener para evitar doble disparo (Problem 6)
    // El botón ya tiene onclick="confirmChangePassword()" en el HTML
}

export function renderAttendanceList() {
    const container = document.getElementById('attendanceList');
    if (!container) return;
    
    // FIXED: Filtrar personal eliminado (soft delete)
    const activeStaff = staffMembers.filter(s => !s.deleted);
    
    if (!Array.isArray(activeStaff) || activeStaff.length === 0) {
        container.innerHTML = '<div class="attendance-empty">No hay personal registrado. El Director puede agregar personal.</div>';
        return;
    }
    
    // Obtener fecha actual y turno
    const today = new Date().toISOString().split('T')[0];
    const currentShift = getCurrentShift();
    
    
    // Separar personal por turno actual y otros turnos
    const currentShiftStaff = [];
    const otherShiftStaff = [];
    
    activeStaff.forEach(staff => {
        const shouldWork = shouldWorkToday(staff);
        const isCurrentShift = isCurrentShiftStaff(staff);
        
        console.log(`[Attendance] ${staff.name}: turno=${staff.shift}, shouldWork=${shouldWork}, isCurrentShift=${isCurrentShift}`);
        
        if (isCurrentShift && shouldWork) {
            currentShiftStaff.push(staff);
        } else {
            otherShiftStaff.push(staff);
        }
    });
    
    // Función auxiliar para renderizar un empleado
    function renderStaffMember(staff, isCurrentShift = true) {
        // Verificar si ya tiene registro de asistencia hoy
        const todayAttendance = staff.attendance && staff.attendance[today];
        
        let statusClass = 'attendance-pending';
        let statusIcon = '⏳';
        let statusText = 'Pendiente';
        
        // SOLO mostrar el estado real si está en su turno correspondiente
        if (isCurrentShift && todayAttendance) {
            if (todayAttendance === 'present') {
                statusClass = 'attendance-present';
                statusIcon = '✅';
                statusText = 'Asistió';
            } else if (todayAttendance === 'absent') {
                statusClass = 'attendance-absent';
                statusIcon = '❌';
                statusText = 'Faltó';
            }
        }
        // Si NO está en su turno, siempre mostrar como pendiente
        
        // Solo recepción y director pueden marcar asistencia del turno actual
        const canMarkAttendance = isCurrentShift && currentUser && (currentUser.role === 'director' || currentUser.role === 'recepcion');
        
        // Mostrar días de trabajo
        const workDaysText = staff.workDays && staff.workDays.length > 0 ? 
            staff.workDays.map(day => {
                const dayNames = {
                    'monday': 'L', 'tuesday': 'M', 'wednesday': 'X', 
                    'thursday': 'J', 'friday': 'V', 'saturday': 'S', 'sunday': 'D'
                };
                return dayNames[day] || day.charAt(0).toUpperCase();
            }).join('') : 'Todos';
        
        // Indicador si debe trabajar hoy
        const shouldWorkIndicator = shouldWorkToday(staff) ? '🟢' : '🔴';
        
        return `
            <div class="attendance-item ${statusClass} ${isCurrentShift ? '' : 'other-shift'}">
                <div class="attendance-info">
                    <span class="attendance-name">${sanitizeHTML(staff.name)} ${shouldWorkIndicator}</span>
                    <span class="attendance-role">${sanitizeHTML(staff.shift || 'Sin turno')} • ${workDaysText}</span>
                </div>
                <div class="attendance-status">
                    <span class="attendance-status-badge">${statusIcon} ${statusText}</span>
                </div>
                ${canMarkAttendance ? `
                    <div class="attendance-actions">
                        <button class="attendance-btn attendance-btn-present" onclick="markAttendance('${staff.id}', 'present')" title="Marcar asistencia">✅</button>
                        <button class="attendance-btn attendance-btn-absent" onclick="markAttendance('${staff.id}', 'absent')" title="Marcar falta">❌</button>
                    </div>
                ` : ''}
                ${currentUser && currentUser.role === 'director' ? `
                    <button class="attendance-btn-edit" onclick="editStaffMember('${staff.id}')" title="Editar">✏️</button>
                    <button class="attendance-btn-delete" onclick="deleteStaffMember('${staff.id}')" title="Eliminar">🗑️</button>
                ` : ''}
            </div>
        `;
    }
    
    // Construir HTML con secciones horizontales
    let html = '<div class="attendance-sections">';
    
    // Sección 1: Personal del turno actual (IZQUIERDA)
    html += `
        <div class="attendance-section current-shift">
            <div class="attendance-section-header">
                <div class="attendance-section-title">
                    <span>${currentShift.type === 'day' ? '☀️' : '🌙'}</span>
                    <span>${currentShift.name}</span>
                </div>
                <span class="attendance-section-count">${currentShiftStaff.length}</span>
            </div>
            <div class="attendance-list">
    `;
    
    if (currentShiftStaff.length === 0) {
        html += '<div class="attendance-empty">No hay personal programado para este turno hoy.</div>';
    } else {
        currentShiftStaff.forEach(staff => {
            html += renderStaffMember(staff, true);
        });
    }
    
    html += '</div></div>';
    
    // Sección 2: Personal de otros turnos (DERECHA)
    html += `
        <div class="attendance-section other-shifts">
            <div class="attendance-section-header">
                <div class="attendance-section-title">
                    <span>👥</span>
                    <span>Otros Turnos</span>
                </div>
                <span class="attendance-section-count">${otherShiftStaff.length}</span>
            </div>
            <div class="attendance-list">
    `;
    
    if (otherShiftStaff.length === 0) {
        html += '<div class="attendance-empty">No hay personal de otros turnos.</div>';
    } else {
        otherShiftStaff.forEach(staff => {
            html += renderStaffMember(staff, false);
        });
    }
    
    html += '</div></div>';
    
    html += '</div>';
    
    // Agregar sección de historial de faltas
    html += renderAttendanceHistory();
    
    container.innerHTML = html;
    
    console.log(`[Attendance] Renderizado: ${currentShiftStaff.length} del turno actual, ${otherShiftStaff.length} de otros turnos`);
}

export function renderAttendanceHistory() {
    // Obtener todas las faltas de los últimos 30 días
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const absences = [];
    
    // FIXED: Filtrar personal eliminado (soft delete)
    const activeStaff = staffMembers.filter(s => !s.deleted);
    
    activeStaff.forEach(staff => {
        if (staff.attendance) {
            Object.entries(staff.attendance).forEach(([date, status]) => {
                if (status === 'absent') {
                    const dateObj = new Date(date + 'T00:00:00');
                    const timestamp = dateObj.getTime();
                    
                    // Solo incluir faltas de los últimos 30 días
                    if (timestamp >= thirtyDaysAgo) {
                        absences.push({
                            staffName: staff.name,
                            staffShift: staff.shift,
                            date: date,
                            dateObj: dateObj,
                            timestamp: timestamp
                        });
                    }
                }
            });
        }
    });
    
    // Ordenar por fecha más reciente primero
    absences.sort((a, b) => b.timestamp - a.timestamp);
    
    let historyHtml = `
        <div class="attendance-history">
            <div class="attendance-history-header">
                <div class="attendance-history-title">
                    <span>📋</span>
                    <span>Historial de Faltas (Últimos 30 días)</span>
                </div>
                <span class="attendance-history-count">${absences.length}</span>
            </div>
            <div class="attendance-history-list">
    `;
    
    if (absences.length === 0) {
        historyHtml += '<div class="attendance-history-empty">No hay faltas registradas en los últimos 30 días.</div>';
    } else {
        absences.forEach(absence => {
            const dayName = absence.dateObj.toLocaleDateString('es-MX', { weekday: 'short' });
            const dateFormatted = absence.dateObj.toLocaleDateString('es-MX', { 
                day: '2-digit', 
                month: 'short'
            });
            const timeAgo = getTimeAgo(absence.timestamp);
            
            historyHtml += `
                <div class="attendance-history-item">
                    <div class="attendance-history-info">
                        <span class="attendance-history-name">${sanitizeHTML(absence.staffName)}</span>
                        <span class="attendance-history-details">${sanitizeHTML(absence.staffShift)} • ${dayName}</span>
                    </div>
                    <div class="attendance-history-date">
                        <span class="attendance-history-day">${dateFormatted}</span>
                        <span class="attendance-history-time">${timeAgo}</span>
                    </div>
                </div>
            `;
        });
    }
    
    historyHtml += '</div></div>';
    
    return historyHtml;
}

export function addStaffMember() {
    // Resetear modal para modo agregar
    resetStaffModal(); // FIXED: Use centralized reset function
    
    // Abrir modal
    const modal = document.getElementById('staffModal');
    if (!modal) return;
    
    modal.classList.add('show');
}

export async function saveStaffFromModal() {
    const name = document.getElementById('staffName').value.trim();
    const shift = document.getElementById('staffShift').value;
    const saveBtn = document.getElementById('saveStaffBtn');
    const editingId = saveBtn ? saveBtn.getAttribute('data-editing-id') : null;
    
    // Obtener días de trabajo seleccionados
    const workDays = [];
    const workDayCheckboxes = document.querySelectorAll('.work-days-calendar input[type="checkbox"]:checked');
    workDayCheckboxes.forEach(checkbox => {
        workDays.push(checkbox.value);
    });
    
    // Validaciones
    if (!name) {
        showToast('⚠️ Ingresa el nombre del personal', 'error');
        return;
    }
    
    if (!shift) {
        showToast('⚠️ Selecciona un turno', 'error');
        return;
    }
    
    if (workDays.length === 0) {
        showToast('⚠️ Selecciona al menos un día de trabajo', 'error');
        return;
    }
    
    if (editingId) {
        // MODO EDICIÓN: Actualizar empleado existente
        const staffIndex = staffMembers.findIndex(s => s.id == editingId);
        if (staffIndex !== -1) {
            staffMembers[staffIndex] = {
                ...staffMembers[staffIndex], // Mantener datos existentes como attendance
                name: name,
                shift: shift,
                workDays: workDays,
                updatedAt: Date.now(), // FIXED: Added updatedAt field
                updatedBy: currentUser ? currentUser.name : 'Desconocido'
            };
            showToast('✅ Personal actualizado correctamente', 'success');
        }
    } else {
        // MODO CREACIÓN: Crear nuevo personal
        const newStaff = {
            id: Date.now(),
            name: name,
            shift: shift,
            workDays: workDays, // Nuevo campo: días de trabajo
            createdAt: Date.now(),
            createdBy: currentUser ? currentUser.name : 'Desconocido',
            attendance: {} // { 'YYYY-MM-DD': 'present' | 'absent' }
        };
        
        staffMembers.push(newStaff);
        showToast('✅ Personal agregado correctamente', 'success');
    }
    
    // FIXED: Guardar inmediatamente sin throttle para sincronización en tiempo real
    await saveStaffDataImmediately();
    renderAttendanceList();
    
    // Cerrar modal y resetear
    document.getElementById('staffModal').classList.remove('show');
    resetStaffModal(); // FIXED: Reset modal after save
    
    const workDaysText = workDays.map(day => {
        const dayNames = {
            'monday': 'Lun', 'tuesday': 'Mar', 'wednesday': 'Mié', 
            'thursday': 'Jue', 'friday': 'Vie', 'saturday': 'Sáb', 'sunday': 'Dom'
        };
        return dayNames[day];
    }).join(', ');
    
    showToast(`✓ ${name} agregado al personal (${workDaysText})`, 'success');
    console.log(`[Attendance] Personal agregado: ${name} (${shift}) - Días: ${workDaysText} por ${currentUser.name}`);
}

export function resetStaffModal() {
    // Limpiar campos
    document.getElementById('staffName').value = '';
    document.getElementById('staffShift').value = '';
    
    // Desmarcar todos los checkboxes
    const workDayCheckboxes = document.querySelectorAll('.work-days-calendar input[type="checkbox"]');
    workDayCheckboxes.forEach(checkbox => {
        checkbox.checked = false;
    });
    
    // Resetear título y botón
    const modalTitle = document.querySelector('#staffModal .modal-title');
    if (modalTitle) modalTitle.textContent = 'Agregar Personal';
    
    const saveBtn = document.getElementById('saveStaffBtn');
    if (saveBtn) {
        saveBtn.textContent = 'Agregar';
        saveBtn.removeAttribute('data-editing-id');
    }
}

export async function markAttendance(staffId, status) {
    logSync(`Marcando asistencia: ${staffId} -> ${status}`, 'sync');
    
    const staff = staffMembers.find(s => s.id == staffId);
    if (!staff) {
        logSync(`Error: Personal no encontrado: ${staffId}`, 'error');
        showToast('Error: Personal no encontrado', 'error');
        return;
    }
    
    const today = new Date().toISOString().split('T')[0];
    
    // Inicializar objeto de asistencia si no existe
    if (!staff.attendance) {
        staff.attendance = {};
    }
    
    // Marcar asistencia
    staff.attendance[today] = status;
    
    logSync(`Asistencia marcada localmente para ${staff.name}`, 'success');
    
    // FIXED: Guardar inmediatamente sin throttle para sincronización en tiempo real
    await saveStaffDataImmediately();
    renderAttendanceList();
    
    const statusText = status === 'present' ? 'asistió' : 'faltó';
    showToast(`✓ ${staff.name} marcado como ${statusText}`, 'success');
    
    logSync(`Asistencia sincronizada exitosamente para ${staff.name}`, 'success');
    console.log(`[Attendance] ${staff.name} marcado como ${status} por ${currentUser.name}`);
}

export async function saveStaffDataImmediately() {
    logSync('Iniciando guardado inmediato de personal', 'sync');
    
    // Guardar en localStorage inmediatamente
    localStorage.setItem('motelStaffMembers', JSON.stringify(staffMembers));
    logSync('Personal guardado en localStorage', 'success');
    
    // Guardar en Firebase inmediatamente sin throttle
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        try {
            logSync('Guardando personal en Firebase...', 'sync');
            await window.FirebaseSync.save('motelStaffMembers', staffMembers);
            logSync('Personal guardado exitosamente en Firebase', 'success');
        } catch (err) {
            logSync(`Error guardando personal en Firebase: ${err.message}`, 'error');
            console.error('[Staff] Error guardando asistencia en Firebase:', err);
        }
    } else {
        logSync('Firebase no disponible para guardado inmediato', 'warning');
    }
}

export function getCurrentDayOfWeek() {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const today = new Date();
    return days[today.getDay()];
}

export function shouldWorkToday(staff) {
    if (!staff.workDays || !Array.isArray(staff.workDays)) {
        // Compatibilidad con personal antiguo sin días de trabajo definidos
        return true;
    }
    
    const currentDay = getCurrentDayOfWeek();
    return staff.workDays.includes(currentDay);
}

export function isCurrentShiftStaff(staff) {
    const currentShift = getCurrentShift();
    
    // Mapear turnos del personal a tipos de turno del sistema
    const shiftMapping = {
        'Día': 'day',
        'Noche': 'night',
        'Fin de Semana Día': 'day',
        'Fin de Semana Noche': 'night'
    };
    
    const staffShiftType = shiftMapping[staff.shift];
    
    // Si no se puede mapear el turno, asumir que no corresponde
    if (!staffShiftType) {
        console.warn(`[Attendance] Turno no reconocido para ${staff.name}: ${staff.shift}`);
        return false;
    }
    
    const matches = staffShiftType === currentShift.type;
    console.log(`[Attendance] ${staff.name}: ${staff.shift} (${staffShiftType}) vs ${currentShift.name} (${currentShift.type}) = ${matches}`);
    
    return matches;
}

export function editStaffMember(staffId) {
    const staff = staffMembers.find(s => s.id == staffId);
    if (!staff) {
        showToast('❌ Personal no encontrado', 'error');
        return;
    }
    
    // Llenar el modal con los datos existentes
    document.getElementById('staffName').value = staff.name;
    document.getElementById('staffShift').value = staff.shift;
    
    // Marcar los días de trabajo
    const workDayCheckboxes = document.querySelectorAll('.work-days-calendar input[type="checkbox"]');
    workDayCheckboxes.forEach(checkbox => {
        checkbox.checked = staff.workDays && staff.workDays.includes(checkbox.value);
    });
    
    // Cambiar el título del modal y el botón
    const modalTitle = document.querySelector('#staffModal .modal-title');
    if (modalTitle) modalTitle.textContent = 'Editar Personal';
    
    const saveBtn = document.getElementById('saveStaffBtn');
    if (saveBtn) {
        saveBtn.textContent = 'Actualizar';
        // Guardar el ID para saber que estamos editando
        saveBtn.setAttribute('data-editing-id', staffId);
    }
    
    // Mostrar el modal
    document.getElementById('staffModal').classList.add('show');
}

export async function deleteStaffMember(staffId) {
    const staff = staffMembers.find(s => s.id == staffId);
    if (!staff) {
        showToast('Error: Personal no encontrado', 'error');
        return;
    }
    
    const confirmed = await showCustomConfirm(
        '⚠️ Eliminar Personal',
        `¿Eliminar a ${staff.name} del registro de personal?\n\nSe perderá todo el historial de asistencia.`
    );
    
    if (!confirmed) return;
    
    staff.deleted = true; // FIXED: Soft delete
    staff.deletedAt = Date.now(); // FIXED: Timestamp de eliminación
    saveData();
    renderAttendanceList(); // FIXED: Re-renderizar para aplicar filtro
    showToast(`✓ ${staff.name} eliminado del personal`, 'success');
}

window.markAttendance = markAttendance;
window.editStaffMember = editStaffMember;
window.deleteStaffMember = deleteStaffMember;