import {
    roomRevenue, _confirmCleanRoomInProgress, deepCleanSchedules,
    setRoomRevenue, setConfirmCleanRoomInProgress, setDeepCleanSchedules, rooms, currentUser
} from '../app.js';

import { sanitizeHTML, showCustomConfirm } from '../utils/formatters.js';
import { logActivity } from '../utils/logger.js';
import { invalidateRevenueIndex } from '../utils/revenue-index.js';
import { _roomSyncNow, renderRooms, renderRoomsActivity } from './rooms.js';
import { getCurrentShift } from './shifts.js';
import { saveData } from '../utils/storage-utils.js';
import { isToday } from '../utils/time.js';
import { showToast } from '../utils/toast-system.js';

// ============================================================================
// CLEANING — limpieza regular de habitaciones, notas de limpieza, y el
// sistema completo de limpieza profunda (programación, tarjetas, badges).
// Extraído de app.js tal cual (sin convertir a módulo ES todavía).
// ============================================================================

export function showCleaningView() {
    const roomsTab = document.getElementById('rooms-tab');
    if (!roomsTab) return;
    
    roomsTab.innerHTML = `
        <div class="cleaning-view">
            <div class="cleaning-header">
                <h2>🧹 Panel de Limpieza</h2>
                <p>Marca las habitaciones como limpias después de terminar</p>
            </div>
            
            <div class="cleaning-stats">
                <div class="cleaning-stat-card dirty">
                    <div class="stat-number" id="dirtyCount">0</div>
                    <div class="stat-label">Sucias</div>
                </div>
                <div class="cleaning-stat-card clean">
                    <div class="stat-number" id="cleanCount">0</div>
                    <div class="stat-label">Limpias Hoy</div>
                </div>
                <div class="cleaning-stat-card total">
                    <div class="stat-number" id="totalRooms">32</div>
                    <div class="stat-label">Total</div>
                </div>
            </div>
            
            <div class="rooms-main-container">
                <div class="cleaning-rooms-grid" id="cleaningRoomsGrid"></div>
                
                <!-- Sidebar de Notas de Limpieza -->
                <div class="rooms-right-sidebar">
                    <div id="cleaningNotesSidebar" class="sidebar-panel">
                        <h3>📝 Notas de Limpieza Recientes</h3>
                        <div id="recentCleaningNotes" class="recent-notes-list"></div>
                    </div>
                </div>
            </div>
            
            <!-- Secciones de Limpieza Profunda -->
            <div class="upcoming-deep-cleans" id="upcomingDeepCleans" style="margin: 20px;">
                <h2>🧹 Limpiezas Profundas Programadas</h2>
                <div class="upcoming-cleans-grid" id="upcomingCleansGrid"></div>
            </div>
        </div>
    `;
    
    // Asegurar que los datos están cargados antes de renderizar
    if (rooms.length === 0) {
        loadData();
    }
    
    renderCleaningRooms();
    
    // Renderizar notas de limpieza en el sidebar
    renderRecentCleaningNotes();
    
    // Renderizar secciones de limpieza profunda
    renderUpcomingDeepCleans();
}

export function renderCleaningRooms() {
    const grid = document.getElementById('cleaningRoomsGrid');
    if (!grid) return;
    
    const dirtyRooms = rooms.filter(r => r.status === 'dirty');
    
    const todayCleaned = roomRevenue.filter(r => 
        r.type === 'cleaned' && 
        isToday(r.timestamp)
    ).length;
    
    // Actualizar estadísticas
    const dirtyCountEl = document.getElementById('dirtyCount');
    const cleanCountEl = document.getElementById('cleanCount');
    
    if (dirtyCountEl) dirtyCountEl.textContent = dirtyRooms.length;
    if (cleanCountEl) cleanCountEl.textContent = todayCleaned;
    
    // Mostrar SOLO habitaciones sucias
    if (dirtyRooms.length === 0) {
        grid.innerHTML = `
            <div class="no-dirty-rooms">
                <div class="success-icon">✅</div>
                <h3>¡Todo limpio!</h3>
                <p>No hay habitaciones sucias en este momento</p>
            </div>
        `;
        return;
    }
    
    grid.innerHTML = dirtyRooms.map(room => {
        return `
            <div class="cleaning-room-card dirty" onclick="toggleCleanRoom('${room.id}')">
                <div class="room-number">${room.number}</div>
                <div class="room-status">🧹 Sucia</div>
                <div class="room-building">${room.building === 'regulares' ? 'Edificio 1' : 'Edificio Torre'}</div>
            </div>
        `;
    }).join('');
}

