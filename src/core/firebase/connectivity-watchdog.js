// src/core/firebase/connectivity-watchdog.js
//
// Encapsula lo que antes vivía suelto dentro de app.js para decidir CUÁNDO
// sospechar que el stream compartido de Firestore quedó "zombie" (el SO
// suspendió la pestaña/el dispositivo y el stream dejó de entregar datos
// para siempre, sin disparar nunca su propio callback de error) y forzar
// una reconexión dura.
//
// A propósito, este módulo NO sabe nada de rooms/inventory/ventas ni de
// cómo re-renderizar la UI. Su único trabajo es: detectar la señal
// (visibilitychange real, watchdog periódico, evento 'online') y avisar
// vía el callback onStaleReturn(reason) — quien decide qué hacer con datos
// frescos (recargar, mergear, re-renderizar) es quien llama a este módulo
// (app.js), no este archivo. Así, "cuándo reconectar" (capa Firebase) y
// "qué hacer después" (capa app) quedan separados en vez de mezclados
// como estaban antes.

import { forceReconnectAll } from './sync-engine.js';

const STALE_THRESHOLD_MS = 60 * 1000;        // oculto > 1 min → posible stream muerto
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;  // revisar cada 5 min mientras la pestaña está visible
const MIN_TRIGGER_GAP_MS = 5000;             // evita disparar dos reconexiones casi simultáneas
                                              // (p.ej. 'online' y 'visibilitychange' casi juntos)

let initialized = false;

export function initConnectivityWatchdog(onStaleReturn) {
    if (initialized) return; // evita registrar los listeners dos veces si se llama por error más de una vez
    initialized = true;

    let hiddenSince = 0;
    let lastTrigger = 0;

    function trigger(reason) {
        const now = Date.now();
        if (now - lastTrigger < MIN_TRIGGER_GAP_MS) return;
        lastTrigger = now;

        forceReconnectAll();

        if (typeof onStaleReturn === 'function') {
            try { onStaleReturn(reason); } catch (e) {}
        }
    }

    // Caso 1: la pestaña vuelve a ser visible tras haber estado oculta un
    // rato. Ojo: los navegadores móviles a veces disparan 'visibilitychange'
    // sin que la pestaña haya estado realmente oculta (al abrir la PWA, al
    // mostrar un permiso del sistema, etc.) — por eso NO se dispara nada si
    // hiddenSince nunca se marcó, y tampoco si estuvo oculta muy poco tiempo.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            hiddenSince = Date.now();
            return;
        }
        if (hiddenSince === 0) return;
        const hiddenMs = Date.now() - hiddenSince;
        hiddenSince = 0;
        if (hiddenMs < STALE_THRESHOLD_MS) return;
        trigger('volver del background');
    });

    // Caso 2: la pestaña nunca se oculta (p.ej. el dispositivo de recepción
    // con la pantalla siempre encendida) — nunca pasaría por el caso 1, así
    // que se revisa igual cada 5 minutos mientras siga visible.
    setInterval(() => {
        if (!document.hidden) trigger('watchdog periódico');
    }, WATCHDOG_INTERVAL_MS);

    // Caso 3: el navegador recupera conexión de red. El stream pudo haber
    // quedado zombie mientras estuvo sin red (mismo motivo que el caso 1).
    window.addEventListener('online', () => trigger('evento online'));
}