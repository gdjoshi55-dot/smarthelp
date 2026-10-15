import { handle, ok } from '@/lib/api';
import { listAuditLogs } from '@/lib/auditServer';
import { createServerClient } from '@/lib/supabaseServer';
import { fail, parsePaging, requireCapability, str, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/audit — the audit trail viewer (§20, §24.13, §31.1).
 *
 * `audit.read` gates it: the trail names actors and carries before/after state,
 * which is admin territory. Filters are a substring `action` (so `refund.`
 * catches the whole family), an `entity_type`/`entity_id` pair, an actor, and a
 * `created_at` window.
 */
export async function GET(req: Request) {
  return handle(req, 'admin.audit.list', async () => {
    await requireCapability(req, 'audit.read');
    const url = new URL(req.url);
    const { limit, offset } = parsePaging(url, 50, 200);

    const action = url.searchParams.get('action');
    const entityType = url.searchParams.get('entityType');
    const entityId = url.searchParams.get('entityId');
    const actor = url.searchParams.get('actorProfileId');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    const result = await listAuditLogs(
      {
        action: action ? str(action, 'action', { max: 80 }) : undefined,
        entityType: entityType ? str(entityType, 'entityType', { max: 80 }) : undefined,
        entityId: entityId ? str(entityId, 'entityId', { max: 120 }) : undefined,
        actorProfileId: actor ? uuid(actor, 'actorProfileId') : undefined,
        from: from ? isoInstant(from, 'from') : undefined,
        to: to ? isoInstant(to, 'to') : undefined,
        limit,
        offset,
      },
      createServerClient()
    );

    return ok(result);
  });
}

function isoInstant(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) fail({ [field]: 'Enter a valid date' });
  return new Date(parsed).toISOString();
}
