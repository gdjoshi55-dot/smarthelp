import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Connection helper for the database suite.
 *
 * Two things it handles that the previous `psql`-based version did not.
 *
 * `.env.local` is loaded here rather than being expected in the process
 * environment. Vitest does not put env-file values into `process.env`, so the
 * suite skipped itself even with a perfectly good `.env.local` sitting next to
 * it. Values already present in the environment win, so CI can still override.
 *
 * `pg` is used rather than shelling out to `psql`, which is not installed on a
 * typical Windows dev box and made the file unrunnable anywhere the CLI was
 * absent. There is also no synchronous query API, so every call site below is
 * async; that is the only real cost.
 */

/** Reads `.env.local` and returns it, without mutating anything. */
function readEnvFile(): Record<string, string> {
  const path = join(__dirname, '..', '..', '.env.local');
  const out: Record<string, string> = {};

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out; // No .env.local is a legitimate state; the caller reports it.
  }

  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const envFile = readEnvFile();

/**
 * The connection string, or undefined when there is none. Checked before any
 * client is built so the suite can skip instead of throwing on import.
 */
export const dbUrl: string | undefined =
  process.env.SUPABASE_DB_URL || envFile.SUPABASE_DB_URL;

/**
 * The URL and service-role key, for the tests that have to go through the
 * auth API rather than through SQL.
 *
 * The env file is consulted *first*, which is the reverse of dbUrl above and
 * deliberate. `vitest.config.ts` puts placeholder values for
 * SUPABASE_SERVICE_ROLE_KEY and friends into process.env so that the Route
 * Handler tests can import modules that read them at module scope. Preferring
 * process.env here would hand those tests a fake key, and a request made with
 * it fails as an auth error rather than a database one — a failure that reads
 * like a bug in the code under test.
 *
 * In CI there is no .env.local, so envFile is empty and the real credentials
 * from the environment are used instead. Both paths are supported on purpose.
 */
export const supabaseUrl: string | undefined =
  envFile.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
export const serviceRoleKey: string | undefined =
  envFile.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

/** True when these tests can actually reach the auth API, and so should run. */
export const hasAuthAdmin = Boolean(dbUrl && supabaseUrl && serviceRoleKey);

let client: Client | undefined;

async function connect(): Promise<Client> {
  const c = new Client({
    connectionString: dbUrl,
    // Supabase's pooler presents a certificate for a name that is not in the
    // chain we build locally, so the usual guidance applies: the transport is
    // encrypted, the CA chain is not verifiable here.
    ssl: { rejectUnauthorized: false },
  });
  // A dropped connection arrives as an `error` event, not as a rejected query —
  // the query that was in flight rejects too, but only sometimes, and a client
  // left with no listener turns that event into an uncaught exception. The
  // failure is not hidden by ignoring it: the next statement goes through
  // `withReconnect`, which sees the dead socket and re-opens it.
  c.on('error', () => {});
  await c.connect();
  return c;
}

/**
 * Has this connection lost its socket?
 *
 * `ending` and `stream` are part of how `pg` tracks a connection but not part of
 * its published types, so they are read through a narrow cast rather than with an
 * `any` that would hide any mistake made here. Both are optional-chained: a guard
 * that throws while diagnosing a dead connection would replace a flake with an
 * outage.
 */
function isDeadConnection(c: Client): boolean {
  const internals = c as unknown as {
    ending?: boolean;
    stream?: { destroyed?: boolean };
  };
  return internals.ending === true || internals.stream?.destroyed === true;
}

/** One shared connection for the file, opened lazily, and reopened if it died. */
export async function getClient(): Promise<Client> {
  if (!dbUrl) {
    throw new Error('SUPABASE_DB_URL is not set');
  }
  // A destroyed socket is the honest signal: after the peer goes away the
  // connection object is still there and still defined, so a truthiness check
  // alone would keep handing out a dead connection for the rest of the run.
  if (client && !isDeadConnection(client)) return client;

  const fresh = await connect();
  client = fresh;
  return fresh;
}

