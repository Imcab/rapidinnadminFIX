import {
    _mrData, _mrMonth, _mrYear, _currentWeek, _payrollEmployees, _editingEmployeeId, _mrUnlistenFn,
    setMrData, setMrMonth, setMrYear, setCurrentWeek, setPayrollEmployees, setEditingEmployeeId,
    setMrUnlistenFn, _appReady, reservations
} from '../app.js';

import { fmt, isCardOrBankPayment, isCashPayment, sanitizeHTML, showCustomConfirm } from '../utils/formatters.js';
import { downloadShiftDayReport } from './shifts.js';
import { ensureMonthDataLoaded } from '../utils/storage-utils.js';
import { getWeekRanges, updateWeekDateRange } from '../utils/time.js';
import { showToast } from '../utils/toast-system.js';
import { getMonthRecords, getHotWindowMonths } from '../utils/hot-window.js';

// ============================================================================
// MONTHLY REPORT + PAYROLL — Reporte Mensual completo (ingresos diarios,
// gastos, movimientos de efectivo/banco, cierre por mes) y Nómina semanal.
// Es, por mucho, el subsistema más grande que quedaba en app.js.
// Extraído de app.js tal cual (sin convertir a módulo ES todavía).
// ============================================================================

export function setupMrDataListener() {
    // Cancelar listener del mes anterior si existe
    if (_mrUnlistenFn) { _mrUnlistenFn(); setMrUnlistenFn(null); }
    if (!window.FirebaseSync || !window.FirebaseSync.listenKey) return;
    const fbKey = 'mr_' + getMonthlyReportKey();
    setMrUnlistenFn(window.FirebaseSync.listenKey(fbKey, (key, val) => {
        console.log('[App] Reporte mensual actualizado desde otro dispositivo:', key);
        setMrData(val);
        localStorage.setItem(getMonthlyReportKey(), JSON.stringify(_mrData));
        loadPayrollEmployees();
        generateMonthlyReport();
        renderWeeklyEmployees();
        updateWeeklySummary();
    }));
}

export async function reconcileExpensesWithMrData() {
    await ensureMonthDataLoaded(_mrYear, _mrMonth);
    const monthExpenses = getMonthRecords(_mrYear, _mrMonth, 'expenses').filter(e => !e.deleted);
    if (monthExpenses.length === 0) return;

    let changed = false;
    monthExpenses.forEach(expense => {
        const expenseDate = new Date(expense.timestamp);
        const todayStr = expenseDate.toISOString().split('T')[0];
        const newItem = {
            category: expense.categoryType,
            concept: expense.description,
            date: todayStr,
            amount: expense.amount,
            _expenseId: expense.id // referencia para evitar duplicados
        };

        // Verificar si ya existe en _mrData (por _expenseId)
        const isDirect = expense.categoryType !== 'mercadotecnia';
        const list = isDirect ? (_mrData.directExpenses || []) : (_mrData.indirectExpenses || []);
        const alreadyExists = list.some(e => e._expenseId === expense.id);

        if (!alreadyExists) {
            if (isDirect) {
                if (!_mrData.directExpenses) _mrData.directExpenses = [];
                _mrData.directExpenses.push(newItem);
            } else {
                if (!_mrData.indirectExpenses) _mrData.indirectExpenses = [];
                _mrData.indirectExpenses.push(newItem);
            }
            changed = true;
        }
    });

    if (changed) {
        saveMonthlyReportData();
    }
}

export async function initMonthlyReport() {
    const now = new Date();
    const monthSel = document.getElementById('reportMonth');
    const yearSel = document.getElementById('reportYear');
    
    // Poblar años (actual y 2 años anteriores)
    const currentYear = now.getFullYear();
    yearSel.innerHTML = '';
    for (let y = currentYear - 2; y <= currentYear; y++) {
        const option = document.createElement('option');
        option.value = y;
        option.textContent = y;
        if (y === currentYear) option.selected = true;
        yearSel.appendChild(option);
    }
    
    // Poblar meses
    const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    monthSel.innerHTML = '';
    months.forEach((month, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = month;
        if (index === now.getMonth()) option.selected = true;
        monthSel.appendChild(option);
    });
    
    setMrMonth(now.getMonth());
    setMrYear(now.getFullYear());
    loadMonthlyReportData();
    loadPayrollEmployees();
    await reconcileExpensesWithMrData();
    await generateMonthlyReport();
    initMrCollapsible();

    // Inicializar semana actual
    updateWeekDateRange();
    renderWeeklyEmployees();
    updateWeeklySummary();

    // Configurar event listeners para nómina
    setupPayrollEventListeners();

    // Listener en tiempo real para nómina/reporte mensual
    setupMrDataListener();
}

export function setupPayrollEventListeners() {
    const payrollName = document.getElementById('payrollName');
    const payrollDailyRate = document.getElementById('payrollDailyRate');
    const payrollDays = document.getElementById('payrollDays');

    // Usar onclick para que nunca se acumulen handlers duplicados
    if (payrollName) payrollName.oninput = calculatePayrollTotal;
    if (payrollDailyRate) payrollDailyRate.oninput = calculatePayrollTotal;
    if (payrollDays) payrollDays.oninput = calculatePayrollTotal;

    const btnSavePayroll = document.getElementById('btnSavePayroll');
    if (btnSavePayroll) {
        btnSavePayroll.onclick = (e) => {
            e.preventDefault();
            savePayrollEmployee();
        };
    }
}

export function getMonthlyReportKey() { return `mrData_${_mrYear}_${_mrMonth}`; }

export function initMrCollapsible() {
    document.querySelectorAll('.mr-section').forEach(section => {
        const title = section.querySelector('.mr-section-title');
        if (!title || title.dataset.collapsible) return;
        title.dataset.collapsible = '1';

        // Envolver todo lo que no sea el título en un mr-section-body
        const children = Array.from(section.children).filter(el => !el.classList.contains('mr-section-title'));
        const body = document.createElement('div');
        body.className = 'mr-section-body';
        children.forEach(el => body.appendChild(el));
        section.appendChild(body);

        title.addEventListener('click', () => {
            const isCollapsed = body.classList.toggle('collapsed');
            title.classList.toggle('collapsed', isCollapsed);
        });
    });
}

export function saveMonthlyReportData() {
    localStorage.setItem(getMonthlyReportKey(), JSON.stringify(_mrData));
    // CRÍTICO: Siempre guardar en Firebase
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        window.FirebaseSync.saveMrData(getMonthlyReportKey(), _mrData).catch(err => {
            console.error('[Firebase] Error guardando reporte mensual:', err);
            showToast('⚠️ Error sincronizando reporte mensual', 'error');
        });
    }
}

export function loadMonthlyReportData() {
    const fallback = { directExpenses: [], indirectExpenses: [], nonOpExpenses: [], salaries: [], efectivoMovimientos: [], bancoMovimientos: [], efectivoAnterior: 0, bancoAnterior: 0 };
    try {
        const saved = localStorage.getItem(getMonthlyReportKey());
        setMrData(saved ? JSON.parse(saved) : fallback);
    } catch(e) { setMrData(fallback); }
    // Intentar cargar desde Firebase (actualiza si hay datos más recientes)
    if (window.FirebaseSync && window.FirebaseSync.ready) {
        window.FirebaseSync.loadMrData(getMonthlyReportKey(), null).then(fbData => {
            if (fbData) {
                setMrData(fbData);
                localStorage.setItem(getMonthlyReportKey(), JSON.stringify(_mrData));
                loadPayrollEmployees();
                generateMonthlyReport();
                renderWeeklyEmployees();
                updateWeeklySummary();
            }
        });
    }
}

export function onWeekChange() {
    const weekSelector = document.getElementById('weekSelector');
    setCurrentWeek(parseInt(weekSelector.value));
    
    updateWeekDateRange();
    renderWeeklyEmployees();
    updateWeeklySummary();
}

export function openPayrollModal(employeeId = null) {
    const modal = document.getElementById('payrollModal');
    setEditingEmployeeId(employeeId);
    
    if (employeeId) {
        // Editar empleado existente
        const employee = _payrollEmployees.find(e => e.id === employeeId);
        if (employee) {
            document.getElementById('payrollName').value = employee.name;
            document.getElementById('payrollShift').value = employee.shift;
            document.getElementById('payrollDepartment').value = employee.department;
            document.getElementById('payrollDailyRate').value = employee.dailyRate;
            document.getElementById('payrollDays').value = employee.days;
            document.getElementById('payrollTotal').value = employee.total;
            document.getElementById('payrollNotes').value = employee.notes || '';
            // Marcar las semanas del empleado
            const empWeeks = employee.weeks || (employee.week ? [employee.week] : [1,2,3,4,5]);
            _setPayrollWeeks(empWeeks);
        }
    } else {
        // Nuevo empleado
        resetPayrollForm();
        // Si hay semana específica seleccionada, pre-marcar solo esa; si no, marcar todas
        if (_currentWeek > 0) {
            _setPayrollWeeks([_currentWeek]);
        }
    }
    
    modal.classList.add('show');
}

