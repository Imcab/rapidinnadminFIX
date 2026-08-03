import {
    expenses, _mrData, currentExpensesPeriod, currentExpensesShift,
    setExpenses, setMrData, setCurrentExpensesPeriod, setCurrentExpensesShift,
    currentShiftStart, _appReady, _mrYear, currentUser
} from '../app.js';

import { sanitizeHTML, showCustomConfirm } from '../utils/formatters.js';
import { generateMonthlyReport } from './monthly-report.js';
import { getCurrentShift, getPeriodStart } from './shifts.js';
import { saveData } from '../utils/storage-utils.js';
import { showToast } from '../utils/toast-system.js';

// ============================================================================
// EXPENSES — registro de gastos, totales, resumen por turno/categoría y
// modal de resumen de gastos.
// Extraído de app.js tal cual (sin convertir a módulo ES todavía).
// ============================================================================

export function addExpense() {
    const category = document.getElementById('expenseCategory').value;
    const description = document.getElementById('expenseDescription').value;
    const amount = parseFloat(document.getElementById('expenseAmount').value);
    const paymentMethod = document.getElementById('expensePaymentMethod').value;

    if (!category) { showToast('Por favor selecciona una categoría', 'error'); return; }
    if (!description || description.trim() === '') { showToast('Por favor ingresa una descripción', 'error'); return; }
    if (!amount || amount <= 0) { showToast('Por favor ingresa un monto válido', 'error'); return; }
    if (!paymentMethod) { showToast('Por favor selecciona un método de pago', 'error'); return; }

    const categoryNames = {
        'operacion': 'Gastos de Operación', 'alimentos': 'Alimentos y Bebidas',
        'limpieza': 'Productos de Limpieza', 'sexshop': 'Sex Shop',
        'generales': 'Generales', 'mercadotecnia': 'Mercadotecnia', 'nomina': 'Nómina'
    };
    const paymentMethodNames = { 'efectivo': 'Efectivo en Caja', 'banco': 'Banco/Transferencia' };

    const expense = {
        id: Date.now(),
        category: categoryNames[category],
        categoryType: category,
        description: description.trim(),
        amount: amount,
        paymentMethod: paymentMethod,
        timestamp: Date.now(),
        shift: getCurrentShift().type,
        shiftName: getCurrentShift().name
    };

    expenses.push(expense);
    
    // Limitar a últimos 5000 registros para evitar problemas de tamaño
    if (expenses.length > 5000) {
        console.warn('[Sistema] Archivando gastos antiguos...');
        setExpenses(expenses.slice(-5000));
    }
    
    saveData();

    // Sincronizar con reporte mensual
    const expenseDate = new Date(expense.timestamp);
    const mrKey = `mrData_${expenseDate.getFullYear()}_${expenseDate.getMonth()}`;
    let mrData;
    try {
        const saved = localStorage.getItem(mrKey);
        mrData = saved ? JSON.parse(saved) : { directExpenses: [], indirectExpenses: [], nonOpExpenses: [], salaries: [], efectivoMovimientos: [], bancoMovimientos: [] };
    } catch(e) {
        mrData = { directExpenses: [], indirectExpenses: [], nonOpExpenses: [], salaries: [], efectivoMovimientos: [], bancoMovimientos: [] };
    }

    const todayStr = expenseDate.toISOString().split('T')[0];
    const newItem = { category, concept: description.trim(), date: todayStr, amount, _expenseId: expense.id };

    // mercadotecnia -> indirecto, resto -> directo
    if (category === 'mercadotecnia') {
        if (!mrData.indirectExpenses) mrData.indirectExpenses = [];
        mrData.indirectExpenses.push(newItem);
    } else {
        if (!mrData.directExpenses) mrData.directExpenses = [];
        mrData.directExpenses.push(newItem);
    }

    localStorage.setItem(mrKey, JSON.stringify(mrData));
    if (_appReady && window.FirebaseSync && window.FirebaseSync.ready) {
        window.FirebaseSync.saveMrData(mrKey, mrData);
    }

    // Si el reporte mensual del mes actual esta abierto, actualizar vista
    if (_mrYear === expenseDate.getFullYear() && _mrMonth === expenseDate.getMonth()) {
        setMrData(mrData);
        generateMonthlyReport();
    }

    // Limpiar formulario
    document.getElementById('expenseCategory').value = '';
    document.getElementById('expenseDescription').value = '';
    document.getElementById('expenseAmount').value = '';
    document.getElementById('expensePaymentMethod').value = '';

    updateExpensesTotal();
    if (currentUser && currentUser.role === 'director') {
        updateExpensesByPaymentMethod('day');
        updateExpensesByCategory('day');
    }

    const paymentIcon = paymentMethod === 'efectivo' ? '💵' : '🏦';
    showToast(`Gasto registrado: $${amount.toFixed(2)} (${paymentIcon} ${paymentMethodNames[paymentMethod]})`, 'success');
}

