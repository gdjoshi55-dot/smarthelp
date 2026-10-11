import { created, handle, ok, ApiHttpError } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import { requireProfessional } from '@/lib/professionalServer';
import { fail, optionalStr } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLUMNS = 'id, professional_id, starts_at, ends_at, reason';

/**
 * GET/POST/DELETE /api/professionals/me/time-off — the days you are not
 * available (§19.1).
 *
 * Every read and write is filtered by the caller's `professionals.id`, so a
 * professional can never read or delete another's time off. Overlapping time
 * off is refused by the route before the insert: `professional_time_off` (0005)
 * has only a `valid_range` check, so the overlap is the application's to
 * enforce, and it answers 409 rather than letting the person book a block that
 * a second block silently sits inside.
 */
export async function GET(req: Request) {
  return handle(req, 'professionals.time_off.list', async () => {
    const { professional } = await requireProfessional(req);
    const supabase = createServerClient();

    const { data, error } = await supabase
      .from('professional_time_off')
      .select(COLUMNS)
      .eq('professional_id', professional.id)
      .order('starts_at', { ascending: true });

    if (error) throw error;
    return ok({ timeOff: (data ?? []).map(toTimeOffView) });
  });
}

export async function POST(req: Request) {
  return handle(req, 'professionals.time_off.create', async () => {
    const { professional } = await requireProfessional(req);
    const supabase = createServerClient();

    const input = validateTimeOff(await readBody(req));

    // Half-open overlap: [startsAt, endsAt) against the existing blocks.
    const { data: clashes, error: clashError } = await supabase
      .from('professional_time_off')
      .select('id')
      .eq('professional_id', professional.id)
      .lt('starts_at', input.endsAt)
      .gt('ends_at', input.startsAt);
    if (clashError) throw clashError;

    if ((clashes ?? []).length > 0) {
      throw new ApiHttpError(
        'INVALID_STATE',
        'You already have time off that overlaps those dates.',
        409
      );
    }

    const { data, error } = await supabase
      .from('professional_time_off')
      .insert({
        professional_id: professional.id,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        reason: input.reason,
      })
      .select(COLUMNS)
      .single();
    if (error) rethrowDbError(error);

    return created({ timeOff: toTimeOffView(data) });
  });
}

export async function DELETE(req: Request) {
  return handle(req, 'professionals.time_off.delete', async () => {
    const { professional } = await requireProfessional(req);
    const supabase = createServerClient();

    const entryId = new URL(req.url).searchParams.get('entryId');
    if (!entryId) fail({ entryId: 'Which time off should be removed?' });

    // `.select()` on the delete returns the row only if the filters matched, so
    // a non-owner's id and a missing id are the same empty answer.
    const { data, error } = await supabase
      .from('professional_time_off')
      .delete()
      .eq('id', entryId)
      .eq('professional_id', professional.id)
      .select('id');
    if (error) throw error;

    if (!data || data.length === 0) {
      throw new ApiHttpError('NOT_FOUND', 'That time off was not found on your account.', 404);
    }
    return ok({ removed: true });
  });
}

interface TimeOffRow {
  id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
}

function toTimeOffView(row: TimeOffRow) {
  return {
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    reason: row.reason,
  };
}

function validateTimeOff(body: Record<string, unknown>) {
  const startsAt = isoInstant(body.startsAt ?? body.starts_at, 'startsAt');
  const endsAt = isoInstant(body.endsAt ?? body.ends_at, 'endsAt');
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    fail({ endsAt: 'The end must be after the start' });
  }
  return { startsAt, endsAt, reason: optionalStr(body.reason, 'reason', { max: 200 }) };
}

/** An ISO-8601 instant, normalised to UTC so two callers cannot disagree. */
function isoInstant(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail({ [field]: 'Pick a date and time' });
  }
  const parsed = new Date(value as string);
  if (Number.isNaN(parsed.getTime())) {
    fail({ [field]: 'Use a valid date and time' });
  }
  return parsed.toISOString();
}

function rethrowDbError(error: { message: string; code?: string }): never {
  if (error.code && error.code.startsWith('23')) {
    throw new ApiHttpError(
      'PROFESSIONAL_UNAVAILABLE',
      'That block of time off clashes with something already on your calendar.',
      422
    );
  }
  throw error;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
