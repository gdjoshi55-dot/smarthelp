-- ============================================================
-- 0024_audit_idempotency.sql
-- SmartHelp: the append-only audit trail and the idempotency
-- ledger.
--
-- Placement note: the delivery plan places this migration in Phase 9,
-- but the Phase 0 auth routes are already privileged writes, and the
-- Definition of Done requires every privileged route to leave an
-- audit row. The two tables are self-contained — no Phase 1-8 table is
-- referenced — so the file is applied in Phase 0 and needs no edit in
-- the phase it was named for.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.13, §28.2, §26.2
-- ============================================================

-- ── Audit log ──────────────────────────────────────────────
-- Append only. No UPDATE, no DELETE, from anyone: the trigger refuses
-- them even for the service role, because an audit trail that can be
-- rewritten is not a trail.
create table if not exists public.audit_logs (
  id               uuid primary key default gen_random_uuid(),
  actor_profile_id uuid references public.profiles(id) on delete set null,
  actor_role       public.user_role,
  action           text not null,          -- 'booking.create', 'refund.execute', …
  entity_type      text not null,          -- 'bookings', 'payments', …
  entity_id        text,
  before_state     jsonb,
  after_state      jsonb,
  metadata         jsonb,
  ip_address       text,
  user_agent       text,
  request_id       text,
  created_at       timestamptz not null default now()
);

create index if not exists idx_audit_created on public.audit_logs (created_at desc);
create index if not exists idx_audit_entity  on public.audit_logs (entity_type, entity_id, created_at desc);
create index if not exists idx_audit_actor   on public.audit_logs (actor_profile_id, created_at desc);
create index if not exists idx_audit_action  on public.audit_logs (action, created_at desc);

create or replace function public.audit_logs_are_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'AUDIT_LOG_IMMUTABLE' using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists trg_audit_logs_immutable on public.audit_logs;
create trigger trg_audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function public.audit_logs_are_immutable();

