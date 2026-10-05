import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase';

/**
 * A stand-in for the service-role Supabase client.
 *
 * The Route Handler tests need to answer two questions — "does the route take
 * the right branch?" and "does it refuse the wrong caller?" — and both are
 * decided by what the database returns, not by how many round trips the route
 * makes. A hand-rolled fake is therefore the right tool: a real database would
 * test PostgREST, which is Supabase's job, not ours.
 *
 * `from()` returns a chainable thenable so `await supabase.from(..).select(..)
 * .eq(..).maybeSingle()` resolves, and every call is recorded in `calls` so a
 * test can assert on *which* row a route wrote, not merely that it wrote one.
 */

export type QueryOperator = 'select' | 'insert' | 'update' | 'upsert' | 'delete';

export interface RecordedCall {
  op: QueryOperator;
  table: string;
  payload?: unknown;
  filters: [string, unknown][];
  /**
   * Just the equality filters, which are the ones the fake applies to the rows
   * a responder returns. `.in()`, ranges and ordering are recorded but not
   * evaluated: a fixture that satisfies them is the test's job, and guessing
   * would hide a real mismatch behind a quietly empty result.
   */
eqFilters: [string, unknown][];
   /**
    * The named arguments of an `rpc` call, when the recorded call came from one.
    *
    * Without this an RPC responder is blind to its own parameters, so a test could
    * not tell `create_booking(p_money => …)` from `create_booking(p_money => null)`
    * — and the booking write paths moved into functions in 0028, which is exactly
    * where a fake that ignores its arguments starts asserting on nothing.
    */
   args?: Record<string, unknown>;
 }

export interface FakeResult<T> {
  data: T;
  error: { message: string; code?: string } | null;
}

type Responder = (call: RecordedCall) => FakeResult<any>;

/** A responder may answer with one row or with a list; `maybeSingle` wants one. */
function unwrapSingle(result: FakeResult<any>): FakeResult<any> {
  if (!Array.isArray(result.data)) return result;
  return { ...result, data: result.data[0] ?? null };
}

export class FakeSupabase {
  calls: RecordedCall[] = [];
  rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

  constructor(
    private readonly tables: Record<string, Responder> = {},
    private readonly rpcs: Record<string, Responder> = {}
  ) {}

  /** Records a call and resolves with whatever the responder returns. */
  private record(call: RecordedCall): FakeResult<any> {
    this.calls.push(call);
    const responder = this.tables[call.table];
    if (!responder) return { data: null, error: null };

    const result = responder(call);
    if (!Array.isArray(result.data)) return result;

    // `.eq()` is applied, so a fixture that returns two services still answers
    // "one service" for `?id=…`. Without this, every query that filters by id
    // would come back with the whole table and the test would be asserting on
    // the fixture rather than on the route.
    const matched = call.eqFilters.reduce(
      (rows, [column, value]) =>
        rows.filter((row) => row && typeof row === 'object' && (row as any)[column] === value),
      result.data
    );

    return { ...result, data: this.echoInsert(call, this.echoUpdate(call, matched)) };
  }

  /**
   * An `update` returns the row *as it now stands*, so the payload is merged
   * into it.
   *
   * Without this, `.update({ status: 'cancelled' }).eq(..).select().maybeSingle()`
   * hands back the untouched fixture and every status-mutating route looks like
   * it wrote nothing — which is the one thing such a test exists to catch. The
   * fake does not recompute triggers or defaults; it just refuses to lie about
   * the columns the route itself wrote.
   */
  private echoUpdate(call: RecordedCall, rows: any): any {
    const payload = call.payload;
    if (call.op !== 'update' || !Array.isArray(rows)) return rows;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return rows;

    return rows.map((row) =>
      row && typeof row === 'object' ? { ...row, ...(payload as Record<string, unknown>) } : row
    );
  }

  /**
   * `.insert(..).select(..).single()` returns the row the database wrote, with
   * the defaults filled in. A fixture that answers an insert with an empty list
   * would make every create route look like it stored nothing, so the payload is
   * echoed back with the columns Postgres would have filled.
   */
  private echoInsert(call: RecordedCall, data: any): any {
    const payload = call.payload;
    if (call.op !== 'insert' || !Array.isArray(data) || data.length > 0) return data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return data;

    return [
      {
        id: '00000000-0000-4000-8000-0000000000ff',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        ...(payload as Record<string, unknown>),
      },
    ];
  }

