/**
 * Rebuilds supabase/schema.sql from supabase/migrations/*.sql.
 *
 * schema.sql is the single file you paste into a fresh Supabase project
 * (SQL > New query). It must always equal the migrations in order, so it is
 * generated rather than hand-maintained. Every migration is idempotent, so the
 * result is safe to re-run on a live project.
 *
 *   npm run db:schema
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'supabase', 'migrations');
const outFile = join(here, '..', 'supabase', 'schema.sql');

const header = `-- ============================================================
-- SmartHelp full database schema for a fresh Supabase project.
--
-- GENERATED FILE - do not edit by hand.
-- Rebuild with: npm run db:schema
-- Source: supabase/migrations/*.sql, concatenated in filename order.
--
-- Run this in the Supabase SQL editor (SQL > New query). Every statement is
-- idempotent, so it is safe to re-run on a live project.
--
-- Then apply supabase/seed.sql for the demo accounts and a bookable
-- marketplace. Seed data is separate on purpose: schema.sql is the shape of
-- the system, seed.sql is sample content.
--
-- Phase 0 of the delivery plan (§31.1) covers migrations 0000-0007.
-- Phases 1-9 append 0008-0028; re-run \`npm run db:schema\` after each.
-- ============================================================
`;

const files = (await readdir(migrationsDir))
  .filter((name) => name.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b));

if (files.length === 0) {
  console.error('No migrations found in', migrationsDir);
  process.exit(1);
}

const sections = [];
for (const name of files) {
  const body = (await readFile(join(migrationsDir, name), 'utf8')).trim();
  sections.push(`\n\n-- ------------------------------------------------------------\n-- ${name}\n-- ------------------------------------------------------------\n\n${body}\n`);
}

await writeFile(outFile, header + sections.join(''), 'utf8');
console.log(`Wrote ${outFile}`);
console.log(`Migrations: ${files.length} (${files[0]} .. ${files[files.length - 1]})`);
