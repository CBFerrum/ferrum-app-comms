//! Mail domain health: what the domain's DNS should say for its mail to arrive and be trusted,
//! and what it says now, in words an operator can act on. The records to publish come from the
//! mail server (the zone file it keeps for the domain, [`hosted::zone_file`]); what is published
//! is asked of the DNS servers this server itself uses, directly (a small client for the few
//! record types mail needs, [`System`]). Reverse DNS and the open port 25 cannot be seen from
//! here, so they are listed as things to check by hand.

use crate::hosted;
use crate::util;
use async_trait::async_trait;
use ferrum_kernel::{Action, Ctx, Error, Kernel, Result};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::time::timeout;

// ───────────────────────────── asking DNS ─────────────────────────────

/// Record types mail needs (RFC 1035 and later), by name.
const TYPES: &[(&str, u16)] = &[("A", 1), ("NS", 2), ("CNAME", 5), ("MX", 15), ("TXT", 16), ("AAAA", 28), ("SRV", 33), ("TLSA", 52), ("CAA", 257)];

fn type_code(kind: &str) -> Option<u16> {
    TYPES.iter().find(|(k, _)| *k == kind).map(|(_, c)| *c)
}

/// A DNS question for `name` and `kind`, with EDNS0 so an answer larger than 512 bytes (a 2048-bit
/// DKIM key) arrives whole over UDP.
fn question(id: u16, name: &str, code: u16) -> Result<Vec<u8>> {
    let mut p = Vec::with_capacity(64);
    p.extend_from_slice(&id.to_be_bytes());
    p.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 1]); // recursion desired; one question, one additional (OPT)
    let name = name.trim_end_matches('.');
    if name.is_empty() || name.len() > 253 {
        return Err(Error::invalid(format!("{name:?} is not a DNS name")));
    }
    for label in name.split('.') {
        if label.is_empty() || label.len() > 63 || !label.is_ascii() {
            return Err(Error::invalid(format!("{name:?} is not a DNS name")));
        }
        p.push(label.len() as u8);
        p.extend_from_slice(label.as_bytes());
    }
    p.push(0);
    p.extend_from_slice(&code.to_be_bytes());
    p.extend_from_slice(&1u16.to_be_bytes()); // class IN
    p.extend_from_slice(&[0, 0, 41, 0x04, 0xD0, 0, 0, 0, 0, 0, 0]); // OPT: root name, type 41, UDP size 1232, no options
    Ok(p)
}

/// A name in a packet, following compression pointers; `pos` moves past it where it started.
fn name_at(packet: &[u8], pos: &mut usize) -> std::result::Result<String, String> {
    let (mut at, mut jumps, mut resume) = (*pos, 0, None);
    let mut labels: Vec<String> = Vec::new();
    loop {
        let len = *packet.get(at).ok_or("a name runs past the end")? as usize;
        if len == 0 {
            at += 1;
            break;
        }
        if len & 0xC0 == 0xC0 {
            let low = *packet.get(at + 1).ok_or("a pointer runs past the end")? as usize;
            resume.get_or_insert(at + 2);
            jumps += 1;
            if jumps > 64 {
                return Err("a name points at itself".into());
            }
            at = ((len & 0x3F) << 8) | low;
            continue;
        }
        let label = packet.get(at + 1..at + 1 + len).ok_or("a label runs past the end")?;
        labels.push(String::from_utf8_lossy(label).into_owned());
        at += 1 + len;
    }
    *pos = resume.unwrap_or(at);
    Ok(labels.join("."))
}

/// What a DNS answer said: cut short (to be asked again over TCP), its code, and the records of
/// the type asked for as text (`10 mail.acme.com`, the joined strings of a TXT).
#[derive(Debug, PartialEq, Eq)]
struct Answer {
    truncated: bool,
    rcode: u8,
    records: Vec<String>,
}

