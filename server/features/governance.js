// Governance (Phase 3): audit log, todo/backlog, settings tidy-up.
export function register() {}
// Called by the core for every admin API request (after auth), and for admin
// login/logout/setup. Must never throw or block.
export function auditAdminRequest(_req, _res, next) {
  next();
}
export function recordAudit() {}
