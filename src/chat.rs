//! Team chat through `/api/app/comms/chat`, which enforces channel membership: private and
//! direct channels (and their messages) do not exist for anyone else — every endpoint answers
//! 404 — while public channels can be read and joined by every chat user. Writes go through the
//! document pipeline with the caller's identity (audit trail, outbox), so the generic API stays
//! the moderation tool of chat administrators. New, edited and deleted messages are pushed to
//! every member's open apps (`notify::push`, kind `chat`). People are told in the bar of what is for
//! them: @mentions, direct messages, replies in threads they take part in, and, where a member
//! chose it, every message of a channel (kinds `comms.mention`, `direct`, `thread`, `channel`).

use crate::util::{self, id, rows, s};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use ferrum_kernel::{Ctx, Doc, DocHook, Error, FieldError, HookCtx, Kernel, Result, SiteRequest, SiteResponse, Tx, notify};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;
use uuid::Uuid;

/// Child table of `ChatChannel.members`.
const MEMBERS: &str = "e_chat_channel__members";
const MAX_BODY: usize = 4096;
static MENTION: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"<@([^>\s@]+@[^>\s]+)>").expect("valid regex"));

fn iso(col: &str) -> String {
    format!("to_char({col} at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
}

/// The key of a direct conversation: its two members, sorted.
fn direct_key(members: &[String]) -> String {
    let set: BTreeSet<String> = members.iter().map(|m| m.trim().to_lowercase()).collect();
    set.into_iter().collect::<Vec<_>>().join("|")
}

pub struct ChannelHook;

#[async_trait]
impl DocHook for ChannelHook {
    async fn before_validate(&self, _hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        if s(doc, "channel_type") == Some("Direct") {
            let members: Vec<String> = rows(doc, "members").iter().filter_map(|r| s(r, "member").map(str::to_string)).collect();
            let key = direct_key(&members);
            doc.insert("channel_name".into(), json!(format!("dm-{}", &hex::encode(Sha256::digest(key.as_bytes()))[..16])));
            doc.insert("direct_key".into(), json!(key));
        } else {
            doc.insert("direct_key".into(), Value::Null);
        }
        Ok(())
    }

    async fn validate(&self, _hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let members: Vec<String> = rows(doc, "members").iter().filter_map(|r| s(r, "member").map(str::to_lowercase)).collect();
        let unique: BTreeSet<&String> = members.iter().collect();
        let mut errors = Vec::new();
        if unique.len() != members.len() {
            errors.push(FieldError::new("members", "each person can be a member once"));
        }
        let kind = s(doc, "channel_type").unwrap_or("Public");
        match kind {
            "Direct" if unique.len() != 2 => errors.push(FieldError::new("members", "a direct conversation has exactly two people")),
            "Direct" => {}
            _ => {
                if s(doc, "channel_name").is_some_and(|n| n.starts_with("dm-")) {
                    errors.push(FieldError::new("channel_name", "names starting with dm- are reserved"));
                }
                if kind == "Private" && members.is_empty() {
                    errors.push(FieldError::new("members", "a private channel needs members"));
                }
                if !members.is_empty() && !rows(doc, "members").iter().any(|r| s(r, "role") == Some("Owner")) {
                    errors.push(FieldError::new("members", "a channel needs an owner"));
                }
            }
        }
        if errors.is_empty() { Ok(()) } else { Err(Error::Validation(errors)) }
    }

    async fn after_save(&self, hc: &mut HookCtx<'_>, doc: &Doc, old: Option<&Doc>) -> Result<()> {
        if let Some(old) = old
            && (s(old, "channel_type") == Some("Direct")) != (s(doc, "channel_type") == Some("Direct"))
        {
            return Err(Error::invalid("a direct conversation cannot become a channel, nor the other way round"));
        }
        // People added must be active users (members deactivated later stay until removed).
        let before: BTreeSet<String> =
            old.map(|o| rows(o, "members").iter().filter_map(|r| s(r, "member").map(str::to_lowercase)).collect()).unwrap_or_default();
        let added: Vec<String> = rows(doc, "members").iter().filter_map(|r| s(r, "member").map(str::to_lowercase)).filter(|m| !before.contains(m)).collect();
        let known: BTreeSet<String> = util::users(hc.tx, hc.ctx.tenant, &added).await?.into_iter().map(|u| u.email).collect();
        match added.iter().find(|m| !known.contains(*m)) {
            Some(missing) => Err(Error::field("members", format!("{missing} is not an active user"))),
            None => Ok(()),
        }
    }
}

pub struct MessageHook;

#[async_trait]
impl DocHook for MessageHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        if !doc.contains_key("created_at") {
            if s(doc, "sender").is_none() || !hc.ctx.is_system {
                doc.insert("sender".into(), json!(hc.ctx.email.to_lowercase()));
            }
            doc.insert("posted_at".into(), json!(util::ts(util::now())));
            doc.insert("deleted".into(), json!(false));
        }
        Ok(())
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let body = s(doc, "body").unwrap_or_default();
        if body.len() > MAX_BODY {
            return Err(Error::field("body", format!("messages are limited to {MAX_BODY} bytes")));
        }
        if !util::b(doc, "deleted") && body.trim().is_empty() && util::attachment_ids(doc.get("attachments")).is_empty() {
            return Err(Error::field("body", "write a message"));
        }
        if let Some(parent) = id(doc, "parent_message") {
            let row: Option<(Uuid, Option<Uuid>)> = sqlx::query_as("select channel, parent_message from e_chat_message where tenant_id = $1 and id = $2")
                .bind(hc.ctx.tenant)
                .bind(parent)
                .fetch_optional(&mut **hc.tx)
                .await?;
            match row {
                Some((channel, None)) if Some(channel) == id(doc, "channel") => {}
                Some((_, Some(_))) => return Err(Error::field("parent_message", "reply to the first message of the thread")),
                _ => return Err(Error::field("parent_message", "is not a message of this channel")),
            }
        }
        Ok(())
    }

    async fn after_save(&self, hc: &mut HookCtx<'_>, doc: &Doc, _old: Option<&Doc>) -> Result<()> {
        // Uploads attached to nothing yet join the message (members download them through
        // /api/app/comms/attachments, which checks membership).
        util::attach_files(hc.tx, hc.ctx.tenant, doc.get("attachments"), "ChatMessage", util::doc_id(doc)?).await
    }
}

// ───────────────────────────── channels ─────────────────────────────

/// How loud a channel is for one member (`ChatChannelMember.notify_level`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Loud {
    /// Every message tells them.
    All,
    /// Mentions, and replies in threads they take part in.
    Mentions,
    /// Nothing: the channel is muted (only a mention by name still reaches them).
    Nothing,
}

