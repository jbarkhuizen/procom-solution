import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { resolveShippingForCheckout } from './shipping.js';
import { clampInt } from './util.js';

export const ORDER_STATUSES = ['pending_payment', 'paid', 'ordered', 'shipped', 'delivered', 'cancelled'];
export const STATUS_LABELS = {
  pending_payment: 'Awaiting payment',
  paid: 'Paid — to process',
  ordered: 'Ordered from supplier',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function rowToOrder(r, items = [], events = []) {
  return {
    id: r.id,
    orderNumber: r.order_number,
    status: r.status,
    statusLabel: STATUS_LABELS[r.status] || r.status,
    paymentStatus: r.payment_status,
    paymentMethod: r.payment_method,
    pfPaymentId: r.pf_payment_id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    phone: r.phone,
    address: {
      line1: r.address_line1,
      line2: r.address_line2,
      suburb: r.suburb,
      city: r.city,
      province: r.province,
      postalCode: r.postal_code,
    },
    pudoLocker: r.pudo_locker,
    customerNotes: r.customer_notes,
    shippingOptionId: r.shipping_option_id,
    shippingName: r.shipping_name,
    shippingCents: r.shipping_cents,
    subtotalCents: r.subtotal_cents,
    totalCents: r.total_cents,
    totalWeightG: r.total_weight_g,
    supplierRef: r.supplier_ref,
    trackingNumber: r.tracking_number,
    adminNotes: r.admin_notes,
    paidAt: r.paid_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    items: items.map((i) => ({
      id: i.id,
      productId: i.product_id,
      sku: i.sku,
      name: i.name,
      fulfilment: i.fulfilment,
      supplierId: i.supplier_id,
      supplierName: i.supplier_name || '',
      supplierCode: i.supplier_code,
      unitCostCents: i.unit_cost_cents,
      unitPriceCents: i.unit_price_cents,
      quantity: i.quantity,
      lineTotalCents: i.line_total_cents,
      weightG: i.weight_g,
    })),
    events: events.map((e) => ({ message: e.message, actor: e.actor, createdAt: e.created_at })),
  };
}

export function getOrder(id, db = getDb()) {
  const r = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!r) return null;
  const items = db.prepare('SELECT oi.*, s.name AS supplier_name FROM order_items oi LEFT JOIN suppliers s ON s.id = oi.supplier_id WHERE order_id = ?').all(id);
  const events = db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id').all(id);
  return rowToOrder(r, items, events);
}

export function logOrderEvent(orderId, message, actor = 'system', db = getDb()) {
  db.prepare('INSERT INTO order_events (order_id, message, actor, created_at) VALUES (?, ?, ?, ?)').run(orderId, message, actor, new Date().toISOString());
}

function nextOrderNumber(db) {
  const last = db.prepare("SELECT order_number FROM orders ORDER BY created_at DESC, order_number DESC LIMIT 1").get();
  const n = last ? Number(String(last.order_number).replace(/\D/g, '')) + 1 : 10001;
  return `PC${n}`;
}

