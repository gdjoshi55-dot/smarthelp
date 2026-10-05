'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Shown instead of the app when the browser cannot reach Supabase.
 *
 * This exists because the alternative was worse. A missing key used to throw
 * out of the `supabase` proxy during the auth boot, which the dev server
 * reports as an unhandled runtime error with a stack trace — technically
 * accurate, and useless to whoever is trying to start the project. A missing
 * `.env.local` is the single most common first-run problem, so it gets a screen
 * that says what to do.
 */
export default function NotConfigured() {
  const { configError } = useAuth();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-2xl">
        <div className="rounded-2xl border border-amber-200 bg-white p-8 shadow-sm">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-6 w-6 shrink-0 text-amber-500" aria-hidden="true" />
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-gray-900">
                SmartHelp is not connected to Supabase yet
              </h1>
              <p className="mt-1 text-sm text-gray-600">
                The app needs a Supabase project before it can sign anyone in.
              </p>
            </div>
          </div>

          {configError ? (
            <p className="mt-4 rounded-lg bg-gray-50 px-3 py-2 font-mono text-xs leading-relaxed text-gray-700 break-words">
              {configError}
            </p>
          ) : null}

          <ol className="mt-6 space-y-4 text-sm">
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-600">
                1
              </span>
              <div>
                <p className="font-medium text-gray-900">Create the environment file</p>
                <pre className="mt-1.5 overflow-x-auto rounded-lg bg-gray-900 px-3 py-2 text-xs text-gray-100">
                  cp .env.example .env.local
                </pre>
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-600">
                2
              </span>
              <div>
                <p className="font-medium text-gray-900">Fill in four values</p>
                <p className="mt-1 text-gray-600">
                  From your project&apos;s Settings → API:
                </p>
                <ul className="mt-2 space-y-1 font-mono text-xs text-gray-700">
                  <li>NEXT_PUBLIC_SUPABASE_URL</li>
                  <li>NEXT_PUBLIC_SUPABASE_ANON_KEY</li>
                  <li>SUPABASE_SERVICE_ROLE_KEY</li>
                  <li>SMARTHELP_OWNER_LOGIN</li>
                </ul>
                <p className="mt-2 text-xs text-gray-500">
                  <code className="font-mono">SUPABASE_SERVICE_ROLE_KEY</code> is server only —
                  never prefix it with <code className="font-mono">NEXT_PUBLIC_</code>.
                </p>
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-600">
                3
              </span>
              <div>
                <p className="font-medium text-gray-900">Apply the database</p>
                <p className="mt-1 text-gray-600">
                  Run the migrations in order, then the seed, and rebuild the schema snapshot.
                </p>
                <pre className="mt-1.5 overflow-x-auto rounded-lg bg-gray-900 px-3 py-2 text-xs text-gray-100">
                  supabase db reset{'\n'}npm run db:schema
                </pre>
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-600">
                4
              </span>
              <div>
                <p className="font-medium text-gray-900">Restart the dev server</p>
                <p className="mt-1 text-gray-600">
                  Environment variables are read at startup, so a running server keeps the old
                  values.
                </p>
              </div>
            </li>
          </ol>

          <p className="mt-6 border-t border-gray-100 pt-4 text-xs text-gray-500">
            Full instructions, including the demo accounts, are in{' '}
            <code className="font-mono">docs/SETUP.md</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
