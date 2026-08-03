// ============ SAFARI FIX PATCH v5.9.8 ============
// Este script corrige problemas específicos de Safari
// Aplicar ANTES de cargar app.js

console.log('[Safari Fix] 🍎 Aplicando correcciones para Safari...');

// 1. Detectar Safari
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
console.log('[Safari Fix] Navegador detectado:', isSafari ? 'Safari' : 'Otro');

// 2. Polyfill para Promise.race si es necesario
if (!Promise.race) {
    Promise.race = function(promises) {
        return new Promise((resolve, reject) => {
            promises.forEach(promise => {
                Promise.resolve(promise).then(resolve, reject);
            });
        });
    };
}

// 3. Mejorar localStorage para Safari (modo privado puede fallar)
// FIXED: Verificar si localStorage realmente falla antes de parchear
let localStorageWorks = true;
try {
    const testKey = '_safari_test_' + Date.now();
    localStorage.setItem(testKey, 'test');
    localStorage.removeItem(testKey);
    console.log('[Safari Fix] localStorage funciona correctamente');
} catch (e) {
    localStorageWorks = false;
    console.warn('[Safari Fix] localStorage no disponible, aplicando parche');
}

// FIXED: Solo aplicar parche si localStorage falla
if (!localStorageWorks) {
    const originalSetItem = localStorage.setItem;
    const originalGetItem = localStorage.getItem;

    localStorage.setItem = function(key, value) {
        try {
            return originalSetItem.call(this, key, value);
        } catch (e) {
            console.warn('[Safari Fix] Error guardando en localStorage:', key, e);
            // FIXED: Intentar sessionStorage primero antes de memoria
            try {
                sessionStorage.setItem(key, value);
                console.log('[Safari Fix] Guardado en sessionStorage:', key);
            } catch (e2) {
                // Fallback a memoria si sessionStorage también falla
                if (!window._memoryStorage) window._memoryStorage = {};
                window._memoryStorage[key] = value;
                console.log('[Safari Fix] Guardado en memoria:', key);
            }
        }
    };

    localStorage.getItem = function(key) {
        try {
            const value = originalGetItem.call(this, key);
            if (value !== null) return value;
        } catch (e) {
            console.warn('[Safari Fix] Error leyendo de localStorage:', key, e);
        }
        
        // FIXED: Intentar sessionStorage antes de memoria
        try {
            const sessionValue = sessionStorage.getItem(key);
            if (sessionValue !== null) return sessionValue;
        } catch (e) {
            // Continuar a memoria
        }
        
        // Fallback a memoria
        if (window._memoryStorage && window._memoryStorage[key]) {
            return window._memoryStorage[key];
        }
        return null;
    };
}

// 4. Forzar inicialización de Firebase antes de cualquier operación
window.waitForFirebaseReady = function() {
    return new Promise((resolve) => {
        let attempts = 0;
        const maxAttempts = 50; // 5 segundos máximo
        
        const checkFirebase = () => {
            attempts++;
            
            if (window.FirebaseSync && window.FirebaseSync.ready) {
                console.log('[Safari Fix] ✅ Firebase listo después de', attempts * 100, 'ms');
                resolve(true);
            } else if (attempts >= maxAttempts) {
                console.warn('[Safari Fix] ⚠️ Firebase no respondió, continuando sin él');
                resolve(false);
            } else {
                setTimeout(checkFirebase, 100);
            }
        };
        
        checkFirebase();
    });
};

// 5. Ejecutar verificación al cargar (solo verificar, NO crear datos)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('[Safari Fix] ✅ DOM listo, esperando a que app.js cargue datos desde Firebase');
    });
} else {
    console.log('[Safari Fix] ✅ DOM listo, esperando a que app.js cargue datos desde Firebase');
}

console.log('[Safari Fix] ✅ Correcciones aplicadas');