export function togglePayrollWeek(btn) {
    btn.classList.toggle('active');
    const week = btn.dataset.week;
    const cb = document.getElementById(`payrollWeek${week}`);
    if (cb) cb.checked = btn.classList.contains('active');
}

export function _setPayrollWeeks(selectedWeeks) {
    document.querySelectorAll('.payroll-week-btn').forEach(btn => {
        const w = parseInt(btn.dataset.week);
        const on = selectedWeeks.includes(w);
        btn.classList.toggle('active', on);
        const cb = document.getElementById(`payrollWeek${w}`);
        if (cb) cb.checked = on;
    });
}

export function closePayrollModal() {
    document.getElementById('payrollModal').classList.remove('show');
    setEditingEmployeeId(null);
    resetPayrollForm();
}

export function resetPayrollForm() {
    document.getElementById('payrollName').value = '';
    document.getElementById('payrollShift').value = 'dia';
    document.getElementById('payrollDepartment').value = 'lavanderia';
    document.getElementById('payrollDailyRate').value = '';
    document.getElementById('payrollDays').value = '';
    document.getElementById('payrollTotal').value = '';
    document.getElementById('payrollNotes').value = '';
    _setPayrollWeeks([1,2,3,4,5]); // todas activas por defecto
}

export function calculatePayrollTotal() {
    const dailyRate = parseFloat(document.getElementById('payrollDailyRate').value) || 0;
    const days = parseInt(document.getElementById('payrollDays').value) || 0;
    const total = dailyRate * days;
    
    document.getElementById('payrollTotal').value = total.toFixed(2);
}

export function savePayrollEmployee() {
    const name = document.getElementById('payrollName').value.trim();
    const weeks = [1,2,3,4,5].filter(w => document.getElementById(`payrollWeek${w}`)?.checked);
    const shift = document.getElementById('payrollShift').value;
    const department = document.getElementById('payrollDepartment').value;
    const dailyRate = parseFloat(document.getElementById('payrollDailyRate').value) || 0;
    const days = parseInt(document.getElementById('payrollDays').value) || 0;
    const total = parseFloat(document.getElementById('payrollTotal').value) || 0;
    const notes = document.getElementById('payrollNotes').value.trim();
    
    if (!name) {
        showToast('Por favor ingresa el nombre del empleado', 'error');
        return;
    }
    
    if (weeks.length === 0) {
        showToast('Selecciona al menos una semana', 'error');
        return;
    }

    if (dailyRate <= 0) {
        showToast('La tarifa diaria debe ser mayor a 0', 'error');
        return;
    }

    if (days <= 0) {
        showToast('Los días trabajados deben ser mayor a 0', 'error');
        return;
    }
    
    if (_editingEmployeeId) {
        // Actualizar empleado existente
        const index = _payrollEmployees.findIndex(e => e.id === _editingEmployeeId);
        if (index !== -1) {
            _payrollEmployees[index] = {
                ..._payrollEmployees[index],
                name,
                shift,
                department,
                dailyRate,
                days,
                total,
                notes,
                weeks
            };
        }

        if (!_mrData.payrollEmployees) _mrData.payrollEmployees = [];
        const empIndex = _mrData.payrollEmployees.findIndex(e => e.id === _editingEmployeeId);
        if (empIndex !== -1) {
            _mrData.payrollEmployees[empIndex] = {
                ..._mrData.payrollEmployees[empIndex],
                name,
                shift,
                department,
                dailyRate,
                days,
                total,
                notes,
                weeks
            };
        } else {
            // Si no está en _mrData pero sí en _payrollEmployees, sincronizar
            _mrData.payrollEmployees.push(_payrollEmployees[_payrollEmployees.findIndex(e => e.id === _editingEmployeeId)]);
        }
    } else {
        // Verificar si ya existe un empleado con el mismo nombre, turno y departamento
        const existingEmployee = _payrollEmployees.find(e => 
            e.name === name && 
            e.shift === shift && 
            e.department === department
        );
        
        if (existingEmployee) {
            showToast('Este empleado ya existe en la nómina', 'error');
            return;
        }
        
        // Crear UN solo empleado para el mes con las semanas seleccionadas
        const newEmployee = {
            id: `${Date.now()}_${_mrYear}_${_mrMonth}`,
            name,
            shift,
            department,
            dailyRate,
            days,
            total,
            notes,
            weeks,
            month: _mrMonth,
            year: _mrYear,
            createdAt: Date.now()
        };
        
        // Agregar al mes actual
        _payrollEmployees.push(newEmployee);
        if (!_mrData.payrollEmployees) _mrData.payrollEmployees = [];
        _mrData.payrollEmployees.push(newEmployee);
        
        // Copiar a los próximos 12 meses
        for (let monthOffset = 1; monthOffset <= 12; monthOffset++) {
            const futureDate = new Date(_mrYear, _mrMonth + monthOffset, 1);
            const futureMonth = futureDate.getMonth();
            const futureYear = futureDate.getFullYear();
            const futureKey = `mrData_${futureYear}_${futureMonth}`;
            
            let futureMrData = JSON.parse(localStorage.getItem(futureKey)) || {};
            if (!futureMrData.payrollEmployees) futureMrData.payrollEmployees = [];
            
            // Agregar UN empleado para todo el mes futuro
            futureMrData.payrollEmployees.push({
                id: `${Date.now()}_${futureYear}_${futureMonth}`,
                name,
                shift,
                department,
                dailyRate,
                days,
                total,
                notes,
                weeks,
                month: futureMonth,
                year: futureYear,
                createdAt: Date.now()
            });
            
            localStorage.setItem(futureKey, JSON.stringify(futureMrData));
            if (window.FirebaseSync?.ready) {
                window.FirebaseSync.saveMrData(futureKey, futureMrData);
            }
        }
    }
    
    saveMonthlyReportData();
    renderWeeklyEmployees();
    updateWeeklySummary();
    closePayrollModal();
    showToast(`Empleado ${_editingEmployeeId ? 'actualizado' : 'agregado'} exitosamente`, 'success');
}

export function deletePayrollEmployee(employeeId) {
    const employee = _payrollEmployees.find(e => e.id === employeeId);
    if (!employee) return;

    showCustomConfirm('Eliminar Empleado', `¿Eliminar a ${employee.name} de este mes?`).then(confirmDelete => {
        if (!confirmDelete) return;

        showCustomConfirm('¿Eliminar de meses futuros?', `¿También eliminar a ${employee.name} de todos los meses futuros?`).then(deleteFromFuture => {
            // Eliminar del mes actual
            setPayrollEmployees(_payrollEmployees.filter(e => e.id !== employeeId));
            if (_mrData.payrollEmployees) {
                _mrData.payrollEmployees = _mrData.payrollEmployees.filter(e => e.id !== employeeId);
            }

            if (deleteFromFuture) {
                for (let monthOffset = 1; monthOffset <= 12; monthOffset++) {
                    const futureDate = new Date(_mrYear, _mrMonth + monthOffset, 1);
                    const futureKey = `mrData_${futureDate.getFullYear()}_${futureDate.getMonth()}`;
                    const storedData = localStorage.getItem(futureKey);
                    if (storedData) {
                        try {
                            let futureMrData = JSON.parse(storedData);
                            if (futureMrData.payrollEmployees) {
                                futureMrData.payrollEmployees = futureMrData.payrollEmployees.filter(e =>
                                    !(e.name === employee.name && e.department === employee.department && e.shift === employee.shift)
                                );
                                localStorage.setItem(futureKey, JSON.stringify(futureMrData));
                                if (window.FirebaseSync?.ready) {
                                    window.FirebaseSync.saveMrData(futureKey, futureMrData);
                                }
                            }
                        } catch (e) { /* ignorar errores de parse */ }
                    }
                }
            }

            saveMonthlyReportData();
            renderWeeklyEmployees();
            updateWeeklySummary();
            showToast('Empleado eliminado exitosamente', 'success');
        });
    });
}