impl Loud {
    /// The member's choice, else what the kind of channel suggests: a direct message tells, a
    /// channel waits for a mention.
    fn of(chosen: Option<&str>, kind: &str) -> Loud {
        match chosen {
            Some("All") => Loud::All,
            Some("Mentions") => Loud::Mentions,
            Some("Nothing") => Loud::Nothing,
            _ if kind == "Direct" => Loud::All,
            _ => Loud::Mentions,
        }
    }
}

struct Member {
    email: String,
    role: String,
    notify: Option<String>,
}

struct Channel {
    id: Uuid,
    name: String,
    kind: String,
    archived: bool,
    /// Only owners start posts (members still reply in threads).
    owners_post: bool,
    members: Vec<Member>,
}

impl Channel {
    fn member(&self, email: &str) -> Option<&Member> {
        self.members.iter().find(|m| m.email.eq_ignore_ascii_case(email))
    }
    fn role(&self, email: &str) -> Option<&str> {
        self.member(email).map(|m| m.role.as_str())
    }
    fn loud(&self, email: &str) -> Loud {
        Loud::of(self.member(email).and_then(|m| m.notify.as_deref()), &self.kind)
    }
    fn readable(&self, ctx: &Ctx) -> bool {
        self.kind == "Public" || self.role(&ctx.email).is_some()
    }
    fn label(&self) -> String {
        if self.kind == "Direct" { "a direct message".into() } else { format!("#{}", self.name) }
    }
}

async fn load_channel(tx: &mut Tx, tenant: Uuid, channel: Uuid) -> Result<Option<Channel>> {
    let row: Option<(String, String, bool, Option<String>)> =
        sqlx::query_as("select channel_name, channel_type, archived, post_policy from e_chat_channel where tenant_id = $1 and id = $2")
            .bind(tenant)
            .bind(channel)
            .fetch_optional(&mut **tx)
            .await?;
    let Some((name, kind, archived, policy)) = row else { return Ok(None) };
    let members: Vec<(String, String, Option<String>)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select member::text, coalesce(role, 'Member'), notify_level from {MEMBERS} where tenant_id = $1 and parent_id = $2 order by idx"
    )))
    .bind(tenant)
    .bind(channel)
    .fetch_all(&mut **tx)
    .await?;
    let members = members.into_iter().map(|(email, role, notify)| Member { email, role, notify }).collect();
    Ok(Some(Channel { id: channel, name, kind, archived, owners_post: policy.as_deref() == Some("Owners"), members }))
}

/// A channel the caller may read; private and direct ones of others are "not found".
async fn readable_channel(tx: &mut Tx, ctx: &Ctx, channel: Uuid) -> Result<Channel> {
    match load_channel(tx, ctx.tenant, channel).await? {
        Some(c) if c.readable(ctx) => Ok(c),
        _ => Err(Error::NotFound("Chat Channel".into())),
    }
}

/// What a call in a channel the caller may read is called: "#name", or the other person of a
/// direct message.
pub(crate) async fn call_title(tx: &mut Tx, ctx: &Ctx, channel: Uuid) -> Result<String> {
    let c = readable_channel(tx, ctx, channel).await?;
    if c.archived {
        return Err(Error::invalid("this channel is archived"));
    }
    if c.kind != "Direct" {
        return Ok(c.label());
    }
    let others: Vec<String> = member_emails(&c).into_iter().filter(|m| !m.eq_ignore_ascii_case(&ctx.email)).collect();
    let name = util::users(tx, ctx.tenant, &others).await?.into_iter().map(|u| u.full_name).find(|n| !n.trim().is_empty());
    Ok(name.or_else(|| others.into_iter().next()).unwrap_or_else(|| c.label()))
}

/// Pushes a chat event to these members' open apps (at commit).
async fn push(tx: &mut Tx, tenant: Uuid, emails: &[String], data: Value) -> Result<()> {
    for u in util::users(tx, tenant, emails).await? {
        notify::push(tx, tenant, u.id, "chat", data.clone()).await?;
    }
    Ok(())
}

fn member_emails(c: &Channel) -> Vec<String> {
    c.members.iter().map(|m| m.email.clone()).collect()
}

async fn channel_json(tx: &mut Tx, ctx: &Ctx, channel: Uuid) -> Result<Value> {
    let sql = format!(
        "select jsonb_build_object('id', c.id, 'name', c.channel_name, 'type', c.channel_type, 'topic', c.topic, 'archived', c.archived, \
         'post_policy', coalesce(c.post_policy, 'Members'), 'notify_level', me.notify_level, \
         'last_message_at', {last}, 'role', me.role, 'last_read_at', {read}, \
         'title', case when c.channel_type = 'Direct' then (select coalesce(nullif(u.full_name, ''), o.member::text) from {MEMBERS} o \
            left join app_user u on u.tenant_id = o.tenant_id and lower(u.email::text) = o.member \
            where o.tenant_id = c.tenant_id and o.parent_id = c.id and o.member <> $3 limit 1) else c.channel_name end, \
         'members', (select coalesce(jsonb_agg(jsonb_build_object('email', m.member, 'full_name', u.full_name, 'role', m.role, 'last_read_at', {mread}, \
            'active', {ACTIVE}) order by m.idx), '[]') \
            from {MEMBERS} m left join app_user u on u.tenant_id = m.tenant_id and lower(u.email::text) = m.member \
            where m.tenant_id = c.tenant_id and m.parent_id = c.id)) \
         from e_chat_channel c left join {MEMBERS} me on me.tenant_id = c.tenant_id and me.parent_id = c.id and me.member = $3 \
         where c.tenant_id = $1 and c.id = $2",
        last = iso("c.last_message_at"),
        read = iso("me.last_read_at"),
        mread = iso("m.last_read_at"),
    );
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(ctx.tenant)
        .bind(channel)
        .bind(ctx.email.to_lowercase())
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| Error::NotFound("Chat Channel".into()))
}

/// Whether the person `u` is about: a live session of theirs that made a request in the last ten
/// minutes (sessions note it at most every five). Only that is shown, never when they were last seen.
const ACTIVE: &str = "exists (select 1 from user_session s where s.tenant_id = u.tenant_id and s.user_id = u.id and s.revoked_at is null \
    and s.expires_at > now() and s.last_seen_at > now() - interval '10 minutes')";

