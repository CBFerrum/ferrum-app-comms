//! Link previews in Chat: a card per link (at most three) with what the linked page says of itself (title,
//! description, site), fetched by the server in a job after the message is posted, text only.
//!
//! Every connection goes through the platform's vetted client with private addresses refused
//! (`Kernel::vetted_client(.., false, ..)`): https only, the host resolved once and refused when it is private,
//! loopback or link-local, the connection pinned to the addresses checked, no redirect followed by the client.
//! Redirects are followed here, each hop vetted again from the start. The one exception is `first_hop_here`, set
//! only by tests for a stand-in on this machine, and only for the first request: every later hop is vetted with
//! private addresses refused. A page is read up to 256 KB, a link takes at most four requests and ten seconds, a
//! workspace at most 120 fetches a minute. Nothing from a page is used as markup or as an address.

use crate::util;
use async_trait::async_trait;
use ferrum_kernel::jobs::{Job, JobHandler, NewJob};
use ferrum_kernel::{Kernel, Result, Tx};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const KIND: &str = "comms.link_preview";
/// Links previewed in one message.
const MAX_LINKS: usize = 3;
/// Requests for one link, its redirects included.
const MAX_HOPS: usize = 4;
/// What one link may take, and one request of it.
const LINK_TIME: Duration = Duration::from_secs(10);
const HOP_TIME: Duration = Duration::from_secs(5);
/// What is read of a page.
pub const MAX_PAGE: usize = 256 << 10;
/// Fetches a workspace makes a minute.
const PER_MINUTE: u32 = 120;
const AGENT: &str = "Ferrum Chat link preview";

/// The addresses of a message worth a card: `https://` with a host name (not an address), no name or password,
/// the default port; at most three, each once. `here` (tests) also takes `http://127.0.0.1:port` for a stand-in.
pub fn links(body: &str, here: bool) -> Vec<String> {
    static URL: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#"(?i)\bhttps?://[^\s<>"'()\[\]]+"#).expect("a valid pattern"));
    let mut out: Vec<String> = Vec::new();
    for m in URL.find_iter(body) {
        let url = m.as_str().trim_end_matches(['.', ',', ';', ':', '!', '?']);
        if url.len() <= 2000 && allowed(url, here) && !out.iter().any(|u| u == url) {
            out.push(url.to_string());
            if out.len() == MAX_LINKS {
                break;
            }
        }
    }
    out
}

/// Whether an address may be fetched: the rules of [`links`], applied to every hop.
fn allowed(url: &str, here: bool) -> bool {
    let Some((scheme, host, port, userinfo)) = parts(url) else { return false };
    if userinfo {
        return false;
    }
    if here && scheme == "http" && host == "127.0.0.1" {
        return true;
    }
    let name = !host.starts_with('[') && host.parse::<std::net::IpAddr>().is_err() && host.contains('.');
    scheme == "https" && name && port.is_none_or(|p| p == 443)
}

/// An address's scheme, host (lower case), port and whether it carries a name or password.
fn parts(url: &str) -> Option<(String, String, Option<u16>, bool)> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let userinfo = authority.contains('@');
    let hostport = authority.rsplit('@').next()?;
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) if !h.starts_with('[') || h.ends_with(']') => (h, Some(p.parse::<u16>().ok()?)),
        _ => (hostport, None),
    };
    let ok = !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || "-.[]:".contains(c));
    ok.then(|| (scheme.to_ascii_lowercase(), host.to_ascii_lowercase(), port, userinfo))
}

/// What a card shows.
#[derive(Debug, Clone, PartialEq)]
pub struct Card {
    pub url: String,
    pub title: String,
    pub description: Option<String>,
    pub site: String,
}

impl Card {
    fn json(&self) -> Value {
        json!({"url": self.url, "title": self.title, "description": self.description, "site": self.site})
    }
}

/// The card for `url`, or none: refused, unreachable, too slow, not HTML, no title. Only the first request may go
/// to this machine, and only when `first_hop_here` (tests); every other request is vetted with private addresses
/// refused. Returns the card and how many requests were made.
pub async fn fetch_preview(k: &Kernel, url: &str, first_hop_here: bool) -> (Option<Card>, usize) {
    let started = Instant::now();
    let mut at = url.to_string();
    let mut asked = 0;
    for hop in 0..MAX_HOPS {
        let here = first_hop_here && hop == 0;
        let left = LINK_TIME.saturating_sub(started.elapsed());
        if left.is_zero() || !allowed(&at, here) {
            return (None, asked);
        }
        let Ok((client, parsed)) = k.vetted_client(&at, here, left.min(HOP_TIME), AGENT).await else {
            tracing::debug!(host = %host_of(&at), "link preview refused");
            return (None, asked);
        };
        asked += 1;
        let Ok(Ok(mut res)) = tokio::time::timeout(left.min(HOP_TIME), client.get(parsed.clone()).header("accept", "text/html").send()).await else {
            return (None, asked);
        };
        let status = res.status().as_u16();
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            let Some(next) = res.headers().get("location").and_then(|v| v.to_str().ok()).and_then(|l| parsed.join(l).ok()) else {
                return (None, asked);
            };
            at = next.to_string();
            continue;
        }
        let html = res.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|c| c.trim().to_ascii_lowercase().starts_with("text/html"));
        if !(200..300).contains(&status) || !html {
            return (None, asked);
        }
        let mut page = Vec::new();
        while page.len() < MAX_PAGE {
            let left = LINK_TIME.saturating_sub(started.elapsed());
            match tokio::time::timeout(left, res.chunk()).await {
                Ok(Ok(Some(chunk))) => page.extend_from_slice(&chunk),
                Ok(Ok(None)) => break,
                _ => return (None, asked),
            }
        }
        page.truncate(MAX_PAGE);
        let site = parsed.host_str().unwrap_or_default().to_string();
        return (card_of(url, &String::from_utf8_lossy(&page), &site), asked);
    }
    (None, asked)
}

