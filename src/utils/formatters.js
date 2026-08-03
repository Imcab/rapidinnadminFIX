// src/utils/formatters.js

export function sanitizeHTML(str) {
    if (typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

export function escapeAttr(str) {
    return sanitizeHTML(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function createSafeHTML(template, data = {}) {
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string') {
            sanitized[key] = sanitizeHTML(value);
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            sanitized[key] = value;
        } else {
            sanitized[key] = '';
        }
    }
    let result = template;
    for (const [key, value] of Object.entries(sanitized)) {
        const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
        result = result.replace(regex, value);
    }
    return result;
}

export function sanitizeNumber(value, defaultValue = 0, min = -Infinity, max = Infinity) {
    const num = parseFloat(value);
    if (!isNaN(num) && isFinite(num)) {
        return Math.max(min, Math.min(max, num));
    }
    return defaultValue;
}

export function sanitizeInt(value, defaultValue = 0, min = -Infinity, max = Infinity) {
    const num = parseInt(value, 10);
    if (!isNaN(num) && isFinite(num)) {
        return Math.max(min, Math.min(max, num));
    }
    return defaultValue;
}

export function isValidTimestamp(ts) {
    return typeof ts === 'number' && ts > 0 && ts < Date.now() + 86400000;
}

export function sanitizeString(str, maxLength = 100) {
    if (typeof str !== 'string') return '';
    return str.trim().substring(0, maxLength);
}

export function sanitizePhone(phone) {
    if (typeof phone !== 'string') return '';
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length < 10) return '';
    return cleaned.substring(0, 20);
}

export function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function normalizePhone(raw) {
    const digits = String(raw || '').replace(/[^\d+]/g, '');
    return digits;
}

export function isValidEmail(email) {
    if (typeof email !== 'string') return false;
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email) && email.length <= 100;
}

// ============ UTILIDADES DE MÉTODOS DE PAGO ============

export function isCardOrBankPayment(pm) {
    return pm === 'tarjeta' || pm === 'banco';
}

export function isCashPayment(pm) {
    return (pm || 'efectivo') === 'efectivo';
}

export function fmt(n) { 
    return '$' + (Number(n) || 0).toFixed(2); 
}

// ============ CONTROL DE EVENTOS ============

export function throttle(func, delay) {
    let lastCall = 0;
    let timeoutId = null;
    let pendingArgs = null;
    return function(...args) {
        const now = Date.now();
        const remaining = delay - (now - lastCall);
        pendingArgs = args; 
        if (remaining <= 0) {
            if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
            lastCall = now;
            const a = pendingArgs; pendingArgs = null;
            return func.apply(this, a);
        }
        if (!timeoutId) {
            timeoutId = setTimeout(() => {
                lastCall = Date.now();
                timeoutId = null;
                const a = pendingArgs; pendingArgs = null;
                func.apply(this, a);
            }, remaining);
        }
    };
}

export function debounce(func, delay) {
    let timeoutId;
    return function(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
    };
}

export function translateStatus(status) {
    const translations = {
        'available': 'Disponible',
        'occupied': 'Ocupado',
        'dirty': 'Sucio',
        'not-available': 'No Disponible',
        'reserved': 'Reservado'
    };
    return translations[status] || status;
}


export function getExpectedShiftType(now = new Date()) {
    const hour = now.getHours();
    return (hour >= 6 && hour < 18) ? 'day' : 'night';
}

