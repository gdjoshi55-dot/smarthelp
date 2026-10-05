'use client';

import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import NotConfigured from '@/components/auth/NotConfigured';

/**
 * Renders the app, or the setup screen if Supabase is not reachable.
 *
 * This lives in the root layout so the message appears on every route at once.
 * A person who has not configured the project should not have to guess which
 * page they are on, or land on `/login` and be told their session failed.
 *
 * Until the auth boot finishes, `configError` is null and the page's own guard
 * renders its spinner, so there is nothing to do here but wait.
 */
export default function AppOrSetupMessage({ children }: { children: React.ReactNode }) {
  const { configError } = useAuth();

  if (configError) return <NotConfigured />;

  return <>{children}</>;
}
