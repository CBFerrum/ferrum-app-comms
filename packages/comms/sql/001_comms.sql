-- The comms package's own bookkeeping (not entities, so never exposed through the generic API), in one baseline:
-- announced reminders, meeting rooms and who was in them, what meetings kept, the names calendar apps gave events,
-- hosted mail's state, people's working hours, times guests proposed, and the apps that take or file mail. Credentials
-- live in secret fields and in Comms' vault, attachments in the platform's file storage. Every table holds workspaces'
-- rows and enforces row-level security (the loop at the end).

-- Reminders already announced: (event, occurrence, offset) fires once.
create table comms_reminder_log (
  tenant_id uuid not null,
  event_id uuid not null,
  occurrence_start timestamptz not null,
  minutes_before int not null,
  fired_at timestamptz not null default now(),
  primary key (tenant_id, event_id, occurrence_start, minutes_before),
  foreign key (tenant_id, event_id) references e_calendar_event (tenant_id, id) on delete cascade
);
create index comms_reminder_log_fired on comms_reminder_log (fired_at);

-- Rooms people started to meet in now (src/meet.rs); meetings of channels and events need none. A room's guest link
-- keeps its key sealed (src/keys.rs), or none while the link is off: a new link replaces it, so the old one stops
-- working. Meetings another app made for one of its records (src/meetings.rs) are rooms too, in nobody's calendar: the
-- record they belong to, when they are held and when they were ended; created_by is the host. Rooms nobody joined for 90
-- days are removed by the package's upkeep.
create table comms_meeting (
  tenant_id uuid not null references tenant(id) on delete cascade,
  id uuid not null,
  title text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  guest_key text,
  source_entity text,
  source_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  ended_at timestamptz,
  primary key (tenant_id, id)
);
create index comms_meeting_unused on comms_meeting (tenant_id, (coalesce(used_at, created_at)));
-- One open meeting per record.
create unique index comms_meeting_source on comms_meeting (tenant_id, source_entity, source_id) where source_entity is not null and ended_at is null;

-- Who was in a meeting another app made, read from the meeting server while it ran: one row per joining (identity),
-- with when it joined (the server's own time) and when it was last seen in the room.
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

-- What a meeting kept (src/meet.rs): the captions people gave their own voices, as its transcript, and its recordings
-- through LiveKit Egress. Both belong to the meeting's LiveKit room.
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

-- The names calendar apps gave the events they created (src/dav.rs): an app finds its event under the name it chose.
-- Other events are `{id}.ics`.
create table comms_dav_name (
  tenant_id uuid not null references tenant(id) on delete cascade,
  event_id uuid not null,
  name text not null check (length(name) between 1 and 255),
  primary key (tenant_id, event_id),
  unique (tenant_id, name),
  foreign key (tenant_id, event_id) references e_calendar_event (tenant_id, id) on delete cascade
);

-- A person's working hours and time away in Calendar (src/hours.rs): one JSON document per person (days, hours, zone,
-- out-of-office period, whether to decline and with what message), read and written through
-- /api/app/comms/calendar/hours only.
create table comms_calendar_hours (
  tenant_id uuid not null references tenant(id) on delete cascade,
  person text not null,
  hours jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, person)
);

-- Another time a guest proposed for an event (src/proposals.rs): from Calendar or from a COUNTER that came by mail
-- (src/itip.rs). Seen by the event's organizer only, through /api/app/comms/calendar; one per guest and occurrence
-- (`occurrence` null for the whole event). Nothing moves until the organizer accepts; accepting or declining removes it,
-- and so does deleting the event.
create table comms_event_proposal (
  tenant_id uuid not null references tenant(id) on delete cascade,
  id uuid not null,
  event_id uuid not null,
  email text not null,
  guest_name text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  occurrence timestamptz,
  note text,
  by_mail boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index comms_event_proposal_event on comms_event_proposal (tenant_id, event_id);

-- New mail known on the server (src/arrivals.rs). One row per hosted mailbox: the mail server's Email state last seen
-- (null until the first look, which notifies about nothing old), the person's Mail setting for notifications as read
-- from their Mail script (and that script's blob, read again only when it changes), and the back-off of a mailbox that
-- keeps failing. The state moves only by compare-and-set, in the transaction that stores the notification.
create table comms_mail_cursor (
  tenant_id uuid not null references tenant(id) on delete cascade,
  mailbox_id uuid not null,
  account_id text not null,
  email_state text,
  notify text not null default 'all' check (notify in ('all', 'people', 'none')),
  script_blob text,
  failures int not null default 0,
  retry_at timestamptz,
  checked_at timestamptz,
  primary key (tenant_id, mailbox_id)
);

-- What a new-mail notification opens (`/open/MailMessage/{id}`): one message, or the Inbox.
create table comms_mail_notice (
  tenant_id uuid not null references tenant(id) on delete cascade,
  id uuid not null,
  user_id uuid not null,
  account_id text not null,
  email_id text,
  folder text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index comms_mail_notice_created on comms_mail_notice (created_at);

-- When each workspace's hosted mailboxes are next brought in step (src/hosted.rs): ten minutes after the last time,
-- and at the next round of upkeep, whichever replica runs it, once a change asks for it (`soon`).
create table comms_mail_sync (
  tenant_id uuid primary key references tenant(id) on delete cascade,
  due_at timestamptz not null default now()
);

-- Senders the whole workspace allows (never Spam) or blocks (always Spam): an address or a domain.
create table comms_mail_sender (
  tenant_id uuid not null references tenant(id) on delete cascade,
  sender text not null,
  kind text not null check (kind in ('allow', 'block')),
  added_by uuid,
  added_at timestamptz not null default now(),
  primary key (tenant_id, sender)
);

-- An address or pattern on a workspace domain, and the app whose handler takes mail sent to it (src/routes.rs). Two
-- apps never hold the same pattern (the unique key; overlapping ones are refused when registering).
create table comms_mail_route (
  tenant_id uuid not null references tenant(id) on delete cascade,
  id uuid not null,
  app text not null,
  pattern text not null,
  keep_in_mailbox boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, pattern)
);

-- Per hosted mailbox (src/arrivals.rs): whether its owner lets apps file their mail (nothing is filed until they say
-- so), and whether the workspace marked the mailbox private (never filed, whatever the owner says).
create table comms_mail_filing (
  tenant_id uuid not null references tenant(id) on delete cascade,
  mailbox_id uuid not null,
  apps_may_file boolean not null default false,
  private boolean not null default false,
  changed_at timestamptz not null default now(),
  primary key (tenant_id, mailbox_id)
);

do $$
declare t text;
begin
  foreach t in array array['comms_reminder_log', 'comms_meeting', 'comms_attendance', 'comms_transcript', 'comms_recording', 'comms_dav_name',
                           'comms_calendar_hours', 'comms_event_proposal', 'comms_mail_cursor', 'comms_mail_notice', 'comms_mail_sync',
                           'comms_mail_sender', 'comms_mail_route', 'comms_mail_filing'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system())) '
      'with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))', t);
  end loop;
end $$;
