-- Private bookkeeping of the comms package (not entities, so never exposed through the generic
-- API): announced reminders. Credentials live in secret fields and
-- attachments in the platform's file storage.

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
  foreach t in array array['comms_reminder_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system())) '
      'with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))', t);
  end loop;
end $$;