export function toggleCleanRoom(roomId) {
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;
    
    if (room.status === 'dirty') {
        openCleaningModal(room);
    }
}

export function openCleaningModal(room) {
    const modal = document.getElementById('cleaningModal');
    const detailsDiv = document.getElementById('cleaningDetails');
    
    // Formatear fecha y hora cuando se marcó como sucia
    const dirtyDate = room.dirtyTimestamp ? new Date(room.dirtyTimestamp) : null;
    const dirtyTimeStr = dirtyDate ? dirtyDate.toLocaleString('es-MX', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }) : 'No registrada';
    
    // Hora actual (cuando se va a limpiar)
    const now = new Date();
    const cleanTimeStr = now.toLocaleString('es-MX', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
    
    // Verificar si esta habitación tiene limpieza profunda programada
    let deepCleanScheduleInfo = '';
    const scheduledDeepClean = deepCleanSchedules.find(schedule => 
        !schedule.completed && 
        schedule.rooms.some(r => r.roomId === room.id)
    );
    
    if (scheduledDeepClean) {
        const scheduleDate = new Date(scheduledDeepClean.scheduledDate);
        const scheduleDateStr = scheduleDate.toLocaleString('es-MX', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        deepCleanScheduleInfo = `
            <div class="deep-clean-schedule-alert">
                <div class="alert-icon-deep">🧹</div>
                <div class="alert-content-deep">
                    <div class="alert-title-deep">Limpieza Profunda Programada</div>
                    <div class="alert-date-deep">${scheduleDateStr}</div>
                    ${scheduledDeepClean.notes ? `<div class="alert-notes-deep">📝 ${sanitizeHTML(scheduledDeepClean.notes)}</div>` : ''}
                </div>
            </div>
        `;
    }
    
    detailsDiv.innerHTML = `
        <div class="cleaning-info-card">
            <div class="room-info-header">
                <div class="room-number-large">${room.number}</div>
                <div class="room-building-info">${room.building === 'regulares' ? 'Edificio 1' : 'Edificio Torre'}</div>
            </div>
            
            <div class="cleaning-timeline">
                <div class="timeline-item dirty-time">
                    <div class="timeline-icon">🧹</div>
                    <div class="timeline-content">
                        <div class="timeline-label">Marcada como sucia</div>
                        <div class="timeline-date">${dirtyTimeStr}</div>
                    </div>
                </div>
                
                <div class="timeline-arrow">?</div>
                
                <div class="timeline-item clean-time">
                    <div class="timeline-icon">?</div>
                    <div class="timeline-content">
                        <div class="timeline-label">Se limpiará ahora</div>
                        <div class="timeline-date">${cleanTimeStr}</div>
                    </div>
                </div>
            </div>
            
            <div class="cleaning-form">
                <label for="cleanerName" style="display: block; margin-bottom: 8px; font-weight: 600; color: #2c3e50;">
                    👤 Limpiado por: <span style="color: #e74c3c;">*</span>
                </label>
                <input type="text" id="cleanerName" placeholder="Nombre de quien limpia (obligatorio)" required style="width: 100%; padding: 12px; border: 2px solid #3498db; border-radius: 8px; margin-bottom: 15px; font-size: 15px;">
                
                <label for="cleaningNotes" style="display: block; margin-bottom: 8px; font-weight: 600; color: #2c3e50;">
                    📝 Notas de Limpieza (opcional)
                </label>
                <textarea id="cleaningNotes" placeholder="Ej: Falta jabón, toalla manchada, etc." rows="3" style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 8px; font-size: 14px; resize: vertical;"></textarea>
            </div>
            
            ${deepCleanScheduleInfo}
        </div>
    `;
    
    modal.classList.add('show');
    
    // MEJORADO: Enfocar automáticamente usando requestAnimationFrame
    // Esto asegura que el DOM esté completamente renderizado
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const cleanerInput = document.getElementById('cleanerName');
            if (cleanerInput) {
                cleanerInput.focus();
                cleanerInput.select(); // Seleccionar texto si hay alguno
            }
        });
    });
    
    // Configurar botón de confirmación
    const confirmBtn = document.getElementById('confirmCleanBtn');
    const cancelBtn = document.getElementById('cancelCleanBtn');
    
    confirmBtn.onclick = () => {
        const success = confirmCleanRoom(room.id);
        if (success) modal.classList.remove('show');
    };
    
    cancelBtn.onclick = () => {
        modal.classList.remove('show');
    };
    
    // Permitir confirmar con Enter en el input de nombre
    const cleanerInput = document.getElementById('cleanerName');
    if (cleanerInput) {
        cleanerInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                const success = confirmCleanRoom(room.id);
                if (success) modal.classList.remove('show');
            }
        }, { once: true });
    }
}

