//! Shared mailboxes and distribution lists on the hosted mail server (`hosted.rs`), kept in step
//! by the same reconcile, in the workspace's mail domain:
//! * a `SharedMailbox` (sales@, support@) is a group account; its members see it as one more
//!   account in their mail;
//! * an `EmailGroup` with a List Address is a mailing list passing mail on to its members who are
//!   not unsubscribed.
//!
//! Group accounts carry `externalId = ferrum:<workspace>:group:<shared mailbox>`; mailing lists
//! have no external id, so their description names their group (`ferrum:<workspace>:list:<id>`).
//! A deleted shared mailbox loses its members and keeps its mail; a list whose address is cleared
//! is removed from the server (it holds no mail).

use crate::hosted::{self, Account, Accounts, Admin, Person};
use crate::util;
use async_trait::async_trait;
use ferrum_kernel::{Ctx, Doc, DocHook, Error, HookCtx, Kernel, Result};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

/// A shared mailbox as Ferrum wants it.
#[derive(Debug)]
struct Shared {
    id: Uuid,
    name: String,
    description: String,
    members: BTreeSet<String>,
}

/// A distribution list as Ferrum wants it.
#[derive(Debug)]
struct Wanted {
    group: Uuid,
    name: String,
    title: String,
    recipients: BTreeSet<String>,
}