export function renderExpensesLog(filter = 'all') {
    const log = document.getElementById('expensesLog');
    if (!log) {
        console.warn('[Expenses] expensesLog element not found in DOM');
        return;
    }

    // FIXED: Filtrar gastos eliminados (soft delete)
    let filteredExpenses = expenses.filter(e => !e.deleted);
    if (filter !== 'all') {
        filteredExpenses = filteredExpenses.filter(e => e.categoryType === filter);
    }

    // Ordenar por timestamp descendente
    const sortedExpenses = [...filteredExpenses].sort((a, b) => b.timestamp - a.timestamp);

    if (sortedExpenses.length === 0) {
        log.innerHTML = '<p class="no-expenses">No hay gastos registrados</p>';
        return;
    }

    const categoryIcons = {
        'operacion': '⚙️',
        'alimentos': '🍽️',
        'limpieza': '🧹',
        'sexshop': '🛍️',
        'generales': '📦',
        'mercadotecnia': '📢',
        'nomina': '💼'
    };

    log.innerHTML = sortedExpenses.slice(0, 20).map(expense => {
        const date = new Date(expense.timestamp);
        const icon = categoryIcons[expense.categoryType] || '📌';
        const paymentIcon = expense.paymentMethod === 'efectivo' ? '💵' : '💳';

        return `
            <div class="expense-item" data-category="${expense.categoryType}">
                <div class="expense-icon">${icon}</div>
                <div class="expense-details">
                    <div class="expense-header">
                        <span class="expense-category">${sanitizeHTML(expense.category)}</span>
                        <span class="expense-amount">-$${expense.amount.toFixed(2)} ${paymentIcon}</span>
                    </div>
                    <div class="expense-description">${sanitizeHTML(expense.description)}</div>
                    <div class="expense-date">${date.toLocaleString('es-MX')}</div>
                </div>
                <button class="btn-delete-expense" onclick="deleteExpense(${expense.id})">&times;</button>
            </div>
        `;
    }).join('');
}

export async function deleteExpense(expenseId) {
    const confirmed = await showCustomConfirm('Eliminar Gasto', '¿Estás seguro de eliminar este gasto?');
    if (!confirmed) {
        return;
    }

    const expense = expenses.find(e => e.id === expenseId);
    if (expense) {
        expense.deleted = true; // FIXED: Soft delete
        expense.deletedAt = Date.now(); // FIXED: Timestamp de eliminación
        saveData();
        updateExpensesTotal();
        renderExpensesLog(); // FIXED: Re-renderizar para aplicar filtro
        
        // Actualizar estadísticas de gastos (solo para director)
        if (currentUser && currentUser.role === 'director') {
            updateExpensesByPaymentMethod('day');
            updateExpensesByCategory('day');
        }
    }
}

export function updateExpensesTotal() {
    const totalCard = document.getElementById('expensesTotalCard');
    if (!totalCard) return;
    
    // Calcular total de gastos del TURNO ACTUAL (desde currentShiftStart)
    const currentShift = getCurrentShift();
    const shiftExpenses = expenses.filter(e =>
        !e.deleted && e.timestamp >= currentShiftStart && e.shift === currentShift.type
    );
    const total = shiftExpenses.reduce((sum, e) => sum + e.amount, 0);
    
    totalCard.textContent = `$${total.toFixed(2)}`;
}

