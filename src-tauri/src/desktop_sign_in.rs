//! Desktop sign-in through the system browser (#9396 follow-up).
//!
//! Passkeys and Google sign-in cannot run in the WebView (origin
//! `tauri://localhost`), so the desktop opens www.worldmonitor.app in the
//! default browser and receives a one-time code on a 127.0.0.1 loopback
//! redirect (RFC 8252) guarded by PKCE and `state`. Rust then exchanges the
//! code for a Clerk sign-in ticket and redeems it through the Clerk relay, so
//! the verifier, the code and the ticket never reach renderer script.
//! See docs/plans/2026-10-19-desktop-system-browser-sign-in.md.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::Url;
use sha2::{Digest, Sha256};

pub const SIGN_IN_PAGE: &str = "https://www.worldmonitor.app/desktop-sign-in";
pub const TOKEN_ENDPOINT: &str = "https://api.worldmonitor.app/api/desktop-auth/token";
pub const FLOW_TIMEOUT: Duration = Duration::from_secs(5 * 60);
pub const START_COOLDOWN: Duration = Duration::from_secs(3);
const MAX_REQUEST_BYTES: usize = 8 * 1024;
/// Total time one connection may take to send its request head. Connections
/// are served one at a time, so this bounds how long an idle preconnect
/// socket or a peer dripping bytes can hold up the real callback, Cancel and
/// the flow deadline.
const CONNECTION_BUDGET: Duration = Duration::from_secs(1);
/// A ticket lives 60 seconds on Clerk's side; redeem well inside that.
pub const PENDING_TICKET_MAX_AGE: Duration = Duration::from_secs(50);
const ACCEPT_POLL: Duration = Duration::from_millis(100);

const RETURN_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<title>World Monitor</title><style>body{font:16px -apple-system,system-ui,sans-serif;\
background:#0f0f0f;color:#e8e8e8;display:grid;place-items:center;height:100vh;margin:0}\
</style></head><body><p>Return to World Monitor to finish signing in. You can close this tab.</p>\
</body></html>";

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS CSPRNG unavailable");
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// The sign-in ticket is a credential for the production Clerk instance, so it
/// is only ever delivered to the production Frontend API, never to a
/// renderer-chosen development instance the relay also allows.
pub fn is_ticket_host(host: &str) -> bool {
    host == crate::clerk_relay::PRODUCTION_FAPI_HOST
}

pub struct FlowSecrets {
    pub state: String,
    pub verifier: String,
    pub challenge: String,
}

impl FlowSecrets {
    pub fn generate() -> Self {
        let verifier = random_token();
        let challenge = pkce_challenge(&verifier);
        Self { state: random_token(), verifier, challenge }
    }
}

/// The launch parameters travel in the fragment, which browsers never send to
/// servers, so they stay out of request logs, Sentry URLs and Clerk redirects.
pub fn sign_in_url(port: u16, state: &str, challenge: &str) -> String {
    format!("{SIGN_IN_PAGE}#port={port}&state={state}&challenge={challenge}")
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The code from `GET /callback?code=…&state=…` when `state` matches. Any
/// other request returns None and the listener keeps waiting, so a web page
/// that probes the port cannot end the flow.
pub fn parse_callback(head: &str, expected_state: &str) -> Option<String> {
    let request_line = head.lines().next()?;
    let mut parts = request_line.split(' ');
    let (method, target) = (parts.next()?, parts.next()?);
    if method != "GET" || !target.starts_with("/callback?") {
        return None;
    }
    let url = Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != "/callback" {
        return None;
    }
    let mut code = None;
    let mut state = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" if code.is_none() => code = Some(value.into_owned()),
            "state" if state.is_none() => state = Some(value.into_owned()),
            "code" | "state" => return None,
            _ => {}
        }
    }
    let (code, state) = (code?, state?);
    let well_formed = code.len() == 43
        && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if well_formed && constant_time_eq(state.as_bytes(), expected_state.as_bytes()) {
        Some(code)
    } else {
        None
    }
}

