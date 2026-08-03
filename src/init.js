import {
    currentUser, activeIntervals, currentFilter, searchRoomNumber, _shiftDataStale,
    setCurrentFilter, setSearchRoomNumber, setShiftDataStale, users, loadData, inventory, rooms, currentRoomId, switchTab, setUsers
} from './app.js';

import { addAnnouncement, saveAnnouncementFromModal } from './features/announcements.js';
import { addStaffMember, initUserManagement, saveStaffFromModal } from './features/attendance.js';
import { initDeepCleaningSystem } from './features/cleaning.js';
import { addExpense, updateExpensesByCategory, updateExpensesByPaymentMethod, updateExpensesTotal } from './features/expenses.js';
import { ensureRoomsSanity, migrateRoomNames, renderReservationsSidebar, renderRooms, updateRoomRevenueDisplay, updateRoomStatus, updateRoomTimers, updateRoomUsageStats } from './features/rooms.js';
import { processSale, renderInventory, renderSalesLog, resetProductModal, saveProduct, updateProductStats } from './features/sales.js';
import { updateShiftControl, updateStatistics } from './features/shifts.js';
import { checkStorageCapacity, safeJSONParse } from './utils/storage-utils.js';
import { _reactivateRealtimeListeners, rolloverHotWindowIfNeeded } from './utils/hot-window.js';
import { initFirebaseSync } from './system.js';
import { updateDateTime } from './utils/time.js';
import { showToast } from './utils/toast-system.js';
import { _getCachedUsersSync } from './features/users.js';

// Initialize app
export async function init() {
    console.log('[App] Inicializando aplicación...');
    
    // Usuarios ya cargados desde caché en DOMContentLoaded (instantáneo)
    if (!users || users.length === 0) setUsers(_getCachedUsersSync());

    // 🔥 CRÍTICO: Cargar datos desde localStorage primero
    loadData();
    
    // Migrar nombres de habitaciones de Torre Nueva (una sola vez)
    migrateRoomNames();
    
    setupEventListeners();
    renderRooms();
    renderReservationsSidebar();
    renderInventory();
    renderSalesLog(); // Renderizar ventas del turno actual
    updateStatistics();
    updateRoomRevenueDisplay('day');
    updateExpensesTotal();
    updateDateTime();
    initDeepCleaningSystem();
    
    // Inicializar gestión de usuarios (solo para director)
    if (currentUser && currentUser.role === 'director') {
        initUserManagement();
    }
    
    // Inicializar estadísticas de gastos (solo para director)
    if (currentUser && currentUser.role === 'director') {
        updateExpensesByPaymentMethod('day');
        updateExpensesByCategory('day');
    }
    
    // Inicializar intervalos y guardar IDs para poder limpiarlos
    activeIntervals.push(setInterval(updateDateTime, 1000));
    activeIntervals.push(setInterval(updateRoomTimers, 1000));
    
    // Verificar integridad al arrancar (sin propagar a Firebase si no hay cambios)
    ensureRoomsSanity();
    // Monitoreo periódico cada 4 horas — solo persiste si detecta cambio estructural real
    activeIntervals.push(setInterval(ensureRoomsSanity, 4 * 60 * 60 * 1000));
    // Revisar capacidad de almacenamiento al arrancar
    checkStorageCapacity();
    // Revisión periódica de capacidad cada 30 minutos
    activeIntervals.push(setInterval(checkStorageCapacity, 30 * 60 * 1000));

    // Revisión periódica de rotación de mes de la ventana caliente de
    // roomRevenue/sales/expenses (por si la app queda abierta cruzando la
    // medianoche del último día del mes) — cada hora es más que suficiente.
    activeIntervals.push(setInterval(rolloverHotWindowIfNeeded, 60 * 60 * 1000));
    
    activeIntervals.push(setInterval(() => {
        if (document.getElementById('shift-control-tab')?.classList.contains('active')) {
            updateShiftControl();
        } else {
            setShiftDataStale(true);
        }
    }, 30000)); // Actualizar control de turno cada 30 segundos

    // Auto-cierre de turno por desfase horario DESACTIVADO a pedido del
    // usuario: no dispara exactamente a las 6:15/18:15, sino en el primer
    // chequeo disponible después de esa hora — si nadie abría la app en
    // ese rango, el cierre (con reporte, cobros incluidos) aparecía horas
    // más tarde sin que quedara claro por qué (ver autoCloseShiftIfOverdue
    // más abajo, que queda sin usar). El corte de turno vuelve a ser 100%
    // manual.
    // activeIntervals.push(setInterval(() => {
    //     autoCloseShiftIfOverdue().catch(err => console.error('[Turno] Error en auto-cierre:', err));
    // }, 60000));

    // Sincronización periódica de DATOS sigue DESACTIVADA - causaba pérdida
    // de datos (recargar/pisar el estado local periódicamente).
    //
    // Esto de abajo es distinto: reconecta los streams en tiempo real
    // (motelData completo + motelRoomDocs), sin leer ni escribir ningún
    // dato propio de la app — no puede pisar nada. Hace falta porque un
    // dispositivo que se queda con la pestaña abierta y VISIBLE durante
    // horas/días (recepción, pantalla siempre encendida) nunca pasa por
    // 'carga inicial' ni por "volver de background" — si su stream muere en
    // silencio (el caso "zombie" que forceReconnectAll existe para
    // resolver: el SO puede matar la conexión sin que dispare nunca el
    // callback de error) queda sordo indefinidamente hasta un reload manual.
    // 2026-07-18: la reactivación barata de acá (_reactivateRealtimeListeners,
    // que solo re-mapea callbacks en memoria asumiendo que el stream sigue
    // vivo) NO alcanza para este caso — hace falta la reconexión DURA
    // (forceReconnectAll) para que el watchdog cumpla lo que su propio
    // propósito dice. Costo: una relectura completa de ambas colecciones
    // cada 5 min mientras la pestaña está visible — trivial (ya medido en
    // segundos) y sin importancia con el plan Blaze activo.
    activeIntervals.push(setInterval(() => {
        if (!document.hidden) {
            if (window.FirebaseSync && window.FirebaseSync.forceReconnectAll) {
                window.FirebaseSync.forceReconnectAll();
            }
            _reactivateRealtimeListeners('watchdog periódico');
        }
    }, 5 * 60 * 1000));

    initFirebaseSync().catch(err => {
        console.error('[Firebase] Error en sincronización:', err);
    });
}


