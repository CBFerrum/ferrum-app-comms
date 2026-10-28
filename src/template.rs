//! Email templates: MiniJinja with no loader (templates cannot reach the filesystem or each
//! other), a fuel limit against runaway loops, chainable undefined values (a missing field —
//! even `doc.missing.deeper` — renders empty instead of failing) and HTML auto-escaping for bodies.

use crate::util::{self, s};
use async_trait::async_trait;
use ferrum_kernel::{Doc, DocHook, Error, HookCtx, Result};
use minijinja::{AutoEscape, Environment, UndefinedBehavior, Value as JValue};
use serde_json::Value;

const FUEL: u64 = 200_000;
const MAX_OUTPUT: usize = 2 * 1024 * 1024;

fn env(html: bool) -> Environment<'static> {
    let mut env = Environment::new();
    env.set_undefined_behavior(UndefinedBehavior::Chainable);
    env.set_fuel(Some(FUEL));
    env.set_recursion_limit(20);
    env.set_auto_escape_callback(move |_| if html { AutoEscape::Html } else { AutoEscape::None });
    env
}

fn render(src: &str, ctx: &Value, html: bool) -> Result<String> {
    let out = env(html).render_str(src, JValue::from_serialize(ctx)).map_err(|e| Error::invalid(format!("template: {e}")))?;
    if out.len() > MAX_OUTPUT {
        return Err(Error::invalid("the template produced more than 2 MB"));
    }
    Ok(out)
}

/// Renders an HTML body; every `{{ value }}` is HTML-escaped.
pub fn render_html(src: &str, ctx: &Value) -> Result<String> {
    render(src, ctx, true)
}

/// Renders a subject line (plain text, one line).
pub fn render_subject(src: &str, ctx: &Value) -> Result<String> {
    let out = render(src, ctx, false)?;
    Ok(out.split(['\r', '\n']).map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" "))
}

/// Syntax check, as a message.
pub fn check(src: &str) -> std::result::Result<(), String> {
    env(true).template_from_str(src).map(|_| ()).map_err(|e| e.to_string())
}

/// Validates template syntax when templates are saved.
pub struct TemplateHook;

#[async_trait]
impl DocHook for TemplateHook {
    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        for field in ["subject", "body"] {
            if let Some(src) = s(doc, field) {
                check(src).map_err(|m| Error::field(field, m))?;
            }
        }
        if let Some(e) = s(doc, "reference_entity")
            && hc.ctx.schema.entity(e).is_none()
        {
            return Err(Error::field("reference_entity", format!("{e} is not an installed entity")));
        }
        let _ = util::now();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_fields_render_empty_and_values_are_escaped() {
        let ctx = json!({"doc": {"customer_name": "<script>alert(1)</script> & Co", "amount": "12.50"}, "user": {"full_name": "Asha"}});
        let body = render_html("<p>Dear {{ doc.customer_name }},</p><p>{{ doc.missing }}|{{ doc.missing.deeper }}|{{ doc.amount }}</p>", &ctx).unwrap();
        assert_eq!(body, "<p>Dear &lt;script&gt;alert(1)&lt;&#x2f;script&gt; &amp; Co,</p><p>||12.50</p>");
        assert_eq!(render_subject("Re: {{ doc.customer_name }}\n{{ user.full_name }}", &ctx).unwrap(), "Re: <script>alert(1)</script> & Co Asha");
        assert!(check("{% for x in %}").is_err());
        assert!(check("Hello {{ doc.name | upper }}").is_ok());
    }

    #[test]
    fn templates_cannot_loop_forever_or_read_files() {
        let ctx = json!({});
        assert!(render_html("{% for i in range(100000) %}{% for j in range(100000) %}x{% endfor %}{% endfor %}", &ctx).is_err());
        assert!(render_html("{% include '/etc/passwd' %}", &ctx).is_err());
    }
}
