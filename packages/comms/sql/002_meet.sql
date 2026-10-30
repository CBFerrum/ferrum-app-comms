-- Rooms people started to meet in now (src/meet.rs); meetings of channels and events need none.
-- Rooms nobody joined for 90 days are removed by the package's upkeep.
create table comms_meeting (
  tenant_id uuid not null references tenant(id) on delete cascade,
  id uuid not null,
  title text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  primary key (tenant_id, id)
);
create index comms_meeting_unused on comms_meeting (tenant_id, (coalesce(used_at, created_at)));

alter table comms_meeting enable row level security;
alter table comms_meeting force row level security;
create policy tenant_isolation on comms_meeting
  using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));
