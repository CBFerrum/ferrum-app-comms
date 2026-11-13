# Changelog

## 0.20.0

Mail becomes something other apps build on: what Helpdesk and CRM asked of it. A database change (`comms/009_inbound_apps.sql`: `comms_mail_route`, `comms_mail_filing`) and new `Communication` fields (`reply_to_address`, `envelope_sender`, `routed_to`, `route_error`, `hidden_from_inbox`) are applied at startup; nothing existing moves. No interface change.

**Received mail keeps its headers.** `Communication.headers` is written for every received (and filed) message: Message-ID, In-Reply-To, References, Reply-To, To, Cc, the recipient it was delivered to, Auto-Submitted, Precedence, List-Id, List-Unsubscribe, Return-Path, the auto-reply and bounce markers, any `x-ferrum-*` marker, the receiving server's Authentication-Results and `x-ferrum-auth` (`verified` or `unverified`, from the DMARC or aligned DKIM result, as the calendar judges invitations). Names lower case, values decoded and on one line, 2,000 characters each and 12,000 together. Erased with the sender. Older rows have none and work as before.

**An app sets Reply-To and threading on what it sends.** `outbound::send` takes Reply-To, In-Reply-To, References (checked as an address and message ids, never header text) and an envelope sender on a domain of the workspace; it returns the Message-ID, which is stored. A message that answers one Mail has takes its thread and record.

**Apps register for inbound mail.** `routes::add_handler` and `routes::register`: an address or a pattern (`ticket-*@`, plus-addressing, the token handed over) on a workspace domain; Mail hands a received message to each registered app once, in its own transaction behind a savepoint, so a failing handler loses nothing (`route_error`); `routed_to` says which app took it; `keep_in_mailbox: false` leaves it out of lists. Two apps cannot overlap; a person's or a shared mailbox's address cannot be taken. The hook on `Communication` keeps working.

**Every message of a mailbox can be filed without a person.** Hosted mail raises `MailMessage.received` and `MailMessage.sent` (ids, addresses, thread, mailbox, subject; never the body) once per message. Off until the owner turns it on (`PUT /mail/filing`), never for a mailbox a manager marks private (`PUT /mail/filing/private`).

Tested against a real PostgreSQL with a fixture app: a message to the registered address reaches the handler once with its headers, a reply is delivered in the same thread, an auto-reply, a bounce and list mail carry their marking headers, a failing handler leaves the mail delivered and logged with its writes undone, an app's send goes out with Reply-To, In-Reply-To, References and its envelope sender, and filing events are raised once across concurrent rounds and not for private or switched-off mailboxes.

Not in this release: the setting's switch in Mail's settings screen (the endpoints are there); routing of mail that stays on the hosted mail server (forward the address to the account's inbound webhook); events for mail kept as a `Communication` (it has `Communication.created`).

## 0.19.0

Mail gets a composer you want to write in. No database change. Tried on a running server beside a real mail server; built with the Ferrum-Frontend commit named in `ui/dist/.source`.

**The kit's editor.** The message is written in the kit's rich-text editor: the toolbar on top of the text (the whole toolbar when the window is wide, the compact one in a window or under a conversation), styles, lists and check lists, colour, links, pictures and tables, paste from Word and Google Docs. A link ends where its words end: a space or a full stop typed after it is not part of it. What you write is cleaned by the kit's rules before every draft save and every send; the server cleans again.

**A window with presence.** A header names the message and carries minimise, full screen, pop out to a browser window of its own, and close. To, with Cc and Bcc on demand and From only when there is a choice; the subject is the window's title. Attachments are tiles with their kind, size and progress. One bar: Send with its menu (send and archive, schedule), attach, Drive, picture, templates, plain text, and the save status. A window resizes by its corner and the next one opens at that size; full screen is centred at a readable width; several windows share the screen; on a phone one composer fills it with the toolbar on the keyboard. The answer under a conversation is the same composer, its send bar staying in view. Notices move to the bottom start while you write, never over Send.

**Pictures and quotes.** Pictures upload to the mailbox as you add them and go out as parts of the message; a forwarded or answered message's pictures go by reference. Remote pictures in a quoted message are kept but not loaded while you write. The original under an answer stays folded until you open it into the text.

**Reading and writing alike.** The composer and the reader set the same text the same way: face, size, line spacing, lists and quotes. A message goes out without a typeface of its own, as Gmail's do.

**Everywhere you write.** The vacation reply is written in the same editor and goes out with its HTML and its words. Signatures in Mail settings and Calendar's event notes use it too. Send is named with its key for assistive technology. The selection bar keeps Archive and Delete in view and folds the rest into More. The composer's code loads when you start writing: Mail's own code is 82 KB, 10 KB less.

Seen on the running server: messages written with formatting, a list, a link, a picture and two files, sent to a colleague and read in her Mail; her answer written with the keyboard alone, its MIME fetched back (`multipart/mixed` around `multipart/related` around the text and HTML, the picture by Content-ID, In-Reply-To and References); the vacation reply's HTML in the automatic answer; a new-mail notice in the bar with Mail closed; right to left in Arabic. 231 interface tests. The new words are in Arabic and Hindi.

Not in this release: Chat's message box (Chat keeps Markdown); no pop-up for new mail, the bar lists it under the bell within about a minute; the pop-out window and dragging a window's corner were not driven in a browser; the toolbar measured on a real phone's keyboard; the composer in Arabic on a phone; the selection bar crowds "Clear selection" in a narrow column (the kit's to fix); a screen-reader audit.

