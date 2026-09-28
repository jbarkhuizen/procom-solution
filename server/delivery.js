import { getDb } from './db.js';
import { getSettings } from './settings.js';
import { listShippingOptions, resolveShippingForCheckout } from './shipping.js';
import { quoteDeliveryCategoryIds, needsDeliveryQuote } from './catalog.js';

// Delivery is arranged per supplier: each supplier's items form one shipment
// with its own choices (a cart mixing suppliers gets one choice per shipment,
// and the fees add up). A supplier is either
//   'flat'  -- one courier fee per order, free once the supplier's cost of the
//              items (incl VAT, i.e. their invoice) reaches a threshold; no
//              delivery quotes (e.g. SMD: R150, free from R5,000), or
//   'store' -- the store-wide shipping options (weight brackets) and delivery
//              quotes for large items. Products without a supplier use this.
// Either kind may also offer free collection from the supplier's address.
// The supplier's real name is never shown to customers -- only public_label.

export const QUOTE_NAME = 'Delivery quoted after order';

export function supplierDelivery(row) {
  return {
    mode: row?.delivery_mode === 'flat' ? 'flat' : 'store',
    feeCents: row?.delivery_fee_cents || 0,
    freeOverCostCents: row?.free_over_cost_cents ?? null,
    label: row?.public_label || '',
    collection: row?.collection_enabled
      ? {
          address: row.collection_address,
          hours: row.collection_hours,
          requirements: row.collection_requirements,
          leadText: row.collection_lead_text || 'typically 2–3 business days after payment',
        }
      : null,
  };
}

// items: [{ p: productRow, quantity }]. Returns one group per shipment with the
// options the customer may pick. Option ids: 'courier' | 'collect' | 'quote' |
// a store-wide shipping option id.
export function planDelivery(items, db = getDb()) {
  const vat = 1 + (Number(getSettings(db).vatRatePct) || 0) / 100;
  const quoteSet = quoteDeliveryCategoryIds(db);
  const suppliers = new Map(db.prepare('SELECT * FROM suppliers').all().map((s) => [s.id, s]));
  const storeOptions = listShippingOptions({ activeOnly: true }, db).filter((o) => o.category !== 'Collection');
  const byKey = new Map();
  for (const it of items) {
    const sup = suppliers.get(it.p.supplier_id);
    const conf = supplierDelivery(sup);
    const key = conf.mode === 'flat' || conf.collection ? it.p.supplier_id : 'store';
    if (!byKey.has(key)) byKey.set(key, { key, supplierId: key === 'store' ? null : it.p.supplier_id, conf: key === 'store' ? supplierDelivery(null) : conf, items: [] });
    byKey.get(key).items.push(it);
  }
  const groups = [...byKey.values()];
  groups.forEach((g, i) => {
    // Named warehouses read "Items from our Edenvale warehouse"; the rest are generic.
    g.named = Boolean(g.conf.label);
    g.label = g.conf.label || (groups.length === 1 ? 'Your order' : g.key === 'store' ? 'Other items' : `Shipment ${i + 1}`);
    g.weightG = g.items.reduce((s, it) => s + it.p.weight_g * it.quantity, 0);
    const costInclVat = Math.round(g.items.reduce((s, it) => s + it.p.cost_cents * it.quantity, 0) * vat);
    const opts = [];
    if (g.conf.collection) opts.push({ id: 'collect', method: 'collect', name: `Collect from our ${g.conf.label || 'warehouse'} (free)`, priceCents: 0, collection: g.conf.collection });
    if (g.conf.mode === 'flat') {
      const free = g.conf.freeOverCostCents != null && costInclVat >= g.conf.freeOverCostCents;
      opts.push({ id: 'courier', method: 'courier', name: free ? 'Courier delivery — free for this order' : 'Courier delivery to your door', priceCents: free ? 0 : g.conf.feeCents });
    } else if (g.items.some((it) => needsDeliveryQuote(it.p, quoteSet))) {
      g.largeItems = g.items.filter((it) => needsDeliveryQuote(it.p, quoteSet)).map((it) => it.p.name);
      opts.push({ id: 'quote', method: 'quote', name: QUOTE_NAME, priceCents: 0 });
    } else {
      for (const o of storeOptions) {
        if (o.optionType === 'auto_weight' && (g.weightG < o.minWeight || (o.maxWeight != null && g.weightG > o.maxWeight))) continue;
        opts.push({ id: o.id, method: 'store', name: o.name, priceCents: o.priceCents, category: o.category, optionType: o.optionType });
      }
    }
    g.options = opts;
  });
  return groups;
}

// What the storefront may see of a plan: no supplier ids' names, no costs.
export function publicPlan(groups) {
  return groups.map((g) => ({
    key: g.key,
    label: g.label,
    heading: g.named ? `Items from our ${g.label}` : g.label,
    items: g.items.map((it) => ({ productId: it.p.id, name: it.p.name, quantity: it.quantity })),
    largeItems: g.largeItems || [],
    weightG: g.weightG,
    options: g.options.map(({ id, method, name, priceCents, category, collection }) => ({ id, method, name, priceCents, category, collection })),
  }));
}

// choices: { [groupKey]: optionId }. `legacyOptionId` (old single-choice
// checkout) applies to the store-wide group only. Returns the chosen shipments.
export function resolveDelivery(groups, choices = {}, legacyOptionId = null, db = getDb()) {
  return groups.map((g) => {
    let id = choices?.[g.key];
    if (!id && g.options.length === 1 && g.options[0].method === 'quote') id = 'quote';
    if (!id && g.key === 'store' && legacyOptionId) id = legacyOptionId;
    const opt = g.options.find((o) => o.id === id);
    // A store-wide option that exists but doesn't fit this shipment: say why.
    if (!opt && id && g.conf.mode === 'store' && !['collect', 'courier', 'quote'].includes(id)) resolveShippingForCheckout(id, g.weightG, db);
    if (!opt) throw new Error(`Please choose how you'd like to receive ${g.named ? `the items from our ${g.label}` : g.label === 'Your order' ? 'your order' : `these items: ${g.label}`}`);
    if (opt.method === 'store') resolveShippingForCheckout(opt.id, g.weightG, db); // re-checks the weight bracket
    return {
      key: g.key,
      supplierId: g.supplierId,
      label: g.label,
      method: opt.method,
      name: opt.name,
      optionId: opt.method === 'store' ? opt.id : null,
      category: opt.category || '',
      feeCents: opt.priceCents,
      productIds: g.items.map((it) => it.p.id),
      collection: opt.method === 'collect' ? opt.collection : null,
      readyAt: '',
    };
  });
}
