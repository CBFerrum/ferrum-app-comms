# comms — mail, team chat and calendar

Package `comms` (depends on `core`, logic in `crates/pkg-comms`): email accounts (SMTP sending,
IMAP polling, inbound webhook), a threaded **Communication** log on any record, email templates,
mailing lists and newsletters, team chat with live pushes, and calendars with recurrence,
reminders, free/busy, RSVP and iCalendar (invitations, feeds, import).

Times are RFC 3339 UTC with milliseconds (`2026-11-02T09:00:00.000Z`). Errors use the usual API
shape (`{"error", "message", "fields"?}`): `not_found` (404), `forbidden` (403), `invalid` /
`validation_failed` (422), `conflict` (409).

## Roles

| Role | Can |
|---|---|
| Comms User | send mail and log calls/notes on records they can read, see the timelines of those records (their own communications also through the generic API), use chat, keep a calendar (own events; events they are invited to are readable) |
| Comms Manager | email accounts (incl. setting passwords), templates, email groups and members, newsletters, every communication, Communication Settings |
| Chat Admin | every chat channel and message through the generic API (moderation) |

Administrators can do everything. People use chat and calendars through the endpoints below;
the generic API on `ChatChannel`/`ChatMessage` is for chat administrators only.

## Setup

1. **Communication Settings** (`CommsSettings`): `public_url` (e.g. `https://erp.example.com`) —
   needed for unsubscribe links, the inbound webhook URL and calendar feed URLs;
   `newsletter_hourly_limit` (default 500); `max_send_attempts` (default 5).
2. **Email Account**: SMTP (`smtp_security`: `STARTTLS` | `TLS` | `None`) and/or IMAP
   (`imap_security`: `TLS` | `STARTTLS` | `None`, `imap_folder`, `poll_interval_minutes`).
   `smtp_password` / `imap_password` are **secret fields** (the server needs `FERRUM_SECRET_KEY`):
   send text to set one, `null` to clear it, `true` to keep it; reads only return `true` when one is
   set. The values are sealed outside the record and never reach documents, lists, events, the
   audit trail or exports. One `default_outgoing` account per
   company plus one shared (company empty). `append_to` + `append_to_mapping`
   (`{"target_field": "subject" | "sender" | "sender_name" | "content" | "text_content" | "received_at" | "account"}`)
   make a new inbound thread create a record (e.g. a Lead or Ticket); without a mapping common
   field names are filled. Auto-replies and bounces never create records.
3. Action `POST /api/v1/EmailAccount/{id}/actions/rotate_inbound_token` →
   `{token, path, url, note}`: the secret inbound webhook URL (`token` is `{account}.{secret}`, the
   secret kept in the account's `inbound_token` secret field), **shown once**; a new one retires
   the previous one.

Mail without an account (no default for the company and no shared default) goes through the
server's own mailer, one simple HTML message per recipient (no threading headers, attachments or
invitations).

## Signed-in endpoints — `/api/app/comms/...`

Bearer auth as everywhere; the caller needs one of the roles above.

### Mail and the communication log

| Method & path | Body / query → response |
|---|---|
| `GET /accounts` | → `{accounts: [{id, account_name, email_address, display_name, company, default_outgoing}]}` — accounts the caller may send from |
| `POST /send` | `{to, cc?, bcc?, subject?, content?, text_content?, template?, reference_entity?, reference_id?, reply_to?, email_account?, attachments?: [{id}], channel?, direction?, communication_date?}` → `201` Communication. `to`/`cc`/`bcc`: a string (`a@x.test, "Rao, Priya" <p@x.test>`) or a list. `template`: id or name; fills a missing subject/content from the referenced record. `reply_to`: a communication id — threads the mail (In-Reply-To/References, `Re:` subject, same record). `channel` defaults to `Email` (others: `SMS`, `Chat`, `Phone`, `Note`, `Meeting` — logged, not sent). The caller must be able to read the referenced record. Email is queued and sent right after the request |
| `POST /templates/preview` | `{template?: id \| name, subject?, body?, reference_entity?, reference_id?}` → `{subject, html}`. Values are HTML-escaped; missing fields render empty |
| `GET /communications` | `reference_entity` + `reference_id` (a record's timeline; needs read access to it), or `mine=1` (what I sent/logged); managers may filter by `email_account`, `direction`, `status`, `channel`, `thread_key` without a record. `limit` (≤ 100, default 50), `cursor` → `{communications: [Communication], next_cursor}` newest first |
| `GET /communications/{id}` | → Communication (with `text_content`, `in_reply_to`, `mail_references`) |
| `POST /communications/{id}/seen` | `{seen?: true}` → `{id, seen}` |
| `POST /communications/{id}/retry` | → `{status: "Queued"}` — a `Failed` email, by its author or a manager |
| `GET /attachments/{id}` | → the file (`Content-Disposition: attachment`) for whoever may see the message it belongs to: chat files by channel membership, mail files by the record's (or the communication's) access rules, unattached uploads by their uploader |