## 0.18.0

Calendar fills in what 0.17 left out. A database change (`comms/008_calendar_proposals.sql`) and new fields are applied at startup; nothing existing moves. Tried on a running server beside a real mail server; built with the Ferrum-Frontend commit named in `ui/dist/.source`.

**Sharing, completed.** Someone a calendar is shared with to make changes can add events to it, from the quick form too, and change or delete them, including a repeating event with its three choices. The calendar's owner stays the organizer, so invitations and reminders are theirs, and the event shows who made it. A calendar can be shared with a group (a role), and someone taken out of the role loses access on their next request.

**Calendar programs see every calendar.** Each of your calendars, and each one shared with you, is its own CalDAV collection with its name and colour. A "make changes" share is writable, "all details" is read-only, and "free and busy" shows only "Busy" with the times: the event is rebuilt from its times alone, so a title, place, guest or note cannot leave that way. `default` keeps working for phones already set up. Programs can create a calendar and keep up to date with sync tokens.

**Subscribe by address.** Paste an `.ics` or `webcal://` address, or use Add holidays. The address must be HTTPS and on the public internet; redirects are not followed and feeds over 5 MB are refused. A feed is fetched at most hourly, only when it has changed, and less often after failures, up to once a day. Its events are read-only, never invite anyone, are not exported and do not make you busy, and remind you only if you turn that on. The side panel says when it last updated or why it could not. The address is kept as a secret and shown afterwards only by its site.

**Propose a new time** from an event, or from an invitation in Mail, where an outside organizer gets a COUNTER by mail. A proposal arriving by mail is recorded only from an invited guest whose mail the server can vouch for, and Mail says so when one is not recorded; it never moves the event by itself. The organizer alone sees proposals, marked on the calendar, and accepts (the event, or that one occurrence, moves and guests are told) or declines (the guest is told).

**Richer events.** Notes are written in Mail's editor, made safe as Mail makes outgoing mail safe, and written into calendar files as both plain text and HTML. Files from Drive are attached by reference; a guest who cannot open one is told whom to ask, and the organizer is offered to share it. The event dialog says how each guest was told: in Ferrum, by email, or a room that answers itself.

**Rooms and resources.** Comms Managers keep rooms and resources, each with a capacity, a place, bookable hours and who may book. Add one to an event like a guest: it answers at once, with the reason when it cannot, and two bookings of the same time get the room only once (held by a test on the database). Rooms show in Find a time, and Suggest lists free rooms that are big enough.

**Fixes to 0.17.** An all-day event no longer makes you busy all day, so the editor no longer warns "You (12:00 AM–12:00 AM) is busy then"; the warning says "You are busy then" and "all day". The event dialog opens with focus on Close, not Delete. The groups list leaves out the platform's own plugin roles.

Seen on the running server: the calendar list, sync tokens, a free-and-busy collection with only "Busy" and MKCALENDAR over CalDAV with curl; a colleague creating and changing events in a calendar shared with her role, and losing it when taken out of the role; GOV.UK's bank holidays subscribed by `webcal://`, with `http://`, a private address and a loopback address refused and the address absent from the log; a proposal accepted and one declined; an outside COUNTER refused as unverified and a colleague's recorded on arrival; a file a guest cannot open; a room booked twice. 72 Rust unit tests, four database scenarios, 223 interface tests. The new words are in Arabic and Hindi.

