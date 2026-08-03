import { getHotWindowMonths } from './hot-window.js';
import { _currentWeek, _mrMonth, _mrYear } from '../app.js';

// Check if timestamp is today
export function isToday(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    return date.toDateString() === today.toDateString();
}

// Update date and time
export function updateDateTime() {
    const el = document.getElementById('currentDate');
    if (el) el.textContent = new Date().toLocaleString();
}

// Get elapsed time
export function getElapsedTime(startTime) {
    if (!startTime) return '0h 0m'; // Validación para evitar NaN
    const elapsed = Date.now() - startTime;
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
}

export function getWeekRanges(year, month) {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const weeks = [];
    
    let currentWeek = 1;
    let weekStart = firstDay;
    
    while (weekStart <= lastDay) {
        let weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6); // Sumar 7 días
        
        // Si el fin de semana pasa el último día del mes, limitarlo al último día
        if (weekEnd > lastDay) {
            weekEnd = lastDay;
        }
        
        weeks.push({
            week: currentWeek,
            start: new Date(weekStart),
            end: weekEnd,
            startStr: weekStart.toLocaleDateString('es-MX'),
            endStr: weekEnd.toLocaleDateString('es-MX')
        });
        
        // Pasar a la siguiente semana
        weekStart = new Date(weekEnd);
        weekStart.setDate(weekStart.getDate() + 1);
        currentWeek++;
    }
    
    return weeks;
}

export function updateWeekDateRange() {
    const weekRangeEl = document.getElementById('weekDateRange');
    
    if (_currentWeek === 0) {
        // Todo el mes
        const monthName = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'][_mrMonth];
        weekRangeEl.textContent = `(${monthName} ${_mrYear})`;
    } else {
        // Semana específica
        const weeks = getWeekRanges(_mrYear, _mrMonth);
        const weekData = weeks.find(w => w.week === _currentWeek);
        if (weekData) {
            weekRangeEl.textContent = `(${weekData.startStr} - ${weekData.endStr})`;
        }
    }
}

// Función auxiliar para calcular tiempo transcurrido
export function getTimeAgo(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));
    
    if (days === 0) {
        return 'Hoy';
    } else if (days === 1) {
        return 'Ayer';
    } else if (days < 7) {
        return `Hace ${days} días`;
    } else if (days < 30) {
        const weeks = Math.floor(days / 7);
        return weeks === 1 ? 'Hace 1 semana' : `Hace ${weeks} semanas`;
    } else {
        return 'Hace más de un mes';
    }
}

export function getRecordMonth(timestamp) {
    const d = new Date(timestamp || 0);
    let year = d.getFullYear();
    let month = d.getMonth();
    if (d.getDate() === 1 && d.getHours() < 6) {
        const prev = new Date(year, month - 1, 1);
        year = prev.getFullYear();
        month = prev.getMonth();
    }
    return { year, month };
}

export function getMonthKey(timestamp) {
    const { year, month } = getRecordMonth(timestamp);
    return `${year}_${month}`;
}

export function _groupByMonth(arr) {
    const groups = new Map();
    (arr || []).forEach(item => {
        const key = getMonthKey(item.timestamp);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    });
    return groups;
}

// Solo el mes ACTUAL se cachea en localStorage (respaldo síncrono para el
// primer render antes de que Firebase responda). Los otros meses de la
// ventana caliente (mes anterior, y el anterior a ese) ya NO se duplican
// aquí — Firebase es quien los mantiene, y _loadHotShardsFromFirebase() los
// trae momentos después del primer render, como ya venía pasando. Guardar
// los 3 meses completos en localStorage era el principal responsable de que
// el aviso de "almacenamiento casi lleno" apareciera cada vez más seguido
// según crecía el historial del negocio.
export function _isCurrentHotMonth(year, month) {
    const current = getHotWindowMonths()[0];
    return current.year === year && current.month === month;
}