/// What counts as unread for the member `$2` of channel `c` whose member row is `me`: messages
/// from others after the read marker, and replies from others in threads they started or
/// answered in (a reply in a thread of someone else's, which they never joined, is not theirs).
const UNREAD: &str = "from e_chat_message x where x.tenant_id = c.tenant_id and x.channel = c.id and not x.deleted and x.sender <> $2 \
    and x.posted_at > coalesce(me.last_read_at, '-infinity'::timestamptz) \
    and (x.parent_message is null or exists (select 1 from e_chat_message t where t.tenant_id = x.tenant_id and t.channel = x.channel and t.sender = $2 \
        and (t.id = x.parent_message or t.parent_message = x.parent_message)))";

/// `GET /chat/channels[?include=public]`: my channels with unread counts (and how many of them
/// mention me) and the last message; `include=public` adds public channels I can join.
async fn list_channels(k: &Kernel, ctx: &Ctx, include_public: bool) -> Result<Value> {
    let sql = format!(
        "select jsonb_build_object('id', c.id, 'name', c.channel_name, 'type', c.channel_type, 'topic', c.topic, 'archived', c.archived, \
         'post_policy', coalesce(c.post_policy, 'Members'), 'notify_level', me.notify_level, \
         'role', me.role, 'last_read_at', {read}, 'last_message_at', {last}, \
         'title', case when c.channel_type = 'Direct' then (select coalesce(nullif(u.full_name, ''), o.member::text) from {MEMBERS} o \
            left join app_user u on u.tenant_id = o.tenant_id and lower(u.email::text) = o.member \
            where o.tenant_id = c.tenant_id and o.parent_id = c.id and o.member <> $2 limit 1) else c.channel_name end, \
         'active', case when c.channel_type = 'Direct' then (select {ACTIVE} from {MEMBERS} o join app_user u on u.tenant_id = o.tenant_id \
            and lower(u.email::text) = o.member where o.tenant_id = c.tenant_id and o.parent_id = c.id and o.member <> $2 limit 1) end, \
         'unread', case when me.id is null then 0 else (select count(*) {UNREAD}) end, \
         'unread_mentions', case when me.id is null then 0 else (select count(*) {UNREAD} and x.mentions @> to_jsonb($2::text)) end, \
         'last_message', (select jsonb_build_object('id', x.id, 'sender', x.sender, 'body', left(x.body, 200), 'posted_at', {posted}) \
            from e_chat_message x where x.tenant_id = c.tenant_id and x.channel = c.id and x.parent_message is null and not x.deleted \
            order by x.posted_at desc limit 1)) \
         from e_chat_channel c left join {MEMBERS} me on me.tenant_id = c.tenant_id and me.parent_id = c.id and me.member = $2 \
         where c.tenant_id = $1 and (me.id is not null or ($3 and c.channel_type = 'Public' and not c.archived)) \
         order by (me.id is null), c.last_message_at desc nulls last, c.channel_name limit 1000",
        read = iso("me.last_read_at"),
        last = iso("c.last_message_at"),
        posted = iso("x.posted_at"),
    );
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let channels: Vec<Value> =
        sqlx::query_scalar(sqlx::AssertSqlSafe(sql)).bind(ctx.tenant).bind(ctx.email.to_lowercase()).bind(include_public).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(json!({"channels": channels}))
}

fn emails(v: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> =
        v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(|e| e.trim().to_lowercase()).collect()).unwrap_or_default();
    out.sort();
    out.dedup();
    out
}

fn named_conflict(e: Error, name: &str) -> Error {
    match e {
        Error::Conflict(_) => Error::Conflict(format!("a channel named {name} already exists")),
        other => other,
    }
}

/// `POST /chat/channels` `{name, type: Public|Private, topic?, members?: [emails]}`.
async fn create_channel(k: &Kernel, ctx: &Ctx, body: Map<String, Value>) -> Result<Value> {
    let name = body.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()).ok_or_else(|| Error::field("name", "is required"))?;
    let kind = body.get("type").and_then(Value::as_str).unwrap_or("Public");
    if !matches!(kind, "Public" | "Private") {
        return Err(Error::field("type", "must be Public or Private (use /chat/direct for direct messages)"));
    }
    let me = ctx.email.to_lowercase();
    let others: Vec<String> = emails(body.get("members")).into_iter().filter(|e| *e != me).collect();
    let mut members = vec![json!({"member": me, "role": "Owner"})];
    members.extend(others.iter().map(|e| json!({"member": e, "role": "Member"})));
    let doc = util::obj(json!({"channel_name": name, "channel_type": kind, "topic": body.get("topic"), "members": members}));
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let saved = k.insert_tx(&util::elevated(ctx), &mut tx, "ChatChannel", doc).await.map_err(|e| named_conflict(e, name))?;
    let channel = util::doc_id(&saved)?;
    push(&mut tx, ctx.tenant, &others, json!({"event": "added", "channel": channel})).await?;
    let out = channel_json(&mut tx, ctx, channel).await?;
    tx.commit().await?;
    Ok(out)
}

/// `POST /chat/direct` `{user: email}`: the conversation with that person, created on first use.
async fn direct(k: &Kernel, ctx: &Ctx, body: Map<String, Value>) -> Result<Value> {
    let me = ctx.email.to_lowercase();
    let other = body
        .get("user")
        .and_then(Value::as_str)
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty())
        .ok_or_else(|| Error::field("user", "is required"))?;
    if other == me {
        return Err(Error::field("user", "choose someone else"));
    }
    let key = direct_key(&[me.clone(), other.clone()]);
    for _ in 0..2 {
        let mut tx = k.db.tenant_tx(ctx.tenant).await?;
        let existing: Option<Uuid> = sqlx::query_scalar("select id from e_chat_channel where tenant_id = $1 and direct_key = $2")
            .bind(ctx.tenant)
            .bind(&key)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(c) = existing {
            let out = channel_json(&mut tx, ctx, c).await?;
            tx.commit().await?;
            return Ok(out);
        }
        let doc = util::obj(json!({"channel_type": "Direct", "members": [{"member": me, "role": "Member"}, {"member": other, "role": "Member"}]}));
        match k.insert_tx(&util::elevated(ctx), &mut tx, "ChatChannel", doc).await {
            Ok(saved) => {
                let channel = util::doc_id(&saved)?;
                push(&mut tx, ctx.tenant, std::slice::from_ref(&other), json!({"event": "added", "channel": channel})).await?;
                let out = channel_json(&mut tx, ctx, channel).await?;
                tx.commit().await?;
                return Ok(out);
            }
            // Both people opened the conversation at the same moment: use the other one's.
            Err(Error::Conflict(_)) => continue,
            Err(e) => return Err(e),
        }
    }
    Err(Error::Retryable("direct conversation".into()))
}

