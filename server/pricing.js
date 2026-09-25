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

export function computeRetailCents(costCents, markupPct, vatRatePct = 15) {
  const cost = Number(costCents) || 0;
  const raw = cost * (1 + (Number(vatRatePct) || 0) / 100) * (1 + (Number(markupPct) || 0) / 100);
  return roundRetail(Math.round(raw));
}

// Gross profit per unit. Not VAT-registered: supplier VAT is a cost we absorb.
// VAT-registered: we claim input VAT back but owe output VAT on the sale.
export function marginCents(priceCents, costCents, { vatRatePct = 15, vatRegistered = false } = {}) {
  const price = Number(priceCents) || 0;
  const cost = Number(costCents) || 0;
  if (vatRegistered) return Math.round(price / (1 + vatRatePct / 100)) - cost;
  return price - Math.round(cost * (1 + vatRatePct / 100));
}