/// A mailing list on the server, with the email group it belongs to.
#[derive(Debug)]
struct List {
    id: String,
    group: Uuid,
    name: String,
    recipients: BTreeSet<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum Change {
    CreateGroup(Uuid),
    UpdateGroup(Uuid, String),
    CreateList(Uuid),
    UpdateList(Uuid, String),
    DestroyList(String),
}

/// Group accounts and lists to make, update (including into a new mail domain) or remove.
fn plan(shared: &[Shared], wanted: &[Wanted], domain_id: &str, groups: &BTreeMap<Uuid, Account>, lists: &[List]) -> Vec<Change> {
    let mut out = Vec::new();
    for s in shared {
        match groups.get(&s.id) {
            None => out.push(Change::CreateGroup(s.id)),
            Some(a) if a.name != s.name || a.description != s.description || a.domain != domain_id => out.push(Change::UpdateGroup(s.id, a.id.clone())),
            Some(_) => {}
        }
    }
    for w in wanted {
        match lists.iter().find(|l| l.group == w.group) {
            None => out.push(Change::CreateList(w.group)),
            Some(l) if l.name != w.name || l.recipients != w.recipients => out.push(Change::UpdateList(w.group, l.id.clone())),
            Some(_) => {}
        }
    }
    for l in lists.iter().filter(|l| !wanted.iter().any(|w| w.group == l.group)) {
        out.push(Change::DestroyList(l.id.clone()));
    }
    out
}

/// The groups each person's account should be in, where that differs from what it is in: the
/// shared mailboxes they are a member of, plus any group the workspace does not manage. People
/// without a mailbox in the domain are in none of the workspace's.
fn memberships(people: &[Person], domain: &str, accounts: &Accounts, shared: &[Shared]) -> Vec<(String, BTreeSet<String>)> {
    let ours: BTreeSet<&String> = accounts.groups.values().map(|g| &g.id).collect();
    let mut out = Vec::new();
    for p in people {
        let Some(account) = accounts.people.get(&p.id) else { continue };
        let mut want: BTreeSet<String> = account.groups.iter().filter(|g| !ours.contains(g)).cloned().collect();
        if p.hosted(domain) {
            want.extend(shared.iter().filter(|s| s.members.contains(&p.email)).filter_map(|s| accounts.groups.get(&s.id)).map(|g| g.id.clone()));
        }
        if want != account.groups {
            out.push((account.id.clone(), want));
        }
    }
    out
}

fn marker(tenant: Uuid, group: Uuid) -> String {
    format!("ferrum:{tenant}:list:{group}")
}

fn set(items: &BTreeSet<String>) -> Value {
    Value::Object(items.iter().map(|i| (i.clone(), json!(true))).collect())
}

async fn lists(k: &Kernel, admin: &Admin, tenant: Uuid) -> Result<Vec<List>> {
    let prefix = format!("ferrum:{tenant}:list:");
    let mut out = Vec::new();
    let mut position = 0;
    loop {
        let r = admin
            .jmap(
                k,
                vec![
                    ("x:MailingList/query", json!({"position": position, "limit": 100})),
                    (
                        "x:MailingList/get",
                        json!({"#ids": {"resultOf": "0", "name": "x:MailingList/query", "path": "/ids"}, "properties": ["name", "description", "recipients"]}),
                    ),
                ],
            )
            .await?;
        for l in r[1]["list"].as_array().into_iter().flatten() {
            let group = l["description"].as_str().and_then(|d| d.strip_prefix(&prefix)).and_then(|g| g.parse().ok());
            if let (Some(group), Some(id)) = (group, l["id"].as_str()) {
                let recipients = l["recipients"].as_object().map(|r| r.keys().map(|e| e.to_lowercase()).collect()).unwrap_or_default();
                out.push(List { id: id.to_string(), group, name: l["name"].as_str().unwrap_or_default().to_string(), recipients });
            }
        }
        match r[0]["ids"].as_array().map_or(0, Vec::len) {
            0 => return Ok(out),
            n => position += n,
        }
    }
}

/// Shared mailboxes and distribution lists in step, after the people's accounts: counts in
/// `report` (`shared`, `lists`) and failures in its `failed`.
pub(crate) async fn reconcile(
    k: &Kernel,
    admin: &Admin,
    ctx: &Ctx,
    domain: &str,
    domain_id: &str,
    people: &[Person],
    accounts: &Accounts,
    report: &mut Value,
) -> Result<()> {
    let tenant = ctx.tenant;
    let mut tx = k.db.tenant_tx(tenant).await?;
    let boxes: Vec<(Uuid, String, Option<String>)> =
        sqlx::query_as("select id, lower(address), display_name from e_shared_mailbox where tenant_id = $1").bind(tenant).fetch_all(&mut *tx).await?;
    let members: Vec<(Uuid, String)> =
        sqlx::query_as("select parent_id, lower(email::text) from e_shared_mailbox__members where tenant_id = $1").bind(tenant).fetch_all(&mut *tx).await?;
    let email_groups: Vec<(Uuid, String, String)> =
        sqlx::query_as("select id, lower(mail_address), group_name from e_email_group where tenant_id = $1 and coalesce(mail_address, '') <> ''")
            .bind(tenant)
            .fetch_all(&mut *tx)
            .await?;
    let subscribers: Vec<(Uuid, String)> =
        sqlx::query_as("select email_group, lower(email::text) from e_email_group_member where tenant_id = $1 and not coalesce(unsubscribed, false)")
            .bind(tenant)
            .fetch_all(&mut *tx)
            .await?;
    tx.commit().await?;
    let shared: Vec<Shared> = boxes
        .into_iter()
        .map(|(id, name, display)| Shared {
            id,
            description: display.filter(|d| !d.trim().is_empty()).unwrap_or_else(|| name.clone()),
            name,
            members: members.iter().filter(|(p, _)| *p == id).map(|(_, e)| e.clone()).collect(),
        })
        .collect();
    let wanted: Vec<Wanted> = email_groups
        .into_iter()
        .map(|(group, name, title)| Wanted {
            group,
            name,
            title,
            recipients: subscribers.iter().filter(|(g, _)| *g == group).map(|(_, e)| e.clone()).collect(),
        })
        .collect();
    let on_server = lists(k, admin, tenant).await?;

    let mut fail = |what: &str, step: &str, e: Error| {
        tracing::warn!(%tenant, what, step, "hosted mail not in step: {e}");
        if let Some(f) = report["failed"].as_array_mut() {
            f.push(json!({"email": what, "step": step, "error": e.to_string()}));
        }
    };
    let (mut shared_done, mut lists_done) = (0, 0);
    for change in plan(&shared, &wanted, domain_id, &accounts.groups, &on_server) {
        let outcome = match &change {
            Change::CreateGroup(id) | Change::UpdateGroup(id, _) => {
                let s = shared.iter().find(|s| s.id == *id).expect("planned from these");
                let fields = json!({"name": s.name, "domainId": domain_id, "description": s.description});
                let (address, step) =
                    (format!("{}@{domain}", s.name), if matches!(change, Change::CreateGroup(_)) { "group created" } else { "group updated" });
                let done = async {
                    let account = match &change {
                        Change::UpdateGroup(_, account) => {
                            let r = admin.jmap(k, vec![("x:Account/set", json!({"update": {account: fields}}))]).await?;
                            hosted::updated(&r[0], account)?;
                            account.clone()
                        }
                        _ => {
                            let mut group = fields;
                            group["@type"] = json!("Group");
                            group["externalId"] = json!(format!("ferrum:{tenant}:group:{id}"));
                            let r = admin.jmap(k, vec![("x:Account/set", json!({"create": {"g": group}}))]).await?;
                            hosted::created(&r[0], "g")?
                        }
                    };
                    let row = util::obj(json!({"account_id": account, "synced_at": util::ts(util::now())}));
                    k.update(ctx, "SharedMailbox", *id, row, None).await.map(|_| ())
                }
                .await;
                done.map(|_| true).map_err(|e| (address, step, e))
            }
            Change::CreateList(group) | Change::UpdateList(group, _) => {
                let w = wanted.iter().find(|w| w.group == *group).expect("planned from these");
                let fields = json!({"name": w.name, "domainId": domain_id, "recipients": set(&w.recipients), "description": marker(tenant, w.group)});
                let r = match &change {
                    Change::UpdateList(_, list) => {
                        admin.jmap(k, vec![("x:MailingList/set", json!({"update": {list: fields}}))]).await.and_then(|r| hosted::updated(&r[0], list))
                    }
                    _ => {
                        admin.jmap(k, vec![("x:MailingList/set", json!({"create": {"l": fields}}))]).await.and_then(|r| hosted::created(&r[0], "l").map(|_| ()))
                    }
                };
                r.map(|_| false).map_err(|e| (format!("{}@{domain} ({})", w.name, w.title), "list", e))
            }
            Change::DestroyList(list) => admin
                .jmap(k, vec![("x:MailingList/set", json!({"destroy": [list]}))])
                .await
                .and_then(|r| {
                    if r[0]["destroyed"].as_array().is_some_and(|d| d.contains(&json!(list))) {
                        Ok(())
                    } else {
                        Err(Error::Unavailable(format!("the mail server kept list {list}")))
                    }
                })
                .map(|_| false)
                .map_err(|e| (list.clone(), "list removed", e)),
        };
        match outcome {
            Ok(true) => shared_done += 1,
            Ok(false) => lists_done += 1,
            Err((what, step, e)) => fail(&what, step, e),
        }
    }
    // Memberships, with the group accounts made above.
    let refetched;
    let accounts = if shared_done > 0 {
        refetched = admin.accounts(k, tenant).await?;
        &refetched
    } else {
        accounts
    };
    for (account, groups) in memberships(people, domain, accounts, &shared) {
        let r = admin.jmap(k, vec![("x:Account/set", json!({"update": {&account: {"memberGroupIds": set(&groups)}}}))]).await;
        match r.and_then(|r| hosted::updated(&r[0], &account)) {
            Ok(()) => shared_done += 1,
            Err(e) => fail(&account, "members", e),
        }
    }
    report["shared"] = json!(shared_done);
    report["lists"] = json!(lists_done);
    Ok(())
}

/// The part before @ of an address in the mail domain: lowercase letters, digits, dots, hyphens and
/// underscores, starting and ending with a letter or digit.
fn local_part(value: &str) -> Option<String> {
    let v = value.trim().to_lowercase();
    let v = v.split('@').next().unwrap_or_default().to_string();
    let ok = (1..=64).contains(&v.len())
        && v.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
        && v.as_bytes().first().zip(v.as_bytes().last()).is_some_and(|(a, z)| a.is_ascii_alphanumeric() && z.is_ascii_alphanumeric());
    ok.then_some(v)
}

const ADDRESS: &str = "letters, digits, dots, hyphens and underscores, starting and ending with a letter or digit (the part before @)";

/// Shared mailboxes: a valid address, members who are people of the workspace.
pub struct SharedMailboxHook;

#[async_trait]
impl DocHook for SharedMailboxHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        if let Some(a) = util::s(doc, "address").map(str::to_string) {
            doc.insert("address".into(), json!(local_part(&a).ok_or_else(|| Error::field("address", ADDRESS))?));
        }
        let Some(rows) = doc.get_mut("members").and_then(Value::as_array_mut) else { return Ok(()) };
        let mut emails = Vec::new();
        for row in rows.iter_mut() {
            if let Some(e) = row["email"].as_str().map(|e| e.trim().to_lowercase()) {
                row["email"] = json!(e);
                emails.push(e);
            }
        }
        let known: Vec<String> = sqlx::query_scalar("select lower(email::text) from app_user where tenant_id = $1 and lower(email::text) = any($2)")
            .bind(hc.ctx.tenant)
            .bind(&emails)
            .fetch_all(&mut **hc.tx)
            .await?;
        match emails.iter().find(|e| !known.contains(e)) {
            Some(e) => Err(Error::field("members", format!("{e} is not a person of this workspace"))),
            None => Ok(()),
        }
    }
    async fn after_save(&self, hc: &mut HookCtx<'_>, _doc: &Doc, _old: Option<&Doc>) -> Result<()> {
        hosted::soon(hc.ctx.tenant);
        Ok(())
    }
    async fn before_delete(&self, hc: &mut HookCtx<'_>, _doc: &Doc) -> Result<()> {
        hosted::soon(hc.ctx.tenant);
        Ok(())
    }
}

