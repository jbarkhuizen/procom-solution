import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { uploadsDir } from './paths.js';

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

export function isAllowedImage(mimetype) {
  return ALLOWED.has(mimetype);
}

// Normalises any uploaded/extracted image to a max-1200px WebP. Re-encoding
// (rather than storing the original bytes) also strips EXIF/GPS metadata and
// neutralises polyglot files -- what we serve is always a clean image.
export async function storeProductImage(buffer, subdir = 'products') {
  const dir = path.join(uploadsDir(), subdir);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${randomUUID()}.webp`;
  await sharp(buffer, { failOn: 'error' })
    .rotate()
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .webp({ quality: 82 })
    .toFile(path.join(dir, name));
  return `/uploads/${subdir}/${name}`;
}

// Copies an existing upload (e.g. a feed thumbnail) so products own their images
// independently of the feed table.
export function copyUpload(publicPath, subdir = 'products') {
  const src = resolveUpload(publicPath);
  if (!src || !fs.existsSync(src)) return null;
  const dir = path.join(uploadsDir(), subdir);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${randomUUID()}${path.extname(src)}`;
  fs.copyFileSync(src, path.join(dir, name));
  return `/uploads/${subdir}/${name}`;
}

// Maps '/uploads/x/y.webp' to a disk path, refusing anything that escapes the uploads dir.
export function resolveUpload(publicPath) {
  if (typeof publicPath !== 'string' || !publicPath.startsWith('/uploads/')) return null;
  const root = path.resolve(uploadsDir());
  const full = path.resolve(root, publicPath.slice('/uploads/'.length));
  return full.startsWith(root + path.sep) ? full : null;
}

export function deleteUpload(publicPath) {
  const full = resolveUpload(publicPath);
  if (full && fs.existsSync(full)) fs.unlinkSync(full);
}