Not in this release: pictures in notes; attachments written into calendar files; a colour per event; a view of a room's own calendar, and a room declining for too many people; renaming or recolouring a calendar from a calendar program; an old sync token makes the program list the calendar again rather than only the changes; holidays need an address, because the platform does not yet give apps a workspace's working calendar; server-made wording (notification titles, subscription results, room reasons) is English only, because the platform has no server-side translation; the last four server fixes were tested but not yet seen on a rebuilt server; a screen-reader audit.

## 0.17.0

Several calendars, and sharing them. Tried on a running server with three people; built with the Ferrum-Frontend commit named in `ui/dist/.source`.

**Your calendars.** Everyone has their own calendars: "Personal" to start, and any you make, each with a colour from the kit's tones. Show or hide each, show only one, rename it, recolour it, choose the default for new events, or delete it and say where its events go (moved to another of yours, or deleted with the guests told; the default cannot be deleted). An event belongs to one calendar and can be moved between yours. Events take their calendar's colour in every view, and the calendar's name is always beside it, in each event's label and in its dialog. Your existing events go into "Personal" the first time your calendars are read: one indexed update, safe to run twice, 0.63 s per 10,000 events in a debug build; on the server it took 1.2 s for the person with the most events.

**Sharing.** Share a calendar with colleagues so that they see only when you are busy, see all details, or make changes. They find it under "Other calendars" with your name. Removing someone ends their access at once; so does either person leaving the workspace. "Busy only" keeps an event's details to you and its guests, even in a shared calendar.

**One rule for every way in** (`calendars::level`): the organiser owns; a "make changes" share may change; a guest, a "see all details" share and a public event show details; a "free and busy" share, and a "Busy only" event in any shared calendar, show "Busy" and the times, with place, notes, link and guests removed on the server; anyone else gets nothing. It is applied by the events list and its search, an event's detail, the bar's search and changes. Reminders go to the organiser and guests only. The feed, export and CalDAV carry only a person's own events and invitations, so nothing shared can leave through them. A database test walks every route at each level and unshared, and checks that a free-and-busy viewer never receives a title.

Places have an "Open in maps" link. Calendar's one-key shortcuts no longer fire while typing in the bar's search. Showing or hiding a calendar takes effect at once and is put back with a message if the server refuses.

Seen on the running server: the move into "Personal" for three people with counts equal before and after; a calendar shared at each level from the other person's side, reading the responses; removal emptying the other person's view at once; delete with "move to Personal"; an invitation and a reminder for an event in a shared calendar; exports and CalDAV reports without the shared events; and 0.16.0's checks again (the London weekly across the change of clocks, drag with Undo, the series scopes). 66 Rust unit tests, the sharing scenario on a database, 217 interface tests. The new words are in Arabic and Hindi.