/// Applies a change to a channel's member rows through the document pipeline.
async fn set_members(k: &Kernel, ctx: &Ctx, tx: &mut Tx, channel: Uuid, change: impl FnOnce(&mut Vec<Value>)) -> Result<()> {
    let sys = util::sys(ctx);
    let doc = k.get_tx(&sys, tx, "ChatChannel", channel, true).await?;
    let mut members: Vec<Value> = doc.get("members").and_then(Value::as_array).cloned().unwrap_or_default();
    change(&mut members);
    let mut patch = Doc::new();
    patch.insert("members".into(), Value::Array(members));
    k.update_tx(&util::elevated(ctx), tx, "ChatChannel", channel, patch, None).await?;
    Ok(())
}

fn owner_or_admin(c: &Channel, ctx: &Ctx) -> Result<()> {
    if c.role(&ctx.email) == Some("Owner") || ctx.has_role("Chat Admin") {
        Ok(())
    } else {
        Err(Error::Forbidden("only the channel's owners can do this".into()))
    }
}

/// `PATCH /chat/channels/{id}` `{name?, topic?, archived?, type?: Public|Private, post_policy?: Members|Owners}` (owners).
async fn update_channel(k: &Kernel, ctx: &Ctx, channel: Uuid, body: Map<String, Value>) -> Result<Value> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let c = readable_channel(&mut tx, ctx, channel).await?;
    owner_or_admin(&c, ctx)?;
    if c.kind == "Direct" {
        return Err(Error::invalid("direct conversations have no name, topic or archive"));
    }
    let mut patch = Doc::new();
    for (from, to) in [("name", "channel_name"), ("topic", "topic"), ("archived", "archived"), ("type", "channel_type"), ("post_policy", "post_policy")] {
        if let Some(v) = body.get(from) {
            patch.insert(to.into(), v.clone());
        }
    }
    if body.get("type").is_some_and(|t| !matches!(t.as_str(), Some("Public" | "Private"))) {
        return Err(Error::field("type", "must be Public or Private"));
    }
    let name = body.get("name").and_then(Value::as_str).unwrap_or(&c.name).to_string();
    k.update_tx(&util::elevated(ctx), &mut tx, "ChatChannel", channel, patch, None).await.map_err(|e| named_conflict(e, &name))?;
    // Everyone who may read it hears of it: members now, and the public channel's other readers on their next look.
    push(&mut tx, ctx.tenant, &member_emails(&c), json!({"event": "channel_updated", "channel": channel})).await?;
    let out = channel_json(&mut tx, ctx, channel).await?;
    tx.commit().await?;
    Ok(out)
}

/// A channel always has an owner: when the last one went, the first member becomes one.
fn ensure_owner(rows: &mut [Value]) {
    if !rows.iter().any(|r| r.get("role").and_then(Value::as_str) == Some("Owner"))
        && let Some(Value::Object(next)) = rows.first_mut()
    {
        next.insert("role".into(), json!("Owner"));
    }
}

/// `POST /chat/channels/{id}/members` `{add?: [emails], remove?: [emails], promote?: [emails],
/// demote?: [emails]}` (owners). People added start with nothing unread; promoting makes an owner,
/// demoting a member; the last owner cannot be demoted.
async fn change_members(k: &Kernel, ctx: &Ctx, channel: Uuid, body: Map<String, Value>) -> Result<Value> {
    let (add, remove) = (emails(body.get("add")), emails(body.get("remove")));
    let (promote, demote) = (emails(body.get("promote")), emails(body.get("demote")));
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let c = readable_channel(&mut tx, ctx, channel).await?;
    owner_or_admin(&c, ctx)?;
    if c.kind == "Direct" {
        return Err(Error::invalid("direct conversations keep their two people"));
    }
    let current: BTreeSet<String> = member_emails(&c).into_iter().collect();
    let added: Vec<String> = add.iter().filter(|e| !current.contains(*e)).cloned().collect();
    let removed: Vec<String> = remove.iter().filter(|e| current.contains(*e)).cloned().collect();
    // Owners once this is done; demoting the last one would leave the channel without.
    let stays_owner = |email: &str, role: &str| {
        !removed.iter().any(|x| x == email) && (promote.iter().any(|x| x == email) || (role == "Owner" && !demote.iter().any(|x| x == email)))
    };
    let owners_left = c.members.iter().filter(|m| stays_owner(&m.email, &m.role)).count() + added.iter().filter(|e| promote.contains(e)).count();
    if owners_left == 0 && !demote.is_empty() {
        return Err(Error::invalid("a channel needs an owner: make someone else an owner first"));
    }
    let joined = util::ts(util::now());
    set_members(k, ctx, &mut tx, channel, |rows| {
        rows.retain(|r| !r.get("member").and_then(Value::as_str).is_some_and(|m| removed.iter().any(|x| x == m)));
        rows.extend(added.iter().map(|e| json!({"member": e, "role": "Member", "last_read_at": joined})));
        for r in rows.iter_mut().filter_map(Value::as_object_mut) {
            let who = r.get("member").and_then(Value::as_str).unwrap_or_default().to_string();
            if promote.contains(&who) {
                r.insert("role".into(), json!("Owner"));
            } else if demote.contains(&who) {
                r.insert("role".into(), json!("Member"));
            }
        }
        ensure_owner(rows);
    })
    .await?;
    push(&mut tx, ctx.tenant, &added, json!({"event": "added", "channel": channel})).await?;
    push(&mut tx, ctx.tenant, &removed, json!({"event": "removed", "channel": channel})).await?;
    let others: Vec<String> = member_emails(&c).into_iter().filter(|m| !added.contains(m) && !removed.contains(m)).collect();
    push(&mut tx, ctx.tenant, &others, json!({"event": "channel_updated", "channel": channel})).await?;
    let out = channel_json(&mut tx, ctx, channel).await?;
    tx.commit().await?;
    Ok(out)
}

/// `POST /chat/channels/{id}/join` (public channels).
async fn join(k: &Kernel, ctx: &Ctx, channel: Uuid) -> Result<Value> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let c = readable_channel(&mut tx, ctx, channel).await?;
    if c.kind != "Public" {
        return Err(Error::NotFound("Chat Channel".into()));
    }
    if c.archived {
        return Err(Error::invalid("this channel is archived"));
    }
    if c.role(&ctx.email).is_none() {
        let me = ctx.email.to_lowercase();
        let first = c.members.is_empty();
        // Joining starts from now: the channel's history is there to read, not a count of unread.
        let joined = util::ts(util::now());
        set_members(k, ctx, &mut tx, channel, |rows| rows.push(json!({"member": me, "role": if first { "Owner" } else { "Member" }, "last_read_at": joined})))
            .await?;
    }
    let out = channel_json(&mut tx, ctx, channel).await?;
    tx.commit().await?;
    Ok(out)
}