export function renderWeeklyEmployees() {
    const grid = document.getElementById('weeklyEmployeesGrid');
    const title = document.getElementById('weeklyEmployeesTitle');
    
    if (!grid) return;
    
    let filteredEmployees = _payrollEmployees;
    
    // Filtrar por semana si no es "todo el mes"
    if (_currentWeek > 0) {
        // Mostrar solo empleados que trabajan en esta semana
        filteredEmployees = _payrollEmployees.filter(e => {
            // Si el empleado tiene el campo 'weeks', verificar que incluya la semana actual
            if (e.weeks && Array.isArray(e.weeks)) {
                return e.weeks.includes(_currentWeek);
            }
            // Compatibilidad con formato antiguo (empleados con campo 'week')
            return e.week === _currentWeek;
        });
    }
    
    // Actualizar título
    if (_currentWeek === 0) {
        title.textContent = `Empleados de ${['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'][_mrMonth]} ${_mrYear}`;
    } else {
        title.textContent = `Empleados de la Semana ${_currentWeek}`;
    }
    
    if (filteredEmployees.length === 0) {
        grid.innerHTML = '<div class="no-employees">No hay empleados registrados para este período</div>';
        return;
    }
    
    const shiftLabels = {
        'dia': 'Día',
        'noche': 'Noche',
        'dia-fin-semana': 'Día, Fin de Semana',
        'noche-fin-semana': 'Noche, Fin de Semana'
    };
    
    const departmentLabels = {
        'lavanderia': 'Lavandería',
        'recepcion': 'Recepción',
        'limpieza': 'Limpieza',
        'suites-lm': 'Suites LM',
        'casa': 'Casa'
    };
    
    grid.innerHTML = filteredEmployees.map(employee => {
        const departmentName = sanitizeHTML(departmentLabels[employee.department] || employee.department);
        const empWeeks = employee.weeks && Array.isArray(employee.weeks)
            ? employee.weeks.slice().sort((a, b) => a - b)
            : (employee.week ? [employee.week] : []);
        const weeksLabel = empWeeks.length > 0 ? `Sem. ${empWeeks.join(', ')}` : '';
        const weeksCount = empWeeks.length || 1;
        const monthlyTotal = employee.total * weeksCount;

        return `
            <div class="employee-card">
                <div class="employee-header">
                    <div>
                        <div class="employee-name">${sanitizeHTML(employee.name)}</div>
                        ${weeksLabel ? `<div style="font-size:11px;color:#8a98a8;margin-top:2px;">${weeksLabel}</div>` : ''}
                    </div>
                    <div class="employee-actions">
                        <button class="btn-employee-action btn-edit-employee" onclick="openPayrollModal('${employee.id}')" title="Editar">✏️</button>
                        <button class="btn-employee-action btn-delete-employee" onclick="deletePayrollEmployee('${employee.id}')" title="Eliminar">🗑️</button>
                    </div>
                </div>
                <div class="employee-details">
                    <div class="employee-detail">
                        <div class="detail-label">Turno</div>
                        <div class="detail-value">${shiftLabels[employee.shift] || employee.shift}</div>
                    </div>
                    <div class="employee-detail">
                        <div class="detail-label">Departamento</div>
                        <div class="detail-value">${departmentName}</div>
                    </div>
                    <div class="employee-detail">
                        <div class="detail-label">Tarifa/Día</div>
                        <div class="detail-value">$${employee.dailyRate.toFixed(2)}</div>
                    </div>
                    <div class="employee-detail">
                        <div class="detail-label">Días/Sem.</div>
                        <div class="detail-value">${employee.days}</div>
                    </div>
                </div>
                <div class="employee-total">
                    <div class="total-label">Total mensual (${weeksCount} sem.)</div>
                    <div class="total-amount">$${monthlyTotal.toFixed(2)}</div>
                </div>
                ${employee.notes ? `<div style="margin-top:8px;padding:8px;background:#f8f9fa;border-radius:4px;font-size:12px;color:#6c757d;"><strong>Notas:</strong> ${sanitizeHTML(employee.notes)}</div>` : ''}
            </div>
        `;
    }).join('');
}

export function updateWeeklySummary() {
    const weeks = getWeekRanges(_mrYear, _mrMonth);
    
    // Ocultar/mostrar semana 5 si no existe
    const week5Card = document.getElementById('week5Card');
    if (week5Card) {
        week5Card.style.display = weeks.length >= 5 ? 'block' : 'none';
    }
    
    // Actualizar cada semana
    for (let i = 1; i <= 5; i++) {
        const weekTotalEl = document.getElementById(`week${i}Total`);
        const weekDatesEl = document.getElementById(`week${i}Dates`);
        
        if (!weekTotalEl || !weekDatesEl) continue;
        
        // Filtrar empleados que trabajan en esta semana
        const weekEmployees = _payrollEmployees.filter(e => {
            if (e.weeks && Array.isArray(e.weeks)) {
                return e.weeks.includes(i);
            }
            // Compatibilidad con formato antiguo
            return e.week === i;
        });
        const weekTotal = weekEmployees.reduce((sum, e) => sum + e.total, 0);
        
        weekTotalEl.textContent = `$${weekTotal.toFixed(2)}`;
        
        const weekData = weeks.find(w => w.week === i);
        if (weekData) {
            weekDatesEl.textContent = `${weekData.startStr} - ${weekData.endStr}`;
        } else {
            weekDatesEl.textContent = '';
        }
    }
}

export function loadPayrollEmployees() {
    // Cargar empleados del mes actual
    setPayrollEmployees([]);
    
    if (_mrData.payrollEmployees && _mrData.payrollEmployees.length > 0) {
        // Cargar desde _mrData si existe
        setPayrollEmployees(_mrData.payrollEmployees.filter(e => 
            e.month === _mrMonth && e.year === _mrYear
        ));
    }
    
    // Si _mrData no tiene empleados, intentar cargar desde localStorage
    if (_payrollEmployees.length === 0) {
        const currentKey = `mrData_${_mrYear}_${_mrMonth}`;
        const storedData = localStorage.getItem(currentKey);
        
        if (storedData) {
            try {
                const parsedData = JSON.parse(storedData);
                if (parsedData.payrollEmployees && parsedData.payrollEmployees.length > 0) {
                    setPayrollEmployees(parsedData.payrollEmployees.filter(e => 
                        e.month === _mrMonth && e.year === _mrYear
                    ));
                    // Sincronizar con _mrData
                    if (!_mrData.payrollEmployees) _mrData.payrollEmployees = [];
                    _mrData.payrollEmployees = _payrollEmployees;
                }
            } catch (e) {
                console.error('Error parsing payroll data:', e);
            }
        }
    }
    
    // MIGRACIÓN: Convertir empleados del formato antiguo (uno por semana) al nuevo formato (uno por mes)
    migrateOldPayrollFormat();
}

export function migrateOldPayrollFormat() {
    // Detectar si hay empleados en formato antiguo (con campo 'week' en lugar de 'weeks')
    const oldFormatEmployees = _payrollEmployees.filter(e => e.week && !e.weeks);
    
    if (oldFormatEmployees.length === 0) return; // No hay nada que migrar
    
    // Agrupar empleados por nombre, turno y departamento
    const employeeGroups = new Map();
    
    oldFormatEmployees.forEach(emp => {
        const key = `${emp.name}_${emp.shift}_${emp.department}`;
        
        if (!employeeGroups.has(key)) {
            employeeGroups.set(key, {
                ...emp,
                weeks: [emp.week],
                id: `${Date.now()}_${_mrYear}_${_mrMonth}` // Nuevo ID único para el mes
            });
        } else {
            const existing = employeeGroups.get(key);
            if (!existing.weeks.includes(emp.week)) {
                existing.weeks.push(emp.week);
            }
        }
    });
    
    // Eliminar empleados en formato antiguo
    setPayrollEmployees(_payrollEmployees.filter(e => !e.week || e.weeks));
    
    // Agregar empleados migrados
    const migratedEmployees = Array.from(employeeGroups.values());
    _payrollEmployees.push(...migratedEmployees);
    
    // Actualizar _mrData
    if (!_mrData.payrollEmployees) _mrData.payrollEmployees = [];
    _mrData.payrollEmployees = _mrData.payrollEmployees.filter(e => 
        !(e.month === _mrMonth && e.year === _mrYear && e.week && !e.weeks)
    );
    _mrData.payrollEmployees.push(...migratedEmployees);
    
    // Guardar cambios
    saveMonthlyReportData();
}

export function getMonthRange() {
    // Inicio: dia 1 a las 6:00 AM. Fin: dia 1 del mes siguiente a las 5:59:59 AM
    // El turno nocturno del ultimo dia queda dentro del mes actual
    const start = new Date(_mrYear, _mrMonth, 1, 6, 0, 0).getTime();
    const end = new Date(_mrYear, _mrMonth + 1, 1, 5, 59, 59).getTime();
    return { start, end };
}

export function getMonthRangeFor(year, month) {
    const start = new Date(year, month, 1, 6, 0, 0).getTime();
    const end = new Date(year, month + 1, 1, 5, 59, 59).getTime();
    return { start, end };
}

export function markMrAnterioresEdited() {
    _mrData.anterioresUserEdited = true;
    recalcMonthlyReport();
}

export function mrSaldoAnteriorInput(isEfec) {
    _mrData.anterioresUserEdited = true;
    const id = isEfec ? 'mr-efectivo-anterior' : 'mr-banco-anterior';
    const el = document.getElementById(id);
    if (el && !String(el.value).trim()) {
        if (isEfec) _mrData.efectivoAnterior = null;
        else _mrData.bancoAnterior = null;
        saveMonthlyReportData();
    }
    recalcMonthlyReport();
}

