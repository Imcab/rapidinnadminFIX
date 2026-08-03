//src/core/firebase/config

import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
    apiKey: "AIzaSyAGb15OXMpcx7YaI4eyCgpbfzonc9biujQ",
    authDomain: "rapid-inn-deploy.firebaseapp.com",
    projectId: "rapid-inn-deploy",
    storageBucket: "rapid-inn-deploy.firebasestorage.app",
    messagingSenderId: "695733542726",
    appId: "1:695733542726:web:53f5b5a9e8e15c161d0f47",
    measurementId: "G-BQ1RM6BSH4"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const DEBUG_MODE = false; //Cambiar a false en producción
const log = DEBUG_MODE ? console.log.bind(console) : () => {};
const warn = console.warn.bind(console);
const error = console.error.bind(console);

const syncDebugLog = [];
const SYNC_DEBUG_LOG_MAX = 150;

const SYNC_KEYS = [
    'motelRooms',
    'motelInventory',
    'motelShiftReports',
    'motelShiftSnapshots',
    'motelCurrentShiftStart',
    'motelCurrentShiftType',
    'motelActivityLog',
    'motelReservations',
    'deepCleanSchedules',
    'motelStaffMembers',
    'motelAnnouncements',
    'motelUsers',
    '_pwd_supervisor',
    '_pwd_director',
    '_pwd_recepcion',
    '_pwd_limpieza'
];

function pushDebug(event, detail = ''){
    try{
        syncDebugLog.push({ t: Date.now(), event, detail });
        if(syncDebugLog.length > SYNC_DEBUG_LOG_MAX){
            syncDebugLog.shift();
        }
    }catch(e){}
}

function inicializarDeviceId() {
    let deviceId = null;
    try {
        deviceId = localStorage.getItem('_deviceId');
        if (!deviceId) {
            deviceId = 'device_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
            localStorage.setItem('_deviceId', deviceId);
            log('[Firebase Config] Nuevo ID generado:', deviceId);
        } else {
            log('[Firebase Config] ID recuperado:', deviceId);
        }
    } catch (e) {
        //Fallback para Safari Privado o navegadores con almacenamiento bloqueado
        if (!window._memStorage) window._memStorage = {};
        if (!window._memStorage['_deviceId']) {
            window._memStorage['_deviceId'] = 'device_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
        }
        deviceId = window._memStorage['_deviceId'];
        warn('[Firebase Config] localStorage bloqueado. Usando ID en memoria:', deviceId);
    }
    return deviceId
}

const currentDeviceId = inicializarDeviceId();

function getDeviceId(){
    return currentDeviceId;
}

function getDebugLog(){
    return syncDebugLog.slice().reverse();
}

export { 
    app, 
    db, 
    auth, 
    currentDeviceId, 
    log, 
    warn, 
    error, 
    pushDebug, 
    syncDebugLog,
    getDeviceId,
    getDebugLog,
    SYNC_KEYS
};