fn write_response(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n\
Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

/// Reads the request head (up to the blank line), capped in size and in
/// total time: the socket timeout alone applies per read, so a peer sending
/// one byte at a time would otherwise never be cut off.
fn read_head(stream: &mut TcpStream) -> Option<String> {
    let deadline = Instant::now() + CONNECTION_BUDGET;
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let remaining = deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero())?;
        stream.set_read_timeout(Some(remaining)).ok()?;
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > MAX_REQUEST_BYTES {
            return None;
        }
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            return String::from_utf8(buf).ok();
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum WaitError {
    Cancelled,
    TimedOut,
    Io(String),
}

/// Blocks until a loopback peer delivers a callback with the right `state`,
/// the deadline passes, or `cancel` is set.
pub fn wait_for_code(
    listener: &TcpListener,
    expected_state: &str,
    deadline: Instant,
    cancel: &AtomicBool,
) -> Result<String, WaitError> {
    listener.set_nonblocking(true).map_err(|e| WaitError::Io(e.to_string()))?;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(WaitError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(WaitError::TimedOut);
        }
        match listener.accept() {
            Ok((mut stream, peer)) => {
                if !peer.ip().is_loopback() {
                    continue;
                }
                let _ = stream.set_nonblocking(false);
                match read_head(&mut stream).and_then(|head| parse_callback(&head, expected_state)) {
                    Some(code) => {
                        write_response(&mut stream, "200 OK", RETURN_PAGE);
                        return Ok(code);
                    }
                    None => write_response(&mut stream, "404 Not Found", ""),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(ACCEPT_POLL),
            Err(e) => return Err(WaitError::Io(e.to_string())),
        }
    }
}

/// Bookkeeping for the browser sign-in: one live flow, a short cooldown after
/// a browser actually opened (a double click must not open a second tab), and
/// the ticket a finished flow leaves for the renderer to redeem once it is
/// ready (it signs out an existing session only after the flow succeeded).
#[derive(Default)]
pub struct FlowRegistry {
    active: Option<Arc<AtomicBool>>,
    last_opened: Option<Instant>,
    pending: Option<PendingTicket>,
}

struct PendingTicket {
    fapi_host: String,
    ticket: String,
    at: Instant,
}

impl FlowRegistry {
    /// Starts a flow, cancelling any previous one, unless a browser opened
    /// for a live flow within the cooldown.
    pub fn begin(&mut self, now: Instant) -> Result<Arc<AtomicBool>, &'static str> {
        let live = self.active.as_ref().is_some_and(|flag| !flag.load(Ordering::SeqCst));
        if live && self.last_opened.is_some_and(|at| now.duration_since(at) < START_COOLDOWN) {
            return Err("already_running");
        }
        self.cancel();
        let flag = Arc::new(AtomicBool::new(false));
        self.active = Some(flag.clone());
        Ok(flag)
    }

    pub fn opened(&mut self, now: Instant) {
        self.last_opened = Some(now);
    }

    fn is_current(&self, flag: &Arc<AtomicBool>) -> bool {
        self.active.as_ref().is_some_and(|active| Arc::ptr_eq(active, flag)) && !flag.load(Ordering::SeqCst)
    }

    /// Err("cancelled") when this flow was cancelled or replaced.
    pub fn check(&self, flag: &Arc<AtomicBool>) -> Result<(), &'static str> {
        if self.is_current(flag) { Ok(()) } else { Err("cancelled") }
    }

    pub fn store_ticket(
        &mut self,
        flag: &Arc<AtomicBool>,
        fapi_host: String,
        ticket: String,
        now: Instant,
    ) -> Result<(), &'static str> {
        self.check(flag)?;
        self.pending = Some(PendingTicket { fapi_host, ticket, at: now });
        self.active = None;
        Ok(())
    }

    /// Ends a flow that failed, so a retry is not held by the cooldown.
    pub fn fail(&mut self, flag: &Arc<AtomicBool>) {
        if self.is_current(flag) {
            self.active = None;
            self.last_opened = None;
        }
    }

    pub fn take_ticket(&mut self, now: Instant) -> Option<(String, String)> {
        let pending = self.pending.take()?;
        (now.duration_since(pending.at) < PENDING_TICKET_MAX_AGE).then_some((pending.fapi_host, pending.ticket))
    }

    pub fn cancel(&mut self) {
        if let Some(flag) = self.active.take() {
            flag.store(true, Ordering::SeqCst);
        }
        self.pending = None;
        self.last_opened = None;
    }
}