// Builds the order from the DB, never from client-sent prices. The cart only
// contributes product ids + quantities.
export function createOrder(input, db = getDb()) {
  const c = input.customer || {};
  const customer = {
    firstName: str(c.firstName, 80),
    lastName: str(c.lastName, 80),
    email: str(c.email, 160).toLowerCase(),
    phone: str(c.phone, 30),
    line1: str(c.addressLine1),
    line2: str(c.addressLine2),
    suburb: str(c.suburb, 80),
    city: str(c.city, 80),
    province: str(c.province, 60),
    postalCode: str(c.postalCode, 12),
    pudoLocker: str(c.pudoLocker),
    notes: str(input.notes, 1000),
  };
  if (!customer.firstName) throw new Error('Please enter your first name');
  if (!EMAIL_RE.test(customer.email)) throw new Error('Please enter a valid email address');
  if (customer.phone.replace(/\D/g, '').length < 9) throw new Error('Please enter a valid phone number');

  const lines = Array.isArray(input.items) ? input.items.slice(0, 100) : [];
  if (!lines.length) throw new Error('Your cart is empty');
  const merged = new Map();
  for (const l of lines) {
    const q = clampInt(l.quantity, 1, 999, 0);
    if (!l.productId || !q) continue;
    merged.set(l.productId, (merged.get(l.productId) || 0) + q);
  }

  const getP = db.prepare('SELECT * FROM products WHERE id = ?');
  const items = [];
  for (const [productId, quantity] of merged) {
    const p = getP.get(productId);
    if (!p || !p.active) throw new Error('An item in your cart is no longer available. Please remove it and try again.');
    const available = p.fulfilment === 'stock' ? p.stock_qty > 0 : p.supplier_in_stock;
    if (!available) throw new Error(`"${p.name}" is out of stock. Please remove it from your cart.`);
    if (p.fulfilment === 'stock' && quantity > p.stock_qty) throw new Error(`Only ${p.stock_qty} of "${p.name}" in stock.`);
    if (quantity < p.min_order_qty) throw new Error(`"${p.name}" has a minimum order quantity of ${p.min_order_qty}.`);
    items.push({ p, quantity, line: p.price_cents * quantity });
  }
  if (!items.length) throw new Error('Your cart is empty');

  const subtotal = items.reduce((s, i) => s + i.line, 0);
  const weight = items.reduce((s, i) => s + i.p.weight_g * i.quantity, 0);
  const ship = resolveShippingForCheckout(input.shippingOptionId, weight, db);
  const isPudo = /pudo/i.test(ship.category) && ship.optionType === 'fixed';
  if (isPudo && !customer.pudoLocker) throw new Error('Please enter the PUDO locker you want your order delivered to');
  const needsAddress = !isPudo || /door/i.test(ship.name); // Locker-to-Door needs both
  if (needsAddress && (!customer.line1 || !customer.city || !customer.postalCode)) throw new Error('Please enter your delivery address (street, city and postal code)');

  const paymentMethod = input.paymentMethod === 'payfast_eft' ? 'payfast_eft' : 'payfast_card';
  const id = randomUUID();
  const ts = new Date().toISOString();

  const tx = db.transaction(() => {
    const orderNumber = nextOrderNumber(db);
    db.prepare(`INSERT INTO orders (id, order_number, status, payment_status, payment_method, first_name, last_name, email, phone,
      address_line1, address_line2, suburb, city, province, postal_code, pudo_locker, customer_notes,
      shipping_option_id, shipping_name, shipping_cents, subtotal_cents, total_cents, total_weight_g, created_at, updated_at)
      VALUES (@id, @orderNumber, 'pending_payment', 'pending', @paymentMethod, @firstName, @lastName, @email, @phone,
      @line1, @line2, @suburb, @city, @province, @postalCode, @pudoLocker, @notes,
      @shipId, @shipName, @shipCents, @subtotal, @total, @weight, @ts, @ts)`).run({
      id,
      orderNumber,
      paymentMethod,
      ...customer,
      shipId: ship.id,
      shipName: ship.name,
      shipCents: ship.priceCents,
      subtotal,
      total: subtotal + ship.priceCents,
      weight,
      ts,
    });
    const ins = db.prepare(`INSERT INTO order_items (id, order_id, product_id, sku, name, fulfilment, supplier_id, supplier_code, unit_cost_cents, unit_price_cents, quantity, line_total_cents, weight_g)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const { p, quantity, line } of items) {
      ins.run(randomUUID(), id, p.id, p.sku, p.name, p.fulfilment, p.supplier_id, p.supplier_code, p.cost_cents, p.price_cents, quantity, line, p.weight_g);
    }
    logOrderEvent(id, `Order placed (${paymentMethod === 'payfast_eft' ? 'Instant EFT' : 'Card'})`, 'customer', db);
  });
  tx();
  return getOrder(id, db);
}

// Idempotent: a repeated ITN for an already-paid order is a no-op.
export function markOrderPaid(id, { pfPaymentId = '' } = {}, db = getDb()) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!o) return { changed: false, order: null };
  if (o.payment_status === 'paid') return { changed: false, order: getOrder(id, db) };
  const ts = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare("UPDATE orders SET payment_status = 'paid', status = CASE WHEN status = 'pending_payment' THEN 'paid' ELSE status END, pf_payment_id = ?, paid_at = ?, updated_at = ? WHERE id = ?")
      .run(pfPaymentId, ts, ts, id);
    // Own-stock items leave inventory at payment time (not at checkout, so
    // abandoned Payfast sessions never hold stock hostage).
    for (const it of db.prepare("SELECT product_id, quantity FROM order_items WHERE order_id = ? AND fulfilment = 'stock'").all(id)) {
      db.prepare('UPDATE products SET stock_qty = MAX(0, stock_qty - ?), updated_at = ? WHERE id = ?').run(it.quantity, ts, it.product_id);
    }
    logOrderEvent(id, `Payment received via Payfast${pfPaymentId ? ` (pf ${pfPaymentId})` : ''}`, 'payfast', db);
  });
  tx();
  return { changed: true, order: getOrder(id, db) };
}

export function listOrders(opts = {}, db = getDb()) {
  const where = [];
  const params = {};
  if (opts.status && ORDER_STATUSES.includes(opts.status)) {
    where.push('status = @status');
    params.status = opts.status;
  } else if (!opts.includeUnpaid) {
    where.push("status != 'pending_payment'");
  }
  if (opts.q) {
    where.push('(order_number LIKE @q OR email LIKE @q OR first_name LIKE @q OR last_name LIKE @q OR phone LIKE @q)');
    params.q = `%${String(opts.q).trim()}%`;
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM orders ${w}`).get(params).n;
  const pageSize = clampInt(opts.pageSize, 1, 200, 50);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = clampInt(opts.page, 1, pages, 1);
  const rows = db
    .prepare(`SELECT o.*, (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) AS item_count FROM orders o ${w} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`)
    .all(params);
  return {
    items: rows.map((r) => ({ ...rowToOrder(r), itemCount: r.item_count || 0 })),
    total,
    page,
    pages,
  };
}

export function updateOrder(id, patch, actor = 'admin', db = getDb()) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!o) return null;
  const ts = new Date().toISOString();
  const changes = [];
  const set = {};
  if (patch.status !== undefined && patch.status !== o.status) {
    if (!ORDER_STATUSES.includes(patch.status)) throw new Error('Unknown status');
    if (patch.status !== 'cancelled' && o.payment_status !== 'paid' && patch.status !== 'pending_payment') {
      throw new Error('This order has not been paid yet');
    }
    set.status = patch.status;
    changes.push(`Status: ${STATUS_LABELS[o.status]} → ${STATUS_LABELS[patch.status]}`);
  }
  for (const [key, col, label] of [
    ['trackingNumber', 'tracking_number', 'Tracking number'],
    ['supplierRef', 'supplier_ref', 'Supplier order ref'],
    ['adminNotes', 'admin_notes', null],
  ]) {
    if (patch[key] !== undefined && String(patch[key]) !== o[col]) {
      set[col] = str(patch[key], 2000);
      if (label) changes.push(`${label}: ${set[col] || '(cleared)'}`);
    }
  }
  if (!Object.keys(set).length) return { order: getOrder(id, db), statusChangedTo: null };
  const cols = Object.keys(set);
  db.prepare(`UPDATE orders SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @ts WHERE id = @id`).run({ ...set, ts, id });
  for (const c of changes) logOrderEvent(id, c, actor, db);
  return { order: getOrder(id, db), statusChangedTo: set.status || null };
}

