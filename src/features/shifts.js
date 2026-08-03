import {
    currentUser, activityLog, rooms, roomRevenue, sales, expenses, shiftReports,
    shiftSnapshots, currentShiftStart, currentShiftType, SHIFT_AUTO_SWITCH_GRACE_MINUTES,
    _autoShiftCheckInProgress,
    setShiftReports, setCurrentShiftStart, setCurrentShiftType, setAutoShiftCheckInProgress, switchTab
} from '../app.js';

import { _normalizeShiftType, getExpectedShiftType, isCardOrBankPayment, showCustomConfirm } from '../utils/formatters.js';
import { ensureRevenueIndex, getShiftRevenue } from '../utils/revenue-index.js';
import { ensureMonthDataLoaded, saveData } from '../utils/storage-utils.js';
import { showToast } from '../utils/toast-system.js';
import { renderExpensesLog, updateExpensesByCategory, updateExpensesByPaymentMethod, updateExpensesTotal } from './expenses.js';
import { updateRoomRevenueDisplay, updateRoomStats, updateRoomUsageStats } from './rooms.js';
import { renderInventory, renderSalesLog, updateProductStats } from './sales.js';

// ============================================================================
// SHIFTS — control de turno, reportes de cierre, historial de turnos,
// modal de método de pago y estadísticas del período.
// Extraído de app.js tal cual (sin convertir a módulo ES todavía).
// ============================================================================

export function getCurrentShift() {
    // Si hay un turno manual establecido, usarlo
    setCurrentShiftType(_normalizeShiftType(currentShiftType));
    if (currentShiftType) {
        if (currentShiftType === 'day') {
            return {
                name: 'Turno Día',
                start: 6,
                end: 18,
                type: 'day'
            };
        } else {
            return {
                name: 'Turno Noche',
                start: 18,
                end: 6,
                type: 'night'
            };
        }
    }
    
    // Si no hay turno manual, detectar por hora (solo para inicialización)
    const now = new Date();
    const hour = now.getHours();
    
    if (hour >= 6 && hour < 18) {
        return {
            name: 'Turno Día',
            start: 6,
            end: 18,
            type: 'day'
        };
    } else {
        return {
            name: 'Turno Noche',
            start: 18,
            end: 6,
            type: 'night'
        };
    }
}

export function getShiftTimeRange() {
    const now = new Date();
    const shift = getCurrentShift();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    let shiftStart, shiftEnd;
    
    if (shift.type === 'day') {
        shiftStart = new Date(today.getTime() + (6 * 60 * 60 * 1000)); // 6 AM hoy
        shiftEnd = new Date(today.getTime() + (18 * 60 * 60 * 1000)); // 6 PM hoy
    } else {
        if (now.getHours() >= 18) {
            // Turno noche que empieza hoy
            shiftStart = new Date(today.getTime() + (18 * 60 * 60 * 1000)); // 6 PM hoy
            shiftEnd = new Date(today.getTime() + (30 * 60 * 60 * 1000)); // 6 AM mañana
        } else {
            // Turno noche que empez? ayer
            shiftStart = new Date(today.getTime() - (6 * 60 * 60 * 1000)); // 6 PM ayer
            shiftEnd = new Date(today.getTime() + (6 * 60 * 60 * 1000)); // 6 AM hoy
        }
    }
    
    return { shiftStart: shiftStart.getTime(), shiftEnd: shiftEnd.getTime() };
}

export function updateShiftTimer() {
    const now = new Date();
    const shift = getCurrentShift();
    let shiftStart;
    if (shift.type === 'day') {
        shiftStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0).getTime();
    } else {
        const h = now.getHours();
        if (h >= 18) {
            shiftStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0).getTime();
        } else {
            // Madrugada (0–6): el turno noche empezó ayer a las 18:00
            shiftStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 18, 0, 0).getTime();
        }
    }
    const elapsed = Math.max(0, now.getTime() - shiftStart);
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    const el = document.getElementById('shiftTimer');
    if (el) el.textContent = hours + 'h ' + minutes + 'm transcurridos';
}