/// Email groups: a valid list address; changes reach the mail server at the next round.
pub struct EmailGroupHook;

#[async_trait]
impl DocHook for EmailGroupHook {
    async fn before_validate(&self, _hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        if let Some(a) = doc.get("mail_address").and_then(Value::as_str).map(str::to_string) {
            let value = if a.trim().is_empty() { Value::Null } else { json!(local_part(&a).ok_or_else(|| Error::field("mail_address", ADDRESS))?) };
            doc.insert("mail_address".into(), value);
        }
        Ok(())
    }
    async fn after_save(&self, hc: &mut HookCtx<'_>, _doc: &Doc, _old: Option<&Doc>) -> Result<()> {
        hosted::soon(hc.ctx.tenant);
        Ok(())
    }
    async fn before_delete(&self, hc: &mut HookCtx<'_>, _doc: &Doc) -> Result<()> {
        hosted::soon(hc.ctx.tenant);
        Ok(())
    }
}

/// Members joining or leaving a group change its list at the next round.
pub struct GroupMemberHook;

#[async_trait]
impl DocHook for GroupMemberHook {
    async fn after_save(&self, hc: &mut HookCtx<'_>, _doc: &Doc, _old: Option<&Doc>) -> Result<()> {
        hosted::soon(hc.ctx.tenant);
        Ok(())
    }
    async fn before_delete(&self, hc: &mut HookCtx<'_>, _doc: &Doc) -> Result<()> {
        hosted::soon(hc.ctx.tenant);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str, name: &str, groups: &[&str]) -> Account {
        Account { id: id.into(), name: name.into(), description: name.into(), domain: "d".into(), groups: groups.iter().map(|g| g.to_string()).collect() }
    }

