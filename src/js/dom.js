// The single place the storefront writes markup into the page.
// CONTRACT: every dynamic value inside `markup` must already be passed
// through esc() (src/js/api.js). Templates here are built from escaped
// catalog/settings data only -- never raw user input.
export function setHtml(el, markup) {
  if (el) el.innerHTML = markup;
}
