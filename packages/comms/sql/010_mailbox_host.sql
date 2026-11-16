-- The host each hosted mailbox's kept password was set for (src/hosted.rs, `password_goes_to`): the password goes to
-- the mail server only while its address is on that host (any port). Recorded when a password is stored; a row from
-- before 0.22 has none until its first safe use. Bookkeeping, not an entity: never exposed through the generic API.
create table comms_mailbox_host (
  tenant_id uuid not null references tenant(id) on delete cascade,
  mailbox_id uuid not null,
  host text not null,
  recorded_at timestamptz not null default now(),
  primary key (tenant_id, mailbox_id)
);

alter table comms_mailbox_host enable row level security;
alter table comms_mailbox_host force row level security;
create policy tenant_isolation on comms_mailbox_host using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));
