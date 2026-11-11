//! Mail administration for the workspace's Comms managers (`/api/app/comms/domain/...`, gated on
//! writing Communication Settings), over what the mail server's administration API reaches
//! (`hosted::Admin`) and what Ferrum keeps itself:
//! * a mailbox's storage quota (`x:Account` `quotas/maxDiskQuota`; at the limit the server defers
//!   new mail for it, "Mailbox over quota.", and refuses saving more in it);
//! * a spam summary: how often people marked mail as spam or not spam in the last 30 days (the
//!   server's training samples, counts only);
//! * senders the whole workspace allows or blocks: the server's own lists are server-wide (shared
//!   with every workspace on it), so these are Ferrum's, applied as mail arrives (`arrivals.rs`);
//! * retention of Trash and Spam: one setting for the whole mail server, shown, not changed here.
//!
//! Every change is written to the audit trail of the workspace's Communication Settings.

use crate::hosted::{self, Admin};
use crate::util;
use chrono::{DateTime, Duration, Utc};
use ferrum_kernel::{Action, Ctx, Error, Kernel, Result};
use serde_json::{Value, json};
use uuid::Uuid;

/// The most a quota may be set to (1 TiB), and the least (10 MB).
const MAX_QUOTA: u64 = 1 << 40;
const MIN_QUOTA: u64 = 10 << 20;
/// Training samples read for the summary, at most.
const MAX_SAMPLES: usize = 20_000;

fn manager(ctx: &Ctx) -> Result<()> {
    ctx.require("CommsSettings", Action::Write).map(|_| ())
}

/// An administrative change in the audit trail of the workspace's Communication Settings.
async fn audit(k: &Kernel, ctx: &Ctx, action: &str, diff: Value) -> Result<()> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let settings: Option<Uuid> =
        sqlx::query_scalar("select id from e_comms_settings where tenant_id = $1 limit 1").bind(ctx.tenant).fetch_optional(&mut *tx).await?;
    if let Some(id) = settings {
        ferrum_kernel::audit::record(&mut tx, ctx, "CommsSettings", id, action, None, diff).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// `PUT /domain/mailboxes/{account}/quota {bytes: n | null}`: a mailbox's storage limit, or none.
pub(crate) async fn set_quota(k: &Kernel, ctx: &Ctx, account: &str, body: &serde_json::Map<String, Value>) -> Result<Value> {
    manager(ctx)?;
    let bytes = match body.get("bytes") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_u64().filter(|b| (MIN_QUOTA..=MAX_QUOTA).contains(b)).ok_or_else(|| Error::field("bytes", "between 10 MB and 1 TB, or none"))?),
    };
    let admin = Admin::connect(k).await?;
    let accounts = admin.accounts(k, ctx.tenant).await?;
    let ours = accounts.people.values().chain(accounts.groups.values()).find(|a| a.id == account).ok_or_else(|| Error::NotFound("mailbox".into()))?;
    let r = admin.jmap(k, vec![("x:Account/set", json!({"update": {account: {"quotas/maxDiskQuota": bytes}}}))]).await?;
    hosted::updated(&r[0], account)?;
    audit(k, ctx, "mail.quota", json!({"mailbox": ours.name, "quota": bytes})).await?;
    Ok(json!({"account": account, "quota": bytes}))
}

/// Which samples fall in the window and what they say: (spam, not spam) per account.
fn tally(samples: &[Value], ours: &[(String, String)], hold: Duration, since: DateTime<Utc>) -> Vec<(String, u64, u64)> {
    let mut out: Vec<(String, u64, u64)> = ours.iter().map(|(_, email)| (email.clone(), 0, 0)).collect();
    for s in samples {
        let Some(i) = ours.iter().position(|(id, _)| s["accountId"].as_str() == Some(id.as_str())) else { continue };
        let made = s["expiresAt"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.with_timezone(&Utc) - hold);
        if made.is_none_or(|m| m < since) {
            continue;
        }
        if s["isSpam"] == json!(true) { out[i].1 += 1 } else { out[i].2 += 1 }
    }
    out.retain(|r| r.1 + r.2 > 0);
    out.sort_by(|a, b| (b.1 + b.2).cmp(&(a.1 + a.2)).then_with(|| a.0.cmp(&b.0)));
    out
}