/**
 * Is this a dead socket rather than a rejected statement?
 *
 * The distinction decides whether the query is safe to run again, and getting it
 * wrong in the lenient direction would turn a real assertion failure into a retry
 * that hides it. Only transport-level wording qualifies — a `check_violation` or a
 * `RAISE` from a trigger carries a SQLSTATE we must report, not retry.
 */
function isConnectionError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /connection (?:terminated|ended|closed|reset)|terminating connection|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|Client has encountered a connection error|socket hang up|timeout expired when trying to connect/i.test(
    message
  );
}

/** Runs a query, re-opening the shared connection once if the socket dropped. */
async function withReconnect<T>(run: (c: Client) => Promise<T>): Promise<T> {
  try {
    return await run(await getClient());
  } catch (e) {
    if (!isConnectionError(e)) throw e;
    // Half-open sockets are what make this suite flaky rather than broken: one
    // dead connection used to fail every *subsequent* test in the file with a
    // transport error, which reads like fifty unrelated bugs. Supabase's pooler
    // recycles idle connections, so a run that has been going two minutes can
    // simply come back.
    client = undefined;
    return run(await getClient());
  }
}

/** Runs SQL as the migration owner, which bypasses RLS. */
export async function sql(query: string): Promise<string> {
  const res = await withReconnect((c) => c.query(query));
  return flatten(res);
}

/**
 * Runs SQL as a signed-in user rather than as the owner, so RLS applies.
 *
 * Everything else in this file connects as the migration owner, which bypasses
 * row-level security. That is enough to assert a policy *exists*; it cannot
 * answer whether a policy lets the wrong person through, which is the question
 * that actually matters for a table like `addresses`.
 *
 * So this drops to the `authenticated` role and sets the JWT claims PostgREST
 * would have set, inside a transaction that is always closed:
 *
 *   set local role authenticated;
 *   select set_config('request.jwt.claims', '{"sub":"…","role":"authenticated"}');
 *   select set_config('request.jwt.claim.role', 'authenticated');
 *
 * The third line is not redundant. `public.is_trusted_session()` — which
 * `set_default_address()` consults — reads `request.jwt.claim.role` and treats
 * an *empty* setting as "this is the server, trust it". Leaving it unset would
 * make every impersonated user look like the service role, and the ownership
 * checks under test would pass for the wrong reason.
 *
 * A statement that RLS should block does not raise: a forbidden `select`
 * returns no rows. Assertions therefore count rows rather than expecting a
 * throw, which is also how the failure would present in production.
 *
 * Pass `userId: null` for an anonymous visitor.
 */
export async function sqlAsRole(
  userId: string | null,
  query: string,
  role = 'authenticated'
): Promise<string> {
  // No reconnect here, deliberately. This wraps a multi-statement transaction
  // whose claims are set inside it, so a socket that dies midway has to surface
  // as a failure: there is no way to re-establish `set local role authenticated`
  // on a fresh connection and have it mean the same thing.
  const c = await getClient();
  // `sub` is omitted rather than emptied for an anonymous visitor: auth.uid()
  // casts it to uuid from either the JSON blob or the individual setting, and
  // '' is not a uuid.
  const claims = JSON.stringify(userId ? { sub: userId, role } : { role });

  await c.query('begin');
  try {
    await c.query(`set local role ${role}`);
    await c.query('select set_config($1, $2, true)', ['request.jwt.claims', claims]);
    await c.query('select set_config($1, $2, true)', ['request.jwt.claim.role', role]);
    await c.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', userId]);
    const res = await c.query(query);
    await c.query('commit');
    return flatten(res);
  } catch (e) {
    // Never leave the shared connection inside an open transaction: the next
    // test would run as `authenticated` and pass or fail for the wrong reason.
    await c.query('rollback').catch(() => {});
    throw e;
  }
}

/** The flat, newline-joined string shape the callers here parse. */
function flatten(res: { rows: Record<string, unknown>[] }): string {
  return res.rows
    .flatMap((r) => Object.values(r))
    .map((v) => (v === null || v === undefined ? '' : String(v)))
    .join('\n')
    .trim();
}

/** Closes the connection. Call from afterAll so the runner can exit. */
export async function closeDb(): Promise<void> {
  if (client) {
    await client.end().catch(() => {});
    client = undefined;
  }
}
