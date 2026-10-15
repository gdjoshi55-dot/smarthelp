import { readApiError, type ApiErrorCode } from './api';
import { authorizationHeader } from './sessionHeaders';

/**
 * The browser's half of the favourites contract (§25.4).
 *
 * Two audiences share this: the `/customer/favourites` screen and the heart on a
 * service or a professional. Both need the same three calls and the same
 * idempotent add, so both import here rather than re-deriving the wire shape.
 */

export class FavouriteApiError extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode | string,
    readonly status: number,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'FavouriteApiError';
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
    throw new FavouriteApiError(
      'We could not reach SmartHelp. Check your connection and try again.',
      'NETWORK_ERROR',
      0
    );
  }

  if (!res.ok) {
    const { message, code, details } = await readApiError(res);
    throw new FavouriteApiError(message, code, res.status, details);
  }

  const body = (await res.json()) as { data: T };
  return body.data;
}

export type FavouriteTargetType = 'service' | 'professional';

export interface FavouriteItem {
  id: string;
  targetType: FavouriteTargetType;
  targetId: string;
  createdAt: string;
  service?: {
    id: string;
    name: string;
    slug: string;
    shortDescription: string | null;
    basePrice: number;
    imageUrl: string | null;
    isActive: boolean;
  };
  professional?: {
    id: string;
    name: string | null;
    rating: number | null;
    ratingCount: number;
    verificationStatus: string;
  };
}

export function fetchFavourites(signal?: AbortSignal): Promise<{ favourites: FavouriteItem[] }> {
  return request<{ favourites: FavouriteItem[] }>(
    '/api/favourites',
    signal ? { signal } : undefined
  );
}

export function addFavourite(
  targetType: FavouriteTargetType,
  targetId: string
): Promise<{ favourite: unknown; alreadySaved: boolean }> {
  return request('/api/favourites', {
    method: 'POST',
    body: JSON.stringify({ targetType, targetId }),
  });
}

export function removeFavourite(
  targetType: FavouriteTargetType,
  targetId: string
): Promise<{ removed: number }> {
  return request(
    `/api/favourites/${encodeURIComponent(targetType)}/${encodeURIComponent(targetId)}`,
    { method: 'DELETE' }
  );
}
