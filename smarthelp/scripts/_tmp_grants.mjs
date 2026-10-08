// TEMPORARY introspection helper (deleted after use): what privileges does
// `authenticated` actually hold on the Phase 3 tables? Read-only.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const c = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const t = await c.query(`
  select table_name, grantee,
         string_agg(privilege_type, ',' order by privilege_type) as privs
    from information_schema.table_privileges
   where table_schema = 'public'
     and table_name in ('payments','wallets','wallet_transactions','refunds','addresses','bookings')
   group by 1, 2
   order by 1, 2;`);
console.log('TABLE PRIVILEGES');
console.table(t.rows);

const d = await c.query(`
  select p.rolname as role, n.nspname as schema, a.defaclobjtype,
         coalesce((select string_agg(g.key || '=' || val.value, ', ')
                     from jsonb_each_text(a.defaclacl) g
                     cross join lateral jsonb_each_text(g.value) val), '') as acl
    from pg_default_acl a
    join pg_roles p on p.oid = a.defaclrole
    join pg_namespace n on n.oid = a.defaclnamespace;`);
console.log('DEFAULT ACLs');
console.table(d.rows);

await c.end();