export function updateRecentActivity(shiftStart, shiftEnd) {
    const container = document.getElementById('scRecentActivity');
    if (!container) return;

    const activities = [];

    roomRevenue.filter(r => r.timestamp >= shiftStart && r.timestamp < shiftEnd && r.type === 'sold' && !r.hidden)
        .forEach(r => activities.push({
            id: r.id,
            dataType: 'roomRevenue',
            timestamp: r.timestamp, type: 'sold',
            icon: '🏠', text: `Hab. ${r.roomNumber} (${r.building === 'regulares' ? 'Ed.1' : 'Torre'}) — $${r.price.toFixed(2)}`,
            amount: r.price
        }));

    roomRevenue.filter(r => r.timestamp >= shiftStart && r.timestamp < shiftEnd && r.type === 'renewal' && !r.hidden)
        .forEach(r => activities.push({
            id: r.id,
            dataType: 'roomRevenue',
            timestamp: r.timestamp, type: 'renewal',
            icon: '🔄', text: `Renovación Hab. ${r.roomNumber} — $${r.price.toFixed(2)}`,
            amount: r.price
        }));

    // NO incluir limpiezas de roomRevenue aquí - se muestran desde activityLog
    // roomRevenue.filter(r => r.timestamp >= shiftStart && r.timestamp < shiftEnd && r.type === 'cleaned')
    //     .forEach(r => activities.push({
    //         timestamp: r.timestamp, type: 'cleaned',
    //         icon: '🧹', 
    //         text: `Hab. ${r.roomNumber} limpiada${r.cleanedBy ? ' por ' + r.cleanedBy : ''}${r.cleaningNotes ? ' (con notas)' : ''}`
    //     }));

    sales.filter(s => s.timestamp >= shiftStart && s.timestamp < shiftEnd && !s.hidden)
        .forEach(s => activities.push({
            id: s.id,
            dataType: 'sales',
            timestamp: s.timestamp, type: 'sale',
            icon: '🛒', text: `${s.productName} x${s.quantity} — $${s.total.toFixed(2)}`,
            amount: s.total
        }));

    expenses.filter(e => e.timestamp >= shiftStart && e.timestamp < shiftEnd && !e.hidden)
        .forEach(e => activities.push({
            id: e.id,
            dataType: 'expenses',
            timestamp: e.timestamp, type: 'expense',
            icon: '💸', text: `Gasto: ${e.description} — $${e.amount.toFixed(2)}`
        }));

    activities.sort((a, b) => b.timestamp - a.timestamp);

    // AGREGAR ACTIVIDADES DEL LOG GENERAL (cambios de contraseña, limpiezas, etc.)
    if (Array.isArray(activityLog)) {
        activityLog.filter(a => a.timestamp >= shiftStart && a.timestamp < shiftEnd && !a.hidden)
            .forEach(a => {
                let icon = '📝';
                let text = a.description || 'Actividad registrada';
                
                // Iconos específicos por tipo
                if (a.type === 'password_change') {
                    icon = '🔑';
                    text = a.description;
                } else if (a.type === 'rooms' && a.description && a.description.includes('🧹') && a.description.includes('limpiada')) {
                    // Actividades de limpieza - usar el ícono y texto del log
                    icon = '🧹';
                    text = a.description;
                    
                    // Agregar información adicional si está disponible en details
                    if (a.details && a.details.building) {
                        const buildingText = a.details.building === 'regulares' ? 'Ed.1' : 'Torre';
                        text = text.replace(`Habitación ${a.details.roomNumber}`, `Hab. ${a.details.roomNumber} (${buildingText})`);
                    }
                    
                    // Agregar información de notas si las hay
                    if (a.details && a.details.notes && a.details.notes.trim()) {
                        text += ' (con notas)';
                    }
                }
                
                activities.push({
                    id: a.id,
                    dataType: 'activityLog',
                    timestamp: a.timestamp,
                    type: a.type || 'general',
                    icon: icon,
                    text: text
                });
            });
        
        // Re-ordenar después de agregar actividades del log
        activities.sort((a, b) => b.timestamp - a.timestamp);
    }

    if (activities.length === 0) {
        container.innerHTML = '<div class="sc-no-activity">Sin actividad registrada aún</div>';
        return;
    }

    container.innerHTML = activities.slice(0, 15).map(a => {
        const time = new Date(a.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
        const amountHtml = a.amount ? `<span class="sc-act-amount">$${a.amount.toFixed(2)}</span>` : '';
        
        // Solo mostrar botón de eliminar para director y recepción
        const deleteBtn = (currentUser && (currentUser.role === 'director' || currentUser.role === 'recepcion') && a.id && a.dataType) 
            ? `<button class="sc-act-delete-btn" onclick="deleteActivityItem('${a.dataType}', ${a.id})" title="Ocultar">🗑️</button>`
            : '';
        
        return `
            <div class="sc-activity-item type-${a.type}">
                <span class="sc-act-icon">${a.icon}</span>
                <div class="sc-act-body">
                    <div class="sc-act-text">${a.text}</div>
                    <div class="sc-act-time">${time}</div>
                </div>
                ${amountHtml}
                ${deleteBtn}
            </div>`;
    }).join('');
}

export function updateShiftControl() {
    const shift = getCurrentShift();

    // Actualizar badge y horario
    const badge = document.getElementById('scShiftBadge');
    const timeEl = document.getElementById('scShiftTime');
    const dateEl = document.getElementById('scShiftDate');
    if (badge) badge.textContent = shift.name.toUpperCase();
    if (timeEl) timeEl.textContent = shift.type === 'day' ? '6:00 AM – 6:00 PM' : '6:00 PM – 6:00 AM';
    // Fecha del DÍA EN QUE EMPEZÓ el turno (currentShiftStart), no la fecha de
    // hoy — un turno de noche que arrancó el 17 sigue siendo "17 de julio"
    // aunque ya sea después de medianoche del 18 cuando se consulta esto.
    if (dateEl) {
        dateEl.textContent = currentShiftStart
            ? new Date(currentShiftStart).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' })
            : '';
    }

    ensureRevenueIndex();

    const shiftRooms = getShiftRevenue(shift.type, currentShiftStart).filter(r => r.type === 'sold');
    const shiftRenewals = getShiftRevenue(shift.type, currentShiftStart).filter(r => r.type === 'renewal');
    const shiftCleaned = getShiftRevenue(shift.type, currentShiftStart).filter(r => r.type === 'cleaned');
    const shiftSales = sales.filter(s => s.shift === shift.type && s.timestamp >= currentShiftStart);
    const shiftExpenses = expenses.filter(e => !e.deleted && e.shift === shift.type && e.timestamp >= currentShiftStart);

    const roomsTotal    = shiftRooms.reduce((s, r) => s + r.price, 0);
    const renewalsTotal = shiftRenewals.reduce((s, r) => s + r.price, 0);
    const salesTotal    = shiftSales.reduce((s, r) => s + r.total, 0);
    const expensesTotal = shiftExpenses.reduce((s, e) => s + e.amount, 0);
    const netTotal      = roomsTotal + renewalsTotal + salesTotal - expensesTotal;

    // KPIs
    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('quickTotalRevenue', '$' + netTotal.toFixed(2));
    setEl('scRoomsKpi', shiftRooms.length + shiftRenewals.length);
    setEl('scDirtyKpi', rooms.filter(r => r.status === 'dirty').length);

    // Desglose ingresos
    setEl('revenueRooms', '$' + (roomsTotal + renewalsTotal).toFixed(2));
    setEl('revenueRoomsCount', shiftRooms.length + ' rentas' + (shiftRenewals.length > 0 ? ' + ' + shiftRenewals.length + ' renovaciones' : ''));
    setEl('revenueSales', '$' + salesTotal.toFixed(2));
    setEl('revenueSalesCount', shiftSales.length + ' transacciones');
    setEl('revenueExpenses', '$' + expensesTotal.toFixed(2));
    setEl('revenueExpensesCount', shiftExpenses.length + ' gastos');

    // Métodos de pago
    const pm = { efectivo: 0, tarjeta: 0 };
    [...shiftRooms, ...shiftRenewals].forEach(r => { pm[r.paymentMethod || 'efectivo'] += r.price; });
    shiftSales.forEach(s => { pm[s.paymentMethod || 'efectivo'] += s.total; });
    setEl('paymentEfectivo', '$' + pm.efectivo.toFixed(2));
    setEl('paymentTarjeta',  '$' + pm.tarjeta.toFixed(2));
    setEl('paymentTotal',    '$' + (pm.efectivo + pm.tarjeta).toFixed(2));

    // Timer y actividad — usar el inicio REAL del turno (currentShiftStart),
    // no el rango fijo 6am/6pm de getShiftTimeRange(), que diverge en cuanto
    // un turno se abre/cierra manualmente fuera de esas horas y mostraba una
    // lista de actividad reciente inconsistente con los KPIs de arriba.
    updateShiftTimer();
    updateRecentActivity(currentShiftStart, Date.now());
}

export async function deleteActivityItem(dataType, itemId) {
    // Buscar el elemento para mostrar información en la confirmación
    let itemText = '';
    let item = null;
    
    switch(dataType) {
        case 'roomRevenue':
            item = roomRevenue.find(r => r.id === itemId);
            if (item) {
                itemText = `${item.type === 'sold' ? 'Venta' : 'Renovación'} de Hab. ${item.roomNumber} - $${item.price.toFixed(2)}`;
            }
            break;
        case 'sales':
            item = sales.find(s => s.id === itemId);
            if (item) {
                itemText = `Venta: ${item.productName} x${item.quantity} - $${item.total.toFixed(2)}`;
            }
            break;
        case 'expenses':
            item = expenses.find(e => e.id === itemId);
            if (item) {
                itemText = `Gasto: ${item.description} - $${item.amount.toFixed(2)}`;
            }
            break;
        case 'activityLog':
            item = activityLog.find(a => a.id === itemId);
            if (item) {
                itemText = item.description || 'Actividad registrada';
            }
            break;
    }
    
    if (!item) {
        showToast('Error: Elemento no encontrado', 'error');
        return;
    }
    
    // Confirmación obligatoria
    const confirmed = await showCustomConfirm(
        '👁️ Ocultar del Historial',
        `¿Ocultar esta actividad del historial y reportes?\n\n${itemText}\n\n✓ Los ingresos NO se modificarán\n✓ Solo desaparecerá del historial visual`
    );
    
    if (!confirmed) return;
    
    // Marcar como oculto en lugar de eliminar
    item.hidden = true;
    item.hiddenBy = currentUser ? currentUser.name : 'Desconocido';
    item.hiddenAt = Date.now();
    
    // Guardar cambios
    saveData();
    
    // Actualizar interfaz
    updateShiftControl();
    
    // Actualizar otras vistas según el tipo
    if (dataType === 'sales') {
        renderSalesLog();
        renderInventory();
    } else if (dataType === 'expenses') {
        updateExpensesTotal();
        renderExpensesLog();
    }
    
    showToast('✓ Elemento oculto del historial', 'success');
    
    console.log(`[Activity] Elemento oculto: ${dataType} ID:${itemId} por ${currentUser.name}`);
}

export async function closeShift(options = {}) {
    const auto = options.auto === true;
    const shift = getCurrentShift();

    const shiftRooms = roomRevenue.filter(r =>
        r.shift === shift.type && r.type === 'sold' && r.timestamp >= currentShiftStart
    );
    const shiftRenewals = roomRevenue.filter(r =>
        r.shift === shift.type && r.type === 'renewal' && r.timestamp >= currentShiftStart
    );
    const shiftCleaned = roomRevenue.filter(r =>
        r.shift === shift.type && r.type === 'cleaned' && r.timestamp >= currentShiftStart
    );
    const shiftSales = sales.filter(s =>
        s.shift === shift.type && s.timestamp >= currentShiftStart
    );

    const roomsSold = shiftRooms.length;
    const roomsCleaned = shiftCleaned.length;
    const difference = roomsSold - roomsCleaned;
    const roomRev = shiftRooms.reduce((sum, r) => sum + r.price, 0);
    const renewalsRev = shiftRenewals.reduce((sum, r) => sum + r.price, 0);
    const salesRev = shiftSales.reduce((sum, s) => sum + s.total, 0);
    const totalRev = roomRev + renewalsRev + salesRev;

    // El cierre automático por desfase horario (ver autoCloseShiftIfOverdue)
    // no debe interrumpir al empleado con un diálogo de confirmación — si
    // nadie cerró el turno manualmente en 15 minutos, se cierra solo.
    if (!auto) {
        let confirmMessage = `Confirmas cerrar el turno ${shift.name}?\n\nResumen:\nHabitaciones vendidas: ${roomsSold}\nHabitaciones limpiadas: ${roomsCleaned}\nIngresos totales: $${totalRev.toFixed(2)}`;
        if (shiftRenewals.length > 0) confirmMessage += `\n(incluye ${shiftRenewals.length} renovación(es))`;
        if (difference !== 0) confirmMessage += `\n\nADVERTENCIA: Diferencia de ${Math.abs(difference)} habitacion(es)`;

        const confirmed = await showCustomConfirm('Confirmar Cierre de Turno', confirmMessage);
        if (!confirmed) return;
    }

    const snapshot = {
        id: Date.now(), shiftType: shift.type, shiftName: shift.name, closedAt: Date.now(),
        rooms: rooms.filter(r => r).map(r => ({ number: r.number, building: r.building, status: r.status, checkInTime: r.checkInTime, price: r.price, guestName: r.guestName, customTime: r.customTime }))
    };
    shiftSnapshots.push(snapshot);

    const shiftClosedAt = Date.now();
    const report = {
        id: Date.now(), shiftName: shift.name, shiftType: shift.type,
        // Usar el inicio/fin REAL del turno (currentShiftStart..cierre), no el
        // rango fijo 6am/6pm de getShiftTimeRange(): si el turno se abrió o
        // cerró manualmente fuera de esa ventana, downloadShiftReport() volvía
        // a filtrar con un rango invertido y devolvía $0 en un reporte cuyo
        // total ya se había calculado correctamente arriba con currentShiftStart.
        startTime: currentShiftStart, endTime: shiftClosedAt, closedAt: shiftClosedAt,
        closedBy: auto ? 'Sistema (automático)' : (currentUser ? currentUser.name : 'Desconocido'),
        autoClosed: auto,
        roomsSold, roomsCleaned, difference,
        roomRevenue: roomRev + renewalsRev, salesRevenue: salesRev, totalRevenue: totalRev,
        salesCount: shiftSales.length, isBalanced: difference === 0
    };
    shiftReports.push(report);
    
    // Mantener los últimos 20 turnos (10 días) para análisis histórico
    if (shiftReports.length > 20) {
        setShiftReports(shiftReports.slice(-20));
    }

    const shiftExpenses = expenses.filter(e => !e.deleted && e.shift === shift.type && e.timestamp >= currentShiftStart);
    // En modo auto NO se dispara la descarga/modal del reporte (interrumpiría
    // al empleado sin que nadie lo haya pedido) — el reporte ya quedó
    // guardado en shiftReports y se puede descargar luego desde el historial
    // de turnos (downloadShiftReport).
    if (!auto) {
        generateShiftReport(shift, shiftRooms, shiftCleaned, shiftSales, shiftExpenses, shiftRenewals, report);
    }

    const closedShiftStart = currentShiftStart;
    setCurrentShiftStart(Date.now());

    // Cambiar al turno contrario: día → noche, noche → día
    setCurrentShiftType((shift.type === 'day') ? 'night' : 'day');

    // Persistir inmediatamente a localStorage y Firebase (sin depender del throttle)
    localStorage.setItem('motelCurrentShiftStart', JSON.stringify(currentShiftStart));
    localStorage.setItem('motelCurrentShiftType', currentShiftType);
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        window.FirebaseSync.save('motelCurrentShiftStart', currentShiftStart).catch(() => {});
        window.FirebaseSync.save('motelCurrentShiftType', currentShiftType).catch(() => {});
    }

    // NO BORRAR DATOS HISTÓRICOS - mantener todos los registros para estadísticas y reportes
    // Los datos se filtran por turno usando el campo 'shift' y 'timestamp' al consultarlos
    // sales, expenses y roomRevenue conservan TODO el histórico

    saveData();
    renderSalesLog();
    updateExpensesTotal();
    updateShiftHistory();
    const newShift = getCurrentShift();

    if (auto) {
        // No confirmación, no cambio de pestaña forzado: el empleado puede
        // estar en medio de otra tarea (limpieza, ventas, etc.) y no debe
        // ser interrumpido, solo notificado.
        showToast(`⏰ ${shift.name} cerrado automáticamente por desfase horario (nadie lo cerró a tiempo). Iniciando ${newShift.name}.`, 'warning', 8000);
        console.log(`[Turno] Auto-cierre: ${shift.name} → ${newShift.name}`);
    } else {
        showToast(`Turno cerrado. Iniciando ${newShift.name} en cero.`, 'success');
        // Navegar a la pestaña de control de turno para mostrar el nuevo turno
        switchTab('shift-control');
    }

    updateShiftControl();
    updateStatistics();
}