/// `POST /chat/channels/{id}/leave`; the last owner hands ownership to the next member.
async fn leave(k: &Kernel, ctx: &Ctx, channel: Uuid) -> Result<Value> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let c = readable_channel(&mut tx, ctx, channel).await?;
    if c.kind == "Direct" {
        return Err(Error::invalid("direct conversations cannot be left"));
    }
    if c.role(&ctx.email).is_none() {
        return Err(Error::invalid("you are not a member of this channel"));
    }
    let me = ctx.email.to_lowercase();
    set_members(k, ctx, &mut tx, channel, |rows| {
        rows.retain(|r| r.get("member").and_then(Value::as_str) != Some(me.as_str()));
        ensure_owner(rows);
    })
    .await?;
    let others: Vec<String> = member_emails(&c).into_iter().filter(|m| *m != me).collect();
    push(&mut tx, ctx.tenant, &others, json!({"event": "channel_updated", "channel": channel})).await?;
    push(&mut tx, ctx.tenant, std::slice::from_ref(&me), json!({"event": "removed", "channel": channel})).await?;
    tx.commit().await?;
    Ok(json!({"left": channel}))
}

// ───────────────────────────── messages ─────────────────────────────

fn message_sql(filter: &str) -> String {
    format!(
        "select jsonb_build_object('id', x.id, 'channel', x.channel, 'sender', x.sender, 'sender_name', coalesce(nullif(u.full_name, ''), x.sender), \
         'body', case when x.deleted then '' else x.body end, 'parent', x.parent_message, 'mentions', coalesce(x.mentions, '[]'::jsonb), \
         'attachments', case when x.deleted then '[]'::jsonb else coalesce(x.attachments, '[]'::jsonb) end, 'deleted', x.deleted, \
         'posted_at', {posted}, 'edited_at', {edited}, \
         'reply_count', (select count(*) from e_chat_message r where r.tenant_id = x.tenant_id and r.parent_message = x.id and not r.deleted), \
         'last_reply_at', (select {reply} from e_chat_message r where r.tenant_id = x.tenant_id and r.parent_message = x.id and not r.deleted order by r.posted_at desc limit 1)) \
         from e_chat_message x left join app_user u on u.tenant_id = x.tenant_id and lower(u.email::text) = x.sender \
         where x.tenant_id = $1 {filter}",
        posted = iso("x.posted_at"),
        edited = iso("x.edited_at"),
        reply = iso("r.posted_at"),
    )
}

async fn message_json(tx: &mut Tx, tenant: Uuid, message: Uuid) -> Result<Value> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(message_sql("and x.id = $2")))
        .bind(tenant)
        .bind(message)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| Error::NotFound("Chat Message".into()))
}

/// The window of top-level messages around one message (a reply counts as its thread's first
/// message), newest first like the usual pages: `next_cursor` goes on to older ones, `newer` says
/// the window ends before the latest message, `target` is the message asked for.
async fn messages_around(k: &Kernel, ctx: &Ctx, channel: Uuid, target: Uuid, limit: i64) -> Result<Value> {
    let half = (limit / 2).max(1);
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    readable_channel(&mut tx, ctx, channel).await?;
    let anchor: Option<(DateTime<Utc>, Uuid)> = sqlx::query_as(
        "select r.posted_at, r.id from e_chat_message m join e_chat_message r on r.tenant_id = m.tenant_id and r.id = coalesce(m.parent_message, m.id) \
         where m.tenant_id = $1 and m.id = $2 and m.channel = $3",
    )
    .bind(ctx.tenant)
    .bind(target)
    .bind(channel)
    .fetch_optional(&mut *tx)
    .await?;
    let (at, root) = anchor.ok_or_else(|| Error::NotFound("Chat Message".into()))?;
    let window = |cmp: &str, dir: &str| {
        message_sql(&format!(
            "and x.channel = $2 and x.parent_message is null and (x.posted_at, x.id) {cmp} ($3::timestamptz, $4::uuid) order by x.posted_at {dir}, x.id {dir} limit $5"
        ))
    };
    // The anchor and `half` before it (one more tells there are older ones); `half` after it (likewise).
    let older: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(window("<=", "desc")))
        .bind(ctx.tenant)
        .bind(channel)
        .bind(at)
        .bind(root)
        .bind(half + 2)
        .fetch_all(&mut *tx)
        .await?;
    let newer: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(window(">", "asc")))
        .bind(ctx.tenant)
        .bind(channel)
        .bind(at)
        .bind(root)
        .bind(half + 1)
        .fetch_all(&mut *tx)
        .await?;
    let found = message_json(&mut tx, ctx.tenant, target).await?;
    tx.commit().await?;
    let (more_older, more_newer) = (older.len() as i64 > half + 1, newer.len() as i64 > half);
    let older: Vec<Value> = older.into_iter().take(half as usize + 1).collect();
    let next = if more_older {
        older.last().and_then(|m| Some(ferrum_kernel::query::encode_cursor(m.get("posted_at")?.as_str()?, m.get("id")?.as_str()?)))
    } else {
        None
    };
    let mut messages: Vec<Value> = newer.into_iter().take(half as usize).rev().collect();
    messages.extend(older);
    Ok(json!({"messages": messages, "next_cursor": next, "newer": more_newer, "target": found}))
}

