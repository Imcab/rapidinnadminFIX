# Rapid Inn Admin - Sistema de Gestión Hotelera

Sistema completo de administración para moteles con gestión de habitaciones, inventario, ventas, turnos y reportes.

**Versión**: 5.9.8 (Safari Compatible)  
**URL**: https://rapid-inn-admin-beige.vercel.app  
**Última actualización**: 11 de Mayo, 2026

---

## CARACTERÍSTICAS

### Gestión de Habitaciones
- 32 habitaciones (28 regulares + 4 suites)
- Control de disponibilidad en tiempo real
- Registro de check-in/check-out
- Historial de ocupación
- Programación de limpieza profunda
- Reservas con bloqueo

### Inventario y Ventas
- Control de stock de productos
- Registro de ventas por categoría
- Alertas de stock bajo
- Estadísticas de productos más vendidos
- Punto de venta integrado

### Control de Turnos
- Sistema de turnos (día 6AM-6PM / noche 6PM-6AM)
- Registro de actividades por turno
- Cierre de turno con resumen financiero
- Historial de turnos
- Estadísticas en tiempo real

### Reportes y Estadísticas
- Reporte mensual completo
- Análisis de ingresos y gastos
- Estadísticas de ocupación
- Exportación a Excel
- Nómina semanal

### Gestión de Usuarios
- 4 roles: Director, Supervisor, Recepción, Limpieza
- Permisos diferenciados por rol
- Contraseñas hasheadas (SHA-256)
- Cambio seguro de contraseñas
- Sincronización automática entre dispositivos

### Sistema de Avisos
- Avisos del Director con 3 niveles de prioridad
- Asistencia de personal (Día/Noche)
- Estados: Pendiente, Asistió, Faltó

---

## TECNOLOGÍAS

- **Frontend**: HTML5, CSS3, JavaScript (Vanilla)
- **Backend**: Firebase (Firestore + Authentication)
- **Hosting**: Vercel
- **Librerías**: SheetJS (exportación Excel)

---

## INSTALACIÓN LOCAL

### Requisitos Previos
- Node.js 16+
- Cuenta de Firebase
- Navegador moderno (Chrome, Safari, Firefox, Edge)

### Pasos

1. **Clonar el repositorio**
```bash
git clone <tu-repo>
cd rapid-inn-admin
```

2. **Instalar dependencias**
```bash
npm install
```

