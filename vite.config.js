import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const pages = ['index', 'shop', 'product', 'checkout', 'checkout-complete', 'contact', 'terms', 'privacy', 'returns', '404'];

// Expands <!-- @include name --> with partials/name.html so the header,
// sidebar and footer live in one place but pages remain static HTML (no
// layout flash while JS boots).
function htmlIncludes() {
  return {
    name: 'procom-html-includes',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(/<!--\s*@include\s+([\w-]+)\s*-->/g, (_m, name) => fs.readFileSync(path.join(root, 'partials', `${name}.html`), 'utf8'));
      },
    },
  };
}

export default defineConfig({
  plugins: [htmlIncludes(), tailwindcss()],
  server: {
    port: 5174, // lapanza3d dev uses 5173
    proxy: {
      '/api': 'http://127.0.0.1:8788',
      '/uploads': 'http://127.0.0.1:8788',
      '/admin': 'http://127.0.0.1:8788',
      '/sitemap.xml': 'http://127.0.0.1:8788',
    },
  },
  build: {
    rollupOptions: {
      input: Object.fromEntries(pages.map((p) => [p, path.join(root, `${p}.html`)])),
    },
  },
});
