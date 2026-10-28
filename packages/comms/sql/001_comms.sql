-- Private bookkeeping of the comms package (not entities, so never exposed through the generic
-- API): newsletter deliveries and announced reminders. Credentials live in secret fields and
-- attachments in the platform's file storage.

-- One row per newsletter recipient, claimed before sending so nobody is mailed twice.
create table comms_newsletter_delivery (
  tenant_id uuid not null,
  newsletter_id uuid not null,
  email text not null,
  status text not null check (status in ('sending', 'sent', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unsubscribed_at timestamptz,
  primary key (tenant_id, newsletter_id, email),
  foreign key (tenant_id, newsletter_id) references e_newsletter (tenant_id, id) on delete cascade
);
create index comms_newsletter_delivery_recent on comms_newsletter_delivery (tenant_id, created_at);

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

do $$
declare t text;
begin
  foreach t in array array['comms_newsletter_delivery', 'comms_reminder_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system())) '
      'with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))', t);
  end loop;
end $$;
