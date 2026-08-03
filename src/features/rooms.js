import {
    roomTimerElements, currentUser, currentFilter, searchRoomNumber, rooms, roomRevenue,
    sales, expenses, reservations, RESERVATION_LOCK_MS, currentRoomId, _appReady,
    _roomsReconciledWithCloud, currentShiftStart, EXPECTED_ROOM_COUNT, ROOM_STATUS_PRIORITY,
    currentRevenueType, currentRevenueFilter, currentRoomsActivityFilter,
    setRooms, setRoomRevenue, setCurrentRoomId, setRoomsReconciledWithCloud,
    setCurrentRevenueType, setCurrentRevenueFilter, setCurrentRoomsActivityFilter
} from '../app.js';

import { renderCleaningRooms, renderRecentCleaningNotes, roomHasPendingDeepClean, showCleaningView } from './cleaning.js';
import { escapeAttr, escapeHtml, normalizePhone, sanitizeHTML, showCustomConfirm, translateStatus } from '../utils/formatters.js';
import { invalidateRevenueIndex } from '../utils/revenue-index.js';
import { logActivity, logMergeConflict } from '../utils/logger.js';
import { addSaleToMovements } from './monthly-report.js';
import { _loadHotShardsFromFirebase } from '../utils/shards.js';
import { getCurrentShift, getPeriodStart, periodLabel } from './shifts.js';
import { _saveDataImmediate, safeLocalStorageSet, saveData } from '../utils/storage-utils.js';
import { getElapsedTime } from '../utils/time.js';
import { showToast } from '../utils/toast-system.js';

// ============================================================================
// ROOMS — habitaciones, reservas, sincronización/integridad de rooms,
// tarjetas de habitación, detalle de ingresos y actividad de habitaciones.
// Extraído de app.js tal cual (sin convertir a módulo ES todavía).
// ============================================================================

window.repairRooms = function() {
    renderRooms();
    showToast('🔧 Habitaciones re-renderizadas', 'info');
}

export function isRoomReservationLocked(room) {
    if (!room || room.status !== 'reserved') return false;
    
    const res = reservations.find(x => x?.id === room.reservationId);
    if (!res) return false;
    
    const ts = res.reservationTimestamp ?? res.createdAt;
    if (!ts || !Number.isFinite(ts)) return false;
    
    return (ts - Date.now()) <= RESERVATION_LOCK_MS;
}

export function renderReservationsSidebar() {
    const roomSelect = document.getElementById('reservationRoomSelect');
    const list = document.getElementById('reservationsList');
    
    if (!roomSelect || !list) {
        console.error('[Reservations] ERROR: No se encontraron los elementos del DOM');
        return;
    }

    // Poblar select con TODAS las habitaciones
    const statusLabel = { available: '✅', occupied: '🔴', dirty: '🟡', reserved: '📌', 'not-available': '⛔' };
    const allRooms = (rooms || []).filter(r => r).slice().sort((a, b) => {
        if (a.building !== b.building) return a.building === 'regulares' ? -1 : 1;
        return a.number - b.number;
    });
    const optPlaceholder = `<option value="">Seleccionar habitación</option>`;
    roomSelect.innerHTML = optPlaceholder + allRooms.map(r => {
        const label = `${r.building === 'regulares' ? 'Ed.1' : 'Torre'}-${r.number}${r.roomName ? ` (${r.roomName})` : ''} ${statusLabel[r.status] || ''}`;
        return `<option value="${r.id}">${label}</option>`;
    }).join('');

    // Render listado (pendientes a futuro, ordenadas por fecha)
    const now = Date.now();
    const items = (Array.isArray(reservations) ? reservations : [])
        .filter(r => r && !['cancelled', 'completed'].includes(r.status ?? 'pending'))
        .slice()
        .sort((a, b) => (a.reservationTimestamp ?? 0) - (b.reservationTimestamp ?? 0));

    if (items.length === 0) {
        list.innerHTML = '<div class="no-notes"><p>No hay reservas registradas</p></div>';
        return;
    }

    list.innerHTML = items.map(r => {
        const ts = r.reservationTimestamp ?? r.createdAt ?? 0;
        const dt = ts ? new Date(ts) : null;
        const dateStr = dt ? dt.toLocaleString('es-MX', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
        const msUntil = ts - now;
        const locked = msUntil <= RESERVATION_LOCK_MS;
        const statusText = locked ? 'Reservada (bloqueada)' : 'Reservada (no bloqueada)';
        const roomLabel = `${r.building === 'regulares' ? 'Ed.1' : 'Torre'}-${r.roomNumber}`;
        const phone = r.phone ? String(r.phone) : '';
        const pm = r.paymentMethod === 'tarjeta' ? '💳 Tarjeta' : (r.paymentMethod === 'efectivo' ? '💵 Efectivo' : '—');
        const price = Number(r.price);
        return `
            <div class="reservation-item ${locked ? 'locked' : ''}">
                <div class="reservation-item-header">
                    <span class="reservation-room-badge">${roomLabel}</span>
                    <span class="reservation-status-badge ${locked ? 'locked' : ''}">${statusText}</span>
                </div>
                <div class="reservation-meta">
                    <div><strong>Nombre:</strong> ${escapeHtml(r.guestName || '')}</div>
                    <div><strong>Tel:</strong> ${escapeHtml(phone)}</div>
                    <div><strong>Fecha:</strong> ${escapeHtml(dateStr)}</div>
                    <div><strong>Precio:</strong> ${escapeHtml(Number.isFinite(price) ? ('$' + price.toFixed(2)) : '—')}</div>
                    <div><strong>Pago:</strong> ${escapeHtml(pm)}</div>
                </div>
                <div class="reservation-actions">
                    <button class="btn-cancel-res" onclick="cancelReservation(${Number(r.id)})">Cancelar</button>
                </div>
            </div>
        `;
    }).join('');
}

export function createReservationFromSidebar(formValues) {
    const { roomId, guestName, phone, reservationTimestamp, paymentMethod, price } = formValues;
    const room = rooms.find(r => r && r.id === roomId);
    if (!room) throw new Error('Habitación no encontrada');
    if (room.status !== 'available') throw new Error(`Habitación ${room.number} no está disponible (${translateStatus(room.status)}) — no se puede reservar`);
    if (!guestName || !guestName.trim()) throw new Error('Nombre requerido');
    if (!phone || !phone.trim()) throw new Error('Teléfono requerido');
    if (!reservationTimestamp || !Number.isFinite(reservationTimestamp)) throw new Error('Fecha/hora inválidas');
    if (!paymentMethod) throw new Error('Método de pago requerido');
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) throw new Error('Precio requerido');

    const id = Date.now();
    const reservation = {
        id,
        roomId: room.id,
        roomNumber: room.number,
        building: room.building,
        guestName: guestName.trim(),
        phone: normalizePhone(phone),
        reservationTimestamp,
        price: p,
        paymentMethod,
        status: 'pending',
        createdAt: id,
        updatedAt: id
    };

    reservations.push(reservation);

    room.status = 'reserved';
    room.reservationId = reservation.id;
    room.lastModified = _roomSyncNow();
    
    // NO registrar ingreso aquí - se registrará cuando el cliente llegue
    // El ingreso se registra en confirmReservationStart() cuando la habitación pasa a 'occupied'

    logActivity('rooms', `📌 Reserva creada Hab. ${room.number} (${room.building === 'regulares' ? 'Ed.1' : 'Torre'})`, {
        reservationId: reservation.id,
        roomId: room.id,
        guestName: reservation.guestName,
        phone: reservation.phone,
        reservationTimestamp
    });

    saveData();
    renderRooms();
    renderReservationsSidebar();
}

export function cancelReservation(reservationId) {
    const idx = reservations.findIndex(r => r && r.id === reservationId);
    if (idx === -1) return;
    const res = reservations[idx];

    showCustomConfirm('Cancelar reserva', '¿Deseas cancelar esta reserva?').then(confirmed => {
        if (!confirmed) return;

        reservations[idx].status = 'cancelled';
        reservations[idx].updatedAt = Date.now();

        const room = rooms.find(r => r && r.id === res.roomId);
        if (room && room.status === 'reserved' && room.reservationId === reservationId) {
            room.status = 'available';
            room.reservationId = null;
            room.lastModified = _roomSyncNow();
        }

        saveData();
        renderRooms();
        renderReservationsSidebar();
        showToast('Reserva cancelada', 'info');
    });
}