export function confirmCleanRoom(roomId) {
    // Evitar procesamiento doble por clics rápidos
    if (_confirmCleanRoomInProgress) return false;

    const room = rooms.find(r => r.id === roomId);
    if (!room) return false;

    const cleanerNameInput = document.getElementById('cleanerName');

    // Validación mejorada: verificar que el input existe y tiene valor
    if (!cleanerNameInput) {
        console.error('[CleanRoom] Input cleanerName no encontrado en el DOM');
        showToast('Error: No se pudo encontrar el campo de nombre', 'error');
        return false;
    }

    const cleanerName = cleanerNameInput.value.trim();
    if (!cleanerName || cleanerName.length === 0) {
        showToast('Por favor ingresa el nombre de quien limpió', 'error');
        cleanerNameInput.focus();
        return false;
    }

    // Bloquear nuevos disparos mientras se procesa
    setConfirmCleanRoomInProgress(true);

    const notesTextarea = document.getElementById('cleaningNotes');
    const cleaningNotes = notesTextarea ? notesTextarea.value.trim() : '';

    // Cambiar estado a disponible
    room.status = 'available';
    room.cleanedCount++;
    room.lastModified = _roomSyncNow(); // Timestamp para merge inteligente
    const cleanTimestamp = Date.now();

    // CRÍTICO: Resetear TODOS los campos de la habitación
    room.checkInTime = null;
    room.endTime = null;
    room.guestName = '';
    room.guestCount = 0;
    room.price = 0;
    room.notes = '';
    room.customTime = null;
    room.paymentMethod = null;

    if (cleaningNotes) {
        // Validar y sanitizar la nota
        const sanitizedNote = cleaningNotes.trim();
        if (sanitizedNote.length > 0) {
            if (!room.cleaningNotes) room.cleaningNotes = [];
            
            const noteData = { 
                id: cleanTimestamp, 
                note: sanitizedNote, 
                timestamp: cleanTimestamp, 
                cleanedBy: cleanerName 
            };
            
            room.cleaningNotes.push(noteData);
            console.log(`[CleaningNotes] ✅ Nota guardada para habitación ${room.number}:`, sanitizedNote);
            
            // Limitar notas por habitación (máximo 50)
            if (room.cleaningNotes.length > 50) {
                room.cleaningNotes = room.cleaningNotes.slice(-50);
                console.log(`[CleaningNotes] Limitando notas de habitación ${room.number} a 50 más recientes`);
            }
        } else {
            console.log(`[CleaningNotes] Nota vacía para habitación ${room.number}, no se guarda`);
        }
    }

    roomRevenue.push({
        id: cleanTimestamp, roomId: room.id, roomNumber: room.number, building: room.building,
        dirtyTimestamp: room.dirtyTimestamp || null, cleanedTimestamp: cleanTimestamp,
        cleaningNotes: cleaningNotes, cleanedBy: cleanerName,
        timestamp: cleanTimestamp, type: 'cleaned',
        shift: getCurrentShift().type, shiftName: getCurrentShift().name
    });
    invalidateRevenueIndex();
    
    // Limitar a últimos 10000 registros sin eliminar nunca registros del turno actual
    if (roomRevenue.length > 10000) {
        console.warn('[Sistema] Archivando ingresos antiguos...');
        const keep = roomRevenue.filter(r => r.timestamp >= currentShiftStart);
        const extra = roomRevenue.filter(r => r.timestamp < currentShiftStart).slice(-Math.max(0, 10000 - keep.length));
        setRoomRevenue([...extra, ...keep]);
        console.log(`[Sistema] Archivados registros antiguos. Preservados: ${keep.length} del turno actual.`);
    }

    room.dirtyTimestamp = null;

    logActivity('rooms', `🧹 Habitación ${room.number} limpiada por ${cleanerName}`, {
        roomId: room.id, roomNumber: room.number, building: room.building, notes: cleaningNotes
    });

    console.log(`[CleaningSystem] ✅ Limpieza registrada - Hab: ${room.number}, Notas: ${cleaningNotes ? 'Sí' : 'No'}, Por: ${cleanerName}`);

    saveData();
    renderCleaningRooms();
    renderRecentCleaningNotes();

    const actModal = document.getElementById('roomsActivityModal');
    if (actModal && actModal.classList.contains('show')) renderRoomsActivity();

    // Limpiar campos
    if (cleanerNameInput) cleanerNameInput.value = '';
    if (notesTextarea) notesTextarea.value = '';

    showToast(`🧹 Habitación ${room.number} marcada como limpia`, 'success');
    setConfirmCleanRoomInProgress(false);
    return true;
}

