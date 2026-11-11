# Changelog

## 0.12.1

The interface follows the upgraded design system, rebuilt with Ferrum-Frontend 0a47157. Text uses the kit's type roles (nothing under 12px) and controls its height tokens; loading shows skeletons shaped like what is coming; empty, no matches, denied, offline and failed are told apart; status colours come from stored state ids. The interface check now runs the UI lint against an empty baseline. In Mail an open row, an unread one, a starred one and the keyboard cursor are distinct, a long sender no longer pushes the time off the row, and the draft line never says saved for a draft kept only in the browser. Chat fits a phone: lines wrap and the composer stays in view. Initials take one character for a Han, Kana or Hangul name and ignore a bracketed alias. In right-to-left a calendar event's title is cut at its end, and the new event's "Who sees it" shows its whole value.

## 0.12.0

What meetings keep of a person is part of their personal-data requests (Ferrum's closure review, FEO-016). The captions someone gave of their own voice, kept as meetings' transcripts in Comms' own table, are in their copy (Administration → Personal data, under the apps), go with their erasure, and go again when a restore replays the erasure. The meeting keeps everyone else's words. Needs Ferrum 937a494 or later (`privacy::PersonalHeld`).

## 0.11.0

Mail asks the platform's one decision about contacting someone when it sends, not only when it was queued (Ferrum's closure review, FEO-015).

- A communication has a Purpose: Transactional (the default: a reply, a receipt, a confirmation) or Marketing (Campaigns marks its mail so).
- When an email goes out, each recipient is asked as they stand then: marketing goes to no one who withdrew their consent to it in any app; nothing goes to anyone whose processing is restricted. They are left out; with no one left, the email is Withheld, saying who and why. A withheld email can be retried, and is asked again.

## 0.10.13

The reports it defines in code (their titles and parameters) have names in Arabic and Hindi too, with its models' and manifest's (300 each in ui/src/locales/names). Translated by the model, to be reviewed by native speakers.

## 0.10.12

Rebuilt with Ferrum-Frontend c59c9a2: the names of its models, fields and manifest in Arabic and Hindi (297 each in ui/src/locales/names, which the platform serves to every page of the workspace, so a record's labels, the launcher and the bar read in the person's language), and the sentences its pages still showed in English (split around a link or a figure, built in code from a template or word by word) whole and translated (562 words each in ui/src/locales). Translated by the model, to be reviewed by native speakers.

## 0.10.11

Rebuilt with Ferrum-Frontend 155518c: the sentences its pages built in code (counts, dates, what a toast or a screen reader says) go through t() too, as whole sentences where code chose a word, and carry built-in Arabic and Hindi (514 words each in ui/src/locales, translated by the model and to be reviewed by native speakers).

## 0.10.10

The assistant knows what its records mean in its pages (contributes.shell.assistant): their states, what counts and where figures come from, with questions it suggests asking there.

## 0.10.9

Rebuilt with Ferrum-Frontend 5b22e7b: its own words carry built-in Arabic and Hindi (493 words each, ui/src/locales, translated by the model and to be reviewed by native speakers), fetched for the page's language only. The labels it keeps in objects, its dialogs, its page titles and the words it keeps in variables go through t() as well, and the names and sizes it shows as they are keep their order right to left. Its pages are drawn once their words are in, and its entry carries only the parts of the kit it uses.

## 0.10.8

Rebuilt with Ferrum-Frontend 6537d65: an action's link, code or token shown once is kept in a dialog to copy, and on a page that reads right to left, English left untranslated keeps its own order. Its own words go through the kit's t() (403 places), so a workspace's own words for its language reach them, and Admin, Interface words lists them under it (dist/words.json).

## 0.10.7

Rebuilt with Ferrum-Frontend d5d98f2: a workspace's own words for its interface (Admin, Interface words) reach its pages as they load; an attachment field that holds a picture shows it; and a value another record already has is said so, where the form said the record had been changed by someone else. Its own screens' margins, paddings, borders, alignment and insets go by the line's start and end, so they mirror right to left as the kit's do; what it places by coordinates (boards, timelines, charts, handles) stays as it was.

