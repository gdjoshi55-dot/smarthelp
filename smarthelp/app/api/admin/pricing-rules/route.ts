import { ApiHttpError, created, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { createPricingRule, listPricingRules, PRICING_RULE_SCOPES } from '@/lib/policyServer';
import { createServerClient } from '@/lib/supabaseServer';
import { fail, int, num, oneOf, requireAuth, requireCapability, str, uuid } from '@/lib/validation';
import type { UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

/**
 * GET/POST /api/admin/pricing-rules — the §7.1 surge-window editor (§24, §31.1).
 *
 * Reads are staff-wide (the 0035 policies say the same); every write needs
 * `pricing.manage`, which only admin and super_admin hold. A rule's scope
 * determines which target column carries the id; the validator enforces the
 * pairing the table's `pricing_rule_scope_target` constraint would otherwise
 * reject one level deeper.
 */
export async function GET(req: Request) {
  return handle(req, 'admin.pricing_rules.list', async () => {
    await requireAuth(req, [...STAFF]);
    const rules = await listPricingRules(createServerClient());
    return ok({ rules });
  });
}

export async function POST(req: Request) {
  return handle(req, 'admin.pricing_rules.create', async (requestId) => {
    const auth = await requireCapability(req, 'pricing.manage');
    const body = await readBody(req);
    const input = validatePricingRuleInput(body);

    const supabase = createServerClient();
    const rule = await createPricingRule(input, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'pricing_rule.create',
      entityType: 'pricing_rules',
      entityId: rule.id,
      after: { name: rule.name, scope: rule.scope, multiplier: rule.multiplier, priority: rule.priority },
      metadata: { input: pricingRuleMeta(input) },
      ipAddress: clientIp(req),
      requestId,
    });

    return created({ rule });
  });
}

function pricingRuleMeta(input: ReturnType<typeof validatePricingRuleInput>) {
  return {
    name: input.name,
    scope: input.scope,
    categoryId: input.categoryId ?? null,
    serviceId: input.serviceId ?? null,
    multiplier: input.multiplier,
    daysOfWeek: input.daysOfWeek ?? [],
    startMinute: input.startMinute ?? null,
    endMinute: input.endMinute ?? null,
    priority: input.priority ?? 0,
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    isActive: input.isActive ?? true,
  };
}

export function validatePricingRuleInput(body: Record<string, unknown>) {
  const name = str(body.name, 'name', { min: 1, max: 80 });
  const scope = oneOf(body.scope, 'scope', PRICING_RULE_SCOPES);
  const multiplier = num(body.multiplier, 'multiplier', { min: 0.01, max: 100 });

  let categoryId: string | null = null;
  let serviceId: string | null = null;
  if (scope === 'category') {
    categoryId = uuid(body.categoryId, 'categoryId');
  } else if (scope === 'service') {
    serviceId = uuid(body.serviceId, 'serviceId');
  }

  const daysOfWeek = optionalDaysOfWeek(body.daysOfWeek);
  const startMinute = optionalMinute(body.startMinute, 'startMinute');
  const endMinute = optionalMinute(body.endMinute, 'endMinute');
  if (startMinute !== null && endMinute !== null && startMinute === endMinute) {
    fail({ endMinute: 'A window cannot start and end at the same minute.' });
  }

  return {
    name,
    scope,
    categoryId,
    serviceId,
    multiplier,
    daysOfWeek,
    startMinute,
    endMinute,
    priority: body.priority === undefined ? 0 : int(body.priority, 'priority', { min: -1000, max: 1000 }),
    validFrom: body.validFrom === undefined || body.validFrom === null ? null : isoInstant(body.validFrom, 'validFrom'),
    validTo: body.validTo === undefined || body.validTo === null ? null : isoInstant(body.validTo, 'validTo'),
    isActive: body.isActive === undefined ? true : body.isActive === true,
  };
}

function optionalDaysOfWeek(value: unknown): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail({ daysOfWeek: 'Pick days of the week' });
  const out: number[] = [];
  for (const d of value) {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 0 || n > 6) fail({ daysOfWeek: 'Days run 0 (Sunday) to 6 (Saturday)' });
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function optionalMinute(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 1439) fail({ [field]: 'Must be a minute of the day (0–1439)' });
  return n;
}

function isoInstant(value: unknown, field: string): string {
  const s = str(value, field, { max: 40 });
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) fail({ [field]: 'Enter a valid date' });
  return new Date(parsed).toISOString();
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new ApiHttpError('VALIDATION_ERROR', 'A JSON body is required.', 400);
  }
}