export function confirmReservationStart() {
    const room = rooms.find(r => r.id === currentRoomId);
    if (!room || room.status !== 'reserved') {
        showToast('Error: La habitación no está reservada', 'error');
        return;
    }
    
    const reservation = reservations.find(r => r.id === room.reservationId);
    if (!reservation) {
        showToast('Error: No se encontró la reserva', 'error');
        return;
    }
    
    // Leer el método de pago confirmado por el recepcionista en el modal
    const confirmedPaymentMethod = validatePaymentMethod('reservationStartPaymentMethod', 'Por favor selecciona el método de pago para esta reserva');
    if (!confirmedPaymentMethod) return;

    // Marcar la habitación como ocupada con los datos de la reserva
    room.status = 'occupied';
    room.checkInTime = _roomSyncNow();
    room.lastModified = _roomSyncNow(); // Timestamp para merge inteligente
    room.guestName = reservation.guestName || '';
    room.guestPhone = reservation.phone || ''; // CORREGIDO: era guestPhone
    room.price = reservation.price || room.defaultPrice;
    room.paymentMethod = confirmedPaymentMethod;
    
    // Calcular tiempo de finalización — usar las horas reales del cuarto
    // (la reserva no captura horas propias; usar 6h fijas aquí regalaba
    // tiempo extra gratis en los cuartos de 4h, que son la mayoría).
    const hours = reservation.hours || room.defaultHours;
    room.endTime = room.checkInTime + (hours * 3600000);
    room.customTime = hours;
    
    // Actualizar la reserva como completada
    reservation.status = 'completed';
    reservation.updatedAt = Date.now();
    
    // AHORA SÍ registrar el ingreso (cuando el cliente realmente llega)
    const revenueEntry = {
        id: Date.now(),
        roomId: room.id,
        roomNumber: room.number,
        building: room.building,
        price: room.price,
        checkInTime: room.checkInTime,
        timestamp: Date.now(),
        type: 'sold',
        paymentMethod: room.paymentMethod,
        shift: getCurrentShift().type,
        shiftName: getCurrentShift().name,
        guestName: room.guestName,
        fromReservation: true // Flag para identificar que viene de reserva
    };
    
    roomRevenue.push(revenueEntry);
    invalidateRevenueIndex(); // Invalidar índice después de agregar
    
    console.log('[Revenue] ✓ Ingreso registrado:', {
        habitacion: room.number,
        precio: room.price,
        turno: revenueEntry.shift,
        timestamp: new Date(revenueEntry.timestamp).toLocaleString()
    });
    
    // Limitar a últimos 10000 registros sin eliminar nunca registros del turno actual
    if (roomRevenue.length > 10000) {
        console.warn('[Sistema] Archivando ingresos antiguos...');
        const keep = roomRevenue.filter(r => r.timestamp >= currentShiftStart);
        const extra = roomRevenue.filter(r => r.timestamp < currentShiftStart).slice(-Math.max(0, 10000 - keep.length));
        setRoomRevenue([...extra, ...keep]);
        console.log(`[Sistema] Archivados registros antiguos. Preservados: ${keep.length} del turno actual.`);
    }

    // _saveDataImmediate() en vez de saveData(): esta acción representa una
    // venta (dinero + habitación ocupada) — no debe esperar el throttle de
    // 2s que existe para agrupar cambios menores. El empleado espera ver el
    // cobro reflejado en el otro dispositivo al instante, no unos segundos
    // después.
    _saveDataImmediate();
    renderRooms();
    renderReservationsSidebar();
    document.getElementById('roomModal').classList.remove('show');
    showToast(`Habitación ${room.number} confirmada en uso`, 'success');
}

export function _markRoomsReconciled(reason) {
    if (_roomsReconciledWithCloud) return;
    setRoomsReconciledWithCloud(true);
    console.log(`[Sync] rooms reconciliado con la nube (${reason}) — habilitando broadcast por habitación`);
    saveData(); // flush inmediato de cualquier edición hecha mientras la puerta estaba cerrada
}

export function isValidRoomsArray(arr) {
    if (!Array.isArray(arr) || arr.length !== EXPECTED_ROOM_COUNT) return false;
    const reg = arr.filter(r => r && r.building === 'regulares').length;
    const tor = arr.filter(r => r && r.building === 'torre').length;
    return reg === 16 && tor === 16;
}

export function tryRepairRoomsFromIds(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    arr.forEach(room => {
        if (!room || room.building === 'regulares' || room.building === 'torre') return;
        if (room.id && typeof room.id === 'string') {
            if (room.id.startsWith('regulares-')) room.building = 'regulares';
            else if (room.id.startsWith('torre-')) room.building = 'torre';
        }
    });
    return isValidRoomsArray(arr);
}

export function _roomsDiffer(a, b) {
    if (!a || !b) return a !== b;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        if (a[k] !== b[k]) return true;
    }
    return false;
}

export function mergeRoomsFromFirebase(incomingRooms, currentRooms) {
    if (!Array.isArray(incomingRooms) || incomingRooms.length === 0) {
        return currentRooms;
    }

    if (!Array.isArray(currentRooms) || currentRooms.length === 0) {
        return incomingRooms;
    }
    
    // Crear mapas de AMBAS fuentes
    const incomingMap = new Map();
    const currentMap = new Map();
    
    incomingRooms.forEach(room => {
        if (room && room.id) incomingMap.set(room.id, room);
    });
    
    currentRooms.forEach(room => {
        if (room && room.id) currentMap.set(room.id, room);
    });
    
    const allRoomIds = new Set([...incomingMap.keys(), ...currentMap.keys()]);
    const merged = [];

    allRoomIds.forEach(roomId => {
        const incomingRoom = incomingMap.get(roomId);
        const currentRoom = currentMap.get(roomId);

        if (!incomingRoom && currentRoom) {
            merged.push({ ...currentRoom });
            return;
        }
        if (incomingRoom && !currentRoom) {
            merged.push({ ...incomingRoom });
            return;
        }
        merged.push(resolveRoomConflict(incomingRoom, currentRoom));
    });

    merged.sort((a, b) => {
        if (a.building !== b.building) return a.building === 'regulares' ? -1 : 1;
        return a.number - b.number;
    });

    if (merged.length < Math.max(incomingRooms.length, currentRooms.length)) {
        console.error('[Merge] Posible pérdida de habitaciones en merge');
    }

    return merged;
}

export function _roomSyncNow() {
    return (window.FirebaseSync && typeof window.FirebaseSync.getCorrectedNow === 'function')
        ? window.FirebaseSync.getCorrectedNow()
        : Date.now();
}

export function roomStatusTimestamp(room) {
    if (room.status === 'occupied') return room.checkInTime || room.lastModified || 0;
    if (room.status === 'dirty') return room.dirtyTimestamp || room.lastModified || 0;
    return room.lastModified || 0;
}

export function resolveRoomConflict(incoming, current) {
    const resolved = { ...current };
    // 10s (valor original) era demasiado ancho: capturaba acciones
    // deliberadas y SECUENCIALES en flujos normales de operación — p.ej.
    // marcar una habitación sucia en un dispositivo y, segundos después,
    // confirmarla limpia desde otro — como si fueran un conflicto
    // ambiguo/simultáneo. En ese caso el desempate por prioridad de
    // negocio (dirty > available) hacía ganar la marca de "sucia" vieja
    // sobre la limpieza recién hecha, y el estado volvía a 'dirty' solo
    // porque las dos acciones habían ocurrido con pocos segundos de
    // diferencia, no porque de verdad hubiera ambigüedad de reloj entre
    // dispositivos. 2s sigue cubriendo un desfase de reloj real entre
    // dispositivos sin atrapar ese flujo secuencial normal.
    const TIME_TOLERANCE_MS = 2000;

    resolved.lastModified = Math.max(incoming.lastModified || 0, current.lastModified || 0);
    resolved.cleanedCount = Math.max(incoming.cleanedCount || 0, current.cleanedCount || 0);
    for (const field of ['dirtyTimestamp', 'cleanedTimestamp', 'cleaningNotes']) {
        if (!resolved[field] && incoming[field]) resolved[field] = incoming[field];
    }

    if (current.status === incoming.status) {
        // Mismo estado en ambos lados (p.ej. ambos 'occupied'): no hay
        // conflicto de ESTADO, pero SÍ puede haber cambiado algo más — el
        // caso típico es una renovación (renewStay()), que suma precio y
        // extiende endTime SIN tocar status. renewStay() marca
        // room.lastModified = Date.now() explícitamente para este momento:
        // "que la renovación prevalezca en merges con Firebase". Antes esta
        // rama cortaba aquí sin mirar lastModified, así que esa renovación
        // (precio, endTime, customTime, guestName...) nunca se copiaba al
        // otro dispositivo — la habitación se veía 'occupied' con el color
        // correcto en ambos lados, pero el precio se quedaba con el valor
        // viejo del lado que no hizo la renovación.
        if ((incoming.lastModified || 0) > (current.lastModified || 0)) {
            const preserved = { lastModified: resolved.lastModified, cleanedCount: resolved.cleanedCount,
                dirtyTimestamp: resolved.dirtyTimestamp, cleanedTimestamp: resolved.cleanedTimestamp,
                cleaningNotes: resolved.cleaningNotes };
            Object.assign(resolved, incoming, preserved);
        }
        return resolved;
    }

    const currentTime = roomStatusTimestamp(current);
    const incomingTime = roomStatusTimestamp(incoming);

    let winner;
    if (incomingTime > currentTime + TIME_TOLERANCE_MS) {
        winner = 'incoming';
    } else if (currentTime > incomingTime + TIME_TOLERANCE_MS) {
        winner = 'current';
    } else {
        // Cambios prácticamente simultáneos: desempatar por prioridad de negocio.
        const incomingPriority = ROOM_STATUS_PRIORITY[incoming.status] || 0;
        const currentPriority = ROOM_STATUS_PRIORITY[current.status] || 0;
        winner = incomingPriority > currentPriority ? 'incoming' : 'current';
    }

    if (winner === 'incoming') {
        const preserved = { lastModified: resolved.lastModified, cleanedCount: resolved.cleanedCount,
            dirtyTimestamp: resolved.dirtyTimestamp, cleanedTimestamp: resolved.cleanedTimestamp,
            cleaningNotes: resolved.cleaningNotes };
        Object.assign(resolved, incoming, preserved);
        logMergeConflict(current.id, 'status', current.status, incoming.status, 'incoming-wins');
    } else {
        logMergeConflict(current.id, 'status', incoming.status, current.status, 'current-wins');
    }

    return resolved;
}

