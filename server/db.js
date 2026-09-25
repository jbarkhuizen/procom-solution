import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { dataDir } from './paths.js';

let db = null;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(dataDir(), { recursive: true });
  db = openDb(process.env.DB_FILE || path.join(dataDir(), 'procom.db'));
  return db;
}

export function openDb(file) {
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  ensureSchema(conn);
  seedDefaults(conn);
  return conn;
}

// Money columns are integer cents (*_cents). Weights are grams.
export function ensureSchema(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Persisted (not in-memory) so a service restart doesn't log admins out.
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      markup_pct REAL,               -- NULL = inherit from parent / site default
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      lead_time_text TEXT NOT NULL DEFAULT 'Ships from our warehouse in 2-5 business days',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      brand TEXT NOT NULL DEFAULT '',
      category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      short_description TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      specs TEXT NOT NULL DEFAULT '[]',          -- JSON [{label, value}]
      images TEXT NOT NULL DEFAULT '[]',         -- JSON ["/uploads/products/x.webp", ...]
      fulfilment TEXT NOT NULL DEFAULT 'dropship' CHECK (fulfilment IN ('dropship','stock')),
      supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
      supplier_code TEXT NOT NULL DEFAULT '',
      cost_cents INTEGER NOT NULL DEFAULT 0,     -- supplier cost EXCL VAT
      markup_pct REAL,                           -- NULL = inherit category/site
      price_mode TEXT NOT NULL DEFAULT 'auto' CHECK (price_mode IN ('auto','manual')),
      price_cents INTEGER NOT NULL DEFAULT 0,    -- selling price (what the customer pays)
      compare_at_cents INTEGER,                  -- optional "was" price
      weight_g INTEGER NOT NULL DEFAULT 1000,
      stock_qty INTEGER NOT NULL DEFAULT 0,      -- only meaningful for fulfilment='stock'
      supplier_in_stock INTEGER NOT NULL DEFAULT 1, -- dropship availability toggle
      min_order_qty INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      featured INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_products_category ON products (category_id);
    CREATE INDEX IF NOT EXISTS idx_products_supplier ON products (supplier_id, supplier_code);

    -- Raw rows from a supplier pricelist upload. Listing an item copies it into products.
    CREATE TABLE IF NOT EXISTS feed_items (
      id TEXT PRIMARY KEY,
      supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      brand TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      cost_cents INTEGER NOT NULL DEFAULT 0,
      previous_cost_cents INTEGER,
      min_order_qty INTEGER NOT NULL DEFAULT 1,
      image TEXT NOT NULL DEFAULT '',
      source_file TEXT NOT NULL DEFAULT '',
      source_sheet TEXT NOT NULL DEFAULT '',
      in_latest_import INTEGER NOT NULL DEFAULT 1,
      imported_at TEXT NOT NULL,
      UNIQUE (supplier_id, code)
    );

    CREATE TABLE IF NOT EXISTS feed_imports (
      id TEXT PRIMARY KEY,
      supplier_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      rows_total INTEGER NOT NULL,
      rows_new INTEGER NOT NULL,
      rows_updated INTEGER NOT NULL,
      price_changes INTEGER NOT NULL,
      products_repriced INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shipping_options (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      option_type TEXT NOT NULL DEFAULT 'fixed' CHECK (option_type IN ('fixed','auto_weight')),
      category TEXT NOT NULL DEFAULT '',
      min_weight INTEGER NOT NULL DEFAULT 0,
      max_weight INTEGER,
      price_cents INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_number TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending_payment',
      payment_status TEXT NOT NULL DEFAULT 'pending',
      payment_method TEXT NOT NULL,
      pf_payment_id TEXT NOT NULL DEFAULT '',
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      address_line1 TEXT NOT NULL DEFAULT '',
      address_line2 TEXT NOT NULL DEFAULT '',
      suburb TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      province TEXT NOT NULL DEFAULT '',
      postal_code TEXT NOT NULL DEFAULT '',
      pudo_locker TEXT NOT NULL DEFAULT '',
      customer_notes TEXT NOT NULL DEFAULT '',
      shipping_option_id TEXT,
      shipping_name TEXT NOT NULL DEFAULT '',
      shipping_cents INTEGER NOT NULL DEFAULT 0,
      subtotal_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0,
      total_weight_g INTEGER NOT NULL DEFAULT 0,
      supplier_ref TEXT NOT NULL DEFAULT '',
      tracking_number TEXT NOT NULL DEFAULT '',
      admin_notes TEXT NOT NULL DEFAULT '',
      paid_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);

    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      fulfilment TEXT NOT NULL,
      supplier_id TEXT,
      supplier_code TEXT NOT NULL DEFAULT '',
      unit_cost_cents INTEGER NOT NULL DEFAULT 0,
      unit_price_cents INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      line_total_cents INTEGER NOT NULL,
      weight_g INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_messages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      handled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
}

export const DEFAULT_SETTINGS = {
  siteName: 'Procom Solutions',
  tagline: 'Computer equipment, tech & more — delivered across South Africa',
  contactEmail: 'lapanzaonline@gmail.com',
  contactPhone: '082 663 9608',
  whatsappNumber: '27826639608',
  hours: 'Mon–Fri 08:00–17:00 · Sat 09:00–13:00',
  announcement: 'Nationwide delivery via PUDO & courier · Secure Payfast checkout',
  vatRegistered: false,
  vatNumber: '',
  vatRatePct: 15,
  defaultMarkupPct: 10,
  defaultWeightG: 1000,
  ownerNotifyEmail: 'lapanzaonline@gmail.com',
  legalEntity: 'Lapanza (trading as Procom Solutions)',
};

// Mirrors lapanza3d.co.za's live shipping table (2026-09-25), minus the
// 3D-filament-specific PUDO rows.
const DEFAULT_SHIPPING = [
  ['PUDO Small (0-1.5kg)', 'auto_weight', 'Courier', 0, 1500, 80],
  ['PUDO Medium (1.5kg - 5kg)', 'auto_weight', 'Courier', 1501, 5000, 100],
  ['PUDO Locker to Locker (Extra-Small) - up to 2kg', 'fixed', 'PUDO Locker', 0, null, 49],
  ['PUDO Locker to Locker (Small) - up to 5kg', 'fixed', 'PUDO Locker', 0, null, 59],
  ['PUDO Locker to Locker (Medium) - up to 10kg', 'fixed', 'PUDO Locker', 0, null, 69],
  ['PUDO Locker to Locker (Large) - up to 15kg', 'fixed', 'PUDO Locker', 0, null, 90],
  ['PUDO Locker to Locker (Extra Large) - up to 20kg', 'fixed', 'PUDO Locker', 0, null, 119],
  ['PUDO Locker to Door (Extra-Small) - up to 2kg', 'fixed', 'PUDO Locker', 0, null, 73],
  ['PUDO Locker to Door (Small) - up to 5kg', 'fixed', 'PUDO Locker', 0, null, 84],
  ['PUDO Locker to Door (Medium) - up to 10kg', 'fixed', 'PUDO Locker', 0, null, 115],
  ['PUDO Locker to Door (Large) - up to 15kg', 'fixed', 'PUDO Locker', 0, null, 165],
  ['PUDO Locker to Door (Extra Large) - up to 20kg', 'fixed', 'PUDO Locker', 0, null, 221],
  ['Local delivery - Pierre van Ryneveld', 'fixed', 'Local Delivery', 0, null, 50],
  ['Local delivery - 10km radius', 'fixed', 'Local Delivery', 0, null, 100],
  ['Local delivery - 25km radius', 'fixed', 'Local Delivery', 0, null, 150],
];

// Starter category tree -- a skeleton the admin will grow. Deliberately
// broad so SMD's 30-odd pricelist categories can map onto it.
const DEFAULT_CATEGORIES = [
  ['Computers & Peripherals', 'computers-peripherals', [
    ['Keyboards & Mice', 'keyboards-mice'],
    ['Headsets & Audio', 'headsets-audio'],
    ['Webcams & Streaming', 'webcams-streaming'],
    ['Computer Accessories', 'computer-accessories'],
  ]],
  ['Networking', 'networking', [
    ['Routers & Mesh', 'routers-mesh'],
    ['Switches', 'switches'],
    ['Security Cameras', 'security-cameras'],
  ]],
  ['Gaming', 'gaming', []],
  ['Mobile & Wearables', 'mobile-wearables', [
    ['Chargers & Cables', 'chargers-cables'],
    ['Power Banks', 'power-banks'],
    ['Smartwatches', 'smartwatches'],
  ]],
  ['Bags & Laptop Cases', 'bags', []],
  ['Smart Home & Lighting', 'smart-home-lighting', []],
  ['Power & Electrical', 'power-electrical', []],
  ['Home & Kitchen', 'home-kitchen', []],
  ['Baby & Toddler', 'baby-toddler', []],
];

function seedDefaults(conn) {
  const now = new Date().toISOString();
  const insSetting = conn.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, JSON.stringify(v));

  if (conn.prepare('SELECT COUNT(*) n FROM shipping_options').get().n === 0) {
    const ins = conn.prepare(`INSERT INTO shipping_options (id, name, option_type, category, min_weight, max_weight, price_cents, active, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`);
    DEFAULT_SHIPPING.forEach(([name, type, cat, min, max, rand], i) => ins.run(randomUUID(), name, type, cat, min, max, rand * 100, i, now, now));
  }

  if (conn.prepare('SELECT COUNT(*) n FROM categories').get().n === 0) {
    const ins = conn.prepare('INSERT INTO categories (id, parent_id, name, slug, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    DEFAULT_CATEGORIES.forEach(([name, slug, children], i) => {
      const id = randomUUID();
      ins.run(id, null, name, slug, i, now, now);
      children.forEach(([cName, cSlug], j) => ins.run(randomUUID(), id, cName, cSlug, j, now, now));
    });
  }

  if (conn.prepare('SELECT COUNT(*) n FROM suppliers').get().n === 0) {
    conn.prepare('INSERT INTO suppliers (id, name, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), 'SMD (Warehouse)', 'Wholesale pricelists: Cash wholesale, Home and Beyond, Infant Essential. Dropship direct to customer.', now, now);
  }
}

// Test helper -- fresh in-memory DB, installed as the module singleton.
export function useMemoryDb() {
  db = openDb(':memory:');
  return db;
}
