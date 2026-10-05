import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, runFile } from './_db.mjs';

/**
 * Applies supabase/migrations/*.sql to SUPABASE_DB_URL, in filename order, and
 * records what it applied in a `schema_migrations` ledger.
 *
 * The ledger is what makes this safe to run twice: a file already recorded is
 * skipped, so a re-run after a partial failure does not try to recreate what
 * succeeded. Review the ledger before forcing anything through.
 *
 *   node scripts/apply-migrations.mjs            # apply what is outstanding
 *   node scripts/apply-migrations.mjs --seed     # ...then the demo seed
 *   node scripts/apply-migrations.mjs --status   # report only, change nothing
 */

const MIGRATIONS_DIR = 'supabase/migrations';
const LEDGER_SCHEMA = 'smarthelp_migrations';
const args = new Set(process.argv.slice(2));
const statusOnly = args.has('--status');
const withSeed = args.has('--seed');

const client = connect();
await client.connect();

try {
  // The ledger lives in its own schema, not in public. It is bookkeeping for
  // this script, not part of the product, and a table in public is a table the
  // RLS test then flags as unprotected — which is correct: the ledger has no
  // policies and no business having any. A private schema also keeps it out of
  // anything that enumerates public.tables, such as PostgREST and db:check.
  await client.query(`
    create schema if not exists ${LEDGER_SCHEMA};
    create table if not exists ${LEDGER_SCHEMA}.schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    );`);

  // A ledger left behind in public by an older version of this script would
  // otherwise sit there forever, still without RLS. It holds no records we care
  // about at that point — the new ledger is what tracks state from here.
  await client.query('drop table if exists public.schema_migrations');

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    // Lexicographic order is the intended order: the filenames are numbered.
    .sort();

  const { rows } = await client.query(`select filename from ${LEDGER_SCHEMA}.schema_migrations`);
  const applied = new Set(rows.map((r) => r.filename));

  console.log(`\n${files.length} migration file(s), ${applied.size} already applied\n`);

  let pending = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }
    pending += 1;
    if (statusOnly) {
      console.log(`  TODO  ${file}`);
      continue;
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await runFile(client, file, sql);
    await client.query(`insert into ${LEDGER_SCHEMA}.schema_migrations (filename) values ($1)`, [
      file,
    ]);
  }

  if (statusOnly) {
    console.log(`\n${pending} outstanding. Re-run without --status to apply.`);
  } else if (pending === 0) {
    console.log('\nNothing to do — the schema is up to date.');
  } else {
    console.log(`\nApplied ${pending} migration(s).`);
  }

  if (withSeed && !statusOnly) {
    const seed = await readFile('supabase/seed.sql', 'utf8');
    console.log('\nseed:');
    await runFile(client, 'seed.sql', seed);
  }
} catch (e) {
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