export async function syncTarjetaVentasToBancoInto(targetMr, year, month) {
    const { start, end } = getMonthRangeFor(year, month);
    await ensureMonthDataLoaded(year, month);
    if (!targetMr.bancoMovimientos) targetMr.bancoMovimientos = [];
    targetMr.bancoMovimientos = targetMr.bancoMovimientos.filter(m => !m.autoGenerated);

    const monthRooms = getMonthRecords(year, month, 'revenue').filter(r =>
        (r.type === 'sold' || r.type === 'renewal') &&
        isCardOrBankPayment(r.paymentMethod)
    );
    monthRooms.forEach(room => {
        const date = new Date(room.timestamp).toISOString().split('T')[0];
        const rn = room.roomNumber || room.number || 'N/A';
        const concept = `Hab. ${rn} (${room.building === 'regulares' ? 'Ed.1' : 'Torre'}) - ${room.guestName || 'Sin nombre'}`;
        targetMr.bancoMovimientos.push({
            date,
            concept,
            ingreso: room.price,
            egreso: 0,
            autoGenerated: true,
            sourceId: room.id,
            sourceType: 'room'
        });
    });

    const monthSales = getMonthRecords(year, month, 'sales').filter(s =>
        isCardOrBankPayment(s.paymentMethod)
    );
    monthSales.forEach(sale => {
        const date = new Date(sale.timestamp).toISOString().split('T')[0];
        const concept = `Venta inventario - ${sale.productName || 'Productos'}`;
        targetMr.bancoMovimientos.push({
            date,
            concept,
            ingreso: sale.total,
            egreso: 0,
            autoGenerated: true,
            sourceId: sale.id,
            sourceType: 'sale'
        });
    });

    const monthReservations = (reservations || []).filter(res => {
        const ts = res.reservationTimestamp || res.createdAt;
        return ts >= start && ts <= end && res.status !== 'cancelled' && res.status !== 'completed' && isCardOrBankPayment(res.paymentMethod);
    });
    monthReservations.forEach(res => {
        const ts = res.reservationTimestamp || res.createdAt;
        const date = new Date(ts).toISOString().split('T')[0];
        const concept = `Reserva Hab. ${res.roomNumber} (${res.building === 'regulares' ? 'Ed.1' : 'Torre'}) - ${res.guestName || 'Sin nombre'}`;
        targetMr.bancoMovimientos.push({
            date,
            concept,
            ingreso: Number(res.price) || 0,
            egreso: 0,
            autoGenerated: true,
            sourceId: res.id,
            sourceType: 'reservation'
        });
    });

    targetMr.bancoMovimientos.sort((a, b) => new Date(a.date) - new Date(b.date));
}

export async function computeCierreForMonth(year, month) {
    let mr;
    try {
        const raw = localStorage.getItem(`mrData_${year}_${month}`);
        mr = raw ? JSON.parse(raw) : null;
    } catch (e) { mr = null; }
    if (!mr) {
        mr = { directExpenses: [], indirectExpenses: [], nonOpExpenses: [], efectivoMovimientos: [], bancoMovimientos: [], efectivoAnterior: 0, bancoAnterior: 0 };
    }
    await ensureMonthDataLoaded(year, month);
    await syncTarjetaVentasToBancoInto(mr, year, month);
    const { start, end } = getMonthRangeFor(year, month);
    const filt = m => {
        const t = new Date(m.date).getTime();
        return !Number.isNaN(t) && t >= start && t <= end;
    };

    const monthRooms = getMonthRecords(year, month, 'revenue').filter(r => r.type === 'sold' || r.type === 'renewal');
    const monthSales = getMonthRecords(year, month, 'sales');
    const monthReservations = (reservations || []).filter(res => {
        const ts = res.reservationTimestamp || res.createdAt;
        return ts >= start && ts <= end && res.status !== 'cancelled' && res.status !== 'completed';
    });

    const roomsEfec = monthRooms.filter(r => isCashPayment(r.paymentMethod)).reduce((s, r) => s + r.price, 0);
    const salesEfec = monthSales.filter(s => isCashPayment(s.paymentMethod)).reduce((s, r) => s + r.total, 0);
    const resEfec = monthReservations.filter(r => isCashPayment(r.paymentMethod)).reduce((s, r) => s + (Number(r.price) || 0), 0);
    const totalIngresos = roomsEfec + salesEfec + resEfec;

    const inversionesCats = ['inversiones_alimentos', 'inversiones_sexshop'];
    const allDirect = mr.directExpenses || [];
    const inversionesTotal = allDirect.filter(e => inversionesCats.includes(e.category)).reduce((s, e) => s + (e.amount || 0), 0);
    const directTotal = allDirect.reduce((s, e) => s + (e.amount || 0), 0);
    const indirectTotal = (mr.indirectExpenses || []).reduce((s, e) => s + (e.amount || 0), 0);
    const nonOpTotal = (mr.nonOpExpenses || []).reduce((s, e) => s + (e.amount || 0), 0);
    const utilidadBruta = totalIngresos - (directTotal - inversionesTotal) - indirectTotal;
    const utilidadNeta = utilidadBruta - inversionesTotal - nonOpTotal;

    const efectivoAnt = mr.efectivoAnterior != null && mr.efectivoAnterior !== '' ? Number(mr.efectivoAnterior) : 0;
    const bancoAnt = mr.bancoAnterior != null && mr.bancoAnterior !== '' ? Number(mr.bancoAnterior) : 0;
    const efecMov = (mr.efectivoMovimientos || []).filter(filt);
    const bancoMov = (mr.bancoMovimientos || []).filter(filt);
    const efecMovIngresos = efecMov.reduce((s, m) => s + (m.ingreso || 0), 0);
    const efecMovEgresos = efecMov.reduce((s, m) => s + (m.egreso || 0), 0);
    const bancoMovIngresos = bancoMov.reduce((s, m) => s + (m.ingreso || 0), 0);
    const bancoMovEgresos = bancoMov.reduce((s, m) => s + (m.egreso || 0), 0);

    return {
        efectivoCierre: efectivoAnt + utilidadNeta + efecMovIngresos - efecMovEgresos,
        bancoCierre: bancoAnt + bancoMovIngresos - bancoMovEgresos
    };
}

export async function applyAnterioresFromPreviousMonth() {
    if (_mrData.anterioresUserEdited) return;
    let py = _mrYear;
    let pm = _mrMonth - 1;
    if (pm < 0) { pm = 11; py--; }
    const tag = `${_mrYear}-${_mrMonth}`;
    if (_mrData.anterioresAutoTag === tag) return;

    const cierre = await computeCierreForMonth(py, pm);
    _mrData.efectivoAnterior = cierre.efectivoCierre;
    _mrData.bancoAnterior = cierre.bancoCierre;
    _mrData.anterioresAutoTag = tag;

    const efecInp = document.getElementById('mr-efectivo-anterior');
    const bancInp = document.getElementById('mr-banco-anterior');
    if (efecInp) efecInp.value = cierre.efectivoCierre === 0 ? '' : String(Math.round(cierre.efectivoCierre * 100) / 100);
    if (bancInp) bancInp.value = cierre.bancoCierre === 0 ? '' : String(Math.round(cierre.bancoCierre * 100) / 100);
    saveMonthlyReportData();
}