fn answer(packet: &[u8], id: u16, code: u16) -> std::result::Result<Answer, String> {
    if packet.len() < 12 || packet[..2] != id.to_be_bytes() {
        return Err("the answer is not to our question".into());
    }
    let flags = u16::from_be_bytes([packet[2], packet[3]]);
    let (questions, answers) = (u16::from_be_bytes([packet[4], packet[5]]), u16::from_be_bytes([packet[6], packet[7]]));
    let mut pos = 12;
    for _ in 0..questions {
        name_at(packet, &mut pos)?;
        pos += 4;
    }
    let mut records = Vec::new();
    for _ in 0..answers {
        name_at(packet, &mut pos)?;
        let head = packet.get(pos..pos + 10).ok_or("a record runs past the end")?;
        let (kind, len) = (u16::from_be_bytes([head[0], head[1]]), u16::from_be_bytes([head[8], head[9]]) as usize);
        pos += 10;
        let data = packet.get(pos..pos + len).ok_or("a record runs past the end")?;
        let mut at = pos;
        pos += len;
        if kind != code {
            continue;
        }
        let text = match kind {
            1 if len == 4 => IpAddr::from([data[0], data[1], data[2], data[3]]).to_string(),
            28 if len == 16 => IpAddr::from(<[u8; 16]>::try_from(data).map_err(|_| "bad AAAA")?).to_string(),
            2 | 5 => name_at(packet, &mut at)?,
            15 if len > 2 => {
                at += 2;
                format!("{} {}", u16::from_be_bytes([data[0], data[1]]), name_at(packet, &mut at)?)
            }
            16 => {
                let (mut text, mut i) = (String::new(), 0);
                while i < data.len() {
                    let n = data[i] as usize;
                    text.push_str(&String::from_utf8_lossy(data.get(i + 1..i + 1 + n).ok_or("a text runs past the end")?));
                    i += 1 + n;
                }
                text
            }
            33 if len > 6 => {
                at += 6;
                format!(
                    "{} {} {} {}",
                    u16::from_be_bytes([data[0], data[1]]),
                    u16::from_be_bytes([data[2], data[3]]),
                    u16::from_be_bytes([data[4], data[5]]),
                    name_at(packet, &mut at)?
                )
            }
            52 if len > 3 => format!("{} {} {} {}", data[0], data[1], data[2], data[3..].iter().map(|b| format!("{b:02x}")).collect::<String>()),
            257 if len > 2 && data.len() >= 2 + data[1] as usize => {
                let tag = String::from_utf8_lossy(&data[2..2 + data[1] as usize]).into_owned();
                format!("{} {tag} \"{}\"", data[0], String::from_utf8_lossy(&data[2 + data[1] as usize..]))
            }
            _ => continue,
        };
        records.push(text);
    }
    Ok(Answer { truncated: flags & 0x0200 != 0, rcode: (flags & 0x000F) as u8, records })
}

/// Who answers DNS questions.
#[async_trait]
pub(crate) trait Resolve: Send + Sync {
    /// The records of `kind` at `name` (none: there are none); an error when it could not be asked.
    async fn lookup(&self, name: &str, kind: &str) -> std::result::Result<Vec<String>, String>;
}

/// The DNS servers this server is set up to use (`/etc/resolv.conf`).
pub(crate) struct System;

fn nameservers(conf: &str) -> Vec<SocketAddr> {
    conf.lines()
        .filter_map(|l| l.split('#').next()?.trim().strip_prefix("nameserver")?.trim().parse::<IpAddr>().ok())
        .map(|ip| SocketAddr::new(ip, 53))
        .take(3)
        .collect()
}

const ASK: Duration = Duration::from_secs(3);

async fn over_udp(server: SocketAddr, query: &[u8]) -> std::io::Result<Vec<u8>> {
    let socket = UdpSocket::bind(if server.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }).await?;
    socket.connect(server).await?;
    socket.send(query).await?;
    let mut buf = vec![0u8; 4096];
    let n = timeout(ASK, socket.recv(&mut buf)).await.map_err(|_| std::io::ErrorKind::TimedOut)??;
    buf.truncate(n);
    Ok(buf)
}

async fn over_tcp(server: SocketAddr, query: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut conn = timeout(ASK, TcpStream::connect(server)).await.map_err(|_| std::io::ErrorKind::TimedOut)??;
    conn.write_all(&(query.len() as u16).to_be_bytes()).await?;
    conn.write_all(query).await?;
    let mut len = [0u8; 2];
    timeout(ASK, conn.read_exact(&mut len)).await.map_err(|_| std::io::ErrorKind::TimedOut)??;
    let mut buf = vec![0u8; u16::from_be_bytes(len) as usize];
    timeout(ASK, conn.read_exact(&mut buf)).await.map_err(|_| std::io::ErrorKind::TimedOut)??;
    Ok(buf)
}

#[async_trait]
impl Resolve for System {
    async fn lookup(&self, name: &str, kind: &str) -> std::result::Result<Vec<String>, String> {
        let code = type_code(kind).ok_or_else(|| format!("{kind} records are not checked here"))?;
        let servers = nameservers(&std::fs::read_to_string("/etc/resolv.conf").unwrap_or_default());
        if servers.is_empty() {
            return Err("this server has no DNS server set up".into());
        }
        let id = rand::random::<u16>();
        let query = question(id, name, code).map_err(|e| e.to_string())?;
        let mut last = String::from("no DNS server answered");
        for server in servers {
            let mut reply = over_udp(server, &query).await;
            if let Ok(r) = &reply
                && answer(r, id, code).is_ok_and(|a| a.truncated)
            {
                reply = over_tcp(server, &query).await;
            }
            match reply.map_err(|e| e.to_string()).and_then(|r| answer(&r, id, code)) {
                // 0: answered, 3: the name does not exist: both say what is there (nothing, for 3).
                Ok(a) if a.rcode == 0 || a.rcode == 3 => return Ok(a.records),
                Ok(a) => last = format!("{server} answered with error {}", a.rcode),
                Err(e) => last = format!("{server}: {e}"),
            }
        }
        Err(last)
    }
}

// ───────────────────────────── what should be published ─────────────────────────────

