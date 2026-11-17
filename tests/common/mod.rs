//! What Comms' suites share: a domain of a workspace's own, claimed for mail and proven by its DNS record as the platform
//! proves one (Ferrum docs/operations.md, "Domains for mail"), the record served by a DNS server of the test's own as the
//! platform's own suites do (crates/kernel/tests/shell_it.rs), so that no test asks the real DNS.

use ferrum_kernel::{Ctx, Kernel, KernelSettings};

/// Claims `domain` (lower case) for mail for `admin`'s workspace and proves it by its record.
pub async fn prove(k: &Kernel, admin: &Ctx, domain: &str) {
    let claim = k.add_host(admin, domain, "mail").await.expect("claimed for mail");
    let resolver = dns(format!("_ferrum.{domain}."), format!("ferrum-domain={}", claim.verify_token)).await;
    k.set_live(KernelSettings { dns_resolvers: vec![resolver], ..(*k.live()).clone() });
    assert!(k.host_reached(domain, false).await.expect("checked").is_some_and(|c| c.works), "{domain} proven by its record");
}

/// A DNS server that answers `name`'s TXT record with `value`; any other name does not exist.
async fn dns(name: String, value: String) -> std::net::SocketAddr {
    use hickory_resolver::proto::op::{Message, OpCode, ResponseCode};
    use hickory_resolver::proto::rr::rdata::TXT;
    use hickory_resolver::proto::rr::{Name, RData, Record};
    let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let addr = socket.local_addr().unwrap();
    tokio::spawn(async move {
        let mut buf = [0u8; 1500];
        while let Ok((n, from)) = socket.recv_from(&mut buf).await {
            let Ok(asked) = Message::from_vec(&buf[..n]) else { continue };
            let Some(q) = asked.queries.first().cloned() else { continue };
            let found = q.name().to_ascii().eq_ignore_ascii_case(&name);
            let mut answer = Message::response(asked.metadata.id, OpCode::Query);
            answer.metadata.recursion_desired = true;
            answer.metadata.recursion_available = true;
            answer.add_query(q);
            if found {
                answer.add_answers(vec![Record::from_rdata(Name::from_ascii(&name).unwrap(), 60, RData::TXT(TXT::new(vec![value.clone()])))]);
            } else {
                answer.metadata.response_code = ResponseCode::NXDomain;
            }
            let _ = socket.send_to(&answer.to_vec().unwrap(), from).await;
        }
    });
    addr
}