**Attachments** are the platform's files: upload with `POST /api/files` (multipart, up to 25 MB;
pass `entity` + `record_id` of the record you mail from, or nothing) and list `{id}`s in
`attachments` — files you uploaded, or files attached to records you can read; 20 per message, 25 MB
together. A mail's files that were attached to nothing join its record (or the communication when
it has none), received mail's files likewise, so they appear in the record's Attachments list and
download through `/files/{id}` with the record's access checks — or through
`GET /api/app/comms/attachments/{id}`, which also applies the mail and chat visibility rules.

**Communication** (as returned here): every field of the entity — `id, channel, direction,
status` (`Queued` → `Sending` → `Sent` | `Failed`; `Received`), `communication_date, email_account,
sender, sender_name, recipients, cc, bcc` (only for its author and managers), `subject,
text_content, attachments: [{id, file_name, content_type, size, url}], reference_entity, reference_id,
reply_to, message_id, in_reply_to, mail_references, thread_key, seen, attempts, sent_at, error,
created_by, created_at` — plus **`content_html`**: the HTML **sanitized for display** (scripts,
event handlers, forms and dangerous URLs removed; a safe subset of inline styles kept). Never
render `content` from the generic API as HTML; render `content_html`, ideally inside a sandboxed
`<iframe sandbox>`. Group a conversation by `thread_key`.

Sending: retries back off 1, 4, 16, 64 minutes … (at most 6 h) until `max_send_attempts`;
SMTP 5xx replies and invalid addresses fail at once. The author gets a bell notification when an
email fails, and a live push (below) on every status change.

### Chat — `/api/app/comms/chat/...`

Private and direct channels, and their messages, do not exist for non-members: every endpoint
answers 404. Public channels can be read by all chat users and joined; posting needs membership.

| Method & path | Body / query → response |
|---|---|
| `GET /chat/channels` | `include=public` also lists public channels I can join → `{channels: [ChannelSummary]}` (mine first, by last activity) |
| `POST /chat/channels` | `{name, type: "Public" \| "Private", topic?, members?: [emails]}` → `201` Channel (I am its Owner). Names are unique (`409`) |
| `POST /chat/direct` | `{user: email}` → Channel: the one direct conversation of the pair, created on first use |
| `GET /chat/channels/{id}` | → Channel |
| `PATCH /chat/channels/{id}` | `{name?, topic?, archived?}` — owners → Channel |
| `POST /chat/channels/{id}/members` | `{add?: [emails], remove?: [emails]}` — owners → Channel |
| `POST /chat/channels/{id}/join` | public channels → Channel |
| `POST /chat/channels/{id}/leave` | → `{left: id}` (the last owner hands ownership to the next member) |
| `GET /chat/channels/{id}/messages` | `limit` (≤ 200, default 50), `cursor`, `thread` (a message id) → `{messages: [Message], next_cursor}`: top-level messages newest first, or a thread's replies oldest first |
| `POST /chat/channels/{id}/messages` | `{body, parent?, mentions?: [emails], attachments?: [{id}]}` → `201` Message. `body` is Markdown, at most 4096 bytes. `<@email>` in the body mentions too. Replies to a reply join the thread's first message. Attachments are `/api/files` uploads; they join the message and download through `GET /attachments/{id}` for channel members (not after the message is deleted) |
| `PATCH /chat/messages/{id}` | `{body}` — the sender only → Message |
| `DELETE /chat/messages/{id}` | the sender, a channel owner or a Chat Admin → `{id, deleted: true}`; text and attachments are erased, the message stays as deleted |
| `POST /chat/channels/{id}/read` | `{at?}` (default now; never moves back) → `{channel, last_read_at}` |
| `GET /chat/search` | `q` (≥ 2 characters), `limit` (≤ 100) → `{messages: [Message]}` from my channels and public ones |

