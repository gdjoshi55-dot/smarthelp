import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const { Client } = pg;

/**
 * Shared plumbing for the database scripts: read a value out of `.env.local`,
 * and open a connection to it.
 *
 * Reading the file rather than relying on the shell's environment is
 * deliberate — `npm run` scripts do not load `.env.local`, and a script that
 * demands the user export variables by hand is a script nobody runs.
 */

export function envValue(name) {
  if (process.env[name]) return process.env[name];
  try {
    const raw = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    const match = raw.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm'));
    return match?.[1]?.trim().replace(/^["']|["']$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

export function requireEnvValue(name) {
  const value = envValue(name);
  if (!value) {
    console.error(`${name} is not set. Add it to .env.local (see docs/SETUP.md).`);
    process.exit(1);
  }
  return value;
}

export function connect() {
  const client = new Client({
    connectionString: requireEnvValue('SUPABASE_DB_URL'),
    // Supabase's pooler presents a certificate that is not in the local trust
    // store. The connection is already encrypted; verifying it against an
    // unknown CA adds nothing here.
    ssl: { rejectUnauthorized: false },
  });
  return client;
}

/**
 * Runs one migration file as a single transaction.
 *
 * A migration that fails halfway must not leave half a schema behind, so each
 * file is all-or-nothing.
 */
export async function runFile(client, label, sql) {
  await client.query('begin');
  try {
    await client.query(sql);
    await client.query('commit');
    console.log(`  ok    ${label}`);
  } catch (e) {
    await client.query('rollback').catch(() => {});
    console.error(`  FAIL  ${label}`);
    console.error(`        ${e.message}`);
    if (e.position) {
      // Point at the offending statement rather than making them count lines.
      const pos = Number(e.position);
      console.error(`        near: ${sql.slice(Math.max(0, pos - 120), pos + 120).trim()}`);
    }
    throw e;
  }
}