/// `GET /domain/spam`: in the last 30 days, how often the workspace's people marked mail as spam
/// and as not spam, in all and per mailbox (counts only, nothing of the messages).
pub(crate) async fn spam(k: &Kernel, ctx: &Ctx) -> Result<Value> {
    manager(ctx)?;
    let admin = Admin::connect(k).await?;
    let accounts = admin.accounts(k, ctx.tenant).await?;
    let domain = hosted::mail_domain(k, ctx.tenant).await?.unwrap_or_default();
    let ours: Vec<(String, String)> =
        accounts.people.values().chain(accounts.groups.values()).map(|a| (a.id.clone(), format!("{}@{domain}", a.name))).collect();
    let settings = admin.jmap(k, vec![("x:SpamClassifier/get", json!({"ids": ["singleton"]}))]).await?;
    let hold = Duration::milliseconds(settings[0]["list"][0]["holdSamplesFor"].as_i64().unwrap_or(180 * 86_400_000));
    let mut samples = Vec::new();
    let mut position = 0;
    while samples.len() < MAX_SAMPLES {
        let r = admin
            .jmap(
                k,
                vec![
                    ("x:SpamTrainingSample/query", json!({"position": position, "limit": 500})),
                    ("x:SpamTrainingSample/get", json!({"#ids": {"resultOf": "0", "name": "x:SpamTrainingSample/query", "path": "/ids"}, "properties": ["isSpam", "accountId", "expiresAt"]})),
                ],
            )
            .await?;
        samples.extend(r[1]["list"].as_array().cloned().unwrap_or_default());
        match r[0]["ids"].as_array().map_or(0, Vec::len) {
            0 => break,
            n => position += n,
        }
    }
    let rows = tally(&samples, &ours, hold, util::now() - Duration::days(30));
    Ok(json!({
        "days": 30,
        "spam": rows.iter().map(|r| r.1).sum::<u64>(),
        "not_spam": rows.iter().map(|r| r.2).sum::<u64>(),
        "mailboxes": rows.iter().map(|(email, spam, ham)| json!({"email": email, "spam": spam, "not_spam": ham})).collect::<Vec<_>>(),
    }))
}

/// `GET /domain/retention`: how long the mail server keeps Trash and Spam, and sent-message
/// receipts. One setting for the whole server (other workspaces may share it): read only here.
pub(crate) async fn retention(k: &Kernel, ctx: &Ctx) -> Result<Value> {
    manager(ctx)?;
    let admin = Admin::connect(k).await?;
    let r = admin.jmap(k, vec![("x:DataRetention/get", json!({"ids": ["singleton"]}))]).await?;
    let d = &r[0]["list"][0];
    let days = |key: &str| d[key].as_i64().map(|ms| ms / 86_400_000);
    Ok(json!({"trash_and_spam_days": days("expungeTrashAfter"), "sent_status_days": days("expungeSubmissionsAfter"), "server_wide": true}))
}

/// A sender as the lists keep it: an address (`ann@example.com`) or a domain (`example.com`, which
/// covers its subdomains), lower case.
pub(crate) fn sender(value: &str) -> Option<String> {
    let v = value.trim().trim_start_matches('@').to_lowercase();
    let (local, domain) = match v.split_once('@') {
        Some((l, d)) => (Some(l), d),
        None => (None, v.as_str()),
    };
    let label_ok =
        |l: &str| !l.is_empty() && l.len() <= 63 && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') && !l.starts_with('-') && !l.ends_with('-');
    let domain_ok = domain.contains('.') && domain.len() <= 253 && domain.split('.').all(label_ok);
    let local_ok = local.is_none_or(|l| !l.is_empty() && l.len() <= 64 && l.bytes().all(|b| b.is_ascii_graphic() && !b"@,;:<>()[]\\\"".contains(&b)));
    (domain_ok && local_ok && v.len() <= 254).then_some(v)
}

/// `GET /domain/senders`: the workspace's allowed and blocked senders, with who added each and when.
pub(crate) async fn senders(k: &Kernel, ctx: &Ctx) -> Result<Value> {
    manager(ctx)?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let rows: Vec<(String, String, Option<String>, DateTime<Utc>)> = sqlx::query_as(
        "select s.sender, s.kind, coalesce(nullif(u.full_name, ''), u.email::text), s.added_at from comms_mail_sender s \
         left join app_user u on u.tenant_id = s.tenant_id and u.id = s.added_by where s.tenant_id = $1 order by s.kind, s.sender",
    )
    .bind(ctx.tenant)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(
        json!({"senders": rows.into_iter().map(|(sender, kind, by, at)| json!({"sender": sender, "kind": kind, "added_by": by, "added_at": util::ts(at)})).collect::<Vec<_>>()}),
    )
}