- **ChannelSummary**: `{id, name, title, type, topic, archived, role` (`Owner` / `Member` / null when
  not a member)`, last_read_at, last_message_at, unread` (top-level messages from others since
  `last_read_at`)`, last_message: {id, sender, body` (first 200 characters)`, posted_at} | null}`.
  `title` is the other person's name for direct conversations.
- **Channel**: `{id, name, title, type, topic, archived, last_message_at, role, last_read_at,
  members: [{email, full_name, role, last_read_at}]}`.
- **Message**: `{id, channel, sender` (email)`, sender_name, body, parent, mentions: [emails],
  attachments, deleted, posted_at, edited_at, reply_count, last_reply_at}`.

People to mention or message come from `GET /api/users` (`id, full_name, email` of active users).

### Calendar — `/api/app/comms/calendar/...`

Events are created and edited with the generic API (`/api/v1/CalendarEvent`, entity
**CalendarEvent**): `subject, starts_at, ends_at, all_day` (midnight UTC boundaries, `ends_at`
exclusive)`, timezone` (IANA, for display)`, location, meeting_link, description, category, color,
visibility` (`Private` | `Public`)`, status` (`Confirmed` | `Tentative` | `Cancelled`)`,
attendees: [{email, attendee_name?, response}], recurrence` (RRULE: `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`,
`INTERVAL`, `BYDAY` incl. `1MO`/`-1FR` with MONTHLY, `BYMONTHDAY` incl. negatives, `COUNT` or
`UNTIL`, `WKST`)`, recurrence_exceptions: ["2026-11-09" | RFC 3339], reminders: [{minutes_before}],
reference_entity, reference_id`. `owner` (the organizer, read-only) is the creator. Attendees can
read the events they are invited to; only the organizer edits or deletes. Colleagues (matched by
sign-in email) get bell notifications for invitations, changes and cancellations; outside guests
get emails with an iCalendar `REQUEST` (or `CANCEL`). Recurrences repeat at the same UTC time.

| Method & path | Body / query → response |
|---|---|
| `GET /calendar/events` | `from`, `to` (dates or RFC 3339; at most 400 days) → `{from, to, occurrences: [Occurrence]}`: my events, events I am invited to and public events, recurrences expanded |
| `POST /calendar/freebusy` | `{users: [emails] (1–50), from, to}` → `{from, to, busy: {email: [{start, end}]}}` — merged busy intervals, no details (declined and cancelled events are free) |
| `POST /calendar/events/{id}/rsvp` | `{response: "Accepted" \| "Declined" \| "Tentative" \| "Needs Action"}` → `{event, response}`; the organizer is notified |
| `GET /calendar/feed` | → `{active}` — whether I have a feed URL |
| `POST /calendar/feed` | → `{active: true, token, path, url}`: a new secret feed URL (shown once; the previous one stops working). Its secret lives in a `CalendarFeed` record's secret field |
| `DELETE /calendar/feed` | → `{active: false}` |
| `POST /calendar/import` | an `.ics` file as the raw body (`text/calendar`), or JSON `{ics}` → `{created, updated, failed: [{uid, subject, error}], warnings}`. Imported events are mine and private; importing the same UIDs again updates them. `TZID`s (IANA or common Windows names) convert to UTC |

**Occurrence**: `{id` (`{event}/{start}`)`, event, start, end, all_day, subject, location,
meeting_link, description, status, visibility, category, color, timezone, owner, is_organizer,
my_response` (null when not an attendee)`, recurring, reference_entity, reference_id}`.

