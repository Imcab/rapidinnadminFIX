import { syncLog, DEBUG_SYNC, currentUser, activityLog, setActivityLog } from '../app.js';

import { saveData } from '../utils/storage-utils.js';

// ============================================================================
// LOGGER — helpers de bajo nivel de logging (sync log, conflictos de merge,
// activity log de datos, y el buffer de debug que usa el panel de
// diagnóstico). Sale de partir log.js + debug.js.
// ============================================================================

// --- de debug.js ---
const _appDebugLog = [];
export function _pushAppDebug(event, detail) {
    try {
        _appDebugLog.push({ t: Date.now(), event, detail: detail || '' });
        if (_appDebugLog.length > 50) _appDebugLog.shift();
    } catch (e) {}
}
export function getAppDebugLog() {
    return _appDebugLog;
}

// --- de log.js ---
export function logSync(message, type = 'info', data = null) {
    const timestamp = new Date().toISOString();
    const deviceId = localStorage.getItem('_deviceId') || 'unknown';
    
    const logEntry = {
        timestamp,
        deviceId,
        type,
        message,
        data: data ? JSON.stringify(data).substring(0, 200) : null
    };
    
    syncLog.push(logEntry);
    
    // Mantener solo los últimos 100 logs
    if (syncLog.length > 100) {
        syncLog.shift();
    }
    
    if (DEBUG_SYNC) {
        const color = {
            'info': '#0099ff',
            'success': '#00aa00', 
            'warning': '#ff9900',
            'error': '#ff0000',
            'sync': '#9900ff'
        }[type] || '#ffffff';
        
        console.log(`%c[SYNC-${deviceId}] ${message}`, `color: ${color}`, data || '');
    }
}

/**
 * Registra conflictos de merge para auditoría
 */
export function logMergeConflict(roomId, field, oldValue, newValue, resolution) {
    try {
        const conflictLog = JSON.parse(localStorage.getItem('_mergeConflictLog') || '[]');
        
        conflictLog.push({
            roomId,
            field,
            oldValue,
            newValue,
            resolution,
            timestamp: Date.now(),
            date: new Date().toLocaleString()
        });
        
        // Mantener últimos 100 conflictos
        if (conflictLog.length > 100) {
            conflictLog.splice(0, conflictLog.length - 100);
        }
        
        localStorage.setItem('_mergeConflictLog', JSON.stringify(conflictLog));
    } catch (e) {
        console.error('[Merge] Error guardando log de conflictos:', e);
    }
}


// Agregar actividad al log
export function logActivity(type, description, details = {}) {
    activityLog.push({
        id: Date.now(),
        type, // 'rooms', 'sales', 'expenses', 'shift'
        description,
        details,
        user: currentUser ? currentUser.name : 'Sistema',
        timestamp: Date.now()
    });
    
    // Mantener solo los últimos 100 registros
    if (activityLog.length > 100) {
        setActivityLog(activityLog.slice(-100));
    }
    
    saveData();
}


/**
 * Ver log de conflictos (para debugging)
 */
export function showMergeConflictLog() {
    try {
        const log = JSON.parse(localStorage.getItem('_mergeConflictLog') || '[]');
        console.log('=== LOG DE CONFLICTOS DE MERGE ===');
        console.log(`Total de conflictos: ${log.length}`);
        console.table(log.slice(-20)); // Últimos 20
        return log;
    } catch (e) {
        console.error('Error leyendo log:', e);
        return [];
    }
}