export function renderRecentCleaningNotes() {
    const notesContainer = document.getElementById('recentCleaningNotes');
    if (!notesContainer) {
        console.warn('[CleaningNotes] Contenedor recentCleaningNotes no encontrado');
        return;
    }

    console.log('[CleaningNotes] Renderizando notas de limpieza...');
    
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const allNotes = [];
    
    // Validar que rooms existe y es un array
    if (!rooms || !Array.isArray(rooms)) {
        console.error('[CleaningNotes] Array de habitaciones no válido');
        notesContainer.innerHTML = '<div class="no-notes"><p>Error cargando habitaciones</p></div>';
        return;
    }
    
    // SOLO habitaciones que tienen notas de limpieza
    rooms.forEach(function(room) {
        if (room.cleaningNotes && Array.isArray(room.cleaningNotes) && room.cleaningNotes.length > 0) {
            room.cleaningNotes.forEach(function(note) {
                // Validar estructura de la nota
                if (note && note.timestamp && note.note && note.timestamp >= oneDayAgo) {
                    allNotes.push({
                        id: note.id,
                        note: sanitizeHTML(note.note), // Sanitizar para seguridad
                        timestamp: note.timestamp,
                        cleanedBy: sanitizeHTML(note.cleanedBy || 'Desconocido'),
                        roomId: room.id,
                        roomNumber: room.number,
                        building: room.building
                    });
                }
            });
        }
    });

    allNotes.sort(function(a, b) { return b.timestamp - a.timestamp; });
    const recentNotes = allNotes.slice(0, 15);

    console.log(`[CleaningNotes] ✅ ${recentNotes.length} notas encontradas`);

    if (recentNotes.length === 0) {
        notesContainer.innerHTML = '<div class="no-notes"><p>No hay notas de limpieza recientes</p></div>';
        return;
    }

    notesContainer.innerHTML = recentNotes.map(function(note) {
        const buildingName = note.building === 'regulares' ? 'Edificio 1' : 'Torre';
        const timeStr = new Date(note.timestamp).toLocaleString('es-MX', {
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
        });
        return '<div class="sidebar-note-item">'
            + '<div class="sidebar-note-header">'
            + '<div class="sidebar-note-badges">'
            + '<span class="sidebar-room-badge">Hab. ' + note.roomNumber + '</span>'
            + '<span class="sidebar-building-badge">' + buildingName + '</span>'
            + '<button class="btn-delete-note" onclick="deleteCleaningNote(\''  + note.roomId + '\', ' + note.id + ')" title="Eliminar">&times;</button>'
            + '</div></div>'
            + '<div class="sidebar-note-text">' + note.note + '</div>'
            + '<div class="sidebar-note-footer">'
            + '<span class="sidebar-note-author">👤 ' + note.cleanedBy + '</span>'
            + '<span class="sidebar-note-date">' + timeStr + '</span>'
            + '</div></div>';
    }).join('');
}

