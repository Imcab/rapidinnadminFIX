/**
 * FUNCIÓN DE EMERGENCIA: Forzar sincronización de contraseñas desde Firebase
 * 
 * INSTRUCCIONES:
 * 1. Abre la consola del navegador (F12)
 * 2. Copia y pega esta función completa
 * 3. Ejecuta: forceSyncPasswords()
 * 4. Espera a que termine y recargue la página
 * 5. Intenta hacer login con la contraseña correcta
 */

window.forceSyncPasswords = async function() {
    console.log('[Emergency] 🔄 Forzando sincronización de contraseñas desde Firebase...');
    
    if (!window.FirebaseSync || !window.FirebaseSync.ready) {
        console.error('[Emergency] ❌ Firebase no disponible');
        alert('❌ Firebase no disponible. Verifica tu conexión a internet.');
        return false;
    }
    
    try {
        // Cargar usuarios desde Firebase
        console.log('[Emergency] Cargando usuarios desde Firebase...');
        const fbUsers = await window.FirebaseSync.load('motelUsers');
        
        if (!fbUsers || !Array.isArray(fbUsers)) {
            console.error('[Emergency] ❌ No hay usuarios en Firebase');
            alert('❌ No hay usuarios en Firebase');
            return false;
        }
        
        console.log('[Emergency] ✅ Usuarios cargados:', fbUsers.length);
        
        // Actualizar localStorage y variable global
        localStorage.setItem('motelUsers', JSON.stringify(fbUsers));
        if (typeof users !== 'undefined') {
            users = fbUsers;
        }
        
        // Cargar contraseñas en texto plano desde Firebase
        const pwdKeys = ['_pwd_supervisor', '_pwd_director', '_pwd_recepcion', '_pwd_limpieza'];
        let pwdCount = 0;
        
        console.log('[Emergency] Cargando contraseñas...');
        for (const key of pwdKeys) {
            const pwd = await window.FirebaseSync.load(key, null);
            if (pwd) {
                localStorage.setItem(key, pwd);
                const username = key.replace('_pwd_', '');
                console.log(`[Emergency] ✅ ${username}: "${pwd}"`);
                pwdCount++;
            } else {
                console.warn(`[Emergency] ⚠️ No se encontró: ${key}`);
            }
        }
        
        console.log('[Emergency] ✅ Sincronización completa!');
        console.log('[Emergency] - Usuarios sincronizados:', fbUsers.length);
        console.log('[Emergency] - Contraseñas sincronizadas:', pwdCount);
        
        alert(`✅ Sincronización completa!\n\nUsuarios: ${fbUsers.length}\nContraseñas: ${pwdCount}\n\nLa página se recargará en 2 segundos...`);
        
        // Recargar la página para aplicar cambios
        setTimeout(() => {
            location.reload();
        }, 2000);
        
        return true;
        
    } catch (error) {
        console.error('[Emergency] ❌ Error:', error);
        alert(`❌ Error sincronizando:\n${error.message}\n\nRevisa la consola para más detalles.`);
        return false;
    }
};

// Ejecutar automáticamente si se carga este script
console.log('✅ Función forceSyncPasswords() cargada');
console.log('📝 Para sincronizar contraseñas, ejecuta: forceSyncPasswords()');