export function updateExpensesSummary(period = 'day', shift = 'all') {
    const now = Date.now();
    let timeAgo;
    
    if (period === 'day') {
        timeAgo = now - (24 * 60 * 60 * 1000);
    } else if (period === 'week') {
        timeAgo = now - (7 * 24 * 60 * 60 * 1000);
    } else {
        timeAgo = now - (30 * 24 * 60 * 60 * 1000);
    }
    
    let periodExpenses = expenses.filter(e => !e.deleted && e.timestamp >= timeAgo);

    // Filtrar por turno usando el campo 'shift' guardado
    if (shift !== 'all') {
        periodExpenses = periodExpenses.filter(expense => {
            // Si el gasto tiene el campo shift guardado, usarlo
            if (expense.shift) {
                return expense.shift === shift;
            }
            // Si no tiene el campo (gastos antiguos), calcular por hora
            const expenseDate = new Date(expense.timestamp);
            const hour = expenseDate.getHours();
            
            if (shift === 'day') {
                return hour >= 6 && hour < 18;
            } else if (shift === 'night') {
                return hour >= 18 || hour < 6;
            }
            return true;
        });
    }
    
    // Agrupar por categoría
    const byCategory = {};
    periodExpenses.forEach(expense => {
        const cat = expense.categoryType;
        if (!byCategory[cat]) {
            byCategory[cat] = 0;
        }
        byCategory[cat] += expense.amount;
    });
    
    const total = periodExpenses.reduce((sum, e) => sum + e.amount, 0);
    
    const categoryNames = {
        'gas': 'Gas',
        'agua': 'Agua',
        'limpieza': 'Limpieza',
        'mantenimiento': 'Mantenimiento',
        'servicios': 'Servicios',
        'nomina': 'N?mina',
        'otros': 'Otros'
    };
    
    const categoryIcons = {
        'gas': '🔥',
        'agua': '💧',
        'limpieza': '🧹',
        'mantenimiento': '🔧',
        'servicios': '🏠',
        'nomina': '💼',
        'otros': '📦'
    };
    
    const container = document.getElementById('expensesSummary');
    if (!container) {
        console.warn('[Expenses] expensesSummary element not found');
        return;
    }
    
    let html = `
        <div class="expense-total-card">
            <div class="total-label">Total de Gastos</div>
            <div class="total-amount">$${total.toFixed(2)}</div>
            <div class="total-count">${periodExpenses.length} transacciones</div>
        </div>
        <div class="expenses-by-category">
    `;
    
    Object.entries(byCategory).forEach(([cat, amount]) => {
        const percentage = total > 0 ? (amount / total * 100).toFixed(1) : 0;
        html += `
            <div class="category-expense-item">
                <div class="category-info">
                    <span class="category-icon">${categoryIcons[cat]}</span>
                    <span class="category-name">${categoryNames[cat]}</span>
                </div>
                <div class="category-amount-info">
                    <span class="category-amount">$${amount.toFixed(2)}</span>
                    <span class="category-percentage">${percentage}%</span>
                </div>
            </div>
        `;
    });
    
    html += '</div>';
    container.innerHTML = html;
}

export function openExpensesSummaryModal() {
    setCurrentExpensesPeriod('day');
    setCurrentExpensesShift('all');
    document.getElementById('expensesSummaryModal').classList.add('show');
    renderExpensesSummaryModal();
}

export function closeExpensesSummaryModal() {
    document.getElementById('expensesSummaryModal').classList.remove('show');
}

export function filterExpensesSummary(period) {
    setCurrentExpensesPeriod(period);
    document.querySelectorAll('#expensesSummaryModal .revenue-detail-filters:first-of-type .filter-btn').forEach(b => b.classList.remove('active'));
    if (event && event.target) event.target.classList.add('active');
    renderExpensesSummaryModal();
}

export function filterExpensesShift(shift) {
    setCurrentExpensesShift(shift);
    document.querySelectorAll('#expensesSummaryModal .revenue-detail-filters:last-of-type .filter-btn').forEach(b => b.classList.remove('active'));
    if (event && event.target) event.target.classList.add('active');
    renderExpensesSummaryModal();
}

