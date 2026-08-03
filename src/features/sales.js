import {
    sales, editingProductId, currentCategoryFilter,
    setSales, setEditingProductId, setCurrentCategoryFilter, inventory, currentUser, currentShiftStart
} from '../app.js';

import { sanitizeHTML, showCustomConfirm } from '../utils/formatters.js';
import { addSaleToMovements } from './monthly-report.js';
import { validatePaymentMethod } from './rooms.js';
import { getCurrentShift, getPeriodStart, updateRevenueStats } from './shifts.js';
import { saveData } from '../utils/storage-utils.js';
import { showToast } from '../utils/toast-system.js';

// ============================================================================
// SALES — inventario, ventas de productos y estadísticas relacionadas.
// Extraído de app.js tal cual (sin convertir a módulo ES todavía).
// ============================================================================

export function saveProduct() {
    const name = document.getElementById('productName').value;
    const category = document.getElementById('productCategory').value;
    const quantity = parseInt(document.getElementById('productQuantity').value);
    const price = parseFloat(document.getElementById('productPrice').value);
    
    if (!name || !category || quantity < 0 || price < 0 || Number.isNaN(quantity) || Number.isNaN(price)) {
        showToast('Por favor completa todos los campos correctamente', 'error');
        return;
    }

    if (editingProductId != null) {
        const item = inventory.find(i => i.id === editingProductId);
        if (item) {
            item.name = name;
            item.category = category;
            item.quantity = quantity;
            item.price = price;
            item.lastModified = Date.now();
        }
        setEditingProductId(null);
    } else {
        inventory.push({ id: Date.now(), name, category, quantity, price, lastModified: Date.now() });
    }
    saveData();
    renderInventory();
    
    document.getElementById('productName').value = '';
    document.getElementById('productCategory').value = 'bebidas';
    document.getElementById('productQuantity').value = '';
    document.getElementById('productPrice').value = '';
    const saveBtn = document.getElementById('saveProductBtn');
    if (saveBtn) saveBtn.textContent = 'Guardar';
    document.getElementById('productModal').classList.remove('show');
}

export function renderInventory() {
    const list = document.getElementById('inventoryList');
    list.innerHTML = '';

    // Filtrar por categoría (y excluir eliminados)
    const visibleInventory = inventory.filter(item => !item.deleted);
    const filteredInventory = currentCategoryFilter === 'all'
        ? visibleInventory
        : visibleInventory.filter(item => item.category === currentCategoryFilter);

    filteredInventory.forEach(item => {
        const div = document.createElement('div');
        div.className = 'inventory-item';

        const isAdmin = currentUser && (currentUser.role === 'supervisor' || currentUser.role === 'director');

        // Nombres de categorías para mostrar
        const categoryNames = {
            'sex-shop': 'Sex Shop',
            'alimentos': 'Alimentos',
            'bebidas': 'Bebidas',
            'otros': 'Otros'
        };

        const categoryBadge = item.category ? `<span class="category-badge ${item.category}">${categoryNames[item.category] || item.category}</span>` : '';

        div.innerHTML = `
            <div class="inventory-item-info">
                <strong style=\"color:#1e2a3a;font-size:14px;\">${sanitizeHTML(item.name)}</strong>${categoryBadge}<br>
                <span class="inventory-details">Cantidad: ${item.quantity} | Precio: $${item.price.toFixed(2)}</span>
            </div>
            ${isAdmin ? `
                <div class="inventory-item-actions">
                    <button class="btn-edit-inventory" onclick="editInventoryItem(${item.id})" title="Editar">✏️</button>
                    <button class="btn-delete-inventory" onclick="deleteInventoryItem(${item.id})" title="Eliminar">&times;</button>
                </div>
            ` : ''}
        `;
        list.appendChild(div);
    });

    updateProductSelect();
}

