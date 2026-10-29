# Ferrum Mail, Chat and Calendar

A native app for [Ferrum](https://github.com/CBFerrum/Ferrum), the open-source, AI-first ERP.

- Email accounts per company (SMTP/IMAP; passwords are write-only secret fields), outgoing mail sent once with retries, inbound mail by IMAP polling or a raw-MIME webhook, threaded onto the record it answers
- Communications on any record: email, notes, calls, meetings, with attachments in Ferrum's file storage
- Email templates rendered against the record (sandboxed, escaped), with preview
- Newsletters to email groups in batches under an hourly limit, with signed one-click unsubscribe
- Team chat: public, private and direct channels, threads, mentions, edits, read markers, search; members only, pushed live
- Calendar: events with attendees and RSVP, recurrence (daily to yearly, by weekday or month day, with exceptions), reminders, free/busy, ICS invitations, a private ICS feed and ICS import
- `packages/comms/README.md` documents every endpoint and the chat push protocol

## Install

Workspace administrators install it from **Apps** in Ferrum; it ships in the official Ferrum
server image. Self-hosters building their own image enable the `comms` feature of the server.
Everything it adds is also available to AI agents over Ferrum's MCP server.

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

`FERRUM_COMMS_TEST_DATABASE_URL` overrides the database URL. The app's metadata lives in `packages/` and is embedded
at build time; `app.yaml` is its manifest (see Ferrum's `docs/plan/apps.md`).

## License

AGPL-3.0-only, like the platform.
