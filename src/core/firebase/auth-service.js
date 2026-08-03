//src/core/firebase/auth-service

import { signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { auth, log, error, pushDebug } from './config.js';

let isAuthReady = false;
let isAuthPending = false;
let authRetries = 0;
let authCooldownUntil = 0;

const MAX_AUTH_RETRIES = 3;
const AUTH_RETRY_COOLDOWN_MS = 30000;
const AUTH_TIMEOUT_MS = 10000;

function authTimeout(promise, ms){
    return Promise.race([
        promise,
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error('auth-timeout')), ms)
        )
    ]);
}

async function ensureAuth() {

    if (isAuthReady && auth.currentUser){
        return true;
    }

    if (isAuthReady && !auth.currentUser){
        isAuthReady = false;
    }

    if (Date.now() < authCooldownUntil){
        log('[Auth Service] Enfriamiento activo tras fallos. Esperando...');
        return false;
    }

    if (auth.currentUser){
        isAuthReady = true;
        log('[Auth Service] Sesión activa detectada');
        return true;
    }

    if (isAuthPending){
        return false;
    }

    isAuthPending = true;

    try {
        log('[Auth Service] Iniciando sesión anónima...');
        await authTimeout(signInAnonymously(auth), AUTH_TIMEOUT_MS);
        
        isAuthReady = true;
        isAuthPending = false;
        authRetries = 0;
        
        log('[Auth Service] Autenticación anónima exitosa');
        pushDebug('auth-ok');
        return true;

    } catch (e) {
        isAuthPending = false;
        authRetries++;
        
        const errCode = e.code || e.message;
        error(`[Auth Service] Error de autenticación (intento ${authRetries}):`, errCode);
        pushDebug('auth-fail', `intento ${authRetries}: ${errCode}`);

        if (authRetries < MAX_AUTH_RETRIES) {
            log('[Auth Service] Reintentando en 2 segundos...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            return ensureAuth();
        } else {
            error(`[Auth Service] Límite de ${MAX_AUTH_RETRIES} intentos alcanzado. Entrando en cooldown.`);
            authCooldownUntil = Date.now() + AUTH_RETRY_COOLDOWN_MS;
            authRetries = 0;
            return false;
        }
    }
}

onAuthStateChanged(auth, (user) =>{
    if(user){
        isAuthReady = true;
        log('[Auth Service] Usuario activo:', user.uid);
    }else{
        isAuthReady = false;
        log('[Auth Service] Sesión cerrada o no iniciada');
    }
});

ensureAuth();

export{
    ensureAuth,
    isAuthReady,
    auth
};