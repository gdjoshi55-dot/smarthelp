import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `supabaseConfigError()` is what turns a missing `.env.local` into a screen
 * with instructions instead of a thrown error. It reads module-scope state, so
 * the module is re-imported per case.
 */
async function load(keys: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ NEXT_PUBLIC_SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_ANON_KEY: '', ...keys })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('@/lib/supabase');
}

const original = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};

afterEach(() => {
  for (const [k, v] of Object.entries(original)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('supabaseConfigError', () => {
  it('says nothing when both keys are present', async () => {
    const { supabaseConfigError } = await load({
      NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    });
    expect(supabaseConfigError()).toBeNull();
  });

  it('names the keys that are missing', async () => {
    const { supabaseConfigError } = await load({
      NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
    });
    const problem = supabaseConfigError();
    expect(problem).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY');
    // Only the key that is actually absent is named.
    expect(problem).not.toContain('NEXT_PUBLIC_SUPABASE_URL');
  });

  it('names both when neither is set, and says how to fix it', async () => {
    const { supabaseConfigError } = await load({
      NEXT_PUBLIC_SUPABASE_URL: undefined,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
    });
    const problem = supabaseConfigError();
    expect(problem).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(problem).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY');
    expect(problem).toContain('.env.local');
  });

  it('treats an empty string as missing, not as configured', async () => {
    const { supabaseConfigError } = await load({
      NEXT_PUBLIC_SUPABASE_URL: '',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: '',
    });
    expect(supabaseConfigError()).toContain('NEXT_PUBLIC_SUPABASE_URL');
  });
});

describe('getSupabase', () => {
  it('refuses to build a client without credentials, so a server fault stays loud', async () => {
    const { getSupabase } = await load({
      NEXT_PUBLIC_SUPABASE_URL: undefined,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
    });
    // The UI checks supabaseConfigError() first; a route that reaches
    // getSupabase() anyway has a real fault and should fail rather than
    // pretend to work.
    expect(() => getSupabase()).toThrow(/credentials missing/);
  });
});
