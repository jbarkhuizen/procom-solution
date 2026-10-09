import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import http from 'http';
import sharp from 'sharp';

process.env.UPLOADS_DIR = path.join(os.tmpdir(), 'procom-test-uploads');
process.env.DISABLE_BACKUPS = '1';

const { isPrivateAddress, fetchImage } = await import('./remote-images.js');
const { storeProductImage } = await import('./images.js');

test('SSRF guard: every spelling of an internal address is refused, public ones pass', () => {
  const internal = [
    '127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'fec0::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a00:1', '0:0:0:0:0:ffff:7f00:1', '::127.0.0.1',
    '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::', '2002:c0a8:1::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1',
    'not-an-ip',
  ];
  for (const ip of internal) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['41.222.36.147', '8.8.8.8', '1.1.1.1', '2606:4700::1111', '2a00:1450:4001:81b::200e', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('image download refuses a server on this machine, even when asked by IP', async () => {
  const server = http.createServer((_req, res) => res.end('secret'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(fetchImage(`http://127.0.0.1:${server.address().port}/x.png`), /private\/internal/);
    await assert.rejects(fetchImage(`http://[::ffff:7f00:1]:${server.address().port}/x.png`), /private\/internal/);
    await assert.rejects(fetchImage('ftp://example.com/x.png'), /only http/);
  } finally {
    server.close();
  }
});

test('uploaded and downloaded images must be real photo formats: SVG and non-images are refused', async () => {
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#888' } }).png().toBuffer();
  assert.match(await storeProductImage(png), /^\/uploads\/products\/.+\.webp$/);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  await assert.rejects(storeProductImage(svg), /Only JPEG, PNG, WebP, GIF or AVIF/);
  await assert.rejects(storeProductImage(Buffer.from('%PDF-1.4 not an image')));
});
