// ============ SCRIPT DE EMERGENCIA - RESETEO DE CONTRASEÑAS ============
// Este script resetea todas las contraseñas a valores por defecto
// Solo usar en caso de emergencia cuando no se puede acceder al sistema

console.log('🚨 INICIANDO RESETEO DE EMERGENCIA DE CONTRASEÑAS...');

// Esperar a que Firebase esté listo
function waitForFirebase() {
    return new Promise((resolve) => {
        if (window.FirebaseSync && window.FirebaseSync.ready) {
            resolve(true);
            return;
        }
        
        let attempts = 0;
        const checkInterval = setInterval(() => {
            attempts++;
            if (window.FirebaseSync && window.FirebaseSync.ready) {
                clearInterval(checkInterval);
                resolve(true);
            } else if (attempts > 30) { // 15 segundos máximo
                clearInterval(checkInterval);
                resolve(false);
            }
        }, 500);
    });
}

async function emergencyPasswordReset() {
    console.log('🔄 Esperando Firebase...');
    const firebaseReady = await waitForFirebase();
    
    if (!firebaseReady) {
        console.error('❌ Firebase no disponible');
        alert('Error: Firebase no disponible. Verifica tu conexión a internet.');
        return;
    }
    
    console.log('✅ Firebase listo, iniciando reseteo...');
    
    // Usuarios por defecto con contraseñas en texto plano
    const defaultUsers = [
        { username: 'director', password: 'rapid2024', role: 'director', name: 'Director', email: '', lastModified: Date.now() },
        { username: 'supervisor', password: 'supervisor123', role: 'supervisor', name: 'Supervisor', email: '', lastModified: Date.now() },
        { username: 'recepcion', password: 'recepcion123', role: 'recepcion', name: 'Recepción', email: '', lastModified: Date.now() },
        { username: 'limpieza', password: 'limpieza2024', role: 'limpieza', name: 'Limpieza', email: '', lastModified: Date.now() }
    ];
    
    try {
        // 1. Limpiar localStorage
        console.log('🧹 Limpiando localStorage...');
        localStorage.removeItem('motelUsers');
        localStorage.removeItem('currentUser');
        localStorage.removeItem('_pwd_director');
        localStorage.removeItem('_pwd_supervisor');
        localStorage.removeItem('_pwd_recepcion');
        localStorage.removeItem('_pwd_limpieza');
        
        // 2. Guardar usuarios en localStorage
        console.log('💾 Guardando usuarios en localStorage...');
        localStorage.setItem('motelUsers', JSON.stringify(defaultUsers));
        
        // 3. Guardar contraseñas para visualización
        console.log('🔑 Guardando contraseñas para visualización...');
        for (const user of defaultUsers) {
            localStorage.setItem(`_pwd_${user.username}`, user.password);
        }
        
        // 4. Guardar en Firebase
        console.log('☁️ Guardando en Firebase...');
        await window.FirebaseSync.save('motelUsers', defaultUsers);
        
        // 5. Guardar contraseñas en Firebase
        for (const user of defaultUsers) {
            await window.FirebaseSync.save(`_pwd_${user.username}`, user.password);
        }
        
        console.log('✅ RESETEO COMPLETADO EXITOSAMENTE');
        console.log('📋 CONTRASEÑAS RESETEADAS:');
        console.log('   director: rapid2024');
        console.log('   supervisor: supervisor123');
        console.log('   recepcion: recepcion123');
        console.log('   limpieza: limpieza2024');
        
        alert('✅ RESETEO COMPLETADO\n\nContraseñas reseteadas:\n• director: rapid2024\n• supervisor: supervisor123\n• recepcion: recepcion123\n• limpieza: limpieza2024\n\nRecarga la página para hacer login.');
        
    } catch (error) {
        console.error('❌ Error durante el reseteo:', error);
        alert('❌ Error durante el reseteo: ' + error.message);
    }
}

// Ejecutar automáticamente
emergencyPasswordReset();