//! A person's calendars (`Calendar`: name, tone, shown or hidden, the default for new events) and
//! sharing them with colleagues at three levels, and THE access rule every route that reads or
//! writes events applies ([`level`]): what one person may know of one event.
//!
//! | Level | What the person gets |
//! |---|---|
//! | `Owner` | the organizer: everything, and changes |
//! | `Edit` | a share "make changes": everything, and changes (not delete, not sharing) |
//! | `Details` | a guest, a share "see all details", or a Public event: what it is, when, where, who |
//! | `FreeBusy` | a share "see only free and busy", or a "busy only" event in a details share: when, as "Busy" |
//! | `None` | nothing: the event does not exist for them |
//!
//! Every event belongs to exactly one calendar of its organizer's; one with none (made before
//! 0.17) belongs to its organizer's default calendar, which [`ensure_default`] makes ("Personal")
//! and fills, idempotently, the first time the organizer's calendars are asked for. A share counts
//! only while both people are active in the workspace (a leaver is deactivated: `app_user.is_active`).
//!
//! A share names a person (by sign-in email) or a group: a role of the workspace, as Drive shares
//! with roles. A group's members are read when access is checked (`user_role`, unexpired), so
//! someone taken out of the role loses the calendar on their next request.

use crate::util::{self, s};
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, Tx};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;

pub(crate) const SHARES: &str = "e_calendar__shares";
pub const TONES: &[&str] = &["blue", "green", "amber", "red", "purple", "neutral"];
/// Share levels as stored.
pub const FREE_BUSY: &str = "Free/busy";
pub const DETAILS: &str = "Details";
pub const EDIT: &str = "Edit";
/// The visibility of an event whose details only its organizer and guests see, even in a shared calendar.
pub const BUSY_ONLY: &str = "Busy only";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    None,
    FreeBusy,
    Details,
    Edit,
    Owner,
}

impl Level {
    pub fn word(self) -> &'static str {
        match self {
            Level::None => "none",
            Level::FreeBusy => "free_busy",
            Level::Details => "details",
            Level::Edit => "edit",
            Level::Owner => "owner",
        }
    }
}

fn share_level(v: &str) -> Level {
    match v {
        EDIT => Level::Edit,
        DETAILS => Level::Details,
        FREE_BUSY => Level::FreeBusy,
        _ => Level::None,
    }
}

/// What a viewer was given on calendars of other people: calendar id → level (active people only).
pub type Shared = BTreeMap<Uuid, Level>;

/// THE access rule: what `me` may know of `event`, given the calendars shared with them.
pub fn level(me: &str, event: &Doc, shared: &Shared) -> Level {
    let me = me.to_lowercase();
    if s(event, "owner").is_some_and(|o| o.to_lowercase() == me) {
        return Level::Owner;
    }
    let guest = util::rows(event, "attendees").iter().any(|a| s(a, "email").is_some_and(|e| e.to_lowercase() == me));
    let share = s(event, "calendar").and_then(|c| c.parse().ok()).and_then(|c: Uuid| shared.get(&c).copied()).unwrap_or(Level::None);
    // A "busy only" event keeps its details to its organizer and guests.
    let share = if s(event, "visibility") == Some(BUSY_ONLY) { share.min(Level::FreeBusy) } else { share };
    let public = if s(event, "visibility") == Some("Public") { Level::Details } else { Level::None };
    let guest = if guest { Level::Details } else { Level::None };
    share.max(public).max(guest)
}

/// An occurrence's fields as a free/busy viewer may see them: when, and "Busy".
pub fn redact(o: &mut Map<String, Value>) {
    for k in [
        "location",
        "meeting_link",
        "description",
        "description_html",
        "attachments",
        "category",
        "color",
        "reference_entity",
        "reference_id",
        "guests",
        "proposed",
    ] {
        o.remove(k);
    }
    o.insert("subject".into(), json!("Busy"));
    o.insert("is_organizer".into(), json!(false));
    o.insert("my_response".into(), Value::Null);
}

