import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from './_db.mjs';

/**
 * Dry-runs the outstanding migrations and writes nothing.
 *
 * Applying a migration to a live project is not something a build script should
 * do unasked, but "does this SQL even compile" is a question worth answering
 * before asking a human for permission. A policy naming a missing function, an
 * index expression that will not cast, a check constraint that contradicts the
 * seed — all cheap to catch here, expensive to catch halfway through a real run.
 *
 *   node scripts/check-migrations.mjs                 # everything outstanding
 *   node scripts/check-migrations.mjs --only 0010     # one file
 *   node scripts/check-migrations.mjs --status        # list only, no connection
 *
 * All files go into ONE transaction that is always rolled back, because
 * migrations are an ordered chain: 0011's trigger references 0010's table, so
 * checking each file against the schema as it stands today would fail on a
 * perfectly good file. DDL is transactional in Postgres, so the rollback undoes
 * the enums, the sequence and the indexes too.
 *
 * Per-file savepoints give a report that says which file broke. The run stops at
 * the first failure: everything after it in the chain depends on it, so their
 * errors would be noise rather than information.
 */

const MIGRATIONS_DIR = 'supabase/migrations';
const LEDGER_SCHEMA = 'smarthelp_migrations';
const args = process.argv.slice(2);
const statusOnly = args.includes('--status');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

const allFiles = (await readdir(MIGRATIONS_DIR))
  .filter((f) => f.endsWith('.sql'))
  // Lexicographic order is the intended order: the filenames are numbered.
  .sort()
  .filter((f) => !only || f.includes(only));

if (statusOnly) {
  console.log('\n  (connect to determine which are outstanding)\n');
  for (const f of allFiles) console.log(`  ${f}`);
  process.exit(0);
}

const client = connect();
await client.connect();

let failed = 0;
let checked = 0;
try {
  const hasLedger = await client.query(
    `select to_regclass('${LEDGER_SCHEMA}.schema_migrations') is not null as present`
  );
  let applied = new Set();
  if (hasLedger.rows[0].present) {
    const { rows } = await client.query(`select filename from ${LEDGER_SCHEMA}.schema_migrations`);
    applied = new Set(rows.map((r) => r.filename));
  }

  const files = allFiles.filter((f) => !applied.has(f));
  if (files.length === 0) {
    console.log('\nNothing outstanding — the schema is up to date.\n');
  }

  await client.query('begin');
  try {
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query(`savepoint chk`);
      try {
        await client.query(sql);
        await client.query(`release savepoint chk`);
        checked += 1;
        console.log(`  ok    ${file}`);
      } catch (e) {
        await client.query(`rollback to savepoint chk`).catch(() => {});
        failed = 1;
        console.log(`  FAIL  ${file}`);
        console.log(`        ${(e.message || '').split('\n').slice(0, 3).join('\n        ')}`);
        const detail = (e.detail || '').split('\n')[0];
        if (detail) console.log(`        detail: ${detail}`);
        const hint = (e.hint || '').split('\n')[0];
        if (hint) console.log(`        hint: ${hint}`);
        if (e.position) {
          const pos = Number(e.position);
          console.log(`        near: ${sql.slice(Math.max(0, pos - 140), pos + 140).trim()}`);
        }
        break;
      }
    }
  } finally {
    // Unconditional. Whatever happened above, this transaction does not commit.
    await client.query('rollback').catch(() => {});
  }

  console.log(
    failed === 0
      ? `\n${checked} file(s) apply cleanly. Nothing was written.\n`
      : `\nStopped at the first failure — the rest of the chain depends on it.\nNothing was written.\n`
  );
} finally {
  process.exitCode = failed;
  await client.end().catch(() => {});
}