import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, UserRole } from './supabase';

/**
 * The audit writer (§26.2, §24.13).
 *
 * Every privileged Route Handler leaves one row per state change. The insert
 * goes through the `write_audit()` SQL function, so it is the only path in and
 * the actor's role is stamped from the database rather than from the caller.
 *
 * What must never be written here: OTPs, passwords, tokens, payment secrets,
 * or a full ID number or bank credential. Pass the state that changed, not the
 * bytes you were handed.
 */

export interface AuditInput {
  actorProfileId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

const REDACTED_KEYS = new Set([
  'password',
  'code',
  'otp',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'secret',
  'api_key',
  'card',
  'cvv',
  'aadhaar_number',
  'pan_number',
  'account_number',
]);

/** Strips anything that must not reach the trail, recursively. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export async function audit(
  supabase: SupabaseClient<Database>,
  input: AuditInput
): Promise<void> {
  try {
    await supabase.rpc('write_audit', {
      p_actor_profile_id: input.actorProfileId,
      p_action: input.action,
      p_entity_type: input.entityType,
      p_entity_id: input.entityId ?? null,
      p_before_state: input.before ? (redact(input.before) as object) : null,
      p_after_state: input.after ? (redact(input.after) as object) : null,
      p_metadata: input.metadata ? (redact(input.metadata) as object) : null,
      p_ip_address: input.ipAddress ?? null,
      p_user_agent: input.userAgent ?? null,
      p_request_id: input.requestId ?? null,
    });
  } catch (e: any) {
    // An audit failure must not fail the business action, but it must be loud.
    console.error('audit write failed:', e?.message ?? e);
  }
}

export function clientIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.headers.get('x-real-ip');
}

export function roleName(role: UserRole | null | undefined): string {
  return role ?? 'anonymous';
}
