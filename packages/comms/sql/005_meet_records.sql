-- What a meeting kept (src/meet.rs): the captions people gave their own voices, as its transcript,
-- and its recordings through LiveKit Egress. Both belong to the meeting's LiveKit room.
create table comms_transcript (
  tenant_id uuid not null references tenant(id) on delete cascade,
  room text not null,
  speaker uuid not null,
  segment text not null,
  speaker_name text not null,
  text text not null,
  said_at timestamptz not null default now(),
  primary key (tenant_id, room, speaker, segment)
);
create index comms_transcript_said on comms_transcript (tenant_id, room, said_at);

create table comms_recording (
  tenant_id uuid not null references tenant(id) on delete cascade,
  id uuid not null,
  room text not null,
  egress_id text,
  status text not null,
  started_by uuid,
  started_at timestamptz not null default now(),
  stopped_by uuid,
  ended_at timestamptz,
  location text,
  error text,
  primary key (tenant_id, id)
);
-- One recording at a time for a meeting.
create unique index comms_recording_one on comms_recording (tenant_id, room) where ended_at is null;

alter table comms_transcript enable row level security;
alter table comms_transcript force row level security;
create policy tenant_isolation on comms_transcript
  using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));
alter table comms_recording enable row level security;
alter table comms_recording force row level security;
create policy tenant_isolation on comms_recording
  using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));