export function fmtDate(dateStr) {
    if (!dateStr) return '';
    
    // Si está en formato YYYY-MM-DD, convertir a Date
    let date;
    if (dateStr.includes('-')) {
        const [year, month, day] = dateStr.split('-').map(Number);
        date = new Date(year, month - 1, day);
    } else {
        date = new Date(dateStr);
    }
    
    if (isNaN(date.getTime())) return dateStr;
    
    return date.toLocaleDateString('es-MX', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
}

export function addSaleToMovements(saleData) {
    // Obtener año y mes de la transacción (NO del mes actualmente visualizado)
    const dateObj = new Date(saleData.timestamp);
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth();
    const key = `mrData_${year}_${month}`;
    
    // Cargar el mrData del mes correcto
    let mrData;
    try {
        const saved = localStorage.getItem(key);
        mrData = saved ? JSON.parse(saved) : { 
            directExpenses: [], indirectExpenses: [], nonOpExpenses: [], 
            salaries: [], efectivoMovimientos: [], bancoMovimientos: [] 
        };
    } catch(e) {
        mrData = { 
            directExpenses: [], indirectExpenses: [], nonOpExpenses: [], 
            salaries: [], efectivoMovimientos: [], bancoMovimientos: [] 
        };
    }
    
    const date = dateObj.toISOString().split('T')[0];
    let concept = '';
    
    if (saleData.type === 'sold' || saleData.type === 'renewal') {
        concept = `Hab. ${saleData.roomNumber} (${saleData.building === 'regulares' ? 'Ed.1' : 'Torre'}) - ${saleData.guestName || 'Sin nombre'}`;
    } else if (saleData.items) {
        // Es venta de inventario
        concept = `Venta inventario - ${saleData.items.map(i => i.name).join(', ')}`;
    }
    
    const amount = saleData.price || saleData.total || 0;
    const paymentMethod = saleData.paymentMethod || 'efectivo';
    
    // Agregar a movimientos de efectivo si es pago en efectivo
    if (paymentMethod === 'efectivo') {
        if (!mrData.efectivoMovimientos) mrData.efectivoMovimientos = [];
        mrData.efectivoMovimientos.push({
            date,
            concept,
            ingreso: amount,
            egreso: 0,
            autoGenerated: true,
            sourceId: saleData.id,
            sourceType: saleData.type || 'sale'
        });
        
        // Ordenar por fecha
        mrData.efectivoMovimientos.sort((a, b) => new Date(a.date) - new Date(b.date));
    }
    
    // Agregar a movimientos de banco si es pago con tarjeta
    if (isCardOrBankPayment(paymentMethod)) {
        if (!mrData.bancoMovimientos) mrData.bancoMovimientos = [];
        mrData.bancoMovimientos.push({
            date,
            concept,
            ingreso: amount,
            egreso: 0,
            autoGenerated: true,
            sourceId: saleData.id,
            sourceType: saleData.type || 'sale'
        });
        
        // Ordenar por fecha
        mrData.bancoMovimientos.sort((a, b) => new Date(a.date) - new Date(b.date));
    }
    
    // Guardar en el mes correcto
    localStorage.setItem(key, JSON.stringify(mrData));
    if (_appReady && window.FirebaseSync && window.FirebaseSync.ready) {
        window.FirebaseSync.saveMrData(key, mrData);
    }
    
    // Si estamos visualizando ese mes, actualizar la vista
    if (_mrYear === year && _mrMonth === month) {
        setMrData(mrData);
        generateMonthlyReport();
    }
}

export function addTarjetaSaleToBanco(saleData) {
    if (!isCardOrBankPayment(saleData.paymentMethod)) return;
    
    // Obtener año y mes de la transacción (NO del mes actualmente visualizado)
    const dateObj = new Date(saleData.timestamp);
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth();
    const key = `mrData_${year}_${month}`;
    
    // Cargar el mrData del mes correcto
    let mrData;
    try {
        const saved = localStorage.getItem(key);
        mrData = saved ? JSON.parse(saved) : { 
            directExpenses: [], indirectExpenses: [], nonOpExpenses: [], 
            salaries: [], efectivoMovimientos: [], bancoMovimientos: [] 
        };
    } catch(e) {
        mrData = { 
            directExpenses: [], indirectExpenses: [], nonOpExpenses: [], 
            salaries: [], efectivoMovimientos: [], bancoMovimientos: [] 
        };
    }
    
    // Crear movimiento en banco
    const date = dateObj.toISOString().split('T')[0];
    let concept = '';
    
    if (saleData.type === 'sold' || saleData.type === 'renewal') {
        concept = `Hab. ${saleData.roomNumber} (${saleData.building === 'regulares' ? 'Ed.1' : 'Torre'}) - ${saleData.guestName || 'Sin nombre'}`;
    } else if (saleData.type === 'reservation') {
        concept = `Reserva Hab. ${saleData.roomNumber} (${saleData.building === 'regulares' ? 'Ed.1' : 'Torre'}) - ${saleData.guestName || 'Sin nombre'}`;
    } else if (saleData.productName) {
        concept = `Venta inventario - ${saleData.productName}`;
    }
    
    const movimiento = {
        date,
        concept,
        ingreso: saleData.price || saleData.total || 0,
        egreso: 0,
        autoGenerated: true,
        sourceId: saleData.id,
        sourceType: saleData.type || 'sale'
    };
    
    // Agregar a movimientos del banco
    if (!mrData.bancoMovimientos) mrData.bancoMovimientos = [];
    mrData.bancoMovimientos.push(movimiento);
    
    // Ordenar por fecha
    mrData.bancoMovimientos.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    // Guardar en el mes correcto
    localStorage.setItem(key, JSON.stringify(mrData));
    if (_appReady && window.FirebaseSync && window.FirebaseSync.ready) {
        window.FirebaseSync.saveMrData(key, mrData);
    }
    
    // Si estamos visualizando ese mes, actualizar la vista
    if (_mrYear === year && _mrMonth === month) {
        setMrData(mrData);
        generateMonthlyReport();
    }
}

export async function syncTarjetaVentasToBanco() {
    await syncTarjetaVentasToBancoInto(_mrData, _mrYear, _mrMonth);
    saveMonthlyReportData();
}

export function cleanMovimientosFromOtherMonths() {
    const { start, end } = getMonthRange();
    
    // Limpiar movimientos de efectivo de otros meses
    if (_mrData.efectivoMovimientos) {
        _mrData.efectivoMovimientos = _mrData.efectivoMovimientos.filter(m => {
            const movDate = new Date(m.date).getTime();
            return movDate >= start && movDate <= end;
        });
    }
    
    // Limpiar movimientos de banco de otros meses
    if (_mrData.bancoMovimientos) {
        _mrData.bancoMovimientos = _mrData.bancoMovimientos.filter(m => {
            const movDate = new Date(m.date).getTime();
            return movDate >= start && movDate <= end;
        });
    }
    
    saveMonthlyReportData();
}

export async function generateMonthlyReport() {
    // Inicializar _mrData si no existe
    if (!_mrData || typeof _mrData !== 'object') {
        setMrData({
            directExpenses: [],
            indirectExpenses: [],
            nonOpExpenses: []
        });
    }

    await ensureMonthDataLoaded(_mrYear, _mrMonth);
    cleanMovimientosFromOtherMonths();
    await applyAnterioresFromPreviousMonth();
    await syncTarjetaVentasToBanco();

    const monthRooms = getMonthRecords(_mrYear, _mrMonth, 'revenue').filter(r => r.type === 'sold' || r.type === 'renewal');
    const monthSales = getMonthRecords(_mrYear, _mrMonth, 'sales');
    const roomsTotal = monthRooms.reduce((s, r) => s + r.price, 0);
    const roomsEfectivo = monthRooms.filter(r => isCashPayment(r.paymentMethod)).reduce((s, r) => s + r.price, 0);
    const roomsBanco = monthRooms.filter(r => isCardOrBankPayment(r.paymentMethod)).reduce((s, r) => s + r.price, 0);
    const salesEfectivo = monthSales.filter(s => isCashPayment(s.paymentMethod)).reduce((s, r) => s + r.total, 0);
    const salesBanco = monthSales.filter(s => isCardOrBankPayment(s.paymentMethod)).reduce((s, r) => s + r.total, 0);

    const totalIngresos = roomsEfectivo + salesEfectivo;

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('mr-rooms-total', fmt(roomsTotal));
    setEl('mr-rooms-efectivo', fmt(roomsEfectivo));
    setEl('mr-rooms-banco', fmt(roomsBanco));
    setEl('mr-sales-efectivo', fmt(salesEfectivo));
    setEl('mr-sales-banco', fmt(salesBanco));
    setEl('mr-total-ingresos', fmt(totalIngresos));

    const inversionesCats = ['inversiones_alimentos', 'inversiones_sexshop'];
    const allDirectExpenses = _mrData.directExpenses || [];
    const inversionesTotal = allDirectExpenses
        .filter(e => inversionesCats.includes(e.category))
        .reduce((s, e) => s + (e.amount || 0), 0);
    const directTotal = allDirectExpenses.reduce((s, e) => s + (e.amount || 0), 0);

    const indirectTotal = (_mrData.indirectExpenses || []).reduce((s, e) => s + (e.amount || 0), 0);
    const nonOpTotal = (_mrData.nonOpExpenses || []).reduce((s, e) => s + (e.amount || 0), 0);
    // Utilidad Bruta: ingresos efectivo - gastos operativos (directos sin inversiones) - indirectos
    const utilidadBruta = totalIngresos - (directTotal - inversionesTotal) - indirectTotal;
    // Utilidad Neta: Bruta - Inversiones - No Operativos
    const utilidadNeta = utilidadBruta - inversionesTotal - nonOpTotal;

    setEl('mr-direct-subtotal', fmt(directTotal));
    setEl('mr-indirect-subtotal', fmt(indirectTotal));
    setEl('mr-inversiones-subtotal', fmt(inversionesTotal));
    setEl('mr-utilidad-bruta', fmt(utilidadBruta));
    setEl('mr-nonop-subtotal', fmt(nonOpTotal));
    setEl('mr-utilidad-neta', fmt(utilidadNeta));

    const efecInputEl = document.getElementById('mr-efectivo-anterior');
    const bancInputEl = document.getElementById('mr-banco-anterior');
    const rawEf = efecInputEl?.value?.trim() ?? '';
    const rawBa = bancInputEl?.value?.trim() ?? '';
    const parseMoney = (raw) => {
        if (raw === '') return 0;
        const n = parseFloat(String(raw).replace(',', '.'));
        return Number.isFinite(n) ? n : 0;
    };
    let efectivoAnterior = parseMoney(rawEf);
    let bancoAnterior = parseMoney(rawBa);
    if (rawEf === '') {
        efectivoAnterior = _mrData.efectivoAnterior != null && _mrData.efectivoAnterior !== '' ? Number(_mrData.efectivoAnterior) : 0;
    }
    if (rawBa === '') {
        bancoAnterior = _mrData.bancoAnterior != null && _mrData.bancoAnterior !== '' ? Number(_mrData.bancoAnterior) : 0;
    }
    const efecMovIngresos = (_mrData.efectivoMovimientos || []).reduce((s, m) => s + (m.ingreso || 0), 0);
    const efecMovEgresos = (_mrData.efectivoMovimientos || []).reduce((s, m) => s + (m.egreso || 0), 0);
    const efectivoTotal = efectivoAnterior + utilidadNeta + efecMovIngresos - efecMovEgresos;
    const bancoMovIngresos = (_mrData.bancoMovimientos || []).reduce((s, m) => s + (m.ingreso || 0), 0);
    const bancoMovEgresos = (_mrData.bancoMovimientos || []).reduce((s, m) => s + (m.egreso || 0), 0);
    const bancoTotal = bancoAnterior + bancoMovIngresos - bancoMovEgresos;

    if (rawEf !== '') _mrData.efectivoAnterior = efectivoAnterior;
    if (rawBa !== '') _mrData.bancoAnterior = bancoAnterior;
    setEl('mr-efectivo-utilidad', fmt(utilidadNeta));
    setEl('mr-efectivo-total', fmt(efectivoTotal));
    setEl('mr-banco-ingresos', fmt(bancoMovIngresos));
    setEl('mr-banco-total', fmt(bancoTotal));

    if (efecInputEl && rawEf === '' && _mrData.efectivoAnterior != null && _mrData.efectivoAnterior !== '') {
        efecInputEl.value = String(_mrData.efectivoAnterior);
    }
    if (bancInputEl && rawBa === '' && _mrData.bancoAnterior != null && _mrData.bancoAnterior !== '') {
        bancInputEl.value = String(_mrData.bancoAnterior);
    }
    renderMrExpenseList('mr-direct-expenses-list', _mrData.directExpenses || [], 'direct');
    renderMrExpenseList('mr-indirect-expenses-list', _mrData.indirectExpenses || [], 'indirect');
    renderMrExpenseList('mr-nonop-expenses-list', _mrData.nonOpExpenses || [], 'nonop');
    renderMrSalaryList();
    renderMrMovimientosList('mr-efectivo-movimientos-list', 'efectivo');
    renderMrMovimientosList('mr-banco-movimientos-list', 'banco');
    await generateDailyIncomeTable();
}

export function recalcMonthlyReport() { generateMonthlyReport(); }

export async function generateDailyIncomeTable() {
    const tbody = document.getElementById('mr-daily-tbody');
    if (!tbody) return;

    await ensureMonthDataLoaded(_mrYear, _mrMonth);
    const monthRevenueRecords = getMonthRecords(_mrYear, _mrMonth, 'revenue');
    const monthSalesRecords = getMonthRecords(_mrYear, _mrMonth, 'sales');
    const daysInMonth = new Date(_mrYear, _mrMonth + 1, 0).getDate();
    const dayNames = ['DOMINGO','LUNES','MARTES','MIÉRCOLES','JUEVES','VIERNES','SÁBADO'];
    const fmtM = n => n ? '$' + (n).toFixed(2) : '';

    let totReg = 0, totTorre = 0, totHab = 0;
    let totEfec = 0, totTarjeta = 0, totIngHab = 0, totConsumos = 0, totTurno = 0, totDia = 0;

    let html = '';

    for (let d = 1; d <= daysInMonth; d++) {
        // Rango del día: turno día (6am-6pm) + turno noche (6pm-6am siguiente)
        const dayStart  = new Date(_mrYear, _mrMonth, d, 6, 0, 0).getTime();
        const dayEnd    = new Date(_mrYear, _mrMonth, d + 1, 5, 59, 59).getTime();
        const shiftDayStart   = new Date(_mrYear, _mrMonth, d, 6, 0, 0).getTime();
        const shiftDayEnd     = new Date(_mrYear, _mrMonth, d, 17, 59, 59).getTime();
        const shiftNightStart = new Date(_mrYear, _mrMonth, d, 18, 0, 0).getTime();
        const shiftNightEnd   = new Date(_mrYear, _mrMonth, d + 1, 5, 59, 59).getTime();

        const dayOfWeek = new Date(_mrYear, _mrMonth, d).getDay();
        const dayName = dayNames[dayOfWeek];

        // Función para calcular datos de un turno
        function shiftData(tsStart, tsEnd) {
            const rooms = monthRevenueRecords.filter(r =>
                r.timestamp >= tsStart && r.timestamp <= tsEnd &&
                (r.type === 'sold' || r.type === 'renewal')
            );
            const shiftSales = monthSalesRecords.filter(s => s.timestamp >= tsStart && s.timestamp <= tsEnd);

            const reg   = rooms.filter(r => r.building === 'regulares').length;
            const torre = rooms.filter(r => r.building === 'torre').length;
            const total = rooms.length;
            const ingHab = rooms.reduce((s, r) => s + r.price, 0);
            const consumos = shiftSales.reduce((s, r) => s + r.total, 0);
            const tarjeta = rooms.filter(r => isCardOrBankPayment(r.paymentMethod)).reduce((s, r) => s + r.price, 0)
                          + shiftSales.filter(s => isCardOrBankPayment(s.paymentMethod)).reduce((s, r) => s + r.total, 0);
            const efectivo = rooms.filter(r => (r.paymentMethod||'efectivo') === 'efectivo').reduce((s, r) => s + r.price, 0)
                          + shiftSales.filter(s => (s.paymentMethod||'efectivo') === 'efectivo').reduce((s, r) => s + r.total, 0);
            return { reg, torre, total, ingHab, consumos, tarjeta, efectivo };
        }

        const sd = shiftData(shiftDayStart, shiftDayEnd);
        const sn = shiftData(shiftNightStart, shiftNightEnd);

        const dayTotalHab = sd.total + sn.total;
        const dayTotalIng = sd.ingHab + sn.ingHab;
        const dayTotalCons = sd.consumos + sn.consumos;
        const dayTotal = dayTotalIng + dayTotalCons;
        const dayTarjeta = sd.tarjeta + sn.tarjeta;
        const dayEfectivo = sd.efectivo + sn.efectivo;

        totReg     += sd.reg + sn.reg;
        totTorre   += sd.torre + sn.torre;
        totHab     += dayTotalHab;
        totEfec    += dayEfectivo;
        totTarjeta += dayTarjeta;
        totIngHab  += dayTotalIng;
        totConsumos+= dayTotalCons;
        totTurno   += dayTotalIng + dayTotalCons;
        totDia     += dayTotal;

        const isEmpty = dayTotalHab === 0 && dayTotal === 0;

        // Fila encabezado del día
        const fechaCompleta = new Date(_mrYear, _mrMonth, d).toLocaleDateString('es-MX', {
            day: '2-digit',
            month: 'short'
        });
        
        html += `<tr class="mr-day-header${isEmpty ? ' mr-day-empty' : ''}">
            <td><strong>${d}</strong></td>
            <td style="text-align:left;">
                <div class="date-badge">
                    <span class="date-day">${fechaCompleta}</span>
                    <span class="date-weekday">${dayName}</span>
                </div>
            </td>
            <td></td>
            <td>${sd.reg + sn.reg || (isEmpty ? '—' : 0)}</td>
            <td>${sd.torre + sn.torre || (isEmpty ? '—' : 0)}</td>
            <td><strong>${dayTotalHab || (isEmpty ? '—' : 0)}</strong></td>
            <td class="mr-money">${fmtM(dayEfectivo)}</td>
            <td class="mr-money">${fmtM(dayTarjeta)}</td>
            <td class="mr-money">${fmtM(dayTotalIng)}</td>
            <td class="mr-money">${fmtM(dayTotalCons)}</td>
            <td class="mr-money"><strong>${fmtM(dayTotal)}</strong></td>
        </tr>`;

        if (!isEmpty) {
            // Fila turno día
            html += `<tr class="mr-shift-day">
                <td></td>
                <td style="text-align:left;padding-left:16px;">☀️ Turno Día <button class="btn-download-shift" onclick="downloadShiftDayReport(${_mrYear},${_mrMonth},${d},'day')" title="Descargar reporte de este turno">📥</button></td>
                <td><span class="mr-shift-badge dia">DÍA</span></td>
                <td>${sd.reg}</td>
                <td>${sd.torre}</td>
                <td>${sd.total}</td>
                <td class="mr-money">${fmtM(sd.efectivo)}</td>
                <td class="mr-money">${fmtM(sd.tarjeta)}</td>
                <td class="mr-money">${fmtM(sd.ingHab)}</td>
                <td class="mr-money">${fmtM(sd.consumos)}</td>
                <td class="mr-money"><strong>${fmtM(sd.ingHab + sd.consumos)}</strong></td>
            </tr>`;

            // Fila turno noche
            html += `<tr class="mr-shift-night">
                <td></td>
                <td style="text-align:left;padding-left:16px;">🌙 Turno Noche <button class="btn-download-shift" onclick="downloadShiftDayReport(${_mrYear},${_mrMonth},${d},'night')" title="Descargar reporte de este turno">📥</button></td>
                <td><span class="mr-shift-badge noche">NOCHE</span></td>
                <td>${sn.reg}</td>
                <td>${sn.torre}</td>
                <td>${sn.total}</td>
                <td class="mr-money">${fmtM(sn.efectivo)}</td>
                <td class="mr-money">${fmtM(sn.tarjeta)}</td>
                <td class="mr-money">${fmtM(sn.ingHab)}</td>
                <td class="mr-money">${fmtM(sn.consumos)}</td>
                <td class="mr-money"><strong>${fmtM(sn.ingHab + sn.consumos)}</strong></td>
            </tr>`;
        }
    }

    tbody.innerHTML = html;

    // Totales en tfoot Y en thead (fila superior)
    const setT = (id, val) => { 
        const el = document.getElementById(id); 
        if (el) el.textContent = val; 
    };
    
    // Actualizar totales de abajo (tfoot)
    setT('mr-tot-regulares', totReg);
    setT('mr-tot-torre', totTorre);
    setT('mr-tot-hab', totHab);
    setT('mr-tot-efectivo', fmtM(totEfec));
    setT('mr-tot-tarjeta', fmtM(totTarjeta));
    setT('mr-tot-ingresos-hab', fmtM(totIngHab));
    setT('mr-tot-consumos', fmtM(totConsumos));
    setT('mr-tot-total', fmtM(totDia));
    
    // Actualizar totales de arriba (thead duplicado)
    setT('mr-tot-regulares-top', totReg);
    setT('mr-tot-torre-top', totTorre);
    setT('mr-tot-hab-top', totHab);
    setT('mr-tot-efectivo-top', fmtM(totEfec));
    setT('mr-tot-tarjeta-top', fmtM(totTarjeta));
    setT('mr-tot-ingresos-hab-top', fmtM(totIngHab));
    setT('mr-tot-consumos-top', fmtM(totConsumos));
    setT('mr-tot-total-top', fmtM(totDia));
}

export async function buildDailyIncomeSheet() {
    await ensureMonthDataLoaded(_mrYear, _mrMonth);
    const monthRevenueRecords = getMonthRecords(_mrYear, _mrMonth, 'revenue');
    const monthSalesRecords = getMonthRecords(_mrYear, _mrMonth, 'sales');
    const daysInMonth = new Date(_mrYear, _mrMonth + 1, 0).getDate();
    const dayNames = ['DOMINGO','LUNES','MARTES','MIÉRCOLES','JUEVES','VIERNES','SÁBADO'];
    const fmtM = n => n ? parseFloat(n.toFixed(2)) : 0;

    const rows = [];
    const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    rows.push(['INGRESOS — ' + months[_mrMonth].toUpperCase() + ' ' + _mrYear]);
    rows.push([]);
    rows.push(['FECHA','DÍA','TURNO','REGULARES','TORRE','TOTAL HAB.','EFECTIVO','TARJETA','INGRESOS HAB.','CONSUMOS','GANANCIA']);

    let totReg=0,totTorre=0,totHab=0,totEfec=0,totTarjeta=0,totIngHab=0,totCons=0,totDia=0;

    for (let d = 1; d <= daysInMonth; d++) {
        const shiftDayStart   = new Date(_mrYear, _mrMonth, d, 6, 0, 0).getTime();
        const shiftDayEnd     = new Date(_mrYear, _mrMonth, d, 17, 59, 59).getTime();
        const shiftNightStart = new Date(_mrYear, _mrMonth, d, 18, 0, 0).getTime();
        const shiftNightEnd   = new Date(_mrYear, _mrMonth, d + 1, 5, 59, 59).getTime();
        const dayOfWeek = new Date(_mrYear, _mrMonth, d).getDay();

        function sd(tsStart, tsEnd) {
            const rms = monthRevenueRecords.filter(r => r.timestamp >= tsStart && r.timestamp <= tsEnd && (r.type==='sold'||r.type==='renewal'));
            const sls = monthSalesRecords.filter(s => s.timestamp >= tsStart && s.timestamp <= tsEnd);
            const reg   = rms.filter(r => r.building==='regulares').length;
            const torre = rms.filter(r => r.building==='torre').length;
            const ingHab = rms.reduce((s,r)=>s+r.price,0);
            const consumos = sls.reduce((s,r)=>s+r.total,0);
            const tarjeta = rms.filter(r=>isCardOrBankPayment(r.paymentMethod)).reduce((s,r)=>s+r.price,0)
                          + sls.filter(s=>isCardOrBankPayment(s.paymentMethod)).reduce((s,r)=>s+r.total,0);
            const efectivo = rms.filter(r=>(r.paymentMethod||'efectivo')==='efectivo').reduce((s,r)=>s+r.price,0)
                          + sls.filter(s=>(s.paymentMethod||'efectivo')==='efectivo').reduce((s,r)=>s+r.total,0);
            return { reg, torre, total: rms.length, ingHab, consumos, tarjeta, efectivo };
        }

        const day = sd(shiftDayStart, shiftDayEnd);
        const night = sd(shiftNightStart, shiftNightEnd);
        const dayTot = day.ingHab + day.consumos + night.ingHab + night.consumos;
        const dayTarjeta = day.tarjeta + night.tarjeta;
        const dayEfectivo = day.efectivo + night.efectivo;

        totReg     += day.reg + night.reg;
        totTorre   += day.torre + night.torre;
        totHab     += day.total + night.total;
        totEfec    += dayEfectivo;
        totTarjeta += dayTarjeta;
        totIngHab  += day.ingHab + night.ingHab;
        totCons    += day.consumos + night.consumos;
        totDia     += dayTot;

        // Fila resumen del día
        rows.push([
            d, dayNames[dayOfWeek], 'RESUMEN',
            day.reg+night.reg, day.torre+night.torre,
            day.total+night.total, fmtM(dayEfectivo), fmtM(dayTarjeta),
            fmtM(day.ingHab+night.ingHab), fmtM(day.consumos+night.consumos),
            fmtM(dayTot)
        ]);
        // Turno día
        rows.push([
            '', 'Turno Día', 'DÍA',
            day.reg, day.torre, day.total, fmtM(day.efectivo), fmtM(day.tarjeta),
            fmtM(day.ingHab), fmtM(day.consumos), fmtM(day.ingHab+day.consumos)
        ]);
        // Turno noche
        rows.push([
            '', 'Turno Noche', 'NOCHE',
            night.reg, night.torre, night.total, fmtM(night.efectivo), fmtM(night.tarjeta),
            fmtM(night.ingHab), fmtM(night.consumos), fmtM(night.ingHab+night.consumos)
        ]);
        rows.push([]);
    }

    rows.push([]);
    rows.push(['TOTALES','','',totReg,totTorre,totHab,fmtM(totEfec),fmtM(totTarjeta),fmtM(totIngHab),fmtM(totCons),fmtM(totDia)]);
    return rows;
}

export function renderMrExpenseList(containerId, list, type) {
    const container = document.getElementById(containerId);
    if (!container) return;
    let acc = 0;
    container.innerHTML = list.map((item, idx) => {
        acc += item.amount || 0;
        return `<div class="mr-row">
            <span>${sanitizeHTML(item.concept || item.category || '')}</span>
            <span class="date-badge-small">${fmtDate(item.date)}</span>
            <span>${fmt(item.amount)}</span>
            <span>${fmt(acc)}</span>
            <span><button onclick="deleteMrExpense('${type}',${idx})" style="background:none;border:none;color:#e74c3c;cursor:pointer;font-size:16px;">✕</button></span>
        </div>`;
    }).join('');
}

export function renderMrSalaryList() {
    const container = document.getElementById('mr-direct-expenses-list');
    if (!container || !_mrData.salaries) return;
}

export function getMrMovimientosFiltered(full, type) {
    const prefix = type === 'efectivo' ? 'mr-efectivo-mov' : 'mr-banco-mov';
    const qEl = document.getElementById(`${prefix}-filter`);
    const ftEl = document.getElementById(`${prefix}-filter-type`);
    const q = (qEl && qEl.value) ? String(qEl.value).trim().toLowerCase() : '';
    const ft = (ftEl && ftEl.value) ? ftEl.value : 'all';
    let list = full.slice();
    if (ft === 'in') list = list.filter((i) => (i.ingreso || 0) > 0);
    else if (ft === 'out') list = list.filter((i) => (i.egreso || 0) > 0);
    else if (ft === 'auto') list = list.filter((i) => i.autoGenerated);
    else if (ft === 'manual') list = list.filter((i) => !i.autoGenerated);
    if (q) {
        list = list.filter((i) => {
            const concept = (i.concept || '').toLowerCase();
            const dateS = String(i.date || '').toLowerCase();
            return concept.includes(q) || dateS.includes(q)
                || String(i.ingreso || '').includes(q) || String(i.egreso || '').includes(q);
        });
    }
    return list;
}

export function filterMrMovimientos(type) {
    const id = type === 'efectivo' ? 'mr-efectivo-movimientos-list' : 'mr-banco-movimientos-list';
    renderMrMovimientosList(id, type);
}

export function renderMrMovimientosList(containerId, type) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const full = type === 'efectivo' ? (_mrData.efectivoMovimientos || []) : (_mrData.bancoMovimientos || []);
    const list = getMrMovimientosFiltered(full, type);
    container.innerHTML = list.map((item) => {
        const originalIndex = full.indexOf(item);
        const ingreso = item.ingreso || 0;
        const egreso = item.egreso || 0;
        const ingresoStr = ingreso > 0 ? fmt(ingreso) : '-';
        const egresoStr = egreso > 0 ? fmt(egreso) : '-';
        const autoBadge = item.autoGenerated ? '<span class="mr-auto-badge" title="Generado automáticamente">AUTO</span>' : '';
        const ingCls = ingreso > 0 ? 'mr-movimiento-ingreso' : '';
        const egCls = egreso > 0 ? 'mr-movimiento-egreso' : '';
        return `<div class="mr-movimiento-row">
        <span class="date-badge-small date-badge-mov">${fmtDate(item.date)}</span>
        <span class="mr-mov-concept">${autoBadge}${sanitizeHTML(item.concept || '')}</span>
        <span class="${ingCls}">${ingresoStr}</span>
        <span class="${egCls}">${egresoStr}</span>
        <button type="button" class="btn-icon btn-danger" onclick="deleteMrMovimiento('${type}',${originalIndex})" title="Eliminar">✕</button>
    </div>`;
    }).join('');
}