3. **Configurar Firebase**
   - Crea un proyecto en [Firebase Console](https://console.firebase.google.com/)
   - Habilita Firestore Database
   - Habilita Authentication (Anónima)
   - Copia las credenciales a `firebase-sync.js`

4. **Aplicar reglas de seguridad**
   - Ve a Firestore Database → Rules
   - Copia el contenido de `firestore.rules`
   - Publica las reglas

5. **Ejecutar localmente**
```bash
# Servidor local simple
python -m http.server 8000
# O usa Live Server en VS Code
```

6. **Acceder**
   - Abre http://localhost:8000
   - Login con contraseñas por defecto (ver abajo)

---

## CONTRASEÑAS POR DEFECTO

Solo se usan si Firebase está vacío:

- **director** / rapid2024
- **supervisor** / supervisor123
- **recepcion** / recepcion123
- **limpieza** / limpieza2024

**IMPORTANTE**: Cambia estas contraseñas después del primer login.

---

## DESPLIEGUE

### Vercel (Recomendado)

```bash
# Instalar Vercel CLI
npm i -g vercel

# Desplegar
vercel --prod
```

### Otros Servicios
El proyecto es estático y puede desplegarse en:
- Netlify
- GitHub Pages
- Firebase Hosting
- Cualquier servidor web

---

## ESTRUCTURA DEL PROYECTO

```
rapid-inn-admin/
├── index.html              # Página principal
├── app.js                  # Lógica principal (365 KB)
├── styles.css              # Estilos CSS
├── firebase-sync.js        # Sincronización con Firebase
├── safari-fix.js           # Correcciones para Safari
├── toast-system.js         # Sistema de notificaciones
├── firestore.rules         # Reglas de seguridad
├── vercel.json             # Configuración de Vercel
├── package.json            # Dependencias
├── README.md               # Este archivo
└── STATUS.md               # Estado del sistema
```

---

## COMPATIBILIDAD

### Navegadores Soportados:
- ✅ Chrome/Edge (Recomendado)
- ✅ Firefox
- ✅ Safari (Mac/iOS) - Corregido en v5.9.8
- ✅ Móviles (iOS/Android)

### Requisitos:
- Conexión a internet (para sincronización)
- JavaScript habilitado
- LocalStorage habilitado
- Cookies habilitadas

### Funciona Offline:
- ✅ Todas las funciones disponibles
- ✅ Datos guardados en localStorage
- ✅ Sincronización automática al reconectar

---

## USO

### Login
1. Ingresa con tu usuario y contraseña
2. El sistema te redirige según tu rol

### Gestión de Habitaciones
1. Ve a "Habitaciones"
2. Click en una habitación para ver detalles
3. Usa "Dar Habitación" o "Liberar" según corresponda

### Registro de Ventas
1. Ve a "Inventario y Ventas"
2. Selecciona producto y cantidad
3. Elige método de pago
4. Click en "Vender"

### Cierre de Turno
1. Ve a "Control de Turno y Estadísticas"
2. Revisa el resumen del turno
3. Click en "Cerrar turno y generar reporte"

### Reporte Mensual
1. Ve a "Reporte Mensual" (solo Director)
2. Selecciona mes y año
3. Revisa ingresos, gastos y utilidades
4. Click en "Descargar Excel" si necesitas

---

## TROUBLESHOOTING

### "Sin conexión" en el indicador
- Verifica tu conexión a internet
- Revisa que Firebase esté configurado correctamente
- Verifica las reglas de seguridad en Firestore

### Safari muestra datos diferentes que Chrome
- Limpia los datos del sitio en Safari
- Abre en modo privado
- Verifica en consola que dice: `[App] ✅ Usuarios cargados desde Firebase`

### Datos no se sincronizan
- Verifica las reglas de Firestore
- Revisa la consola del navegador (F12) para errores
- Verifica que tengas conexión a internet
- Ejecuta: `FirebaseSync.syncPending()`

---

## COMANDOS DE DIAGNÓSTICO

Abre la consola del navegador (F12) y ejecuta:

```javascript
// Ver estado de Firebase
console.log('Firebase Ready:', window.FirebaseSync?.ready);
console.log('Online:', window.FirebaseSync?.isOnline());
console.log('Pending:', window.FirebaseSync?.getPendingCount());

// Ver usuarios
console.log('Users:', users);

// Ver habitaciones
console.log('Rooms:', rooms);

// Forzar sincronización
FirebaseSync.syncPending();

// Cargar datos de Firebase
FirebaseSync.loadAll().then(data => console.log(data));

// Resetear contraseñas (EMERGENCIA)
resetPasswordsToDefault();
```

---

## SEGURIDAD

### Implementado:
- ✅ Contraseñas hasheadas (SHA-256)
- ✅ Autenticación por roles
- ✅ Permisos por perfil
- ✅ Validación de inputs
- ✅ Sanitización de HTML (protección XSS)
- ✅ Firestore Rules configuradas

### Firebase:
- Proyecto: rapid-inn-deploy
- Autenticación: Anónima
- Base de datos: Firestore
- Reglas: Ver `firestore.rules`

---

## HISTORIAL DE VERSIONES

### v5.9.8 (11 Mayo 2026) - Corrección Safari Final
- ✅ Safari carga datos desde Firebase correctamente
- ✅ motelUsers se guarda automáticamente en Firebase
- ✅ safari-fix.js agregado
- ✅ Sincronización completa entre dispositivos

### v5.9.3 (Anterior)
- Sincronización 2x más rápida
- Actualización automática cada 10 segundos

### v5.9.0 (Anterior)
- Sistema de contraseñas corregido
- Merge inteligente en Firebase

### v5.8.0 (Anterior)
- Optimización de rendimiento (30x más rápido)

---

## SOPORTE

Para soporte técnico:
- Revisa STATUS.md para estado del sistema
- Ejecuta comandos de diagnóstico (ver arriba)
- Contacta al equipo de desarrollo

---

**Versión**: 5.9.8 (Safari Compatible)  
**URL**: https://rapid-inn-admin-beige.vercel.app  
**Última actualización**: 11 de Mayo, 2026

### Gestión de Habitaciones
- Control de disponibilidad en tiempo real
- Registro de check-in/check-out
- Historial de ocupación
- Programación de limpieza profunda

### Inventario y Ventas
- Control de stock de productos
- Registro de ventas
- Alertas de stock bajo
- Estadísticas de productos más vendidos

### Control de Turnos
- Sistema de turnos (día/noche)
- Registro de actividades por turno
- Cierre de turno con resumen financiero
- Historial de turnos

### Reportes y Estadísticas
- Reporte mensual completo
- Análisis de ingresos y gastos
- Estadísticas de ocupación
- Exportación a Excel

### Gestión de Usuarios
- 4 roles: Director, Supervisor, Recepción, Limpieza
- Permisos diferenciados por rol
- Cambio seguro de contraseñas
- Registro de actividades

## 🛠️ Tecnologías

- **Frontend**: HTML5, CSS3, JavaScript (Vanilla)
- **Backend**: Firebase (Firestore + Authentication)
- **Hosting**: Vercel
- **Librerías**: SheetJS (exportación Excel)

## 📦 Instalación

### Requisitos Previos
- Node.js 16+
- Cuenta de Firebase
- Cuenta de Vercel (opcional)

### Configuración Local

1. **Clonar el repositorio**
```bash
git clone <tu-repo>
cd rapid-inn-admin
```

2. **Instalar dependencias**
```bash
npm install
```

3. **Configurar Firebase**
   - Crea un proyecto en [Firebase Console](https://console.firebase.google.com/)
   - Habilita Firestore Database
   - Habilita Authentication (Email/Password)
   - Copia las credenciales a `firebase-sync.js`

4. **Configurar usuario admin**
   - En Firebase Authentication, crea un usuario:
     - Email: `rapidinnadmin@gmail.com` (o el que prefieras)
     - Password: (tu contraseña segura)
   - Actualiza las credenciales en `firebase-sync.js`:
     ```javascript
     const FIREBASE_AUTH_EMAIL = 'tu-email@gmail.com';
     const FIREBASE_AUTH_PASSWORD = 'tu-password';
     ```

5. **Aplicar reglas de seguridad**
   - Ve a Firestore Database → Rules
   - Copia el contenido de `firestore.rules`
   - Publica las reglas

6. **Ejecutar localmente**
```bash
# Servidor local simple
python -m http.server 8000
# O usa Live Server en VS Code
```

## 🚀 Despliegue

### Vercel (Recomendado)

```bash
# Instalar Vercel CLI
npm i -g vercel

# Desplegar
vercel --prod
```

### Otros Servicios
El proyecto es estático y puede desplegarse en:
- Netlify
- GitHub Pages
- Firebase Hosting
- Cualquier servidor web

## 📁 Estructura del Proyecto

```
rapid-inn-admin/
├── index.html              # Página principal
├── app.js                  # Lógica de la aplicación (v5.5.0)
├── styles.css              # Estilos
├── firebase-sync.js        # Sincronización con Firebase
├── toast-system.js         # Notificaciones
├── firestore.rules         # Reglas de seguridad
├── vercel.json             # Configuración de Vercel
├── package.json            # Dependencias
├── README.md               # Documentación
├── STATUS.md               # Estado del sistema
└── SEGURIDAD_REFORZADA_v5.5.0.md  # Documentación de seguridad
```

## 🔐 Seguridad

### Reglas de Firestore

**Desarrollo** (acceso abierto):
```javascript
allow read, write: if true;
```

**Producción** (solo usuarios autenticados):
```javascript
allow read, write: if request.auth != null;
```

### Contraseñas
- Hasheadas con SHA-256
- Almacenadas en Firestore
- Cambio seguro desde la interfaz

### Roles y Permisos
- **Director**: Acceso total
- **Supervisor**: Gestión operativa
- **Recepción**: Check-in/out, ventas
- **Limpieza**: Solo limpieza

## 📊 Uso

### Login
1. Ingresa con tu email y contraseña
2. El sistema te redirige según tu rol

### Gestión de Habitaciones
1. Ve a "Habitaciones"
2. Click en una habitación para ver detalles
3. Usa "Check-in" o "Check-out" según corresponda

### Registro de Ventas
1. Ve a "Inventario y Ventas"
2. Click en "Vender"
3. Selecciona productos y cantidad
4. Elige método de pago

### Cierre de Turno
1. Ve a "Control de Turno"
2. Revisa el resumen del turno
3. Click en "Cerrar Turno"

### Reporte Mensual
1. Ve a "Reporte Mensual"
2. Selecciona mes y año
3. Revisa ingresos, gastos y utilidades
4. Exporta a Excel si necesitas

## 🐛 Troubleshooting

### "Sin conexión" en el indicador
- Verifica tu conexión a internet
- Revisa que Firebase esté configurado correctamente
- Verifica las reglas de seguridad en Firestore

### Error de autenticación
- Verifica que el usuario exista en Firebase Authentication
- Verifica que las credenciales en `firebase-sync.js` sean correctas
- Verifica que Authentication esté habilitado

### Datos no se sincronizan
- Verifica las reglas de Firestore
- Revisa la consola del navegador (F12) para errores
- Verifica que tengas conexión a internet

## 📝 Comandos de Diagnóstico

Abre la consola del navegador (F12) y ejecuta:

```javascript
// Ver estado de Firebase
console.log('Firebase Ready:', window.FirebaseSync?.ready);
console.log('Online:', window.FirebaseSync?.isOnline());
console.log('Pending:', window.FirebaseSync?.getPendingCount());

// Forzar sincronización
window.FirebaseSync.syncPending();

// Ver items problemáticos
console.log('Failed:', window.FirebaseSync.getFailedItems());
```

## 🔒 Seguridad v5.5.0

### Mejoras de Seguridad Implementadas
- ✅ Protección XSS completa (sanitización en 10 funciones)
- ✅ Contraseñas hasheadas con SHA-256
- ✅ Eliminadas funciones de testing en producción
- ✅ Validaciones robustas en todas las operaciones
- ✅ Fallbacks para prevenir errores

Ver documento completo: `SEGURIDAD_REFORZADA_v5.5.0.md`

## 🔄 Sistema de Sincronización

El sistema usa Firebase Firestore para sincronización en tiempo real:
- Sincronización automática entre dispositivos
- Sistema de reconexión automática
- Merge inteligente de datos
- Cola de operaciones offline
- Protección contra pérdida de datos

**Comandos de diagnóstico** (consola del navegador F12):
```javascript
// Ver estado de Firebase
console.log('Firebase Ready:', window.FirebaseSync?.ready);
console.log('Online:', window.FirebaseSync?.isOnline());
console.log('Pending:', window.FirebaseSync?.getPendingCount());

// Forzar sincronización
window.FirebaseSync.syncPending();
```

## 📈 Roadmap

- [ ] PWA (Progressive Web App)
- [ ] Notificaciones push
- [ ] Modo offline completo
- [ ] Dashboard con gráficas
- [ ] Integración con sistemas de pago
- [ ] App móvil nativa

## 🤝 Contribuir

Las contribuciones son bienvenidas. Por favor:
1. Fork el proyecto
2. Crea una rama para tu feature
3. Commit tus cambios
4. Push a la rama
5. Abre un Pull Request

## 📄 Licencia

Este proyecto es privado y propietario.

## 👤 Autor

Rapid Inn Admin Team

## 📞 Soporte

Para soporte, contacta a: rapidinnadmin@gmail.com

---

**Versión**: 5.5.0 - Seguridad Reforzada  
**Última actualización**: Abril 2026
