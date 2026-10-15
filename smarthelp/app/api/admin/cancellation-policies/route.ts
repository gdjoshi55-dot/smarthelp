import { ApiHttpError, created, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import {
  createCancellationPolicy,
  listCancellationPolicies,
} from '@/lib/policyServer';
import { createServerClient } from '@/lib/supabaseServer';
import { fail, int, num, oneOf, optionalStr, requireAuth, requireCapability, str, uuid } from '@/lib/validation';
import type { UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

const FEE_TYPES = ['free', 'percentage', 'fixed'] as const;

/**
 * GET/POST /api/admin/cancellation-policies — the §11.1 ladder editor (§24, §31.1).
 *
 * Like pricing rules: staff read, `pricing.manage` writes. `hours_before` is
 * the band *ceiling*, kept that way here so the console and
 * `quoteCancellation` can never disagree about which band a request falls in.
 */
export async function GET(req: Request) {
  return handle(req, 'admin.cancellation_policies.list', async () => {
    await requireAuth(req, [...STAFF]);
    const policies = await listCancellationPolicies(createServerClient());
    return ok({ policies });
  });
}

export async function POST(req: Request) {
  return handle(req, 'admin.cancellation_policies.create', async (requestId) => {
    const auth = await requireCapability(req, 'pricing.manage');
    const body = await readBody(req);
    const input = validateCancellationPolicyInput(body);

    const supabase = createServerClient();
    const policy = await createCancellationPolicy(input, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'cancellation_policy.create',
      entityType: 'cancellation_policies',
      entityId: policy.id,
      after: { fee_type: policy.fee_type, fee_value: policy.fee_value, band: policy.band },
      metadata: { input },
      ipAddress: clientIp(req),
      requestId,
    });

    return created({ policy });
  });
}

export function validateCancellationPolicyInput(body: Record<string, unknown>) {
  const feeType = oneOf(body.feeType, 'feeType', FEE_TYPES);
  const feeValue = num(body.feeValue ?? 0, 'feeValue', {
    min: 0,
    ...(feeType === 'percentage' ? { max: 100 } : {}),
  });
  const hoursBefore = body.hoursBefore === undefined || body.hoursBefore === null
    ? null
    : num(body.hoursBefore, 'hoursBefore', { min: 0 });
  const serviceId = body.serviceId === undefined || body.serviceId === null
    ? null
    : uuid(body.serviceId, 'serviceId');
  const appliesWhenArrived = body.appliesWhenArrived === true;

  if (appliesWhenArrived && hoursBefore !== null) {
    fail({ hoursBefore: 'The arrival band has no hour ceiling; clear this first.' });
  }
  if (feeType === 'free' && (feeValue !== 0)) {
    fail({ feeValue: 'A free band charges nothing.' });
  }

  return {
    serviceId,
    hoursBefore,
    feeType,
    feeValue,
    appliesWhenArrived,
    band: optionalStr(body.band, 'band', { max: 40 }),
    sortOrder: body.sortOrder === undefined ? 0 : int(body.sortOrder, 'sortOrder', { min: -10_000, max: 10_000 }),
    isActive: body.isActive === undefined ? true : body.isActive === true,
  };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new ApiHttpError('VALIDATION_ERROR', 'A JSON body is required.', 400);
  }
}