export function persistMotelRoomsOnly() {
    safeLocalStorageSet('motelRooms', rooms);
    if (_appReady && window.FirebaseSync && window.FirebaseSync.ready) {
        try { window.FirebaseSync.save('motelRooms', rooms); } catch (e) {}
    }
}

export function ensureRoomsSanity() {
    let wasChanged = false;

    // Un arreglo VACÍO no es "corrupto" — es el estado normal antes de que
    // termine de cargar Firebase (loadData() solo trae lo que haya en
    // localStorage, y un dispositivo nuevo o con caché borrada no tiene
    // nada ahí todavía). init() llama a ensureRoomsSanity() de forma
    // síncrona, ANTES de que initFirebaseSync() (llamado al final de esa
    // misma función) tenga oportunidad de traer los datos reales. Antes,
    // esto se trataba igual que datos corruptos y se reemplazaba por la
    // plantilla de 32 habitaciones por defecto — un dispositivo nuevo veía
    // un parpadeo confuso de "todo disponible, sin huéspedes" antes de que
    // llegaran los datos reales unos segundos después. No llegaba a
    // subirse a Firebase (persistMotelRoomsOnly() está condicionado a
    // _appReady, que en este punto todavía es false), pero el parpadeo
    // visual era real y engañoso. Simplemente no hay nada que "reparar"
    // todavía — dejar que renderRooms() siga mostrando su placeholder de
    // "Cargando habitaciones…" hasta que los datos reales lleguen.
    if (Array.isArray(rooms) && rooms.length === 0) return;

    // Validación 1: Array válido
    if (!isValidRoomsArray(rooms)) {
        if (tryRepairRoomsFromIds(rooms)) {
            console.warn('[Data] Campo building corregido según id de habitación.');
            wasChanged = true;
        } else {
            console.error('[Data] Lista de habitaciones inválida; se restaura la plantilla inicial.');
            setRooms(createInitialRooms());
            wasChanged = true;
        }
        if (wasChanged) persistMotelRoomsOnly();
        return;
    }

    // Validación 2: Número correcto de habitaciones
    if (rooms.length !== EXPECTED_ROOM_COUNT) {
        console.error(`[Data] ⚠️ CRÍTICO: Se detectaron ${rooms.length} habitaciones, se esperaban ${EXPECTED_ROOM_COUNT}`);

        const initialRooms = createInitialRooms();
        const currentRoomIds = new Set(rooms.map(r => r.id));
        const missingRooms = initialRooms.filter(r => !currentRoomIds.has(r.id));

        if (missingRooms.length > 0) {
            console.warn(`[Data] Recuperando ${missingRooms.length} habitaciones faltantes:`, missingRooms.map(r => r.id));
            setRooms([...rooms, ...missingRooms]);
            rooms.sort((a, b) => {
                if (a.building !== b.building) return a.building === 'regulares' ? -1 : 1;
                return a.number - b.number;
            });
            wasChanged = true;
            console.log(`[Data] ✓ Habitaciones recuperadas. Total actual: ${rooms.length}`);
        } else {
            console.error('[Data] No se pudieron recuperar habitaciones. Restaurando plantilla completa.');
            setRooms(createInitialRooms());
            wasChanged = true;
        }
    }

    // Validación 3: Verificar que no haya duplicados
    const roomIds = rooms.map(r => r.id);
    const uniqueIds = new Set(roomIds);
    if (roomIds.length !== uniqueIds.size) {
        console.error('[Data] ⚠️ Se detectaron habitaciones duplicadas');
        const seen = new Map();
        setRooms(rooms.filter(room => {
            if (seen.has(room.id)) {
                const existing = seen.get(room.id);
                // roomStatusTimestamp() (ya usado en resolveRoomConflict)
                // elige el campo correcto según el status de cada lado y
                // corrige el reloj — un fallback crudo lastModified||checkInTime
                // podía quedarse con el duplicado 'available' viejo de un
                // dispositivo con el reloj atrasado sobre uno 'occupied' más
                // nuevo en la realidad.
                const existingTime = roomStatusTimestamp(existing);
                const currentTime = roomStatusTimestamp(room);
                if (currentTime > existingTime) {
                    seen.set(room.id, room);
                    return true;
                }
                return false;
            }
            seen.set(room.id, room);
            return true;
        }));
        wasChanged = true;
        console.log(`[Data] ✓ Duplicados eliminados. Total actual: ${rooms.length}`);
    }

    // Solo propagar a Firebase si hubo un cambio estructural real
    if (wasChanged) persistMotelRoomsOnly();
}

export function createInitialRooms() {
    const initialRooms = [];
    
    // Regulares building: rooms 1-16 with default prices and names
    const regularesPrices = {
        1: 350, 2: 350, 3: 350, 4: 350,
        5: 600, 6: 300, 7: 250, 8: 250,
        9: 250, 10: 250, 11: 300, 12: 600,
        13: 350, 14: 350, 15: 350, 16: 350
    };
    
    const regularesNames = {
        1: 'Sensual', 2: 'Sensual', 3: 'Sensual', 4: 'Sensual',
        5: 'VIP', 6: 'Ejecutiva', 7: 'Rapid Inn', 8: 'Rapid Inn',
        9: 'Rapid Inn', 10: 'Rapid Inn', 11: 'Ejecutiva', 12: 'VIP',
        13: 'Sensual', 14: 'Sensual', 15: 'Sensual', 16: 'Sensual'
    };
    
    for (let i = 1; i <= 16; i++) {
        initialRooms.push({
            id: `regulares-${i}`,
            number: i,
            status: 'available',
            checkInTime: null,
            building: 'regulares',
            roomName: regularesNames[i],
            defaultPrice: regularesPrices[i],
            defaultHours: (i === 5 || i === 12) ? 6 : 4,
            price: 0,
            customTime: null,
            guestName: '',
            guestCount: 0,
            notes: '',
            cleanedCount: 0
        });
    }
    
    // Torre Nueva building: rooms 1-16 with default prices, floors, and names
    const torrePrices = {
        1: 300, 2: 300, 3: 300, 4: 300,
        5: 300, 6: 300, 7: 300, 8: 300,
        9: 300, 10: 650, 11: 650, 12: 450,
        13: 450, 14: 650, 15: 650, 16: 300
    };
    
    // Piso 1: 7,6,8,5,1,4,2,3
    // Piso 2: 15,14,16,13,9,12,10,11
    const torreFloors = {
        1: 1, 2: 1, 3: 1, 4: 1,
        5: 1, 6: 1, 7: 1, 8: 1,
        9: 2, 10: 2, 11: 2, 12: 2,
        13: 2, 14: 2, 15: 2, 16: 2
    };
    
    const torreNames = {
        1: 'Rapid Inn', 2: 'Rapid Inn', 3: 'Rapid Inn', 4: 'Rapid Inn',
        5: 'Rapid Inn', 6: 'Rapid Inn', 7: 'Rapid Inn', 8: 'Rapid Inn',
        9: 'Rapid Inn', 10: 'Ejecutiva', 11: 'Ejecutiva', 12: 'VIP',
        13: 'VIP', 14: 'Ejecutiva', 15: 'Ejecutiva', 16: 'Rapid Inn'
    };
    
    for (let i = 1; i <= 16; i++) {
        initialRooms.push({
            id: `torre-${i}`,
            number: i,
            status: 'available',
            checkInTime: null,
            building: 'torre',
            floor: torreFloors[i],
            roomName: torreNames[i] || null,
            defaultPrice: torrePrices[i],
            defaultHours: (i === 12 || i === 13) ? 6 : 4,
            price: 0,
            customTime: null,
            guestName: '',
            guestCount: 0,
            notes: '',
            cleanedCount: 0
        });
    }
    return initialRooms;
}