-- The single writer. Every privileged Route Handler calls this; nothing
-- else may insert, so a stray client INSERT cannot forge a trail.
create or replace function public.write_audit(
  p_actor_profile_id uuid,
  p_action           text,
  p_entity_type      text,
  p_entity_id        text default null,
  p_before_state     jsonb default null,
  p_after_state      jsonb default null,
  p_metadata         jsonb default null,
  p_ip_address       text default null,
  p_user_agent       text default null,
  p_request_id       text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_role public.user_role;
begin
  select role into v_role from public.profiles where id = p_actor_profile_id;

  insert into public.audit_logs (
    actor_profile_id, actor_role, action, entity_type, entity_id,
    before_state, after_state, metadata, ip_address, user_agent, request_id
  ) values (
    p_actor_profile_id, v_role, p_action, p_entity_type, p_entity_id,
    p_before_state, p_after_state, p_metadata, p_ip_address, p_user_agent, p_request_id
  )
  returning id into v_id;

  return v_id;
end $$;

-- ── Idempotency ledger ─────────────────────────────────────
-- One row per (key, operation, caller). A replay of the same key with
-- the same body returns the stored response; a replay with a different
-- body is a conflict, because it means the client changed its mind
-- under a key it had already spent.
create table if not exists public.idempotency_keys (
  id             uuid primary key default gen_random_uuid(),
  key            text not null,
  operation      text not null,
  actor_profile_id uuid references public.profiles(id) on delete cascade,
  request_hash   text not null,          -- sha256 of the canonical body
  response_status int,
  response_body  jsonb,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  unique (key, operation, actor_profile_id)
);

create index if not exists idx_idempotency_created on public.idempotency_keys (created_at desc);

-- Claim a key, or return the already-stored response.
-- Returns: 'claimed' | 'replay' | 'in_flight' | 'conflict'
create or replace function public.claim_idempotency_key(
  p_key             text,
  p_operation       text,
  p_actor_profile_id uuid,
  p_request_hash    text
) returns table (
  outcome          text,
  stored_status    int,
  stored_body      jsonb
)
language plpgsql security definer set search_path = public as $$
declare
  r public.idempotency_keys;
begin
  select * into r
  from public.idempotency_keys
  where key = p_key and operation = p_operation and actor_profile_id = p_actor_profile_id;

  if not found then
    insert into public.idempotency_keys (key, operation, actor_profile_id, request_hash)
    values (p_key, p_operation, p_actor_profile_id, p_request_hash)
    on conflict do nothing;
    return query select 'claimed'::text, null::int, null::jsonb;
    return;
  end if;

  if r.request_hash <> p_request_hash then
    return query select 'conflict'::text, null::int, null::jsonb;
    return;
  end if;

  if r.completed_at is null then
    return query select 'in_flight'::text, null::int, null::jsonb;
    return;
  end if;

  return query select 'replay'::text, r.response_status, r.response_body;
end $$;

create or replace function public.complete_idempotency_key(
  p_key         text,
  p_operation   text,
  p_actor_profile_id uuid,
  p_status       int,
  p_body         jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.idempotency_keys
     set response_status = p_status,
         response_body   = p_body,
         completed_at    = now()
   where key = p_key and operation = p_operation and actor_profile_id = p_actor_profile_id;
end $$;

-- ── RLS ────────────────────────────────────────────────────
alter table public.audit_logs      enable row level security;
alter table public.idempotency_keys enable row level security;

-- Staff-readable, nobody-writable. The insert path is write_audit() only.
do $$ begin
  create policy audit_read_staff on public.audit_logs for select
    using (public.is_staff(array['admin','super_admin']::public.user_role[]));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy audit_no_write on public.audit_logs for insert with check (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy audit_no_update on public.audit_logs for update using (false);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy audit_no_delete on public.audit_logs for delete using (false);
exception when duplicate_object then null; end $$;

-- A caller sees only their own keys, and only while they are in flight.
do $$ begin
  create policy idempotency_select_own on public.idempotency_keys for select
    using (actor_profile_id = auth.uid() and completed_at is null);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy idempotency_claim_own on public.idempotency_keys for insert
    with check (actor_profile_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy idempotency_complete_own on public.idempotency_keys for update
    using (actor_profile_id = auth.uid())
    with check (actor_profile_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy idempotency_no_delete on public.idempotency_keys for delete using (false);
exception when duplicate_object then null; end $$;

-- Nobody writes directly. The only insert path is write_audit().
-- SELECT is retained for `authenticated` so that the RLS policies above are
-- the thing that actually decides visibility — revoking the table grant
-- instead would make every policy on it decorative.
revoke all on public.audit_logs from anon;
revoke insert, update, delete on public.audit_logs from authenticated;
grant select on public.audit_logs to authenticated;

revoke all on public.idempotency_keys from anon;
revoke delete on public.idempotency_keys from authenticated;
grant select, insert, update on public.idempotency_keys to authenticated;

-- The functions are security definer, so their bodies already run with the
-- owner's rights; the EXECUTE grant is what the *caller* needs. Default ACL
-- gives EXECUTE to PUBLIC, and revoking from PUBLIC also takes it away from
-- service_role — which would make every privileged route's RPC fail with
-- `permission denied for function`. Re-grant it explicitly, to service_role
-- only: the browser must never be able to write an audit row.
revoke all on function public.write_audit(uuid, text, text, text, jsonb, jsonb, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_idempotency_key(text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.complete_idempotency_key(text, text, uuid, int, jsonb) from public, anon, authenticated;

grant execute on function public.write_audit(uuid, text, text, text, jsonb, jsonb, jsonb, text, text, text) to service_role;
grant execute on function public.claim_idempotency_key(text, text, uuid, text) to service_role;
grant execute on function public.complete_idempotency_key(text, text, uuid, int, jsonb) to service_role;
