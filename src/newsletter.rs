//! Newsletters, sent in batches from maintenance to the members of their email groups — never
//! to unsubscribed ones — within the tenant's hourly limit. Every recipient is claimed in
//! `comms_newsletter_delivery` before the mail goes out, so nobody gets a newsletter twice (a
//! worker dying mid-send leaves that one recipient unmailed rather than mailed twice). Each mail
//! carries a signed unsubscribe link and List-Unsubscribe headers (RFC 2369, one-click RFC 8058).

use crate::account;
use crate::mail::{self, Outgoing, SendError};
use crate::template;
use crate::util::{self, id, s};
use async_trait::async_trait;
use ferrum_kernel::{Doc, DocHook, Error, HookCtx, Kernel, Result, SiteRequest, SiteResponse};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Mails per newsletter and maintenance round at most.
const BATCH: i64 = 100;
/// Child table of `Newsletter.email_groups`.
const GROUPS: &str = "e_newsletter__email_groups";

pub struct NewsletterHook;

#[async_trait]
impl DocHook for NewsletterHook {
    async fn validate(&self, _hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        for f in ["subject", "content"] {
            if let Some(src) = s(doc, f) {
                template::check(src).map_err(|m| Error::field(f, m))?;
            }
        }
        let rows = util::rows(doc, "email_groups");
        let groups: Vec<Option<&str>> = rows.iter().map(|r| r.get("email_group").and_then(Value::as_str)).collect();
        let mut unique = groups.clone();
        unique.sort();
        unique.dedup();
        if unique.len() != groups.len() {
            return Err(Error::field("email_groups", "each email group can be listed once"));
        }
        Ok(())
    }

    async fn after_save(&self, hc: &mut HookCtx<'_>, doc: &Doc, old: Option<&Doc>) -> Result<()> {
        if let Some(old) = old
            && !hc.ctx.is_system
            && s(old, "status").is_some_and(|st| st != "Draft")
        {
            for f in ["subject", "content", "email_groups", "email_account", "schedule_at"] {
                if old.get(f) != doc.get(f) {
                    return Err(Error::invalid("only draft newsletters can be edited; move it back to Draft first"));
                }
            }
        }
        Ok(())
    }

    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, _params: &Value) -> Result<Option<Value>> {
        let newsletter = util::doc_id(doc)?;
        let status = s(doc, "status").unwrap_or("Draft");
        let mut v = Doc::new();
        match name {
            "schedule" => {
                if status != "Draft" {
                    return Err(Error::invalid("only draft newsletters can be scheduled"));
                }
                if util::settings(hc.tx, hc.ctx.tenant).await?.public_url.is_none() {
                    return Err(Error::invalid("set the Public URL in Communication Settings first: every newsletter carries an unsubscribe link"));
                }
                let account = match id(doc, "email_account") {
                    Some(a) => Some(a),
                    None => account::default_outgoing(hc.tx, hc.ctx.tenant, None).await?,
                };
                match account {
                    Some(a) => {
                        let acc = account::load(hc.kernel, hc.tx, hc.ctx.tenant, a).await?.ok_or_else(|| Error::field("email_account", "does not exist"))?;
                        if !acc.enable_outgoing || acc.smtp.is_none() {
                            return Err(Error::field("email_account", format!("{} does not send mail", acc.name)));
                        }
                    }
                    None if hc.kernel.mailer.is_none() => return Err(Error::field("email_account", "set up an outgoing email account first")),
                    None => {}
                }
                v.insert("status".into(), json!("Scheduled"));
                v.insert("schedule_at".into(), json!(s(doc, "schedule_at").map(str::to_string).unwrap_or_else(|| util::ts(util::now()))));
                v.insert("last_error".into(), Value::Null);
            }
            "unschedule" => {
                if status != "Scheduled" {
                    return Err(Error::invalid("only scheduled newsletters can go back to draft"));
                }
                v.insert("status".into(), json!("Draft"));
            }
            "cancel_newsletter" => {
                if !matches!(status, "Scheduled" | "Sending") {
                    return Err(Error::invalid("only scheduled or sending newsletters can be stopped"));
                }
                v.insert("status".into(), json!("Cancelled"));
                v.insert("finished_at".into(), json!(util::ts(util::now())));
            }
            _ => return Ok(None),
        }
        hc.kernel.set_values_tx(hc.ctx, hc.tx, "Newsletter", newsletter, v.clone()).await?;
        Ok(Some(Value::Object(v)))
    }
}

fn unsubscribe_message(newsletter: Uuid, email: &str) -> String {
    format!("unsubscribe:{newsletter}:{}", email.trim().to_lowercase())
}

