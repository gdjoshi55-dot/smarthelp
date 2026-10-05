import { connect } from './_db.mjs';

/**
 * Prints the columns of a table in the `auth` schema.
 *
 * The seed writes to auth.users and auth.identities directly, and GoTrue has
 * changed both across versions — so the seed has to be checked against the
 * project it is being applied to, not against documentation.
 *
 *   node scripts/describe-auth.mjs
 */

const table = process.argv[2] || 'identities';

const client = connect();
await client.connect();

try {
  const { rows } = await client.query(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'auth' and table_name = $1
      order by ordinal_position;`,
    [table]
  );
  console.log(`\nauth.${table}: ${rows.length} columns\n`);
  for (const c of rows) {
    const req = c.is_nullable === 'NO' ? 'NOT NULL' : '';
    const def = c.column_default ? ` default=${c.column_default}` : '';
    console.log(`  ${c.column_name.padEnd(28)} ${c.data_type}${req}${def}`);
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
