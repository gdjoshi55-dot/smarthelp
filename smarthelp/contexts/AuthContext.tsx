'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, supabaseConfigError, type Profile, type UserRole } from '@/lib/supabase';
import { CAPABILITIES, ROLE_HOME, can, type Capability } from '@/lib/roles';
import { readApiError } from '@/lib/api';

/**
 * The session, the profile, the role and the capabilities.
 *
 * Two rules hold this together:
 *   1. The role is read from `/api/auth/me`, which reads it from the database.
 *      A tampered localStorage entry changes nothing.
 *   2. Capabilities are derived from that role by the same module the server
 *      uses, so the UI can hide what the API would refuse anyway.
 *
 * The context is a convenience for rendering. It is never the enforcement —
 * RLS and the Route Handler guards are (§26.2).
 */

export interface CustomerSummary {
  id: string;
  referral_code: string;
  total_bookings: number;
  completed_bookings: number;
  lifetime_value: number;
}

export interface ProfessionalSummary {
  id: string;
  verification_status: string;
  training_status: string;
  availability_status: string;
  is_available_today: boolean;
  rating: number | null;
  rating_count: number;
}

export interface MeResponse {
  profile: Profile;
  role: UserRole;
  roleLabel: string;
  /** Always the expanded list — the server sends no wildcard. */
  capabilities: Capability[];
  sections: string[];
  home: string;
  customer: CustomerSummary | null;
  professional: ProfessionalSummary | null;
  serverNow: string;
}

/** What the send-a-code endpoints report back once a code is on its way. */
export interface CodeDispatch {
  target: string;
  resendInSeconds: number;
  expiresInSeconds: number;
  /** Only ever set when no mail provider is configured, i.e. local dev. */
  devCode?: string;
}

/** The only two roles a person may pick for themselves. */
export type SignUpRole = 'customer' | 'professional';

interface AuthContextType {
  session: Session | null;
  profile: Profile | null;
  role: UserRole | null;
  roleLabel: string | null;
  capabilities: Capability[];
  sections: string[];
  customer: CustomerSummary | null;
  professional: ProfessionalSummary | null;
  loading: boolean;
  /** True while the initial session probe is running. */
  initialising: boolean;
  error: string | null;
  /**
   * Set when the app cannot reach Supabase at all — usually a missing
   * `.env.local`. Distinct from `error`, which a retry can clear.
   */
  configError: string | null;

  requestOtp: (input: {
    phone?: string;
    email?: string;
    channel: 'phone' | 'email';
    purpose?: 'login' | 'staff_login' | 'admin_mfa';
    role?: 'customer' | 'professional';
    full_name?: string;
  }) => Promise<{ devCode?: string; resendInSeconds: number }>;

  verifyOtp: (input: {
    phone?: string;
    email?: string;
    channel: 'phone' | 'email';
    code: string;
    purpose?: 'login' | 'staff_login' | 'admin_mfa';
    role?: 'customer' | 'professional';
    full_name?: string;
  }) => Promise<void>;

  /** The SmartPOS-style password sign-in. Works for every role. */
  signIn: (email: string, password: string) => Promise<{ role: UserRole; home: string }>;

  /**
   * First half of sign-up: email a code to prove the address, create nothing.
   * The password is not part of this call.
   */
  signUpStart: (input: {
    email: string;
    fullName: string;
    role: SignUpRole;
  }) => Promise<CodeDispatch>;

  /**
   * Second half: the code plus the password, which creates the account and
   * signs the person straight in.
   */
    signUpComplete: (input: {
      email: string;
      code: string;
      password: string;
      passwordConfirm: string;
      fullName: string;
      role: SignUpRole;
      phone?: string;
    }) => Promise<{ role: UserRole; home: string }>;

  /** Always succeeds, whether or not the address is registered. */
  passwordResetStart: (
    email: string
  ) => Promise<CodeDispatch>;

  passwordResetComplete: (input: {
    email: string;
    code: string;
    password: string;
    passwordConfirm: string;
  }) => Promise<{ email: string }>;

  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  hasCapability: (capability: Capability) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [initialising, setInitialising] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set only when the app cannot talk to Supabase at all. It is a setup
  // problem, not a session problem, so it is kept apart from `error`: it must
  // never be cleared by a retry that was never going to work.
  const [configError, setConfigError] = useState<string | null>(null);

