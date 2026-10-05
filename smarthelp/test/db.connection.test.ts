import { describe, expect, it } from 'vitest';
import { closeDb, dbUrl, sql } from './helpers/dbEnv';

/**
 * A self-test for the connection helper's recovery path.
 *
 * The suite's flakiness was never in the booking rules — it was one shared socket
 * carrying two minutes of sequential queries against a pooler that recycles idle
 * connections. A dead connection used to fail every later test in the file with a
 * transport error, which looks like dozens of unrelated failures and gets
 * "fixed" by rerunning until green.
 *
 * That failure mode is hard to reproduce on demand, so it is provoked here: the
 * socket is destroyed underneath the helper and the next statement still has to
 * succeed. Without `withReconnect` the first assertion below fails and everything
 * after it fails too, which is exactly the shape of the original flake.
 *
 * Skipped when there is no database, like the rest of the live suite.
 */

const describeDb = dbUrl ? describe : describe.skip;

if (!dbUrl) {
  console.warn('\n[db] Skipping the connection recovery tests — no SUPABASE_DB_URL.\n');
}

describeDb('the shared database connection', () => {
  it('answers normally while the socket is healthy', async () => {
    expect(await sql('select 1;')).toBe('1');
  });

  it('reconnects after the connection is dropped, so one dead socket does not fail the rest of the file', async () => {
    // Provoked the way it actually happens: the server ends the session, which is
    // what an idle-connection recycle or a pooler restart looks like to `pg`. The
    // terminating statement rejects — it is being asked to kill its own backend —
    // so that rejection is expected, and the next statement has to succeed anyway.
    // Without `withReconnect` the next one throws, and everything after it in the
    // same file throws too, which is exactly the shape of the original flake.
    await sql('select pg_terminate_backend(pg_backend_pid());').catch(() => {});

    expect(await sql('select 2;')).toBe('2');
    // And it is a real connection afterwards, not a one-shot.
    expect(await sql('select 3;')).toBe('3');
  });

  it('still reports a rejected statement rather than retrying it', async () => {
    // The other half of the fix. A `check_violation` must not be mistaken for a
    // transport error and rerun, because a test asserting "this is refused" would
    // then pass for a reason that has nothing to do with what it claims.
    await expect(sql('select 1 / 0;')).rejects.toThrow(/division by zero/i);
    expect(await sql('select 4;')).toBe('4');
  });
});