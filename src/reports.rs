//! Reports: email activity per account and day, newsletter performance and chat activity per
//! channel. Each runs in a read-only transaction and sees only the records the caller may read.

use async_trait::async_trait;
use chrono::{Duration, NaiveDate};
use ferrum_domain::reports::{Params, ReportSource, col, read_tx};
use ferrum_kernel::{Action, Ctx, Error, Kernel, Result, row_scope};
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder};
use std::collections::HashMap;
use uuid::Uuid;

pub struct CommsReports;

fn date(name: &str, label: &str) -> Value {
    json!({"name": name, "label": label, "type": "date"})
}

/// The period asked for; the last 30 days by default. `to` is inclusive.
fn period(p: &Params<'_>) -> Result<(NaiveDate, NaiveDate)> {
    let today = chrono::Utc::now().date_naive();
    let to = p.date("to_date")?.unwrap_or(today);
    let from = p.date("from_date")?.unwrap_or(to - Duration::days(29));
    if from > to {
        return Err(Error::field("from_date", "is after the end date"));
    }
    Ok((from, to))
}

/// `part` as a percentage of `whole`, two decimals, in integer arithmetic.
fn pct(part: i64, whole: i64) -> Value {
    if whole == 0 {
        return json!("0.00");
    }
    let basis_points = (part * 10_000 + whole / 2) / whole;
    json!(format!("{}.{:02}", basis_points / 100, basis_points % 100))
}

#[async_trait]
impl ReportSource for CommsReports {
    fn catalog(&self) -> Vec<Value> {
        vec![
            json!({"name": "email_activity", "label": "Email Activity", "module": "communication", "entity": "Communication", "params": [
                date("from_date", "From Date"), date("to_date", "To Date"),
                {"name": "email_account", "label": "Email Account", "type": "link", "to": "EmailAccount"}]}),
            json!({"name": "newsletter_performance", "label": "Newsletter Performance", "module": "communication", "entity": "Newsletter", "params": [
                date("from_date", "Sent From"), date("to_date", "Sent To")]}),
            json!({"name": "chat_activity", "label": "Chat Activity", "module": "communication", "entity": "ChatChannel", "params": [
                date("from_date", "From Date"), date("to_date", "To Date")]}),
        ]
    }

