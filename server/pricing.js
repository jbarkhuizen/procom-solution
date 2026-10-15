// Retail pricing for supplier-costed products.
//
// Supplier pricelists quote cost EXCL VAT. Lapanza is not VAT-registered, so
// the 15% VAT paid to the supplier is a real cost and must be recovered:
//
//   retail = cost_excl × (1 + vat) × (1 + markup)
//
// If the business later registers for VAT the formula is numerically the same
// (VAT is then charged to the customer instead of absorbed) -- only invoice
// wording changes, which is why `vatRegistered` is a display setting, not a
// pricing input.

export function effectiveMarkupPct({ productMarkup, categoryChain = [], defaultMarkup }) {
  if (productMarkup != null && productMarkup !== '') return Number(productMarkup);
  for (const cat of categoryChain) {
    if (cat && cat.markup_pct != null) return Number(cat.markup_pct);
  }
  return Number(defaultMarkup) || 0;
}

// Rounds a raw computed price (cents) to a customer-facing retail price.
// Default: round UP to the next whole rand, so we never undercut the markup
// by a few cents. Business owners often prefer charm pricing (R199, R249)
// -- that is a margin/perception trade-off; change it here and every auto-
// priced product follows on the next save or pricelist import.
export function roundRetail(rawCents) {
  if (rawCents <= 0) return 0;
  return Math.ceil(rawCents / 100) * 100;
}

// minProfitCents (owner rule 2026-09-30, Site settings "Minimum profit per item"):
// the price is at least cost incl VAT + that amount, so cheap items still cover
// Payfast's fixed fee (a R25 plug at 10% markup made R2.27 and lost money on a card sale).
//
// fee (owner 2026-10-15, Site settings "Add the Payfast fee to every price"): { pct, fixedCents, vatFactor } of the dearest
// enabled Payfast method. The price is grossed up so that AFTER Payfast takes its fee on the full price, the markup
// (and the minimum profit) is still what the owner keeps:
//   price = (cost x (1 + VAT) x (1 + markup) + fixed x feeVat) / (1 - pct x feeVat)
// null = no fee (the older behaviour; tests and the setting switched off).
export function computeRetailCents(costCents, markupPct, vatRatePct = 15, minProfitCents = 0, fee = null) {
  const cost = Number(costCents) || 0;
  const withVat = cost * (1 + (Number(vatRatePct) || 0) / 100);
  const raw = withVat * (1 + (Number(markupPct) || 0) / 100);
  const min = cost > 0 ? withVat + Math.max(0, Number(minProfitCents) || 0) : 0;
  let target = Math.max(raw, min);
  if (fee && cost > 0) {
    const vf = Number(fee.vatFactor) || 1;
    target = (target + (Number(fee.fixedCents) || 0) * vf) / (1 - ((Number(fee.pct) || 0) / 100) * vf);
  }
  return roundRetail(Math.round(target));
}

// Gross profit per unit. Not VAT-registered: supplier VAT is a cost we absorb.
// VAT-registered: we claim input VAT back but owe output VAT on the sale.
export function marginCents(priceCents, costCents, { vatRatePct = 15, vatRegistered = false } = {}) {
  const price = Number(priceCents) || 0;
  const cost = Number(costCents) || 0;
  if (vatRegistered) return Math.round(price / (1 + vatRatePct / 100)) - cost;
  return price - Math.round(cost * (1 + vatRatePct / 100));
}