/// One record the domain should have.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Want {
    /// Lower case, without the final dot.
    pub name: String,
    pub kind: String,
    pub value: String,
}

/// Splits a zone file line into words; a quoted string is one word (without its quotes), and `;`
/// outside quotes starts a comment.
fn words(line: &str) -> Vec<String> {
    let (mut out, mut cur, mut quoted, mut any) = (Vec::new(), String::new(), false, false);
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                any = true;
            }
            '\\' if quoted => cur.extend(chars.next()),
            ';' if !quoted => break,
            c if c.is_whitespace() && !quoted => {
                if any || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                any = false;
            }
            '(' | ')' if !quoted => {}
            c => {
                cur.push(c);
                any = true;
            }
        }
    }
    if any || !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// The records of a BIND zone file (what the mail server gives for the domain): the kinds mail
/// uses, with names made whole (`@` and relative names are the domain's).
pub(crate) fn parse_zone(text: &str, domain: &str) -> Vec<Want> {
    let mut origin = domain.trim_end_matches('.').to_ascii_lowercase();
    let mut last = origin.clone();
    let mut out = Vec::new();
    for line in text.lines() {
        let w = words(line);
        let Some(first) = w.first() else { continue };
        if let Some(d) = first.strip_prefix('$') {
            if d.eq_ignore_ascii_case("ORIGIN") && w.len() > 1 {
                origin = w[1].trim_end_matches('.').to_ascii_lowercase();
            }
            continue;
        }
        let mut at = 0;
        let name = if line.starts_with(char::is_whitespace) {
            last.clone()
        } else {
            at = 1;
            let n = first.to_ascii_lowercase();
            if n == "@" {
                origin.clone()
            } else if let Some(absolute) = n.strip_suffix('.') {
                absolute.to_string()
            } else {
                format!("{n}.{origin}")
            }
        };
        last = name.clone();
        // A time to live and a class may come before the type, in either order.
        while w.get(at).is_some_and(|x| x.bytes().all(|b| b.is_ascii_digit()) || x.eq_ignore_ascii_case("IN")) {
            at += 1;
        }
        let Some(kind) = w.get(at).map(|k| k.to_ascii_uppercase()).filter(|k| type_code(k).is_some() && k.as_str() != "NS") else { continue };
        let rest = &w[at + 1..];
        let value = if kind == "TXT" { rest.concat() } else { rest.join(" ") };
        if !value.is_empty() {
            out.push(Want { name, kind, value });
        }
    }
    out
}

/// What can be set up without the mail server's own list: where mail goes if the operator named
/// the server, and the sender policy and report address any domain should have.
pub(crate) fn defaults(domain: &str, mail_host: Option<&str>) -> Vec<Want> {
    let want = |name: &str, kind: &str, value: String| Want { name: name.into(), kind: kind.into(), value };
    let mut out = Vec::new();
    if let Some(host) = mail_host {
        out.push(want(domain, "MX", format!("10 {}", host.trim_end_matches('.'))));
    }
    out.push(want(domain, "TXT", "v=spf1 mx ~all".into()));
    out.push(want(&format!("_dmarc.{domain}"), "TXT", format!("v=DMARC1; p=quarantine; rua=mailto:postmaster@{domain}")));
    out
}

// ───────────────────────────── judging what is published ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Ok,
    Missing,
    Differs,
    /// Could not be asked.
    Unknown,
}

impl Status {
    fn word(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Missing => "missing",
            Status::Differs => "differs",
            Status::Unknown => "unknown",
        }
    }
}

/// How a record is judged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rule {
    /// Mail hosts, whatever their priorities.
    Mx,
    /// One sender policy that allows what ours does.
    Spf,
    /// The public key must be ours.
    Dkim,
    /// A record that starts with this is there; its settings are the operator's.
    Prefix(&'static str),
    /// The same value.
    Exact,
}

struct Purpose {
    id: &'static str,
    title: &'static str,
    importance: &'static str,
    why: &'static str,
    rule: Rule,
}

