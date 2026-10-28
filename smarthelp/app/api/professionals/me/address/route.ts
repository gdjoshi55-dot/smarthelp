import { NextResponse } from 'next/server';
import { ApiHttpError, handle, ok } from '@/lib/api';
import { readJson, requireAuth, validateProfessionalAddress } from '@/lib/validation';
import { createServerClient } from '@/lib/supabaseServer';
import { audit, clientIp } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return handle(req, 'professionals.me.address', async () => {
    const auth = await requireAuth(req);
    if (auth.role !== 'professional') throw new ApiHttpError('FORBIDDEN', 'Only professionals can access this resource.', 403);

    const supabase = createServerClient();
    const { data, error } = await supabase
      .from('professionals')
      .select('address_line1,address_line2,address_area,address_city,address_state,address_pincode,address_lat,address_lng,address_updated_at')
      .eq('profile_id', auth.userId)
      .maybeSingle();

    if (error) throw error;
    return ok({ address: data ?? null });
  });
}

export async function PUT(req: Request) {
  return handle(req, 'professionals.me.address.update', async (requestId) => {
    const auth = await requireAuth(req);
    if (auth.role !== 'professional') throw new ApiHttpError('FORBIDDEN', 'Only professionals can access this resource.', 403);

    const body = await readJson(req);
    const patch = validateProfessionalAddress(body) as Record<string, unknown>;
    patch.address_updated_at = new Date().toISOString();

    const supabase = createServerClient();
    const { data: pro } = await supabase.from('professionals').select('id').eq('profile_id', auth.userId).maybeSingle();
    if (!pro?.id) throw new ApiHttpError('NOT_FOUND', 'Professional profile not found.', 404);

    const { data, error } = await supabase
      .from('professionals')
      .update(patch as any)
      .eq('id', pro.id)
      .select('address_line1,address_line2,address_area,address_city,address_state,address_pincode,address_lat,address_lng,address_updated_at')
      .maybeSingle();

    if (error) throw error;

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'professional.address.update',
      entityType: 'professionals',
      entityId: pro.id,
      before: null,
      after: patch as Record<string, unknown>,
      ipAddress: clientIp(req),
      userAgent: req.headers.get('user-agent'),
      requestId,
    });

    return ok({ address: data });
  });
}
