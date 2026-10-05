import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The super_admin bootstrap is the one path in the product by which a role is
 * granted without an administrator performing the grant. It is worth pinning
 * down tightly: it must be off by default, and it must not fire on a partial
 * match.
 *
 * OWNER_LOGIN is read from the environment at module load, so the module is
 * re-imported with a fresh environment per case.
 */
async function loadOwner(login: string | undefined) {
  vi.resetModules();
  if (login === undefined) {
    delete process.env.SMARTHELP_OWNER_LOGIN;
  } else {
    process.env.SMARTHELP_OWNER_LOGIN = login;
  }
  return import('@/lib/owner');
}

const original = process.env.SMARTHELP_OWNER_LOGIN;

afterEach(() => {
  if (original === undefined) delete process.env.SMARTHELP_OWNER_LOGIN;
  else process.env.SMARTHELP_OWNER_LOGIN = original;
});

describe('isOwnerLogin', () => {
  it('matches nothing at all when the allow-list is empty', async () => {
    const { isOwnerLogin } = await loadOwner(undefined);
    expect(isOwnerLogin('admin@smarthelp.test')).toBe(false);
    expect(isOwnerLogin('')).toBe(false);
    expect(isOwnerLogin(null)).toBe(false);
  });

  it('matches the bare login name and the seeded .test address', async () => {
    const { isOwnerLogin } = await loadOwner('smarthelp');
    expect(isOwnerLogin('smarthelp')).toBe(true);
    expect(isOwnerLogin('SmartHelp')).toBe(true);
    expect(isOwnerLogin('  smarthelp  ')).toBe(true);
    expect(isOwnerLogin('smarthelp@smarthelp.test')).toBe(true);
  });

  it('does not fire on a different account, a suffix, or a prefix', async () => {
    const { isOwnerLogin } = await loadOwner('smarthelp');
    expect(isOwnerLogin('other')).toBe(false);
    expect(isOwnerLogin('not-smarthelp')).toBe(false);
    expect(isOwnerLogin('smarthelp.evil@example.com')).toBe(false);
    expect(isOwnerLogin('smart')).toBe(false);
  });

  it('never matches an absent login', async () => {
    const { isOwnerLogin } = await loadOwner('smarthelp');
    expect(isOwnerLogin(undefined)).toBe(false);
    expect(isOwnerLogin(null)).toBe(false);
  });

  it('trims the allow-list value itself, so a stray space in the env is not fatal', async () => {
    const { OWNER_LOGIN, isOwnerLogin } = await loadOwner('  smarthelp  ');
    expect(OWNER_LOGIN).toBe('smarthelp');
    expect(isOwnerLogin('smarthelp@smarthelp.test')).toBe(true);
  });
});

describe('synthetic email handshake', () => {
  beforeEach(() => vi.resetModules());

  it('derives one address per phone, and recognises it again', async () => {
    const { syntheticEmailFor, isSyntheticEmail } = await import('@/lib/authServer');
    const email = syntheticEmailFor('+919876543210');
    expect(email).toBe('919876543210@auth.smarthelp.invalid');
    expect(isSyntheticEmail(email)).toBe(true);
  });

  it('is stable, so the same phone always maps to the same auth user', async () => {
    const { syntheticEmailFor } = await import('@/lib/authServer');
    expect(syntheticEmailFor('+919876543210')).toBe(syntheticEmailFor('919876543210'));
  });

  it('does not claim a real address', async () => {
    const { isSyntheticEmail } = await import('@/lib/authServer');
    expect(isSyntheticEmail('someone@smarthelp.in')).toBe(false);
    expect(isSyntheticEmail('demo.admin@smarthelp.test')).toBe(false);
    expect(isSyntheticEmail(null)).toBe(false);
    expect(isSyntheticEmail(undefined)).toBe(false);
  });
});