    async fn run(&self, k: &Kernel, ctx: &Ctx, name: &str, params: &HashMap<String, String>) -> Result<Value> {
        let p = Params { raw: params };
        let (from, to) = period(&p)?;
        let (start, end) = (from.and_time(chrono::NaiveTime::MIN).and_utc(), (to + Duration::days(1)).and_time(chrono::NaiveTime::MIN).and_utc());
        let mut tx = read_tx(k, ctx).await?;
        let out = match name {
            "email_activity" => {
                let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(
                    "select coalesce(a.account_name, '(server mailer)'), (c.communication_date at time zone 'UTC')::date, \
                     count(*) filter (where c.direction = 'Sent' and c.status = 'Sent'), count(*) filter (where c.direction = 'Received'), \
                     count(*) filter (where c.status = 'Failed'), count(*) filter (where c.status in ('Queued', 'Sending')) \
                     from e_communication c left join e_email_account a on a.tenant_id = c.tenant_id and a.id = c.email_account \
                     where c.channel = 'Email' and c.tenant_id = ",
                );
                qb.push_bind(ctx.tenant).push(" and c.communication_date >= ").push_bind(start).push(" and c.communication_date < ").push_bind(end);
                if let Some(acc) = p.uuid("email_account")? {
                    qb.push(" and c.email_account = ").push_bind(acc);
                }
                let ent = k.entity(ctx, "Communication")?;
                row_scope(ctx, &ent, Action::Read)?.push_sql(&mut qb, "c");
                qb.push(" group by 1, 2 order by 2 desc, 1");
                let data: Vec<(String, NaiveDate, i64, i64, i64, i64)> = qb.build_query_as().fetch_all(&mut *tx).await?;
                let mut totals = [0i64; 4];
                let rows: Vec<Value> = data
                    .into_iter()
                    .map(|(account, day, sent, received, failed, queued)| {
                        for (t, v) in totals.iter_mut().zip([sent, received, failed, queued]) {
                            *t += v;
                        }
                        json!({"account": account, "day": day.to_string(), "sent": sent, "received": received, "failed": failed, "queued": queued})
                    })
                    .collect();
                json!({
                    "columns": [col("day", "Day", "date"), col("account", "Account", "data"), col("sent", "Sent", "int"), col("received", "Received", "int"),
                                col("failed", "Failed", "int"), col("queued", "Waiting", "int")],
                    "rows": rows,
                    "totals": {"sent": totals[0], "received": totals[1], "failed": totals[2], "queued": totals[3]},
                    "meta": {"from_date": from.to_string(), "to_date": to.to_string()},
                })
            }
            "newsletter_performance" => {
                let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(
                    "select n.subject, n.status, (coalesce(n.started_at, n.schedule_at) at time zone 'UTC')::date, coalesce(n.total_recipients, 0), \
                     count(d.email) filter (where d.status = 'sent'), count(d.email) filter (where d.status = 'failed'), \
                     count(d.email) filter (where d.unsubscribed_at is not null) \
                     from e_newsletter n left join comms_newsletter_delivery d on d.tenant_id = n.tenant_id and d.newsletter_id = n.id \
                     where n.status <> 'Draft' and n.tenant_id = ",
                );
                qb.push_bind(ctx.tenant)
                    .push(" and coalesce(n.started_at, n.schedule_at, n.created_at) >= ")
                    .push_bind(start)
                    .push(" and coalesce(n.started_at, n.schedule_at, n.created_at) < ")
                    .push_bind(end);
                let ent = k.entity(ctx, "Newsletter")?;
                row_scope(ctx, &ent, Action::Read)?.push_sql(&mut qb, "n");
                qb.push(" group by n.tenant_id, n.id order by coalesce(n.started_at, n.schedule_at, n.created_at) desc");
                let data: Vec<(String, String, Option<NaiveDate>, i64, i64, i64, i64)> = qb.build_query_as().fetch_all(&mut *tx).await?;
                let rows: Vec<Value> = data
                    .into_iter()
                    .map(|(subject, status, day, total, sent, failed, unsubscribed)| {
                        json!({"subject": subject, "status": status, "sent_on": day.map(|d| d.to_string()), "recipients": total, "sent": sent,
                               "failed": failed, "unsubscribed": unsubscribed, "unsubscribe_rate": pct(unsubscribed, sent), "delivery_rate": pct(sent, sent + failed)})
                    })
                    .collect();
                json!({
                    "columns": [col("subject", "Newsletter", "data"), col("status", "Status", "data"), col("sent_on", "Sent On", "date"),
                                col("recipients", "Recipients", "int"), col("sent", "Sent", "int"), col("failed", "Failed", "int"),
                                col("delivery_rate", "Delivered %", "percent"), col("unsubscribed", "Unsubscribed", "int"), col("unsubscribe_rate", "Unsubscribe %", "percent")],
                    "rows": rows,
                    "meta": {"from_date": from.to_string(), "to_date": to.to_string()},
                })
            }
            "chat_activity" => {
                let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(
                    "select c.id, c.channel_name, c.channel_type, \
                     (select string_agg(m.member::text, ', ' order by m.idx) from e_chat_channel__members m where m.tenant_id = c.tenant_id and m.parent_id = c.id), \
                     (select count(*) from e_chat_channel__members m where m.tenant_id = c.tenant_id and m.parent_id = c.id), \
                     count(x.id) filter (where not x.deleted), count(distinct x.sender), max(x.posted_at) \
                     from e_chat_channel c left join e_chat_message x on x.tenant_id = c.tenant_id and x.channel = c.id and x.posted_at >= ",
                );
                qb.push_bind(start).push(" and x.posted_at < ").push_bind(end).push(" where c.tenant_id = ").push_bind(ctx.tenant);
                let ent = k.entity(ctx, "ChatChannel")?;
                row_scope(ctx, &ent, Action::Read)?.push_sql(&mut qb, "c");
                qb.push(" group by c.tenant_id, c.id order by 6 desc, c.channel_name");
                let data: Vec<(Uuid, String, String, Option<String>, i64, i64, i64, Option<chrono::DateTime<chrono::Utc>>)> =
                    qb.build_query_as().fetch_all(&mut *tx).await?;
                let mut total = 0;
                let rows: Vec<Value> = data
                    .into_iter()
                    .map(|(id, name, kind, members, member_count, messages, senders, last)| {
                        total += messages;
                        let label = if kind == "Direct" { format!("Direct: {}", members.unwrap_or_default()) } else { format!("#{name}") };
                        json!({"channel": label, "channel_id": id, "type": kind, "members": member_count, "messages": messages, "active_members": senders,
                               "last_message_at": last.map(crate::util::ts)})
                    })
                    .collect();
                json!({
                    "columns": [col("channel", "Channel", "data"), col("type", "Type", "data"), col("members", "Members", "int"), col("messages", "Messages", "int"),
                                col("active_members", "Active Members", "int"), col("last_message_at", "Last Message", "datetime")],
                    "rows": rows,
                    "totals": {"messages": total},
                    "meta": {"from_date": from.to_string(), "to_date": to.to_string()},
                })
            }
            _ => return Err(Error::NotFound(format!("report {name}"))),
        };
        tx.rollback().await?;
        Ok(out)
    }
}