Reminders are bell notifications ("Reminder: …"), once per occurrence and reminder, to the
organizer and colleagues who have not declined.

## Public endpoints — `/api/site/{tenant}/comms/...`

| Method & path | What |
|---|---|
| `POST /inbound/{token}` | A provider forwards one received message (up to 32 MB): the raw MIME as the body (`message/rfc822`), or a `multipart/form-data` form with a `body-mime` (Mailgun), `email` (SendGrid) or `raw` field → `202 {status: "created" \| "duplicate", id}`. Unknown token → 404 |
| `GET /unsubscribe?n=&e=&s=` | Confirmation page for a newsletter unsubscribe link (a GET never unsubscribes, so link scanners cannot) |
| `POST /unsubscribe?n=&e=&s=` | Unsubscribes the address from the newsletter's groups and shows a confirmation page; also the RFC 8058 one-click target of the `List-Unsubscribe` header. A changed or incomplete link → 403 page |
| `GET /calendar/{token}.ics` | The token owner's calendar as iCalendar (events since 180 days ago, recurrences as RRULE, reminders as VALARM) |

## Live pushes (`/ws/live`)

Package messages arrive on the live socket (see `server/src/live.rs`) as
`{"push": {"kind": "...", "data": {...}}}`, delivered at commit to the user's open apps. They
carry ids, not content: refetch through the endpoints above.

| kind | data | sent to |
|---|---|---|
| `chat` | `{event: "message", channel, message, parent, sender}` | every member of the channel (the sender's other sessions too) |
| `chat` | `{event: "edited", channel, message}` / `{event: "deleted", channel, message}` | every member |
| `chat` | `{event: "read", channel, last_read_at}` | the reader's own sessions (sync unread badges) |
| `chat` | `{event: "added", channel}` / `{event: "removed", channel}` | people added to or removed from a channel (also the other person when a direct conversation starts) |
| `chat` | `{event: "channel_updated", channel}` | every member (name, topic or archive changed) |
| `mail` | `{communication, status}` | the author of an email, when it is `Sent`, `Failed` or queued again |

Bell notifications (`{"notification": {...}}` on the same socket, `GET /api/notifications`):
@mentions (`entity: ChatMessage`, the message id), failed emails and replies to your mail
(`Communication`), calendar invitations, changes, cancellations, RSVPs and reminders
(`CalendarEvent`).

## Newsletters

`EmailGroup` + `EmailGroupMember` (`email` unique per group, `unsubscribed`). A `Newsletter`
(`subject`, `content` HTML with `{{ member.member_name }}`, `{{ member.email }}`,
`{{ unsubscribe_url }}`; `email_groups`; `email_account`; `schedule_at`) is scheduled with the
actions `schedule` / `unschedule` / `cancel_newsletter`, then sent by maintenance in batches within
the hourly limit, each member once (an address in several groups is mailed once), never to
unsubscribed members. Every mail has a personal HMAC-signed unsubscribe link (added as a footer
when the content has no `{{ unsubscribe_url }}`) and `List-Unsubscribe` / `List-Unsubscribe-Post`
headers. Status `Draft` → `Scheduled` → `Sending` → `Sent` (or `Cancelled`); `total_recipients`,
`sent_count`, `failed_count` follow along.

## Reports

`email_activity` (sent / received / failed / waiting per account and day), `newsletter_performance`
(recipients, delivered %, unsubscribes), `chat_activity` (messages and active members per channel;
chat administrators). Parameters `from_date` / `to_date` default to the last 30 days.

## Background work

Every minute (`maintenance`, one replica at a time): retry due mail and requeue mail stuck in
Sending for 10 minutes; poll IMAP accounts whose interval passed (only UIDs above the last one; a
new UIDVALIDITY rereads the folder; the first poll takes the newest 50; at most 50 per poll);
start due newsletters and send the next batch; announce due reminders; purge old reminder
bookkeeping. While an account's SMTP server is failing, newly queued mail waits for these retries
instead of holding up the outbox worker with a timeout per message.
Received mail is deduplicated by Message-ID, so the webhook and the poller can both deliver the
same message.
