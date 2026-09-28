// Run the SMD auto-list from the server's shell -- no browser, no nginx
// timeout. Dry run by default; --apply backs up the database first, then lists.
//
//   node server/smd-autolist-cli.js                 # preview infant + cash
//   node server/smd-autolist-cli.js --apply         # back up, then list both
//   node server/smd-autolist-cli.js --list cash     # just one list
//
// Run from the app directory (it uses data/procom.db there).
import { getDb } from './db.js';
import { backupsDir } from './paths.js';
import { autoList } from './smd-autolist.js';
import { SMD_LISTS } from './smd-rules.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = args.includes('--list') ? args[args.indexOf('--list') + 1] : null;
const lists = only ? [only] : Object.keys(SMD_LISTS);

const db = getDb();
const supplier = db.prepare("SELECT id, name FROM suppliers WHERE name LIKE 'SMD%' ORDER BY created_at LIMIT 1").get();
if (!supplier) throw new Error('No SMD supplier found');

if (apply) {
  const file = `${backupsDir()}/pre-autolist-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
  await db.backup(file);
  console.log(`Backup saved: ${file}`);
} else {
  console.log('DRY RUN -- nothing is changed. Add --apply to list.');
}

for (const list of lists) {
  const started = Date.now();
  const r = autoList({ list, supplierId: supplier.id, dryRun: !apply });
  const toList = r.summary.reduce((n, g) => n + g.newListings, 0);
  console.log(`\n== ${r.list} (${supplier.name}): ${r.itemsFound} rows | ${toList} to list | ${r.alreadyCategorised} already categorised | ${r.unmatched.length} unrecognised | ${r.heavy.length} heavy`);
  for (const s of r.skipped) console.log(`   skipped ${s.items.length}: ${s.reason}`);
  if (r.unmatched.length) console.log(`   UNRECOGNISED: ${r.unmatched.map((u) => u.code).join(', ')}`);
  if (!apply) {
    console.log(`   New categories (${r.newCategories.length}):`);
    for (const c of r.newCategories) console.log(`     ${c}`);
  } else {
    console.log(`   Listed ${r.created} | categorised ${r.categorised} | delivery quoted ${r.quoted} | categories created ${r.categoriesCreated.length} | errors ${r.errors.length} | ${Math.round((Date.now() - started) / 1000)}s`);
    for (const e of r.errors.slice(0, 10)) console.log(`   ERROR ${e}`);
  }
}