## 0.10.6

Rebuilt with Ferrum-Frontend 63280d3: right to left, its pages mirror as they read (icons that point along the line, margins and alignment by the line's start and end, arrow keys along it), and the records pages' words are in Arabic and Hindi.

## 0.10.5

Rebuilt with Ferrum-Frontend a64416a: a new record's box whose default is 1 shows ticked, as it is saved.

## 0.10.4

Rebuilt with Ferrum-Frontend 922fcfb: an action's dialog says every refusal, the errors on what the action made (another record's rows) among them, and an action with parameters and a confirmation asks once.

## 0.10.3

Rebuilt with Ferrum-Frontend a76295e: its pages show times on a person's own clock when they chose one on their Account page, while today and due dates stay on the workspace's day.

## 0.10.2

Rebuilt with Ferrum-Frontend 24c3951: its pages show times on the workspace's clock, naming the zone when it is not the browser's, a draft numbered on submit is headed as a draft, and a record of an app that is not installed says so.

## 0.10.1

Rebuilt with Ferrum-Frontend bb60115: a record page reads an empty number or check as the server does, so an action whose condition needs one shows, and a workspace's settings open as their one record.

## 0.10.0

Attachments stream: an attachment is sent by the server straight from storage, whatever its size, instead of being read whole into memory first (Ferrum's SiteResponse::file, FERRUM-OPS-006).

## 0.9.3

Rebuilt with Ferrum-Frontend 00dea07: in a workflow state that names what may change, the other fields show read-only, and the fields the state needs show required.

## 0.9.2

Rebuilt with Ferrum-Frontend daeadda: after an action runs, a record page shows what the action said it did rather than only that it is done.

## 0.9.1

Rebuilt with Ferrum-Frontend 80ff179: a field's label names its control for assistive technology, and a record whose title is a link shows that record's title, not its id.

## 0.9.0

Captions, transcripts and recordings in meetings (FERRUM-COMMS-002).

- **Captions** are each person's own. *Caption my voice* has their browser's speech recognition
  (Chrome, Edge, Safari) caption what they say. It goes to everyone in the call on LiveKit's
  `lk.transcription` text stream, the one LiveKit's transcription agents use, so an operator's agent
  shows the same way. *Captions* shows the latest lines. The button says that the browser may send
  the voice to its maker to recognise it.
- **The transcript** is what people captioned: each segment kept once per person, the last words
  standing, for whoever may join the meeting (`GET`/`POST /api/app/comms/meet/{kind}/{id}/transcript`).
  Guests' captions show in the call but are not kept.
- **Recordings** go through LiveKit Egress, where the operator runs it with its storage
  (`FERRUM_MEET_RECORDINGS=true`, and `FERRUM_MEET_API_URL` when the server reaches LiveKit at another
  address than browsers). Anyone in the meeting may start or stop one, one at a time. The person
  confirms first, and everyone in the call sees *Recording*. The meeting's recordings say where each
  file went once Egress has stored it (`/api/app/comms/meet/{kind}/{id}/recordings`). With recordings
  on, the server calls LiveKit's API.

## 0.8.1

Presence in Chat (part of FERRUM-COMMS-002).

- A channel's members, and the other person of a direct conversation, show whether they are about:
  a session of theirs made a request in the last ten minutes (sessions note it at most every five).
  Only that is shown, never when someone was last seen. A green dot on their initials and "Active
  now" in Members, and on the direct conversation in the sidebar.

## 0.8.0

The interfaces of Chat, Mail, Calendar and Meet, worked through screen by screen.

Chat
- A direct message now tells the other person, and a reply tells the people of its thread. Each person
  chooses how loud a channel is for them: every message, mentions and replies to them, or nothing
  (muted, with no count, though a mention still marks it). Three new kinds of notification in the bell:
  direct messages, thread replies, and every message of the channels you chose to hear in full.
- Unread counts are right: replies in threads you started or answered in count, mentions are counted
  apart, and someone who joins a channel or is added to it starts with nothing unread (before, the
  whole history was unread). A conversation opens at its first unread message, marks itself read only
  when you reach the bottom, and any message can be marked unread again. "Mark everything as read" is
  in the list's menu, and Chat tells the bar how much waits to be read.
- A channel's details open beside it: its name and topic, who can find it, who can post (every member,
  or only owners start posts while members reply in threads), how loud it is for you, leaving, and its
  members, which owners add, remove and make owners. The last owner cannot be demoted.
