import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Encrypts small secrets kept in the database (supplier portal passwords).
// AES-256-GCM. The key is VAULT_KEY from .env if set, otherwise a random key
// the server creates once in `.vault-key` next to the app (git-ignored, never
// in data/ -- so neither a copied database nor the off-site Google Drive
// backup ever holds the key next to the passwords). Losing the key makes
// stored passwords unreadable: they must be entered again in admin.

const PREFIX = 'v1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keyFile = () => process.env.VAULT_KEY_FILE || path.join(ROOT, '.vault-key');

let cached = null; // { source, key }

function key() {
  const source = process.env.VAULT_KEY || keyFile();
  if (cached?.source === source) return cached.key;
  let material = process.env.VAULT_KEY;
  if (!material) {
    const file = keyFile();
    if (!fs.existsSync(file)) {
      // 'wx': never overwrite a key that appeared meanwhile; 0600: owner only.
      try {
        fs.writeFileSync(file, `${crypto.randomBytes(32).toString('base64')}\n`, { flag: 'wx', mode: 0o600 });
      } catch (err) {
        if (err.code !== 'EEXIST') throw new Error(`Could not create the password key file (${err.message})`);
      }
    }
    material = fs.readFileSync(file, 'utf8').trim();
  }
  if (material.length < 16) throw new Error('The password key is too short (VAULT_KEY / .vault-key)');
  cached = { source, key: crypto.createHash('sha256').update(material).digest() };
  return cached.key;
}

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecret(stored) {
  if (!stored) return '';
  const [v, iv, tag, data] = String(stored).split(':');
  if (v !== PREFIX || !iv || !tag || data == null) throw new Error('Stored password is damaged');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new Error('Stored password cannot be read with the current key -- enter it again in Admin -> Suppliers');
  }
}
