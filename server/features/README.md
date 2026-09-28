# Feature modules

Each feature owns its files and plugs into the core through fixed hooks, so
features can be built side by side without editing the same lines:

| File | Contract |
|---|---|
| `<f>.schema.js` | `export const SQL` (CREATE TABLE IF NOT EXISTS ...) and `export const COLUMNS` (`[table, column, definition]`, additive). Imports nothing. Loaded by `db.js`. |
| `<f>.js` | `export function register({ app, admin, wrap, rateLimit, express })` adds routes: public ones on `app` under `/api/...`, admin ones on the `admin` router (mounted at `/api/admin`, already login + same-origin protected). Plus the hook functions listed below. |
| `admin/pages/<f>.js` | `export default function (routes, kit)` adds admin views (`routes['clients'] = async () => ...`). `kit` holds the admin helpers (api, view, setTop, h, rand, ...). Nav buttons live in `admin/index.html`. |

Hooks called by the core (keep the signatures):

- `specials.js` `specialPriceCents(productRow, db)` -> cents or null. Called for every product the storefront shows and in `createOrder`; must be cheap (cache).
- `promos.js` `priceAdjustments({ items, subtotalCents, promoCode, email }, db)` -> `{ discountCents, promoCode }`. `items` = `[{ p, quantity, unitCents }]`. Throw an Error with a customer-friendly message for an invalid code.
- `accounts.js` `onOrderCreated(order, db)` -- e.g. link the order to a registered client.
- `invoices.js` `onOrderPaid(order, db)` -- called once, after the Payfast payment is confirmed.