/// Starts due newsletters and sends the next batch of each, within `budget`.
pub async fn run(k: &Kernel, tenant: Uuid, budget: Duration) -> Result<usize> {
    let started = Instant::now();
    let mut tx = k.db.tenant_tx(tenant).await?;
    sqlx::query(
        "update comms_newsletter_delivery set status = 'failed', error = 'interrupted while sending', updated_at = now() \
         where tenant_id = $1 and status = 'sending' and updated_at < now() - interval '30 minutes'",
    )
    .bind(tenant)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "update e_newsletter set status = 'Sending', started_at = now(), version = version + 1, updated_at = now() \
         where tenant_id = $1 and status = 'Scheduled' and coalesce(schedule_at, now()) <= now()",
    )
    .bind(tenant)
    .execute(&mut *tx)
    .await?;
    let sending: Vec<Uuid> = sqlx::query_scalar("select id from e_newsletter where tenant_id = $1 and status = 'Sending' order by started_at, id")
        .bind(tenant)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    let mut sent = 0;
    for n in sending {
        let left = budget.saturating_sub(started.elapsed());
        if left.is_zero() {
            break;
        }
        sent += send_batch(k, tenant, n, left).await?;
    }
    Ok(sent)
}

async fn update_counts(tx: &mut ferrum_kernel::Tx, tenant: Uuid, newsletter: Uuid, total: i64, finished: bool, error: Option<&str>) -> Result<()> {
    sqlx::query(
        "update e_newsletter n set total_recipients = $3, last_error = coalesce($5, n.last_error), \
         sent_count = (select count(*) from comms_newsletter_delivery d where d.tenant_id = n.tenant_id and d.newsletter_id = n.id and d.status = 'sent'), \
         failed_count = (select count(*) from comms_newsletter_delivery d where d.tenant_id = n.tenant_id and d.newsletter_id = n.id and d.status = 'failed'), \
         status = case when $4 then 'Sent' else n.status end, finished_at = case when $4 then now() else n.finished_at end, \
         version = n.version + 1, updated_at = now() where n.tenant_id = $1 and n.id = $2 and n.status = 'Sending'",
    )
    .bind(tenant)
    .bind(newsletter)
    .bind(total)
    .bind(finished)
    .bind(error)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn send_batch(k: &Kernel, tenant: Uuid, newsletter: Uuid, budget: Duration) -> Result<usize> {
    let started = Instant::now();
    let mut tx = k.db.tenant_tx(tenant).await?;
    let settings = util::settings(&mut tx, tenant).await?;
    let used: i64 = sqlx::query_scalar("select count(*) from comms_newsletter_delivery where tenant_id = $1 and created_at > now() - interval '1 hour'")
        .bind(tenant)
        .fetch_one(&mut *tx)
        .await?;
    let room = (settings.hourly_limit - used).clamp(0, BATCH);
    let n: Doc = sqlx::query_scalar::<_, Value>("select to_jsonb(n) from e_newsletter n where n.tenant_id = $1 and n.id = $2")
        .bind(tenant)
        .bind(newsletter)
        .fetch_one(&mut *tx)
        .await
        .map(util::obj)?;
    let members = format!(
        "from e_email_group_member m where m.tenant_id = $1 and not m.unsubscribed \
         and m.email_group in (select g.email_group from {GROUPS} g where g.tenant_id = $1 and g.parent_id = $2)"
    );
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select count(distinct lower(m.email)) {members}")))
        .bind(tenant)
        .bind(newsletter)
        .fetch_one(&mut *tx)
        .await?;
    let pending: Vec<(String, Option<String>)> = if room > 0 {
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select distinct on (lower(m.email)) lower(m.email), m.member_name {members} \
             and not exists (select 1 from comms_newsletter_delivery d where d.tenant_id = $1 and d.newsletter_id = $2 and d.email = lower(m.email)) \
             order by lower(m.email), m.member_name nulls last limit $3"
        )))
        .bind(tenant)
        .bind(newsletter)
        .bind(room)
        .fetch_all(&mut *tx)
        .await?
    } else {
        vec![]
    };
    if pending.is_empty() {
        let in_flight: i64 =
            sqlx::query_scalar("select count(*) from comms_newsletter_delivery where tenant_id = $1 and newsletter_id = $2 and status = 'sending'")
                .bind(tenant)
                .bind(newsletter)
                .fetch_one(&mut *tx)
                .await?;
        // Done when nobody is left (the hourly limit only pauses).
        update_counts(&mut tx, tenant, newsletter, total, room > 0 && in_flight == 0, None).await?;
        tx.commit().await?;
        return Ok(0);
    }
    let account_id = match id(&n, "email_account") {
        Some(a) => Some(a),
        None => account::default_outgoing(&mut tx, tenant, None).await?,
    };
    let account = match account_id {
        Some(a) => account::load(k, &mut tx, tenant, a).await?,
        None => None,
    };
    let (_, base) = util::public_url(&mut tx, tenant, "/unsubscribe").await?;
    tx.commit().await?;
    let key = util::signing_key(k, tenant).await?;
    let Some(base) = base else {
        let mut tx = k.db.tenant_tx(tenant).await?;
        update_counts(&mut tx, tenant, newsletter, total, false, Some("the Public URL in Communication Settings is not set")).await?;
        tx.commit().await?;
        return Ok(0);
    };
    let (subject_src, content_src) = (s(&n, "subject").unwrap_or_default().to_string(), s(&n, "content").unwrap_or_default().to_string());
    let mut sent = 0;
    let mut stop_error = None;
    for (email, name) in pending {
        if started.elapsed() > budget {
            break;
        }
        let mut tx = k.db.tenant_tx(tenant).await?;
        // Claimed only while still subscribed to one of the groups (they may have just left).
        let claimed = sqlx::query(sqlx::AssertSqlSafe(format!(
            "insert into comms_newsletter_delivery (tenant_id, newsletter_id, email, status) \
             select $1, $2, $3, 'sending' where exists (select 1 from e_email_group_member m where m.tenant_id = $1 \
             and lower(m.email) = $3 and not m.unsubscribed and m.email_group in \
             (select g.email_group from {GROUPS} g where g.tenant_id = $1 and g.parent_id = $2)) on conflict do nothing"
        )))
        .bind(tenant)
        .bind(newsletter)
        .bind(&email)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        tx.commit().await?;
        if claimed == 0 {
            continue;
        }
        let url = format!("{base}?n={newsletter}&e={}&s={}", util::url_encode(&email), util::sign(&key, &unsubscribe_message(newsletter, &email)));
        let outcome = render_and_send(k, account.as_ref(), &subject_src, &content_src, &email, name.as_deref(), &url).await;
        let mut tx = k.db.tenant_tx(tenant).await?;
        match outcome {
            Ok(()) => {
                sent += 1;
                sqlx::query(
                    "update comms_newsletter_delivery set status = 'sent', updated_at = now() where tenant_id = $1 and newsletter_id = $2 and email = $3",
                )
                .bind(tenant)
                .bind(newsletter)
                .bind(&email)
                .execute(&mut *tx)
                .await?;
            }
            Err(e) if e.permanent => {
                sqlx::query("update comms_newsletter_delivery set status = 'failed', error = $4, updated_at = now() where tenant_id = $1 and newsletter_id = $2 and email = $3")
                    .bind(tenant)
                    .bind(newsletter)
                    .bind(&email)
                    .bind(&e.message)
                    .execute(&mut *tx)
                    .await?;
            }
            // The server is unreachable: release the claim, try again next round.
            Err(e) => {
                sqlx::query("delete from comms_newsletter_delivery where tenant_id = $1 and newsletter_id = $2 and email = $3 and status = 'sending'")
                    .bind(tenant)
                    .bind(newsletter)
                    .bind(&email)
                    .execute(&mut *tx)
                    .await?;
                stop_error = Some(e.message);
            }
        }
        tx.commit().await?;
        if stop_error.is_some() {
            break;
        }
    }
    let mut tx = k.db.tenant_tx(tenant).await?;
    update_counts(&mut tx, tenant, newsletter, total, false, stop_error.as_deref()).await?;
    tx.commit().await?;
    Ok(sent)
}

