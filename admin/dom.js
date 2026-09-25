// Single HTML sink for the admin SPA. CONTRACT: callers pass markup whose
// dynamic values have already been escaped with h() from admin.js.
export function setHtml(el, markup) {
  if (el) el.innerHTML = markup;
}
