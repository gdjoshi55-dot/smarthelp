import { createServerClient } from './supabaseServer';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditLog, Database, UserRole } from './supabase';

/**
 * The audit viewer's read model (§20, §24.13, §26.2).
 *
 * `audit_logs` is append-only and written only through `write_audit`; this
 * module is the one place the console reads it. The list is a projection: the
 * `before_state`/`after_state`/`metadata` blobs are carried through untouched
 * (they were redacted on the way in), so the viewer can show exactly what was
 * recorded without a second round-trip.
 */

type ServerClient = SupabaseClient<Database>;

export interface AdminAuditLogItem {
  id: string;
  actorProfileId: string | null;
  actorName: string | null;
  actorRole: UserRole | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: object | null;
  after: object | null;
  metadata: object | null;
  ipAddress: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface AdminAuditFilters {
  /** Action substring, e.g. `refund.` catches the whole family. */
  action?: string;
  entityType?: string;
  entityId?: string;
  actorProfileId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function listAuditLogs(
  filters: AdminAuditFilters = {},
  supabase: ServerClient = createServerClient()
): Promise<{ logs: AdminAuditLogItem[]; total: number }> {
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  let query = supabase.from('audit_logs').select('*', { count: 'exact' });
  if (filters.action) query = query.ilike('action', `%${filters.action}%`);
  if (filters.entityType) query = query.eq('entity_type', filters.entityType);
  if (filters.entityId) query = query.eq('entity_id', filters.entityId);
  if (filters.actorProfileId) query = query.eq('actor_profile_id', filters.actorProfileId);
  if (filters.from) query = query.gte('created_at', filters.from);
  if (filters.to) query = query.lte('created_at', filters.to);

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const rows = (data ?? []) as AuditLog[];
  if (rows.length === 0) return { logs: [], total: count ?? 0 };

  const actorIds = [...new Set(rows.map((r) => r.actor_profile_id).filter((v): v is string => !!v))];
  const names: Record<string, string> = {};
  if (actorIds.length > 0) {
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', actorIds);
    if (profilesError) throw profilesError;
    for (const p of profiles ?? []) names[p.id] = p.full_name;
  }

  return {
    logs: rows.map((r) => ({
      id: r.id,
      actorProfileId: r.actor_profile_id,
      actorName: r.actor_profile_id ? names[r.actor_profile_id] ?? null : null,
      actorRole: r.actor_role,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      before: r.before_state,
      after: r.after_state,
      metadata: r.metadata,
      ipAddress: r.ip_address,
      requestId: r.request_id,
      createdAt: r.created_at,
    })),
    total: count ?? rows.length,
  };
}