async fn render_and_send(
    k: &Kernel,
    account: Option<&account::Account>,
    subject_src: &str,
    content_src: &str,
    email: &str,
    name: Option<&str>,
    url: &str,
) -> std::result::Result<(), SendError> {
    let fail = |m: String| SendError { permanent: true, message: m };
    let c = json!({"member": {"email": email, "member_name": name}, "unsubscribe_url": url});
    let subject = template::render_subject(subject_src, &c).map_err(|e| fail(e.to_string()))?;
    let mut html = template::render_html(content_src, &c).map_err(|e| fail(e.to_string()))?;
    if !content_src.contains("unsubscribe_url") {
        html.push_str(&format!(
            "<p style=\"margin-top:32px;font-size:12px;color:#6e7781\">You receive this email because you subscribed to our mailing list. \
             <a href=\"{}\">Unsubscribe</a></p>",
            util::html_escape(url)
        ));
    }
    match account {
        Some(acc) => {
            let server = acc.smtp.as_ref().ok_or_else(|| fail(format!("the email account {} has no SMTP host", acc.name)))?;
            let to = email.parse().map_err(|_| fail(format!("{email} is not a valid address")))?;
            let message = mail::build(Outgoing {
                from: mail::from_mailbox(acc).map_err(fail)?,
                to: vec![to],
                cc: vec![],
                bcc: vec![],
                subject,
                text: mail_parser::decoders::html::html_to_text(&html),
                html,
                message_id: format!("{}@{}", Uuid::now_v7().simple(), acc.domain()),
                in_reply_to: None,
                references: vec![],
                attachments: vec![],
                ics: None,
                headers: vec![
                    ("List-Unsubscribe".into(), format!("<{url}>")),
                    ("List-Unsubscribe-Post".into(), "List-Unsubscribe=One-Click".into()),
                    ("Precedence".into(), "bulk".into()),
                ],
            })
            .map_err(fail)?;
            mail::smtp_send(server, &message).await
        }
        None => match &k.mailer {
            Some(m) => m.send(email, &subject, &html).await.map_err(|e| SendError { permanent: false, message: e.to_string() }),
            None => Err(fail("no outgoing email account is set up".into())),
        },
    }
}

