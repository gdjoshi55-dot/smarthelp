import { ApiHttpError, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { deletePricingRule, updatePricingRule } from '@/lib/policyServer';
import { createServerClient } from '@/lib/supabaseServer';
import { requireCapability, uuid } from '@/lib/validation';
import { validatePricingRuleInput } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH/DELETE /api/admin/pricing-rules/:id (§24, §31.1).
 *
 * The console edits a whole rule at a time, so PATCH carries the same validated
 * shape as POST and replaces it. Both paths check existence first — the D3
 * decision means a missing id is a 404 with no write.
 */
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.pricing_rules.update', async (requestId) => {
    const auth = await requireCapability(req, 'pricing.manage');
    const id = uuid(params.id, 'id');
    const body = await readBody(req);

    const supabase = createServerClient();
    const before = await loadRule(id, supabase);
    const input = validatePricingRuleInput(body);
    const rule = await updatePricingRule(id, input, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'pricing_rule.update',
      entityType: 'pricing_rules',
      entityId: id,
      before: { name: before.name, scope: before.scope, multiplier: before.multiplier, is_active: before.is_active },
      after: { name: rule.name, scope: rule.scope, multiplier: rule.multiplier, is_active: rule.is_active },
      metadata: { input },
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({ rule });
  });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.pricing_rules.delete', async (requestId) => {
    const auth = await requireCapability(req, 'pricing.manage');
    const id = uuid(params.id, 'id');

    const supabase = createServerClient();
    const before = await loadRule(id, supabase);
    await deletePricingRule(id, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'pricing_rule.delete',
      entityType: 'pricing_rules',
      entityId: id,
      before: { name: before.name, scope: before.scope },
      metadata: { id },
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({ deleted: true });
  });
}

async function loadRule(
  id: string,
  supabase: ReturnType<typeof createServerClient>
): Promise<{ name: string; scope: string; multiplier: unknown; is_active: boolean }> {
  const { data, error } = await supabase
    .from('pricing_rules')
    .select('name, scope, multiplier, is_active')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new ApiHttpError('NOT_FOUND', 'That pricing rule was not found.', 404);
  }
  return data;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new ApiHttpError('VALIDATION_ERROR', 'A JSON body is required.', 400);
  }
}