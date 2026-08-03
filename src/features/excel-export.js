import { isCardOrBankPayment, isCashPayment, sanitizeHTML, sanitizeInt, sanitizeNumber } from '../utils/formatters.js';
import { getMonthRecords } from '../utils/hot-window.js';
import { buildDailyIncomeSheet, fmtDate } from './monthly-report.js';
import { ensureMonthDataLoaded } from '../utils/storage-utils.js';
import { showToast } from '../utils/toast-system.js';
import { _mrMonth, _mrYear, _mrData, _payrollEmployees } from '../app.js';


export async function downloadMonthlyExcel() {
    if (typeof XLSX === 'undefined') {
        showToast('Cargando módulo de Excel...', 'info');
        await import('https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js');
    }

    if (typeof XLSX === 'undefined') { 
        showToast('Librería Excel no disponible', 'error'); 
        return; 
    }

    // Verificar que las variables globales estén inicializadas
    if (_mrMonth === null || _mrYear === null) {
        showToast('Error: No se ha inicializado el reporte mensual', 'error');
        return;
    }

    await ensureMonthDataLoaded(_mrYear, _mrMonth);

    const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const mesNombre = months[_mrMonth];
    const fmt2 = n => parseFloat((n || 0).toFixed(2));
    const fmtDate = ts => new Date(ts).toLocaleDateString('es-MX', { day:'2-digit', month:'short', year:'numeric' });
    const fmtMoney = n => '$ ' + fmt2(n).toLocaleString('es-MX', { minimumFractionDigits: 2 });

    const wb = XLSX.utils.book_new();

    // ─── DATOS BASE ───────────────────────────────────────────────────────────
    const monthRooms = getMonthRecords(_mrYear, _mrMonth, 'revenue').filter(r => r.type === 'sold' || r.type === 'renewal');
    const monthSales = getMonthRecords(_mrYear, _mrMonth, 'sales');
    const roomsEfec = monthRooms.filter(r => isCashPayment(r.paymentMethod)).reduce((s,r)=>s+r.price,0);
    const roomsBanc = monthRooms.filter(r => isCardOrBankPayment(r.paymentMethod)).reduce((s,r)=>s+r.price,0);
    const salesEfec = monthSales.filter(s => isCashPayment(s.paymentMethod)).reduce((s,r)=>s+r.total,0);
    const salesBanc = monthSales.filter(s => isCardOrBankPayment(s.paymentMethod)).reduce((s,r)=>s+r.total,0);
    const totalIngresos = roomsEfec + salesEfec;

    const invCats = ['inversiones_alimentos','inversiones_sexshop'];
    const allDirect = _mrData.directExpenses || [];
    const invTotal    = allDirect.filter(e=>invCats.includes(e.category)).reduce((s,e)=>s+e.amount,0);
    const directTotal = allDirect.reduce((s,e)=>s+(e.amount||0),0);
    const indirTotal  = (_mrData.indirectExpenses||[]).reduce((s,e)=>s+e.amount,0);
    const nonOpTotal  = (_mrData.nonOpExpenses||[]).reduce((s,e)=>s+e.amount,0);
    const utBruta     = totalIngresos - (directTotal - invTotal) - indirTotal;
    const utNeta      = utBruta - invTotal - nonOpTotal;
    const salItems    = _mrData.salaries || [];
    const salAcum     = salItems.reduce((s,e)=>s+(e.neto||0),0);

    // ─── HOJA 1: RESUMEN ─────────────────────────────────────────────────────
    const resumen = [
        ['REPORTE MENSUAL — ' + mesNombre.toUpperCase() + ' ' + _mrYear],
        [],
        ['RESUMEN EJECUTIVO'],
        [],
        ['CONCEPTO', '', 'MONTO'],
        [],
        ['INGRESOS'],
        ['  Habitaciones (efectivo)', '', fmtMoney(roomsEfec)],
        ['  Habitaciones (banco)*', '', fmtMoney(roomsBanc)],
        ['  Ventas inventario (efectivo)', '', fmtMoney(salesEfec)],
        ['  Ventas inventario (banco)*', '', fmtMoney(salesBanc)],
        [],
        ['TOTAL INGRESOS EFECTIVO', '', fmtMoney(totalIngresos)],
        [],
        [],
        ['EGRESOS'],
        ['  Gastos directos (operativos)', '', fmtMoney(directTotal - invTotal)],
        ['  Gastos indirectos', '', fmtMoney(indirTotal)],
        ['  Inversiones', '', fmtMoney(invTotal)],
        ['  Gastos no operativos', '', fmtMoney(nonOpTotal)],
        ['  Nómina', '', fmtMoney(salAcum)],
        [],
        ['TOTAL EGRESOS', '', fmtMoney((directTotal - invTotal) + indirTotal + invTotal + nonOpTotal + salAcum)],
        [],
        [],
        ['UTILIDADES'],
        ['  Utilidad Bruta', '', fmtMoney(utBruta)],
        ['  Utilidad Neta', '', fmtMoney(utNeta)],
        [],
        [],
        ['NOTAS:'],
        ['* Los ingresos a banco son ilustrativos y no se suman al efectivo disponible'],
        ['* La utilidad bruta = Ingresos - (Gastos directos - Inversiones) - Gastos indirectos'],
        ['* La utilidad neta = Utilidad bruta - Inversiones - Gastos no operativos'],
    ];
    const wsResumen = XLSX.utils.aoa_to_sheet(resumen);
    wsResumen['!cols'] = [{wch:45},{wch:5},{wch:20}];
    
    // Aplicar formato al resumen
    if (wsResumen['A1']) wsResumen['A1'].s = { font: { bold: true, sz: 14 } };
    if (wsResumen['A3']) wsResumen['A3'].s = { font: { bold: true } };
    if (wsResumen['A7']) wsResumen['A7'].s = { font: { bold: true } };
    if (wsResumen['A16']) wsResumen['A16'].s = { font: { bold: true } };
    if (wsResumen['A26']) wsResumen['A26'].s = { font: { bold: true } };
    
    XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

    // ─── HOJA 2: GASTOS (formato mejorado) ──────────────────────────────────
    const gastoRows = [];
    gastoRows.push(['GASTOS DETALLADOS — ' + mesNombre.toUpperCase() + ' ' + _mrYear]);
    gastoRows.push([]);
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push(['GASTOS DE OPERACIÓN']);
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push([]);

    const catLabels = {
        agua: 'AGUA', 
        luz: 'LUZ', 
        gas: 'GAS',
        limpieza: 'PRODUCTOS DE LIMPIEZA',
        inversiones_alimentos: 'ALIMENTOS Y BEBIDAS',
        inversiones_sexshop: 'SEX SHOP',
        mercadotecnia: 'MERCADOTECNIA',
        otros: 'GENERALES',
    };
    const catOrder = ['agua','luz','gas','limpieza','inversiones_alimentos','inversiones_sexshop','mercadotecnia','otros'];
    let totalDirectOp = 0;

    catOrder.forEach(function(cat) {
        const items = allDirect.filter(function(e){ return e.category === cat; });
        gastoRows.push(['─── ' + (catLabels[cat] || cat.toUpperCase()) + ' ───']);
        gastoRows.push(['Fecha', 'Concepto', '', 'Monto', '', '']);
        
        if (items.length === 0) {
            gastoRows.push(['', '(sin registros)', '', fmtMoney(0), '', '']);
        } else {
            let acum = 0;
            items.forEach(function(e) {
                acum += e.amount;
                gastoRows.push([e.date || '—', e.concept || '—', '', fmtMoney(e.amount), '', '']);
            });
            gastoRows.push([]);
            gastoRows.push(['', '', '', 'SUBTOTAL:', '', fmtMoney(acum)]);
            totalDirectOp += acum;
        }
        gastoRows.push([]);
    });

    // Salarios
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push(['─── NÓMINA / SALARIOS ───']);
    gastoRows.push(['Fecha', 'Empleado', '', 'Monto', '', '']);
    
    if (salItems.length === 0) {
        gastoRows.push(['', '(sin registros)', '', fmtMoney(0), '', '']);
    } else {
        salItems.forEach(function(e) {
            const employeeName = e.concept || e.name || '—';
            gastoRows.push([e.date || '—', employeeName, '', fmtMoney(e.neto || 0), '', '']);
        });
    }
    gastoRows.push([]);
    gastoRows.push(['', '', '', 'SUBTOTAL NÓMINA:', '', fmtMoney(salAcum)]);
    gastoRows.push([]);
    gastoRows.push(['', '', '', 'TOTAL GASTOS DE OPERACIÓN:', '', fmtMoney(totalDirectOp + salAcum)]);
    gastoRows.push([]);
    gastoRows.push([]);

    // Indirectos
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push(['GASTOS INDIRECTOS']);
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push([]);
    
    const indirCatLabels = { 
        mercadotecnia:'MERCADOTECNIA', 
        administracion:'ADMINISTRACIÓN', 
        mantenimiento:'MANTENIMIENTO' 
    };
    const indirBycat = {};
    (_mrData.indirectExpenses||[]).forEach(function(e) {
        if (!indirBycat[e.category]) indirBycat[e.category] = [];
        indirBycat[e.category].push(e);
    });
    
    let totalIndir = 0;
    
    if (Object.keys(indirBycat).length === 0) {
        gastoRows.push(['(sin registros)']);
    } else {
        Object.entries(indirBycat).forEach(function(entry) {
            const cat = entry[0], items = entry[1];
            gastoRows.push(['─── ' + (indirCatLabels[cat] || cat.toUpperCase()) + ' ───']);
            gastoRows.push(['Fecha', 'Concepto', '', 'Monto', '', '']);
            
            let acum = 0;
            items.forEach(function(e) { 
                acum += e.amount; 
                gastoRows.push([e.date || '—', e.concept || '—', '', fmtMoney(e.amount), '', '']); 
            });
            gastoRows.push([]);
            gastoRows.push(['', '', '', 'SUBTOTAL:', '', fmtMoney(acum)]);
            gastoRows.push([]);
            totalIndir += acum;
        });
    }
    
    gastoRows.push(['', '', '', 'TOTAL GASTOS INDIRECTOS:', '', fmtMoney(totalIndir)]);
    gastoRows.push([]);
    gastoRows.push([]);

    // No operativos
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push(['INVERSIONES Y GASTOS NO OPERATIVOS']);
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push([]);
    gastoRows.push(['Fecha', 'Concepto', '', 'Monto', '', '']);
    
    let totalNonOp = 0;
    if ((_mrData.nonOpExpenses||[]).length === 0) {
        gastoRows.push(['', '(sin registros)', '', fmtMoney(0), '', '']);
    } else {
        (_mrData.nonOpExpenses||[]).forEach(function(e) {
            totalNonOp += e.amount;
            gastoRows.push([e.date || '—', e.concept || '—', '', fmtMoney(e.amount), '', '']);
        });
    }
    gastoRows.push([]);
    gastoRows.push(['', '', '', 'TOTAL NO OPERATIVOS:', '', fmtMoney(totalNonOp)]);
    gastoRows.push([]);
    gastoRows.push(['', '', '', 'TOTAL INVERSIONES (incluidas en directos):', '', fmtMoney(invTotal)]);
    gastoRows.push([]);
    gastoRows.push([]);
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push(['RESUMEN FINAL']);
    gastoRows.push(['═══════════════════════════════════════════════════════════════']);
    gastoRows.push([]);
    gastoRows.push(['', '', '', 'UTILIDAD BRUTA:', '', fmtMoney(utBruta)]);
    gastoRows.push(['', '', '', 'UTILIDAD NETA:', '', fmtMoney(utNeta)]);

    const wsGastos = XLSX.utils.aoa_to_sheet(gastoRows);
    wsGastos['!cols'] = [{wch:14},{wch:35},{wch:4},{wch:18},{wch:4},{wch:18}];
    XLSX.utils.book_append_sheet(wb, wsGastos, 'Gastos');

    // ─── HOJA 3: INGRESOS DIARIOS (formato Lili) ─────────────────────────────
    const dailyRows = await buildDailyIncomeSheet();
    const wsDaily = XLSX.utils.aoa_to_sheet(dailyRows);
    wsDaily['!cols'] = [{wch:6},{wch:12},{wch:8},{wch:10},{wch:8},{wch:8},{wch:10},{wch:10},{wch:14},{wch:12},{wch:14},{wch:14},{wch:12}];
    XLSX.utils.book_append_sheet(wb, wsDaily, 'Ingresos Diarios');

    // ─── HOJA 4: NOMINA POR SEMANAS ───────────────────────────────────────────────
    const nomRows = [
        ['NÓMINA MENSUAL — ' + mesNombre.toUpperCase() + ' ' + _mrYear],
        [],
        ['DESGLOSE POR SEMANAS'],
        []
    ];
    
    let totalGeneralNomina = 0;
    
    // Procesar cada semana (1 a 4)
    for (let weekNum = 1; weekNum <= 4; weekNum++) {
        // Filtrar empleados que trabajan en esta semana (campo 'weeks' es array)
        const weekEmployees = _payrollEmployees.filter(e => {
            if (e.weeks && Array.isArray(e.weeks)) {
                return e.weeks.includes(weekNum);
            }
            // Compatibilidad con formato antiguo (campo 'week' singular)
            return e.week === weekNum;
        });
        
        if (weekEmployees.length === 0) {
            nomRows.push([`SEMANA ${weekNum}`, '', '', '', '']);
            nomRows.push(['(sin empleados registrados)']);
            nomRows.push([]);
            continue;
        }
        
        nomRows.push([`SEMANA ${weekNum}`]);
        nomRows.push([]);
        nomRows.push(['Nombre', 'Departamento', 'Turno', 'Tarifa Diaria', 'Días', 'Total']);
        nomRows.push([]); // Línea separadora
        
        let weekTotal = 0;
        
        // Agrupar por turno para mejor organización
        const byShift = {
            'día': [],
            'noche': [],
            'día, fin de semana': [],
            'noche, fin de semana': []
        };
        
        weekEmployees.forEach(emp => {
            const shiftKey = emp.shift.toLowerCase();
            if (byShift[shiftKey]) {
                byShift[shiftKey].push(emp);
            } else {
                byShift['día'].push(emp); // Fallback
            }
        });
        
        // Procesar cada turno
        Object.entries(byShift).forEach(([shiftName, employees]) => {
            if (employees.length === 0) return;
            
            // Título del turno
            const shiftLabel = shiftName.toUpperCase();
            nomRows.push([shiftLabel, '', '', '', '', '']);
            
            // Agrupar por departamento dentro del turno
            const byDept = {
                'lavanderia': [],
                'suites-lm': [],
                'casa': []
            };
            
            employees.forEach(emp => {
                const deptKey = emp.department.toLowerCase();
                if (byDept[deptKey]) {
                    byDept[deptKey].push(emp);
                } else {
                    byDept['lavanderia'].push(emp); // Fallback
                }
            });
            
            // Procesar cada departamento
            Object.entries(byDept).forEach(([deptKey, deptEmployees]) => {
                if (deptEmployees.length === 0) return;
                
                const deptLabel = deptKey === 'lavanderia' ? 'Lavandería'
                    : deptKey === 'suites-lm' ? 'Suites LM'
                    : deptKey === 'casa' ? 'Casa'
                    : deptKey;
                
                // Empleados del departamento
                deptEmployees.forEach(emp => {
                    const dailyRate = sanitizeNumber(emp.dailyRate, 0);
                    const days = sanitizeInt(emp.days, 0);
                    const total = sanitizeNumber(emp.total, dailyRate * days);
                    
                    nomRows.push([
                        sanitizeHTML(emp.name || 'Sin nombre'),
                        deptLabel,
                        '', // Turno ya está en el header
                        fmtMoney(dailyRate),
                        days.toString(),
                        fmtMoney(total)
                    ]);
                    
                    weekTotal += total;
                });
            });
            
            nomRows.push([]); // Espacio entre turnos
        });
        
        // Subtotal de la semana
        nomRows.push(['', '', '', '', 'SUBTOTAL SEMANA ' + weekNum, fmtMoney(weekTotal)]);
        nomRows.push([]);
        nomRows.push([]); // Doble espacio entre semanas
        
        totalGeneralNomina += weekTotal;
    }
    
    // Total general
    nomRows.push([]);
    nomRows.push(['', '', '', '', 'TOTAL GENERAL NÓMINA', fmtMoney(totalGeneralNomina)]);
    nomRows.push([]);
    nomRows.push(['* Este total debe coincidir con los salarios en la hoja de Gastos']);
    
    const wsNomina = XLSX.utils.aoa_to_sheet(nomRows);
    wsNomina['!cols'] = [{wch:25},{wch:15},{wch:20},{wch:15},{wch:8},{wch:15}];
    
    // Aplicar formato a las celdas de encabezado
    const range = XLSX.utils.decode_range(wsNomina['!ref']);
    for (let R = range.s.r; R <= range.e.r; ++R) {
        for (let C = range.s.c; C <= range.e.c; ++C) {
            const cellAddress = XLSX.utils.encode_cell({r: R, c: C});
            if (!wsNomina[cellAddress]) continue;
            
            // Aplicar formato a títulos y subtotales
            const cellValue = wsNomina[cellAddress].v;
            if (typeof cellValue === 'string') {
                if (cellValue.includes('SEMANA') || cellValue.includes('TOTAL') || cellValue.includes('NÓMINA')) {
                    wsNomina[cellAddress].s = {
                        font: { bold: true },
                        fill: { fgColor: { rgb: "E8E8E8" } }
                    };
                }
            }
        }
    }
    
    XLSX.utils.book_append_sheet(wb, wsNomina, 'Nomina');

    XLSX.writeFile(wb, 'ReporteMensual_' + mesNombre + '_' + _mrYear + '.xlsx');
    showToast('Descargando Excel: ' + mesNombre + ' ' + _mrYear, 'success');
}

window.downloadMonthlyExcel = downloadMonthlyExcel;