import { readApiError, type ApiErrorCode } from './api';
import { authorizationHeader } from './sessionHeaders';

/**
 * The browser's half of the account-editing contract (§20.1, §25.3).
 *
 * `PUT /api/auth/me` is the only write a customer or professional has over their
 * own profile, and the allow-list is small on purpose: name, email, avatar and
 * locale. Role and status are not on it at the server either — the column grant
 * on `profiles` excludes them and `guard_profile_privileges()` rejects a change
 * even if the grant is ever widened — so this client cannot ask for them.
 *
 * ## The `Authorization` header
 *
 * Attached here once, for the reason `lib/sessionHeaders.ts` gives: the session
 * lives in `localStorage`, so an unauthenticated-looking 401 on a page the user
 * is visibly signed in to is the exact bug that module exists to prevent.
 */

export class ProfileApiError extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode | string,
    readonly status: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ProfileApiError';
  }

  get fields(): Record<string, string> | null {
    const fields = this.details?.fields;
    return fields && typeof fields === 'object' ? (fields as Record<string, string>) : null;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const auth = await authorizationHeader();

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...auth,
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ProfileApiError(
      'We could not reach SmartHelp. Check your connection and try again.',
      'NETWORK_ERROR',
      0
    );
  }

  if (!res.ok) {
    const { message, code, details } = await readApiError(res);
    throw new ProfileApiError(message, code, res.status, details);
  }

  const body = (await res.json()) as { data: T };
  return body.data;
}

/** The wire fields `validateUpdateMe` accepts. Phone changes need an OTP. */
export interface ProfilePatch {
  full_name?: string;
  email?: string;
  avatar_url?: string;
  locale?: string;
}

/**
 * Update the caller's own profile. Sends only the keys the form actually
 * changed, so an untouched field is never rewritten with a stale value.
 */
export function updateMe(patch: ProfilePatch): Promise<{ profile: unknown }> {
  return request<{ profile: unknown }>('/api/auth/me', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}
