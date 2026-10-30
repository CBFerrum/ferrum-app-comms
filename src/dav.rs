//! Calendar and contacts apps: CalDAV (RFC 4791) and CardDAV (RFC 6352) over WebDAV (RFC 4918);
//! Ferrum docs/plan/collaboration.md, C5. The platform signs the app in at `/api/dav/comms/…` (the
//! person's email and an app password, over HTTP Basic) and hands the request here as that person.
//!
//! | Path under `/api/dav/comms` | What |
//! |---|---|
//! | `/` | the root: who is signed in |
//! | `/u/{user}/` | the person (principal) |
//! | `/u/{user}/calendars/default/` | their calendar: events they organize, or are invited to and have not declined |
//! | `/u/{user}/addressbooks/colleagues/` | the workspace's people, read-only |
//! | `/u/{user}/addressbooks/contacts/` | CRM contacts they may read, read-only (where CRM is installed) |
//!
//! Apps sync by collection tags (`getctag`) and ETags; both are hashes of what GET returns.

use crate::calendar;
use crate::ics::{self, ParsedEvent};
use crate::util::{self, s};
use ferrum_kernel::{Access, Action, Ctx, Doc, Error, Filter, Kernel, ListQuery, Op, Result, SiteRequest, SiteResponse, Tx};
use quick_xml::events::Event;
use quick_xml::name::ResolveResult;
use quick_xml::{NsReader, XmlVersion};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;

const BASE: &str = "/api/dav/comms";
const D: &str = "DAV:";
const C: &str = "urn:ietf:params:xml:ns:caldav";
const CR: &str = "urn:ietf:params:xml:ns:carddav";
const CS: &str = "http://calendarserver.org/ns/";
const A: &str = "http://apple.com/ns/ical/";
/// How far back the calendar reaches; repeating events are always in it.
const DAYS_BACK: i64 = 400;
/// The most events and contacts a collection lists.
const MAX_ITEMS: usize = 20_000;
/// The largest event an app may send.
const MAX_EVENT: usize = 1 << 20;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Book {
    Colleagues,
    Contacts,
}

impl Book {
    fn slug(self) -> &'static str {
        match self {
            Book::Colleagues => "colleagues",
            Book::Contacts => "contacts",
        }
    }
    fn title(self) -> &'static str {
        match self {
            Book::Colleagues => "Colleagues",
            Book::Contacts => "Contacts",
        }
    }
}

#[derive(Debug)]
enum Res {
    Root,
    Principal,
    CalendarHome,
    Calendar,
    Event(String),
    BookHome,
    Book(Book),
    Card(Book, String),
}

/// `/api/dav/comms/…`
pub async fn handle(k: &Kernel, ctx: &Ctx, req: &SiteRequest, path: &[&str]) -> Result<SiteResponse> {
    let res = resource(ctx, path)?;
    if let Res::Book(Book::Contacts) | Res::Card(Book::Contacts, _) = res
        && !crm(ctx)
    {
        return Err(Error::NotFound("address book".into()));
    }
    match req.method.as_str() {
        "OPTIONS" => Ok(options()),
        "PROPFIND" => propfind(k, ctx, req, &res).await,
        "REPORT" => report(k, ctx, req, &res).await,
        "GET" | "HEAD" => get(k, ctx, &res, req.method == "HEAD").await,
        "PUT" => put(k, ctx, req, &res).await,
        "DELETE" => delete(k, ctx, req, &res).await,
        "PROPPATCH" => proppatch(ctx, req, &res),
        _ => {
            let mut r = SiteResponse::text(405, "text/plain; charset=utf-8", "calendar and contacts apps cannot do that here");
            r.headers.push(("allow".into(), ALLOW.into()));
            Ok(r)
        }
    }
}

const ALLOW: &str = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT";

fn options() -> SiteResponse {
    let mut r = SiteResponse::text(200, "text/plain; charset=utf-8", "");
    r.headers.push(("dav".into(), "1, 3, calendar-access, addressbook".into()));
    r.headers.push(("allow".into(), ALLOW.into()));
    r
}

/// Where CRM's contacts can be read.
fn crm(ctx: &Ctx) -> bool {
    ctx.schema.entity("Contact").is_some() && ctx.perms.access("Contact", Action::Read) != Access::None
}

// ───────────────────────────── addresses ─────────────────────────────

fn resource(ctx: &Ctx, path: &[&str]) -> Result<Res> {
    let none = || Error::NotFound("calendar or address book".into());
    let book = |b: &str| match b {
        "colleagues" => Ok(Book::Colleagues),
        "contacts" => Ok(Book::Contacts),
        _ => Err(none()),
    };
    let me = ctx.user.to_string();
    Ok(match path {
        [] => Res::Root,
        ["u", u, rest @ ..] if *u == me => match rest {
            [] => Res::Principal,
            ["calendars"] => Res::CalendarHome,
            ["calendars", "default"] => Res::Calendar,
            ["calendars", "default", n] => Res::Event(n.to_string()),
            ["addressbooks"] => Res::BookHome,
            ["addressbooks", b] => Res::Book(book(b)?),
            ["addressbooks", b, n] => Res::Card(book(b)?, n.to_string()),
            _ => return Err(none()),
        },
        _ => return Err(none()),
    })
}

fn principal(ctx: &Ctx) -> String {
    format!("{BASE}/u/{}/", ctx.user)
}

fn href(ctx: &Ctx, r: &Res) -> String {
    let p = principal(ctx);
    match r {
        Res::Root => format!("{BASE}/"),
        Res::Principal => p,
        Res::CalendarHome => format!("{p}calendars/"),
        Res::Calendar => format!("{p}calendars/default/"),
        Res::Event(n) => format!("{p}calendars/default/{}", enc(n)),
        Res::BookHome => format!("{p}addressbooks/"),
        Res::Book(b) => format!("{p}addressbooks/{}/", b.slug()),
        Res::Card(b, n) => format!("{p}addressbooks/{}/{}", b.slug(), enc(n)),
    }
}