/// What a page says of itself, from its `<meta>` and `<title>` tags, as text, cut short.
pub fn card_of(url: &str, head: &str, host: &str) -> Option<Card> {
    static META: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?is)<meta\b[^>]*>").expect("a valid pattern"));
    static ATTR: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r#"(?is)\b(property|name|content)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).expect("a valid pattern"));
    static TITLE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?is)<title\b[^>]*>(.*?)</title>").expect("a valid pattern"));
    let mut meta: Vec<(String, String)> = Vec::new();
    for tag in META.find_iter(head) {
        let (mut key, mut content) = (None, None);
        for a in ATTR.captures_iter(tag.as_str()) {
            let v = a.get(2).or_else(|| a.get(3)).map(|m| m.as_str().to_string()).unwrap_or_default();
            if a[1].eq_ignore_ascii_case("content") { content = Some(v) } else { key = Some(v.to_ascii_lowercase()) }
        }
        if let (Some(k), Some(c)) = (key, content) {
            meta.push((k, c));
        }
    }
    let find = |names: &[&str]| names.iter().find_map(|n| meta.iter().find(|(k, _)| k == n).map(|(_, c)| c.clone()));
    let clean = |v: String, max: usize| Some(util::cut(&util::clean_line(&decode(&v), max), max)).filter(|v| !v.is_empty());
    let title = find(&["og:title", "twitter:title"]).or_else(|| TITLE.captures(head).map(|c| c[1].to_string())).and_then(|t| clean(t, 200))?;
    Some(Card {
        url: url.to_string(),
        title,
        description: find(&["og:description", "description", "twitter:description"]).and_then(|d| clean(d, 300)),
        site: find(&["og:site_name"]).and_then(|s| clean(s, 100)).unwrap_or_else(|| util::cut(host, 100)),
    })
}

/// HTML's character references, as text.
fn decode(v: &str) -> String {
    static REF: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|amp|lt|gt|quot|apos|#39|nbsp);").expect("a valid pattern"));
    REF.replace_all(v, |c: &regex::Captures| {
        let r = &c[1];
        match r {
            "amp" => "&".to_string(),
            "lt" => "<".to_string(),
            "gt" => ">".to_string(),
            "quot" => "\"".to_string(),
            "apos" => "'".to_string(),
            "nbsp" => " ".to_string(),
            _ => {
                let n = r.strip_prefix("#x").or_else(|| r.strip_prefix("#X")).map(|h| u32::from_str_radix(h, 16)).unwrap_or_else(|| r[1..].parse());
                n.ok().and_then(char::from_u32).map(String::from).unwrap_or_default()
            }
        }
    })
    .into_owned()
}

/// The host of an address, for logs: never its path or query (they may carry a secret).
fn host_of(url: &str) -> String {
    parts(url).map(|p| p.1).unwrap_or_default()
}

fn digest(body: &str) -> String {
    hex::encode(Sha256::digest(body.as_bytes()))
}

/// Queues the previews of a message whose text is new or changed (in the message's transaction; the job runs after
/// it commits). The job reads the message itself, so it also clears the cards of a text that lost its links.
pub async fn queue(tx: &mut Tx, tenant: Uuid, message: Uuid, body: &str) -> Result<()> {
    let mut job = NewJob::new(KIND, json!({"message": message}));
    job.dedupe_key = Some(format!("comms.preview:{message}:{}", &digest(body)[..16]));
    ferrum_kernel::jobs::enqueue(tx, tenant, None, job).await?;
    Ok(())
}

/// Whether the workspace lets the server fetch links posted in Chat (empty: on).
async fn previews_on(tx: &mut Tx, tenant: Uuid) -> Result<bool> {
    let v: Option<Option<String>> =
        sqlx::query_scalar("select chat_link_previews from e_comms_settings where tenant_id = $1 limit 1").bind(tenant).fetch_optional(&mut **tx).await?;
    Ok(v.flatten().as_deref() != Some("Off"))
}

/// The job: the message's links, fetched; the cards written only onto the text they were made from.
pub struct LinkPreviews {
    /// Tests only: the first request of a link may go to a stand-in on this machine (`http://127.0.0.1`).
    pub stand_in: bool,
}