fn purpose(w: &Want, domain: &str) -> Purpose {
    let p = |id, title, importance, why, rule| Purpose { id, title, importance, why, rule };
    match (w.kind.as_str(), w.name.as_str()) {
        ("MX", n) if n == domain => p(
            "mx",
            "Mail for your domain is delivered to your mail server (MX)",
            "required",
            "Without it nobody can send mail to addresses at this domain.",
            Rule::Mx,
        ),
        ("TXT", n) if n == domain && w.value.starts_with("v=spf1") => p(
            "spf",
            "Which servers may send mail as your domain (SPF)",
            "required",
            "Receiving mail systems use it to tell your mail from forgeries. Without it your mail is likely to land in spam.",
            Rule::Spf,
        ),
        ("TXT", n) if n.ends_with(&format!("._domainkey.{domain}")) => p(
            "dkim",
            "Your mail is signed (DKIM)",
            "required",
            "A signature that proves a message came from your domain. Large mail providers distrust mail without one.",
            Rule::Dkim,
        ),
        ("TXT", n) if n == format!("_dmarc.{domain}") => p(
            "dmarc",
            "What receivers do with mail that fails those checks (DMARC)",
            "recommended",
            "Tells receivers to reject or quarantine forged mail, and where to send reports. Providers increasingly expect it.",
            Rule::Prefix("v=DMARC1"),
        ),
        ("TXT", n) if n == format!("_smtp._tls.{domain}") => p(
            "tlsrpt",
            "Reports about mail that could not be delivered securely (TLS-RPT)",
            "optional",
            "Other servers tell you when they could not reach yours over an encrypted connection.",
            Rule::Prefix("v=TLSRPTv1"),
        ),
        ("TXT", n) if n == format!("_mta-sts.{domain}") => p(
            "mtasts",
            "Other servers must use encryption to send you mail (MTA-STS)",
            "optional",
            "Stops mail to you being read or changed on its way by downgrading the connection.",
            Rule::Prefix("v=STSv1"),
        ),
        ("SRV", _) => p(
            "srv",
            "Mail programs find your server on their own (SRV)",
            "optional",
            "Outlook, Apple Mail and phones can fill in the server settings from your address.",
            Rule::Exact,
        ),
        (_, n) if n.starts_with("autoconfig.") || n.starts_with("autodiscover.") || n.starts_with("mta-sts.") => p(
            "autoconfig",
            "Mail programs set themselves up (autoconfig and autodiscover)",
            "optional",
            "Thunderbird, Outlook and others look these names up to configure a new account.",
            Rule::Exact,
        ),
        ("TLSA", _) => p(
            "dane",
            "Other servers can verify your server's certificate (DANE)",
            "optional",
            "Lets servers that support it check your mail server's certificate against DNS.",
            Rule::Exact,
        ),
        ("CAA", _) => p(
            "caa",
            "Only the certificate authorities you name may issue certificates (CAA)",
            "optional",
            "Limits who can issue a certificate for your domain.",
            Rule::Exact,
        ),
        _ => p("other", "Another record the mail server asks for", "optional", "The mail server lists it for this domain.", Rule::Exact),
    }
}

/// A value to compare: names without final dots and in lower case, text without spaces.
fn norm(kind: &str, value: &str) -> String {
    if kind == "TXT" {
        return value.split_whitespace().collect();
    }
    value.split_whitespace().map(|t| t.trim_matches('"').trim_end_matches('.').to_ascii_lowercase()).collect::<Vec<_>>().join(" ")
}

fn tag<'a>(txt: &'a str, name: &str) -> Option<&'a str> {
    txt.split(';').find_map(|p| p.trim().strip_prefix(name)?.strip_prefix('=')).map(str::trim)
}

fn mechanisms(spf: &str) -> BTreeSet<String> {
    spf.split_whitespace().skip(1).filter(|m| !m.trim_start_matches(['+', '-', '~', '?']).eq_ignore_ascii_case("all")).map(|m| m.to_ascii_lowercase()).collect()
}

/// Whether what is published is what is wanted, and a word on why not.
fn judge(w: &Want, rule: Rule, found: &std::result::Result<Vec<String>, String>) -> (Status, Option<String>) {
    let found = match found {
        Ok(f) => f,
        Err(e) => return (Status::Unknown, Some(format!("It could not be looked up: {e}."))),
    };
    let same = |f: &String| norm(&w.kind, f) == norm(&w.kind, &w.value);
    match rule {
        Rule::Mx => {
            let host = |v: &str| v.split_whitespace().last().unwrap_or_default().trim_end_matches('.').to_ascii_lowercase();
            match (found.is_empty(), found.iter().any(|f| host(f) == host(&w.value))) {
                (true, _) => (Status::Missing, None),
                (false, true) => (Status::Ok, None),
                _ => (Status::Differs, Some("Mail for the domain goes to a different server than this one.".into())),
            }
        }
        Rule::Spf => {
            let all: Vec<&String> = found.iter().filter(|f| f.to_ascii_lowercase().starts_with("v=spf1")).collect();
            match all.as_slice() {
                [] => (Status::Missing, None),
                [one] => {
                    let lacking: Vec<String> = mechanisms(&w.value).difference(&mechanisms(one)).cloned().collect();
                    if lacking.is_empty() {
                        (Status::Ok, None)
                    } else {
                        (Status::Differs, Some(format!("It does not allow {}; mail from this server may fail the check.", lacking.join(", "))))
                    }
                }
                _ => (Status::Differs, Some("There is more than one SPF record. Receivers ignore all of them; merge them into one.".into())),
            }
        }
        Rule::Dkim => {
            let key = |v: &str| tag(v, "p").map(|k| k.split_whitespace().collect::<String>());
            let wanted = key(&w.value);
            match (found.iter().filter(|f| f.contains("DKIM1")).count(), found.iter().any(|f| key(f) == wanted && wanted.is_some())) {
                (0, _) => (Status::Missing, None),
                (_, true) => (Status::Ok, None),
                _ => (
                    Status::Differs,
                    Some("A DKIM record is published, but with a different key. Replace it with the one above, or mail will fail the check.".into()),
                ),
            }
        }
        Rule::Prefix(start) => match found.iter().find(|f| f.to_ascii_lowercase().starts_with(&start.to_ascii_lowercase())) {
            Some(f) if start == "v=DMARC1" && tag(f, "p").is_some_and(|p| p.eq_ignore_ascii_case("none")) => {
                (Status::Ok, Some("It only watches (p=none): forged mail is still delivered. Move to quarantine or reject once the reports look right.".into()))
            }
            Some(_) => (Status::Ok, None),
            None if found.is_empty() => (Status::Missing, None),
            None => (Status::Differs, Some("Something else is published here.".into())),
        },
        Rule::Exact => match (found.is_empty(), found.iter().any(same)) {
            (true, _) => (Status::Missing, None),
            (false, true) => (Status::Ok, None),
            _ => (Status::Differs, Some("A different value is published.".into())),
        },
    }
}

