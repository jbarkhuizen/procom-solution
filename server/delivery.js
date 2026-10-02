import { getDb } from './db.js';
import { getSettings } from './settings.js';
import { listShippingOptions, resolveShippingForCheckout } from './shipping.js';
import { quoteDeliveryCategoryIds, needsDeliveryQuote, courierInsuranceByCategory } from './catalog.js';

// Delivery is arranged per supplier: each supplier's items form one shipment
// with its own choices (a cart mixing suppliers gets one choice per shipment,
// and the fees add up). A supplier is either
//   'flat'  -- one courier fee per order, free once the supplier's cost of the
//              items (incl VAT, i.e. their invoice) reaches a threshold; no
//              delivery quotes (e.g. SMD: R150, free from R5,000), or
//   'store' -- the store-wide shipping options (weight brackets) and delivery
//              quotes for large items. Products without a supplier use this.
// Either kind may also offer free collection from the supplier's address, and
// the customer's own courier collecting there ('own_courier': free; the
// customer sends us the waybill and collection date).
// Courier insurance: items in a category with courier_insurance_pct (e.g.
// Esquire TVs, 3%) add that % of the item price as a separate line whenever
// the shipment goes by our courier (courier / store / quote) -- not when
// collected or sent with the customer's own courier.
// The supplier's real name is never shown to customers -- only public_label.

export const QUOTE_NAME = 'Delivery quoted after order';

export function supplierDelivery(row) {
  return {
    mode: row?.delivery_mode === 'flat' ? 'flat' : 'store',
    feeCents: row?.delivery_fee_cents || 0,
    costCents: row?.delivery_cost_cents ?? null, // null = same as the fee
    freeOverCostCents: row?.free_over_cost_cents ?? null,
    label: row?.public_label || '',
    ownCourier: Boolean(row?.own_courier_enabled && row?.collection_address),
    pickupAddress: row?.collection_address || '',
    pickupHours: row?.collection_hours || '',
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
// options the customer may pick. Option ids: 'courier' | 'collect' | 'own_courier' | 'quote' |
// a store-wide shipping option id.
export function planDelivery(items, db = getDb()) {
  const vat = 1 + (Number(getSettings(db).vatRatePct) || 0) / 100;
  const quoteSet = quoteDeliveryCategoryIds(db);
  const insuranceByCat = courierInsuranceByCategory(db);
  const suppliers = new Map(db.prepare('SELECT * FROM suppliers').all().map((s) => [s.id, s]));
  const storeOptions = listShippingOptions({ activeOnly: true }, db).filter((o) => o.category !== 'Collection');
  const byKey = new Map();
  for (const it of items) {
    const sup = suppliers.get(it.p.supplier_id);
    const conf = supplierDelivery(sup);
    const key = conf.mode === 'flat' || conf.collection || conf.ownCourier ? it.p.supplier_id : 'store';
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
    const insured = g.items.filter((it) => insuranceByCat.has(it.p.category_id));
    const insuranceCents = Math.ceil(insured.reduce((s, it) => s + ((it.unitCents ?? it.p.price_cents) * it.quantity * insuranceByCat.get(it.p.category_id)) / 100, 0));
    const insurancePct = insured.length ? Math.max(...insured.map((it) => insuranceByCat.get(it.p.category_id))) : 0;
    const opts = [];
    if (g.conf.collection) opts.push({ id: 'collect', method: 'collect', name: `Collect from our ${g.conf.label || 'warehouse'} (free)`, priceCents: 0, collection: g.conf.collection });
    if (g.conf.ownCourier) {
      opts.push({
        id: 'own_courier',
        method: 'own_courier',
        name: 'I’ll send my own courier (free) — email us the waybill and collection date',
        priceCents: 0,
        collection: { address: g.conf.pickupAddress, hours: g.conf.pickupHours, requirements: '', leadText: g.conf.collection?.leadText || 'typically 2–3 business days after payment' },
      });
    }
    if (g.conf.mode === 'flat') {
      const free = g.conf.freeOverCostCents != null && costInclVat >= g.conf.freeOverCostCents;
      opts.push({ id: 'courier', method: 'courier', name: free ? 'Courier delivery — free for this order' : 'Courier delivery to your door', priceCents: free ? 0 : g.conf.feeCents, costCents: free ? 0 : g.conf.costCents ?? g.conf.feeCents });
    } else if (g.items.some((it) => needsDeliveryQuote(it.p, quoteSet))) {
      g.largeItems = g.items.filter((it) => needsDeliveryQuote(it.p, quoteSet)).map((it) => it.p.name);
      opts.push({ id: 'quote', method: 'quote', name: QUOTE_NAME, priceCents: 0 });
    } else {
      for (const o of storeOptions) {
        if (o.optionType === 'auto_weight' && (g.weightG < o.minWeight || (o.maxWeight != null && g.weightG > o.maxWeight))) continue;
        opts.push({ id: o.id, method: 'store', name: o.name, priceCents: o.priceCents, costCents: o.costCents ?? o.priceCents, category: o.category, optionType: o.optionType });
      }
    }
    // Our courier carries the goods: add the insurance line (never for collect / own courier).
    for (const o of opts) {
      o.insuranceCents = insuranceCents && ['courier', 'store', 'quote'].includes(o.method) ? insuranceCents : 0;
      if (o.insuranceCents) o.insuranceName = `Courier insurance (${insurancePct}% of ${insured.map((it) => it.p.name).join(', ')})`.slice(0, 200);
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
    options: g.options.map(({ id, method, name, priceCents, category, collection, insuranceCents, insuranceName }) => ({ id, method, name, priceCents, category, collection, insuranceCents, insuranceName })),
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
    if (!opt && id && g.conf.mode === 'store' && !['collect', 'own_courier', 'courier', 'quote'].includes(id)) resolveShippingForCheckout(id, g.weightG, db);
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
      costCents: opt.costCents ?? opt.priceCents, // what the courier costs us
      insuranceCents: opt.insuranceCents || 0,
      insuranceName: opt.insuranceName || '',
      productIds: g.items.map((it) => it.p.id),
      // own_courier: the pickup address for the customer's courier.
      collection: opt.method === 'collect' || opt.method === 'own_courier' ? opt.collection : null,
      readyAt: '',
    };
  });
}