/// The calendars shared with `me` (by name, or through a role I hold now) whose owners are still
/// active, with my level on each (the highest when shared both ways).
pub async fn shared_with(tx: &mut Tx, tenant: Uuid, me: &str) -> Result<Shared> {
    let rows: Vec<(Uuid, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select c.id, s.level from e_calendar c join {SHARES} s on s.tenant_id = c.tenant_id and s.parent_id = c.id \
         join app_user o on o.tenant_id = c.tenant_id and lower(o.email::text) = c.owner and o.is_active \
         join app_user m on m.tenant_id = c.tenant_id and lower(m.email::text) = $2 and m.is_active \
         where c.tenant_id = $1 and c.owner <> $2 and (lower(s.person) = $2 or (s.role is not null and exists (select 1 from user_role ur \
           where ur.tenant_id = c.tenant_id and ur.user_id = m.id and ur.role = s.role and (ur.expires_at is null or ur.expires_at > now()))))"
    )))
    .bind(tenant)
    .bind(me.to_lowercase())
    .fetch_all(&mut **tx)
    .await?;
    let mut out = Shared::new();
    for (id, l) in rows {
        let l = share_level(&l);
        out.entry(id).and_modify(|x| *x = (*x).max(l)).or_insert(l);
    }
    Ok(out)
}

/// `GET /calendar/groups`: the groups (roles) a calendar can be shared with, with how many active people
/// hold each (plugins' own roles, held by service users, are not groups of people).
pub async fn groups(k: &Kernel, ctx: &Ctx) -> Result<Value> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let rows: Vec<(String, Option<String>, i64)> = sqlx::query_as(
        "select r.name, r.description, (select count(*) from user_role ur join app_user u on u.tenant_id = ur.tenant_id and u.id = ur.user_id and u.is_active \
            where ur.tenant_id = r.tenant_id and ur.role = r.name and (ur.expires_at is null or ur.expires_at > now())) \
         from role r where r.tenant_id = $1 and r.name not like 'plugin:%' order by r.name",
    )
    .bind(ctx.tenant)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(
        json!({"groups": rows.into_iter().map(|(name, description, members)| json!({"name": name, "description": description, "members": members})).collect::<Vec<_>>()}),
    )
}

/// My default calendar ("Personal", made now if I have none), with my events that have no calendar put in it.
pub async fn ensure_default(k: &Kernel, tx: &mut Tx, ctx: &Ctx, owner: &str) -> Result<Uuid> {
    let owner = owner.to_lowercase();
    let found: Option<Uuid> = sqlx::query_scalar("select id from e_calendar where tenant_id = $1 and owner = $2 order by is_default desc, created_at limit 1")
        .bind(ctx.tenant)
        .bind(&owner)
        .fetch_optional(&mut **tx)
        .await?;
    let id = match found {
        Some(id) => id,
        None => {
            let doc = util::obj(json!({"calendar_name": "Personal", "owner": owner, "tone": "blue", "is_default": true}));
            util::doc_id(&k.insert_tx(&util::sys(ctx), tx, "Calendar", doc).await?)?
        }
    };
    // One statement, indexed by owner: safe to run again, and cheap (measured in the report).
    sqlx::query("update e_calendar_event set calendar = $3 where tenant_id = $1 and owner = $2 and calendar is null")
        .bind(ctx.tenant)
        .bind(&owner)
        .bind(id)
        .execute(&mut **tx)
        .await?;
    Ok(id)
}

/// One share as its owner reads it: a person or a group, and the level.
fn share_json(r: &Doc) -> Value {
    match s(r, "role") {
        Some(role) => json!({"role": role, "level": r.get("level")}),
        None => json!({"person": r.get("person"), "level": r.get("level")}),
    }
}

/// A calendar as its owner or a viewer reads it.
fn calendar_json(doc: &Doc, level: Level, owner_name: Option<String>, me: &str) -> Value {
    let mine = level == Level::Owner;
    json!({
        "id": doc.get("id"), "name": doc.get("calendar_name"), "tone": s(doc, "tone").unwrap_or("blue"),
        "hidden": mine && util::b(doc, "hidden"), "is_default": mine && util::b(doc, "is_default"),
        "owner": doc.get("owner"), "owner_name": owner_name, "level": level.word(),
        // Who has access: only the owner sees the list.
        "shares": if mine { Value::Array(util::rows(doc, "shares").iter().map(share_json).collect()) } else { json!([]) },
        "mine": mine && s(doc, "owner").is_some_and(|o| o == me),
        // Subscribed from outside: where from (its host), when it last worked, why not.
        "subscription": if mine && util::b(doc, "is_subscription") { crate::subscribe::summary(doc) } else { Value::Null },
    })
}

async fn load(tx: &mut Tx, tenant: Uuid, where_sql: &str, me: &str, ids: &[Uuid]) -> Result<Vec<Doc>> {
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(c) || jsonb_build_object('shares', (select coalesce(jsonb_agg(to_jsonb(s) order by s.idx), '[]') from {SHARES} s \
            where s.tenant_id = c.tenant_id and s.parent_id = c.id)) from e_calendar c where c.tenant_id = $1 and ({where_sql}) order by c.created_at"
    )))
    .bind(tenant)
    .bind(me)
    .bind(ids)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(util::obj).collect())
}