/// `GET /chat/channels/{id}/messages?cursor=&limit=&thread=&around=`: top-level messages newest
/// first, or a thread's replies oldest first, or the window around one message.
async fn list_messages(k: &Kernel, ctx: &Ctx, channel: Uuid, req: &SiteRequest) -> Result<Value> {
    let limit: i64 = util::param(req, "limit").and_then(|l| l.parse().ok()).unwrap_or(50).clamp(1, 200);
    let around: Option<Uuid> = util::param(req, "around").map(|t| t.parse()).transpose().map_err(|_| Error::field("around", "must be a message id"))?;
    if let Some(target) = around {
        return messages_around(k, ctx, channel, target, limit).await;
    }
    let thread: Option<Uuid> = util::param(req, "thread").map(|t| t.parse()).transpose().map_err(|_| Error::field("thread", "must be a message id"))?;
    let cursor = util::param(req, "cursor").map(ferrum_kernel::query::decode_cursor).transpose()?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    readable_channel(&mut tx, ctx, channel).await?;
    let (cmp, dir) = if thread.is_some() { (">", "asc") } else { ("<", "desc") };
    let mut filter = String::from("and x.channel = $2 and ");
    filter.push_str(if thread.is_some() { "x.parent_message = $3" } else { "x.parent_message is null and $3::uuid is null" });
    if cursor.is_some() {
        filter.push_str(&format!(" and (x.posted_at, x.id) {cmp} ($4::timestamptz, $5::uuid)"));
    } else {
        filter.push_str(" and $4::timestamptz is null and $5::uuid is null");
    }
    filter.push_str(&format!(" order by x.posted_at {dir}, x.id {dir} limit $6"));
    let (ts, cid) = match &cursor {
        Some((t, i)) => (Some(util::parse_ts(t).ok_or_else(|| Error::invalid("bad cursor"))?), Some(*i)),
        None => (None, None),
    };
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(message_sql(&filter)))
        .bind(ctx.tenant)
        .bind(channel)
        .bind(thread)
        .bind(ts)
        .bind(cid)
        .bind(limit + 1)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    let more = rows.len() as i64 > limit;
    let messages: Vec<Value> = rows.into_iter().take(limit as usize).collect();
    let next = if more {
        messages.last().and_then(|m| Some(ferrum_kernel::query::encode_cursor(m.get("posted_at")?.as_str()?, m.get("id")?.as_str()?)))
    } else {
        None
    };
    Ok(json!({"messages": messages, "next_cursor": next}))
}

fn body_text(body: &Map<String, Value>) -> Result<String> {
    let text = body.get("body").and_then(Value::as_str).unwrap_or_default().to_string();
    if text.len() > MAX_BODY {
        return Err(Error::field("body", format!("messages are limited to {MAX_BODY} bytes")));
    }
    Ok(text)
}

/// Who is in a thread: whoever started it or answered in it.
async fn thread_people(tx: &mut Tx, tenant: Uuid, root: Uuid) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "select distinct sender from e_chat_message where tenant_id = $1 and (id = $2 or parent_message = $2) and not deleted and sender is not null",
    )
    .bind(tenant)
    .bind(root)
    .fetch_all(&mut **tx)
    .await?)
}

/// `POST /chat/channels/{id}/messages` `{body, parent?, mentions?: [emails], attachments?}`.
async fn post(k: &Kernel, ctx: &Ctx, channel: Uuid, body: Map<String, Value>) -> Result<Value> {
    let text = body_text(&body)?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let c = readable_channel(&mut tx, ctx, channel).await?;
    if c.role(&ctx.email).is_none() {
        return Err(Error::Forbidden("join the channel to post".into()));
    }
    if c.archived {
        return Err(Error::invalid("this channel is archived"));
    }
    let parent: Option<Uuid> =
        body.get("parent").and_then(Value::as_str).map(|p| p.parse()).transpose().map_err(|_| Error::field("parent", "must be a message id"))?;
    // Replies to replies join the thread's first message.
    let root = match parent {
        Some(p) => {
            let row: Option<(Uuid, Option<Uuid>)> = sqlx::query_as("select channel, parent_message from e_chat_message where tenant_id = $1 and id = $2")
                .bind(ctx.tenant)
                .bind(p)
                .fetch_optional(&mut *tx)
                .await?;
            match row {
                Some((ch, up)) if ch == channel => Some(up.unwrap_or(p)),
                _ => return Err(Error::field("parent", "is not a message of this channel")),
            }
        }
        None => None,
    };
    if c.owners_post && root.is_none() && c.role(&ctx.email) != Some("Owner") {
        return Err(Error::Forbidden("only the channel's owners start posts here; members can reply in threads".into()));
    }
    let me = ctx.email.to_lowercase();
    let mut mentioned: BTreeSet<String> = emails(body.get("mentions")).into_iter().collect();
    mentioned.extend(MENTION.captures_iter(&text).map(|m| m[1].to_lowercase()));
    mentioned.remove(&me);
    // Only people who can read the channel learn about the message.
    let mentioned: Vec<String> = if c.kind == "Public" {
        util::users(&mut tx, ctx.tenant, &mentioned.into_iter().collect::<Vec<_>>()).await?.into_iter().map(|u| u.email).collect()
    } else {
        mentioned.into_iter().filter(|m| c.role(m).is_some()).collect()
    };
    let attachments = util::check_files(k, &mut tx, ctx, body.get("attachments")).await?;
    let doc = util::obj(json!({"channel": channel, "body": text, "parent_message": root, "mentions": mentioned, "attachments": attachments}));
    let saved = k.insert_tx(&util::elevated(ctx), &mut tx, "ChatMessage", doc).await?;
    let message = util::doc_id(&saved)?;
    sqlx::query("update e_chat_channel set last_message_at = now() where tenant_id = $1 and id = $2").bind(ctx.tenant).bind(channel).execute(&mut *tx).await?;
    if root.is_none() {
        sqlx::query(sqlx::AssertSqlSafe(format!("update {MEMBERS} set last_read_at = now() where tenant_id = $1 and parent_id = $2 and member = $3")))
            .bind(ctx.tenant)
            .bind(channel)
            .bind(&me)
            .execute(&mut *tx)
            .await?;
    }
    push(&mut tx, ctx.tenant, &member_emails(&c), json!({"event": "message", "channel": channel, "message": message, "parent": root, "sender": me})).await?;
    let who = if ctx.full_name.trim().is_empty() { ctx.email.clone() } else { ctx.full_name.clone() };
    let snippet = util::cut(&text, 200);
    let snippet = if snippet.trim().is_empty() { "Sent a file".to_string() } else { snippet };
    // Each person hears once, of the most direct thing: a mention, then what the conversation is
    // to them (a direct message, a thread they are in, a channel they chose to hear in full).
    let mut hears: BTreeMap<String, &str> = mentioned.iter().map(|m| (m.clone(), "mention")).collect();
    match root {
        _ if c.kind == "Direct" => {
            for m in c.members.iter().filter(|m| m.email != me && c.loud(&m.email) != Loud::Nothing) {
                hears.entry(m.email.clone()).or_insert("direct");
            }
        }
        Some(r) => {
            for p in thread_people(&mut tx, ctx.tenant, r).await? {
                if p != me && c.member(&p).is_some() && c.loud(&p) != Loud::Nothing {
                    hears.entry(p).or_insert("thread");
                }
            }
        }
        None => {
            for m in c.members.iter().filter(|m| m.email != me && c.loud(&m.email) == Loud::All) {
                hears.entry(m.email.clone()).or_insert("channel");
            }
        }
    }
    let wanted: Vec<String> = hears.keys().cloned().collect();
    let users: BTreeMap<String, Uuid> = util::users(&mut tx, ctx.tenant, &wanted).await?.into_iter().map(|u| (u.email, u.id)).collect();
    for (email, by) in hears {
        let Some(user) = users.get(&email) else { continue };
        let title = match by {
            "mention" => format!("{who} mentioned you in {}", c.label()),
            "direct" => format!("{who} sent you a message"),
            "thread" => format!("{who} replied in a thread in {}", c.label()),
            _ => format!("{who} in {}", c.label()),
        };
        notify::send_kind(
            &mut tx,
            ctx.tenant,
            *user,
            &format!("comms.{by}"),
            "inapp",
            &util::cut(&title, 200),
            Some(&snippet),
            Some("ChatMessage"),
            Some(message),
        )
        .await?;
    }
    let out = message_json(&mut tx, ctx.tenant, message).await?;
    tx.commit().await?;
    Ok(out)
}

