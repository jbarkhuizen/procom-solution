import './site.js';
import { api } from './api.js';

const form = document.getElementById('contact-form');
const result = document.getElementById('c-result');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  result.classList.add('hidden');
  try {
    await api('/api/contact', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
    form.reset();
    result.textContent = 'Thanks — we have your message and will be in touch shortly.';
    result.className = 'text-sm font-medium';
  } catch (err) {
    result.textContent = err.message;
    result.className = 'text-sm font-medium text-terracotta';
  } finally {
    btn.disabled = false;
  }
});
