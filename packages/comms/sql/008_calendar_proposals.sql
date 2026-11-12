-- Another time a guest proposed for an event (src/proposals.rs): from Calendar or from a COUNTER that
-- came by mail (src/itip.rs). Seen by the event's organizer only, through /api/app/comms/calendar;
-- one per guest and occurrence (`occurrence` null for the whole event). Nothing moves until the
-- organizer accepts; accepting or declining removes it, and so does deleting the event.
create table if not exists comms_event_proposal (
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
create index if not exists comms_event_proposal_event on comms_event_proposal (tenant_id, event_id);
