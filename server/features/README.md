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

## Phase 2 hooks

- `src/js/analytics-beacon.js` `track(event, data)` -- called by the core storefront: `add_to_cart` (cart.js), `checkout_start` (checkout.js). site.js imports the module on every page, so it can also send page views itself.
- Paid orders, revenue, cost and discounts come from the `orders` / `order_items` tables (read them; don't add hooks to orders.js).
- Admin pages may override an existing core route (e.g. `routes['dashboard']`): page modules load after admin.js defines its routes.
- Customer newsletter opt-in lives on `clients.newsletter_opt_in` (accounts feature).

## Phase 3 hooks

- `governance.js` `auditAdminRequest(req, res, next)` runs before every `/api/admin` route (after login check; `req.admin.username` is set). Record mutations (non-GET) with the outcome (hook `res.on('finish')`); never log passwords, tokens or file contents. `recordAudit({ action, actor, req, details })` is called for admin login / failed login / logout / setup.
- Pages `backups-page.js` and `settings-page.js` override the core `routes.backups` / `routes.settings`; `nav.js` may restructure the admin sidebar at load (collapsible groups).