/// The message and its channel, when the caller can read them.
async fn readable_message(tx: &mut Tx, ctx: &Ctx, message: Uuid) -> Result<(Doc, Channel)> {
    let row: Option<Value> = sqlx::query_scalar("select to_jsonb(x) from e_chat_message x where x.tenant_id = $1 and x.id = $2")
        .bind(ctx.tenant)
        .bind(message)
        .fetch_optional(&mut **tx)
        .await?;
    let doc = row.map(util::obj).ok_or_else(|| Error::NotFound("Chat Message".into()))?;
    let channel = id(&doc, "channel").ok_or_else(|| Error::internal("message without channel"))?;
    let c = readable_channel(tx, ctx, channel).await.map_err(|_| Error::NotFound("Chat Message".into()))?;
    Ok((doc, c))
}

/// `PATCH /chat/messages/{id}` `{body}`: the sender only.
async fn edit(k: &Kernel, ctx: &Ctx, message: Uuid, body: Map<String, Value>) -> Result<Value> {
    let text = body_text(&body)?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let (doc, c) = readable_message(&mut tx, ctx, message).await?;
    if !s(&doc, "sender").is_some_and(|m| m.eq_ignore_ascii_case(&ctx.email)) {
        return Err(Error::Forbidden("you can only edit your own messages".into()));
    }
    if util::b(&doc, "deleted") {
        return Err(Error::invalid("this message was deleted"));
    }
    let patch = util::obj(json!({"body": text, "edited_at": util::ts(util::now())}));
    k.update_tx(&util::elevated(ctx), &mut tx, "ChatMessage", message, patch, None).await?;
    push(&mut tx, ctx.tenant, &member_emails(&c), json!({"event": "edited", "channel": c.id, "message": message})).await?;
    let out = message_json(&mut tx, ctx.tenant, message).await?;
    tx.commit().await?;
    Ok(out)
}

/// `DELETE /chat/messages/{id}`: the sender, a channel owner or a chat administrator. The text
/// and attachments are erased; the message stays as "deleted" so threads keep their shape.
async fn delete(k: &Kernel, ctx: &Ctx, message: Uuid) -> Result<Value> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let (doc, c) = readable_message(&mut tx, ctx, message).await?;
    let own = s(&doc, "sender").is_some_and(|m| m.eq_ignore_ascii_case(&ctx.email));
    if !own && c.role(&ctx.email) != Some("Owner") && !ctx.has_role("Chat Admin") {
        return Err(Error::Forbidden("you can only delete your own messages".into()));
    }
    let patch = util::obj(json!({"deleted": true, "body": "", "attachments": [], "mentions": []}));
    k.update_tx(&util::elevated(ctx), &mut tx, "ChatMessage", message, patch, None).await?;
    push(&mut tx, ctx.tenant, &member_emails(&c), json!({"event": "deleted", "channel": c.id, "message": message})).await?;
    tx.commit().await?;
    Ok(json!({"id": message, "deleted": true}))
}

/// `POST /chat/channels/{id}/read` `{at?}`: moves my read marker forward (never back); with
/// `{unread_from: message}` it moves back to just before that message, so it and what follows are
/// unread again.
async fn mark_read(k: &Kernel, ctx: &Ctx, channel: Uuid, body: Map<String, Value>) -> Result<Value> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    readable_channel(&mut tx, ctx, channel).await?;
    let me = ctx.email.to_lowercase();
    let unread_from: Option<Uuid> =
        body.get("unread_from").and_then(Value::as_str).map(|m| m.parse()).transpose().map_err(|_| Error::field("unread_from", "must be a message id"))?;
    let (sql, at) = match unread_from {
        Some(message) => {
            let posted: Option<DateTime<Utc>> = sqlx::query_scalar("select posted_at from e_chat_message where tenant_id = $1 and id = $2 and channel = $3")
                .bind(ctx.tenant)
                .bind(message)
                .bind(channel)
                .fetch_optional(&mut *tx)
                .await?;
            let before = posted.ok_or_else(|| Error::NotFound("Chat Message".into()))? - chrono::Duration::milliseconds(1);
            ("least(coalesce(last_read_at, 'infinity'::timestamptz), $4)", before)
        }
        None => {
            let at = match body.get("at").and_then(Value::as_str) {
                Some(t) => util::parse_ts(t).ok_or_else(|| Error::field("at", "must be an RFC 3339 date-time"))?,
                None => util::now(),
            };
            ("greatest(coalesce(last_read_at, '-infinity'::timestamptz), $4)", at)
        }
    };
    let read: Option<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "update {MEMBERS} set last_read_at = {sql}, updated_at = now() where tenant_id = $1 and parent_id = $2 and member = $3 returning {}",
        iso("last_read_at")
    )))
    .bind(ctx.tenant)
    .bind(channel)
    .bind(&me)
    .bind(at)
    .fetch_optional(&mut *tx)
    .await?;
    let read = read.ok_or_else(|| Error::invalid("you are not a member of this channel"))?;
    push(&mut tx, ctx.tenant, &[me], json!({"event": "read", "channel": channel, "last_read_at": read})).await?;
    tx.commit().await?;
    Ok(json!({"channel": channel, "last_read_at": read}))
}

/// `POST /chat/read-all`: everything I am in is read up to now.
async fn mark_all_read(k: &Kernel, ctx: &Ctx) -> Result<Value> {
    let me = ctx.email.to_lowercase();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let n = sqlx::query(sqlx::AssertSqlSafe(format!(
        "update {MEMBERS} set last_read_at = now(), updated_at = now() where tenant_id = $1 and member = $2 and (last_read_at is null or last_read_at < now())"
    )))
    .bind(ctx.tenant)
    .bind(&me)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    push(&mut tx, ctx.tenant, &[me], json!({"event": "read"})).await?;
    tx.commit().await?;
    Ok(json!({"channels": n}))
}