export function toggleSalaryFields() {
    const cat = document.getElementById('mr-direct-category')?.value;
    const normal = document.getElementById('mr-direct-normal-fields');
    const salary = document.getElementById('mr-direct-salary-fields');
    if (normal) normal.style.display = cat === 'salarios' ? 'none' : 'contents';
    if (salary) salary.style.display = cat === 'salarios' ? 'contents' : 'none';
}

export function addMrDirectExpense() {
    const cat = document.getElementById('mr-direct-category')?.value;
    if (!cat) { showToast('Selecciona una categoría', 'error'); return; }
    if (cat === 'salarios') { addMrSalary(); return; }
    const concept = document.getElementById('mr-direct-concept')?.value.trim();
    const date = document.getElementById('mr-direct-date')?.value;
    const amount = parseFloat(document.getElementById('mr-direct-amount')?.value);
    if (!concept || !date || !amount) { showToast('Completa todos los campos', 'error'); return; }
    if (!_mrData.directExpenses) _mrData.directExpenses = [];
    _mrData.directExpenses.push({ category: cat, concept, date, amount });
    saveMonthlyReportData();
    generateMonthlyReport();
    document.getElementById('mr-direct-concept').value = '';
    document.getElementById('mr-direct-amount').value = '';
}

export function addMrIndirectExpense() {
    const cat = document.getElementById('mr-indirect-category')?.value;
    const concept = document.getElementById('mr-indirect-concept')?.value.trim();
    const date = document.getElementById('mr-indirect-date')?.value;
    const amount = parseFloat(document.getElementById('mr-indirect-amount')?.value);
    if (!cat || !concept || !date || !amount) { showToast('Completa todos los campos', 'error'); return; }
    if (!_mrData.indirectExpenses) _mrData.indirectExpenses = [];
    _mrData.indirectExpenses.push({ category: cat, concept, date, amount });
    saveMonthlyReportData();
    generateMonthlyReport();
    document.getElementById('mr-indirect-concept').value = '';
    document.getElementById('mr-indirect-amount').value = '';
}

