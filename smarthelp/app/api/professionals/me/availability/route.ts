import { ApiHttpError, handle, ok } from '@/lib/api';
import { createServerClient } from '@/lib/supabaseServer';
import { requireProfessional } from '@/lib/professionalServer';
import { fail } from '@/lib/validation';
import type { AvailabilityStatus } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLUMNS = 'id, availability_status, is_available_today';

/**
 * GET/POST /api/professionals/me/availability — the online toggle (§19.1,
 * Interaction Contract 4).
 *
 * The state lives on `professionals` and the server owns the flip: the browser
 * may only say "online" or "offline", never name a status, so `busy` and
 * `break` (which the matching engine sets) cannot be forged by a client. The
 * route is also the one place in the phase where the UI is optimistic — the
 * Switch moves first and this call decides whether it stays moved — so the
 * response echoes the stored values for the rollback.
 *
 * `guard_professional_privileges` (0005) admits an availability change for the
 * service role, which is how this route reaches the row.
 */
export async function GET(req: Request) {
  return handle(req, 'professionals.availability.get', async () => {
    const { professional } = await requireProfessional(req);
    return ok({
      availabilityStatus: professional.availability_status,
      isAvailableToday: professional.is_available_today,
    });
  });
}

export async function POST(req: Request) {
  return handle(req, 'professionals.availability.set', async () => {
    const { professional } = await requireProfessional(req);
    const supabase = createServerClient();

    const body = await readBody(req);
    if (typeof body.online !== 'boolean') {
      fail({ online: 'Say whether you are going online or offline' });
    }
    const online = body.online as boolean;

    const { data, error } = await supabase
      .from('professionals')
      .update({
        availability_status: (online ? 'online' : 'offline') as AvailabilityStatus,
        is_available_today: online,
      })
      .eq('id', professional.id)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw error;

    if (!data) {
      // The row existed a moment ago; a vanished row is not something to guess
      // about, so it is a 404 rather than a silent success.
      throw new ApiHttpError('NOT_FOUND', 'Professional not found', 404);
    }

    return ok({
      availabilityStatus: data.availability_status as AvailabilityStatus,
      isAvailableToday: data.is_available_today as boolean,
    });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