export function isPastShiftGracePeriod(now = new Date()) {
    const h = now.getHours(), m = now.getMinutes();
    if (h === 6 && m < SHIFT_AUTO_SWITCH_GRACE_MINUTES) return false;
    if (h === 18 && m < SHIFT_AUTO_SWITCH_GRACE_MINUTES) return false;
    return true;
}

export async function autoCloseShiftIfOverdue() {
    if (_autoShiftCheckInProgress) return;
    if (!currentShiftType || !rooms || rooms.length === 0) return; // datos aún no cargados

    const now = new Date();
    if (currentShiftType === getExpectedShiftType(now)) return; // ya está al día
    if (!isPastShiftGracePeriod(now)) return; // dentro del margen de gracia

    setAutoShiftCheckInProgress(true);
    try {
        // Pequeño jitter: si hay varios dispositivos abiertos, evita que
        // todos disparen el cierre en el mismo instante. Al reanudar, se
        // vuelve a comprobar por si otro dispositivo (o Firebase Sync) ya
        // resolvió el desfase mientras tanto.
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 8000)));
        if (currentShiftType === getExpectedShiftType(new Date())) return;

        await closeShift({ auto: true });
    } finally {
        setAutoShiftCheckInProgress(false);
    }
}

export function updateShiftHistory() {
    const container = document.getElementById('shiftHistory');
    if (!container) return;
    const recentShifts = [...shiftReports].reverse().slice(0, 20);
    if (recentShifts.length === 0) {
        container.innerHTML = '<p style="text-align:center;color:#999;">No hay turnos cerrados aún</p>';
        return;
    }
    container.innerHTML = recentShifts.map(report => {
        const closedDate = new Date(report.closedAt);
        return `<div class="shift-report-item ${report.isBalanced ? 'balanced' : 'unbalanced'}">
            <div class="shift-report-header"><strong>${report.shiftName}</strong><span class="shift-date">${closedDate.toLocaleString('es-MX')}</span></div>
            <div class="shift-report-details">
                <div>Vendidas: ${report.roomsSold} | Limpiadas: ${report.roomsCleaned} | Diferencia: ${report.difference}</div>
                <div>Total: <strong>$${report.totalRevenue.toFixed(2)}</strong></div>
                <div class="shift-status">${report.isBalanced ? '✓ Balanceado' : '⚠ Con diferencia'}</div>
            </div>
        </div>`;
    }).join('');
}