export function addMrNonOpExpense() {
    const concept = document.getElementById('mr-nonop-concept')?.value.trim();
    const date = document.getElementById('mr-nonop-date')?.value;
    const amount = parseFloat(document.getElementById('mr-nonop-amount')?.value);
    if (!concept || !date || !amount) { showToast('Completa todos los campos', 'error'); return; }
    if (!_mrData.nonOpExpenses) _mrData.nonOpExpenses = [];
    _mrData.nonOpExpenses.push({ concept, date, amount });
    saveMonthlyReportData();
    generateMonthlyReport();
    document.getElementById('mr-nonop-concept').value = '';
    document.getElementById('mr-nonop-amount').value = '';
}

export function addMrSalary() {
    const name = document.getElementById('mr-salary-name')?.value.trim();
    const date = document.getElementById('mr-salary-date')?.value;
    const tarifa = parseFloat(document.getElementById('mr-salary-tarifa')?.value);
    const neto = parseFloat(document.getElementById('mr-salary-neto')?.value);
    if (!name || !date || !neto) { showToast('Completa los campos de salario', 'error'); return; }
    if (!_mrData.directExpenses) _mrData.directExpenses = [];
    _mrData.directExpenses.push({ category: 'salarios', concept: name, date, amount: neto, tarifa });
    saveMonthlyReportData();
    generateMonthlyReport();
}