export function migrateRoomNames() {
    console.log('[Rooms] Migrando nombres de habitaciones de Torre Nueva...');
    
    const torreNamesMap = {
        1: 'Rapid Inn', 2: 'Rapid Inn', 3: 'Rapid Inn', 4: 'Rapid Inn',
        5: 'Rapid Inn', 6: 'Rapid Inn', 7: 'Rapid Inn', 8: 'Rapid Inn',
        9: 'Rapid Inn', 10: 'Ejecutiva', 11: 'Ejecutiva', 12: 'VIP',
        13: 'VIP', 14: 'Ejecutiva', 15: 'Ejecutiva', 16: 'Rapid Inn'
    };
    
    let updated = false;
    
    rooms.forEach(room => {
        if (room.building === 'torre' && room.number >= 1 && room.number <= 16) {
            const newName = torreNamesMap[room.number];
            if (room.roomName !== newName) {
                console.log(`[Rooms] Actualizando habitación Torre ${room.number}: "${room.roomName || 'sin nombre'}" → "${newName}"`);
                room.roomName = newName;
                updated = true;
            }
        }
    });
    
    if (updated) {
        // Solo localStorage — no llamar saveData() aquí porque ocurre antes de
        // initFirebaseSync y subiría datos rancios a Firebase antes del merge
        localStorage.setItem('motelRooms', JSON.stringify(rooms));
        return true;
    } else {
        return false;
    }
}

export function shouldShowRoom(room) {
    // Filtro por número de Búsqueda
    if (searchRoomNumber !== null && room.number !== searchRoomNumber) {
        return false;
    }
    
    // Filtro por estado
    if (currentFilter === 'all') {
        return true;
    } else if (currentFilter === 'available') {
        return room.status === 'available';
    } else if (currentFilter === 'unavailable') {
        return room.status === 'occupied' || room.status === 'dirty' || 
               room.status === 'not-available' || room.status === 'reserved';
    }
    
    return true;
}