Not in this release: subscribing to an outside calendar by its address; public holidays (the platform does not yet let an app read a workspace's working calendar); calendar programs (CalDAV) see one collection per person, not one per calendar, and nothing shared; sharing with groups; creating events in someone else's calendar, and changing a repeating event there; proposing a new time; rich-text descriptions and attachments from Drive; rooms and resources; a screen-reader audit.

## 0.16.0

Calendar becomes a calendar people can plan in. Tried on a running server beside a real mail server; a database change (`comms/007_calendar_hours.sql`) is applied at startup. Built with the Ferrum-Frontend commit named in `ui/dist/.source`.

**Repeating events keep their time of day across daylight saving.** A weekly 09:00 meeting in London stays at 09:00 when the clocks change; its instant moves instead (it used to repeat at the start's UTC time, an hour off for half the year). A time the spring-forward jump skips is read with the offset from before the jump (02:30 becomes 03:30), as phones and Google Calendar do; a time the fall-back hour repeats is the first of the two. All-day events repeat as dates. `UNTIL` and `COUNT` are read as the iCalendar standard says. Events made before this version are right without any change to stored data; exceptions stored earlier still remove their occurrences; a reminder that already went out is not sent again. Calendar files, the secret feed, CalDAV and invitations write repeating events in their zone with a `VTIMEZONE`, and imports keep the zone they came in. Tested over Europe/London, America/New_York, Australia/Sydney, Asia/Kolkata, America/Sao_Paulo and Australia/Lord_Howe, weekly, monthly and yearly, across both changes of clocks.

**Views.** Day, work week, week, month, agenda and year; Today and previous / next; a small month to jump to a date; the current time; working hours shaded; a second time zone down the side. The view and the date are in the address, so a link opens the same view. On a phone: the day first, three days for a week, and the month as dots with the chosen day's list beneath.

**Making and changing events.** Click or drag on empty time for a quick form (title, time, guests, More options). Drag an event to move it and its lower edge to resize it, in 15-minute steps, or use Alt and the arrow keys; every change offers Undo. For a repeating event every change and deletion asks: this event, this and following, or all events. The editor has a time-zone picker and shows your own time beside it when the zones differ.

**Working hours and time away.** Your days and hours in your zone, and an out-of-office period that shows on your calendar, can decline invitations that fall in it with your message, and links to Mail's vacation reply.

**Find a time** draws each guest's working hours and time away and suggests only times inside everyone's hours, on each person's own clock. A guest outside the workspace shows as no information.

**Search** in Calendar by title, guest, place or notes, and from the bar's search (only events the person can see). **Files and feed**: import an `.ics` file, export your calendar, and copy, renew or turn off the secret feed address. **Keys**: d, x, w, m, a, y, t, j, k, n, p, c, / and ?, in a help list.

Seen on the running server: the London and New York weekly events on both sides of the change; the feed, export and a CalDAV report carrying the zone; an imported New York event; an invitation declined at once during time away and one outside it left to answer; suggestions inside both people's hours; a reminder arriving at the corrected minute; every shortcut. 65 Rust unit tests, 215 interface tests. The new words are in Arabic and Hindi.

Not in this release: several calendars per person with colours, sharing a calendar, subscribing to an outside calendar by its address, public holidays, and one CalDAV collection per calendar; event attachments, a rich-text description, proposing a new time, rooms and resources; a change to one occurrence becomes an event of its own rather than an override inside the series; time away shows to colleagues only in Find a time; dragging on a touch screen is hold-then-drag and was not tried on a phone; a screen-reader audit.

## 0.15.0

Meetings other apps can make. The crate has a public module, `ferrum_app_comms::meetings`, for an app to give one of its records (a booking, a live class) a video meeting: `create` (entity and id as its source, a title, a start and end, a host; the record's open meeting is returned if it has one), `find`, `get`, `member_link` (the page a signed-in member opens), `guest_link` (for an outside guest by name and address: no account, admits only to that meeting, stops two hours after it was due to end or when it is ended), `reschedule` (links keep working at the new time), `end` (reads attendance one last time, closes the room, stops every link) and `attendance`. Comms sends no invitation; the calling app sends its own. Such a meeting is a room: in nobody's calendar. Without the app or a meeting server the functions answer `MeetingError::NotInstalled` or `NotConfigured`, which the caller can branch on.

Attendance: LiveKit keeps no history of who was in a room, so Comms asks the room service who is in it every minute while a meeting is on (a quarter of an hour before to two hours after it was due to end) and keeps each joining with LiveKit's own time of joining. Time spent is accurate to about a minute; joinings from several devices count once. It is part of a person's personal-data copy and erasure. Rooms made this way are removed 90 days after they were due to end. No operator setup beyond the meeting server.

## 0.14.0

Mail works when nobody has it open. Tried throughout against a real Stalwart, with the server's new work running on it. Built with the Ferrum-Frontend commit named in `ui/dist/.source`; a database change (`comms/006_mail_arrivals.sql`) is applied at startup.

**New mail reaches you anywhere.** Within about a minute of arriving, new unread mail in your Inbox becomes one notification: "New message from Ann Lee", or "3 new messages", with the newest sender and subject, never the body. It goes where you chose to get notifications: in the bar, by email, in the daily digest or on your phone. Opening it opens that message, or the Inbox when several arrived. Mail's own setting still decides what counts: everything, only people you have written to, or nothing. Nothing old is announced, nothing is announced twice (also when two servers run the step at once: held by a test that fails without the safeguard), and a mailbox that fails waits and tries again without holding up the others. With Mail open, a tab no longer announces your own new mail again; it refreshes. One request per mailbox per round, inside the mail server's limit; a quiet round over ten mailboxes took 40 to 120 ms.

**On arrival.** A guest's emailed answer updates your event as soon as it arrives. Only that guest's own answer counts, and only if they are invited. Mail from outside counts only when the mail server authenticated the sender (DMARC, or a DKIM signature for the sender's domain); otherwise it stays in your Inbox and the card says the sender could not be verified. An event taken from an invitation records who invited you, and a cancellation from that person cancels the event, or the one occurrence it names. Snoozed mail comes back to the Inbox, unread, at its time, whether Mail is open or not.

**Administration.** In Mail settings, Administration: every mailbox with what it holds and a storage limit to set, with what happens at the limit; shared mailboxes and their members, whose access changes at once; how often people marked mail as spam or not spam in the last 30 days; senders the whole workspace allows or blocks (an address, or a domain with its subdomains); and how long Trash and Spam are kept. Every change is in the audit trail.

**Smaller things.** Unsubscribe in one click where a message offers it: Mail's server asks the sender's own address, over HTTPS only, never a private address, without following a redirect. Download all of a message's attachments as one zip (up to 100 MB). A sent message says where it got to: delivered, on its way, or refused, with the receiving server's words.

57 Rust unit tests, a database test for the arrival step, 204 interface tests. The new words are in Arabic and Hindi.

Not in this release: notifications for shared mailboxes when Mail is not open; a read-only member of a shared mailbox (members read, answer and send); giving a colleague access to your own mailbox; sending as a shared address from your own mailbox saves the copy in your own Sent; retention is one setting for the whole mail server and is changed there; the mail server's own spam rules and lists are managed on the mail server; counter-proposals are not applied; events taken from an invitation before this version cannot be cancelled by mail; a sent message's delivery status is kept for 3 days; mail to outside addresses, and authenticated SMTP from mail programs as a sign of a local sender, were not tried (the test server has no outside DNS); the new screens were not read right to left; a screen-reader audit.
## 0.13.1

Outgoing mail can carry extra headers. A Communication has a `headers` field (an object of name to value, set by the app that queues the mail, read-only to people) which is copied onto the message when it is sent through an email account. It is meant for what bulk senders need: `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 2369, RFC 8058), `List-Id`, `Precedence`, `Auto-Submitted`, `Feedback-ID` and `X-` names. Any other name (From, To, Cc, Bcc, Subject, Reply-To, Content-*), a value with a line break or other control character, an empty or over-long value, or more than 20 headers is refused when the Communication is saved. Mail sent through the server's own mailer (no email account) cannot carry headers: it still goes, the headers are not sent, and the log says so.

## 0.13.0

Mail becomes a mail program people can live in. Built with Ferrum-Frontend 99d45a0 and tried throughout against a real Stalwart with seeded mailboxes. Nothing here needs a newer mail server; one administrator's list needs this version's own server code.

**Folders.** Every folder has an icon and the names people know (Inbox, Starred, Drafts, Sent, Archive, All mail, Spam, Trash), whatever the server calls them. Archive exists for everyone. Folders of one's own can be made, renamed, nested, coloured and deleted (the mail goes to Archive), and a conversation can also be filed under a second folder, shown as chips.

**The list.** A checkbox on every row, Shift+click, select all; a bar to archive, delete, mark as spam or not spam, mark read or unread, star and move, and the same on a row's hover; restore from Trash and Spam; Empty Trash and Empty Spam, which say how long mail stays (30 days). Every such action can be undone for eight seconds, exactly: folders and flags go back as they were, also for a selection. Sender names, a count for conversations, a date that is a time today and a day this week; counts and new mail arrive within seconds while Mail is open, without losing the place or the selection.

**Spam and safety.** A message that failed its sender checks, or that claims this workspace's own domain without passing, carries a warning; mail from outside is marked External; a message in Spam says why it is there. Block a sender, report phishing, unsubscribe where the message offers it. Remote pictures stay blocked behind one bar, with "always show from this sender". Plain text reads on the theme's surface; HTML mail reads as a sheet in the dark theme.

**Writing.** A rich-text composer: bold, italic, underline, strikethrough, colour, highlight, size, lists, quote, alignment, links (Ctrl or ⌘ K), a plain-text switch. Replies keep the original as it looked, behind a fold; forwards carry the original's attachments and pictures without re-uploading them; Reply and Reply all go where they should, and never answer one's own draft. Recipients are chips, checked as typed, with suggestions from the workspace and from people written to before. Attachments by drop, paste, the button or from Drive, with progress, cancel and retry and the limits said first; pictures inline, resized by a corner. Several messages can be open at once; on a phone one fills the screen.

**Nothing written is lost.** A draft is saved a moment after the last key and says so truthfully ("Saving", "Saved to Drafts", "Could not save, retrying"); words typed in the half second before a crash come back from the browser; open messages reopen after a reload; sending leaves no stray draft; discarding can be undone.

**Sending.** "Sent" appears only when the mail server has accepted the message. Undo send (off, 5 to 30 seconds) and Schedule send (tomorrow morning, Monday morning, a picked time) are held by the mail server itself, so they do not depend on the tab staying open; a Scheduled list shows what is waiting, to edit or cancel. Signatures per identity, stored on the mail server so other mail programs share them, with pictures. Templates live in a Templates folder. A message that mentions an attachment and has none, or has no subject, asks before it goes.

**Finding mail.** One box searches all mail, with the operators people know (`from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `is:starred`, `in:`, `before:`, `after:`, `older_than:`, `newer_than:`, quoted phrases, `-`, `OR`), the same as chips and as a form; matches are marked; a search can be saved as a folder.

**Filters.** When a message matches (from, to, subject, words, list, size) it can skip the inbox, go to a folder, be starred, marked read, forwarded, deleted, or never sent to spam; made from a message or from a search, and applied to matching mail on the spot, with Undo. They run on the mail server (Sieve) in one script Mail owns; a person's own script is never overwritten. Forwarding asks first, refuses the mailbox's own address, and shows a banner while it is on. Filters, blocked senders, saved searches, folder colours and Mail's settings are kept in that script, so they follow the person to any browser.

**Reading.** Attachments preview in place (pictures, PDF) and save to Drive; print a conversation as a document; Show original with Copy and .eml; snooze until later, tomorrow, next week or a date (it returns when Mail is next open at or after that time, and says so). Largest conversations, to free space. Import .eml and .mbox files, export a folder as .mbox.

**Invitations.** A message with an invitation shows the event with Yes, Maybe and No; the answer updates the calendar and mails the organiser, and a guest's emailed answer updates the organiser's event when they open it.

**Keys and help.** `x`, `e`, `#`, `!`, `v`, `l`, `z`, `u`, `Shift+I` and `Shift+U`, `/` and `?`, each listed in the shortcut help.

Mail's interface was read once in Arabic and corrected; 578 new words are in Arabic and Hindi. 204 interface tests. The first page stays at 125 KB; the composer, the PDF viewer and settings load when used.

Not in this release: a notification for new mail when Mail is not open in any tab, and a calendar answer applied on arrival (both need a job on the server, designed but not built); snooze that returns without Mail open; shared mailboxes and send-as from the interface; quotas per mailbox, a spam summary, workspace-wide allow and block lists and retention for administrators; one-click unsubscribe by POST; "Download all" attachments as a zip; labels as Gmail has them beyond filing under a second folder; desktop notifications were not tried (they are asked for only from settings); delivery to an outside address was not tried (the test server has no outside DNS); a screen-reader audit; Chat, Calendar and Meet are unchanged apart from the invitation card.

## 0.12.1

The interface follows the upgraded design system, rebuilt with Ferrum-Frontend 76c4fad. Text uses the kit's type roles (nothing under 12px) and controls its height tokens; loading shows skeletons shaped like what is coming; empty, no matches, denied, offline and failed are told apart; status colours come from stored state ids. The interface check now runs the UI lint against an empty baseline. In Mail an open row, an unread one, a starred one and the keyboard cursor are distinct, a long sender no longer pushes the time off the row, and the draft line never says saved for a draft kept only in the browser. Chat fits a phone: lines wrap and the composer stays in view. Initials take one character for a Han, Kana or Hangul name and ignore a bracketed alias. In right-to-left a calendar event's title is cut at its end, and the new event's "Who sees it" shows its whole value.

## 0.12.0

What meetings keep of a person is part of their personal-data requests (Ferrum's closure review, FEO-016). The captions someone gave of their own voice, kept as meetings' transcripts in Comms' own table, are in their copy (Administration → Personal data, under the apps), go with their erasure, and go again when a restore replays the erasure. The meeting keeps everyone else's words. Needs Ferrum cf642d9 or later (`privacy::PersonalHeld`).

## 0.11.0

Mail asks the platform's one decision about contacting someone when it sends, not only when it was queued (Ferrum's closure review, FEO-015).

- A communication has a Purpose: Transactional (the default: a reply, a receipt, a confirmation) or Marketing (Campaigns marks its mail so).
- When an email goes out, each recipient is asked as they stand then: marketing goes to no one who withdrew their consent to it in any app; nothing goes to anyone whose processing is restricted. They are left out; with no one left, the email is Withheld, saying who and why. A withheld email can be retried, and is asked again.

## 0.10.13

The reports it defines in code (their titles and parameters) have names in Arabic and Hindi too, with its models' and manifest's (300 each in ui/src/locales/names). Translated by the model, to be reviewed by native speakers.

## 0.10.12

Rebuilt with Ferrum-Frontend 43d7779: the names of its models, fields and manifest in Arabic and Hindi (297 each in ui/src/locales/names, which the platform serves to every page of the workspace, so a record's labels, the launcher and the bar read in the person's language), and the sentences its pages still showed in English (split around a link or a figure, built in code from a template or word by word) whole and translated (562 words each in ui/src/locales). Translated by the model, to be reviewed by native speakers.

## 0.10.11

Rebuilt with Ferrum-Frontend 046a3a2: the sentences its pages built in code (counts, dates, what a toast or a screen reader says) go through t() too, as whole sentences where code chose a word, and carry built-in Arabic and Hindi (514 words each in ui/src/locales, translated by the model and to be reviewed by native speakers).

## 0.10.10

The assistant knows what its records mean in its pages (contributes.shell.assistant): their states, what counts and where figures come from, with questions it suggests asking there.

## 0.10.9

Rebuilt with Ferrum-Frontend 389b2af: its own words carry built-in Arabic and Hindi (493 words each, ui/src/locales, translated by the model and to be reviewed by native speakers), fetched for the page's language only. The labels it keeps in objects, its dialogs, its page titles and the words it keeps in variables go through t() as well, and the names and sizes it shows as they are keep their order right to left. Its pages are drawn once their words are in, and its entry carries only the parts of the kit it uses.

## 0.10.8

Rebuilt with Ferrum-Frontend 1f5981d: an action's link, code or token shown once is kept in a dialog to copy, and on a page that reads right to left, English left untranslated keeps its own order. Its own words go through the kit's t() (403 places), so a workspace's own words for its language reach them, and Admin, Interface words lists them under it (dist/words.json).

## 0.10.7

Rebuilt with Ferrum-Frontend 8a1c2e7: a workspace's own words for its interface (Admin, Interface words) reach its pages as they load; an attachment field that holds a picture shows it; and a value another record already has is said so, where the form said the record had been changed by someone else. Its own screens' margins, paddings, borders, alignment and insets go by the line's start and end, so they mirror right to left as the kit's do; what it places by coordinates (boards, timelines, charts, handles) stays as it was.

## 0.10.6

Rebuilt with Ferrum-Frontend 9d80f4f: right to left, its pages mirror as they read (icons that point along the line, margins and alignment by the line's start and end, arrow keys along it), and the records pages' words are in Arabic and Hindi.

## 0.10.5

Rebuilt with Ferrum-Frontend 204b713: a new record's box whose default is 1 shows ticked, as it is saved.

## 0.10.4

Rebuilt with Ferrum-Frontend 6cfda39: an action's dialog says every refusal, the errors on what the action made (another record's rows) among them, and an action with parameters and a confirmation asks once.

## 0.10.3

Rebuilt with Ferrum-Frontend b39fffb: its pages show times on a person's own clock when they chose one on their Account page, while today and due dates stay on the workspace's day.

## 0.10.2

Rebuilt with Ferrum-Frontend d350579: its pages show times on the workspace's clock, naming the zone when it is not the browser's, a draft numbered on submit is headed as a draft, and a record of an app that is not installed says so.

## 0.10.1

Rebuilt with Ferrum-Frontend 20d08e5: a record page reads an empty number or check as the server does, so an action whose condition needs one shows, and a workspace's settings open as their one record.

## 0.10.0

Attachments stream: an attachment is sent by the server straight from storage, whatever its size, instead of being read whole into memory first (Ferrum's SiteResponse::file, FERRUM-OPS-006).

## 0.9.3

Rebuilt with Ferrum-Frontend ae13c69: in a workflow state that names what may change, the other fields show read-only, and the fields the state needs show required.

## 0.9.2

Rebuilt with Ferrum-Frontend daeadda: after an action runs, a record page shows what the action said it did rather than only that it is done.

## 0.9.1

Rebuilt with Ferrum-Frontend 89b7cc7: a field's label names its control for assistive technology, and a record whose title is a link shows that record's title, not its id.

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