// Text block the owner pastes into an email/WhatsApp to the warehouse:
// what to pick, and where to deliver it (dropship = straight to customer).
export function supplierOrderSheet(order) {
  const bySupplier = new Map();
  for (const it of order.items.filter((i) => i.fulfilment === 'dropship')) {
    const key = it.supplierName || 'Supplier';
    if (!bySupplier.has(key)) bySupplier.set(key, []);
    bySupplier.get(key).push(it);
  }
  const a = order.address;
  const deliver = order.pudoLocker
    ? `PUDO locker: ${order.pudoLocker}`
    : [a.line1, a.line2, a.suburb, a.city, a.province, a.postalCode].filter(Boolean).join(', ');
  return [...bySupplier.entries()].map(([supplier, items]) => ({
    supplier,
    text: [
      `Order request — Procom Solutions ref ${order.orderNumber}`,
      '',
      ...items.map((i) => `${i.quantity} x ${i.supplierCode || i.sku} — ${i.name}`),
      '',
      'Please deliver directly to:',
      `${order.firstName} ${order.lastName} · ${order.phone}`,
      deliver,
      `Delivery method: ${order.shippingName}`,
    ].join('\n'),
  }));
}

export function dashboardStats(db = getDb()) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const paid30 = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) total FROM orders WHERE payment_status = 'paid' AND paid_at >= ?").get(since);
  const cost30 = db
    .prepare("SELECT COALESCE(SUM(oi.unit_cost_cents * oi.quantity),0) c FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.payment_status = 'paid' AND o.paid_at >= ?")
    .get(since).c;
  const shipping30 = db.prepare("SELECT COALESCE(SUM(shipping_cents),0) s FROM orders WHERE payment_status = 'paid' AND paid_at >= ?").get(since).s;
  return {
    ordersToProcess: db.prepare("SELECT COUNT(*) n FROM orders WHERE status IN ('paid','ordered')").get().n,
    awaitingPayment: db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'pending_payment' AND created_at >= ?").get(since).n,
    paidOrders30: paid30.n,
    revenue30Cents: paid30.total,
    supplierCost30Cents: cost30,
    shipping30Cents: shipping30,
    activeProducts: db.prepare('SELECT COUNT(*) n FROM products WHERE active = 1').get().n,
    inactiveProducts: db.prepare('SELECT COUNT(*) n FROM products WHERE active = 0').get().n,
    outOfStock: db.prepare("SELECT COUNT(*) n FROM products WHERE active = 1 AND ((fulfilment='stock' AND stock_qty <= 0) OR (fulfilment='dropship' AND supplier_in_stock = 0))").get().n,
    uncategorised: db.prepare('SELECT COUNT(*) n FROM products WHERE category_id IS NULL').get().n,
    feedItems: db.prepare('SELECT COUNT(*) n FROM feed_items').get().n,
    unreadMessages: db.prepare('SELECT COUNT(*) n FROM contact_messages WHERE handled = 0').get().n,
    recentOrders: listOrders({ pageSize: 8 }, db).items,
  };
}