    #[test]
    fn shared_mailboxes_and_lists_follow_the_workspace() {
        let (sales, support, gone) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
        let mails = |e: &[&str]| e.iter().map(|e| e.to_string()).collect::<BTreeSet<_>>();
        let shared = [
            Shared { id: sales, name: "sales".into(), description: "sales".into(), members: mails(&["ann@acme.com", "bob@acme.com"]) },
            Shared { id: support, name: "support".into(), description: "Support desk".into(), members: mails(&["bob@acme.com"]) },
        ];
        let person = |email: &str, active: bool| Person { id: Uuid::now_v7(), email: email.into(), full_name: String::new(), active };
        let people = [person("ann@acme.com", true), person("bob@acme.com", true), person("cat@acme.com", true), person("dan@acme.com", false)];
        let mut accounts = Accounts::default();
        accounts.groups.insert(sales, account("g1", "sales", &[]));
        accounts.groups.insert(gone, account("g9", "old", &[]));
        // Ann is in step; Bob misses sales; Cat is in a group the workspace no longer has, and in
        // one it does not manage; Dan left but is still in sales.
        accounts.people.insert(people[0].id, account("a", "ann", &["g1"]));
        accounts.people.insert(people[1].id, account("b", "bob", &[]));
        accounts.people.insert(people[2].id, account("c", "cat", &["g9", "other"]));
        accounts.people.insert(people[3].id, account("d", "dan", &["g1"]));
        let wanted = [
            Wanted { group: Uuid::from_u128(1), name: "all".into(), title: "All".into(), recipients: mails(&["ann@acme.com", "bob@acme.com"]) },
            Wanted { group: Uuid::from_u128(2), name: "new".into(), title: "New".into(), recipients: mails(&["x@y.com"]) },
        ];
        let lists = [
            List { id: "l1".into(), group: Uuid::from_u128(1), name: "all".into(), recipients: mails(&["ann@acme.com"]) },
            List { id: "l3".into(), group: Uuid::from_u128(3), name: "dropped".into(), recipients: mails(&[]) },
        ];
        assert_eq!(
            plan(&shared, &wanted, "d", &accounts.groups, &lists),
            [
                Change::CreateGroup(support),
                Change::UpdateList(Uuid::from_u128(1), "l1".into()),
                Change::CreateList(Uuid::from_u128(2)),
                Change::DestroyList("l3".into())
            ],
            "sales is in step; a list's members changed; one is new and one lost its address"
        );
        // Once support exists, Bob is in both; Cat keeps only the group not ours; Dan in none.
        accounts.groups.insert(support, account("g2", "support", &[]));
        assert_eq!(
            memberships(&people, "acme.com", &accounts, &shared),
            [("b".to_string(), mails(&["g1", "g2"])), ("c".to_string(), mails(&["other"])), ("d".to_string(), mails(&[]))]
        );
        assert_eq!(local_part(" Sales@acme.com "), Some("sales".into()));
        assert_eq!(local_part("all-staff.2026"), Some("all-staff.2026".into()));
        for bad in ["", "-x", "x-", "a b", "ä", &"a".repeat(65)] {
            assert_eq!(local_part(bad), None, "{bad}");
        }
    }
}