/// How to put it right, for the status.
fn fix(w: &Want, status: Status) -> Option<String> {
    match status {
        Status::Ok => None,
        Status::Missing => Some(format!("At your DNS provider, add a {} record named {} with the value shown under “Publish”.", w.kind, w.name)),
        Status::Differs => Some(format!("At your DNS provider, change the {} record named {} to the value shown under “Publish”.", w.kind, w.name)),
        Status::Unknown => Some("Check again in a moment. If it keeps failing, this server cannot reach a DNS server.".into()),
    }
}

/// The report: one check per wanted record, in the order mail needs them.
fn report(domain: &str, wanted: &[Want], found: &HashMap<(String, String), std::result::Result<Vec<String>, String>>) -> Value {
    let mut checks: Vec<(u8, Value, Status)> = wanted
        .iter()
        .map(|w| {
            let pur = purpose(w, domain);
            let got = found.get(&(w.name.clone(), w.kind.clone())).cloned().unwrap_or_else(|| Err("not asked".into()));
            let (status, note) = judge(w, pur.rule, &got);
            let rank = match pur.importance {
                "required" => 0,
                "recommended" => 1,
                _ => 2,
            };
            let value = json!({
                "id": pur.id, "title": pur.title, "importance": pur.importance, "why": pur.why,
                "kind": w.kind, "name": w.name, "expected": w.value,
                "found": got.as_ref().map(|f| f.iter().map(|v| util::cut(v, 400)).collect::<Vec<_>>()).unwrap_or_default(),
                "status": status.word(), "note": note, "fix": fix(w, status),
            });
            (rank, value, status)
        })
        .collect();
    checks.sort_by_key(|(rank, v, _)| (*rank, v["id"].as_str().unwrap_or_default().to_string()));
    let ok = checks.iter().filter(|(_, _, s)| *s == Status::Ok).count();
    let required_wrong = checks.iter().filter(|(r, _, s)| *r == 0 && matches!(s, Status::Missing | Status::Differs)).count();
    json!({
        "checks": checks.into_iter().map(|(_, v, _)| v).collect::<Vec<_>>(),
        "summary": {"ok": ok, "total": wanted.len(), "required_wrong": required_wrong},
    })
}

/// A BIND-style zone of the wanted records, to hand to a DNS provider.
fn zone(domain: &str, wanted: &[Want]) -> String {
    let mut out = format!("; DNS records for {domain}\n$ORIGIN {domain}.\n");
    for w in wanted {
        let value = if w.kind == "TXT" { format!("\"{}\"", w.value.replace('"', "\\\"")) } else { w.value.clone() };
        let name = if w.name == domain { "@".to_string() } else { w.name.strip_suffix(&format!(".{domain}")).unwrap_or(&w.name).to_string() };
        out.push_str(&format!("{name}\t3600\tIN\t{}\t{value}\n", w.kind));
    }
    out
}

/// What a person has to check by hand: not visible in the domain's own DNS records.
fn by_hand(domain: &str) -> Value {
    json!([
        {"id": "ptr", "title": "Reverse DNS of the mail server", "how": format!("Large providers refuse mail from a server whose address does not name it back. Ask your hosting provider to set the reverse DNS (PTR) of the mail server's IP address to its mail host name, the one {domain}'s MX record points at.")},
        {"id": "port25", "title": "Port 25 is open", "how": "Other mail servers deliver to yours on port 25. Many cloud providers block it until asked. From another network, connect to the mail host on port 25 and expect a greeting that starts with 220."},
    ])
}