/// `GET|POST /unsubscribe?n=&e=&s=` (public): GET asks for confirmation (link scanners only
/// GET), POST — the button, or a mail client's one-click request — unsubscribes.
pub async fn unsubscribe(k: &Kernel, req: &SiteRequest) -> Result<SiteResponse> {
    let tenant = req.tenant;
    let (n, e, sig) = (util::param(req, "n"), util::param(req, "e"), util::param(req, "s"));
    let key = util::signing_key(k, tenant).await?;
    let mut tx = k.db.tenant_tx(tenant).await?;
    let valid = match (n.and_then(|n| n.parse::<Uuid>().ok()), e, sig) {
        (Some(n), Some(e), Some(sig)) if util::verify(&key, &unsubscribe_message(n, e), sig) => Some((n, e.trim().to_lowercase())),
        _ => None,
    };
    let Some((newsletter, email)) = valid else {
        tx.rollback().await?;
        return Ok(util::page(
            403,
            "This link is not valid",
            "<p>The unsubscribe link is incomplete or was changed. Please use the link from the email you received.</p>",
        ));
    };
    let subject: Option<String> =
        sqlx::query_scalar("select subject from e_newsletter where tenant_id = $1 and id = $2").bind(tenant).bind(newsletter).fetch_optional(&mut *tx).await?;
    let list = subject.as_deref().map(|s| format!(" from “{}”", util::html_escape(s))).unwrap_or_default();
    if req.method.eq_ignore_ascii_case("GET") {
        tx.rollback().await?;
        let query = format!("?n={newsletter}&e={}&s={}", util::url_encode(&email), sig.unwrap_or_default());
        return Ok(util::page(
            200,
            "Unsubscribe",
            &format!(
                "<p>Stop sending <strong>{}</strong> these emails{list}?</p><form method=\"post\" action=\"{}\"><button type=\"submit\">Unsubscribe</button></form>",
                util::html_escape(&email),
                util::html_escape(&query)
            ),
        ));
    }
    if !req.method.eq_ignore_ascii_case("POST") {
        return Err(Error::NotFound("page".into()));
    }
    // The newsletter's groups; all groups when the newsletter was deleted since.
    let updated = sqlx::query(sqlx::AssertSqlSafe(format!(
        "update e_email_group_member m set unsubscribed = true, version = m.version + 1, updated_at = now() \
         where m.tenant_id = $1 and lower(m.email) = $2 and not m.unsubscribed and (not exists (select 1 from e_newsletter n where n.tenant_id = $1 and n.id = $3) \
         or m.email_group in (select g.email_group from {GROUPS} g where g.tenant_id = $1 and g.parent_id = $3))"
    )))
    .bind(tenant)
    .bind(&email)
    .bind(newsletter)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    sqlx::query(
        "update comms_newsletter_delivery set unsubscribed_at = coalesce(unsubscribed_at, now()) where tenant_id = $1 and newsletter_id = $2 and email = $3",
    )
    .bind(tenant)
    .bind(newsletter)
    .bind(&email)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::info!(%tenant, %newsletter, lists = updated, "newsletter unsubscribe");
    Ok(util::page(200, "You are unsubscribed", &format!("<p><strong>{}</strong> will not receive these emails any more{list}.</p>", util::html_escape(&email))))
}