// Blindaje contra el formato {type, changedAt} que escribía código de una
// migración distinta (incidente 2026-07-16): un dispositivo con ese código
// todavía en memoria puede re-subir ese objeto a Firebase encima de un
// valor ya corregido. getCurrentShift() compara con === 'day', así que ese
// objeto (verdadero pero no === 'day') caía siempre a "noche" y las
// ganancias del turno se veían en $0 sin que nadie cerrara nada. Normaliza
// a la forma plana esperada en cualquier punto donde currentShiftType
// pueda venir de Firebase/localStorage, no solo aquí.
export function _normalizeShiftType(value) {
    // NO re-subir el valor corregido a Firebase: hacerlo confía en que el
    // ".type" embebido en el objeto corrupto es el turno correcto, cuando en
    // realidad puede venir de un dispositivo con código viejo cuyo estado en
    // memoria simplemente está desactualizado (p.ej. no vio un cierre de
    // turno manual que otro dispositivo sí hizo). Re-publicar ese valor como
    // si fuera la verdad puede pisar un cambio de turno legítimo hecho en
    // otro dispositivo. Esta función solo corrige la FORMA para uso local
    // (display/cálculo), sin tocar el documento compartido.
    if (value && typeof value === 'object' && typeof value.type === 'string') {
        return value.type;
    }
    // Cualquier otro valor que no sea exactamente 'day'/'night' es basura —
    // incluye el caso real encontrado el 2026-07-16: un `localStorage.setItem`
    // sin JSON.stringify en algún punto (código viejo) coaccionó un objeto a
    // su .toString(), guardando literalmente el string "[object Object]",
    // que NO es `typeof === 'object'` y por lo tanto no lo detectaba el
    // chequeo de arriba. getCurrentShift() trataba cualquier valor truthy
    // distinto de 'day' como "noche" sin más — con esta cadena forzaba
    // siempre noche sin importar la hora real, mostrando $0 de un turno que
    // nadie cerró. En vez de asumir "noche" para cualquier basura, calcular
    // el turno correcto por hora de reloj.
    if (value !== 'day' && value !== 'night') {
        return getExpectedShiftType();
    }
    return value;
}

/**
 * Obtener icono según rol
 */
export function getRoleIcon(role) {
    const icons = {
        'director': '👔',
        'supervisor': '👨‍💼',
        'recepcion': '🧑‍💻',
        'limpieza': '🧹'
    };
    return icons[role] || '👤';
}

/**
 * Obtener nombre del rol
 */
export function getRoleName(role) {
    const names = {
        'director': 'Director',
        'supervisor': 'Supervisor',
        'recepcion': 'Recepción',
        'limpieza': 'Limpieza'
    };
    return names[role] || role;
}

/**
 * Une dos arrays de objetos por su campo `id`, deduplicando.
 * El array `remote` gana en caso de colisión de IDs.
 * Se usa para sales, expenses, roomRevenue.
 */
export function mergeArraysById(remote, local) {
    if (!Array.isArray(remote) || remote.length === 0) return Array.isArray(local) ? local : [];
    if (!Array.isArray(local) || local.length === 0) return remote;
    const map = new Map();
    local.forEach(item => { if (item && item.id != null) map.set(item.id, item); });
    // El remoto solo gana si su timestamp es estrictamente más reciente;
    // en empate, el local conserva precedencia (evita sobrescribir con relojes desfasados)
    remote.forEach(item => {
        if (item && item.id != null) {
            const existing = map.get(item.id);
            if (!existing || (item.timestamp || 0) > (existing.timestamp || 0)) {
                map.set(item.id, item);
            }
        }
    });
    return Array.from(map.values()).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}


// Actualizar panel de alertas
// Sistema de confirmación personalizado
export function showCustomConfirm(title, message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('customConfirmModal');
        const titleEl = document.getElementById('confirmTitle');
        const messageEl = document.getElementById('confirmMessage');
        const yesBtn = document.getElementById('confirmYesBtn');
        const noBtn = document.getElementById('confirmNoBtn');

        if (!modal || !titleEl || !messageEl || !yesBtn || !noBtn) {
            // Fallback al confirm nativo si faltan elementos del DOM
            resolve(window.confirm(message));
            return;
        }

        titleEl.textContent = title;
        messageEl.textContent = message;

        modal.classList.add('show');
        
        const handleYes = () => {
            modal.classList.remove('show');
            yesBtn.removeEventListener('click', handleYes);
            noBtn.removeEventListener('click', handleNo);
            resolve(true);
        };
        
        const handleNo = () => {
            modal.classList.remove('show');
            yesBtn.removeEventListener('click', handleYes);
            noBtn.removeEventListener('click', handleNo);
            resolve(false);
        };
        
        yesBtn.addEventListener('click', handleYes);
        noBtn.addEventListener('click', handleNo);
    });
}

// Sistema de alerta personalizado
export function showCustomAlert(title, message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('customAlertModal');
        const titleEl = document.getElementById('alertTitle');
        const messageEl = document.getElementById('alertMessage');
        const okBtn = document.getElementById('alertOkBtn');

        if (!modal || !titleEl || !messageEl || !okBtn) {
            window.alert(message);
            resolve();
            return;
        }

        titleEl.textContent = title;
        messageEl.textContent = message;

        modal.classList.add('show');
        
        const handleOk = () => {
            modal.classList.remove('show');
            okBtn.removeEventListener('click', handleOk);
            resolve();
        };
        
        okBtn.addEventListener('click', handleOk);
    });
}