/// `POST /domain/senders {sender, kind: allow|block}`: adds one (or moves it to the other list).
/// The workspace's own domain cannot be blocked.
pub(crate) async fn add_sender(k: &Kernel, ctx: &Ctx, body: &serde_json::Map<String, Value>) -> Result<Value> {
    manager(ctx)?;
    let kind = body.get("kind").and_then(Value::as_str).filter(|k| ["allow", "block"].contains(k)).ok_or_else(|| Error::field("kind", "allow or block"))?;
    let who = sender(body.get("sender").and_then(Value::as_str).unwrap_or_default())
        .ok_or_else(|| Error::field("sender", "an address (name@example.com) or a domain (example.com)"))?;
    if kind == "block"
        && let Some(own) = hosted::mail_domain(k, ctx.tenant).await?
        && (who == own || who.ends_with(&format!("@{own}")) || who.ends_with(&format!(".{own}")))
    {
        return Err(Error::field("sender", "the workspace's own domain and its people cannot be blocked here"));
    }
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    sqlx::query(
        "insert into comms_mail_sender (tenant_id, sender, kind, added_by) values ($1, $2, $3, $4) \
         on conflict (tenant_id, sender) do update set kind = excluded.kind, added_by = excluded.added_by, added_at = now()",
    )
    .bind(ctx.tenant)
    .bind(&who)
    .bind(kind)
    .bind(ctx.user)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    audit(k, ctx, &format!("mail.{kind}"), json!({"sender": who})).await?;
    Ok(json!({"sender": who, "kind": kind}))
}

/// `DELETE /domain/senders/{sender}`.
pub(crate) async fn remove_sender(k: &Kernel, ctx: &Ctx, who: &str) -> Result<Value> {
    manager(ctx)?;
    let who = who.trim().to_lowercase();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let gone: Option<String> = sqlx::query_scalar("delete from comms_mail_sender where tenant_id = $1 and sender = $2 returning kind")
        .bind(ctx.tenant)
        .bind(&who)
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    let kind = gone.ok_or_else(|| Error::NotFound("sender".into()))?;
    audit(k, ctx, &format!("mail.un{kind}"), json!({"sender": who})).await?;
    Ok(json!({"sender": who, "removed": kind}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn senders_are_addresses_or_domains() {
        assert_eq!(sender(" Ann@Example.COM "), Some("ann@example.com".into()));
        assert_eq!(sender("@promo.example"), Some("promo.example".into()));
        assert_eq!(sender("mail.promo.example"), Some("mail.promo.example".into()));
        for bad in [
            "",
            "example",
            "a@b",
            "a b@example.com",
            "-x.example",
            "x-.example",
            "a@@example.com",
            "<a@example.com>",
            "a@exa mple.com",
            &format!("{}.com", "a".repeat(64)),
        ] {
            assert_eq!(sender(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_spam_summary_counts_the_last_30_days_of_this_workspace() {
        let hold = Duration::days(180);
        let now = DateTime::parse_from_rfc3339("2026-11-12T00:00:00Z").unwrap().with_timezone(&Utc);
        // Made 1, 10 and 40 days ago (expiry = made + 180 days); one of another workspace's account.
        let at = |days_ago: i64| util::ts(now - Duration::days(days_ago) + hold);
        let samples = vec![
            json!({"accountId": "g", "isSpam": true, "expiresAt": at(1)}),
            json!({"accountId": "g", "isSpam": false, "expiresAt": at(10)}),
            json!({"accountId": "h", "isSpam": true, "expiresAt": at(10)}),
            json!({"accountId": "g", "isSpam": true, "expiresAt": at(40)}),
            json!({"accountId": "zz", "isSpam": true, "expiresAt": at(1)}),
            json!({"accountId": "h", "isSpam": true}),
        ];
        let ours = vec![("g".to_string(), "admin".to_string()), ("h".to_string(), "omar.haddad".to_string()), ("i".to_string(), "quiet".to_string())];
        assert_eq!(tally(&samples, &ours, hold, now - Duration::days(30)), [("admin".to_string(), 1, 1), ("omar.haddad".to_string(), 1, 0)]);
    }
}
