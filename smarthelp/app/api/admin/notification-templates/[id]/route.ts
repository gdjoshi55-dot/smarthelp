import { ApiHttpError, handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { getTemplate, updateTemplate } from '@/lib/notificationServer';
import { createServerClient } from '@/lib/supabaseServer';
import { fail, optionalStr, readJson, requireCapability, uuid } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Reads a `string[]` out of an untrusted body, or `undefined` if absent. */
function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail({ [field]: 'Must be a list of token names' });
  }
  return value as string[];
}

/**
 * PUT /api/admin/notification-templates/:id — edit a template's copy (§25.10).
 *
 * `notification.manage` is the gate (D6): a template is what every customer in
 * the product reads, so it sits with the same class of change as a role grant.
 * Only the fields present are written — a partial save cannot blank the rest —
 * and `updated_by` is stamped from the caller, never passed.
 */
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  return handle(req, 'admin.notificationTemplates.update', async (requestId) => {
    const auth = await requireCapability(req, 'notification.manage');
    const id = uuid(params.id, 'id');
    const body = await readJson(req);

    const supabase = createServerClient();
    const before = await getTemplate(id, supabase);
    if (!before) {
      throw new ApiHttpError('NOT_FOUND', 'That template was not found.', 404);
    }

    const patch: Parameters<typeof updateTemplate>[1] = {};
    if (body.subject !== undefined) {
      patch.subject = optionalStr(body.subject, 'subject', { max: 200 });
    }
    if (body.body !== undefined) {
      patch.body = optionalStr(body.body, 'body', { max: 4000 }) ?? undefined;
    }
    if (body.variables !== undefined) {
      patch.variables = stringArray(body.variables, 'variables');
    }
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean') fail({ isActive: 'Must be true or false' });
      patch.isActive = body.isActive;
    }

    if (Object.keys(patch).length === 0) {
      fail({ template: 'Nothing to update' }, 'Nothing to update');
    }

    const updated = await updateTemplate(id, patch, auth.userId, supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'notification_template.update',
      entityType: 'notification_templates',
      entityId: id,
      metadata: {
        code: before.code,
        channel: before.channel,
        before: { subject: before.subject, body: before.body, is_active: before.is_active },
        after: {
          subject: updated?.subject,
          body: updated?.body,
          is_active: updated?.is_active,
        },
      },
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({ template: updated });
  });
}
