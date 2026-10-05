import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Read-only reachability check for SUPABASE_DB_URL.
 *
 * Reports what is there, changes nothing. Safe to run against a project you are
 * unsure about.
 *
 *   node scripts/db-check.mjs
 */

const env = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
const url =
  process.env.SUPABASE_DB_URL ||
  env.match(/^\s*SUPABASE_DB_URL\s*=\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');

if (!url) {
  console.error('SUPABASE_DB_URL is not set.');
  process.exit(1);
}

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  const { rows: [v] } = await client.query('select version()');
  console.log('connected:', v.version.split(',')[0]);

  const { rows: tables } = await client.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name;`
  );
  console.log(`\npublic tables: ${tables.length}`);
  for (const t of tables) console.log('  ', t.table_name);

  const { rows: fns } = await client.query(
    `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' order by 1;`
  );
  console.log(`\npublic functions: ${fns.length}`);
  for (const f of fns) console.log('  ', f.proname);

  if (tables.length === 0) {
    console.log('\nThe project has no schema. The migrations have not been applied.');
  }
} catch (e) {
  console.error('\nFAILED:', e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
