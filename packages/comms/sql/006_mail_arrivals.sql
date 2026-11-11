-- New mail known on the server (src/arrivals.rs): where each hosted mailbox was last looked at, the
-- notifications' targets, and the workspace's allowed and blocked senders. Bookkeeping, not
-- entities: never exposed through the generic API.

-- One row per hosted mailbox: the mail server's Email state last seen (null until the first look,
-- which notifies about nothing old), the person's Mail setting for notifications as read from their
-- Mail script (and that script's blob, read again only when it changes), and the back-off of a
-- mailbox that keeps failing. The state moves only by compare-and-set, in the transaction that
-- stores the notification.
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

-- Senders the whole workspace allows (never Spam) or blocks (always Spam): an address or a domain.
create table comms_mail_sender (
  tenant_id uuid not null references tenant(id) on delete cascade,
  sender text not null,
  kind text not null check (kind in ('allow', 'block')),
  added_by uuid,
  added_at timestamptz not null default now(),
  primary key (tenant_id, sender)
);

do $$
declare t text;
begin
  foreach t in array array['comms_mail_cursor', 'comms_mail_notice', 'comms_mail_sender'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system())) '
      'with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))', t);
  end loop;
end $$;
