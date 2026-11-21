-- Comms 0.35: who a meeting's host removed, refused a new pass until `until` (six hours). Kept by user id, or a
-- named guest's identity without its last part; purged by upkeep once it has ended.
create table if not exists comms_meeting_denied (
  tenant_id uuid not null references tenant(id) on delete cascade,
  room text not null,
  who text not null,
  until timestamptz not null,
  denied_by uuid,
  primary key (tenant_id, room, who)
);

do $$
begin
  alter table comms_meeting_denied enable row level security;
  alter table comms_meeting_denied force row level security;
  if not exists (select 1 from pg_policies where tablename = 'comms_meeting_denied' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on comms_meeting_denied using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
      with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));
  end if;
end $$;