  const loadMe = useCallback(async (active: Session | null) => {
    if (!active) {
      setMe(null);
      return;
    }
    const res = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${active.access_token}` },
      cache: 'no-store',
    });
    if (!res.ok) {
      const { message } = await readApiError(res);
      setError(message);
      setMe(null);
      return;
    }
    const body = await res.json();
    setMe(body.data as MeResponse);
  }, []);

  // The one place the session is established: on mount, and on any auth event.
  useEffect(() => {
    let cancelled = false;

    // Anything wrong in here is a configuration or connectivity fault, and the
    // page must say so rather than spin forever. The `supabase` proxy throws
    // synchronously when the keys are missing, so this whole body is guarded,
    // not just the awaits.
    try {
      const boot = async () => {
        try {
          const { data } = await supabase.auth.getSession();
          if (cancelled) return;
          setSession(data.session);
          await loadMe(data.session);
        } catch (e: any) {
          if (cancelled) return;
          setConfigError(supabaseConfigError() ?? e?.message ?? 'Could not reach Supabase.');
        } finally {
          if (!cancelled) setInitialising(false);
        }
      };

      boot();

      const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
        if (cancelled) return;
        if (event === 'SIGNED_OUT' || !next) {
          setSession(null);
          setMe(null);
          setInitialising(false);
          return;
        }
        setSession(next);
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
          loadMe(next).finally(() => setInitialising(false));
        }
      });

      return () => {
        cancelled = true;
        sub.subscription.unsubscribe();
      };
    } catch (e: any) {
      setConfigError(supabaseConfigError() ?? e?.message ?? 'Could not reach Supabase.');
      setInitialising(false);
      return;
    }
  }, [loadMe]);

  const requestOtp = useCallback<AuthContextType['requestOtp']>(async (input) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const { message } = await readApiError(res);
        setError(message);
        throw new Error(message);
      }
      const body = await res.json();
      return {
        devCode: body.data?.devCode,
        resendInSeconds: body.data?.resendInSeconds ?? 60,
      };
    } finally {
      setLoading(false);
    }
  }, []);

  const verifyOtp = useCallback<AuthContextType['verifyOtp']>(async (input) => {
    setLoading(true);
    setError(null);
    try {
      // Step 1: the server checks the code against its own ledger.
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const { message, code } = await readApiError(res);
        setError(message);
        throw Object.assign(new Error(message), { code });
      }
      const body = await res.json();

      // Step 2: exchange the one-time token for a session.
      const { error: sessionError } = await supabase.auth.verifyOtp({
        token_hash: body.data.tokenHash,
        type: 'email',
      });
      if (sessionError) {
        setError('Your code was accepted but the session could not be opened. Please request a new code.');
        throw sessionError;
      }
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * One POST to a SmartHelp auth endpoint, with the loading flag and the error
   * banner handled the same way for every call.
   *
   * A rejected call throws, so the form can stop where it is and show the
   * message. `details.fields` rides along on the error so a form can put a
   * message under the field that caused it rather than only in the banner.
   */
  const postAuth = useCallback(async <T,>(url: string, body: unknown): Promise<T> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const { message, code, details } = await readApiError(res);
        setError(message);
        throw Object.assign(new Error(message), { code, details });
      }
      return ((await res.json()).data as T);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Stores the session the server opened, so `me` fills in on its own.
   *
   * The role comes back with the session because the server decided it, and it
   * is the route the form redirects to — before `me` has loaded, so there is no
   * frame where the page sits on a half-known user.
   */
  const adoptSession = useCallback(
    async (
      session: { access_token: string; refresh_token: string },
      role: UserRole
    ): Promise<{ role: UserRole; home: string }> => {
      const { error: sessionError } = await supabase.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
      if (sessionError) {
        setError('Signed in, but the session could not be stored. Please try again.');
        throw sessionError;
      }
      return { role, home: ROLE_HOME[role] };
    },
    []
  );

  const signIn = useCallback<AuthContextType['signIn']>(
    async (email, password) => {
      const data = await postAuth<{ session: Session; role: UserRole }>(
        '/api/auth/sign-in',
        { email, password }
      );
      return adoptSession(data.session, data.role);
    },
    [postAuth, adoptSession]
  );

  const signUpStart = useCallback<AuthContextType['signUpStart']>(
    (input) =>
      postAuth('/api/auth/sign-up/start', {
        email: input.email,
        full_name: input.fullName,
        role: input.role,
      }),
    [postAuth]
  );

  const signUpComplete = useCallback<AuthContextType['signUpComplete']>(
    async (input) => {
      const data = await postAuth<{ session: Session; role: UserRole }>(
        '/api/auth/sign-up/complete',
        {
          email: input.email,
          code: input.code,
          password: input.password,
          password_confirm: input.passwordConfirm,
          full_name: input.fullName,
          role: input.role,
          phone: input.phone?.trim() || undefined,
        }
      );
      return adoptSession(data.session, data.role);
    },
    [postAuth, adoptSession]
  );

  const passwordResetStart = useCallback<AuthContextType['passwordResetStart']>(
    (email) => postAuth('/api/auth/password-reset/start', { email }),
    [postAuth]
  );

  const passwordResetComplete = useCallback<AuthContextType['passwordResetComplete']>(
    (input) =>
      postAuth('/api/auth/password-reset/complete', {
        email: input.email,
        code: input.code,
        password: input.password,
        password_confirm: input.passwordConfirm,
      }),
    [postAuth]
  );

  const signOut = useCallback(async () => {
    setLoading(true);
    try {
      if (session) {
        await fetch('/api/auth/sign-out', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}` },
        }).catch(() => undefined);
      }
      await supabase.auth.signOut();
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, [session]);

  const refreshProfile = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    setSession(data.session);
    await loadMe(data.session);
  }, [loadMe]);

  const value = useMemo<AuthContextType>(
    () => ({
      session,
      profile: me?.profile ?? null,
      role: me?.role ?? null,
      roleLabel: me?.roleLabel ?? null,
      capabilities: me?.capabilities ?? [],
      sections: me?.sections ?? [],
      customer: me?.customer ?? null,
      professional: me?.professional ?? null,
      loading,
      initialising,
      error,
      configError,
      requestOtp,
      verifyOtp,
      signIn,
      signUpStart,
      signUpComplete,
      passwordResetStart,
      passwordResetComplete,
      signOut,
      refreshProfile,
      hasCapability: (capability: Capability) => can(me?.role ?? null, capability),
    }),
    [
      session,
      me,
      loading,
      initialising,
      error,
      configError,
      requestOtp,
      verifyOtp,
      signIn,
      signUpStart,
      signUpComplete,
      passwordResetStart,
      passwordResetComplete,
      signOut,
      refreshProfile,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export { ROLE_HOME, CAPABILITIES };