export function renderRooms() {
    // FIXED: Limpiar cache de elementos DOM al inicio (Problem 4b)
    roomTimerElements.clear();
    
    // Guard: si el usuario es limpieza, usar vista de limpieza
    if (currentUser && currentUser.role === 'limpieza') {
        if (document.getElementById('cleaningRoomsGrid')) {
            renderCleaningRooms();
        } else {
            showCleaningView();
        }
        return;
    }
    const grid = document.getElementById('roomsGrid');
    if (!grid) {
        console.error('roomsGrid no encontrado en el DOM');
        return;
    }
    // rooms vacío es "todavía no cargó", no "corrupto" — ensureRoomsSanity()
    // ya lo ignora, pero evitamos incluso la llamada para dejar claro que
    // no hay nada que reparar mientras se espera a Firebase.
    if (rooms && rooms.length > 0 && !isValidRoomsArray(rooms)) {
        ensureRoomsSanity();
    }
    if (!rooms || rooms.length === 0) {
        grid.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:#7f8c8d;">
                <div style="font-size:40px;margin-bottom:14px;animation:spin 1.5s linear infinite;display:inline-block;">&#8635;</div>
                <p style="font-size:17px;font-weight:600;color:#5a6a8a;margin-bottom:6px;">Cargando habitaciones&hellip;</p>
                <p style="font-size:13px;">Sincronizando con Firebase, un momento.</p>
            </div>`;
        return;
    }

    grid.innerHTML = '';
    
    const buildingsContainer = document.createElement('div');
    buildingsContainer.className = 'buildings-container';
    
    // Regulares building (rooms 1-16)
    const regularesSection = document.createElement('div');
    regularesSection.className = 'building-section';
    regularesSection.innerHTML = '<h2 class="building-title">Edificio 1</h2>';
    const regularesGrid = document.createElement('div');
    regularesGrid.className = 'building-grid';
    
    const layout = [
        [8, 9],
        [7, 10],
        [6, 11],
        [5, 12],
        [4, 13],
        [3, 14],
        [2, 15],
        [1, 16]
    ];
    
    layout.forEach(row => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'room-row';
        row.forEach(roomNum => {
            const room = rooms.find(r => r.number === roomNum && r.building === 'regulares');
            if (room && shouldShowRoom(room)) {
                const card = createRoomCard(room);
                rowDiv.appendChild(card);
            }
        });
        if (rowDiv.children.length > 0) {
            regularesGrid.appendChild(rowDiv);
        }
    });
    
    regularesSection.appendChild(regularesGrid);
    buildingsContainer.appendChild(regularesSection);
    
    // Torre Nueva building (rooms 1-16) organized by floors
    const torreSection = document.createElement('div');
    torreSection.className = 'building-section';
    torreSection.innerHTML = '<h2 class="building-title">Edificio Torre</h2>';
    const torreGrid = document.createElement('div');
    torreGrid.className = 'building-grid';
    
    // Piso 1 with custom order: 7,6,8,5,1,4,2,3
    const piso1Title = document.createElement('h3');
    piso1Title.className = 'floor-title';
    piso1Title.textContent = 'Piso 1';
    torreGrid.appendChild(piso1Title);
    
    const piso1Layout = [
        [7, 6],
        [8, 5],
        [1, 4],
        [2, 3]
    ];
    
    piso1Layout.forEach(row => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'room-row';
        row.forEach(roomNum => {
            const room = rooms.find(r => r.number === roomNum && r.building === 'torre');
            if (room && shouldShowRoom(room)) {
                const card = createRoomCard(room);
                rowDiv.appendChild(card);
            }
        });
        if (rowDiv.children.length > 0) {
            torreGrid.appendChild(rowDiv);
        }
    });
    
    // Piso 2 with custom order: 15,14,16,13,9,12,10,11
    const piso2Title = document.createElement('h3');
    piso2Title.className = 'floor-title';
    piso2Title.textContent = 'Piso 2';
    torreGrid.appendChild(piso2Title);
    
    const piso2Layout = [
        [15, 14],
        [16, 13],
        [9, 12],
        [10, 11]
    ];
    
    piso2Layout.forEach(row => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'room-row';
        row.forEach(roomNum => {
            const room = rooms.find(r => r.number === roomNum && r.building === 'torre');
            if (room && shouldShowRoom(room)) {
                const card = createRoomCard(room);
                rowDiv.appendChild(card);
            }
        });
        if (rowDiv.children.length > 0) {
            torreGrid.appendChild(rowDiv);
        }
    });
    
    torreSection.appendChild(torreGrid);
    buildingsContainer.appendChild(torreSection);
    
    grid.appendChild(buildingsContainer);
    updateRoomTimers();
    
    // Renderizar notas recientes en el sidebar
    renderRecentCleaningNotes();
}

export function createRoomCard(room) {
    const card = document.createElement('div');
    
    // Determinar el estado visual para habitaciones reservadas
    let cardClass = room.status;
    let statusText = '';
    
    if (room.status === 'reserved') {
        const isLocked = isRoomReservationLocked(room);
        if (!isLocked) {
            // Reserva no bloqueada (falta más de 12 horas)
            cardClass = 'reserved-not-locked';
            statusText = 'RESERVADO (NO BLOQUEADO)';
        } else {
            // Reserva bloqueada (falta 12 horas o menos)
            cardClass = 'reserved-locked';
            statusText = 'RESERVADO (BLOQUEADO)';
        }
    }
    
    card.className = `room-card ${cardClass}`;
    if (roomHasPendingDeepClean(room)) card.classList.add('room-card--deep-clean-pending');

    // Traducir estados
    const statusTranslations = {
        'available': 'DISPONIBLE',
        'occupied': 'OCUPADO',
        'dirty': 'SUCIO',
        'not-available': 'NO DISPONIBLE',
        'reserved': 'RESERVADO'
    };

    // Usar el texto de estado personalizado para reservas, o el traductor por defecto
    const finalStatusText = statusText || statusTranslations[room.status] || room.status;

    // Calcular tiempo restante si está ocupado
    let timeDisplay = '';
    if (room.status === 'occupied' && room.endTime) {
        timeDisplay = `<div class="room-time" id="countdown-${room.id}"></div>`;
    } else if (room.checkInTime) {
        timeDisplay = `<div class="room-time" id="timer-${room.id}"></div>`;
    }

    // Mostrar horas en lugar de precio cuando está ocupado
    let priceDisplay = '';
    if (room.status === 'occupied') {
        const hours = room.customTime !== null ? room.customTime : room.defaultHours;
        priceDisplay = `<div class="room-price">${hours}h</div>`;
    } else if (room.price > 0) {
        const p = Number(room.price);
        priceDisplay = `<div class="room-price">$${Number.isFinite(p) ? p.toFixed(2) : '0.00'}</div>`;
    } else {
        priceDisplay = `<div class="room-default-price">$${room.defaultPrice}</div>`;
    }

    // Display room name for rooms that have one
    let roomNameDisplay = '';
    if (room.roomName) {
        roomNameDisplay = `<div class="room-name">${room.roomName}</div>`;
    }

    const deepPendingBadge = roomHasPendingDeepClean(room)
        ? '<span class="room-deep-clean-pending-badge" title="Limpieza profunda pendiente">Pendiente LP</span>'
        : '';

    card.innerHTML = `
        ${deepPendingBadge}
        <div class="room-number">${room.number}</div>
        ${roomNameDisplay}
        <div class="room-status">${finalStatusText}</div>
        ${timeDisplay}
        ${priceDisplay}
    `;
    
    // FIXED: Cachear elementos del DOM después de crearlos (Problem 4b)
    setTimeout(() => {
        if (room.status === 'occupied' && room.endTime) {
            const countdownEl = document.getElementById(`countdown-${room.id}`);
            if (countdownEl) {
                roomTimerElements.set(`countdown-${room.id}`, countdownEl);
            }
        } else if (room.checkInTime) {
            const timerEl = document.getElementById(`timer-${room.id}`);
            if (timerEl) {
                roomTimerElements.set(`timer-${room.id}`, timerEl);
            }
        }
    }, 0);
    
    card.addEventListener('click', () => {
        openRoomModal(room.id);
    });
    
    // Agregar data attribute para debugging
    card.dataset.roomId = room.id;
    card.dataset.roomNumber = room.number;
    return card;
}

export function openRoomModal(roomId) {
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;
    const modal = document.getElementById('roomModal');
    setCurrentRoomId(roomId);
    const modalRoomNumberEl = document.getElementById('modalRoomNumber');
    if (modalRoomNumberEl) modalRoomNumberEl.textContent = `${room.number} (${room.building === 'regulares' ? 'Regulares' : 'Torre Nueva'})`;
    
    const details = document.getElementById('roomDetails');
    
    // Si la habitación está reservada Y bloqueada (menos de 12 horas), mostrar solo botón de confirmar uso
    if (room.status === 'reserved') {
        const isLocked = isRoomReservationLocked(room);
        
        // Solo mostrar modal especial si está BLOQUEADA
        if (isLocked) {
            const reservation = reservations.find(r => r.id === room.reservationId);
            
            details.innerHTML = `
            <div style="text-align: center; padding: 20px;">
                <div style="font-size: 48px; margin-bottom: 20px;">📌</div>
                <h3 style="color: #27ae60; margin-bottom: 15px;">Habitación Reservada (Bloqueada)</h3>
                <p><strong>Estado:</strong> ${translateStatus(room.status)}</p>
                ${reservation ? `
                    <p><strong>Huésped:</strong> ${sanitizeHTML(reservation.guestName || 'Sin nombre')}</p>
                    <p><strong>Teléfono:</strong> ${sanitizeHTML(reservation.phone || 'Sin teléfono')}</p>
                    <p><strong>Precio:</strong> $${reservation.price || room.defaultPrice}</p>
                    <p><strong>Horas:</strong> ${reservation.hours || 'No especificado'}</p>
                ` : ''}
                <div style="background: #fff3cd; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
                    <strong>⚠️ Reserva Activa</strong>
                    <p style="margin: 10px 0 0 0; font-size: 14px;">Esta habitación está bloqueada por una reserva. Solo puedes confirmar el inicio de uso.</p>
                </div>
                <div style="text-align: left; margin-bottom: 20px;">
                    <label style="display: block; font-weight: bold; color: #27ae60; margin-bottom: 8px;">💳 Confirmar Método de Pago: <span style="color: #e74c3c;">*</span></label>
                    <select id="reservationStartPaymentMethod" style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 8px; font-size: 16px; background: white;">
                        <option value="">Seleccionar Método de pago</option>
                        <option value="efectivo" ${(reservation && reservation.paymentMethod === 'efectivo') ? 'selected' : ''}>💵 Efectivo</option>
                        <option value="tarjeta" ${(reservation && reservation.paymentMethod === 'tarjeta') ? 'selected' : ''}>💳 Tarjeta</option>
                    </select>
                </div>
                <button class="btn-primary" style="background: #27ae60; font-size: 16px; padding: 15px 30px;" onclick="confirmReservationStart()">
                    ✓ Confirmar Uso de Habitación en Reserva
                </button>
            </div>
        `;
        
        // Ocultar botones de acción
        const modalActions = document.getElementById('modalActions');
        if (modalActions) modalActions.style.display = 'none';
        
        modal.classList.add('show');
        return;
        }
        // Si NO está bloqueada, continuar con el flujo normal
    }
    
    // Mostrar botón de renovación solo si está ocupada
    const renewalSection = room.status === 'occupied' ? `
        <div class="renewal-section">
            <h3 style="color: #27ae60; margin-top: 20px;">Renovar Estancia</h3>
            <input type="number" id="renewalPrice" placeholder="Precio de renovación" step="0.01" min="0">
            <input type="number" id="renewalTime" placeholder="Horas Adicionales" min="1">
            <div class="payment-method-selector" style="margin: 20px 0;">
                <label style="display: block; margin-bottom: 10px; font-weight: bold; color: #27ae60; font-size: 16px;">💳 Método de Pago: <span style="color: #e74c3c;">*</span></label>
                <select id="renewalPaymentMethod" style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 8px; font-size: 16px; background: white;">
                    <option value="">Seleccionar Método de pago</option>
                    <option value="efectivo">💵 Efectivo</option>
                    <option value="tarjeta">💳 Tarjeta</option>
                </select>
            </div>
            <button class="btn-primary" onclick="renewStay()">Agregar Tiempo y Cobrar</button>
        </div>
    ` : '';
    
    details.innerHTML = `
        <p><strong>Estado:</strong> ${translateStatus(room.status)}</p>
        ${room.checkInTime ? `<p><strong>Tiempo Transcurrido:</strong> ${getElapsedTime(room.checkInTime)}</p>` : ''}
        ${room.endTime ? `<p><strong>Tiempo Restante:</strong> <span id="modal-countdown"></span></p>` : ''}
        <p><strong>Precio estándar:</strong> $${room.defaultPrice}</p>
        ${room.price > 0 ? `<p><strong>Precio Actual:</strong> $${room.price.toFixed(2)}</p>` : ''}
        ${room.guestName ? `<p><strong>Huésped:</strong> ${sanitizeHTML(room.guestName)}</p>` : ''}
        ${room.notes ? `<p><strong>Notas:</strong> ${sanitizeHTML(room.notes)}</p>` : ''}
        ${renewalSection}
        <div class="room-form" style="${room.status === 'occupied' ? 'display: none;' : ''}">
            <input type="text" id="guestNameInput" placeholder="Nombre del Huésped (opcional)" value="${escapeAttr(room.guestName || '')}">
            <input type="number" id="guestCountInput" placeholder="Número de Personas" min="1" max="10" value="${room.guestCount || ''}" style="margin-top: 10px;">
            <div class="payment-method-selector" style="margin: 20px 0;">
                <label style="display: block; margin-bottom: 10px; font-weight: bold; color: #2c3e50; font-size: 16px;">💳 Método de Pago: <span style="color: #e74c3c;">*</span></label>
                <select id="paymentMethodInput" style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 8px; font-size: 16px; background: white;">
                    <option value="">Seleccionar Método de pago</option>
                    <option value="efectivo">💵 Efectivo</option>
                    <option value="tarjeta">💳 Tarjeta</option>
                </select>
            </div>
            <button class="btn-primary" onclick="useDefaultPrice()">Usar Precio estándar ($${room.defaultPrice})</button>
            <button class="btn-primary" onclick="showCustomPricing()">Precio y Tiempo Personalizado</button>
            <div id="customPricingForm" style="display: none;">
                <input type="number" id="customPriceInput" placeholder="Precio Personalizado" step="0.01" min="0">
                <input type="number" id="customTimeInput" placeholder="Tiempo (horas)" min="1">
            </div>
            <textarea id="notesInput" placeholder="Notas (opcional)">${sanitizeHTML(room.notes || '')}</textarea>
        </div>
    `;
    
    // Actualizar countdown en el modal si está ocupada
    if (room.status === 'occupied' && room.endTime) {
        updateModalCountdown(room);
    }
    
    // Aplicar permisos a los botones del modal
    const modalActions = document.getElementById('modalActions');
    
    // Ocultar todos los botones de acción solo si la habitación está reservada Y bloqueada
    if (room.status === 'reserved' && isRoomReservationLocked(room)) {
        if (modalActions) modalActions.style.display = 'none';
    } else {
        if (modalActions) modalActions.style.display = 'flex';
        
        if (currentUser) {
            document.querySelectorAll('#modalActions .btn').forEach(btn => {
                const allowedRoles = btn.dataset.roles ? btn.dataset.roles.split(',') : ['supervisor'];
                if (allowedRoles.includes(currentUser.role)) {
                    btn.style.display = 'inline-block';
                } else {
                    btn.style.display = 'none';
                }
            });
        }
    }
    
    modal.classList.add('show');
}

export function updateModalCountdown(room) {
    const modalCountdown = document.getElementById('modal-countdown');
    if (modalCountdown && room.endTime) {
        const remaining = room.endTime - Date.now();
        if (remaining > 0) {
            const hours = Math.floor(remaining / 3600000);
            const minutes = Math.floor((remaining % 3600000) / 60000);
            modalCountdown.textContent = `${hours}h ${minutes}m`;
            modalCountdown.style.color = remaining < 1800000 ? '#ff0000' : '#27ae60';
        } else {
            modalCountdown.textContent = '⚠️ TIEMPO EXCEDIDO!';
            modalCountdown.style.color = '#ff0000';
        }
    }
}

export function renewStay() {
    const room = rooms.find(r => r.id === currentRoomId);
    if (!room || room.status !== 'occupied') {
        showToast('Habitación no válida para renovación', 'error');
        return;
    }
    const renewalPrice = parseFloat(document.getElementById('renewalPrice').value);
    const renewalTime = parseInt(document.getElementById('renewalTime').value);
    
    if (!renewalPrice || renewalPrice <= 0) {
        showToast('Por favor ingresa un precio válido', 'error');
        return;
    }
    
    if (!renewalTime || renewalTime <= 0) {
        showToast('Por favor ingresa las horas adicionales', 'error');
        return;
    }
    
    // Validar Método de pago
    const paymentMethod = validatePaymentMethod('renewalPaymentMethod', 'Por favor selecciona un Método de pago');
    if (!paymentMethod) return;

    if (!room.endTime) {
        const hoursToAdd = room.customTime != null ? room.customTime : room.defaultHours;
        room.endTime = (room.checkInTime || Date.now()) + hoursToAdd * 60 * 60 * 1000;
    }
    
    // Agregar tiempo al endTime existente
    const additionalTime = renewalTime * 60 * 60 * 1000;
    room.endTime = room.endTime + additionalTime;

    // Sumar el precio de renovación al precio actual de la habitación
    room.price = room.price + renewalPrice;
    room.lastModified = _roomSyncNow(); // Garantiza que la renovación prevalezca en merges con Firebase
    
    // Registrar el ingreso adicional
    const renewalTs = Date.now();
    roomRevenue.push({
        id: renewalTs,
        roomId: room.id,
        roomNumber: room.number,
        building: room.building,
        guestName: room.guestName,
        price: renewalPrice,
        customTime: renewalTime,
        checkInTime: renewalTs,
        timestamp: renewalTs,
        type: 'renewal',
        shift: getCurrentShift().type,
        shiftName: getCurrentShift().name,
        originalCheckIn: room.checkInTime,
        paymentMethod: paymentMethod
    });
    invalidateRevenueIndex();
    
    // Agregar automáticamente a movimientos según método de pago
    addSaleToMovements({
        id: Date.now(),
        roomId: room.id,
        roomNumber: room.number,
        building: room.building,
        guestName: room.guestName,
        price: renewalPrice,
        timestamp: Date.now(),
        type: 'renewal',
        paymentMethod: paymentMethod
    });
    
    // Limpiar campos
    document.getElementById('renewalPrice').value = '';
    document.getElementById('renewalTime').value = '';
    
    // _saveDataImmediate() en vez de saveData(): una renovación es dinero
    // nuevo — debe reflejarse al instante en los demás dispositivos, no
    // esperar el throttle de 2s.
    _saveDataImmediate();
    renderRooms();

    showToast(`renovación registrada: +${renewalTime} horas - $${renewalPrice.toFixed(2)} agregado`, 'success');
    
    // Actualizar el modal
    openRoomModal(currentRoomId);
}

export function validatePaymentMethod(elementId, errorMsg = 'Por favor selecciona un método de pago') {
    const element = document.getElementById(elementId);
    const value = element ? element.value : '';
    if (!value) {
        showToast(errorMsg, 'error');
        return false;
    }
    return value;
}

export function validateRequired(value, fieldName) {
    if (!value || (typeof value === 'string' && value.trim() === '')) {
        showToast(`Por favor ingresa ${fieldName}`, 'error');
        return false;
    }
    return true;
}

export function validatePositiveNumber(value, fieldName) {
    const num = parseFloat(value);
    if (!num || num <= 0 || isNaN(num)) {
        showToast(`Por favor ingresa un ${fieldName} válido`, 'error');
        return false;
    }
    return num;
}

export function useDefaultPrice() {
    const room = rooms.find(r => r.id === currentRoomId);
    if (!room) return;
    room.price = room.defaultPrice;
    room.customTime = null; // Usar tiempo por defecto de la habitación
    
    // Guardar y cerrar modal
    saveData();
    
    // Marcar como ocupado automáticamente
    updateRoomStatus(currentRoomId, 'occupied');
}

export function showCustomPricing() {
    document.getElementById('customPricingForm').style.display = 'block';
}

export function updateRoomStatus(roomId, status) {
    const room = rooms.find(r => r.id === roomId);
    if (!room) {
        showToast('Habitación no encontrada', 'error');
        return;
    }

    // Bloquear cambio si tiene reserva activa (excepto si se está marcando como ocupado desde la reserva)
    if (room.status === 'reserved' && status !== 'occupied') {
        showToast('Esta habitación está reservada y no se puede cambiar de estado', 'error');
        return;
    }
    
    // GUARDAR ESTADO ORIGINAL COMPLETO antes de cualquier modificación
    const originalState = {
        status: room.status,
        guestName: room.guestName,
        guestCount: room.guestCount,
        notes: room.notes,
        price: room.price,
        customTime: room.customTime,
        paymentMethod: room.paymentMethod
    };
    
    // First, save any details that were entered
    const guestInput = document.getElementById('guestNameInput');
    const guestCountInput = document.getElementById('guestCountInput');
    const customPriceInput = document.getElementById('customPriceInput');
    const customTimeInput = document.getElementById('customTimeInput');
    const notesInput = document.getElementById('notesInput');
    const paymentMethodInput = document.getElementById('paymentMethodInput');
    
    if (guestInput) room.guestName = guestInput.value;
    if (guestCountInput) room.guestCount = parseInt(guestCountInput.value) || 0;
    if (notesInput) room.notes = notesInput.value;
    
    // Handle custom pricing and time
    if (customPriceInput && customPriceInput.value) {
        const customPrice = parseFloat(customPriceInput.value);
        const customTime = parseInt(customTimeInput.value);
        
        // Validación de precio
        if (customPrice <= 0) {
            showToast('El precio debe ser mayor a $0', 'error');
            // REVERTIR TODO EL ESTADO
            Object.assign(room, originalState);
            return;
        }
        
        // Validación de tiempo mínimo 4 horas
        if (customTime && customTime < 4) {
            showToast('El tiempo mínimo es de 4 horas', 'error');
            // REVERTIR TODO EL ESTADO
            Object.assign(room, originalState);
            return;
        }
        
        room.price = customPrice;
        room.customTime = customTime || null;
    } else if (room.price === 0) {
        room.price = room.defaultPrice;
        room.customTime = null; // No usar tiempo personalizado si no se especificó
    }
    
    const oldStatus = room.status;
    room.status = status;
    room.lastModified = _roomSyncNow(); // Timestamp para merge inteligente
    
    if (status === 'occupied') {
        // Validar Método de pago
        const paymentMethod = validatePaymentMethod('paymentMethodInput', 'Por favor selecciona un Método de pago');
        if (!paymentMethod) {
            // REVERTIR TODO EL ESTADO
            Object.assign(room, originalState);
            return;
        }
        
        room.checkInTime = _roomSyncNow();

        // Set end time based on custom or default hours
        const hoursToAdd = room.customTime !== null ? room.customTime : room.defaultHours;
        room.endTime = room.checkInTime + (hoursToAdd * 60 * 60 * 1000);
        
        // Immediately record revenue when marking as occupied
        if (room.price > 0) {
            // Usar el paymentMethod ya validado arriba (no redeclarar)
            const checkinTs = Date.now();
            roomRevenue.push({
                id: checkinTs,
                roomId: room.id,
                roomNumber: room.number,
                building: room.building,
                guestName: room.guestName,
                price: room.price,
                customTime: room.customTime !== null ? room.customTime : room.defaultHours,
                checkInTime: room.checkInTime,
                endTime: room.endTime,
                timestamp: checkinTs,
                type: 'sold',
                shift: getCurrentShift().type,
                shiftName: getCurrentShift().name,
                paymentMethod: paymentMethod
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
        }
    } else if (status === 'dirty') {
        // Guardar timestamp cuando se marca como sucia
        room.dirtyTimestamp = _roomSyncNow();
        room.lastModified = _roomSyncNow(); // Para sincronización correcta
    } else if (status === 'available' || status === 'not-available') {
        // NO registrar limpieza automáticamente aquí - solo se registra en confirmCleanRoom
        // Track if room was cleaned (solo para contador interno)
        if (oldStatus === 'dirty' && status === 'available') {
            room.cleanedCount++;
        }
        room.checkInTime = null;
        room.endTime = null;
        room.guestName = '';
        room.guestCount = 0;
        room.price = 0;
        room.notes = '';
        room.customTime = null;
        room.paymentMethod = null;
    }

    // _saveDataImmediate() en vez de saveData(): este es el cambio de
    // status principal (vender/ocupar, marcar sucia, liberar) — incluye el
    // cobro cuando status pasa a 'occupied'. No debe esperar el throttle de
    // 2s; el empleado en el otro dispositivo tiene que ver el cambio de
    // inmediato, no unos segundos después.
    _saveDataImmediate();

    // Renderizar según el rol activo
    if (currentUser && currentUser.role === 'limpieza') {
        renderCleaningRooms();
    } else {
        // Actualizar vista para admin/staff
        renderRooms();
    }
    
    // Refrescar modal de actividad si está abierto
    const _actM = document.getElementById('roomsActivityModal');
    if (_actM && _actM.classList.contains('show')) renderRoomsActivity();
    
    // Registrar actividad (deshabilitado)
    // logActivity('rooms', `habitación ${room.number} marcada como ${translateStatus(status)}`, {
    //     roomId: room.id,
    //     roomNumber: room.number,
    //     oldStatus,
    //     newStatus: status
    // });
    
    // Mostrar notificación toast
    const statusText = translateStatus(status);
    showToast(`habitación ${room.number} marcada como ${statusText}`, 'success');
    
    document.getElementById('roomModal').classList.remove('show');
}

export function updateRoomTimers() {
    rooms.forEach(room => {
        if (room.checkInTime) {
            // Si tiene endTime, mostrar cuenta regresiva
            if (room.endTime) {
                const countdownEl = roomTimerElements.get(`countdown-${room.id}`);
                if (countdownEl) {
                    const remaining = room.endTime - Date.now();
                    if (remaining > 0) {
                        const hours = Math.floor(remaining / 3600000);
                        const minutes = Math.floor((remaining % 3600000) / 60000);
                        countdownEl.textContent = `${hours}h ${minutes}m restantes`;

                        // Cambiar color si queda menos de 30 minutos
                        if (remaining < 1800000) { // 30 minutos
                            countdownEl.style.color = '#ff0000';
                            countdownEl.style.fontWeight = 'bold';
                        }
                    } else {
                        countdownEl.textContent = '⚠️ TIEMPO EXCEDIDO!';
                        countdownEl.style.color = '#ff0000';
                        countdownEl.style.fontWeight = 'bold';
                    }
                }
            } else {
                // Mostrar tiempo transcurrido (para habitaciones sin endTime configurado)
                const timerEl = roomTimerElements.get(`timer-${room.id}`);
                if (timerEl) {
                    timerEl.textContent = getElapsedTime(room.checkInTime);
                }
            }
        }
    });
}

export function openRevenueDetail(type) {
    setCurrentRevenueType(type);
    setCurrentRevenueFilter('all');
    const modal = document.getElementById('revenueDetailModal');
    const titles = { rooms: '🏠 Desglose de Habitaciones', sales: '🛒 Desglose de Ventas', expenses: '💸 Desglose de Egresos' };
    document.getElementById('revenueDetailTitle').textContent = titles[type] || 'Desglose';
    document.querySelectorAll('#revenueDetailModal .filter-btn').forEach(b => b.classList.remove('active'));
    const firstBtn = document.querySelector('#revenueDetailModal .filter-btn');
    if (firstBtn) firstBtn.classList.add('active');
    renderRevenueDetail();
    modal.classList.add('show');
}

export function closeRevenueDetailModal() {
    document.getElementById('revenueDetailModal').classList.remove('show');
}

export function filterRevenueDetail(filter) {
    setCurrentRevenueFilter(filter);
    document.querySelectorAll('#revenueDetailModal .filter-btn').forEach(b => b.classList.remove('active'));
    if (event && event.target) event.target.classList.add('active');
    renderRevenueDetail();
}

export function renderRevenueDetail() {
    const container = document.getElementById('revenueDetailList');
    let data = [];
    if (currentRevenueType === 'rooms') data = roomRevenue.filter(r => r.type === 'sold');
    else if (currentRevenueType === 'sales') data = [...sales];
    else if (currentRevenueType === 'expenses') data = [...expenses];

    if (currentRevenueFilter !== 'all') data = data.filter(item => item.shift === currentRevenueFilter);
    data.sort((a, b) => b.timestamp - a.timestamp);

    let total = 0;
    if (currentRevenueType === 'rooms') total = data.reduce((s, i) => s + i.price, 0);
    else if (currentRevenueType === 'sales') total = data.reduce((s, i) => s + i.total, 0);
    else total = data.reduce((s, i) => s + i.amount, 0);

    document.getElementById('detailTotalAmount').textContent = '$' + total.toFixed(2);
    document.getElementById('detailTotalCount').textContent = data.length + ' transacciones';

    if (data.length === 0) { container.innerHTML = '<div class="no-detail-data">No hay datos para mostrar</div>'; return; }

    container.innerHTML = data.map(item => {
        const date = new Date(item.timestamp);
        const dateStr = date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
        const timeStr = date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
        const shiftName = item.shiftName || (item.shift === 'day' ? 'Turno Día' : 'Turno Noche');
        if (currentRevenueType === 'rooms') {
            return `<div class="revenue-detail-item">
                <div class="revenue-detail-item-info">
                    <div class="revenue-detail-item-header"><span class="revenue-detail-icon">🏠</span><span class="revenue-detail-title">Hab. ${item.roomNumber}</span><span class="revenue-detail-shift-badge ${item.shift}">${sanitizeHTML(shiftName)}</span></div>
                    <div class="revenue-detail-meta"><span>${item.building === 'regulares' ? 'Edificio 1' : 'Torre'}</span><span>${dateStr} ${timeStr}</span>${item.guestName ? `<span>${sanitizeHTML(item.guestName)}</span>` : ''}</div>
                </div>
                <div class="revenue-detail-amount">$${item.price.toFixed(2)}</div>
            </div>`;
        } else if (currentRevenueType === 'sales') {
            return `<div class="revenue-detail-item">
                <div class="revenue-detail-item-info">
                    <div class="revenue-detail-item-header"><span class="revenue-detail-icon">🛒</span><span class="revenue-detail-title">${sanitizeHTML(item.productName)}</span><span class="revenue-detail-shift-badge ${item.shift}">${sanitizeHTML(shiftName)}</span></div>
                    <div class="revenue-detail-meta"><span>x${item.quantity}</span><span>$${item.price ? item.price.toFixed(2) : '0.00'} c/u</span><span>${dateStr} ${timeStr}</span></div>
                </div>
                <div class="revenue-detail-amount">$${item.total.toFixed(2)}</div>
            </div>`;
        } else {
            return `<div class="revenue-detail-item expense">
                <div class="revenue-detail-item-info">
                    <div class="revenue-detail-item-header"><span class="revenue-detail-icon">💸</span><span class="revenue-detail-title">${sanitizeHTML(item.description)}</span><span class="revenue-detail-shift-badge ${item.shift}">${sanitizeHTML(shiftName)}</span></div>
                    <div class="revenue-detail-meta"><span>${sanitizeHTML(item.categoryType || '')}</span><span>${dateStr} ${timeStr}</span></div>
                </div>
                <div class="revenue-detail-amount">$${item.amount.toFixed(2)}</div>
            </div>`;
        }
    }).join('');
}

export function openRoomsActivityModal() {
    setCurrentRoomsActivityFilter('current');
    const modal = document.getElementById('roomsActivityModal');
    modal.classList.add('show');
    document.querySelectorAll('#roomsActivityModal .filter-btn').forEach(b => b.classList.remove('active'));
    const firstBtn = document.querySelector('#roomsActivityModal .filter-btn');
    if (firstBtn) firstBtn.classList.add('active');
    // Cargar desde Firebase si roomRevenue está vacío
    if (roomRevenue.length === 0 && window.FirebaseSync && window.FirebaseSync.ready) {
        const container = document.getElementById('roomsActivityList');
        if (container) container.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">Cargando datos...</div>';
        Promise.all([
            _loadHotShardsFromFirebase(),
            window.FirebaseSync.load('motelRooms', null)
        ]).then(([, motelRooms]) => {
            if (motelRooms) setRooms(motelRooms);
            renderRoomsActivity();
        });
    } else {
        renderRoomsActivity();
    }
}

export function closeRoomsActivityModal() {
    document.getElementById('roomsActivityModal').classList.remove('show');
}

export function filterRoomsActivity(filter) {
    setCurrentRoomsActivityFilter(filter);
    document.querySelectorAll('#roomsActivityModal .filter-btn').forEach(b => b.classList.remove('active'));
    if (event && event.target) event.target.classList.add('active');
    renderRoomsActivity();
}

export function renderRoomsActivity() {
    const container = document.getElementById('roomsActivityList');
    if (!container) return;
    const shift = getCurrentShift();
    let roomsData = [], title = '', count = 0;

    if (currentRoomsActivityFilter === 'current') {
        const soldInShift = roomRevenue.filter(r => r.type === 'sold' && r.timestamp >= Date.now() - 24*60*60*1000);
        const cleanedInShift = roomRevenue.filter(r => r.type === 'cleaned' && r.timestamp >= Date.now() - 24*60*60*1000);
        const roomsMap = {};
        soldInShift.forEach(sale => {
            const key = `${sale.building}-${sale.roomNumber}`;
            if (!roomsMap[key]) roomsMap[key] = { roomNumber: sale.roomNumber, building: sale.building, sales: [], cleanings: [] };
            roomsMap[key].sales.push(sale);
        });
        cleanedInShift.forEach(clean => {
            const key = `${clean.building}-${clean.roomNumber}`;
            if (!roomsMap[key]) roomsMap[key] = { roomNumber: clean.roomNumber, building: clean.building, sales: [], cleanings: [] };
            roomsMap[key].cleanings.push(clean);
        });
        Object.values(roomsMap).forEach(rd => {
            const room = rooms.find(r => r.number === rd.roomNumber && r.building === rd.building);
            rd.currentStatus = room ? room.status : 'unknown';
        });
        roomsData = Object.values(roomsMap);
        title = 'Turno Actual';
    } else if (currentRoomsActivityFilter === 'previous') {
        const prevType = shift.type === 'day' ? 'night' : 'day';
        const soldPrev = roomRevenue.filter(r => r.shift === prevType && r.type === 'sold');
        const cleanedPrev = roomRevenue.filter(r => r.shift === prevType && r.type === 'cleaned');
        const roomsMap = {};
        soldPrev.forEach(sale => {
            const key = `${sale.building}-${sale.roomNumber}`;
            if (!roomsMap[key]) roomsMap[key] = { roomNumber: sale.roomNumber, building: sale.building, sales: [], cleanings: [] };
            roomsMap[key].sales.push(sale);
        });
        cleanedPrev.forEach(clean => {
            const key = `${clean.building}-${clean.roomNumber}`;
            if (!roomsMap[key]) roomsMap[key] = { roomNumber: clean.roomNumber, building: clean.building, sales: [], cleanings: [] };
            roomsMap[key].cleanings.push(clean);
        });
        Object.values(roomsMap).forEach(rd => {
            const room = rooms.find(r => r.number === rd.roomNumber && r.building === rd.building);
            rd.currentStatus = room ? room.status : 'unknown';
        });
        roomsData = Object.values(roomsMap);
        title = 'Turno Anterior';
    } else if (currentRoomsActivityFilter === 'dirty') {
        roomsData = rooms.filter(r => r.status === 'dirty').map(r => ({
            roomNumber: r.number, building: r.building, currentStatus: 'dirty', sales: [], cleanings: [], isDirty: true
        }));
        title = 'Habitaciones Sucias';
    }

    count = roomsData.length;
    const labelEl = document.getElementById('roomsActivityLabel');
    const countEl = document.getElementById('roomsActivityCount');
    const subtitleEl = document.getElementById('roomsActivitySubtitle');
    if (labelEl) labelEl.textContent = title;
    if (countEl) countEl.textContent = count;
    if (subtitleEl) subtitleEl.textContent = 'habitaciones';

    if (roomsData.length === 0) { container.innerHTML = '<div class="no-detail-data">No hay habitaciones para mostrar</div>'; return; }

    container.innerHTML = roomsData.map(rd => {
        let statusBadge = '';
        if (rd.currentStatus === 'dirty') statusBadge = '<span style="background:#e74c3c;color:white;padding:3px 8px;border-radius:10px;font-size:11px;font-weight:600;">🧹 Sucia</span>';
        else if (rd.currentStatus === 'available') statusBadge = '<span style="background:#27ae60;color:white;padding:3px 8px;border-radius:10px;font-size:11px;font-weight:600;">✓ Disponible</span>';
        else if (rd.currentStatus === 'occupied') statusBadge = '<span style="background:#3498db;color:white;padding:3px 8px;border-radius:10px;font-size:11px;font-weight:600;">🔑 Ocupada</span>';

        let salesInfo = '';
        if (rd.sales.length > 0) {
            const last = rd.sales[rd.sales.length - 1];
            const t = new Date(last.checkInTime || last.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
            salesInfo = `<div style="background:#e8f5e9;padding:10px;border-radius:8px;margin-top:8px;font-size:13px;">
                <strong style="color:#27ae60;">🛒 Venta</strong> — $${last.price.toFixed(2)} a las ${t}
                ${rd.cleanings.length > 0 ? `<br>✓ Limpiada a las ${new Date(rd.cleanings[rd.cleanings.length-1].timestamp).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'})}` : ''}
            </div>`;
        }

        const buildingName = sanitizeHTML(rd.building === 'regulares' ? 'Edificio 1' : 'Edificio Torre');
        
        return `<div class="revenue-detail-item" style="display:block;">
            <div class="revenue-detail-item-info">
                <div class="revenue-detail-item-header">
                    <span class="revenue-detail-icon">🏠</span>
                    <span class="revenue-detail-title">Hab. ${rd.roomNumber}</span>
                    ${statusBadge}
                </div>
                <div class="revenue-detail-meta"><span>${buildingName}</span>${rd.sales.length > 0 ? `<span>${rd.sales.length} venta(s)</span>` : ''}${rd.cleanings.length > 0 ? `<span>${rd.cleanings.length} limpieza(s)</span>` : ''}</div>
                ${salesInfo}
            </div>
        </div>`;
    }).join('');
}

export function updateRoomStats() {
    const container = document.getElementById('roomStats');
    if (!container) return;
    const stats = {
        occupied: rooms.filter(r => r.status === 'occupied').length,
        available: rooms.filter(r => r.status === 'available').length,
        dirty: rooms.filter(r => r.status === 'dirty').length,
        'not-available': rooms.filter(r => r.status === 'not-available').length,
        reserved: rooms.filter(r => r.status === 'reserved').length
    };
    const labels = { occupied: '🔑 Ocupadas', available: '✓ Disponibles', dirty: '🧹 Sucias', 'not-available': '🚫 No disponibles', reserved: '📌 Reservadas' };
    container.innerHTML = Object.entries(stats).map(([status, count]) =>
        `<div class="sc-stat-item"><span class="sc-stat-item-label">${labels[status]}</span><span class="sc-stat-item-value">${count}</span></div>`
    ).join('');
}

export function updateRoomRevenueDisplay(period = 'day') {
    const container = document.getElementById('roomRevenueSummary');
    if (!container) return;
    const timeAgo = getPeriodStart(period);
    const periodData = roomRevenue.filter(r => r.timestamp >= timeAgo && (r.type === 'sold' || r.type === 'renewal'));
    const total = periodData.reduce((s, r) => s + r.price, 0);
    const count = periodData.filter(r => r.type === 'sold').length;
    container.innerHTML = `<div class="sc-summary-card">
        <div class="sc-summary-label">${periodLabel(period)}</div>
        <div class="sc-summary-amount">$${total.toFixed(2)}</div>
        <div class="sc-summary-count">${count} habitaciones vendidas</div>
    </div>`;
}

export function updateRoomUsageStats(period) {
    const container = document.getElementById('roomUsageStats');
    if (!container) return;
    const timeAgo = getPeriodStart(period);
    const periodRentals = roomRevenue.filter(r => r.timestamp >= timeAgo && r.type === 'sold');
    const roomCount = {};
    periodRentals.forEach(r => {
        const key = `Hab.${r.roomNumber} (${r.building === 'regulares' ? 'Ed.1' : 'Torre'})`;
        roomCount[key] = (roomCount[key] || 0) + 1;
    });
    const sorted = Object.entries(roomCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (sorted.length === 0) { container.innerHTML = '<p style="color:#999;text-align:center;font-size:13px;">Sin rentas en este período</p>'; return; }
    container.innerHTML = sorted.map(([name, count], idx) =>
        `<div class="sc-rank-item r${idx+1}"><div class="sc-rank-num">${idx+1}</div><span class="sc-rank-name">${name}</span><span class="sc-rank-value">${count} veces</span></div>`
    ).join('');
}

window.cancelReservation = cancelReservation;
window.confirmReservationStart = confirmReservationStart;
window.renewStay = renewStay;
window.showCustomPricing = showCustomPricing;
window.useDefaultPrice = useDefaultPrice;

window.closeRevenueDetailModal = closeRevenueDetailModal;
window.closeRoomsActivityModal = closeRoomsActivityModal;
window.filterRevenueDetail = filterRevenueDetail;
window.filterRoomsActivity = filterRoomsActivity;
window.openRevenueDetail = openRevenueDetail;
window.openRoomsActivityModal = openRoomsActivityModal;