export async function deleteCleaningNote(roomId, noteId) {
    try {
        console.log(`[CleaningNotes] Eliminando nota ${noteId} de habitación ${roomId}`);
        
        const room = rooms.find(r => r.id === roomId);
        if (!room) {
            console.error('[CleaningNotes] Habitación no encontrada:', roomId);
            showToast('❌ Habitación no encontrada', 'error');
            return;
        }
        
        if (!room.cleaningNotes || !Array.isArray(room.cleaningNotes)) {
            console.error('[CleaningNotes] No hay notas en esta habitación');
            showToast('❌ No hay notas en esta habitación', 'error');
            return;
        }
        
        // Encontrar índice de la nota
        const noteIndex = room.cleaningNotes.findIndex(n => n.id === noteId);
        if (noteIndex === -1) {
            console.error('[CleaningNotes] Nota no encontrada:', noteId);
            showToast('❌ Nota no encontrada', 'error');
            return;
        }
        
        // Confirmar eliminación con modal personalizado
        const confirmed = await showCustomConfirm(
            '🗑️ Eliminar Nota',
            '¿Estás seguro de eliminar esta nota de limpieza?\n\nEsta acción no se puede deshacer.'
        );
        
        if (!confirmed) return;
        
        // Eliminar la nota
        const deletedNote = room.cleaningNotes[noteIndex];
        room.cleaningNotes.splice(noteIndex, 1);
        
        console.log(`[CleaningNotes] ✅ Nota eliminada:`, deletedNote.note);
        
        // Guardar cambios
        saveData();
        renderRecentCleaningNotes();
        
        showToast('🗑️ Nota de limpieza eliminada', 'success');
        
    } catch (error) {
        console.error('[CleaningNotes] Error eliminando nota:', error);
        showToast('❌ Error eliminando nota', 'error');
    }
}

export async function loadDeepCleanSchedules() {
    try {
        // Cache-first: render immediately from localStorage
        const saved = localStorage.getItem('deepCleanSchedules');
        setDeepCleanSchedules(saved ? JSON.parse(saved) : []);
        renderScheduledCleansList();
        renderUpcomingDeepCleans();
        // Refresh from Firebase in background
        if (window.FirebaseSync && window.FirebaseSync.ready) {
            window.FirebaseSync.load('deepCleanSchedules', null).then(fbData => {
                if (fbData && Array.isArray(fbData)) {
                    setDeepCleanSchedules(fbData);
                    localStorage.setItem('deepCleanSchedules', JSON.stringify(deepCleanSchedules));
                    renderScheduledCleansList();
                    renderUpcomingDeepCleans();
                }
            }).catch(() => {});
        }
    } catch (e) {
        console.error('[DeepClean] Error cargando:', e);
        setDeepCleanSchedules([]);
    }
}

export function saveDeepCleanSchedules() {
    localStorage.setItem('deepCleanSchedules', JSON.stringify(deepCleanSchedules));
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        window.FirebaseSync.save('deepCleanSchedules', deepCleanSchedules)
            .catch(err => {
                console.error('[Firebase] Error guardando deepCleanSchedules:', err);
                // No reintentar aquí - el sistema offline queue de firebase-sync.js ya maneja esto
            });
    }
}

export function openDeepCleanScheduleModal() {
    const modal = document.getElementById('deepCleanScheduleModal');
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('deepCleanDate').setAttribute('min', today);
    document.getElementById('deepCleanDate').value = today;
    renderRoomSelectionGrid();
    modal.classList.add('show');
}

export function closeDeepCleanScheduleModal() {
    document.getElementById('deepCleanScheduleModal').classList.remove('show');
    document.getElementById('deepCleanDate').value = '';
    document.getElementById('deepCleanTime').value = '10:00';
    document.getElementById('deepCleanNotes').value = '';
    document.querySelectorAll('.room-selection-btn.selected').forEach(btn => btn.classList.remove('selected'));
}

export function renderRoomSelectionGrid() {
    const grid = document.getElementById('roomSelectionGrid');
    if (!grid) return;
    grid.innerHTML = rooms.map(room => {
        const building = room.building === 'regulares' ? 'Ed.1' : 'Torre';
        return `<button class="room-selection-btn" onclick="toggleRoomSelection('${room.id}')" id="sel-${room.id}">${building}-${room.number}</button>`;
    }).join('');
}

