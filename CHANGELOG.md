# Changelog

## 0.7.1

- Depends on the platform's `contacts` (Ferrum docs/plan/apps-ui.md §13, U3): every workspace with
  Comms has the shared contacts and addresses, without CRM. Comms users read them, so calendar and
  contacts apps show the address book; CRM's roles edit it.

## 0.7.0

- Comms' own interface (Ferrum docs/plan/apps-ui.md, U4a), out of the web app: `ui/`, one interface
  with four launcher entries and routes, Mail (`/mail/`), Chat (`/chat/`), Calendar (`/calendar/`)
  and Meet (`/meet/`), served by the platform under its bar and embedded in the crate (`UI`, from
  `ui/dist`).
- Calls from Chat and Calendar open in a companion window that outlives the page, so people keep
  working in other apps while they talk; the window closes itself when they leave the call.
- For other apps: the intents `compose email`, `schedule event` and `share record`, and Chat as the
  bar's side panel. Mail attaches files from Drive (the `pick file` intent); the bar's Create menu has
  Email.
- Meetings' links are Comms' pages (`/meet/{kind}/{id}`); guests join on its public page
  `/meet/guest/{workspace}/{link}` (`shell.public`). Links made before (`/app/meet/…`) keep working:
  invitations read them, and the web app sends them here.
- Needs Ferrum platform 0.3.2.

## 0.6.0

- Calendar and contacts apps (CalDAV and CardDAV, `/api/dav/comms/...`; Ferrum docs/plan/collaboration.md, C5). Each person's calendar syncs both ways: organizers add, change and delete events from their apps, guests answer and decline, and a change to one occurrence becomes an event of its own. Two read-only address books: the workspace's people, and the CRM contacts the person may read. Apps sign in with an app password (Ferrum's API key of scope `dav`).
- Meeting guests: an event's outside guests get their own link to its meeting in their invitation; rooms have a guest link to share. Guests join as "Name (guest)" without signing in.
- iCalendar imports read changes to single occurrences (RECURRENCE-ID) as events of their own; before, one could overwrite its series.

## 0.5.0

- Video meetings on a LiveKit server the operator runs beside Ferrum (`FERRUM_MEET_URL`, `FERRUM_MEET_KEY`, `FERRUM_MEET_SECRET`). `/api/app/comms/meet/...` signs LiveKit tokens for the call of a chat channel (whoever may read it), of a calendar event (its organizer and guests, or anyone for a public event) or of a room someone started (anyone in the workspace with its link). Archived channels and cancelled events have no call. Rooms nobody joined for 90 days are removed.

## 0.4.0

- Shared mailboxes. A Shared Mailbox (an address such as sales@, a display name and its members) becomes a group account on the mail server. Its members see it in their mail as one more account. A member who leaves, is deactivated or moves out of the domain loses it. A deleted shared mailbox keeps its mail but loses its members.
- Distribution lists. An Email Group with a List Address (e.g. all-staff) becomes a mailing list on the mail server, passing mail on to the members who are not unsubscribed. Clearing the address removes the list.
- Changes to shared mailboxes, email groups and their members, and to the Mail Domain, reach the mail server at the next maintenance round (about a minute) instead of up to ten minutes later.

## 0.3.0

- Webmail endpoints (`/api/app/comms/mail/...`) for whoever has a hosted mailbox:
  - the JMAP session;
  - JMAP requests of mail methods (others refused);
  - attachments in and out;
  - messages to read with their HTML made safe (no scripts or forms, styles that load nothing, inline images embedded, remote images only on request);
  - filing a message onto a record as the person's communication.
- Ferrum signs in with the kept password. When the mail server no longer takes it, Ferrum sets a new one and retries.
- Files are served with their type stripped of parameters before the check against types a browser could run.

## 0.2.0

- Hosted mail: with a Stalwart mail server the operator runs (`FERRUM_MAIL_URL`,
  `FERRUM_MAIL_ADMIN`, `FERRUM_MAIL_ADMIN_SECRET`) and a Mail Domain in Communication Settings,
  every active person whose address is in the domain gets a mailbox there. Ferrum keeps them in
  step every ten minutes or on "Sync Mailboxes": new people get one, a changed address moves it,
  deactivated people and people who leave the domain are locked out (their mail stays), people
  who come back are let in again. Hosted Mailboxes lists them; each password is a sealed secret.
- Declares the messages a person sent as their personal data, so Administration → Personal data
  exports and erases them (by email).

## 0.1.0

- First release as a standalone Ferrum app (previously part of the Ferrum repository).
- Passwords, the inbound webhook token, calendar feed tokens and the newsletter signing key are platform secret fields (sealed, write-only); the package's own secrets table is gone.
- Mail and chat attachments use the platform's file storage (`/api/files`), attached to the record a mail belongs to; the package's own attachment table and upload endpoint are gone.
- The inbound raw-MIME webhook accepts messages up to 32 MB.
- Comms Users read and edit their own communications through the generic API as well.