export function renderExpensesSummaryModal() {
    const container = document.getElementById('expensesSummaryModalContent');
    if (!container) return;
    const now = Date.now();
    const timeAgo = currentExpensesPeriod === 'day' ? now - 86400000 : currentExpensesPeriod === 'week' ? now - 604800000 : now - 2592000000;
    let periodExpenses = expenses.filter(e => !e.deleted && e.timestamp >= timeAgo);
    if (currentExpensesShift !== 'all') periodExpenses = periodExpenses.filter(e => e.shift === currentExpensesShift);
    const total = periodExpenses.reduce((s, e) => s + e.amount, 0);
    const byCategory = {};
    periodExpenses.forEach(e => { byCategory[e.categoryType] = (byCategory[e.categoryType] || 0) + e.amount; });
    const catNames = { operacion: 'Operación', alimentos: 'Alimentos', limpieza: 'Limpieza', sexshop: 'Sex Shop', generales: 'Generales', mercadotecnia: 'Mercadotecnia', nomina: 'Nómina' };
    container.innerHTML = `<div style="background:linear-gradient(135deg,#fa709a,#fee140);color:white;border-radius:10px;padding:18px;text-align:center;margin:16px 0;">
        <div style="font-size:12px;opacity:.85;text-transform:uppercase;letter-spacing:.8px;">Total Gastos</div>
        <div style="font-size:32px;font-weight:800;">$${total.toFixed(2)}</div>
        <div style="font-size:12px;opacity:.8;">${periodExpenses.length} transacciones</div>
    </div>
    <div>${Object.entries(byCategory).map(([cat, amt]) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:#f8f9fa;border-radius:8px;margin-bottom:6px;">
            <span style="font-size:13px;color:#2c3e50;">${sanitizeHTML(catNames[cat] || cat)}</span>
            <span style="font-weight:700;color:#e74c3c;">$${amt.toFixed(2)}</span>
        </div>`).join('')}
    </div>`;
}

export function updateExpensesByPaymentMethod(period = 'day') {
    const container = document.getElementById('expensesByPaymentStats');
    if (!container) return;
    const timeAgo = getPeriodStart(period);
    const periodExpenses = expenses.filter(e => !e.deleted && e.timestamp >= timeAgo);
    const pm = { efectivo: 0, banco: 0 };
    periodExpenses.forEach(e => { pm[e.paymentMethod || 'efectivo'] = (pm[e.paymentMethod || 'efectivo'] || 0) + e.amount; });
    const total = periodExpenses.reduce((s, e) => s + e.amount, 0);
    container.innerHTML = `
        <div class="sc-stat-item"><span class="sc-stat-item-label">💵 Efectivo</span><span class="sc-stat-item-value" style="color:#e74c3c;">$${(pm.efectivo||0).toFixed(2)}</span></div>
        <div class="sc-stat-item"><span class="sc-stat-item-label">🏦 Banco</span><span class="sc-stat-item-value" style="color:#e74c3c;">$${(pm.banco||0).toFixed(2)}</span></div>
        <div class="sc-stat-item" style="border-top:2px solid #eee;margin-top:4px;padding-top:8px;"><span class="sc-stat-item-label" style="font-weight:700;">Total</span><span class="sc-stat-item-value" style="color:#e74c3c;font-weight:800;">$${total.toFixed(2)}</span></div>`;
}

export function updateExpensesByCategory(period = 'day') {
    const container = document.getElementById('expensesByCategoryStats');
    if (!container) return;
    const timeAgo = getPeriodStart(period);
    const periodExpenses = expenses.filter(e => !e.deleted && e.timestamp >= timeAgo);
    const byCategory = {};
    periodExpenses.forEach(e => { byCategory[e.categoryType] = (byCategory[e.categoryType] || 0) + e.amount; });
    const catNames = { operacion: '💧 Operación', alimentos: '🍽️ Alimentos', limpieza: '🧹 Limpieza', sexshop: '🛍️ Sex Shop', generales: '📦 Generales', mercadotecnia: '📢 Mercadotecnia', nomina: '💼 Nómina' };
    const sorted = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) { container.innerHTML = '<p style="color:#999;text-align:center;font-size:13px;">Sin gastos en este período</p>'; return; }
    container.innerHTML = sorted.map(([cat, amt]) =>
        `<div class="sc-stat-item"><span class="sc-stat-item-label">${catNames[cat] || cat}</span><span class="sc-stat-item-value" style="color:#e74c3c;">$${amt.toFixed(2)}</span></div>`
    ).join('');
}

window.deleteExpense = deleteExpense;

window.closeExpensesSummaryModal = closeExpensesSummaryModal;
window.filterExpensesShift = filterExpensesShift;
window.filterExpensesSummary = filterExpensesSummary;
window.renderExpensesLog = renderExpensesLog;