/// `GET /calendar/calendars`: my calendars (the default made if I have none) and those shared with me.
pub async fn list(k: &Kernel, ctx: &Ctx) -> Result<Value> {
    let me = ctx.email.to_lowercase();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    ensure_default(k, &mut tx, ctx, &me).await?;
    let shared = shared_with(&mut tx, ctx.tenant, &me).await?;
    let ids: Vec<Uuid> = shared.keys().copied().collect();
    let mut out = Vec::new();
    for doc in load(&mut tx, ctx.tenant, "c.owner = $2 or c.id = any($3)", &me, &ids).await? {
        let owner = s(&doc, "owner").unwrap_or_default().to_string();
        let level = if owner == me { Level::Owner } else { util::id(&doc, "id").and_then(|i| shared.get(&i).copied()).unwrap_or(Level::None) };
        let name = if owner == me { None } else { crate::calendar::display_name(&mut tx, ctx.tenant, &owner).await? };
        out.push(calendar_json(&doc, level, name, &me));
    }
    tx.commit().await?;
    Ok(json!({"calendars": out}))
}

/// The fields a person may set on their own calendar, checked.
fn fields(body: &Map<String, Value>, creating: bool) -> Result<Doc> {
    let mut doc = Doc::new();
    if let Some(n) = body.get("name").and_then(Value::as_str).map(str::trim) {
        if n.is_empty() {
            return Err(Error::field("name", "give the calendar a name"));
        }
        doc.insert("calendar_name".into(), json!(util::cut(n, 100)));
    } else if creating {
        return Err(Error::field("name", "give the calendar a name"));
    }
    if let Some(t) = body.get("tone").and_then(Value::as_str) {
        if !TONES.contains(&t) {
            return Err(Error::field("tone", "one of blue, green, amber, red, purple, neutral"));
        }
        doc.insert("tone".into(), json!(t));
    }
    if let Some(h) = body.get("hidden").and_then(Value::as_bool) {
        doc.insert("hidden".into(), json!(h));
    }
    if let Some(r) = body.get("remind").and_then(Value::as_bool) {
        doc.insert("remind".into(), json!(r));
    }
    if let Some(list) = body.get("shares") {
        let list = list.as_array().ok_or_else(|| Error::field("shares", "a list of {person, level}"))?;
        let mut rows = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for r in list {
            let level = r
                .get("level")
                .and_then(Value::as_str)
                .filter(|l| [FREE_BUSY, DETAILS, EDIT].contains(l))
                .ok_or_else(|| Error::field("shares", "a level is Free/busy, Details or Edit"))?;
            let role = r.get("role").and_then(Value::as_str).map(str::trim).filter(|g| !g.is_empty());
            let row = match role {
                Some(g) => json!({"role": util::cut(g, 100), "level": level}),
                None => {
                    let person = r
                        .get("person")
                        .and_then(Value::as_str)
                        .map(|p| p.trim().to_lowercase())
                        .filter(|p| p.contains('@'))
                        .ok_or_else(|| Error::field("shares", "each share names a person by email, or a group"))?;
                    json!({"person": person, "level": level})
                }
            };
            let key = row.get("role").map(|g| format!("role:{g}")).unwrap_or_else(|| format!("person:{}", row["person"]));
            if seen.insert(key) {
                rows.push(row);
            }
        }
        doc.insert("shares".into(), Value::Array(rows));
    }
    Ok(doc)
}

/// One of my calendars, or not found (another person's calendar is not mine to change).
async fn mine(tx: &mut Tx, ctx: &Ctx, id: Uuid) -> Result<Doc> {
    let me = ctx.email.to_lowercase();
    load(tx, ctx.tenant, "c.id = any($3) and c.owner = $2", &me, &[id]).await?.into_iter().next().ok_or_else(|| Error::NotFound("Calendar".into()))
}

