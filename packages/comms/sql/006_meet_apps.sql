-- Meetings another app made for one of its records (src/meetings.rs): the record they belong to,
-- when they are held, and when they were ended. created_by is the host. Such a meeting is a room:
-- it is in nobody's calendar.
alter table comms_meeting add column if not exists source_entity text;
alter table comms_meeting add column if not exists source_id uuid;
alter table comms_meeting add column if not exists starts_at timestamptz;
alter table comms_meeting add column if not exists ends_at timestamptz;
alter table comms_meeting add column if not exists ended_at timestamptz;
-- One open meeting per record.
create unique index if not exists comms_meeting_source on comms_meeting (tenant_id, source_entity, source_id) where source_entity is not null and ended_at is null;

-- Who was in such a meeting, read from the meeting server while it ran: one row per joining
-- (identity), with when it joined (the server's own time) and when it was last seen in the room.
create table comms_attendance (
  tenant_id uuid not null,
  room_id uuid not null,
  identity text not null,
  user_id uuid,
  email text,
  name text not null,
  joined_at timestamptz not null,
  last_seen timestamptz not null,
  primary key (tenant_id, room_id, identity),
  foreign key (tenant_id, room_id) references comms_meeting (tenant_id, id) on delete cascade
);

alter table comms_attendance enable row level security;
alter table comms_attendance force row level security;
create policy tenant_isolation on comms_attendance
  using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));