export function generateShiftReport(shift, shiftRooms, shiftCleaned, shiftSales, shiftExpenses, shiftRenewals, report) {
    const closedDate = new Date(report.closedAt);
    const dateStr = closedDate.toLocaleString('es-MX');
    const pm = { efectivo: 0, tarjeta: 0 };
    [...shiftRooms, ...(shiftRenewals || [])].forEach(r => { pm[r.paymentMethod || 'efectivo'] += r.price; });
    shiftSales.forEach(s => { pm[s.paymentMethod || 'efectivo'] += s.total; });
    const expTotal = (shiftExpenses || []).reduce((s, e) => s + e.amount, 0);

    let content = `REPORTE DE CIERRE DE TURNO - RAPID INN\n${'='.repeat(50)}\n\n`;
    content += `Turno: ${shift.name}\nHorario: ${shift.type === 'day' ? '6:00 AM - 6:00 PM' : '6:00 PM - 6:00 AM'}\nFecha: ${dateStr}\nCerrado por: ${report.closedBy}\n\n`;
    content += `${'─'.repeat(50)}\nRESUMEN FINANCIERO\n${'─'.repeat(50)}\n`;
    content += `Ingresos habitaciones: $${report.roomRevenue.toFixed(2)}\nIngresos ventas: $${report.salesRevenue.toFixed(2)}\nEgresos: $${expTotal.toFixed(2)}\nTOTAL NETO: $${(report.totalRevenue - expTotal).toFixed(2)}\n\n`;
    content += `CORTE POR MÉTODO DE PAGO\nEfectivo: $${pm.efectivo.toFixed(2)}\nTarjeta: $${pm.tarjeta.toFixed(2)}\n\n`;
    content += `HABITACIONES\nVendidas: ${report.roomsSold} | Limpiadas: ${report.roomsCleaned} | Diferencia: ${report.difference} ${report.isBalanced ? '[OK]' : '[!]'}\n`; // FIXED: Emojis reemplazados por ASCII
    
    // Agregar explicación de diferencias
    if (report.difference !== 0) {
        content += `\nEXPLICACIÓN DE DIFERENCIAS:\n`;
        
        // Crear mapas de habitaciones vendidas y limpiadas
        const soldRoomNumbers = new Set(shiftRooms.map(r => r.roomNumber));
        const cleanedRoomNumbers = new Set(shiftCleaned.map(r => r.roomNumber));
        
        // Habitaciones vendidas pero no limpiadas (quedaron sucias)
        const notCleaned = shiftRooms.filter(r => !cleanedRoomNumbers.has(r.roomNumber));
        if (notCleaned.length > 0) {
            content += `\nHabitaciones vendidas sin limpiar (${notCleaned.length}):\n`;
            notCleaned.forEach(r => {
                const time = new Date(r.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
                content += `  • Hab. ${r.roomNumber} - Vendida a las ${time}\n`;
            });
        }
        
        // Habitaciones limpiadas pero no vendidas (se limpiaron de más)
        const notSold = shiftCleaned.filter(r => !soldRoomNumbers.has(r.roomNumber));
        if (notSold.length > 0) {
            content += `\nHabitaciones limpiadas sin vender (${notSold.length}):\n`;
            notSold.forEach(r => {
                const time = new Date(r.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
                content += `  • Hab. ${r.roomNumber} - Limpiada a las ${time}\n`;
            });
        }
    }
    content += '\n';

    if (shiftRooms.length > 0) {
        content += `DETALLE HABITACIONES VENDIDAS\n`;
        shiftRooms.forEach(r => {
            const time = new Date(r.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
            content += `Hab.${r.roomNumber} (${r.building === 'regulares' ? 'Ed.1' : 'Torre'}) - $${r.price.toFixed(2)} - ${r.paymentMethod || 'efectivo'} - ${time}\n`;
        });
        content += '\n';
    }
    if (shiftSales.length > 0) {
        content += `VENTAS DE INVENTARIO\n`;
        shiftSales.forEach(s => { content += `${s.productName} x${s.quantity} = $${s.total.toFixed(2)}\n`; });
        content += '\n';
    }
    if ((shiftExpenses || []).length > 0) {
        content += `EGRESOS\n`;
        shiftExpenses.forEach(e => { content += `${e.description}: $${e.amount.toFixed(2)}\n`; });
    }

    const filename = `Reporte_${shift.name.replace(' ', '_')}_${closedDate.getFullYear()}-${String(closedDate.getMonth()+1).padStart(2,'0')}-${String(closedDate.getDate()).padStart(2,'0')}.txt`;
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth <= 768;

    if (isMobile) {
        showMobileReportModal(content, shift.name, filename);
    } else {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

export function showMobileReportModal(content, shiftName, filename) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;display:flex;flex-direction:column;padding:16px;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:#fff;border-radius:14px;display:flex;flex-direction:column;max-height:85vh;overflow:hidden;';

    const header = document.createElement('div');
    header.style.cssText = 'padding:14px 18px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;';
    const title = document.createElement('strong');
    title.textContent = 'Reporte ' + shiftName;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:none;border:none;font-size:22px;cursor:pointer;color:#666;line-height:1;';
    closeBtn.onclick = () => document.body.removeChild(overlay);
    header.appendChild(title);
    header.appendChild(closeBtn);

    const pre = document.createElement('pre');
    pre.textContent = content;
    pre.style.cssText = 'padding:14px;overflow:auto;flex:1;font-size:11px;font-family:monospace;white-space:pre-wrap;margin:0;background:#f8f9fa;';

    const footer = document.createElement('div');
    footer.style.cssText = 'padding:14px;border-top:1px solid #eee;display:flex;gap:10px;';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 Copiar';
    copyBtn.style.cssText = 'flex:1;padding:12px;background:#667eea;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;';
    copyBtn.onclick = () => {
        const fallback = () => {
            const ta = document.createElement('textarea');
            ta.value = content;
            ta.style.cssText = 'position:fixed;opacity:0;';
            document.body.appendChild(ta);
            ta.focus(); ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        };
        (navigator.clipboard ? navigator.clipboard.writeText(content).catch(fallback) : Promise.reject()).catch(fallback);
        copyBtn.textContent = '✓ Copiado!';
        setTimeout(() => { copyBtn.textContent = '📋 Copiar'; }, 2000);
    };

    const dlBtn = document.createElement('button');
    dlBtn.textContent = '⬇ Descargar';
    dlBtn.style.cssText = 'flex:1;padding:12px;background:#2ecc71;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;';
    dlBtn.onclick = () => {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    footer.appendChild(copyBtn);
    footer.appendChild(dlBtn);
    modal.appendChild(header);
    modal.appendChild(pre);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}

export function openShiftHistoryModal() {
    renderShiftHistoryList();
    document.getElementById('shiftHistoryModal').classList.add('show');
}

export function closeShiftHistoryModal() {
    document.getElementById('shiftHistoryModal').classList.remove('show');
}

export function renderShiftHistoryList() {
    const container = document.getElementById('shiftHistoryList');
    if (!container) return;
    const recentShifts = [...shiftReports].reverse().slice(0, 4); // Cambiar de 14 a 4 turnos (2 días)
    if (recentShifts.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:#999;"><div style="font-size:48px;">📋</div><h3>No hay turnos cerrados</h3></div>';
        return;
    }
    container.innerHTML = recentShifts.map((report, idx) => {
        const date = new Date(report.closedAt);
        const dateStr = date.toLocaleString('es-MX', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        return `<div class="shift-history-item ${report.isBalanced ? 'balanced' : 'unbalanced'}">
            <div class="shift-history-header">
                <div>
                    <strong>${report.shiftName}</strong>
                    <span class="shift-history-date">${dateStr}</span>
                </div>
                <div class="shift-history-total">$${report.totalRevenue.toFixed(2)}</div>
            </div>
            <div class="shift-history-details">
                <span>🏠 ${report.roomsSold} vendidas</span>
                <span>🧹 ${report.roomsCleaned} limpiadas</span>
                <span>${report.isBalanced ? '✓ Balanceado' : `⚠ Dif: ${report.difference}`}</span>
                <span>Por: ${report.closedBy}</span>
            </div>
            <button class="btn-download-shift" onclick="downloadShiftReport(${shiftReports.length - 1 - idx})">📥 Descargar</button>
        </div>`;
    }).join('');
}

export function downloadShiftReport(reportIndex) {
    const report = shiftReports[reportIndex];
    if (!report) return;
    const shift = { type: report.shiftType, name: report.shiftName };
    const shiftRooms = roomRevenue.filter(r => r.shift === report.shiftType && r.type === 'sold' && r.timestamp >= report.startTime && r.timestamp <= report.closedAt);
    const shiftCleaned = roomRevenue.filter(r => r.shift === report.shiftType && r.type === 'cleaned' && r.timestamp >= report.startTime && r.timestamp <= report.closedAt);
    const shiftSales = sales.filter(s => s.shift === report.shiftType && s.timestamp >= report.startTime && s.timestamp <= report.closedAt);
    const shiftExpenses = expenses.filter(e => !e.deleted && e.shift === report.shiftType && e.timestamp >= report.startTime && e.timestamp <= report.closedAt);
    const shiftRenewals = roomRevenue.filter(r => r.shift === report.shiftType && r.type === 'renewal' && r.timestamp >= report.startTime && r.timestamp <= report.closedAt);
    generateShiftReport(shift, shiftRooms, shiftCleaned, shiftSales, shiftExpenses, shiftRenewals, report);
}

export async function downloadShiftDayReport(year, month, day, shiftType) {
    await ensureMonthDataLoaded(year, month);
    const monthRevenueRecords = getMonthRecords(year, month, 'revenue');
    const monthSalesRecords = getMonthRecords(year, month, 'sales');
    const monthExpenseRecords = getMonthRecords(year, month, 'expenses');

    const shiftStart = shiftType === 'day'
        ? new Date(year, month, day, 6, 0, 0).getTime()
        : new Date(year, month, day, 18, 0, 0).getTime();
    const shiftEnd = shiftType === 'day'
        ? new Date(year, month, day, 17, 59, 59).getTime()
        : new Date(year, month, day + 1, 5, 59, 59).getTime();

    const inShift = (item) => item.timestamp >= shiftStart && item.timestamp <= shiftEnd && item.shift === shiftType;
    const rooms       = monthRevenueRecords.filter(r => inShift(r) && r.type === 'sold');
    const renewals     = monthRevenueRecords.filter(r => inShift(r) && r.type === 'renewal');
    const cleaned       = monthRevenueRecords.filter(r => inShift(r) && r.type === 'cleaned');
    const salesShift   = monthSalesRecords.filter(s => inShift(s));
    const expensesShift = (monthExpenseRecords || []).filter(e => !e.deleted && inShift(e));

    const pm = { efectivo: 0, tarjeta: 0 };
    [...rooms, ...renewals].forEach(r => { pm[isCardOrBankPayment(r.paymentMethod) ? 'tarjeta' : 'efectivo'] += r.price; });
    salesShift.forEach(s => { pm[isCardOrBankPayment(s.paymentMethod) ? 'tarjeta' : 'efectivo'] += s.total; });

    const roomRevenueTotal = rooms.reduce((s, r) => s + r.price, 0) + renewals.reduce((s, r) => s + r.price, 0);
    const salesRevenueTotal = salesShift.reduce((s, r) => s + r.total, 0);
    const expTotal = expensesShift.reduce((s, e) => s + e.amount, 0);

    const dateObj = new Date(year, month, day);
    const dateStr = dateObj.toLocaleDateString('es-MX', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    const shiftLabel = shiftType === 'day' ? 'Turno Día (6:00 AM - 6:00 PM)' : 'Turno Noche (6:00 PM - 6:00 AM)';

    let content = `REPORTE DE TURNO - RAPID INN\n${'='.repeat(50)}\n\n`;
    content += `Turno: ${shiftLabel}\nFecha: ${dateStr}\n\n`;
    content += `${'─'.repeat(50)}\nRESUMEN FINANCIERO\n${'─'.repeat(50)}\n`;
    content += `Ingresos habitaciones: $${roomRevenueTotal.toFixed(2)}\nIngresos ventas: $${salesRevenueTotal.toFixed(2)}\nEgresos: $${expTotal.toFixed(2)}\nTOTAL NETO: $${(roomRevenueTotal + salesRevenueTotal - expTotal).toFixed(2)}\n\n`;
    content += `CORTE POR MÉTODO DE PAGO\nEfectivo: $${pm.efectivo.toFixed(2)}\nTarjeta: $${pm.tarjeta.toFixed(2)}\n\n`;
    content += `HABITACIONES\nVendidas: ${rooms.length} | Renovaciones: ${renewals.length} | Limpiadas: ${cleaned.length}\n\n`;

    if (rooms.length > 0) {
        content += `HABITACIONES VENDIDAS\n`;
        rooms.forEach(r => {
            const time = new Date(r.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
            content += `Hab.${r.roomNumber} (${r.building === 'regulares' ? 'Ed.1' : 'Torre'}) - $${r.price.toFixed(2)} - ${r.paymentMethod || 'efectivo'} - ${time}\n`;
        });
        content += '\n';
    }
    if (renewals.length > 0) {
        content += `RENOVACIONES\n`;
        renewals.forEach(r => {
            const time = new Date(r.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
            content += `Hab.${r.roomNumber} - $${r.price.toFixed(2)} - ${time}\n`;
        });
        content += '\n';
    }
    if (salesShift.length > 0) {
        content += `VENTAS DE INVENTARIO\n`;
        salesShift.forEach(s => { content += `${s.productName} x${s.quantity} = $${s.total.toFixed(2)}\n`; });
        content += '\n';
    }
    if (expensesShift.length > 0) {
        content += `EGRESOS\n`;
        expensesShift.forEach(e => { content += `${e.description}: $${e.amount.toFixed(2)}\n`; });
    }

    const filename = `Reporte_${shiftType === 'day' ? 'TurnoDia' : 'TurnoNoche'}_${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}.txt`;
    const shiftShortLabel = shiftType === 'day' ? 'Turno Día' : 'Turno Noche';
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth <= 768;

    if (isMobile) {
        showMobileReportModal(content, shiftShortLabel, filename);
    } else {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

export function openPaymentMethodModal(method) {
    const modal = document.getElementById('paymentMethodModal');
    const title = document.getElementById('paymentMethodModalTitle');
    const content = document.getElementById('paymentMethodModalContent');
    const shift = getCurrentShift();
    const shiftRooms = roomRevenue.filter(r => r.shift === shift.type && r.type === 'sold' && r.timestamp >= currentShiftStart);
    const shiftRenewals = roomRevenue.filter(r => r.shift === shift.type && r.type === 'renewal' && r.timestamp >= currentShiftStart);
    const shiftSales = sales.filter(s => s.shift === shift.type && s.timestamp >= currentShiftStart);

    const icons = { efectivo: '💵 Efectivo', tarjeta: '💳 Tarjeta', todos: '💰 Todos los Pagos' };
    title.textContent = icons[method] || 'Pagos';

    const allItems = [
        ...shiftRooms.map(r => ({ ...r, amount: r.price, label: `Hab. ${r.roomNumber}`, type: 'room' })),
        ...shiftRenewals.map(r => ({ ...r, amount: r.price, label: `Renovación Hab. ${r.roomNumber}`, type: 'renewal' })),
        ...shiftSales.map(s => ({ ...s, amount: s.total, label: s.productName, type: 'sale' }))
    ].filter(item => method === 'todos' || (item.paymentMethod || 'efectivo') === method);

    const total = allItems.reduce((s, i) => s + i.amount, 0);

    content.innerHTML = `<div style="background:linear-gradient(135deg,#667eea,#764ba2);color:white;border-radius:10px;padding:18px;text-align:center;margin-bottom:16px;">
        <div style="font-size:12px;opacity:.85;text-transform:uppercase;">Total ${icons[method]}</div>
        <div style="font-size:36px;font-weight:800;">$${total.toFixed(2)}</div>
        <div style="font-size:12px;opacity:.8;">${allItems.length} transacciones</div>
    </div>
    <div>${allItems.length === 0 ? '<p style="text-align:center;color:#999;padding:20px;">Sin transacciones</p>' :
        allItems.sort((a,b) => b.timestamp - a.timestamp).map(item => {
            const time = new Date(item.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
            const icon = item.type === 'room' ? '🏠' : item.type === 'renewal' ? '🔄' : '🛒';
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:#f8f9fa;border-radius:8px;margin-bottom:6px;">
                <div><span style="margin-right:8px;">${icon}</span><span style="font-size:13px;color:#2c3e50;">${item.label}</span><br><span style="font-size:11px;color:#95a5a6;">${time}</span></div>
                <span style="font-weight:700;color:#27ae60;">$${item.amount.toFixed(2)}</span>
            </div>`;
        }).join('')
    }</div>`;

    modal.classList.add('show');
}

export function closePaymentMethodModal() {
    document.getElementById('paymentMethodModal').classList.remove('show');
}

export function scSetPeriod(btn, type, period) {
    const parent = btn.closest('.sc-stat-card');
    if (parent) parent.querySelectorAll('.sc-period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (type === 'roomRevenue') updateRoomRevenueDisplay(period);
    else if (type === 'salesRevenue') updateRevenueStats(period);
    else if (type === 'expensesByPayment') updateExpensesByPaymentMethod(period);
    else if (type === 'expensesByCategory') updateExpensesByCategory(period);
}

export function getPeriodStart(period) {
    const now = Date.now();
    // 'day' ahora representa el turno actual, no las últimas 24 horas
    if (period === 'day') return currentShiftStart; // CAMBIO: usar turno actual
    if (period === 'week') return now - 604800000;
    return now - 2592000000;
}

export function periodLabel(period) {
    if (period === 'day') return 'Turno Actual'; // CAMBIO: de "Hoy (24h)" a "Turno Actual"
    if (period === 'week') return 'Esta semana';
    return 'Este mes';
}

export function updateRevenueStats(period = 'day') {
    const container = document.getElementById('revenueStats');
    if (!container) return;
    const timeAgo = getPeriodStart(period);
    const periodSales = sales.filter(s => s.timestamp >= timeAgo);
    const total = periodSales.reduce((s, sale) => s + sale.total, 0);
    container.innerHTML = `<div class="sc-summary-card pink">
        <div class="sc-summary-label">${periodLabel(period)}</div>
        <div class="sc-summary-amount">$${total.toFixed(2)}</div>
        <div class="sc-summary-count">${periodSales.length} transacciones</div>
    </div>`;
}

export function updateStatistics() {
    updateRoomStats();
    updateRoomRevenueDisplay('day');
    updateRevenueStats('day');
    if (currentUser && currentUser.role === 'director') {
        updateExpensesByPaymentMethod('day');
        updateExpensesByCategory('day');
        updateProductStats('day');
        updateRoomUsageStats('day');
    }
}

window.deleteActivityItem = deleteActivityItem;
window.downloadShiftReport = downloadShiftReport;
window.downloadShiftDayReport = downloadShiftDayReport;

window.closePaymentMethodModal = closePaymentMethodModal;
window.closeShift = closeShift;
window.closeShiftHistoryModal = closeShiftHistoryModal;
window.openPaymentMethodModal = openPaymentMethodModal;
window.openShiftHistoryModal = openShiftHistoryModal;
window.scSetPeriod = scSetPeriod;