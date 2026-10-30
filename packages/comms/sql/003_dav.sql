-- The names calendar apps gave the events they created (src/dav.rs): an app finds its event under
-- the name it chose. Other events are `{id}.ics`.
create table comms_dav_name (
  tenant_id uuid not null references tenant(id) on delete cascade,
  event_id uuid not null,
  name text not null check (length(name) between 1 and 255),
  primary key (tenant_id, event_id),
  unique (tenant_id, name),
  foreign key (tenant_id, event_id) references e_calendar_event (tenant_id, id) on delete cascade
);

alter table comms_dav_name enable row level security;
alter table comms_dav_name force row level security;
create policy tenant_isolation on comms_dav_name
  using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));