// Setup event listeners
export function setupEventListeners() {
    // ============ ATAJOS DE TECLADO GLOBALES ============
    document.addEventListener('keydown', (e) => {
        // Escape: Cerrar modal activo
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal.show').forEach(modal => {
                modal.classList.remove('show');
            });
        }
        
        // Ctrl/Cmd + H: Ir a Habitaciones
        if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
            e.preventDefault();
            switchTab('rooms');
        }
        
        // Ctrl/Cmd + I: Ir a Inventario
        if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
            e.preventDefault();
            switchTab('inventory');
        }
        
        // Ctrl/Cmd + T: Ir a Control de Turno
        if ((e.ctrlKey || e.metaKey) && e.key === 't') {
            e.preventDefault();
            switchTab('shift-control');
        }
        
        // F5 sin Ctrl: Recargar datos (sin recargar página)
        if (e.key === 'F5' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            loadData();
            showToast('📡 Datos recargados', 'info');
        }
    });
    
    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            switchTab(tab);
        });
    });

    // Room modal
    const roomModal = document.getElementById('roomModal');
    roomModal.querySelector('.close').addEventListener('click', () => {
        roomModal.classList.remove('show');
    });

    roomModal.querySelectorAll('.modal-actions .btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const action = e.target.dataset.action;
            if (currentRoomId) {
                // Interceptar "Reservar" para mostrar mensaje
                if (action === 'reserved') {
                    roomModal.classList.remove('show');
                    showToast('La función de reservas ha sido desactivada', 'info');
                    return;
                }
                updateRoomStatus(currentRoomId, action);
            }
            roomModal.classList.remove('show');
        });
    });

    // Product modal
    const productModal = document.getElementById('productModal');
    document.getElementById('addProductBtn').addEventListener('click', () => {
        resetProductModal();
        productModal.classList.add('show');
    });

    productModal.querySelector('.close').addEventListener('click', () => {
        productModal.classList.remove('show');
        resetProductModal();
    });

    document.getElementById('saveProductBtn').addEventListener('click', saveProduct);

    // Botón de agregar personal (asistencia)
    const btnAddStaff = document.getElementById('btnAddStaff');
    if (btnAddStaff) {
        btnAddStaff.addEventListener('click', addStaffMember);
    }

    // Botón de agregar aviso
    const btnAddAnnouncement = document.getElementById('btnAddAnnouncement');
    if (btnAddAnnouncement) {
        btnAddAnnouncement.addEventListener('click', addAnnouncement);
    }

    // Modal de avisos
    const announcementModal = document.getElementById('announcementModal');
    if (announcementModal) {
        const closeBtn = announcementModal.querySelector('.close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                announcementModal.classList.remove('show');
            });
        }
        
        const saveBtn = document.getElementById('saveAnnouncementBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', saveAnnouncementFromModal);
        }
    }

    // Modal de personal
    const staffModal = document.getElementById('staffModal');
    if (staffModal) {
        const closeBtn = staffModal.querySelector('.close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                staffModal.classList.remove('show');
            });
        }
        
        const saveBtn = document.getElementById('saveStaffBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', saveStaffFromModal);
        }
    }

    // Cleaning modal
    const cleaningModal = document.getElementById('cleaningModal');
    cleaningModal.querySelector('.close').addEventListener('click', () => {
        cleaningModal.classList.remove('show');
    });

    // Sales
    document.getElementById('sellBtn').addEventListener('click', processSale);
    
    document.getElementById('addExpenseBtn').addEventListener('click', addExpense);
    
    
    // Period tabs for statistics
    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('sc-period-btn')) {
            const type = e.target.dataset.type;
            const period = e.target.dataset.period;
            
            // Update active state
            document.querySelectorAll(`.sc-period-btn[data-type="${type}"]`).forEach(btn => {
                btn.classList.remove('active');
            });
            e.target.classList.add('active');
            
            // Update stats
            if (type === 'products') {
                updateProductStats(period);
            } else if (type === 'rooms') {
                updateRoomUsageStats(period);
            }
        }
    });
    
    // Filtros de habitaciones
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            setCurrentFilter(btn.dataset.filter);
            if (!currentUser || currentUser.role !== 'limpieza') renderRooms();
        });
    });
    
    // Búsqueda de habitación
    const roomSearchInput = document.getElementById('roomSearchInput');
    if (roomSearchInput) {
        roomSearchInput.addEventListener('input', (e) => {
            const value = e.target.value.trim();
            setSearchRoomNumber(value ? parseInt(value) : null);
            if (!currentUser || currentUser.role !== 'limpieza') renderRooms();
        });
    }
}