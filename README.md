# Ferrum Mail, Chat and Calendar

A native app for [Ferrum](https://github.com/CBFerrum/Ferrum), the open-source, AI-first ERP.

- Email accounts per company (SMTP/IMAP; passwords are write-only secret fields), outgoing mail sent once with retries, inbound mail by IMAP polling or a raw-MIME webhook, threaded onto the record it answers
- Communications on any record: email, notes, calls, meetings, with attachments in Ferrum's file storage
- Email templates rendered against the record (sandboxed, escaped), with preview
- Newsletters to email groups in batches under an hourly limit, with signed one-click unsubscribe
- Team chat: public, private and direct channels, threads, mentions, edits, read markers, search; members only, pushed live
- Hosted mail: with a Stalwart mail server, a mailbox for every person in the workspace's mail domain, kept in step with their account, and webmail endpoints over JMAP (safe message HTML, attachments, app passwords, filing a mail onto a record), shared mailboxes (sales@, support@) and distribution lists
- Calendar: events with attendees and RSVP, recurrence (daily to yearly, by weekday or month day, with exceptions), reminders, free/busy, ICS invitations, a private ICS feed and ICS import
- Video meetings on a LiveKit server the operator runs: a call in any chat channel, a meeting for any calendar event, or a room to meet in now; Comms decides who may join and signs their tokens. People outside the workspace join by link: an event's guests by the link in their invitation, anyone by a room's guest link
- Calendar and contacts apps (CalDAV, CardDAV): each person's calendar syncs both ways with Apple Calendar, Thunderbird, DAVx⁵ or Outlook, and their colleagues and CRM contacts reach their address books
- `packages/comms/README.md` documents every endpoint and the chat push protocol

## Install

Workspace administrators install it from **Apps** in Ferrum; it ships in the official Ferrum
server image. Self-hosters building their own image enable the `comms` feature of the server.
Everything it adds is also available to AI agents over Ferrum's MCP server.

## Its interface

Mail, Chat, Calendar and Meet are this app's own interface (`ui/`), which Ferrum serves under its bar
at `/mail/`, `/chat/`, `/calendar/` and `/meet/` (Ferrum docs/plan/apps-ui.md). Calls from Chat and
Calendar open in a window of their own that outlives the page; meeting guests join on the public page
`/meet/guest/{workspace}/{link}`. For other apps it writes emails (`compose email`), schedules
meetings (`schedule event`), shares records to Chat (`share record`) and opens Chat beside any page.

`ui/dist` is committed: the crate embeds it, so the server carries the interface of the version it was
built with. With Ferrum-Frontend checked out at `../ferrum/web`:

```
cd ui
npm run build       # into dist/, stamped with its sources (commit dist/)
npm run check       # CI: dist/ was built from ui/ as it is
npm run typecheck && npm test
```

## Develop

Clone it next to the platform and point the platform dependencies at your checkout (this file
is git-ignored):

```toml
# .cargo/config.toml
[patch."https://github.com/CBFerrum/Ferrum"]
ferrum-kernel = { path = "../ferrum/crates/kernel" }
ferrum-meta = { path = "../ferrum/crates/meta" }
ferrum-domain = { path = "../ferrum/crates/domain" }
ferrum-calc = { path = "../ferrum/crates/calc" }
```

The tests need PostgreSQL with an ordinary (non-superuser) role — row-level security must apply:

```bash
createuser ferrum --pwprompt && createdb -O ferrum ferrum_comms_test
```

```bash
cargo test
```

`FERRUM_COMMS_TEST_DATABASE_URL` overrides the database URL. The hosted-mail part runs against a
real Stalwart when one is set up (`export $(tests/stalwart.sh)` starts one in Docker) and is
skipped otherwise. The app's metadata lives in `packages/` and is embedded
at build time; `app.yaml` is its manifest (see Ferrum's `docs/plan/apps.md`).

## License

AGPL-3.0-only, like the platform.