export function toggleRoomSelection(roomId) {
    const btn = document.getElementById('sel-' + roomId);
    if (btn) btn.classList.toggle('selected');
}

export function roomHasPendingDeepClean(room) {
    if (!room || !deepCleanSchedules || !deepCleanSchedules.length) return false;
    return deepCleanSchedules.some((s) => !s.completed && Array.isArray(s.rooms)
        && s.rooms.some((r) => r.roomId === room.id && r.completed !== true));
}

export function deepCleanRoomLabel(r) {
    return `${r.building === 'regulares' ? 'Ed.1' : 'Torre'}-${r.roomNumber}`;
}

export function deepCleanStatusBadgesHtml(roomsInSchedule) {
    return roomsInSchedule.map((r) => {
        const done = r.completed === true;
        const badgeClass = done ? 'deep-clean-status-badge deep-clean-status-badge--done' : 'deep-clean-status-badge deep-clean-status-badge--pending';
        const badgeText = done ? 'Hecha' : 'Pendiente';
        return `<span class="scheduled-room-chip"><span class="room-chip">${deepCleanRoomLabel(r)}</span><span class="${badgeClass}">${badgeText}</span></span>`;
    }).join('');
}

export function saveDeepCleanSchedule() {
    const date = document.getElementById('deepCleanDate').value;
    const time = document.getElementById('deepCleanTime').value;
    const notes = document.getElementById('deepCleanNotes').value.trim();
    if (!date || !time) { showToast('Selecciona fecha y hora', 'error'); return; }
    const selectedRooms = [];
    document.querySelectorAll('.room-selection-btn.selected').forEach(btn => {
        const roomId = btn.id.replace('sel-', '');
        const room = rooms.find(r => r.id === roomId);
        if (room) selectedRooms.push({ roomId: room.id, roomNumber: room.number, building: room.building });
    });
    if (selectedRooms.length === 0) { showToast('Selecciona al menos una habitación', 'error'); return; }
    const schedule = {
        id: Date.now(), scheduledDate: new Date(`${date}T${time}`).getTime(),
        rooms: selectedRooms, notes, completed: false, createdAt: Date.now(),
        createdBy: currentUser ? currentUser.name : 'Sistema'
    };
    deepCleanSchedules.push(schedule);
    saveDeepCleanSchedules();
    closeDeepCleanScheduleModal();
    renderScheduledCleansList();
    if (!currentUser || currentUser.role !== 'limpieza') renderRooms();
    showToast('Limpieza profunda programada', 'success');
}

