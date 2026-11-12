//! What an app calls to send mail through Mail: [`send`] queues one email, in the caller's transaction (nothing
//! goes unless it commits), as a `Communication` on the record it is about. Unlike a bare insert it takes the
//! threading and reply headers as typed values and checks them: a Reply-To is one address, In-Reply-To and
//! References are message ids, the envelope sender is on a domain of the workspace. None of them is header text, so
//! nothing an app passes along (a customer's own Message-ID, say) can add a header. The Message-ID Mail gave the
//! message comes back in [`Sent`] and is stored on the Communication, so an answer to it is matched to it (and to
//! the record) by [`crate::inbound`] and by the app, by In-Reply-To or References.

use crate::util::{self, id, s};
use ferrum_kernel::{Action, Ctx, Doc, Error, Kernel, Result, Tx};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::LazyLock;
use uuid::Uuid;

/// One email to send.
#[derive(Debug, Clone, Default)]
pub struct Message {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    /// HTML; the plain text is made from it when `text` is empty.
    pub html: String,
    pub text: Option<String>,
    /// The record it is about: entity and id.
    pub reference: Option<(String, Uuid)>,
    /// The email account to send from; the default outgoing one when empty.
    pub account: Option<Uuid>,
    /// Where answers go: one address, `a@x.test` or `Name <a@x.test>`.
    pub reply_to: Option<String>,
    /// The message ids this answers, with or without angle brackets: the one answered, and what came before it.
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    /// Where bounces go (the SMTP envelope sender): an address on a domain of the workspace.
    pub envelope_sender: Option<String>,
    /// Files to attach: `[{id}]` as for a Communication.
    pub attachments: Option<Value>,
    /// Headers from Mail's allow-list for bulk and automatic mail (List-Unsubscribe, Auto-Submitted, `X-` names...).
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sent {
    /// The queued Communication.
    pub communication: Uuid,
    /// The Message-ID the message goes out with, without angle brackets.
    pub message_id: String,
}

/// A message id as it is written in In-Reply-To and References, without the angle brackets: `local@domain` of
/// printable characters that cannot end a header, at most 250.
pub fn message_id(v: &str) -> Result<String> {
    static ID: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.\-]{1,200}@[A-Za-z0-9.\-\[\]:]{1,200}$").expect("a valid pattern"));
    let bare = v.trim().strip_prefix('<').and_then(|r| r.strip_suffix('>')).unwrap_or(v.trim());
    if ID.is_match(bare) { Ok(bare.to_string()) } else { Err(Error::invalid(format!("'{}' is not a message id", util::cut(&util::clean_line(v, 80), 80)))) }
}

/// The domain of `address` (lower case) when it is on, or under, a domain of the workspace.
async fn on_workspace_domain(tx: &mut Tx, tenant: Uuid, address: &str) -> Result<bool> {
    let Some((_, domain)) = address.rsplit_once('@') else { return Ok(false) };
    let domain = domain.to_ascii_lowercase();
    Ok(crate::routes::domains(tx, tenant).await?.iter().any(|d| domain == *d || domain.ends_with(&format!(".{d}"))))
}

/// Queues `m` as the system (the caller needs the right to create communications unless it is one), and returns
/// its Message-ID. Nothing is sent before the transaction commits.
pub async fn send(k: &Kernel, ctx: &Ctx, tx: &mut Tx, m: &Message) -> Result<Sent> {
    if !ctx.is_system {
        ctx.require("Communication", Action::Create)?;
    }
    let one_address = |field: &str, v: &str| -> Result<String> {
        let mailbox = v
            .parse::<lettre::message::Mailbox>()
            .map_err(|_| Error::field(field, format!("'{}' is not an address", util::cut(&util::clean_line(v, 80), 80))))?;
        Ok(mailbox.to_string())
    };
    let reply_to = m.reply_to.as_deref().map(|v| one_address("reply_to", v)).transpose()?;
    let in_reply_to = m.in_reply_to.as_deref().map(message_id).transpose()?;
    let references = m.references.iter().map(|r| message_id(r)).collect::<Result<Vec<_>>>()?;
    if references.len() > 50 {
        return Err(Error::field("references", "at most 50 message ids"));
    }
    let envelope = match m.envelope_sender.as_deref() {
        Some(v) => {
            let bare =
                v.trim().parse::<lettre::Address>().map_err(|_| Error::field("envelope_sender", "must be one plain address"))?.to_string().to_ascii_lowercase();
            if !on_workspace_domain(tx, ctx.tenant, &bare).await? {
                return Err(Error::field("envelope_sender", "must be on a domain of the workspace (its mail domain or an outgoing email account's)"));
            }
            Some(bare)
        }
        None => None,
    };
    let mut doc = Doc::new();
    let mut put = |f: &str, v: Value| {
        doc.insert(f.to_string(), v);
    };
    put("channel", json!("Email"));
    put("direction", json!("Sent"));
    put("subject", json!(m.subject));
    put("content", json!(m.html));
    put("text_content", json!(m.text));
    for (f, list) in [("recipients", &m.to), ("cc", &m.cc), ("bcc", &m.bcc)] {
        put(f, if list.is_empty() { Value::Null } else { json!(list.join(", ")) });
    }
    put("email_account", json!(m.account.map(|a| a.to_string())));
    put("reference_entity", json!(m.reference.as_ref().map(|r| r.0.clone())));
    put("reference_id", json!(m.reference.as_ref().map(|r| r.1.to_string())));
    put("reply_to_address", json!(reply_to));
    put("envelope_sender", json!(envelope));
    put("in_reply_to", json!(in_reply_to));
    put("mail_references", if references.is_empty() { Value::Null } else { json!(references.join(" ")) });
    if let Some(a) = &m.attachments {
        put("attachments", a.clone());
    }
    put("headers", if m.headers.is_empty() { Value::Null } else { json!(m.headers) });
    put("seen", json!(true));
    let sent = k.insert_tx(&util::sys(ctx), tx, "Communication", doc).await?;
    Ok(Sent {
        communication: id(&sent, "id").ok_or_else(|| Error::internal("a communication without an id"))?,
        message_id: s(&sent, "message_id").ok_or_else(|| Error::internal("a queued email without a Message-ID"))?.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_ids_are_ids_and_never_header_text() {
        assert_eq!(message_id("<0192abc@mail.acme.test>").unwrap(), "0192abc@mail.acme.test");
        assert_eq!(message_id("CAF=x+y.1@mail.gmail.com").unwrap(), "CAF=x+y.1@mail.gmail.com");
        for bad in ["", "no-at-sign", "a@b\r\nBcc: x@y.test", "a b@c.test", "<a@b", "a@b>", "a@b, c@d", "a@", "@b"] {
            assert!(message_id(bad).is_err(), "{bad:?}");
        }
    }
}
