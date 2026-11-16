-- A person's working hours and time away in Calendar (src/hours.rs): one JSON document per person
-- (days, hours, zone, out-of-office period, whether to decline and with what message). Bookkeeping,
-- not an entity: read and written through /api/app/comms/calendar/hours only.
create table if not exists comms_calendar_hours (
  tenant_id uuid not null references tenant(id) on delete cascade,
  person text not null,
  hours jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, person)
);

alter table comms_calendar_hours enable row level security;
alter table comms_calendar_hours force row level security;
create policy tenant_isolation on comms_calendar_hours
  using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));