export function addMrEfectivoMovimiento() {
    const date = document.getElementById('mr-efec-date')?.value;
    const concept = document.getElementById('mr-efec-concept')?.value.trim();
    const ingreso = parseFloat(document.getElementById('mr-efec-ingreso')?.value) || 0;
    const egreso = parseFloat(document.getElementById('mr-efec-egreso')?.value) || 0;
    if (!date || !concept) { showToast('Completa fecha y concepto', 'error'); return; }
    if (!_mrData.efectivoMovimientos) _mrData.efectivoMovimientos = [];
    _mrData.efectivoMovimientos.push({ date, concept, ingreso, egreso });
    saveMonthlyReportData();
    generateMonthlyReport();
    document.getElementById('mr-efec-concept').value = '';
    document.getElementById('mr-efec-ingreso').value = '';
    document.getElementById('mr-efec-egreso').value = '';
}

export function addMrBancoMovimiento() {
    const date = document.getElementById('mr-banco-date')?.value;
    const concept = document.getElementById('mr-banco-concept')?.value.trim();
    const ingreso = parseFloat(document.getElementById('mr-banco-ingreso')?.value) || 0;
    const egreso = parseFloat(document.getElementById('mr-banco-egreso')?.value) || 0;
    if (!date || !concept) { showToast('Completa fecha y concepto', 'error'); return; }
    if (!_mrData.bancoMovimientos) _mrData.bancoMovimientos = [];
    _mrData.bancoMovimientos.push({ date, concept, ingreso, egreso });
    saveMonthlyReportData();
    generateMonthlyReport();
    document.getElementById('mr-banco-concept').value = '';
    document.getElementById('mr-banco-ingreso').value = '';
    document.getElementById('mr-banco-egreso').value = '';
}

export function deleteMrExpense(type, index) {
    const map = { direct: 'directExpenses', indirect: 'indirectExpenses', nonop: 'nonOpExpenses' };
    const key = map[type];
    if (key && _mrData[key]) { _mrData[key].splice(index, 1); saveMonthlyReportData(); generateMonthlyReport(); }
}

export function deleteMrSalary(index) { deleteMrExpense('direct', index); }

export function deleteMrMovimiento(type, index) {
    const key = type === 'efectivo' ? 'efectivoMovimientos' : 'bancoMovimientos';
    if (_mrData[key]) {
        const movimiento = _mrData[key][index];
        // No permitir eliminar movimientos automáticos generados desde ventas
        if (movimiento && movimiento.autoGenerated) {
            showToast('No puedes eliminar movimientos automáticos de ventas', 'error');
            return;
        }
        _mrData[key].splice(index, 1);
        saveMonthlyReportData();
        generateMonthlyReport();
    }
}

export async function onMonthYearChange() {
    setMrMonth(parseInt(document.getElementById('reportMonth')?.value));
    setMrYear(parseInt(document.getElementById('reportYear')?.value));
    loadMonthlyReportData();
    _mrData.anterioresUserEdited = false;
    loadPayrollEmployees();
    await generateMonthlyReport();

    // Actualizar nómina
    setCurrentWeek(0); // Resetear a "todo el mes"
    document.getElementById('weekSelector').value = '0';
    updateWeekDateRange();
    renderWeeklyEmployees();
    updateWeeklySummary();

    // Actualizar listener al nuevo mes
    setupMrDataListener();
}

window.deleteMrExpense = deleteMrExpense;
window.deleteMrMovimiento = deleteMrMovimiento;
window.deletePayrollEmployee = deletePayrollEmployee;
window.openPayrollModal = openPayrollModal;

window.addMrBancoMovimiento = addMrBancoMovimiento;
window.addMrDirectExpense = addMrDirectExpense;
window.addMrEfectivoMovimiento = addMrEfectivoMovimiento;
window.addMrIndirectExpense = addMrIndirectExpense;
window.addMrNonOpExpense = addMrNonOpExpense;
window.closePayrollModal = closePayrollModal;
window.savePayrollEmployee = savePayrollEmployee;
window.togglePayrollWeek = togglePayrollWeek;

window.filterMrMovimientos = filterMrMovimientos;
window.mrSaldoAnteriorInput = mrSaldoAnteriorInput;
window.onMonthYearChange = onMonthYearChange;
window.onWeekChange = onWeekChange;
window.toggleSalaryFields = toggleSalaryFields;