export function updateProductSelect() {
    const select = document.getElementById('productSelect');
    select.innerHTML = '<option value="">Seleccionar Producto</option>';
    
    inventory.filter(item => !item.deleted && item.quantity > 0).forEach(item => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = `${item.name} ($${item.price.toFixed(2)}) - ${item.quantity} disponibles`;
        select.appendChild(option);
    });
}

export function processSale() {
    const sellBtn = document.getElementById('sellBtn');
    const productId = parseInt(document.getElementById('productSelect').value);
    const quantity = parseInt(document.getElementById('quantityInput').value);
    
    if (!productId || !quantity || quantity < 1) {
        showToast('Por favor selecciona un producto y cantidad válida', 'error');
        return;
    }
    
    const product = inventory.find(p => p.id === productId);
    if (!product || product.deleted) {
        showToast('Producto no encontrado o ya no existe', 'error');
        return;
    }
    
    // Validación de stock
    if (product.quantity < quantity) {
        showToast(`Stock insuficiente. Solo hay ${product.quantity} unidades disponibles`, 'error');
        return;
    }
    
    // Validar Método de pago
    const paymentMethod = validatePaymentMethod('salePaymentMethod', 'Por favor selecciona un Método de pago');
    if (!paymentMethod) return;
    
    // Prevenir duplicados - deshabilitar botón
    sellBtn.disabled = true;
    sellBtn.textContent = 'Procesando...';
    
    product.quantity -= quantity;
    product.lastModified = Date.now();
    const total = product.price * quantity;
    
    sales.push({
        id: Date.now(),
        productName: product.name,
        quantity,
        price: product.price,
        total,
        timestamp: Date.now(),
        shift: getCurrentShift().type,
        shiftName: getCurrentShift().name,
        paymentMethod: paymentMethod
    });
    
    // Limitar a últimos 5000 registros para evitar problemas de tamaño
    if (sales.length > 5000) {
        console.warn('[Sistema] Archivando ventas antiguas...');
        setSales(sales.slice(-5000));
    }
    
    // Agregar automáticamente a movimientos según método de pago
    addSaleToMovements({
        id: Date.now(),
        items: [{name: product.name, quantity, price: product.price}],
        total,
        timestamp: Date.now(),
        paymentMethod: paymentMethod
    });
    
    saveData();
    renderInventory();
    renderSalesLog();
    
    // Registrar actividad (deshabilitado)
    // logActivity('sales', `Venta: ${quantity} ${product.name} - $${total.toFixed(2)}`, {
    //     productId: product.id,
    //     productName: product.name,
    //     quantity,
    //     total
    // });
    
    showToast(`✅ Venta registrada: ${quantity} ${product.name} - $${total.toFixed(2)}`, 'success');
    
    document.getElementById('quantityInput').value = '1';
    
    // Rehabilitar botón después de 1 segundo
    setTimeout(() => {
        sellBtn.disabled = false;
        sellBtn.textContent = 'Vender';
    }, 1000);
}

export function renderSalesLog() {
    const log = document.getElementById('salesLog');
    if (!log) return;
    
    // Filtrar ventas del turno actual (desde currentShiftStart)
    const currentShift = getCurrentShift();
    const shiftSales = sales.filter(s => 
        s.timestamp >= currentShiftStart && s.shift === currentShift.type
    );
    
    log.innerHTML = '<h3>Ventas del Turno Actual</h3>';
    
    if (shiftSales.length === 0) {
        log.innerHTML += '<p style="text-align:center;color:#999;padding:20px;">No hay ventas en este turno</p>';
        return;
    }
    
    // Mostrar las últimas 10 ventas del turno
    shiftSales.slice().reverse().slice(0, 10).forEach(sale => {
        const div = document.createElement('div');
        div.className = 'sale-item';
        
        const date = new Date(sale.timestamp);
        const timeStr = date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
        const paymentIcon = sale.paymentMethod === 'efectivo' ? '💵' : '💳';
        
        div.innerHTML = `
            <div class="sale-item-header">
                <strong>${sanitizeHTML(sale.productName)}</strong>
                <span class="sale-amount">$${sale.total.toFixed(2)} ${paymentIcon}</span>
            </div>
            <div class="sale-item-details">
                <span>Cantidad: ${sale.quantity}</span>
                <span>Precio unitario: $${sale.price.toFixed(2)}</span>
                <span>${timeStr}</span>
            </div>
        `;
        log.appendChild(div);
    });
    
    // Mostrar total del turno
    const totalTurno = shiftSales.reduce((sum, s) => sum + s.total, 0);
    const totalDiv = document.createElement('div');
    totalDiv.className = 'sale-total';
    totalDiv.innerHTML = `
        <strong>Total del turno:</strong>
        <span>$${totalTurno.toFixed(2)}</span>
    `;
    log.appendChild(totalDiv);
}