/// `GET /domain` (Comms managers): the mail domain, how much mail runs on it, and what its DNS
/// says compared with what it should say.
pub(crate) async fn health(k: &Kernel, ctx: &Ctx) -> Result<Value> {
    ctx.require("CommsSettings", Action::Write)?;
    let Some(domain) = hosted::mail_domain(k, ctx.tenant).await? else {
        return Ok(json!({"domain": null, "hosted": hosted::server_url().is_some()}));
    };
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let (mailboxes, synced): (i64, Option<String>) = sqlx::query_as(
        "select count(*) filter (where status = 'Active'), to_char(max(synced_at) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') from e_hosted_mailbox where tenant_id = $1",
    )
    .bind(ctx.tenant)
    .fetch_one(&mut *tx)
    .await?;
    let shared: i64 = sqlx::query_scalar("select count(*) from e_shared_mailbox where tenant_id = $1").bind(ctx.tenant).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    // The records the mail server wants, else the few any domain needs.
    let (source, note, wanted) = match hosted::zone_file(k, &domain).await {
        Ok(Some(text)) => match parse_zone(&text, &domain) {
            w if !w.is_empty() => ("mail server", None, w),
            _ => ("defaults", Some("The mail server gave no records for this domain yet. These are the ones every domain needs; run “Sync Mailboxes” in Communication Settings, then check again.".to_string()), defaults(&domain, None)),
        },
        Ok(None) if hosted::server_url().is_none() => (
            "defaults",
            Some("Hosted mail is not set up on this server (the operator sets FERRUM_MAIL_URL), so it cannot say which records its mail needs. These are the ones every domain needs.".to_string()),
            defaults(&domain, None),
        ),
        Ok(None) => ("defaults", Some("The mail server does not know this domain yet. Run “Sync Mailboxes” in Communication Settings, then check again. These are the records every domain needs.".to_string()), defaults(&domain, None)),
        Err(e) => ("defaults", Some(format!("The mail server did not answer ({e}), so these are only the records every domain needs.")), defaults(&domain, None)),
    };
    let mut wanted = wanted;
    if source == "defaults"
        && let Some(host) = std::env::var("FERRUM_MAIL_HOST").ok().map(|h| h.trim().to_string()).filter(|h| !h.is_empty())
    {
        wanted = defaults(&domain, Some(&host));
    }
    let found = lookups(&System, &wanted).await;
    let mut out = report(&domain, &wanted, &found);
    let o = out.as_object_mut().expect("a report is an object");
    o.insert("domain".into(), json!(domain));
    o.insert("hosted".into(), json!(hosted::server_url().is_some()));
    o.insert("mailboxes".into(), json!(mailboxes));
    o.insert("shared".into(), json!(shared));
    o.insert("synced_at".into(), json!(synced));
    o.insert("source".into(), json!(source));
    o.insert("note".into(), json!(note));
    o.insert("checked_at".into(), json!(util::ts(util::now())));
    o.insert("zone".into(), json!(zone(&domain, &wanted)));
    o.insert("manual".into(), by_hand(&domain));
    Ok(out)
}