  from(table: string) {
    const state: RecordedCall = { op: 'select', table, filters: [], eqFilters: [] };
    let mutating = false;

    const chain: any = {
      select: (_cols?: string) => {
        // A trailing `.select()` on a mutation means "and give me the row back".
        // It must not undo the write that was already recorded.
        if (!mutating) state.op = 'select';
        return chain;
      },
      insert: (payload: unknown) => {
        mutating = true;
        state.op = 'insert';
        state.payload = payload;
        return chain;
      },
      update: (payload: unknown) => {
        mutating = true;
        state.op = 'update';
        state.payload = payload;
        return chain;
      },
      upsert: (payload: unknown) => {
        mutating = true;
        state.op = 'upsert';
        state.payload = payload;
        return chain;
      },
      delete: () => {
        mutating = true;
        state.op = 'delete';
        return chain;
      },
      eq: (column: string, value: unknown) => {
        state.filters.push([column, value]);
        state.eqFilters.push([column, value]);
        return chain;
      },
      in: (column: string, values: unknown) => {
        state.filters.push([column, values]);
        return chain;
      },
      // Ordering and ranges are part of the fluent surface the query builders
      // use. The fake does not evaluate them — a `RecordedCall` is not a result
      // set — but it has to accept them, or a query that merely *sorts* fails
      // for a reason that has nothing to do with what is being tested.
      order: () => chain,
      limit: () => chain,
      range: () => chain,
      gte: (column: string, value: unknown) => {
        state.filters.push([column, value]);
        return chain;
      },
      gt: (column: string, value: unknown) => {
        state.filters.push([column, value]);
        return chain;
      },
      lte: (column: string, value: unknown) => {
        state.filters.push([column, value]);
        return chain;
      },
      lt: (column: string, value: unknown) => {
        state.filters.push([column, value]);
        return chain;
      },
      is: (column: string, value: unknown) => {
        state.filters.push([column, value]);
        return chain;
      },
      not: () => chain,
      // PostgREST unwraps a `maybeSingle` to the row itself, and a fixture that
      // answers "these are the rows" has to work for a `.eq('id', …)` that leaves
      // one. Without this a query that filters down to a single row hands the
      // route an array, and every field reads as undefined.
      maybeSingle: () => Promise.resolve(this.record(state)).then(unwrapSingle),
      single: () => Promise.resolve(this.record(state)).then(unwrapSingle),
      then: (resolve: (value: FakeResult<any>) => unknown) =>
        Promise.resolve(this.record(state)).then(resolve),
    };

    return chain;
  }

  rpc(fn: string, args: Record<string, unknown> = {}) {
    this.rpcCalls.push({ fn, args });
    const responder = this.rpcs[fn];
    const result = responder
      ? responder({ op: 'select', table: fn, filters: [], eqFilters: [], args })
      : { data: null, error: null };
    return Promise.resolve(result);
  }

  /**
   * Records a write an RPC responder performed.
   *
   * A `security definer` function does several things in one statement, and a
   * responder standing in for one has to be able to say so: `create_booking()`
   * writes a booking, its item lines and a status change, and the tests that care
   * about those rows should not have to care that they now arrive through an RPC.
   * The recorded call is what `writesTo()` finds.
   */
  noteWrite(table: string, op: QueryOperator, payload?: unknown) {
    this.calls.push({ op, table, payload, filters: [], eqFilters: [] });
  }

  auth: {
    admin: {
      createUser: (attrs: unknown) => Promise<unknown>;
      updateUserById: (id: string, attrs: unknown) => Promise<unknown>;
      generateLink: (params: unknown) => Promise<unknown>;
      signOut: (token: string) => Promise<unknown>;
    };
    getUser: (token?: string) => Promise<unknown>;
    getSession: () => Promise<unknown>;
    refreshSession: () => Promise<unknown>;
    signInWithPassword: (creds: unknown) => Promise<unknown>;
  } = {
    admin: {
      createUser: async (_attrs: unknown) => ({
        data: { user: { id: '00000000-0000-4000-8000-000000000001' } },
        error: null,
      }),
      updateUserById: async (_id: string, _attrs: unknown) => ({
        data: { user: { id: '00000000-0000-4000-8000-000000000001' } },
        error: null,
      }),
      generateLink: async (_params: unknown) => ({
        data: {
          action_link: 'http://localhost/verify?token_hash=handshake',
          // GoTrue returns the *hashed* token under `hashed_token`; the
          // `verifyOtp` exchange takes that, not the raw one.
          properties: { hashed_token: 'handshake-token-hash', email_otp: '123456' },
          user: { id: '00000000-0000-4000-8000-000000000001' },
        },
        error: null,
      }),
      signOut: async (_token: string) => ({ error: null }),
    },
    getUser: async (_token?: string) => ({
      data: { user: { id: '00000000-0000-4000-8000-000000000001' } },
      error: null,
    }),
    getSession: async () => ({ data: { session: null }, error: null }),
    refreshSession: async () => ({ data: { session: null }, error: null }),
    signInWithPassword: async (_creds: unknown) => ({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    }),
  };

  /** The calls written to one table, for a focused assertion. */
  writesTo(table: string): RecordedCall[] {
    return this.calls.filter(
      (c) => c.table === table && c.op !== 'select'
    );
  }
}

export type FakeOf<T> = SupabaseClient<Database> & T;

/** Builds a plain object that the route will treat as a service-role client. */
export function fakeSupabase(instance: FakeSupabase): SupabaseClient<Database> {
  return instance as unknown as SupabaseClient<Database>;
}