export function resetProductModal() {
    setEditingProductId(null);
    document.getElementById('productName').value = '';
    document.getElementById('productQuantity').value = '';
    document.getElementById('productPrice').value = '';
    const catEl = document.getElementById('productCategory');
    if (catEl) catEl.value = 'bebidas';
    const saveBtn = document.getElementById('saveProductBtn');
    if (saveBtn) saveBtn.textContent = 'Guardar';
}

export function filterInventoryByCategory(category, btn) {
    setCurrentCategoryFilter(category);
    document.querySelectorAll('.category-filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderInventory();
}

export function updateProductStats(period) {
    const container = document.getElementById('productStats');
    if (!container) return;
    const timeAgo = getPeriodStart(period);
    const periodSales = sales.filter(s => s.timestamp >= timeAgo);
    const productCount = {};
    periodSales.forEach(s => { productCount[s.productName] = (productCount[s.productName] || 0) + s.quantity; });
    const sorted = Object.entries(productCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (sorted.length === 0) { container.innerHTML = '<p style="color:#999;text-align:center;font-size:13px;">Sin ventas en este período</p>'; return; }
    container.innerHTML = sorted.map(([name, qty], idx) =>
        `<div class="sc-rank-item r${idx+1}"><div class="sc-rank-num">${idx+1}</div><span class="sc-rank-name">${name}</span><span class="sc-rank-value">${qty} uds</span></div>`
    ).join('');
}

export function updateSalesStats(period = 'day') { updateRevenueStats(period); }

export function editInventoryItem(itemId) {
    const item = inventory.find(i => i.id === itemId);
    if (!item) return;
    setEditingProductId(itemId);
    const modal = document.getElementById('productModal');
    document.getElementById('productName').value = item.name;
    document.getElementById('productCategory').value = item.category || 'bebidas';
    document.getElementById('productQuantity').value = item.quantity;
    document.getElementById('productPrice').value = item.price;
    const saveBtn = document.getElementById('saveProductBtn');
    if (saveBtn) saveBtn.textContent = 'Actualizar';
    modal.classList.add('show');
}

export function deleteInventoryItem(itemId) {
    const item = inventory.find(i => i.id === itemId);
    if (!item) return;
    showCustomConfirm('Eliminar Producto', 'Eliminar este producto del inventario?').then(confirmed => {
        if (!confirmed) return;
        // Soft-delete (igual que staff/anuncios/gastos) en vez de quitarlo del
        // arreglo: con la sincronización por merge-by-id, un id que
        // desaparece por completo de un lado puede "resucitar" si el otro
        // dispositivo todavía tiene una copia vieja del producto.
        item.deleted = true;
        item.deletedAt = Date.now();
        item.lastModified = Date.now();
        saveData();
        renderInventory();
        showToast('Producto eliminado', 'success');
    });
}

window.editInventoryItem = editInventoryItem;
window.deleteInventoryItem = deleteInventoryItem;

window.filterInventoryByCategory = filterInventoryByCategory;