/// A resource name as a path segment.
fn enc(name: &str) -> String {
    name.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~@+".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn dec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%'
            && let (Some(h), Some(l)) = (b.get(i + 1).copied().and_then(hex), b.get(i + 2).copied().and_then(hex))
        {
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The resource names an app's hrefs point at inside `collection` (full URLs or paths).
fn names_in(hrefs: &[String], collection: &str) -> Vec<(String, Option<String>)> {
    hrefs
        .iter()
        .map(|h| {
            let path = h.find("/api/dav/").map_or(h.as_str(), |i| &h[i..]);
            let name = dec(path).strip_prefix(collection).filter(|n| !n.is_empty() && !n.contains('/')).map(str::to_string);
            (h.clone(), name)
        })
        .collect()
}

// ───────────────────────────── XML in ─────────────────────────────

/// An element of a request body, in document order.
struct El {
    depth: usize,
    ns: String,
    name: String,
    text: String,
    attrs: Vec<(String, String)>,
}

impl El {
    fn is(&self, ns: &str, name: &str) -> bool {
        self.ns == ns && self.name == name
    }
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

fn elements(body: &[u8]) -> Result<Vec<El>> {
    let bad = |e: &dyn std::fmt::Display| Error::invalid(format!("the request is not well-formed XML: {e}"));
    let text = std::str::from_utf8(body).map_err(|e| bad(&e))?;
    let mut reader = NsReader::from_str(text);
    let (mut out, mut open): (Vec<El>, Vec<usize>) = (Vec::new(), Vec::new());
    loop {
        let (ns, event) = reader.read_resolved_event().map_err(|e| bad(&e))?;
        let ns = match ns {
            ResolveResult::Bound(n) => n.as_ref().to_string(),
            _ => String::new(),
        };
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let attrs = e
                    .attributes()
                    .flatten()
                    .map(|a| (a.key.local_name().as_ref().to_string(), a.normalized_value(XmlVersion::Implicit1_0).map(|v| v.into_owned()).unwrap_or_default()))
                    .collect();
                out.push(El { depth: open.len(), ns, name: e.local_name().as_ref().to_string(), text: String::new(), attrs });
                if matches!(event, Event::Start(_)) {
                    open.push(out.len() - 1);
                }
            }
            Event::End(_) => {
                open.pop();
            }
            Event::Text(t) => {
                if let Some(&i) = open.last() {
                    out[i].text.push_str(&t.xml_content(XmlVersion::Implicit1_0));
                }
            }
            Event::CData(t) => {
                if let Some(&i) = open.last() {
                    out[i].text.push_str(&t.xml_content(XmlVersion::Implicit1_0));
                }
            }
            Event::GeneralRef(r) => {
                if let Some(&i) = open.last() {
                    match r.resolve_char_ref() {
                        Ok(Some(c)) => out[i].text.push(c),
                        _ => out[i].text.push_str(quick_xml::escape::resolve_predefined_entity(&r).unwrap_or_default()),
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(out)
}

type Prop = (String, String);

/// The properties a PROPFIND or REPORT asks for; `None` for all of them (allprop, or no body).
fn wanted(els: &[El]) -> Option<Vec<Prop>> {
    let i = els.iter().position(|e| e.depth == 1 && e.is(D, "prop"))?;
    Some(els[i + 1..].iter().take_while(|e| e.depth > 1).filter(|e| e.depth == 2).map(|e| (e.ns.clone(), e.name.clone())).collect())
}

// ───────────────────────────── XML out ─────────────────────────────

fn x(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// `<P:name>inner</P:name>` for a property.
fn element((ns, name): &Prop, inner: &str) -> String {
    let prefix = match ns.as_str() {
        D => "D:",
        C => "C:",
        CR => "CR:",
        CS => "CS:",
        A => "A:",
        _ => "",
    };
    let decl = if prefix.is_empty() { format!(" xmlns=\"{}\"", x(ns)) } else { String::new() };
    if inner.is_empty() { format!("<{prefix}{name}{decl}/>") } else { format!("<{prefix}{name}{decl}>{inner}</{prefix}{name}>") }
}

const NAMESPACES: &str = r#"xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CR="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/""#;

fn xml(status: u16, body: String) -> SiteResponse {
    SiteResponse::text(status, "application/xml; charset=utf-8", format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>{body}"))
}

/// A 207 Multi-Status body.
struct Multi(String);

impl Multi {
    fn new() -> Self {
        Multi(format!("<D:multistatus {NAMESPACES}>"))
    }

    /// A resource with the asked-for properties: those it has, then those it has not.
    fn add(&mut self, href: &str, props: Vec<(Prop, Option<String>)>) {
        let (found, missing): (Vec<_>, Vec<_>) = props.into_iter().partition(|(_, v)| v.is_some());
        self.0 += &format!("<D:response><D:href>{}</D:href>", x(href));
        if !found.is_empty() || missing.is_empty() {
            let inner: String = found.iter().map(|(p, v)| element(p, v.as_deref().unwrap_or_default())).collect();
            self.0 += &format!("<D:propstat><D:prop>{inner}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>");
        }
        if !missing.is_empty() {
            let inner: String = missing.iter().map(|(p, _)| element(p, "")).collect();
            self.0 += &format!("<D:propstat><D:prop>{inner}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>");
        }
        self.0 += "</D:response>";
    }

    fn missing(&mut self, href: &str) {
        self.0 += &format!("<D:response><D:href>{}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>", x(href));
    }

    fn done(self) -> SiteResponse {
        xml(207, format!("{}</D:multistatus>", self.0))
    }
}

/// A refusal with a WebDAV precondition (`<D:error>`), e.g. 403 `C:valid-calendar-object-resource`.
fn refuse(status: u16, condition: &str, message: &str) -> SiteResponse {
    xml(status, format!("<D:error {NAMESPACES}><{condition}/><D:responsedescription>{}</D:responsedescription></D:error>", x(message)))
}

// ───────────────────────────── properties ─────────────────────────────

/// A calendar object or a card: its name, its text (iCalendar or vCard) and its ETag.
struct Item {
    name: String,
    data: String,
    etag: String,
}

impl Item {
    fn new(name: String, data: String) -> Item {
        let etag = format!("\"{}\"", &hex::encode(Sha256::digest(data.as_bytes()))[..24]);
        Item { name, data, etag }
    }
}

/// A collection's tag: changes whenever any of its items is added, changed or removed.
fn ctag(items: &[Item]) -> String {
    let mut h = Sha256::new();
    for i in items {
        h.update(i.name.as_bytes());
        h.update(i.etag.as_bytes());
    }
    format!("\"{}\"", &hex::encode(h.finalize())[..24])
}

/// The properties `allprop` returns.
fn all_props(r: &Res) -> Vec<Prop> {
    let p = |ns: &str, n: &str| (ns.to_string(), n.to_string());
    let mut out = vec![p(D, "resourcetype"), p(D, "displayname"), p(D, "current-user-principal")];
    match r {
        Res::Event(_) | Res::Card(..) => out.extend([p(D, "getetag"), p(D, "getcontenttype")]),
        Res::Calendar => out.extend([p(CS, "getctag"), p(C, "supported-calendar-component-set"), p(D, "current-user-privilege-set")]),
        Res::Book(_) => out.extend([p(CS, "getctag"), p(D, "current-user-privilege-set")]),
        Res::Root | Res::Principal => out.extend([p(C, "calendar-home-set"), p(CR, "addressbook-home-set")]),
        Res::CalendarHome | Res::BookHome => {}
    }
    out
}

fn privileges(names: &[&str]) -> String {
    names.iter().map(|n| format!("<D:privilege><D:{n}/></D:privilege>")).collect()
}

/// One property of a resource; `tag` is its collection tag, `item` its object.
fn prop(ctx: &Ctx, r: &Res, (ns, name): &Prop, tag: Option<&str>, item: Option<&Item>) -> Option<String> {
    let href_of = |r: &Res| format!("<D:href>{}</D:href>", x(&href(ctx, r)));
    let is_book = matches!(r, Res::Book(_));
    Some(match (ns.as_str(), name.as_str()) {
        (D, "resourcetype") => match r {
            Res::Principal => "<D:collection/><D:principal/>".into(),
            Res::Calendar => "<D:collection/><C:calendar/>".into(),
            Res::Book(_) => "<D:collection/><CR:addressbook/>".into(),
            Res::Event(_) | Res::Card(..) => String::new(),
            _ => "<D:collection/>".into(),
        },
        (D, "displayname") => x(&match r {
            Res::Root => "Ferrum".to_string(),
            Res::Principal => {
                if ctx.full_name.trim().is_empty() {
                    ctx.email.clone()
                } else {
                    ctx.full_name.clone()
                }
            }
            Res::CalendarHome => "Calendars".into(),
            Res::Calendar => "Calendar".into(),
            Res::BookHome => "Address books".into(),
            Res::Book(b) => b.title().into(),
            Res::Event(n) | Res::Card(_, n) => n.clone(),
        }),
        (D, "current-user-principal") => href_of(&Res::Principal),
        (D, "principal-URL") | (D, "owner") if !matches!(r, Res::Root) => href_of(&Res::Principal),
        (C, "calendar-home-set") if matches!(r, Res::Root | Res::Principal) => href_of(&Res::CalendarHome),
        (CR, "addressbook-home-set") if matches!(r, Res::Root | Res::Principal) => href_of(&Res::BookHome),
        (C, "calendar-user-address-set") if matches!(r, Res::Root | Res::Principal) => {
            format!("<D:href>mailto:{}</D:href>{}", x(&ctx.email.to_lowercase()), href_of(&Res::Principal))
        }
        (D, "current-user-privilege-set") => match r {
            Res::Calendar | Res::Event(_) => privileges(&["read", "write", "write-content", "bind", "unbind", "read-current-user-privilege-set"]),
            _ => privileges(&["read", "read-current-user-privilege-set"]),
        },
        (D, "supported-report-set") if matches!(r, Res::Calendar) => "<D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report>\
             <D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report>"
            .into(),
        (D, "supported-report-set") if is_book => "<D:supported-report><D:report><CR:addressbook-multiget/></D:report></D:supported-report>\
             <D:supported-report><D:report><CR:addressbook-query/></D:report></D:supported-report>"
            .into(),
        (C, "supported-calendar-component-set") if matches!(r, Res::Calendar) => "<C:comp name=\"VEVENT\"/>".into(),
        (C, "supported-calendar-data") if matches!(r, Res::Calendar) => "<C:calendar-data content-type=\"text/calendar\" version=\"2.0\"/>".into(),
        (CR, "supported-address-data") if is_book => "<CR:address-data-type content-type=\"text/vcard\" version=\"3.0\"/>".into(),
        (C, "max-resource-size") if matches!(r, Res::Calendar) => MAX_EVENT.to_string(),
        (C, "calendar-description") if matches!(r, Res::Calendar) => "Events you organize or are invited to in Ferrum".into(),
        (CR, "addressbook-description") => match r {
            Res::Book(Book::Colleagues) => "The people of your workspace".into(),
            Res::Book(Book::Contacts) => "Contacts from CRM that you may see".into(),
            _ => return None,
        },
        (A, "calendar-color") if matches!(r, Res::Calendar) => "#2563EBFF".into(),
        (CS, "getctag") => x(tag?),
        (D, "getetag") => x(&item?.etag),
        (D, "getcontenttype") => match r {
            Res::Event(_) => "text/calendar; charset=utf-8; component=VEVENT".into(),
            Res::Card(..) => "text/vcard; charset=utf-8".into(),
            _ => return None,
        },
        (C, "calendar-data") if matches!(r, Res::Event(_)) => x(&item?.data),
        (CR, "address-data") if matches!(r, Res::Card(..)) => x(&item?.data),
        _ => return None,
    })
}

fn props(ctx: &Ctx, r: &Res, wanted: &[Prop], tag: Option<&str>, item: Option<&Item>) -> Vec<(Prop, Option<String>)> {
    wanted.iter().map(|p| (p.clone(), prop(ctx, r, p, tag, item))).collect()
}

/// Whether any of `wanted` is one of these (namespace, name) pairs.
fn asks(wanted: &[Prop], names: &[(&str, &str)]) -> bool {
    wanted.iter().any(|(ns, n)| names.iter().any(|(a, b)| a == ns && b == n))
}

// ───────────────────────────── PROPFIND, PROPPATCH ─────────────────────────────

async fn propfind(k: &Kernel, ctx: &Ctx, req: &SiteRequest, r: &Res) -> Result<SiteResponse> {
    let els = if req.body.iter().all(u8::is_ascii_whitespace) { vec![] } else { elements(&req.body)? };
    let wanted = wanted(&els).unwrap_or_else(|| all_props(r));
    // Depth infinity is taken as 1: nothing here is deeper.
    let children = util::header(req, "depth").map(str::trim) != Some("0");
    let tagged = asks(&wanted, &[(CS, "getctag")]);
    let mut m = Multi::new();
    match r {
        Res::Calendar | Res::Book(_) => {
            let items = items(k, ctx, r, None).await?;
            m.add(&href(ctx, r), props(ctx, r, &wanted, Some(&ctag(&items)), None));
            if children {
                for i in &items {
                    let child = child(r, &i.name);
                    m.add(&href(ctx, &child), props(ctx, &child, &wanted, None, Some(i)));
                }
            }
        }
        Res::Event(n) | Res::Card(_, n) => {
            let collection = parent(r);
            let item = items(k, ctx, &collection, Some(std::slice::from_ref(n))).await?.into_iter().next().ok_or_else(|| Error::NotFound("item".into()))?;
            m.add(&href(ctx, r), props(ctx, r, &wanted, None, Some(&item)));
        }
        Res::CalendarHome | Res::BookHome => {
            m.add(&href(ctx, r), props(ctx, r, &wanted, None, None));
            if children {
                let collections = match r {
                    Res::CalendarHome => vec![Res::Calendar],
                    _ if crm(ctx) => vec![Res::Book(Book::Colleagues), Res::Book(Book::Contacts)],
                    _ => vec![Res::Book(Book::Colleagues)],
                };
                for c in collections {
                    let tag = if tagged { Some(ctag(&items(k, ctx, &c, None).await?)) } else { None };
                    m.add(&href(ctx, &c), props(ctx, &c, &wanted, tag.as_deref(), None));
                }
            }
        }
        Res::Root | Res::Principal => m.add(&href(ctx, r), props(ctx, r, &wanted, None, None)),
    }
    Ok(m.done())
}

fn child(r: &Res, name: &str) -> Res {
    match r {
        Res::Book(b) => Res::Card(*b, name.to_string()),
        _ => Res::Event(name.to_string()),
    }
}

fn parent(r: &Res) -> Res {
    match r {
        Res::Card(b, _) => Res::Book(*b),
        _ => Res::Calendar,
    }
}

/// Apps may set a calendar's colour or order; nothing here keeps them, so each is refused.
fn proppatch(ctx: &Ctx, req: &SiteRequest, r: &Res) -> Result<SiteResponse> {
    let els = elements(&req.body)?;
    let asked: Vec<Prop> = els
        .iter()
        .enumerate()
        .filter(|(i, e)| e.depth >= 3 && els[..*i].iter().rev().find(|p| p.depth == e.depth - 1).is_some_and(|p| p.is(D, "prop")))
        .map(|(_, e)| (e.ns.clone(), e.name.clone()))
        .collect();
    let mut m = Multi::new();
    let inner: String = asked.iter().map(|p| element(p, "")).collect();
    m.0 += &format!(
        "<D:response><D:href>{}</D:href><D:propstat><D:prop>{inner}</D:prop><D:status>HTTP/1.1 403 Forbidden</D:status></D:propstat></D:response>",
        x(&href(ctx, r))
    );
    Ok(m.done())
}

// ───────────────────────────── REPORT ─────────────────────────────

async fn report(k: &Kernel, ctx: &Ctx, req: &SiteRequest, r: &Res) -> Result<SiteResponse> {
    let els = elements(&req.body)?;
    let Some(root) = els.first() else { return Err(Error::invalid("an empty REPORT")) };
    let wanted = wanted(&els).unwrap_or_else(|| all_props(&child(r, "")));
    let calendar = matches!(r, Res::Calendar);
    let book = matches!(r, Res::Book(_));
    let mut m = Multi::new();
    if (calendar && root.is(C, "calendar-multiget")) || (book && root.is(CR, "addressbook-multiget")) {
        let hrefs: Vec<String> = els.iter().filter(|e| e.is(D, "href")).map(|e| e.text.trim().to_string()).collect();
        let named = names_in(&hrefs, &href(ctx, r));
        let names: Vec<String> = named.iter().filter_map(|(_, n)| n.clone()).collect();
        let found: HashMap<String, Item> = items(k, ctx, r, Some(&names)).await?.into_iter().map(|i| (i.name.clone(), i)).collect();
        for (h, name) in named {
            match name.as_ref().and_then(|n| found.get(n)) {
                Some(i) => {
                    let c = child(r, &i.name);
                    m.add(&href(ctx, &c), props(ctx, &c, &wanted, None, Some(i)));
                }
                None => m.missing(&h),
            }
        }
    } else if (calendar && root.is(C, "calendar-query")) || (book && root.is(CR, "addressbook-query")) {
        let found = match r {
            Res::Book(b) => cards(k, ctx, *b, None).await?,
            _ => {
                let range = els.iter().find(|e| e.is(C, "time-range")).map(|e| (e.attr("start").and_then(ical_time), e.attr("end").and_then(ical_time)));
                let list: Vec<(Doc, String)> =
                    events(k, ctx, None).await?.into_iter().filter(|(doc, _)| range.is_none_or(|(from, to)| overlaps(doc, from, to))).collect();
                event_items(k, ctx, list).await?
            }
        };
        for i in found {
            {
                let c = child(r, &i.name);
                m.add(&href(ctx, &c), props(ctx, &c, &wanted, None, Some(&i)));
            }
        }
    } else {
        return Ok(refuse(403, "D:supported-report", "this report is not supported here"));
    }
    Ok(m.done())
}

/// Whether an event may have an occurrence in [from, to): a repeating one always may.
fn overlaps(doc: &Doc, from: Option<chrono::DateTime<chrono::Utc>>, to: Option<chrono::DateTime<chrono::Utc>>) -> bool {
    let (Some(start), end) = (util::time(doc, "starts_at"), util::time(doc, "ends_at")) else { return true };
    let end = end.unwrap_or(start).max(start);
    s(doc, "recurrence").is_some() || (to.is_none_or(|t| start < t) && from.is_none_or(|f| end > f || (end == start && start >= f)))
}

/// `20261030T000000Z`
fn ical_time(v: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::NaiveDateTime::parse_from_str(v.trim().trim_end_matches(['Z', 'z']), "%Y%m%dT%H%M%S").ok().map(|t| t.and_utc())
}

// ───────────────────────────── items ─────────────────────────────

/// A collection's items, or those of them named in `only`.
async fn items(k: &Kernel, ctx: &Ctx, r: &Res, only: Option<&[String]>) -> Result<Vec<Item>> {
    match r {
        Res::Calendar => {
            let ids = match only {
                Some(names) => {
                    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
                    let ids = event_ids(&mut tx, ctx, names).await?;
                    tx.commit().await?;
                    Some(ids)
                }
                None => None,
            };
            event_items(k, ctx, events(k, ctx, ids.as_deref()).await?).await
        }
        Res::Book(b) => cards(k, ctx, *b, only).await,
        _ => Ok(vec![]),
    }
}

/// My calendar's events (or those of `only`) as (document, resource name).
async fn events(k: &Kernel, ctx: &Ctx, only: Option<&[Uuid]>) -> Result<Vec<(Doc, String)>> {
    let sql = format!(
        "select to_jsonb(e) || jsonb_build_object('attendees', (select coalesce(jsonb_agg(to_jsonb(a) order by a.idx), '[]') from {att} a \
            where a.tenant_id = e.tenant_id and a.parent_id = e.id), 'reminders', (select coalesce(jsonb_agg(to_jsonb(r) order by r.idx), '[]') \
            from {rem} r where r.tenant_id = e.tenant_id and r.parent_id = e.id)), coalesce(n.name, e.id::text || '.ics') \
         from e_calendar_event e left join comms_dav_name n on n.tenant_id = e.tenant_id and n.event_id = e.id \
         where e.tenant_id = $1 and (e.owner = $2 or exists (select 1 from {att} a where a.tenant_id = e.tenant_id and a.parent_id = e.id \
              and a.email = $2 and a.response <> 'Declined')) \
         and (e.recurrence is not null or e.ends_at > now() - interval '{DAYS_BACK} days' or e.starts_at > now() - interval '{DAYS_BACK} days') \
         and ($3::uuid[] is null or e.id = any($3)) order by e.starts_at, e.id limit {MAX_ITEMS}",
        att = calendar::ATTENDEES,
        rem = calendar::REMINDERS,
    );
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let rows: Vec<(Value, String)> =
        sqlx::query_as(sqlx::AssertSqlSafe(sql)).bind(ctx.tenant).bind(ctx.email.to_lowercase()).bind(only).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(rows.into_iter().map(|(v, n)| (calendar::normalize(util::obj(v)), n)).collect())
}

/// The ids of the events these names point at.
async fn event_ids(tx: &mut Tx, ctx: &Ctx, names: &[String]) -> Result<Vec<Uuid>> {
    let mut ids: Vec<Uuid> = sqlx::query_scalar("select event_id from comms_dav_name where tenant_id = $1 and name = any($2)")
        .bind(ctx.tenant)
        .bind(names)
        .fetch_all(&mut **tx)
        .await?;
    ids.extend(names.iter().filter_map(|n| n.strip_suffix(".ics")?.parse::<Uuid>().ok()));
    Ok(ids)
}

/// Events as calendar objects: iCalendar with the event's last change as its DTSTAMP, so the same
/// event always reads the same.
async fn event_items(k: &Kernel, ctx: &Ctx, list: Vec<(Doc, String)>) -> Result<Vec<Item>> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let mut names: BTreeMap<String, Option<String>> = BTreeMap::new();
    let mut out = Vec::with_capacity(list.len());
    for (doc, name) in list {
        let owner = s(&doc, "owner").unwrap_or_default().to_lowercase();
        if !names.contains_key(&owner) {
            let n = calendar::display_name(&mut tx, ctx.tenant, &owner).await?;
            names.insert(owner.clone(), n);
        }
        let Some(mut ev) = calendar::vevent(&doc, names.get(&owner).cloned().flatten(), false, true) else { continue };
        if let Some(t) = util::time(&doc, "updated_at") {
            ev.stamp = t;
        }
        out.push(Item::new(name, ics::calendar(None, None, &[ev])));
    }
    tx.commit().await?;
    Ok(out)
}

// ───────────────────────────── GET, PUT, DELETE ─────────────────────────────

async fn get(k: &Kernel, ctx: &Ctx, r: &Res, head: bool) -> Result<SiteResponse> {
    let (name, ctype) = match r {
        Res::Event(n) => (n, "text/calendar; charset=utf-8"),
        Res::Card(_, n) => (n, "text/vcard; charset=utf-8"),
        _ => return Ok(SiteResponse::text(200, "text/plain; charset=utf-8", "Ferrum's address for calendar and contacts apps.\n")),
    };
    let item = items(k, ctx, &parent(r), Some(std::slice::from_ref(name))).await?.into_iter().next().ok_or_else(|| Error::NotFound("item".into()))?;
    let mut resp = SiteResponse::text(200, ctype, if head { String::new() } else { item.data });
    resp.headers.push(("etag".into(), item.etag));
    Ok(resp)
}

/// `If-Match` and `If-None-Match` against the item's current ETag (`None`: it does not exist).
fn precondition(req: &SiteRequest, etag: Option<&str>) -> Option<SiteResponse> {
    let matches = |h: &str| h.split(',').map(str::trim).any(|t| t == "*" || Some(t) == etag);
    let failed = match (util::header(req, "if-match"), util::header(req, "if-none-match")) {
        (Some(m), _) if etag.is_none() || !matches(m) => true,
        (_, Some(n)) if etag.is_some() && matches(n) => true,
        _ => false,
    };
    failed.then(|| SiteResponse::text(412, "text/plain; charset=utf-8", "the item changed or exists"))
}

/// One of my calendar's events, by resource name, with its current ETag.
async fn find(k: &Kernel, ctx: &Ctx, name: &str) -> Result<Option<(Uuid, Doc, String)>> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let ids = event_ids(&mut tx, ctx, &[name.to_string()]).await?;
    tx.commit().await?;
    let Some(id) = ids.first() else { return Ok(None) };
    let list = events(k, ctx, Some(&[*id])).await?;
    let Some((doc, n)) = list.first().cloned() else { return Ok(None) };
    let item = event_items(k, ctx, list).await?.into_iter().next();
    Ok(item.filter(|_| n == name).map(|i| (*id, doc, i.etag)))
}

async fn put(k: &Kernel, ctx: &Ctx, req: &SiteRequest, r: &Res) -> Result<SiteResponse> {
    let name = match r {
        Res::Event(n) => n,
        Res::Card(..) => return Ok(refuse(403, "D:need-privileges", "address books here are read-only: change contacts in Ferrum")),
        _ => return Ok(refuse(403, "D:need-privileges", "calendar apps can add events to the calendar only")),
    };
    if req.body.len() > MAX_EVENT {
        return Ok(refuse(403, "C:max-resource-size", "the event is too large"));
    }
    let invalid = |m: &str| Ok(refuse(403, "C:valid-calendar-object-resource", m));
    let Ok(text) = std::str::from_utf8(&req.body) else { return invalid("the event is not UTF-8") };
    let parsed = match ics::parse(text) {
        Ok(p) => p,
        Err(e) => return invalid(&e),
    };
    if let Some(w) = parsed.warnings.iter().find(|w| w.contains("time zone") || w.contains("recurrence not imported")) {
        return invalid(&format!("Ferrum cannot keep this event: {w}"));
    }
    let mut list = ics::detach_overrides(parsed.events).into_iter();
    let Some(main) = list.next() else { return invalid("there is no event (VEVENT) in it") };
    let detached: Vec<ParsedEvent> = list.collect();
    let me = ctx.email.to_lowercase();

    let mut existing = find(k, ctx, name).await?;
    if existing.is_none() {
        // An event of mine with this UID, from an import or another app: this name now points at it.
        let mut tx = k.db.tenant_tx(ctx.tenant).await?;
        let bound: bool = sqlx::query_scalar("select exists (select 1 from comms_dav_name where tenant_id = $1 and name = $2)")
            .bind(ctx.tenant)
            .bind(name)
            .fetch_one(&mut *tx)
            .await?;
        if bound {
            return Ok(refuse(409, "C:no-uid-conflict", "this name belongs to another event"));
        }
        let mine: Option<(Uuid, Option<String>)> = match &main.uid {
            Some(uid) => {
                sqlx::query_as(
                    "select e.id, n.name from e_calendar_event e left join comms_dav_name n on n.tenant_id = e.tenant_id and n.event_id = e.id \
                 where e.tenant_id = $1 and e.owner = $2 and e.ical_uid = $3",
                )
                .bind(ctx.tenant)
                .bind(&me)
                .bind(util::cut(uid, 990))
                .fetch_optional(&mut *tx)
                .await?
            }
            None => None,
        };
        tx.commit().await?;
        match mine {
            Some((_, Some(other))) => return Ok(refuse(409, "C:no-uid-conflict", &format!("this event is already in the calendar as {other}"))),
            Some((id, None)) => existing = find(k, ctx, &format!("{id}.ics")).await?,
            None => {}
        }
    }
    if let Some(resp) = precondition(req, existing.as_ref().map(|(_, _, e)| e.as_str())) {
        return Ok(resp);
    }

    match existing {
        // A guest's copy: their answer is the only thing they change.
        Some((id, doc, _)) if s(&doc, "owner").unwrap_or_default().to_lowercase() != me => {
            if let Some(a) = main.attendees.iter().find(|a| a.email == me) {
                let answer = response(&a.partstat);
                let stored = calendar_attendees(&doc).into_iter().find(|(e, _, _)| *e == me).map(|(_, _, r)| r);
                if stored.as_deref() != Some(answer) {
                    calendar::rsvp(k, ctx, id, util::obj(json!({"response": answer}))).await?;
                }
            }
            Ok(SiteResponse::text(204, "text/plain", ""))
        }
        Some((id, doc, _)) => {
            let patch = fields(&main, Some(&doc), &me);
            k.update(ctx, "CalendarEvent", id, patch, None).await?;
            bind(k, ctx, id, name).await?;
            save_detached(k, ctx, &detached, &me).await?;
            Ok(SiteResponse::text(204, "text/plain", ""))
        }
        None => {
            ctx.require("CalendarEvent", Action::Create)?;
            let mut doc = fields(&main, None, &me);
            let uid = main.uid.clone().unwrap_or_else(|| name.trim_end_matches(".ics").to_string());
            doc.insert("ical_uid".into(), json!(util::cut(&uid, 990)));
            doc.insert("owner".into(), json!(me));
            let created = k.insert(&util::elevated(ctx), "CalendarEvent", doc).await?;
            bind(k, ctx, util::doc_id(&created)?, name).await?;
            save_detached(k, ctx, &detached, &me).await?;
            Ok(SiteResponse::text(201, "text/plain", ""))
        }
    }
}

fn response(partstat: &str) -> &'static str {
    match partstat {
        "ACCEPTED" => "Accepted",
        "DECLINED" => "Declined",
        "TENTATIVE" => "Tentative",
        _ => "Needs Action",
    }
}

/// (email, name, response) of an event's attendees.
fn calendar_attendees(doc: &Doc) -> Vec<(String, Option<String>, String)> {
    util::rows(doc, "attendees")
        .iter()
        .filter_map(|a| {
            Some((s(a, "email")?.to_lowercase(), s(a, "attendee_name").map(str::to_string), s(a, "response").unwrap_or("Needs Action").to_string()))
        })
        .collect()
}

/// An event's fields as an organizer's app sent them. Ferrum keeps what apps tend to drop (the
/// meeting link, visibility, status when absent) and the guests' own answers.
fn fields(e: &ParsedEvent, existing: Option<&Doc>, me: &str) -> Doc {
    let mut doc = calendar::event_fields(e);
    if e.url.is_none() && existing.is_some() {
        doc.remove("meeting_link");
    }
    if e.status.is_none() && existing.is_some() {
        doc.remove("status");
    }
    if existing.is_some() {
        doc.remove("sequence");
    }
    if let Some(private) = e.private {
        doc.insert("visibility".into(), json!(if private { "Private" } else { "Public" }));
    }
    let known: HashMap<String, (Option<String>, String)> =
        existing.map(calendar_attendees).unwrap_or_default().into_iter().map(|(email, name, r)| (email, (name, r))).collect();
    let attendees: Vec<Value> = e
        .attendees
        .iter()
        .filter(|a| a.email != me)
        .map(|a| {
            let (name, answer) = match known.get(&a.email) {
                Some((name, r)) => (a.name.clone().or(name.clone()), r.clone()),
                None => (a.name.clone(), "Needs Action".to_string()),
            };
            json!({"email": a.email, "attendee_name": name.map(|n| util::cut(&n, 140)), "response": answer})
        })
        .collect();
    doc.insert("attendees".into(), Value::Array(attendees));
    doc.insert("reminders".into(), Value::Array(e.alarms.iter().map(|m| json!({"minutes_before": m})).collect()));
    doc
}

/// Keeps the name an app gave an event, when it is not the event's own (`{id}.ics`).
async fn bind(k: &Kernel, ctx: &Ctx, id: Uuid, name: &str) -> Result<()> {
    if name == format!("{id}.ics") {
        return Ok(());
    }
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    sqlx::query("insert into comms_dav_name (tenant_id, event_id, name) values ($1, $2, $3) on conflict do nothing")
        .bind(ctx.tenant)
        .bind(id)
        .bind(util::cut(name, 255))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Occurrences an organizer changed on their own, as events of their own (same UID, same event).
async fn save_detached(k: &Kernel, ctx: &Ctx, list: &[ParsedEvent], me: &str) -> Result<()> {
    for e in list {
        let Some(uid) = e.uid.as_deref().map(|u| util::cut(u, 990)) else { continue };
        let mut tx = k.db.tenant_tx(ctx.tenant).await?;
        let id: Option<Uuid> = sqlx::query_scalar("select id from e_calendar_event where tenant_id = $1 and owner = $2 and ical_uid = $3")
            .bind(ctx.tenant)
            .bind(me)
            .bind(&uid)
            .fetch_optional(&mut *tx)
            .await?;
        tx.commit().await?;
        match id {
            Some(id) => {
                let doc = k.get(ctx, "CalendarEvent", id, false).await?;
                k.update(ctx, "CalendarEvent", id, fields(e, Some(&doc), me), None).await?;
            }
            None => {
                let mut doc = fields(e, None, me);
                doc.insert("ical_uid".into(), json!(uid));
                doc.insert("owner".into(), json!(me));
                k.insert(&util::elevated(ctx), "CalendarEvent", doc).await?;
            }
        }
    }
    Ok(())
}

/// Deleting an event the person organizes cancels it for everyone; deleting an invitation
/// declines it.
async fn delete(k: &Kernel, ctx: &Ctx, req: &SiteRequest, r: &Res) -> Result<SiteResponse> {
    let name = match r {
        Res::Event(n) => n,
        Res::Card(..) => return Ok(refuse(403, "D:need-privileges", "address books here are read-only: change contacts in Ferrum")),
        _ => return Ok(refuse(403, "D:need-privileges", "calendars and address books cannot be deleted here")),
    };
    let Some((id, doc, etag)) = find(k, ctx, name).await? else { return Err(Error::NotFound("event".into())) };
    if let Some(resp) = precondition(req, Some(&etag)) {
        return Ok(resp);
    }
    if s(&doc, "owner").unwrap_or_default().eq_ignore_ascii_case(&ctx.email) {
        k.delete(ctx, "CalendarEvent", id, None).await?;
    } else {
        calendar::rsvp(k, ctx, id, util::obj(json!({"response": "Declined"}))).await?;
    }
    Ok(SiteResponse::text(204, "text/plain", ""))
}

// ───────────────────────────── address books ─────────────────────────────

/// A vCard 3.0 line, escaped and folded.
fn card_line(out: &mut String, name: &str, value: &str) {
    out.push_str(&ics::fold(&format!("{name}:{}", ics::escape(value))));
    out.push_str("\r\n");
}

struct Card<'a> {
    uid: String,
    full_name: String,
    first: &'a str,
    last: &'a str,
    org: Option<&'a str>,
    title: Option<&'a str>,
    emails: Vec<(String, bool)>,
    /// (number, Mobile | Work | Home | Other, primary)
    phones: Vec<(String, String, bool)>,
    note: Option<&'a str>,
    rev: Option<String>,
}

fn vcard(c: &Card) -> String {
    let mut out = String::from("BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//Ferrum//Communication//EN\r\n");
    card_line(&mut out, "UID", &c.uid);
    card_line(&mut out, "FN", &c.full_name);
    out.push_str(&ics::fold(&format!("N:{};{};;;", ics::escape(c.last), ics::escape(c.first))));
    out.push_str("\r\n");
    if let Some(o) = c.org.filter(|o| !o.trim().is_empty()) {
        card_line(&mut out, "ORG", o);
    }
    if let Some(t) = c.title.filter(|t| !t.trim().is_empty()) {
        card_line(&mut out, "TITLE", t);
    }
    for (email, primary) in &c.emails {
        card_line(&mut out, if *primary { "EMAIL;TYPE=INTERNET,PREF" } else { "EMAIL;TYPE=INTERNET" }, email);
    }
    for (number, kind, primary) in &c.phones {
        let kind = match kind.as_str() {
            "Mobile" => "CELL",
            "Work" => "WORK",
            "Home" => "HOME",
            _ => "VOICE",
        };
        card_line(&mut out, &format!("TEL;TYPE={kind}{}", if *primary { ",PREF" } else { "" }), number);
    }
    if let Some(n) = c.note.filter(|n| !n.trim().is_empty()) {
        card_line(&mut out, "NOTE", n);
    }
    if let Some(r) = &c.rev {
        out.push_str(&format!("REV:{r}\r\n"));
    }
    out.push_str("END:VCARD\r\n");
    out
}

/// `2026-10-30T09:00:00.000Z` → `20261030T090000Z`
fn rev(doc: &Doc) -> Option<String> {
    util::time(doc, "updated_at").map(|t| t.format("%Y%m%dT%H%M%SZ").to_string())
}

/// "Ana María Rao" → ("Ana María", "Rao")
fn split_name(full: &str) -> (&str, &str) {
    full.trim().rsplit_once(' ').map_or((full.trim(), ""), |(first, last)| (first.trim(), last.trim()))
}

async fn cards(k: &Kernel, ctx: &Ctx, book: Book, only: Option<&[String]>) -> Result<Vec<Item>> {
    let ids: Option<Vec<Uuid>> = only.map(|names| names.iter().filter_map(|n| n.strip_suffix(".vcf")?.parse().ok()).collect());
    if ids.as_ref().is_some_and(Vec::is_empty) {
        return Ok(vec![]);
    }
    match book {
        Book::Colleagues => colleagues(k, ctx, ids.as_deref()).await,
        Book::Contacts => contacts(k, ctx, ids.as_deref()).await,
    }
}

/// Active people of the workspace; plugins' service users (addresses under the reserved `.invalid`)
/// are not people.
async fn colleagues(k: &Kernel, ctx: &Ctx, only: Option<&[Uuid]>) -> Result<Vec<Item>> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let rows: Vec<(Uuid, String, String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select id, email::text, full_name, updated_at from app_user where tenant_id = $1 and is_active and ($2::uuid[] is null or id = any($2)) \
         and email::text not like '%.invalid' order by full_name, id limit {MAX_ITEMS}"
    )))
    .bind(ctx.tenant)
    .bind(only)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(rows
        .into_iter()
        .map(|(id, email, full_name, updated)| {
            let full = if full_name.trim().is_empty() { email.clone() } else { full_name.trim().to_string() };
            let (first, last) = split_name(&full);
            let data = vcard(&Card {
                uid: id.to_string(),
                full_name: full.clone(),
                first,
                last,
                org: None,
                title: None,
                emails: vec![(email.to_lowercase(), true)],
                phones: vec![],
                note: None,
                rev: Some(updated.format("%Y%m%dT%H%M%SZ").to_string()),
            });
            Item::new(format!("{id}.vcf"), data)
        })
        .collect())
}

/// CRM contacts the person may read, through the platform's list (its permissions and field
/// masks), with their emails and phones.
async fn contacts(k: &Kernel, ctx: &Ctx, only: Option<&[Uuid]>) -> Result<Vec<Item>> {
    let mut docs: Vec<Doc> = Vec::new();
    let mut cursor = None;
    loop {
        let filters = only.map(|ids| vec![Filter { field: "id".into(), op: Op::In, value: json!(ids) }]).unwrap_or_default();
        let q = ListQuery { filters, sort: Some("created_at asc".into()), limit: Some(500), cursor: cursor.take(), with_titles: true, ..Default::default() };
        let page = k.list(ctx, "Contact", &q).await?;
        docs.extend(page.rows);
        match page.next_cursor {
            Some(c) if docs.len() < MAX_ITEMS => cursor = Some(c),
            _ => break,
        }
    }
    let ids: Vec<Uuid> = docs.iter().filter_map(|d| util::id(d, "id")).collect();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let tables: (bool, bool) =
        sqlx::query_as("select to_regclass('e_contact__emails') is not null, to_regclass('e_contact__phones') is not null").fetch_one(&mut *tx).await?;
    let emails: Vec<(Uuid, String, bool)> = if tables.0 {
        sqlx::query_as("select parent_id, email::text, coalesce(is_primary, false) from e_contact__emails where tenant_id = $1 and parent_id = any($2) order by parent_id, idx")
            .bind(ctx.tenant)
            .bind(&ids)
            .fetch_all(&mut *tx)
            .await?
    } else {
        vec![]
    };
    let phones: Vec<(Uuid, String, Option<String>, bool)> = if tables.1 {
        sqlx::query_as(
            "select parent_id, phone::text, phone_type::text, coalesce(is_primary, false) from e_contact__phones where tenant_id = $1 and parent_id = any($2) order by parent_id, idx",
        )
        .bind(ctx.tenant)
        .bind(&ids)
        .fetch_all(&mut *tx)
        .await?
    } else {
        vec![]
    };
    tx.commit().await?;
    let mut by_contact: HashMap<Uuid, (Vec<(String, bool)>, Vec<(String, String, bool)>)> = HashMap::new();
    for (id, email, primary) in emails {
        by_contact.entry(id).or_default().0.push((email.to_lowercase(), primary));
    }
    for (id, phone, kind, primary) in phones {
        by_contact.entry(id).or_default().1.push((phone, kind.unwrap_or_else(|| "Other".into()), primary));
    }
    Ok(docs
        .iter()
        .filter_map(|d| {
            let id = util::id(d, "id")?;
            let (first, last) = (s(d, "first_name").unwrap_or_default(), s(d, "last_name").unwrap_or_default());
            let full = s(d, "full_name").map(str::to_string).filter(|n| !n.trim().is_empty()).unwrap_or_else(|| format!("{first} {last}").trim().to_string());
            let (mut emails, mut phones) = by_contact.remove(&id).unwrap_or_default();
            // A masked primary field hides the list it comes from.
            if !d.contains_key("email") {
                emails.clear();
            } else if emails.is_empty()
                && let Some(e) = s(d, "email")
            {
                emails.push((e.to_lowercase(), true));
            }
            if !d.contains_key("phone") {
                phones.clear();
            } else if phones.is_empty()
                && let Some(p) = s(d, "phone")
            {
                phones.push((p.to_string(), "Other".into(), true));
            }
            let titles = d.get("_titles").and_then(Value::as_object);
            let org = ["customer", "supplier", "prospect", "lead"].iter().find_map(|f| titles?.get(*f)?.as_str());
            let data = vcard(&Card {
                uid: id.to_string(),
                full_name: if full.is_empty() { emails.first().map(|e| e.0.clone()).unwrap_or_else(|| "Contact".into()) } else { full.clone() },
                first,
                last,
                org,
                title: s(d, "designation"),
                emails,
                phones,
                note: s(d, "notes"),
                rev: rev(d),
            });
            Some(Item::new(format!("{id}.vcf"), data))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_read_with_their_namespaces() {
        let body = br#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:getetag/><cs:getctag/><x:color xmlns:x="urn:x"/></d:prop></d:propfind>"#;
        let els = elements(body).unwrap();
        assert_eq!(
            wanted(&els).unwrap(),
            vec![(D.to_string(), "getetag".to_string()), (CS.to_string(), "getctag".to_string()), ("urn:x".to_string(), "color".to_string())]
        );
        let multiget = br#"<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-data/></D:prop><D:href>/api/dav/comms/u/1/calendars/default/a%20b&amp;c.ics</D:href></C:calendar-multiget>"#;
        let els = elements(multiget).unwrap();
        let hrefs: Vec<String> = els.iter().filter(|e| e.is(D, "href")).map(|e| e.text.clone()).collect();
        assert_eq!(names_in(&hrefs, "/api/dav/comms/u/1/calendars/default/")[0].1.as_deref(), Some("a b&c.ics"));
        assert!(wanted(&elements(b"<D:propfind xmlns:D=\"DAV:\"><D:allprop/></D:propfind>").unwrap()).is_none());
        assert!(elements(b"<D:propfind xmlns:D=\"DAV:\"><D:prop>").is_err() || wanted(&elements(b"<D:propfind xmlns:D=\"DAV:\"><D:prop>").unwrap()).is_some());
    }

    #[test]
    fn names_round_trip_through_hrefs() {
        for name in ["5D3A-11.ics", "Ana's event @ 9.ics", "日本.ics"] {
            assert_eq!(dec(&enc(name)), name);
            assert!(!enc(name).contains(' '));
        }
        let full = vec!["https://erp.example.com/api/dav/comms/u/1/calendars/default/x.ics".to_string(), "/elsewhere/x.ics".to_string()];
        let named = names_in(&full, "/api/dav/comms/u/1/calendars/default/");
        assert_eq!((named[0].1.as_deref(), named[1].1.as_deref()), (Some("x.ics"), None));
    }

    #[test]
    fn unknown_properties_keep_their_namespace() {
        assert_eq!(element(&("urn:x".into(), "color".into()), ""), "<color xmlns=\"urn:x\"/>");
        assert_eq!(element(&(CS.into(), "getctag".into()), "\"a\""), "<CS:getctag>\"a\"</CS:getctag>");
    }

    #[test]
    fn cards_are_vcard_3() {
        let card = vcard(&Card {
            uid: "1".into(),
            full_name: "Rao, Ana".into(),
            first: "Ana",
            last: "Rao",
            org: Some("Acme; Ltd"),
            title: Some("Buyer"),
            emails: vec![("ana@acme.test".into(), true)],
            phones: vec![("+91 98 7654 3210".into(), "Mobile".into(), false)],
            note: Some("Line 1\nLine 2"),
            rev: Some("20261030T090000Z".into()),
        });
        for l in [
            "FN:Rao\\, Ana",
            "N:Rao;Ana;;;",
            "ORG:Acme\\; Ltd",
            "EMAIL;TYPE=INTERNET,PREF:ana@acme.test",
            "TEL;TYPE=CELL:+91 98 7654 3210",
            "NOTE:Line 1\\nLine 2",
        ] {
            assert!(card.contains(&format!("{l}\r\n")), "{l} in {card}");
        }
        assert_eq!(split_name("Ana María Rao"), ("Ana María", "Rao"));
        assert_eq!(split_name("Ana"), ("Ana", ""));
    }
}
