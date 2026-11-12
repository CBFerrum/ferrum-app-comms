-- Apps that take inbound mail (src/routes.rs) and what apps may file of a person's hosted mail
-- (src/arrivals.rs). Bookkeeping, not entities: never exposed through the generic API.

-- An address or pattern on a workspace domain, and the app whose handler takes mail sent to it. Two apps
-- never hold the same pattern (the unique key; overlapping ones are refused when registering).
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

-- Per hosted mailbox: whether its owner lets apps file their mail (nothing is filed until they say so), and
-- whether the workspace marked the mailbox private (never filed, whatever the owner says).
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
  foreach t in array array['comms_mail_route', 'comms_mail_filing'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system())) '
      'with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))', t);
  end loop;
end $$;
