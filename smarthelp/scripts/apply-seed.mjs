import { readFile } from 'node:fs/promises';
import { connect, runFile } from './_db.mjs';

/**
 * Applies supabase/seed.sql — the demo accounts and the bookable catalogue.
 *
 * Separate from apply-migrations.mjs because the seed is not schema: it is
 * disposable data that is safe (and intended) to re-run, while the migrations
 * are not.
 *
 *   node scripts/apply-seed.mjs
 */

const client = connect();
await client.connect();

try {
  const sql = await readFile('supabase/seed.sql', 'utf8');
  await runFile(client, 'seed.sql', sql);
  console.log('\nDemo accounts (password Demo@12345):');
  console.log('  customer      demo.customer@smarthelp.test');
  console.log('  professional  demo.pro@smarthelp.test');
  console.log('  admin         demo.admin@smarthelp.test');
  console.log('  support       demo.support@smarthelp.test');
  console.log('  ops           demo.ops@smarthelp.test');
} catch {
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
