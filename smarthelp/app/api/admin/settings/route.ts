import { handle, ok } from '@/lib/api';
import { audit, clientIp } from '@/lib/audit';
import { createServerClient } from '@/lib/supabaseServer';
import {
  PLATFORM_SETTING_KEYS,
  getPlatformSettings,
  setPlatformSetting,
  type PlatformSettingKey,
} from '@/lib/settingsServer';
import { fail, num, readJson, requireAuth, requireCapability, str } from '@/lib/validation';
import type { UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAFF: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

/**
 * GET /api/admin/settings — the resolved platform settings (§24.14, §31.1).
 *
 * Any staff member may read them (support needs `supportRefundLimit` to know
 * when a refund needs a second approver); the write below is admin-only.
 */
export async function GET(req: Request) {
  return handle(req, 'admin.settings.get', async () => {
    await requireAuth(req, [...STAFF]);
    const settings = await getPlatformSettings(createServerClient());
    return ok({ settings });
  });
}

/**
 * PUT /api/admin/settings — edits a subset of the settings (§22, §31.1, D4).
 *
 * `role.manage` is the gate: these are platform-wide numbers, the same class of
 * change as a role grant. Only the keys present in the body are written, each
 * validated against the type its entry in `PLATFORM_SETTING_KEYS` declares, so a
 * partial save cannot blank the rest. Every accepted key is written with one
 * `setPlatformSetting` call and the whole batch is audited as one event.
 */
export async function PUT(req: Request) {
  return handle(req, 'admin.settings.update', async (requestId) => {
    const auth = await requireCapability(req, 'role.manage');
    const body = await readJson(req);
    const supabase = createServerClient();

    const keys = Object.keys(body);
    if (keys.length === 0) fail({ settings: 'Nothing to update' }, 'Nothing to update');

    const before = await getPlatformSettings(supabase);
    const applied: string[] = [];
    const unknown: string[] = [];

    for (const key of keys) {
      if (!(key in PLATFORM_SETTING_KEYS)) {
        unknown.push(key);
        continue;
      }
      const settingKey = key as PlatformSettingKey;
      const declared = PLATFORM_SETTING_KEYS[settingKey];
      // Each key is written through the typed writer; the loop is dynamic, so
      // the value is narrowed here rather than at the call site. `never` is the
      // assertion that satisfies the per-key generic without widening to `any`.
      const value =
        declared === 'number'
          ? num(body[key], key, { min: 0 })
          : str(body[key], key, { min: 1, max: 200 });
      await setPlatformSetting(settingKey, value as never, auth.userId, supabase);
      applied.push(key);
    }

    if (applied.length === 0) {
      fail({ settings: `Unknown setting(s): ${unknown.join(', ')}` }, 'No recognised settings to update');
    }

    const after = await getPlatformSettings(supabase);

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'settings.update',
      entityType: 'platform_settings',
      metadata: {
        keys: applied,
        unknown,
        before: Object.fromEntries(applied.map((k) => [k, before[k as PlatformSettingKey]])),
        after: Object.fromEntries(applied.map((k) => [k, after[k as PlatformSettingKey]])),
      },
      ipAddress: clientIp(req),
      requestId,
    });

    return ok({ settings: after, updated: applied });
  });
}