- Typing @ offers the people to mention (in a private conversation, only those who can read it). Unsent text is kept for each conversation and thread. A message
  that cannot be sent says why and stays. A mention's notification, a link to a message and a search
  result open the message in its place; a thread shows the message it belongs to; a conversation can be
  searched on its own.
- For the API: `PATCH /chat/channels/{id}` takes `type` and `post_policy`; `POST …/members` takes
  `promote` and `demote`; `PUT …/notify`, `POST /chat/read-all` and `GET /chat/messages/{id}` are new;
  messages take `?around=` and the read marker `{unread_from}`; search takes `channel=`; channels answer
  `unread_mentions`, `post_policy` and `notify_level`.

Mail
- A folder lists conversations, not single messages, with how many each holds; opening one shows its
  messages one under another, the newest and unread ones open. Archive, delete, spam and unread act on
  the whole conversation.
- The keyboard drives it: j and k, Enter, r, a, f, e, #, !, s, Shift+U, c, / and ? (which lists them).
- Writing is saved as a draft in the mailbox a moment after the last key, and kept in this browser until
  the mail server has it. Closing keeps the draft; a draft opens from Drafts to be written on; a message
  left unsent in this browser is offered again. A message that cannot be sent stays in the window with
  the reason in words and is in Drafts. To, Cc and Bcc complete from the people in the workspace.
- Mail domain health, for Comms managers (`/mail/domain`, `GET /api/app/comms/domain`): which DNS
  records the domain's mail needs (from the mail server's own zone file for it, else the few every
  domain needs), which are published, which are missing or different, and what to do, in words; copy a
  value, download the zone file. Reverse DNS and port 25 are listed as checks by hand.

Calendar and Meet
- Guests outside the workspace answer from their invitation: it carries Yes, Maybe and No links to a page
  of Calendar's own (public, signed for that event and that address) that takes the answer and a note
  for the organizer. Colleagues add notes to their answers too, and the event lists each guest's answer.
  A notification of an invitation opens the event in Calendar.
- Calendar has its own event editor, with Find a time: when each colleague is busy that day (never why),
  a warning when the chosen time clashes, and the times in the next week that suit everyone. The
  schedule intent warns of a clash too. `POST /calendar/freebusy` takes `exclude`, an event to leave out.
- Where meetings are not set up, the meeting page, a guest's link and the calendar say so and offer no
  call. On a phone a call opens over the page and keeps the screen awake, and a browser without a camera
  or microphone can join to listen. A call that cannot reach the meeting server says so.

Not in this version: an emailed iCalendar reply (a guest's mail program answering the organizer) is not
applied to the event, so guests answer with the link in the invitation; reactions, presence, scheduled
messages, mail filters, outbound queue status, and recording are not built.

Also in this release: a person's request for their data now reaches chat messages they sent, mailing
lists they are on and their calendar feeds, which an erasure blanks.

## 0.7.4

- The bar's search finds chat messages (`shell.search`): those in public channels and in the
  person's own, each opening its conversation. `GET /chat/search` answers `results` in the bar's
  shape beside `messages`.
- Chat channels open in Chat from anywhere (`shell.open`: `/open/ChatChannel/{id}`).

## 0.7.3

- Pop out in a browser that says it floats videos but cannot float a call's (a camera stream):
  the person is told so in plain words and the button goes away, instead of an engine's error.

## 0.7.2

- Calls pop out: in a meeting, Pop out puts the call in a small window that stays above every other
  (Document Picture-in-Picture: a shared screen first, else whoever speaks, with the microphone, the
  camera and leaving), so people keep it in view while they work in other apps. Where browsers can
  only float a video (Safari), the speaker's video floats instead; where they can do neither,
  there is no button. Leaving the call, or its page, closes the small window. Guests have it too.

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
