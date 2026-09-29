import crypto from 'crypto';

// Encrypts small secrets kept in the database (supplier portal passwords).
// AES-256-GCM with a key that lives only in the server .env (VAULT_KEY), so
// a copied database or an off-site backup (Google Drive) never exposes them.
// Losing VAULT_KEY makes stored passwords unreadable -- they must be re-entered.

const PREFIX = 'v1';

export const vaultReady = () => Boolean(process.env.VAULT_KEY && process.env.VAULT_KEY.length >= 16);

function key() {
  if (!vaultReady()) throw new Error('Passwords cannot be stored yet: VAULT_KEY is not set in the server .env (at least 16 characters)');
  return crypto.createHash('sha256').update(process.env.VAULT_KEY).digest();
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
    throw new Error('Stored password cannot be read with the current VAULT_KEY -- enter it again');
  }
}