/// `PUT /chat/channels/{id}/notify` `{level: All|Mentions|Nothing|null}`: how loud the channel is
/// for me (null: what its kind suggests, everything for a direct message, mentions for a channel).
async fn set_notify(k: &Kernel, ctx: &Ctx, channel: Uuid, body: Map<String, Value>) -> Result<Value> {
    let level = match body.get("level") {
        Some(Value::String(l)) if ["All", "Mentions", "Nothing"].contains(&l.as_str()) => Some(l.clone()),
        None | Some(Value::Null) => None,
        _ => return Err(Error::field("level", "must be All, Mentions, Nothing or null")),
    };
    let me = ctx.email.to_lowercase();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    readable_channel(&mut tx, ctx, channel).await?;
    let n = sqlx::query(sqlx::AssertSqlSafe(format!(
        "update {MEMBERS} set notify_level = $4, updated_at = now() where tenant_id = $1 and parent_id = $2 and member = $3"
    )))
    .bind(ctx.tenant)
    .bind(channel)
    .bind(&me)
    .bind(&level)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(Error::invalid("you are not a member of this channel"));
    }
    push(&mut tx, ctx.tenant, &[me], json!({"event": "channel_updated", "channel": channel})).await?;
    tx.commit().await?;
    Ok(json!({"channel": channel, "notify_level": level}))
}

/// `GET /chat/messages/{id}`: one message the caller may read (a link to it, a search result).
async fn get_message(k: &Kernel, ctx: &Ctx, message: Uuid) -> Result<Value> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    readable_message(&mut tx, ctx, message).await?;
    let out = message_json(&mut tx, ctx.tenant, message).await?;
    tx.commit().await?;
    Ok(out)
}

/// `GET /chat/search?q=&limit=&channel=`: messages in channels I belong to and in public channels,
/// or in one of them; also as the bar's search provider (`shell.search`: `results`, each opening
/// its conversation at the message).
async fn search(k: &Kernel, ctx: &Ctx, req: &SiteRequest) -> Result<Value> {
    let q = util::param(req, "q").unwrap_or_default();
    if q.chars().count() < 2 {
        return Err(Error::field("q", "type at least two characters"));
    }
    let limit: i64 = util::param(req, "limit").and_then(|l| l.parse().ok()).unwrap_or(50).clamp(1, 100);
    let one: Option<Uuid> = util::param(req, "channel").map(|c| c.parse()).transpose().map_err(|_| Error::field("channel", "must be a channel id"))?;
    let pattern = format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let filter = format!(
        "and not x.deleted and x.body ilike $2 escape '\\' and ($5::uuid is null or x.channel = $5) and exists (select 1 from e_chat_channel c where c.tenant_id = x.tenant_id and c.id = x.channel \
         and (c.channel_type = 'Public' or exists (select 1 from {MEMBERS} m where m.tenant_id = c.tenant_id and m.parent_id = c.id and m.member = $3))) \
         order by x.posted_at desc limit $4"
    );
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(message_sql(&filter)))
        .bind(ctx.tenant)
        .bind(pattern)
        .bind(ctx.email.to_lowercase())
        .bind(limit)
        .bind(one)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    let results: Vec<Value> = rows
        .iter()
        .map(|m| {
            let body = m["body"].as_str().unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
            let when = m["posted_at"].as_str().unwrap_or_default().get(..10).unwrap_or_default().to_string();
            json!({
                "title": util::cut(&body, 120),
                "subtitle": format!("{} · {when}", m["sender_name"].as_str().unwrap_or_default()),
                "url": format!("/chat/{}?m={}", m["channel"].as_str().unwrap_or_default(), m["id"].as_str().unwrap_or_default()),
                "icon": "message-square",
                "updated_at": m["posted_at"],
            })
        })
        .collect();
    Ok(json!({"messages": rows, "results": results}))
}

fn uuid(seg: &str) -> Result<Uuid> {
    seg.parse().map_err(|_| Error::NotFound("record".into()))
}

/// Routes `/chat/...`.
pub async fn handle(k: &Kernel, ctx: &Ctx, req: &SiteRequest, path: &[&str]) -> Result<SiteResponse> {
    let body = || util::body_json(req);
    let out = match (req.method.as_str(), path) {
        ("GET", ["channels"]) => list_channels(k, ctx, util::param(req, "include") == Some("public")).await?,
        ("POST", ["channels"]) => return Ok(util::created(create_channel(k, ctx, body()?).await?)),
        ("POST", ["direct"]) => direct(k, ctx, body()?).await?,
        ("GET", ["channels", c]) => {
            let mut tx = k.db.tenant_tx(ctx.tenant).await?;
            readable_channel(&mut tx, ctx, uuid(c)?).await?;
            let out = channel_json(&mut tx, ctx, uuid(c)?).await?;
            tx.commit().await?;
            out
        }
        ("PATCH", ["channels", c]) => update_channel(k, ctx, uuid(c)?, body()?).await?,
        ("POST", ["channels", c, "members"]) => change_members(k, ctx, uuid(c)?, body()?).await?,
        ("POST", ["channels", c, "join"]) => join(k, ctx, uuid(c)?).await?,
        ("POST", ["channels", c, "leave"]) => leave(k, ctx, uuid(c)?).await?,
        ("GET", ["channels", c, "messages"]) => list_messages(k, ctx, uuid(c)?, req).await?,
        ("POST", ["channels", c, "messages"]) => return Ok(util::created(post(k, ctx, uuid(c)?, body()?).await?)),
        ("POST", ["channels", c, "read"]) => mark_read(k, ctx, uuid(c)?, body()?).await?,
        ("PUT", ["channels", c, "notify"]) => set_notify(k, ctx, uuid(c)?, body()?).await?,
        ("POST", ["read-all"]) => mark_all_read(k, ctx).await?,
        ("GET", ["messages", m]) => get_message(k, ctx, uuid(m)?).await?,
        ("PATCH", ["messages", m]) => edit(k, ctx, uuid(m)?, body()?).await?,
        ("DELETE", ["messages", m]) => delete(k, ctx, uuid(m)?).await?,
        ("GET", ["search"]) => search(k, ctx, req).await?,
        _ => return Err(Error::NotFound("chat endpoint".into())),
    };
    Ok(util::ok(out))
}

/// Whether the caller may read a chat message that was not deleted (for attachment downloads).
pub async fn message_visible(tx: &mut Tx, ctx: &Ctx, message: Uuid) -> Result<bool> {
    Ok(readable_message(tx, ctx, message).await.is_ok_and(|(doc, _)| !util::b(&doc, "deleted")))
}