export function renderScheduledCleansList() {
    const container = document.getElementById('scheduledCleansList');
    if (!container) return;
    const pending = deepCleanSchedules.filter(s => !s.completed);
    if (pending.length === 0) {
        container.innerHTML = '<p style="color:#999;text-align:center;padding:10px;">No hay limpiezas programadas</p>';
        return;
    }
    container.innerHTML = pending.map(schedule => {
        const date = new Date(schedule.scheduledDate);
        const dateStr = date.toLocaleString('es-MX', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        return `<div class="scheduled-clean-item">
            <div class="scheduled-clean-info">
                <div class="scheduled-clean-date">📅 ${dateStr}</div>
                <div class="scheduled-clean-rooms">${deepCleanStatusBadgesHtml(schedule.rooms)}</div>
                ${schedule.notes ? `<div class="scheduled-clean-notes">📝 ${sanitizeHTML(schedule.notes)}</div>` : ''}
            </div>
            <button class="btn-delete-schedule" onclick="deleteDeepCleanSchedule(${schedule.id})">✕</button>
        </div>`;
    }).join('');
}

export function deleteDeepCleanSchedule(scheduleId) {
    setDeepCleanSchedules(deepCleanSchedules.filter(s => s.id !== scheduleId));
    saveDeepCleanSchedules();
    renderScheduledCleansList();
    if (!currentUser || currentUser.role !== 'limpieza') renderRooms();
    showToast('Programación eliminada', 'info');
}

export function renderUpcomingDeepCleans() {
    const container = document.getElementById('upcomingCleansGrid');
    if (!container) return;
    const upcoming = deepCleanSchedules.filter(s => !s.completed);
    if (upcoming.length === 0) {
        container.innerHTML = '<p style="color:#999;text-align:center;">No hay limpiezas profundas programadas</p>';
        return;
    }
    container.innerHTML = upcoming.map(schedule => {
        const date = new Date(schedule.scheduledDate);
        const dateStr = date.toLocaleString('es-MX', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
        return `<div class="upcoming-clean-card">
            <div class="upcoming-clean-date">📅 ${dateStr}</div>
            <div class="upcoming-clean-rooms upcoming-clean-rooms--badges">${deepCleanStatusBadgesHtml(schedule.rooms)}</div>
            ${schedule.notes ? `<div class="upcoming-clean-notes">📝 ${sanitizeHTML(schedule.notes)}</div>` : ''}
            <div class="upcoming-clean-actions">
                ${schedule.rooms.map(r => `<button class="btn-complete-deep-clean" onclick="openDeepCleanConfirmModal('${r.roomId}', ${schedule.id})">✓ Completar Hab.${r.roomNumber}</button>`).join('')}
            </div>
        </div>`;
    }).join('');
}

export function completeDeepCleanRoom(roomId, scheduleId) { openDeepCleanConfirmModal(roomId, scheduleId); }

export function openDeepCleanConfirmModal(roomId, scheduleId) {
    const modal = document.getElementById('deepCleanConfirmModal');
    const schedule = deepCleanSchedules.find(s => s.id === scheduleId);
    const roomData = schedule ? schedule.rooms.find(r => r.roomId === roomId) : null;
    if (!roomData) return;
    const el = id => document.getElementById(id);
    if (el('dcRoomNumber')) el('dcRoomNumber').textContent = roomData.roomNumber;
    if (el('dcRoomBuilding')) el('dcRoomBuilding').textContent = roomData.building === 'regulares' ? 'Edificio 1' : 'Edificio Torre';
    if (el('dcScheduledDate')) el('dcScheduledDate').textContent = new Date(schedule.scheduledDate).toLocaleString('es-MX');
    if (schedule.notes && el('dcScheduleNotes')) {
        el('dcScheduleNotes').textContent = schedule.notes;
        el('dcScheduleNotesContainer').style.display = '';
    }
    const confirmBtn = document.getElementById('btnConfirmDeepClean');
    if (confirmBtn) confirmBtn.onclick = () => confirmDeepCleanCompletion(roomId, scheduleId);
    modal.classList.add('show');
}

export function closeDeepCleanConfirmModal() {
    document.getElementById('deepCleanConfirmModal').classList.remove('show');
}

export function confirmDeepCleanCompletion(roomId, scheduleId) {
    const schedule = deepCleanSchedules.find(s => s.id === scheduleId);
    if (!schedule) return;
    const roomData = schedule.rooms.find(r => r.roomId === roomId);
    if (!roomData) return;
    const notes = document.getElementById('deepCleanCompletionNotes') ? document.getElementById('deepCleanCompletionNotes').value.trim() : '';
    roomData.completed = true;
    roomData.completedAt = Date.now();
    roomData.completionNotes = notes;
    if (schedule.rooms.every(r => r.completed)) schedule.completed = true;
    saveDeepCleanSchedules();
    closeDeepCleanConfirmModal();
    renderUpcomingDeepCleans();
    renderScheduledCleansList();
    if (!currentUser || currentUser.role !== 'limpieza') renderRooms();
    showToast('Limpieza profunda completada', 'success');
}

export async function initDeepCleaningSystem() {
    await loadDeepCleanSchedules();
    renderScheduledCleansList();
}

window.deleteCleaningNote = deleteCleaningNote;
window.deleteDeepCleanSchedule = deleteDeepCleanSchedule;
window.openDeepCleanConfirmModal = openDeepCleanConfirmModal;
window.toggleCleanRoom = toggleCleanRoom;
window.toggleRoomSelection = toggleRoomSelection;

window.closeDeepCleanConfirmModal = closeDeepCleanConfirmModal;
window.closeDeepCleanScheduleModal = closeDeepCleanScheduleModal;
window.openDeepCleanScheduleModal = openDeepCleanScheduleModal;
window.saveDeepCleanSchedule = saveDeepCleanSchedule;