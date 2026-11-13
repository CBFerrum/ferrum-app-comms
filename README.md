<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <img alt="Ferrum Mail, Chat and Calendar: mail, team chat, calendars and video meetings in one open workspace" src="docs/assets/banner-light.svg" width="100%">
</picture>

<br>

[![Version](https://img.shields.io/badge/version-0.20.0-2563eb?style=flat-square)](CHANGELOG.md)
[![Licence: AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![Ferrum platform](https://img.shields.io/badge/runs%20on-Ferrum-2f5bea?style=flat-square)](https://github.com/CBFerrum/Ferrum)
[![CI](https://github.com/CBFerrum/ferrum-app-comms/actions/workflows/ci.yml/badge.svg)](https://github.com/CBFerrum/ferrum-app-comms/actions/workflows/ci.yml)
![Rust](https://img.shields.io/badge/Rust-server-b7410e?style=flat-square&logo=rust)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-data-336791?style=flat-square&logo=postgresql&logoColor=white)
![React](https://img.shields.io/badge/React%20%2B%20TypeScript-interface-0ea5e9?style=flat-square&logo=react&logoColor=white)
![Tests](https://img.shields.io/badge/tests-80%20Rust%20%C2%B7%20188%20interface-16a34a?style=flat-square)

### Mail, team chat, calendars and video meetings, on the same data as the rest of your business.

Ferrum Comms is four apps in one repository: **Mail**, **Chat**, **Calendar** and **Meet**. It is for teams that want
a Gmail-and-Google-Calendar or Outlook-and-Teams style workspace that they host themselves, and that
knows about customers, tickets, orders and bookings. It replaces a mailbox service, a calendar, a team
chat tool and a video meeting service, and it keeps every message about a record on that record.

[💡 Why](#-why-ferrum-comms) · [📸 Screenshots](#-screenshots) · [✨ Features](#-features) · [📊 Compare](#-how-it-compares) · [📍 Roadmap](#-roadmap) · [🚀 Install](#-install) · [🔧 Develop](#-develop)

</div>

## 💡 Why Ferrum Comms

- 🏠 **Your mail, your server.** With a [Stalwart](https://stalw.art) mail server beside Ferrum, every person gets a real mailbox at your domain, kept in step with their account. Any mail program can use it too.
- 🔗 **One data set with the rest of Ferrum.** Mail about a lead, a ticket or an order is kept on that record's timeline. A calendar event can point at a record. Chat can share a record. CRM, Helpdesk and others can take inbound mail for their own addresses.
- 📖 **Open source, AGPL-3.0.** No per-seat licence. You run it, you own the data, and you can read every line.
- 🧩 **One interface, four apps.** Mail, Chat, Calendar and Meet share one bar, one sign-in, one set of permissions and one notification centre, each with its own launcher entry.
- 🔄 **Works with the programs people already use.** Calendars and address books sync over CalDAV and CardDAV; mail works with any IMAP and SMTP program through app passwords; events import and export as iCalendar.
- 🛡️ **Safe by design.** Mail is cleaned before it is shown, remote pictures stay blocked until asked for, marketing mail respects each person's consent, and a person's data can be exported and erased.
- 🌍 **Many languages and right to left.** The interface ships in English, Arabic and Hindi and mirrors for right-to-left languages.

## 🎯 At a glance

| | |
|---|---|
| 📦 **Version** | 0.20.0 |
| 🖥️ **Kind** | Its own interface: four shell apps at `/mail/`, `/chat/`, `/calendar/` and `/meet/` |
| ➕ **What it adds** | 21 entities in one package, 3 roles, 3 reports, 4 launcher apps, 3 intents, a side panel, bar search, 10 kinds of notification, 2 public pages |
| 🧱 **Depends on** | The platform's `core` and `contacts` packages. Nothing else is required |
| 🤝 **Works with** | Drive (attach files, save attachments), CRM and Helpdesk (inbound mail routing), Campaigns (marketing mail), Bookings and Live (meetings for records), every app with a record timeline |
| 🌍 **Languages** | English, Arabic, Hindi |
| 🧪 **Tests** | 80 Rust test functions (unit and database) and 188 interface tests, counted from the source |
| 📄 **Licence** | AGPL-3.0-only |

## 📸 Screenshots

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/mail-inbox-dark.webp"><img alt="Mail — the inbox with folders" src="docs/assets/screens/mail-inbox-light.webp" width="100%"></picture>
<p align="center"><b>✉️ Mail — the inbox with folders</b><br><sub>Folders, labels and saved searches on the left, conversations in the middle, the reading pane on the right.</sub></p>

### ✉️ Mail

<table>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/mail-conversation-dark.webp"><img alt="Mail — a conversation" src="docs/assets/screens/mail-conversation-light.webp"></picture>
<p><b>✉️ Mail — a conversation</b><br><sub>Read a conversation: messages in order, with reply, forward and the toolbar of actions.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/mail-selection-move-to-dark.webp"><img alt="Mail — several conversations selected, Move to" src="docs/assets/screens/mail-selection-move-to-light.webp"></picture>
<p><b>✉️ Mail — several conversations selected, Move to</b><br><sub>Select conversations to archive, delete, report, mark, star or move them together.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/mail-composer-rich-dark.webp"><img alt="Mail — the composer with a picture and an attachment" src="docs/assets/screens/mail-composer-rich-light.webp"></picture>
<p><b>✉️ Mail — the composer with a picture and an attachment</b><br><sub>Write with formatting, an inline picture and an attached file.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/mail-search-operators-dark.webp"><img alt="Mail — search with operator chips" src="docs/assets/screens/mail-search-operators-light.webp"></picture>
<p><b>✉️ Mail — search with operator chips</b><br><sub>Type from:, has:attachment or a word: the search turns into chips you can remove, and can be saved.</sub></p>
</td>
</tr>
</table>

<details>
<summary>📸 More Mail screens: invitations and settings</summary>

<table>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/mail-calendar-invitation-dark.webp"><img alt="Mail — a calendar invitation" src="docs/assets/screens/mail-calendar-invitation-light.webp"></picture>
<p><b>✉️ Mail — a calendar invitation</b><br><sub>An invitation shows the event with Yes, Maybe and No; your answer is sent back.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/mail-settings-general-dark.webp"><img alt="Mail settings — General" src="docs/assets/screens/mail-settings-general-light.webp"></picture>
<p><b>✉️ Mail settings — General</b><br><sub>Default reply, conversation view, density, reading pane, keyboard shortcuts and notifications.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/mail-settings-writing-dark.webp"><img alt="Mail settings — Writing, with a signature" src="docs/assets/screens/mail-settings-writing-light.webp"></picture>
<p><b>✉️ Mail settings — Writing, with a signature</b><br><sub>Undo-send time, the signature and templates.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/mail-settings-filters-dark.webp"><img alt="Mail settings — Filters" src="docs/assets/screens/mail-settings-filters-light.webp"></picture>
<p><b>✉️ Mail settings — Filters</b><br><sub>Filters run on the mail server as mail arrives.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/mail-settings-blocked-dark.webp"><img alt="Mail settings — Blocked senders" src="docs/assets/screens/mail-settings-blocked-light.webp"></picture>
<p><b>✉️ Mail settings — Blocked senders</b><br><sub>Senders you blocked; unblock with one click.</sub></p>
</td>
<td width="50%"></td>
</tr>
</table>

</details>

### 📅 Calendar

<table>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/calendar-week-dark.webp"><img alt="Calendar — week view" src="docs/assets/screens/calendar-week-light.webp"></picture>
<p><b>📅 Calendar — week view</b><br><sub>Your week with your calendars listed on the left; tick or untick a calendar to show or hide it.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/calendar-day-dark.webp"><img alt="Calendar — day view" src="docs/assets/screens/calendar-day-light.webp"></picture>
<p><b>📅 Calendar — day view</b><br><sub>One day, hour by hour.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/calendar-work-week-dark.webp"><img alt="Calendar — work week" src="docs/assets/screens/calendar-work-week-light.webp"></picture>
<p><b>📅 Calendar — work week</b><br><sub>Monday to Friday only.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/calendar-month-dark.webp"><img alt="Calendar — month view" src="docs/assets/screens/calendar-month-light.webp"></picture>
<p><b>📅 Calendar — month view</b><br><sub>The whole month, with events as bars.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/calendar-agenda-dark.webp"><img alt="Calendar — agenda" src="docs/assets/screens/calendar-agenda-light.webp"></picture>
<p><b>📅 Calendar — agenda</b><br><sub>A list of what is coming up, in order.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/calendar-year-dark.webp"><img alt="Calendar — year view" src="docs/assets/screens/calendar-year-light.webp"></picture>
<p><b>📅 Calendar — year view</b><br><sub>Twelve months at a glance.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/calendar-calendar-menu-dark.webp"><img alt="Calendar — a calendar&#x27;s menu" src="docs/assets/screens/calendar-calendar-menu-light.webp"></picture>
<p><b>📅 Calendar — a calendar&#x27;s menu</b><br><sub>Show only this calendar, rename and colour it, share it, make it the default or delete it.</sub></p>
</td>
<td width="50%"></td>
</tr>
</table>

### 💬 Chat

<table>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/chat-channel-list-dark.webp"><img alt="Chat — channels" src="docs/assets/screens/chat-channel-list-light.webp"></picture>
<p><b>💬 Chat — channels</b><br><sub>See your channels and direct messages; bold ones have unread messages.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/chat-conversation-dark.webp"><img alt="Chat — a conversation" src="docs/assets/screens/chat-conversation-light.webp"></picture>
<p><b>💬 Chat — a conversation</b><br><sub>Read and reply in a channel; mention a colleague with an at sign.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/chat-conversation-operations-dark.webp"><img alt="Chat — a working channel" src="docs/assets/screens/chat-conversation-operations-light.webp"></picture>
<p><b>💬 Chat — a working channel</b><br><sub>A channel used by the operations team to coordinate.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/chat-channel-details-dark.webp"><img alt="Chat — channel details" src="docs/assets/screens/chat-channel-details-light.webp"></picture>
<p><b>💬 Chat — channel details</b><br><sub>See a channel&#x27;s topic and members, and change how loudly it notifies you.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/chat-chat-search-dark.webp"><img alt="Chat — search messages" src="docs/assets/screens/chat-chat-search-light.webp"></picture>
<p><b>💬 Chat — search messages</b><br><sub>Search every conversation you can read for a word or phrase.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/chat-new-conversation-dark.webp"><img alt="Chat — start a conversation" src="docs/assets/screens/chat-new-conversation-light.webp"></picture>
<p><b>💬 Chat — start a conversation</b><br><sub>Start a direct message or create a channel for a team or topic.</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/chat-direct-message-dark.webp"><img alt="Chat — a direct message" src="docs/assets/screens/chat-direct-message-light.webp"></picture>
<p><b>💬 Chat — a direct message</b><br><sub>Talk privately with one colleague.</sub></p>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/meet-home-dark.webp"><img alt="Meet — home" src="docs/assets/screens/meet-home-light.webp"></picture>
<p><b>🎥 Meet — home</b><br><sub>Start a meeting now and share its link with people in your workspace.</sub></p>
</td>
</tr>
</table>

### 📱 On a phone

<p align="center">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/mail-inbox-phone-dark.webp"><img alt="Mail — the inbox with folders" src="docs/assets/screens/mail-inbox-phone-light.webp" width="260"></picture>
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens/mail-conversation-phone-dark.webp"><img alt="Mail — a conversation" src="docs/assets/screens/mail-conversation-phone-light.webp" width="260"></picture>
</p>
<p align="center"><sub>Folders, labels and saved searches on the left, conversations in the middle, the reading pane on the right. · Read a conversation: messages in order, with reply, forward and the toolbar of actions.</sub></p>

> [!NOTE]
> A call itself runs in the browser on a video server you operate, so only Meet's home is pictured. The screenshots follow your GitHub theme: switch between light and dark to see both.

## ✨ Features

### ✉️ Mail: reading and organising

- **Real mailboxes.** With a Stalwart mail server and a Mail Domain set in Communication Settings, every active person whose address is in the domain gets a mailbox. New people get one, a changed address moves it, and a person who leaves the domain is locked out while their mail stays.
- **Folders people know.** Inbox, Starred, Drafts, Sent, Archive, All mail, Spam and Trash each have an icon and the usual name, whatever the server calls them. Archive exists for everyone. Starred, All mail, Scheduled and Snoozed are virtual folders.
- **Your own folders.** Create, rename, nest, colour and delete folders (mail in a deleted folder goes to Archive). A conversation can also be filed under a second folder, shown as chips.
- **Conversations.** A folder lists conversations with how many messages each holds. Opening one shows its messages one under another, with the newest and unread ones open. Archive, delete, spam and unread act on the whole conversation.
- **The list.** A checkbox on every row, Shift+click to select a range, select all, and a bar to archive, delete, mark as spam or not spam, mark read or unread, star and move. Row hover shows the same actions. Counts and new mail arrive within seconds while Mail is open, without losing your place or selection.
- **Undo for everything.** Every move, flag and delete can be undone for eight seconds, exactly: folders and flags go back as they were, for a selection too. Restore from Trash and Spam; Empty Trash and Empty Spam say how long mail stays (30 days).
- **Search that reads like Gmail's.** One box over all mail with `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `is:starred`, `in:`, `before:`, `after:`, `older_than:`, `newer_than:`, quoted phrases, `-` and `OR`. The query becomes chips you can remove, or a form. Matches are marked, and a search can be saved as a folder.
- **Filters on the server.** When a message matches (from, to, subject, words, list, size) it can skip the inbox, go to a folder, be starred, marked read, forwarded, deleted or never sent to spam. Make one from a message or a search; apply it to matching mail on the spot, with Undo. Filters run on the mail server as one Sieve script that Mail owns, and a person's own script is never overwritten, so filters follow you to any mail program.
- **Snooze.** Snooze to later, tomorrow, next week or a date. Snoozed mail returns to the Inbox, unread, at its time, whether Mail is open or not.
- **Spam and safety.** Report spam and not spam per row, in bulk or by key. A message in Spam says why it is there. Block a sender, report phishing, and see a warning when a message failed its sender checks or claims your own domain without passing them. Mail from outside the workspace is marked External.
- **Remote pictures blocked.** Pictures from the web stay blocked behind one bar, with "always show from this sender". HTML mail is made safe before it is shown: no scripts, forms or tracking styles.
- **One-click unsubscribe.** Where a message offers it, Mail's server asks the sender's own address over HTTPS only, never a private address, and does not follow a redirect.
- **Attachments.** Pictures and PDFs preview in place. Save an attachment to Drive, or download all of a message's attachments as one zip (up to 100 MB).
- **Show original.** See the full source and headers with Copy and a `.eml` download. Print a conversation as a document.
- **Delivery status.** A sent message says whether it was delivered, is on its way or was refused, with the receiving server's words (kept for 3 days).
- **Import and export.** Import `.eml` and `.mbox` files; export a folder or a selection as `.mbox`.
- **Largest conversations.** A list of the conversations that take the most space, to free room.
- **Keyboard.** `j` and `k`, Enter, `r`, `a`, `f`, `e`, `x`, `#`, `!`, `v`, `l`, `z`, `u`, `s`, `c`, Shift+I, Shift+U, `/` and `?` for the shortcut help.

### 📝 Mail: writing and sending

- **A rich-text composer.** Bold, italic, underline, strikethrough, colour, highlight, size, lists and check lists, quotes, alignment, links (Ctrl or ⌘ K), tables and pictures, with paste from Word and Google Docs. A plain-text switch is one click away. What you write is cleaned by rules before every draft save and every send, and the server cleans again.
- **A window with presence.** Minimise, full screen, pop out to a browser window of its own, close. Several windows share the screen, a window resizes by its corner and the next opens at that size. On a phone one composer fills the screen.
- **Recipients as chips.** To, Cc and Bcc are checked as you type, with suggestions from the workspace and from people you have written to. From shows only when you have a choice.
- **Attachments.** Drop, paste, the button, or pick from Drive, with progress, cancel and retry and the limits said first. Pictures go inline as parts of the message and resize by a corner. Forwards carry the original's attachments and pictures without uploading them again.
- **Replies that behave.** Reply and Reply all go where they should and never answer your own draft. The original stays folded under your answer until you open it.
- **Nothing written is lost.** A draft is saved a moment after the last key and says so truthfully ("Saving", "Saved to Drafts", "Could not save, retrying"). Words typed just before a crash come back from the browser, open messages reopen after a reload, sending leaves no stray draft, and discarding can be undone.
- **Undo send and schedule send.** Undo send holds a message 5 to 30 seconds. Schedule send offers tomorrow morning, Monday morning or a picked time, with a Scheduled list to edit or cancel. The mail server itself holds both, so they do not depend on the tab staying open.
- **A check before sending.** A message that mentions an attachment and has none, or has no subject, asks first.
- **Signatures per identity** with pictures, kept on the mail server so other mail programs share them.
- **Templates** live in a Templates folder for canned replies.
- **Vacation reply** with dates on your own clock, written in the same editor and sent as HTML and plain text.
- **Forwarding** as a filter action: it asks first, refuses the mailbox's own address and shows a banner while it is on.

### 📮 Mail: invitations and the calendar

- **Answer from the message.** A message with an invitation shows the event with Yes, Maybe and No. The answer updates your calendar and goes to the organiser.
- **Emailed answers are applied.** A guest's reply by mail updates the organiser's event on arrival, only from an invited guest, and from outside the workspace only when the mail server could vouch for the sender (DMARC or a DKIM signature). Otherwise the card says the sender could not be verified.
- **Cancellations by mail** cancel the event, or the one occurrence they name, when they come from the person who invited you.
- **Propose a new time** from an invitation; an outside organiser receives it as an iCalendar counter-proposal.

### 🏢 Mail: administration and hosted mail

- **Administration** (Comms Managers): every mailbox with what it holds and a storage limit with what happens at the limit; shared mailboxes and their members; how often people marked mail as spam or not spam in the last 30 days; senders the whole workspace allows or blocks (an address, or a domain with its subdomains); how long Trash and Spam are kept. Every change is in the audit trail.
- **Shared mailboxes.** An address such as `sales@` with members who read, answer and send. Members see it as one more account, and access changes at once when someone is added, removed or leaves.
- **Distribution lists.** An Email Group with a list address becomes a mailing list on the mail server and passes mail to members who have not unsubscribed.
- **Mail domain health.** A screen for Comms Managers lists the DNS records the domain's mail needs (MX, SPF, DKIM, DMARC), which are published, which are missing or different and what to do, with copy buttons and a zone file download. Reverse DNS and port 25 are listed as checks to do by hand.
- **Mail programs.** App passwords let phones and desktop mail programs use the same mailbox.
- **Notifications with no tab open.** Within about a minute of arrival, new unread Inbox mail becomes one notification ("New message from Ann Lee" or "3 new messages"), never showing the body. It goes where the person chose: the bar, email, the daily digest or their phone. Mail's own setting decides what counts: everything, only people you have written to, or nothing.

### 🧾 Mail on business records

- **Email accounts.** Add SMTP accounts for sending and IMAP polling or an inbound webhook for receiving, per company, with one default account per company and one shared. Passwords are sealed secret fields that never reach lists, exports or the audit trail.
- **Communication log.** Every email sent or received about a record is a Communication threaded on that record: status (Queued, Sending, Sent, Failed, Received), sender, recipients, HTML cleaned for display, attachments, and thread. Calls, meetings and notes sit in the same timeline.
- **Reliable sending.** Retries back off from 1, 4, 16 and 64 minutes up to six hours until a limit; permanent failures (a 5xx reply, an invalid address) fail at once. The author is notified when an email fails and can retry it.
- **Templates with fields.** An Email Template fills `{{ doc.field }}` from the record the mail is sent from, with a preview. Values are escaped.
- **Inbound mail creates records.** An account can map a new inbound thread to a new record (a Lead or Ticket, for example). Auto-replies and bounces never create records. Received mail is de-duplicated by Message-ID.
- **Newsletters.** Send to email groups in batches within an hourly limit, once per address, never to people who unsubscribed. Each mail carries a personal signed unsubscribe link and the `List-Unsubscribe` headers. Status runs Draft, Scheduled, Sending, Sent or Cancelled, with counts of recipients, sent and failed.
- **Consent respected.** A communication has a Purpose, Transactional or Marketing. As mail goes out, each recipient is checked as they stand: marketing skips anyone who withdrew consent in any app, and nothing goes to anyone whose processing is restricted. If no one is left the email is Withheld, saying who and why.
- **Extra headers for bulk senders.** Apps that queue mail can set `List-Unsubscribe`, `List-Id`, `Precedence`, `Auto-Submitted`, `Feedback-ID` and `X-` headers from an allow-list.
- **Received mail keeps its headers.** Message-ID, In-Reply-To, References, Reply-To, delivered-to, Auto-Submitted, List-Id, Return-Path, the auto-reply and bounce markers, and the sender check result are stored with each received message and erased with the sender.
- **Mail for other apps.** An app can send with Reply-To, threading headers and an envelope sender on a workspace domain, and get the Message-ID back. It can register an address or pattern (`ticket-*@`, plus-addressing) to take inbound mail once, behind a savepoint, so a failing handler loses nothing. Hosted mail can raise `MailMessage.received` and `MailMessage.sent` events (ids, addresses, thread, subject, never the body) once per message, off until the owner turns it on and never for a mailbox a manager marks private.

### 📅 Calendar: views and events

- **Six views.** Day, work week, week, month, agenda and year, with Today, previous and next, a small month to jump to a date, the current time, working hours shaded and an optional second time zone down the side. The view and date are in the address, so a link opens the same view.
- **On a phone.** The day comes first, three days stand in for a week, and the month shows dots with the chosen day's list beneath.
- **Quick creation.** Click or drag on empty time for a quick form (title, time, guests, More options). Drag an event to move it and its lower edge to resize it in 15-minute steps, or use Alt and the arrow keys. Every change offers Undo.
- **The event editor.** Title, start and end, all day, time zone with your own time beside it when they differ, place with an "Open in maps" link, video meeting, guests, reminders, category, visibility (Private or Public), status (Confirmed, Tentative, Cancelled) and a link to a business record.
- **Rich notes and files.** Notes are written in Mail's editor, made safe as Mail makes outgoing mail safe, and written into calendar files as plain text and HTML. Attach up to 20 files from Drive by reference; a guest who cannot open one is told whom to ask, and the organiser is offered to share it.
- **Repeating events done right.** Daily, weekly, monthly and yearly rules with interval, weekdays, `1MO` and `-1FR` style positions, month days, count or until. A weekly 09:00 London meeting stays at 09:00 across daylight saving; a time the spring jump skips is read as phones and Google Calendar read it. Every change and delete of a repeating event asks: this event, this and following, or all events.
- **All-day and multi-day events** repeat as dates; an all-day event does not make you busy all day.
- **Search** by title, guest, place or notes, in Calendar and from the bar's search, showing only events the person may see.
- **Keys.** `d`, `x`, `w`, `m`, `a`, `y`, `t`, `j`, `k`, `n`, `p`, `c`, `/` and `?`.

### 👥 Calendar: guests, scheduling and rooms

- **Guests and answers.** Colleagues get a notification and answer Yes, Maybe or No with a note. Outside guests get an email with an iCalendar invitation and links to a public page of Calendar's own, signed for that event and address, to answer without an account. The event lists each guest's answer.
- **Find a time.** Draws each colleague's busy time (never why), working hours and time away, warns of a clash, and suggests only times inside everyone's hours, each on their own clock. Someone outside the workspace shows as no information.
- **Working hours and time away.** Set your days and hours in your zone, and an out-of-office period that can decline new invitations in it with your message and links to Mail's vacation reply.
- **Propose a new time.** A guest proposes from the event or from an invitation in Mail. Only the organiser sees proposals, and accepts (the event or that one occurrence moves and guests are told) or declines.
- **Rooms and resources.** Comms Managers keep rooms and resources with a capacity, a place, bookable hours and who may book. Add one to an event like a guest: it answers at once, with the reason when it cannot. Two bookings of the same time get the room only once, which a database test holds. Find a time lists free rooms that are big enough.
- **Reminders** are notifications, once per occurrence and reminder, to the organiser and to guests who have not declined.

### 🗓️ Calendar: many calendars and sharing

- **Your calendars.** "Personal" to start, and any you make, each with a colour. Show or hide each, show only one, rename, recolour, make one the default, or delete it and say where its events go.
- **Sharing at three levels.** Free and busy only, all details, or make changes. Share with a person or a group (a role); remove someone and access ends at once. A "Busy only" event keeps its details to you and its guests even in a shared calendar.
- **One rule for every way in.** The same visibility rule applies to the events list, search, an event's detail, the bar's search, changes, the feed, export and CalDAV, and a database test walks every route at each level.
- **Subscribe by address.** Paste an `.ics` or `webcal://` address, or use Add holidays. The address must be HTTPS and public, redirects are not followed, feeds over 5 MB are refused, and a feed is fetched at most hourly. Subscribed events are read-only and do not invite anyone.
- **Files and feed.** Import an `.ics` file (re-importing the same UIDs updates), export your calendar, and copy, renew or turn off a secret feed address that Google Calendar, Outlook and phones can subscribe to.
- **Calendar programs.** Every calendar, and every calendar shared with you, is its own CalDAV collection with its name and colour, with sync tokens. Apple Calendar, Thunderbird, DAVx⁵ and Outlook sync both ways. Two read-only address books (the workspace's people, and the CRM contacts you may read) sync over CardDAV.
- **My work.** Invitations to answer appear in the platform's My work list on Home.

### 💬 Chat

- **Channels.** Public channels everyone can find and join, private channels that do not exist for non-members, and one direct conversation per pair of people. Names are unique. Archive a channel to end it.
- **Messages.** Markdown messages up to 4 KB, with `@` completion to mention people (in a private conversation, only those who can read it). Edit your own messages; delete your own, or any as a channel owner or Chat Admin (the text and files are erased and the message stays as deleted).
- **Threads.** Reply in a thread; a thread shows the message it belongs to; replies to a reply join the thread.
- **Files.** Attach files from your computer, up to 25 MB, that channel members can download.
- **Unread that is right.** Counts include replies in threads you started or answered, mentions are counted apart, and someone who joins a channel starts with nothing unread. A conversation opens at its first unread message, marks itself read only when you reach the bottom, and any message can be marked unread again. "Mark everything as read" is in the list's menu, and the bar shows how much waits.
- **How loud a channel is.** Every message, mentions and replies to you, or nothing (muted, with no count, though a mention still marks it). Direct messages notify, replies notify the people of their thread.
- **Channel details.** Name and topic, who can find it, who can post (every member, or only owners start posts while members reply in threads), your notification level, leaving, and members that owners add, remove and make owners. The last owner cannot be demoted.
- **Presence.** A green dot and "Active now" show whether a person made a request in the last ten minutes, and never when they were last seen.
- **Search.** The bar's search finds messages in public channels and your own, and Chat can search one conversation on its own, each result opening in its place.
- **Drafts are kept.** Unsent text is kept for each conversation and thread in the browser. A message that cannot be sent says why and stays.
- **Live.** New messages, edits, deletes, read state and membership changes are pushed to open sessions.
- **Calls from a channel.** Start a video call in any channel you can read.
- **Share a record.** From any app, "Share in Chat" posts a record into a conversation, and Chat is also the bar's side panel on every screen.
- **Phones.** Lines wrap and the composer stays in view.

### 🎥 Meet

- **Video meetings on your server.** Meetings run on a [LiveKit](https://livekit.io) server you operate. Comms decides who may join and signs the access tokens; sound and pictures never pass through Ferrum.
- **Three kinds of meeting.** A channel's call (whoever may read the channel), an event's call (its organiser and guests, or anyone for a public event) and a room anyone in the workspace can start and share.
- **Guests join by link.** People outside the workspace join as "Name (guest)" with no account. A room has a guest link you can turn on, renew or turn off; an event's outside guest gets their own signed link in the invitation.
- **In the call.** Device check before joining, camera, microphone, screen sharing and the meeting's own chat. On a phone a call opens over the page and keeps the screen awake, and a browser with no camera or microphone can join to listen.
- **Pop out.** Put the call in a small always-on-top window (Document Picture-in-Picture; a floating speaker video in Safari) while you work in other apps. Calls from Chat and Calendar open in a companion window that outlives the page.
- **Captions and transcripts.** Each person can caption their own voice with their browser's speech recognition (the button says the browser may send the voice to its maker). Captions show to everyone and are kept as the meeting's transcript, per speaker, and are part of that person's personal-data copy and erasure. Guests' captions show but are not kept.
- **Recordings.** Where the operator runs LiveKit Egress with storage (`FERRUM_MEET_RECORDINGS=true`), anyone in the meeting can record. The person confirms first, everyone sees "Recording", and the meeting lists where each file went.
- **Honest when not set up.** Where meetings are not configured, the page, a guest's link and the calendar say so and offer no call.
- **Meetings for other apps.** The public `ferrum_app_comms::meetings` module creates a meeting for another app's record (a booking, a live class), gives members and outside guests their join links, reschedules, ends, and reports attendance: each joining with its time, accurate to about a minute, counted once across devices, and part of a person's personal-data copy. Such meetings are rooms, in nobody's calendar, and are removed 90 days after they were due to end.

### 🔔 Notifications, search and the platform

| Where | What |
|---|---|
| 🚀 Launcher | Mail, Chat, Calendar and Meet |
| ➕ Create menu | Email |
| 🔀 Intents | Write an email (to, cc, subject, body, attachments), Schedule a meeting (subject, times, attendees, place, meeting, record), Share in Chat (a record) |
| 🗔 Side panel | Chat on every screen |
| 🔎 Bar search | Chat messages and Calendar events the person may read or see |
| ✅ My work | Calendar invitations to answer |
| 🌐 Public pages | A meeting's guest page, and where a guest answers an invitation |
| 🔔 Notification kinds | Calendar invitations, answers to your invitations, event reminders, mentions, direct messages, thread replies, every message in channels you hear in full, new mail, replies to email you sent, undelivered email. Each person chooses how each reaches them |
| 🤖 Assistant | Knows the records and suggests questions such as "What meetings do I have tomorrow?" and "Which emails to customers failed to send today?" |

### 🔐 Permissions, privacy and accessibility

- **Roles.** Comms User, Comms Manager and Chat Admin (below). Private channels and conversations answer "not found" to non-members.
- **Row-level security and audit** come from the platform: every record, including through the REST and MCP APIs, follows the same rules and audit trail.
- **Personal data.** A person's request for their data reaches the messages they sent, chat messages, mailing lists they are on, calendar feeds and meeting captions and attendance; an erasure blanks them.
- **Languages and direction.** English, Arabic and Hindi, including the names of reports; right-to-left mirrors the screens.
- **Accessibility.** Controls are named for assistive technology and every action has a key. A screen-reader audit has not been done yet.

## 🧭 How it works

### Mail, on records and in mailboxes

```mermaid
flowchart LR
    P["Person writes in Mail - or from a record"] --> OUT["Outgoing mail - sent once, retried"]
    OUT --> SMTP[("SMTP or hosted mail server")]
    IN[("IMAP, webhook or hosted mailbox")] --> RECV["Inbound mail"]
    RECV -->|threaded| REC["The record it answers - lead, ticket, order"]
    RECV --> APPS["Apps that registered - an address or pattern"]
    OUT --> REC
    REC --> TL["Record timeline - emails, calls, notes"]
    classDef app fill:#2563eb,color:#fff,stroke:#2563eb
    class OUT,RECV,TL app
```

Two things work side by side. **Email accounts** (SMTP, IMAP or a webhook) send and receive mail about records and keep it on the record's timeline. **Hosted mail** gives each person a full mailbox on a Stalwart server, which Mail's own screens read and write. Apps can register an address, so a received message goes to the app that owns it once.

### Calendar, invitations and meetings

```mermaid
flowchart TD
    EV["Event in Calendar"] --> IN["Colleagues: notification"]
    EV --> OUT["Outside guests: email with iCalendar"]
    OUT --> ANS["Answer by link, by Mail or by their calendar"]
    IN --> ANS
    ANS --> EV
    EV --> MEET["Meet room, signed by Comms"]
    EV --> DAV["CalDAV, feed and export"]
    MEET --> LK[("LiveKit server you run")]
```

An event notifies colleagues inside Ferrum and emails outsiders an iCalendar invitation with answer links. Any answer, whether from the notification, the public page, Mail or the guest's own calendar program, lands on the event. The event's video link opens a Meet room; Comms signs the token and the call runs on your LiveKit server.

### Inside Ferrum

```mermaid
flowchart LR
    subgraph Browser
        UI["Mail, Chat, Calendar, Meet"]
        BAR["Ferrum bar - search, bell, side panel"]
    end
    subgraph Server["Ferrum server"]
        API["REST, MCP, live"]
        K["Kernel - permissions, RLS, audit"]
        APP["Comms - 21 entities, 3 roles"]
    end
    DB[("PostgreSQL")]
    UI --> API --> K --> DB
    BAR --> API
    K <--> APP
    APP --> ST[("Stalwart mail")]
    APP --> LK[("LiveKit")]
```

Everything Comms adds is ordinary Ferrum metadata and Rust, so its records get lists, forms, search, permissions, an audit trail and the REST and MCP APIs, and AI agents work with them under the same rules as people.

## 🧱 Data model

| Entity | What it is | Key fields |
|---|---|---|
| Communication | The message log of every record: emails, calls, meetings, notes | subject, channel, direction, status, purpose, sender, recipients, thread, headers, attachments, reference to a record |
| EmailAccount | A mailbox for SMTP sending and IMAP or webhook receiving | account name, address, company, default outgoing, SMTP and IMAP settings (secrets sealed) |
| EmailTemplate | Subject and HTML body with record fields | name, record type, subject, body |
| EmailGroup, EmailGroupMember | A mailing list and its members | list address, member email, unsubscribed |
| Newsletter (and NewsletterEmailGroup) | A batch email to groups | subject, groups, content, schedule, status, counts |
| CommsSettings | Workspace settings | public URL, hourly newsletter limit, send attempts, mail domain |
| HostedMailbox | A person's mailbox on the hosted mail server | email, status, last sync |
| SharedMailbox, SharedMailboxMember | A mailbox several people read and answer | address, display name, members |
| Calendar | A person's calendar, a subscription, or a room or resource | name, owner, colour, default, subscription address, capacity, place |
| CalendarEvent | An event | subject, times, time zone, all day, place, meeting link, notes, attachments, visibility, status, recurrence, exceptions, reminders |
| CalendarEventAttendee, CalendarEventReminder | Guests with answers, and reminders | email, response, comment, minutes before |
| CalendarShare, CalendarBooker | Who a calendar is shared with and at which level; who may book a room | person or role, level |
| CalendarFeed | A person's secret feed address | person, token |
| ChatChannel, ChatChannelMember | A channel and its members | name, type, topic, archived, post policy, role, last read, notification level |
| ChatMessage | A Markdown message | channel, sender, body, parent, mentions, attachments, edited, deleted |

### 👥 Roles

| Role | What it can do |
|---|---|
| **Comms User** | Sends mail from records they can read, chats with colleagues, keeps a calendar and reads the shared address book |
| **Comms Manager** | Manages email accounts and their credentials, templates, mailing lists, newsletters, shared mailboxes, rooms, settings and every communication |
| **Chat Admin** | Moderates chat through the generic API: every channel and message, private ones included |

### 📊 Reports and jobs

- **Reports:** Email Activity (sent, received, failed and waiting per account and day), Newsletter Performance (recipients, delivered, unsubscribes) and Chat Activity (messages and active members per channel).
- **Background work, every minute:** retry due mail, poll IMAP accounts, start due newsletters and send batches, announce reminders, look at new hosted mail for notifications and snoozes, refresh subscribed calendars, keep hosted mailboxes in step (every ten minutes), poll meeting attendance, and remove rooms and old reminder bookkeeping.

## 🔌 Integrations

| With | How | Needs |
|---|---|---|
| Stalwart mail server | Hosted mailboxes, shared mailboxes, lists, Sieve filters, JMAP | A Stalwart server; `FERRUM_MAIL_URL`, `FERRUM_MAIL_ADMIN`, `FERRUM_MAIL_ADMIN_SECRET`; a Mail Domain |
| SMTP and IMAP | Email accounts for sending, receiving and polling | Account credentials |
| Inbound webhook | Raw MIME up to 32 MB posted to a secret URL | A public URL in Communication Settings |
| LiveKit | Video meetings, captions, recordings (Egress) | `FERRUM_MEET_URL`, `FERRUM_MEET_KEY`, `FERRUM_MEET_SECRET`; for recordings `FERRUM_MEET_RECORDINGS` and optionally `FERRUM_MEET_API_URL` |
| CalDAV and CardDAV | Apple Calendar, Thunderbird, DAVx⁵, Outlook | An app password (an API key of scope `dav`) |
| iCalendar | Invitations, `.ics` import and export, a secret feed, `webcal://` subscriptions | Nothing |
| Drive | Attach files to mail and events; save attachments | The Drive app |
| CRM, Helpdesk and other apps | Register inbound addresses; send with threading; file mail to records | The app itself |
| Campaigns | Marketing mail marked with a Purpose and consent checked | Campaigns |
| Webhooks and automations | Outbox events such as `Communication.created` and `MailMessage.received` | Platform webhooks |

## 📊 How it compares

Mail and Calendar are compared with Gmail and Google Calendar in Google Workspace, Outlook in Microsoft 365, Zoho Mail and Nextcloud, the open and self-hosted option. Chat is compared with Slack, Microsoft Teams, Mattermost and Nextcloud Talk. Meet is compared with Google Meet, Zoom, Microsoft Teams and Jitsi Meet.

### ✉️ Mail

| Capability | Ferrum Mail | Gmail | Outlook | Zoho Mail | Nextcloud Mail |
|---|:-:|:-:|:-:|:-:|:-:|
| Threaded conversations | ✅ | ✅ | ✅ | ✅ | ✅ |
| Nested and coloured folders | ✅ | ✅ | ✅ | ✅ | ✅ |
| Search operators and saved searches | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Server-side filters | ✅ | ✅ | ✅ | ✅ | ✅ |
| Snooze | ✅ | ✅ | ✅ | ✅ | ✅ |
| Undo send | ✅ | ✅ | ✅ | ✅ | ✅ |
| Schedule send | ✅ | ✅ | ✅ | ✅ | ✅ |
| Rich composer with inline pictures | ✅ | ✅ | ✅ | ✅ | ✅ |
| Signatures, templates, vacation reply | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Phishing and sender-check warnings | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Spam filtering and reporting | 🟡 ¹ | ✅ | ✅ | ✅ | 🟡 |
| Virus scanning of attachments | ❌ | ✅ | ✅ | ✅ | 🟡 |
| Read receipts | ❌ | ✅ | ✅ | ✅ | 🟡 |
| Send importance (high, low) | ❌ | ❌ | ✅ | ✅ | ❌ |
| Shared mailboxes | 🟡 ² | ✅ | ✅ | ✅ | 🟡 |
| Delegate access to your own mailbox | ❌ | ✅ | ✅ | ✅ | 🟡 |
| Offline in the browser | ❌ | ✅ | ✅ | 🟡 | ❌ |
| Native mobile apps | ❌ | ✅ | ✅ | ✅ | ✅ |
| AI drafting and summaries inside Mail | ❌ | ✅ | ✅ | ✅ | 🟡 |
| Import `.eml` and `.mbox`, export `.mbox` | ✅ | 🟡 | ✅ | ✅ | ❌ |
| Per-mailbox quotas and domain DNS health | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Mail kept on business records, apps take inbound mail | ✅ | ❌ | 🟡 | 🟡 | ❌ |
| Mailing lists and newsletters | ✅ | 🟡 | 🟡 | 🟡 | ❌ |
| Marketing consent checked at send time | ✅ | ➖ | ➖ | ➖ | ➖ |
| Self-hosted | ✅ | ❌ | ❌ | ❌ | ✅ |
| Open source | ✅ | ❌ | ❌ | ❌ | ✅ |
| No per-user licence fee | ✅ | ❌ | ❌ | 🟡 | ✅ |

¹ Spam filtering is done by the Stalwart mail server; Mail adds reporting, Spam folder tools, blocked senders and workspace allow and block lists.
² Members read, answer and send. A read-only member is not built.

### 📅 Calendar

| Capability | Ferrum Calendar | Google Calendar | Outlook Calendar | Zoho Calendar | Nextcloud Calendar |
|---|:-:|:-:|:-:|:-:|:-:|
| Day, week, month, agenda and year views | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Repeating events correct across daylight saving | ✅ | ✅ | ✅ | ✅ | ✅ |
| Drag to move and resize, with undo | ✅ | ✅ | ✅ | ✅ | ✅ |
| Guests, answers and iCalendar invitations | ✅ | ✅ | ✅ | ✅ | ✅ |
| Find a time and suggestions | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Propose a new time | ✅ | ✅ | ✅ | 🟡 | ❌ |
| Rooms and resources | ✅ | ✅ | ✅ | ✅ | ✅ |
| Several calendars with colours | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sharing at free-busy, details and edit levels | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Share a calendar with a group | ✅ | ✅ | ✅ | ✅ | ✅ |
| Subscribe to an `.ics` feed | ✅ | ✅ | ✅ | ✅ | ✅ |
| Working hours and out of office | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Video link on an event | ✅ | ✅ | ✅ | ✅ | ✅ |
| Files attached from cloud storage | ✅ | ✅ | ✅ | ✅ | 🟡 |
| CalDAV for phone and desktop programs | ✅ | ✅ | ❌ | ✅ | ✅ |
| Public holidays in one click | 🟡 ¹ | ✅ | ✅ | ✅ | 🟡 |
| Booking pages for outsiders | 🟡 ² | ✅ | ✅ | ✅ | ✅ |
| Tasks and to-dos | ❌ | ✅ | ✅ | ✅ | ✅ |
| Event linked to a business record | ✅ | ❌ | ❌ | 🟡 | ❌ |
| Native mobile apps | ❌ | ✅ | ✅ | ✅ | ✅ |
| Self-hosted and open source | ✅ | ❌ | ❌ | ❌ | ✅ |

¹ Add holidays subscribes to a public holiday feed by its address; the platform does not yet give apps the workspace's working calendar.
² Public booking pages are the Bookings app, which uses Comms meetings and calendars.

### 💬 Chat

| Capability | Ferrum Chat | Slack | Microsoft Teams | Mattermost | Nextcloud Talk |
|---|:-:|:-:|:-:|:-:|:-:|
| Public and private channels | ✅ | ✅ | ✅ | ✅ | ✅ |
| Direct messages | ✅ | ✅ | ✅ | ✅ | ✅ |
| Group direct messages | ❌ | ✅ | ✅ | ✅ | ✅ |
| Threads | ✅ | ✅ | ✅ | ✅ | ✅ |
| Mentions with notifications | ✅ | ✅ | ✅ | ✅ | ✅ |
| Per-channel notification level | ✅ | ✅ | ✅ | ✅ | ✅ |
| Right unread markers | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit and delete | ✅ | ✅ | ✅ | ✅ | ✅ |
| File sharing | ✅ | ✅ | ✅ | ✅ | ✅ |
| Search | ✅ | ✅ | ✅ | ✅ | ✅ |
| Emoji reactions | ❌ | ✅ | ✅ | ✅ | ✅ |
| Pinned messages | ❌ | ✅ | ✅ | ✅ | 🟡 |
| Typing indicator | ❌ | ✅ | ✅ | ✅ | ✅ |
| Link previews | ❌ | ✅ | ✅ | ✅ | ✅ |
| Custom status | ❌ | ✅ | ✅ | ✅ | ✅ |
| Guest access to chat | ❌ | ✅ | ✅ | ✅ | ✅ |
| Message retention rules | ❌ | ✅ | ✅ | ✅ | ✅ |
| Bots, apps and incoming webhooks | ❌ | ✅ | ✅ | ✅ | ✅ |
| Video call from a channel | ✅ | ✅ | ✅ | 🟡 | ✅ |
| Share a business record into a chat | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| Native mobile apps | ❌ | ✅ | ✅ | ✅ | ✅ |
| Self-hosted | ✅ | ❌ | ❌ | ✅ | ✅ |
| Open source | ✅ | ❌ | ❌ | 🟡 | ✅ |

### 🎥 Meet

| Capability | Ferrum Meet | Google Meet | Zoom | Microsoft Teams | Jitsi Meet |
|---|:-:|:-:|:-:|:-:|:-:|
| Join by link as a guest, no account | ✅ | ✅ | ✅ | ✅ | ✅ |
| Device check before joining | ✅ | ✅ | ✅ | ✅ | ✅ |
| Screen sharing | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chat inside the call | ✅ | ✅ | ✅ | ✅ | ✅ |
| Captions | 🟡 ¹ | ✅ | ✅ | ✅ | 🟡 |
| Recording | 🟡 ² | ✅ | ✅ | ✅ | 🟡 |
| Raise hand and reactions | ❌ | ✅ | ✅ | ✅ | ✅ |
| Waiting room or lobby | ❌ | ✅ | ✅ | ✅ | ✅ |
| Host controls (mute others, remove, end for all) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Breakout rooms | ❌ | ✅ | ✅ | ✅ | ✅ |
| Background blur | ❌ | ✅ | ✅ | ✅ | ✅ |
| Choice of layouts | 🟡 | ✅ | ✅ | ✅ | ✅ |
| Dial in by phone | ❌ | ✅ | ✅ | ✅ | 🟡 |
| Pop-out call window | ✅ | 🟡 | ✅ | ✅ | 🟡 |
| Calendar link on events | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Meetings made for another app's records, with attendance | ✅ | ❌ | 🟡 | 🟡 | ❌ |
| Self-hosted | ✅ | ❌ | ❌ | ❌ | ✅ |
| Open source | ✅ | ❌ | ❌ | ❌ | ✅ |

¹ Each person captions their own voice with their browser's speech recognition; there is no automatic captioning of everyone.
² Needs LiveKit Egress and storage, run by the operator.

### 🏆 Where Ferrum Comms stands out

- 🔗 Mail, events, chat and meetings live next to your customers, tickets, bookings and ledger, with the same permissions and audit trail.
- 🧩 Other apps build on it: inbound mail routing, threaded sending, meetings with attendance and one-click "Share in Chat" or "Schedule a meeting" intents.
- 🛡️ Marketing mail checks each recipient's consent at send time, and personal data requests reach mail, chat, calendars and captions.
- 📖 Open source and self-hosted, with no per-seat licence and no data leaving your servers except mail itself.
- 🕐 Careful calendar rules: repeating events across daylight saving, one visibility rule for every way in, rooms that cannot be double booked.
- 🔁 Plays well with others: CalDAV, CardDAV, IMAP and SMTP, iCalendar feeds and `webcal://` subscriptions.

### 🚧 Where the leaders are still ahead

- 📱 Native mobile apps and offline use. Comms is a web interface that adapts to a phone.
- 🤖 AI help inside Mail, Chat and Calendar.
- 💬 Chat depth: reactions, pins, typing indicators, link previews, group direct messages, guests, retention rules, bots and custom status.
- 🎥 Meeting controls: raise hand, waiting room, host controls, breakout rooms, background blur and dial-in.
- ✉️ Mail extras: attachment virus scanning, read receipts, importance, mailbox delegation and read-only shared mailboxes.
- ✅ Tasks and a public holiday calendar built in.

> [!NOTE]
> Leader columns are from public product information as of November 2026 and may change. Nextcloud and Jitsi features depend on the apps and server components an administrator installs; a 🟡 there means "available with extra setup or in part".

## 📍 Roadmap

### ✅ Recently shipped

- [x] **0.20.0**: Mail for other apps. Received mail keeps its headers, apps send with Reply-To and threading and get the Message-ID, apps register inbound addresses, and mailboxes can be filed without a person.
- [x] **0.19.0**: A composer on the kit's rich-text editor, in a window with presence, with pictures as parts, rich vacation replies and signatures.
- [x] **0.18.0**: Calendar sharing with groups, every calendar over CalDAV, subscriptions by address, proposing a new time, rich notes and Drive files, rooms and resources.
- [x] **0.17.0**: Several calendars with colours and sharing at three levels enforced on the server for every route.
- [x] **0.16.0**: Repeating events right across daylight saving, six views, drag to move and resize with Undo, working hours and time away, a scheduling assistant, search.
- [x] **0.15.0**: Meetings other apps can make for their records, with guest links and attendance.
- [x] **0.14.0**: Mail on the server: new-mail notifications with no tab open, calendar answers and snoozed mail on arrival, administration and one-click unsubscribe.

### 🔜 Next up

**Mail**
- [ ] A settings switch for filing every message of a mailbox (the endpoints exist; the screen does not).
- [ ] A read-only member of a shared mailbox, and sending as a shared address with the copy in the shared Sent folder.
- [ ] Giving a colleague access to your own mailbox (delegation).
- [ ] Notifications for shared mailboxes when Mail is not open.
- [ ] Attachment virus scanning.
- [ ] A screen-reader audit of all four apps.

**Calendar**
- [ ] Tasks and to-dos.
- [ ] Public holidays from the workspace's own working calendar.
- [ ] A room's own calendar view, and a room that declines when there are too many people.

**Chat**
- [ ] Emoji reactions and pinned messages.
- [ ] Typing indicators and link previews.
- [ ] Group direct messages.

**Meet**
- [ ] Raise hand, a waiting room and host controls (mute others, remove, end for all).

### 🔭 Later

**Mail**
- [ ] Read receipts and send importance.
- [ ] Follow-up nudges.
- [ ] Offline reading.
- [ ] Migration from another IMAP server.
- [ ] A retention policy per mailbox, and one setting for Trash and Spam retention inside Ferrum.
- [ ] Auditing of who read whose mail.
- [ ] Routing for mail that stays on the hosted server, without forwarding to the inbound webhook.
- [ ] A rich-text message box in Chat.
- [ ] Desktop pop-ups for new mail.

**Calendar**
- [ ] Pictures in event notes, and attachments written into calendar files.
- [ ] A colour per event.
- [ ] Changing one occurrence as an override inside the series instead of an event of its own.
- [ ] Renaming and recolouring a calendar from a calendar program, and incremental sync from an old sync token.
- [ ] Showing time away to colleagues outside Find a time.
- [ ] Dragging on a touch screen tried on real phones.

**Chat**
- [ ] Guest access, retention rules, bots and incoming webhooks.
- [ ] Custom status and statuses beyond "Active now".
- [ ] Scheduled messages.

**Meet**
- [ ] Background blur, breakout rooms, dial-in by phone and a choice of layouts.
- [ ] Automatic captions for everyone, not only each person's own voice.
- [ ] Polls and a whiteboard.

**Everywhere**
- [ ] Native mobile apps.
- [ ] AI drafting, summaries and smart replies.
- [ ] The pop-out composer window and the phone keyboard toolbar tried on real devices; the composer in Arabic on a phone.
- [ ] Server-made wording (notification titles, subscription results, room reasons) in more languages once the platform can translate it.

## 🚀 Install

Ferrum Comms is a native app. It is compiled into the official Ferrum server image; a workspace administrator installs it from **Apps** (`/store/`). Self-hosters who build their own image enable the `comms` feature of the server. It needs Ferrum platform `>=0.3.2, <0.4`.

**First steps**

1. In **Communication Settings** set the public URL (used for unsubscribe links, the inbound webhook and feed addresses), the hourly newsletter limit and the number of send attempts.
2. For hosted mailboxes, run a Stalwart server, set `FERRUM_MAIL_URL`, `FERRUM_MAIL_ADMIN` and `FERRUM_MAIL_ADMIN_SECRET` on the Ferrum server, then set the **Mail Domain**. Everyone whose address is in the domain gets a mailbox. Publish the DNS records Mail's domain health screen lists.
3. For mail about records, add an **Email Account** (SMTP and IMAP or the inbound webhook) and mark a default outgoing account per company.
4. For meetings, run a LiveKit server and set `FERRUM_MEET_URL`, `FERRUM_MEET_KEY` and `FERRUM_MEET_SECRET`. For recordings also run LiveKit Egress and set `FERRUM_MEET_RECORDINGS=true`.
5. Give people the **Comms User** role, and the people who manage accounts, rooms and mailboxes **Comms Manager**. Give moderators **Chat Admin**.
6. Passwords and tokens are sealed secrets, so the server needs `FERRUM_SECRET_KEY`.

Everything Comms adds is also available to AI agents over Ferrum's MCP server, within each person's permissions.

## 🔧 Develop

Clone it next to the platform:

```text
work/
├── ferrum/            https://github.com/CBFerrum/Ferrum (with Ferrum-Frontend cloned into ferrum/web)
└── ferrum-app-comms/
```

Point the platform dependencies at your checkout (this file is git-ignored):

```toml
# .cargo/config.toml
[patch."https://github.com/CBFerrum/Ferrum"]
ferrum-apps = { path = "../ferrum/crates/apps" }
ferrum-domain = { path = "../ferrum/crates/domain" }
ferrum-kernel = { path = "../ferrum/crates/kernel" }
ferrum-meta = { path = "../ferrum/crates/meta" }
```

The tests need PostgreSQL with an ordinary (non-superuser) role so row-level security applies, and a Stalwart mail server for the hosted-mail part (`tests/stalwart.sh` starts one and prints the variables to set; CI appends them to its environment):

```bash
createuser ferrum --pwprompt && createdb -O ferrum ferrum_comms_test
export FERRUM_COMMS_TEST_DATABASE_URL=postgres://ferrum:ferrum@localhost:5432/ferrum_comms_test
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The tests also build on [ferrum-app-erp](https://github.com/CBFerrum/ferrum-app-erp), which Cargo takes from GitHub. To work on both, clone it into the same folder and add:

```toml
[patch."https://github.com/CBFerrum/ferrum-app-erp"]
ferrum-app-erp = { path = "../ferrum-app-erp" }
```

The interface lives in `ui/` and builds with Ferrum-Frontend's packages from the sibling checkout:

```bash
cd ui
npm run check       # UI lint and the size budget
npm run typecheck
npm test
npm run build       # writes ui/dist, which the crate embeds and which is committed
```

With a development server started with `FERRUM_DEV_UI=1`, `ferrum-app dev --ui` serves the pages from Vite behind the real bar and session, with hot reload. CI (`.github/workflows/ci.yml`) runs the Rust checks and the interface checks on every push and pull request.

## 📂 Project layout

```text
app.yaml              the manifest: id, version, shell apps, intents, search, notifications
packages/comms/       entities (mail, calendar, chat), roles, reports, SQL migrations
  README.md           the HTTP, live and Rust API in detail
src/                  Rust: mail sending and receiving, hosted mail, calendars, recurrence,
                      iCalendar, CalDAV and CardDAV, chat, meetings, upkeep jobs
ui/src/               React interface: Mail*, Calendar*, Chat*, Meet, shared libraries in lib/
ui/src/locales/       Arabic and Hindi words
tests/                integration tests against PostgreSQL and a real Stalwart
docs/                 banner and screenshots
CHANGELOG.md          what changed in each version
```

## 📜 Changelog

Every release is described in [CHANGELOG.md](CHANGELOG.md). The latest is **0.20.0**, which makes Mail something other apps build on.

## 🤝 Contributing

Issues and pull requests are welcome at [github.com/CBFerrum/ferrum-app-comms](https://github.com/CBFerrum/ferrum-app-comms/issues). Run the checks in [Develop](#-develop) before you open a pull request.

## 📄 License

[AGPL-3.0-only](LICENSE), like the platform.

<div align="center">

<sub>Part of <a href="https://github.com/CBFerrum/Ferrum">Ferrum</a>, the open business platform · Made with 🦀 Rust and 🐘 PostgreSQL</sub>

</div>