/// FAPI sign-in response fields the renderer needs, and nothing else.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInOutcome {
    pub status: String,
    pub created_session_id: Option<String>,
    pub identifier: Option<String>,
}

pub fn parse_sign_in_response(body: &str) -> Result<SignInOutcome, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| "Clerk returned an unreadable sign-in response".to_string())?;
    let sign_in = value.get("response").unwrap_or(&value);
    let text = |key: &str| sign_in.get(key).and_then(|v| v.as_str()).map(str::to_string);
    let status = text("status").ok_or_else(|| "Clerk sign-in response had no status".to_string())?;
    Ok(SignInOutcome {
        status,
        created_session_id: text("created_session_id"),
        identifier: text("identifier"),
    })
}

/// The ticket is redeemed on a fresh Clerk client, so an existing session is
/// never signed out first (a client with a session refuses a ticket with
/// `session_exists`). The new client replaces the stored one only when Clerk
/// accepted the ticket and issued a client token; any failure leaves the
/// user's current session exactly as it was.
pub fn adopt_redeemed_client(
    http_status: u16,
    outcome: Option<&SignInOutcome>,
    new_client_token: Option<&str>,
) -> bool {
    let usable_outcome = outcome.is_some_and(|outcome| {
        // A completed sign-in must have produced a session to activate;
        // other statuses (e.g. needs_second_factor) continue in the app.
        outcome.status != "complete"
            || outcome.created_session_id.as_deref().is_some_and(|id| !id.trim().is_empty())
    });
    http_status < 400 && usable_outcome && new_client_token.is_some_and(|token| !token.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use std::sync::Arc;

    const STATE: &str = "s1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_abc";
    const CODE: &str = "c1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_abc";

    #[test]
    fn derives_the_s256_challenge() {
        let verifier = "dBjftJeZ4CVP-mJ92ZcbaYWHQjSNNSSzSRDf8nB25o4";
        assert_eq!(pkce_challenge(verifier), "dq603AtCWbd6C-Stzz5O7ACc2P5b1imWHJ5dlcIgMgw");
    }

    #[test]
    fn generates_url_safe_secrets_that_match_the_server_contract() {
        let secrets = FlowSecrets::generate();
        for value in [&secrets.state, &secrets.verifier, &secrets.challenge] {
            assert_eq!(value.len(), 43);
            assert!(value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        }
        assert_eq!(pkce_challenge(&secrets.verifier), secrets.challenge);
        assert_ne!(secrets.state, FlowSecrets::generate().state);
    }

    #[test]
    fn puts_launch_parameters_in_the_fragment() {
        let url = sign_in_url(51234, STATE, "chal");
        let parsed = Url::parse(&url).unwrap();
        assert_eq!(parsed.host_str(), Some("www.worldmonitor.app"));
        assert_eq!(parsed.query(), None);
        assert_eq!(parsed.fragment(), Some(format!("port=51234&state={STATE}&challenge=chal").as_str()));
    }

    #[test]
    fn accepts_only_a_well_formed_callback_with_the_expected_state() {
        let ok = format!("GET /callback?code={CODE}&state={STATE} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        assert_eq!(parse_callback(&ok, STATE), Some(CODE.to_string()));

        let reordered = format!("GET /callback?state={STATE}&code={CODE} HTTP/1.1\r\n\r\n");
        assert_eq!(parse_callback(&reordered, STATE), Some(CODE.to_string()));

        for head in [
            format!("GET /callback?code={CODE}&state=wrong HTTP/1.1\r\n\r\n"),
            format!("GET /callback?code={CODE} HTTP/1.1\r\n\r\n"),
            format!("GET /callback?state={STATE} HTTP/1.1\r\n\r\n"),
            format!("POST /callback?code={CODE}&state={STATE} HTTP/1.1\r\n\r\n"),
            format!("GET /other?code={CODE}&state={STATE} HTTP/1.1\r\n\r\n"),
            format!("GET /callback/x?code={CODE}&state={STATE} HTTP/1.1\r\n\r\n"),
            format!("GET /callback?code=short&state={STATE} HTTP/1.1\r\n\r\n"),
            format!("GET /callback?code={CODE}&code={CODE}&state={STATE} HTTP/1.1\r\n\r\n"),
            format!("GET /callback?code={CODE}&state={STATE}&state=other HTTP/1.1\r\n\r\n"),
            "garbage".to_string(),
            String::new(),
        ] {
            assert_eq!(parse_callback(&head, STATE), None, "{head:?}");
        }
    }

    fn send(addr: SocketAddr, request: &str) -> String {
        let mut stream = TcpStream::connect(addr).unwrap();
        let _ = stream.write_all(request.as_bytes());
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        response
    }

    #[test]
    fn keeps_waiting_through_probes_and_returns_the_real_callback() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let waiter = {
            let cancel = cancel.clone();
            std::thread::spawn(move || {
                wait_for_code(&listener, STATE, Instant::now() + Duration::from_secs(10), &cancel)
            })
        };

        let probe = send(addr, &format!("GET /callback?code={CODE}&state=x HTTP/1.1\r\n\r\n"));
        assert!(probe.starts_with("HTTP/1.1 404"));
        let real = send(addr, &format!("GET /callback?code={CODE}&state={STATE} HTTP/1.1\r\n\r\n"));
        assert!(real.starts_with("HTTP/1.1 200"));
        assert!(real.contains("Content-Security-Policy: default-src 'none'"));
        assert!(!real.contains(CODE), "the page must not reflect request data");

        assert_eq!(waiter.join().unwrap(), Ok(CODE.to_string()));
    }

    #[test]
    fn drops_an_oversized_request_and_stops_on_cancel_or_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let waiter = {
            let cancel = cancel.clone();
            std::thread::spawn(move || {
                wait_for_code(&listener, STATE, Instant::now() + Duration::from_secs(10), &cancel)
            })
        };
        let huge = format!("GET /callback?code={CODE}&state={STATE}&pad={} HTTP/1.1\r\n\r\n", "a".repeat(MAX_REQUEST_BYTES));
        // The listener stops reading at the cap and closes, so the client may
        // see a 404 or a reset; it must never see a 200.
        assert!(!send(addr, &huge).starts_with("HTTP/1.1 200"));
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(waiter.join().unwrap(), Err(WaitError::Cancelled));

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let never = AtomicBool::new(false);
        assert_eq!(wait_for_code(&listener, STATE, Instant::now(), &never), Err(WaitError::TimedOut));
    }

    #[test]
    fn holds_a_live_flow_through_the_cooldown_but_not_a_failed_one() {
        let t0 = Instant::now();
        let mut flows = FlowRegistry::default();
        let first = flows.begin(t0).unwrap();
        flows.opened(t0);
        assert_eq!(flows.begin(t0 + Duration::from_secs(1)).err(), Some("already_running"));

        flows.fail(&first);
        let retry = flows.begin(t0 + Duration::from_secs(1)).expect("a failed flow must not block a retry");
        assert!(first.load(Ordering::SeqCst) || flows.check(&first).is_err());

        flows.opened(t0 + Duration::from_secs(1));
        let replacement = flows.begin(t0 + Duration::from_secs(10)).expect("after the cooldown a new click restarts");
        assert!(retry.load(Ordering::SeqCst), "the replaced flow is cancelled");
        assert_eq!(flows.check(&retry), Err("cancelled"));
        assert_eq!(flows.check(&replacement), Ok(()));
    }

    #[test]
    fn keeps_a_ticket_only_for_the_current_flow_and_only_briefly() {
        let t0 = Instant::now();
        let mut flows = FlowRegistry::default();
        let stale = flows.begin(t0).unwrap();
        let current = flows.begin(t0).unwrap();
        assert_eq!(flows.store_ticket(&stale, "h".into(), "t-stale".into(), t0), Err("cancelled"));
        assert_eq!(flows.store_ticket(&current, "h".into(), "t".into(), t0), Ok(()));
        assert_eq!(flows.take_ticket(t0), Some(("h".to_string(), "t".to_string())));
        assert_eq!(flows.take_ticket(t0), None, "single use");

        let next = flows.begin(t0).unwrap();
        flows.store_ticket(&next, "h".into(), "t2".into(), t0).unwrap();
        assert_eq!(flows.take_ticket(t0 + PENDING_TICKET_MAX_AGE), None, "expired");

        let cancelled = flows.begin(t0).unwrap();
        flows.store_ticket(&cancelled, "h".into(), "t3".into(), t0).unwrap();
        flows.cancel();
        assert_eq!(flows.take_ticket(t0), None, "cancel drops a pending ticket");
    }

    #[test]
    fn delivers_the_ticket_only_to_the_production_frontend_api() {
        assert!(is_ticket_host("clerk.worldmonitor.app"));
        assert!(!is_ticket_host("attacker.clerk.accounts.dev"));
        assert!(!is_ticket_host("evil.com"));
    }

    #[test]
    fn a_dripping_connection_cannot_hold_the_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let waiter = {
            let cancel = cancel.clone();
            std::thread::spawn(move || {
                wait_for_code(&listener, STATE, Instant::now() + Duration::from_secs(20), &cancel)
            })
        };
        // A peer that sends one byte every 200 ms never finishes its header.
        let dripper = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(addr).unwrap();
            for _ in 0..40 {
                if stream.write_all(b"G").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        });
        std::thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        let real = send(addr, &format!("GET /callback?code={CODE}&state={STATE} HTTP/1.1\r\n\r\n"));
        assert!(real.starts_with("HTTP/1.1 200"), "the real callback is served");
        assert!(started.elapsed() < Duration::from_secs(4), "within the per-connection budget");
        assert_eq!(waiter.join().unwrap(), Ok(CODE.to_string()));
        let _ = dripper.join();
    }

    #[test]
    fn adopts_the_redeemed_client_only_when_clerk_accepted_the_ticket() {
        let complete = SignInOutcome { status: "complete".into(), created_session_id: Some("s".into()), identifier: None };
        let second = SignInOutcome { status: "needs_second_factor".into(), created_session_id: None, identifier: None };
        assert!(adopt_redeemed_client(200, Some(&complete), Some("new-token")));
        assert!(adopt_redeemed_client(200, Some(&second), Some("new-token")), "the in-app card continues on this client");
        assert!(!adopt_redeemed_client(422, Some(&complete), Some("new-token")), "a refused ticket keeps the old session");
        assert!(!adopt_redeemed_client(200, None, Some("new-token")), "an unreadable response keeps the old session");
        assert!(!adopt_redeemed_client(200, Some(&complete), None), "no token to adopt keeps the old session");
        assert!(!adopt_redeemed_client(200, Some(&complete), Some("  ")));

        // A "complete" sign-in with no session would end the old session and
        // leave the renderer nothing to activate.
        for missing in [None, Some("".to_string()), Some("  ".to_string())] {
            let sessionless = SignInOutcome { status: "complete".into(), created_session_id: missing, identifier: None };
            assert!(!adopt_redeemed_client(200, Some(&sessionless), Some("new-token")));
        }
    }

    #[test]
    fn reads_only_status_session_and_identifier_from_clerk() {
        let body = r#"{"response":{"object":"sign_in_attempt","status":"complete","created_session_id":"sess_1","identifier":"a@b.c","user_data":{"x":1}},"client":{"sessions":[]}}"#;
        assert_eq!(
            parse_sign_in_response(body).unwrap(),
            SignInOutcome {
                status: "complete".into(),
                created_session_id: Some("sess_1".into()),
                identifier: Some("a@b.c".into()),
            }
        );
        let second_factor = r#"{"response":{"status":"needs_second_factor","created_session_id":null}}"#;
        assert_eq!(parse_sign_in_response(second_factor).unwrap().status, "needs_second_factor");
        assert!(parse_sign_in_response("{}").is_err());
        assert!(parse_sign_in_response("nope").is_err());
    }
}