#[async_trait]
impl JobHandler for LinkPreviews {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn title(&self) -> &'static str {
        "Link previews"
    }

    fn timeout(&self) -> Duration {
        Duration::from_secs(60)
    }

    async fn run(&self, k: &Kernel, job: &Job) -> Result<Value> {
        let tenant = job.tenant_id;
        let Some(message) = job.payload.get("message").and_then(Value::as_str).and_then(|m| m.parse::<Uuid>().ok()) else {
            return Ok(json!({"skipped": "no message"}));
        };
        let mut tx = k.db.tenant_tx(tenant).await?;
        let on = previews_on(&mut tx, tenant).await?;
        let row: Option<(String, bool, Option<Value>)> =
            sqlx::query_as("select coalesce(body, ''), deleted, previews from e_chat_message where tenant_id = $1 and id = $2")
                .bind(tenant)
                .bind(message)
                .fetch_optional(&mut *tx)
                .await?;
        tx.commit().await?;
        let Some((body, deleted, stored)) = row else { return Ok(json!({"skipped": "gone"})) };
        if deleted || !on {
            return Ok(json!({"skipped": if deleted { "deleted" } else { "off" }}));
        }
        let urls = links(&body, self.stand_in);
        let mut cards = Vec::new();
        if !urls.is_empty() {
            if k.rate_limit(&format!("comms.preview|{tenant}"), Duration::from_secs(60), PER_MINUTE, "too many link previews").await.is_err() {
                return Ok(json!({"skipped": "limit"}));
            }
            for url in &urls {
                if let (Some(card), _) = fetch_preview(k, url, self.stand_in).await {
                    cards.push(card.json());
                }
            }
        } else if stored.as_ref().is_none_or(|s| s.as_array().is_none_or(|a| a.is_empty())) {
            return Ok(json!({"cards": 0}));
        }
        let written = write_cards(k, tenant, message, &body, &cards).await?;
        Ok(json!({"cards": if written { cards.len() } else { 0 }}))
    }
}

/// Writes a message's cards, only onto the text they were made from (`body`, as the job read it): an edit or a
/// delete meanwhile leaves them out. Whether they were written; the channel's people are told when they were.
pub async fn write_cards(k: &Kernel, tenant: Uuid, message: Uuid, body: &str, cards: &[Value]) -> Result<bool> {
    let mut tx = k.db.tenant_tx(tenant).await?;
    let channel: Option<Uuid> = sqlx::query_scalar(
        "update e_chat_message set previews = $3 where tenant_id = $1 and id = $2 and not deleted \
         and encode(sha256(convert_to(coalesce(body, ''), 'UTF8')), 'hex') = $4 returning channel",
    )
    .bind(tenant)
    .bind(message)
    .bind(Value::Array(cards.to_vec()))
    .bind(digest(body))
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(channel) = channel {
        crate::chat::push_to_channel(&mut tx, tenant, channel, json!({"event": "preview", "channel": channel, "message": message})).await?;
    }
    tx.commit().await?;
    Ok(channel.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_https_names_on_the_default_port() {
        let body = "see http://plain.example.com, https://10.0.0.1/x https://localhost/a https://u:p@site.example.com/ \
                    https://site.example.com:8443/ https://[::1]/ and https://news.example.com/a?b=1. also (https://docs.example.org/x) \
                    https://news.example.com/a?b=1 https://three.example.net/ https://four.example.net/";
        assert_eq!(links(body, false), ["https://news.example.com/a?b=1", "https://docs.example.org/x", "https://three.example.net/"]);
        assert!(links("http://127.0.0.1:9/x", false).is_empty());
        assert_eq!(links("http://127.0.0.1:9/x", true), ["http://127.0.0.1:9/x"]);
        assert!(links("http://127.0.0.2:9/x https://127.0.0.1/", true).is_empty());
    }

    #[test]
    fn titles_come_from_meta_tags_and_are_cut() {
        let page = r#"<html><head><title>Plain &amp; simple</title>
            <meta property="og:title" content="Q3 &quot;plan&quot; &#8212; final">
            <meta name='description' content="What we ship &lt;b&gt;next&lt;/b&gt;&#x21;">
            <meta property="og:site_name" content="Example News"></head>"#;
        let c = card_of("https://news.example.com/p", page, "news.example.com").unwrap();
        assert_eq!(c.title, "Q3 \"plan\" — final");
        assert_eq!(c.description.as_deref(), Some("What we ship <b>next</b>!"));
        assert_eq!(c.site, "Example News");
        let plain = card_of("https://a.example.com", "<title><script>alert(1)</script> Hi</title>", "a.example.com").unwrap();
        assert_eq!((plain.title.as_str(), plain.site.as_str()), ("<script>alert(1)</script> Hi", "a.example.com"));
        let long = format!("<title>{}</title>", "x".repeat(10 << 20));
        assert_eq!(card_of("https://a.example.com", &long, "a.example.com").unwrap().title.chars().count(), 200);
        assert!(card_of("https://a.example.com", "<p>no title</p>", "a.example.com").is_none());
    }
}