/// Shares only with active colleagues (not oneself) and groups that exist.
async fn check_shares(tx: &mut Tx, ctx: &Ctx, doc: &Doc) -> Result<()> {
    let people: Vec<String> = util::rows(doc, "shares").iter().filter_map(|r| s(r, "person").map(str::to_string)).collect();
    if people.iter().any(|p| *p == ctx.email.to_lowercase()) {
        return Err(Error::field("shares", "you have your own calendar already"));
    }
    let known: Vec<String> = util::users(tx, ctx.tenant, &people).await?.into_iter().map(|u| u.email.to_lowercase()).collect();
    if let Some(p) = people.iter().find(|p| !known.contains(p)) {
        return Err(Error::field("shares", format!("{p} is not an active person in this workspace")));
    }
    for g in util::rows(doc, "shares").iter().filter_map(|r| s(r, "role")) {
        let ok: bool =
            sqlx::query_scalar("select exists (select 1 from role where tenant_id = $1 and name = $2)").bind(ctx.tenant).bind(g).fetch_one(&mut **tx).await?;
        if !ok {
            return Err(Error::field("shares", format!("there is no group named {g}")));
        }
    }
    Ok(())
}

/// `POST /calendar/calendars`, `PATCH|DELETE /calendar/calendars/{id}` (DELETE `?events=move:{id}|delete`).
pub async fn change(k: &Kernel, ctx: &Ctx, method: &str, id: Option<Uuid>, body: Map<String, Value>, events: Option<&str>) -> Result<Value> {
    let me = ctx.email.to_lowercase();
    let sys = util::sys(ctx);
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let default = ensure_default(k, &mut tx, ctx, &me).await?;
    let out = match (method, id) {
        ("POST", None) => {
            let mut doc = fields(&body, true)?;
            check_shares(&mut tx, ctx, &doc).await?;
            doc.insert("owner".into(), json!(me));
            doc.entry("tone").or_insert(json!("green"));
            Value::Object(k.insert_tx(&sys, &mut tx, "Calendar", doc).await?)
        }
        ("PATCH", Some(id)) => {
            mine(&mut tx, ctx, id).await?;
            let mut doc = fields(&body, false)?;
            check_shares(&mut tx, ctx, &doc).await?;
            if body.get("is_default").and_then(Value::as_bool) == Some(true) {
                sqlx::query("update e_calendar set is_default = (id = $3) where tenant_id = $1 and owner = $2")
                    .bind(ctx.tenant)
                    .bind(&me)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                doc.insert("is_default".into(), json!(true));
            }
            let reminding = doc.contains_key("remind");
            let saved = k.update_tx(&sys, &mut tx, "Calendar", id, doc, None).await?;
            // Reminders on or off for a subscription: its events are read again on the next round.
            if reminding {
                sqlx::query("update e_calendar set fetch_etag = null, fetch_modified = null, next_fetch_at = now() where tenant_id = $1 and id = $2 and is_subscription")
                    .bind(ctx.tenant)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
            Value::Object(saved)
        }
        ("DELETE", Some(id)) => {
            let cal = mine(&mut tx, ctx, id).await?;
            if id == default {
                return Err(Error::invalid("make another calendar the default before deleting this one"));
            }
            let list: Vec<Uuid> = sqlx::query_scalar("select id from e_calendar_event where tenant_id = $1 and calendar = $2")
                .bind(ctx.tenant)
                .bind(id)
                .fetch_all(&mut *tx)
                .await?;
            // A subscription's events are copies: they go with it.
            let events = if util::b(&cal, "is_subscription") { Some("delete") } else { events };
            match events.unwrap_or("") {
                e if e.starts_with("move:") => {
                    let to: Uuid = e[5..].parse().map_err(|_| Error::field("events", "move:{calendar id}"))?;
                    mine(&mut tx, ctx, to).await?;
                    sqlx::query("update e_calendar_event set calendar = $3 where tenant_id = $1 and calendar = $2")
                        .bind(ctx.tenant)
                        .bind(id)
                        .bind(to)
                        .execute(&mut *tx)
                        .await?;
                }
                // Deleting events through the kernel tells their guests they are cancelled.
                "delete" => {
                    for e in &list {
                        k.delete_tx(&sys, &mut tx, "CalendarEvent", *e, None).await?;
                    }
                }
                _ if list.is_empty() => {}
                _ => return Err(Error::field("events", "say where its events go: move:{calendar id} or delete")),
            }
            k.delete_tx(&sys, &mut tx, "Calendar", id, None).await?;
            json!({"deleted": id, "events": list.len()})
        }
        _ => return Err(Error::NotFound("calendar endpoint".into())),
    };
    tx.commit().await?;
    Ok(out)
}

/// Before an event is saved: it belongs to one of its organizer's calendars (the default when none
/// is named). Another person's calendar is refused.
pub async fn place_event(k: &Kernel, tx: &mut Tx, ctx: &Ctx, doc: &mut Doc) -> Result<()> {
    let Some(owner) = s(doc, "owner").map(str::to_lowercase) else { return Ok(()) };
    match s(doc, "calendar").and_then(|c| c.parse::<Uuid>().ok()) {
        Some(c) => {
            let found: Option<Option<bool>> = sqlx::query_scalar("select is_subscription from e_calendar where tenant_id = $1 and id = $2 and owner = $3")
                .bind(ctx.tenant)
                .bind(c)
                .bind(&owner)
                .fetch_optional(&mut **tx)
                .await?;
            let Some(subscribed) = found else {
                return Err(Error::field("calendar", "an event goes in one of its organizer's own calendars"));
            };
            // Only the fetch (the system itself, no person) writes a subscription's events.
            if subscribed.unwrap_or(false) && !ctx.user.is_nil() {
                return Err(Error::field("calendar", "a subscribed calendar is read-only: its events come from its address"));
            }
        }
        None => {
            let id = ensure_default(k, tx, ctx, &owner).await?;
            doc.insert("calendar".into(), json!(id));
        }
    }
    Ok(())
}

/// `POST /calendar/subscriptions/{id}/refresh`: fetch one of my subscriptions now.
pub async fn refresh(k: &Kernel, ctx: &Ctx, id: Uuid) -> Result<Value> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let cal = mine(&mut tx, ctx, id).await?;
    tx.commit().await?;
    if !util::b(&cal, "is_subscription") {
        return Err(Error::invalid("this calendar is not a subscription"));
    }
    Ok(match crate::subscribe::refresh(k, ctx.tenant, id, false).await? {
        Ok(said) => json!({"ok": true, "result": said}),
        Err(e) => json!({"ok": false, "result": e}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(v: Value) -> Doc {
        util::obj(v)
    }

    #[test]
    fn the_access_rule() {
        let cal: Uuid = "0192d3b1-0000-7000-8000-0000000000c1".parse().unwrap();
        let other: Uuid = "0192d3b1-0000-7000-8000-0000000000c2".parse().unwrap();
        let event = ev(json!({"owner": "ana@acme.test", "calendar": cal.to_string(), "visibility": "Private", "attendees": [{"email": "Guest@acme.test"}]}));
        let busy_only = ev(json!({"owner": "ana@acme.test", "calendar": cal.to_string(), "visibility": BUSY_ONLY}));
        let public = ev(json!({"owner": "ana@acme.test", "calendar": other.to_string(), "visibility": "Public"}));
        let none = Shared::new();
        let at = |l: Level| Shared::from([(cal, l)]);
        assert_eq!(level("ANA@acme.test", &event, &none), Level::Owner);
        assert_eq!(level("guest@acme.test", &event, &none), Level::Details);
        assert_eq!(level("bo@acme.test", &event, &none), Level::None, "not shared");
        assert_eq!(level("bo@acme.test", &event, &at(Level::FreeBusy)), Level::FreeBusy);
        assert_eq!(level("bo@acme.test", &event, &at(Level::Details)), Level::Details);
        assert_eq!(level("bo@acme.test", &event, &at(Level::Edit)), Level::Edit);
        // A busy-only event in a shared calendar is busy time to everyone but its organizer and guests.
        assert_eq!(level("bo@acme.test", &busy_only, &at(Level::Details)), Level::FreeBusy);
        assert_eq!(level("bo@acme.test", &busy_only, &at(Level::Edit)), Level::FreeBusy);
        // A share of one calendar says nothing about another; a public event is details for all.
        assert_eq!(level("bo@acme.test", &public, &at(Level::FreeBusy)), Level::Details);
        let mut o = util::obj(json!({"subject": "Salary review", "location": "Room 4", "description": "x", "is_organizer": true, "start": "s"}));
        redact(&mut o);
        assert_eq!(o, util::obj(json!({"subject": "Busy", "is_organizer": false, "my_response": null, "start": "s"})));
        assert_eq!(share_level("Edit"), Level::Edit);
        assert!(fields(&util::obj(json!({"name": " "})), true).is_err());
        assert!(fields(&util::obj(json!({"name": "Team", "tone": "pink"})), true).is_err());
        assert!(fields(&util::obj(json!({"name": "Team", "shares": [{"person": "bo@acme.test", "level": "Owner"}]})), true).is_err());
        let f = fields(
            &util::obj(json!({"name": "Team", "shares": [{"person": "Bo@acme.test", "level": "Edit"}, {"person": "bo@acme.test", "level": "Details"}]})),
            true,
        )
        .unwrap();
        assert_eq!(f["shares"], json!([{"person": "bo@acme.test", "level": "Edit"}]));
    }
}
