// Newsletter signup forms (footer on every page, and newsletter.html).
// Loaded by a script tag in partials/shell-bottom.html. Double opt-in: the
// server emails a confirmation link; nobody is subscribed until they click it.
import { api } from './api.js';

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-newsletter-form]');
  if (!form) return;
  e.preventDefault();
  const out = form.querySelector('[data-newsletter-result]');
  const btn = form.querySelector('button[type="submit"]');
  const email = form.elements.email.value.trim();
  const say = (msg, bad = false) => {
    if (!out) return;
    out.textContent = msg;
    out.classList.toggle('text-terracotta', bad);
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    say('Please enter a valid email address.', true);
    form.elements.email.focus();
    return;
  }
  btn.disabled = true;
  try {
    const r = await api('/api/newsletter/subscribe', {
      method: 'POST',
      body: { email, source: form.dataset.source || 'footer', website: form.elements.website?.value || '' },
    });
    say(r.message || 'Thanks! Please check your inbox to confirm.');
    form.elements.email.value = '';
  } catch (err) {
    say(err.message, true);
  } finally {
    btn.disabled = false;
  }
});
