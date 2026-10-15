import { ApiHttpError } from './api';

/**
 * The one cron guard (§25.11, D5).
 *
 * Every `/api/cron/*` Route Handler funnels its authentication through here, so
 * "the guard fails closed" is a property of one function rather than of a route
 * a future contributor might copy without the `!cronSecret` branch.
 *
 * It **fails closed** — a deliberate deviation from the reference guard, which
 * is `if (cronSecret) { … }` and therefore skips the check when the variable is
 * unset. The reference pattern is only safe when every deployment sets the
 * variable; an unauthenticated pass that *writes* rows (a reconciliation, a
 * reminder) is exactly the thing that must not run on a misconfigured deploy.
 * So an unset `CRON_SECRET` is a `503`, and the three accepted channels mirror
 * the reference in precedence: `Authorization: Bearer`, then `x-cron-secret`,
 * then `?secret=`.
 *
 * Returns normally when the caller is the scheduler; throws `ApiHttpError`
 * otherwise, which `handle()` turns into the right response.
 */
export function assertCronSecret(req: Request): void {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    throw new ApiHttpError(
      'SERVICE_UNAVAILABLE',
      'CRON_SECRET is not set. The cron will not run without it.',
      503
    );
  }
  const provided =
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    req.headers.get('x-cron-secret') ||
    new URL(req.url).searchParams.get('secret') ||
    '';
  if (provided !== cronSecret) {
    throw new ApiHttpError('UNAUTHENTICATED', 'The provided cron secret does not match.', 401);
  }
}