/// Asks for every wanted name and kind at once.
async fn lookups(dns: &dyn Resolve, wanted: &[Want]) -> HashMap<(String, String), std::result::Result<Vec<String>, String>> {
    let keys: BTreeSet<(String, String)> = wanted.iter().map(|w| (w.name.clone(), w.kind.clone())).collect();
    let asks = keys.into_iter().map(|(name, kind)| async move {
        let r = dns.lookup(&name, &kind).await;
        ((name, kind), r)
    });
    futures::future::join_all(asks).await.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A DNS answer to a question for `name`: the question, then these records (type, data), their
    /// names pointing back at the question's.
    fn reply(id: u16, flags: u16, name: &str, records: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut p = id.to_be_bytes().to_vec();
        p.extend_from_slice(&flags.to_be_bytes());
        p.extend_from_slice(&[0, 1]);
        p.extend_from_slice(&(records.len() as u16).to_be_bytes());
        p.extend_from_slice(&[0, 0, 0, 0]);
        for l in name.split('.') {
            p.push(l.len() as u8);
            p.extend_from_slice(l.as_bytes());
        }
        p.extend_from_slice(&[0, 0, 1, 0, 1]); // the end of the name, then the type and class asked
        for (kind, data) in records {
            p.extend_from_slice(&[0xC0, 12]);
            p.extend_from_slice(&kind.to_be_bytes());
            p.extend_from_slice(&[0, 1, 0, 0, 0, 60]);
            p.extend_from_slice(&(data.len() as u16).to_be_bytes());
            p.extend_from_slice(data);
        }
        p
    }

    #[test]
    fn a_question_is_built_and_an_answer_read() {
        let q = question(0x1234, "_dmarc.acme.test.", 16).unwrap();
        assert_eq!(&q[..12], &[0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
        assert_eq!(&q[12..19], b"\x06_dmarc");
        assert!(q.ends_with(&[0, 0, 41, 0x04, 0xD0, 0, 0, 0, 0, 0, 0]) && q[12..].windows(4).any(|w| w == [4, b'a', b'c', b'm']));
        assert!(question(1, "bad..name", 1).is_err() && question(1, &"a".repeat(64), 1).is_err() && question(1, "", 1).is_err());

        // A TXT of two strings joins them; an MX points back into the packet for its host.
        let txt = reply(7, 0x8180, "acme.test", &[(16, [&[9u8][..], b"v=spf1 mx", &[4], b" ~al"].concat()), (5, vec![0])]);
        assert_eq!(answer(&txt, 7, 16).unwrap(), Answer { truncated: false, rcode: 0, records: vec!["v=spf1 mx ~al".into()] });
        let mut mx = vec![0, 10, 4];
        mx.extend_from_slice(b"mail");
        mx.extend_from_slice(&[0xC0, 12]);
        let mail = reply(8, 0x8180, "acme.test", &[(15, mx)]);
        assert_eq!(answer(&mail, 8, 15).unwrap().records, vec!["10 mail.acme.test".to_string()]);
        assert_eq!(answer(&reply(9, 0x8183, "acme.test", &[]), 9, 16).unwrap(), Answer { truncated: false, rcode: 3, records: vec![] });
        assert!(answer(&reply(9, 0x8382, "acme.test", &[]), 9, 16).unwrap().truncated);
        assert_eq!(answer(&reply(1, 0x8180, "acme.test", &[(1, vec![192, 0, 2, 1])]), 1, 1).unwrap().records, vec!["192.0.2.1".to_string()]);
        // Not ours, cut short, or a pointer in a circle: an error, not a panic.
        assert!(answer(&txt, 99, 16).is_err() && answer(&txt[..20], 7, 16).is_err() && answer(&[], 7, 16).is_err());
        let mut circle = reply(5, 0x8180, "acme.test", &[(16, vec![0])]);
        circle[12] = 0xC0;
        circle[13] = 12;
        assert!(answer(&circle, 5, 16).is_err());
    }

    #[test]
    fn the_systems_dns_servers_are_read() {
        assert_eq!(
            nameservers("# generated\nsearch lan\nnameserver 10.0.0.2\nnameserver fd00::1 # v6\nnameserver nope\n"),
            vec!["10.0.0.2:53".parse().unwrap(), "[fd00::1]:53".parse().unwrap()]
        );
        assert!(nameservers("search lan\n").is_empty());
    }

    const ZONE: &str = r#"; zone for acme.test
$ORIGIN acme.test.
@ 3600 IN MX 10 mail.acme.test.
acme.test. 3600 IN TXT "v=spf1 mx -all"
rsa-acme.test._domainkey.acme.test. 3600 IN TXT "v=DKIM1; k=rsa; " "p=MIIBIjAN"
_dmarc 3600 IN TXT "v=DMARC1; p=quarantine; rua=mailto:postmaster@acme.test"
_submissions._tcp 3600 IN SRV 0 1 465 mail.acme.test.
autoconfig 3600 IN CNAME mail.acme.test.
acme.test. IN CAA 0 issue "letsencrypt.org"
  IN A 192.0.2.5 ; same name again
@ IN NS ns1.acme.test.
_25._tcp.mail IN TLSA 3 1 1 ABCDEF
"#;

    fn wants() -> Vec<Want> {
        parse_zone(ZONE, "acme.test")
    }

    #[test]
    fn a_zone_file_becomes_the_records_to_publish() {
        let w = wants();
        let line = |i: usize| (w[i].name.as_str(), w[i].kind.as_str(), w[i].value.as_str());
        assert_eq!(line(0), ("acme.test", "MX", "10 mail.acme.test."));
        assert_eq!(line(1), ("acme.test", "TXT", "v=spf1 mx -all"));
        assert_eq!(line(2), ("rsa-acme.test._domainkey.acme.test", "TXT", "v=DKIM1; k=rsa; p=MIIBIjAN"));
        assert_eq!(line(3).0, "_dmarc.acme.test");
        assert_eq!(line(4), ("_submissions._tcp.acme.test", "SRV", "0 1 465 mail.acme.test."));
        assert_eq!(line(5), ("autoconfig.acme.test", "CNAME", "mail.acme.test."));
        assert_eq!(line(6), ("acme.test", "CAA", "0 issue letsencrypt.org"));
        assert_eq!(line(7), ("acme.test", "A", "192.0.2.5"), "a line that starts blank is the name before it");
        assert_eq!(w.len(), 9, "name servers are not ours to check: {w:?}");
        assert_eq!(line(8), ("_25._tcp.mail.acme.test", "TLSA", "3 1 1 ABCDEF"));
        assert!(parse_zone("", "acme.test").is_empty() && parse_zone("; only a comment\n$TTL 300\n", "acme.test").is_empty());
    }

    fn found(list: &[(&str, &str, &[&str])]) -> HashMap<(String, String), std::result::Result<Vec<String>, String>> {
        list.iter().map(|(n, k, v)| ((n.to_string(), k.to_string()), Ok(v.iter().map(|s| s.to_string()).collect()))).collect()
    }

    fn status_of(report: &Value, id: &str) -> (String, Option<String>) {
        let c = report["checks"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap_or_else(|| panic!("no {id} in {report}"));
        (c["status"].as_str().unwrap().to_string(), c["note"].as_str().map(str::to_string))
    }

    #[test]
    fn what_is_published_is_judged_against_what_is_wanted() {
        let w = wants();
        let dns = found(&[
            ("acme.test", "MX", &["20 MAIL.acme.test"]),
            ("acme.test", "TXT", &["v=spf1 ip4:192.0.2.1 -all", "unrelated"]),
            ("rsa-acme.test._domainkey.acme.test", "TXT", &["v=DKIM1;k=rsa;p=OTHERKEY"]),
            ("_dmarc.acme.test", "TXT", &["v=DMARC1; p=none"]),
            ("_submissions._tcp.acme.test", "SRV", &["0 1 465 mail.acme.test"]),
            ("autoconfig.acme.test", "CNAME", &["elsewhere.example"]),
            ("acme.test", "CAA", &[]),
            ("acme.test", "A", &["192.0.2.5"]),
            ("_25._tcp.mail.acme.test", "TLSA", &["3 1 1 abcdef"]),
        ]);
        let r = report("acme.test", &w, &dns);
        assert_eq!(status_of(&r, "mx").0, "ok", "the host is what counts, not its priority or its case");
        let spf = status_of(&r, "spf");
        assert_eq!(spf.0, "differs");
        assert!(spf.1.unwrap().contains("mx"), "it says what is not allowed");
        assert_eq!(status_of(&r, "dkim").0, "differs");
        assert!(status_of(&r, "dmarc").1.unwrap().contains("p=none") && status_of(&r, "dmarc").0 == "ok");
        assert_eq!(status_of(&r, "srv").0, "ok");
        assert_eq!(status_of(&r, "autoconfig").0, "differs");
        assert_eq!(status_of(&r, "caa").0, "missing");
        assert_eq!(status_of(&r, "dane").0, "ok");
        assert_eq!(r["summary"], json!({"ok": 5, "total": 9, "required_wrong": 2}));
        assert_eq!(r["checks"][0]["importance"], "required", "what mail needs comes first");
    }

    #[test]
    fn a_correct_domain_passes_and_a_missing_or_unreachable_one_is_told_apart() {
        let w = wants();
        let dns = found(&[
            ("acme.test", "MX", &["10 mail.acme.test"]),
            ("acme.test", "TXT", &["v=spf1 mx -all"]),
            ("rsa-acme.test._domainkey.acme.test", "TXT", &["v=DKIM1; k=rsa; p=MIIB IjAN"]),
            ("_dmarc.acme.test", "TXT", &[]),
        ]);
        let r = report("acme.test", &w, &dns);
        assert_eq!((status_of(&r, "mx").0.as_str(), status_of(&r, "spf").0.as_str(), status_of(&r, "dkim").0.as_str()), ("ok", "ok", "ok"));
        assert_eq!(status_of(&r, "dmarc").0, "missing");
        assert_eq!(r["summary"]["required_wrong"], 0);
        let mut broken = found(&[]);
        broken.insert(("acme.test".into(), "MX".into()), Err("timed out".into()));
        let r = report("acme.test", &w, &broken);
        let (status, note) = status_of(&r, "mx");
        assert_eq!(status, "unknown");
        assert!(note.unwrap().contains("timed out"));
        assert_eq!(r["summary"]["required_wrong"], 0, "a failure to ask is not a missing record");
        let two = found(&[("acme.test", "TXT", &["v=spf1 mx -all", "v=spf1 a -all"])]);
        assert!(status_of(&report("acme.test", &w, &two), "spf").1.unwrap().contains("more than one"));
    }

    #[test]
    fn the_defaults_and_the_zone_to_hand_over() {
        let d = defaults("acme.test", Some("mail.acme.test."));
        assert_eq!(
            d.iter().map(|w| (w.name.as_str(), w.kind.as_str())).collect::<Vec<_>>(),
            vec![("acme.test", "MX"), ("acme.test", "TXT"), ("_dmarc.acme.test", "TXT")]
        );
        assert_eq!(d[0].value, "10 mail.acme.test");
        assert_eq!(defaults("acme.test", None).len(), 2);
        let z = zone("acme.test", &wants()[..4]);
        assert!(z.contains("$ORIGIN acme.test.\n@\t3600\tIN\tMX\t10 mail.acme.test.\n") && z.contains("_dmarc\t3600\tIN\tTXT\t\"v=DMARC1;"));
        // What the zone says is read back as the same records.
        assert_eq!(parse_zone(&z, "acme.test"), wants()[..4].to_vec());
    }

    #[tokio::test]
    async fn every_name_is_asked_once() {
        struct Fake;
        #[async_trait]
        impl Resolve for Fake {
            async fn lookup(&self, name: &str, kind: &str) -> std::result::Result<Vec<String>, String> {
                if name.starts_with("_dmarc") { Err("down".into()) } else { Ok(vec![format!("{kind} at {name}")]) }
            }
        }
        let got = lookups(&Fake, &wants()).await;
        assert_eq!(got.len(), 9);
        assert_eq!(got[&("acme.test".to_string(), "MX".to_string())], Ok(vec!["MX at acme.test".to_string()]));
        assert!(got[&("_dmarc.acme.test".to_string(), "TXT".to_string())].is_err());
    }
}
