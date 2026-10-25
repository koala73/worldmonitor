//! Clerk Frontend API relay for the desktop renderer.
//!
//! Clerk's production Frontend API rejects requests whose `Origin` is the
//! desktop WebView (`tauri://localhost` on macOS, `http(s)://tauri.localhost`
//! on Windows) with `400 origin_invalid`, and a WebView cannot drop that
//! header. Requests sent from here carry no `Origin`, use Clerk's native mode
//! (`_is_native=1` plus an `Authorization` client token instead of cookies),
//! and keep that client token on the Rust side so renderer script never reads
//! it (#9396).

use reqwest::Url;
use serde::{Deserialize, Serialize};

pub const PRODUCTION_FAPI_HOST: &str = "clerk.worldmonitor.app";
/// Development instances, matching the desktop CSP's script-src entry.
const DEVELOPMENT_FAPI_HOST_SUFFIX: &str = ".clerk.accounts.dev";
pub const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_RESPONSE_BODY_BYTES: usize = 8 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES: [&str; 2] = ["application/x-www-form-urlencoded", "application/json"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClerkFapiRequest {
    pub host: String,
    pub method: String,
    /// Path plus query, e.g. `/v1/client?_clerk_js_version=6.25.6`.
    pub path: String,
    pub content_type: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClerkFapiResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: String,
}

/// The client token Clerk issued for one Frontend API host. It is only ever
/// sent back to the host that issued it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClerkClientToken {
    pub host: String,
    pub token: String,
}

pub struct ValidatedRequest {
    pub method: reqwest::Method,
    pub url: Url,
    pub content_type: Option<String>,
    pub body: Option<String>,
}

pub fn is_allowed_fapi_host(host: &str) -> bool {
    if host == PRODUCTION_FAPI_HOST {
        return true;
    }
    match host.strip_suffix(DEVELOPMENT_FAPI_HOST_SUFFIX) {
        Some(label) => {
            !label.is_empty()
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        }
        None => false,
    }
}

pub fn validate_request(request: ClerkFapiRequest) -> Result<ValidatedRequest, String> {
    let host = request.host.trim().to_ascii_lowercase();
    if !is_allowed_fapi_host(&host) {
        return Err(format!("Clerk relay refuses host '{host}'"));
    }

    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        other => return Err(format!("Clerk relay refuses method '{other}'")),
    };

    if !request.path.starts_with("/v1/") {
        return Err("Clerk relay only forwards /v1/ paths".to_string());
    }
    let mut url = Url::parse(&format!("https://{host}{}", request.path))
        .map_err(|_| "Invalid Clerk relay path".to_string())?;
    // Parsing normalizes dot segments and could reinterpret an authority, so
    // re-check the result rather than trusting the raw string.
    if url.scheme() != "https"
        || url.host_str() != Some(host.as_str())
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.path().starts_with("/v1/")
    {
        return Err("Clerk relay path escapes the Frontend API".to_string());
    }
    url.set_fragment(None);
    let query: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| key != "_is_native")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.query_pairs_mut()
        .clear()
        .extend_pairs(query)
        .append_pair("_is_native", "1");

    let content_type = match request.content_type {
        Some(value) => {
            let essence = value.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            if !ALLOWED_CONTENT_TYPES.contains(&essence.as_str()) {
                return Err(format!("Clerk relay refuses content type '{essence}'"));
            }
            Some(value)
        }
        None => None,
    };

    if request.body.is_some() && content_type.is_none() {
        return Err("Clerk relay refuses a body without a content type".to_string());
    }
    if method == reqwest::Method::GET && request.body.is_some() {
        return Err("Clerk relay refuses a GET body".to_string());
    }
    if request.body.as_ref().is_some_and(|body| body.len() > MAX_REQUEST_BODY_BYTES) {
        return Err("Clerk relay request body exceeds the limit".to_string());
    }

    Ok(ValidatedRequest {
        method,
        url,
        content_type,
        body: request.body,
    })
}

/// Appends one response chunk, refusing it when the body would cross `max`,
/// so an oversized response is rejected before it is buffered.
pub fn append_capped(body: &mut Vec<u8>, chunk: &[u8], max: usize) -> Result<(), String> {
    if body.len() + chunk.len() > max {
        return Err("Clerk response exceeds the relay limit".to_string());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

/// The stored token to attach for `host`, if it was issued by that host.
pub fn token_for_host<'a>(stored: Option<&'a ClerkClientToken>, host: &str) -> Option<&'a str> {
    stored
        .filter(|entry| entry.host == host)
        .map(|entry| entry.token.as_str())
}

/// Clerk returns the client token in the `Authorization` response header on
/// every native-mode response, rotated after sign-in and sign-out. Returns the
/// value to store when it differs from what is stored.
pub fn next_stored_token(
    stored: Option<&ClerkClientToken>,
    host: &str,
    response_authorization: Option<&str>,
) -> Option<ClerkClientToken> {
    let token = response_authorization?.trim();
    if token.is_empty() {
        return None;
    }
    let next = ClerkClientToken {
        host: host.to_string(),
        token: token.to_string(),
    };
    if stored == Some(&next) {
        None
    } else {
        Some(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(host: &str, method: &str, path: &str) -> ClerkFapiRequest {
        ClerkFapiRequest {
            host: host.to_string(),
            method: method.to_string(),
            path: path.to_string(),
            content_type: None,
            body: None,
        }
    }

    #[test]
    fn allows_the_production_host_and_development_instances_only() {
        assert!(is_allowed_fapi_host("clerk.worldmonitor.app"));
        assert!(is_allowed_fapi_host("happy-otter-12.clerk.accounts.dev"));
        assert!(!is_allowed_fapi_host("worldmonitor.app"));
        assert!(!is_allowed_fapi_host("clerk.worldmonitor.app.evil.com"));
        assert!(!is_allowed_fapi_host("evil.com"));
        assert!(!is_allowed_fapi_host(".clerk.accounts.dev"));
        assert!(!is_allowed_fapi_host("a.b.clerk.accounts.dev"));
        assert!(!is_allowed_fapi_host("api.clerk.com"));
    }

    #[test]
    fn forwards_a_v1_path_in_native_mode() {
        let validated = validate_request(request(
            "clerk.worldmonitor.app",
            "get",
            "/v1/client?_clerk_js_version=6.25.6&__clerk_api_version=2026-05-12",
        ))
        .expect("valid request");
        assert_eq!(validated.method, reqwest::Method::GET);
        assert_eq!(
            validated.url.as_str(),
            "https://clerk.worldmonitor.app/v1/client?_clerk_js_version=6.25.6&__clerk_api_version=2026-05-12&_is_native=1"
        );
    }

    #[test]
    fn replaces_a_caller_supplied_native_flag() {
        let validated = validate_request(request(
            "clerk.worldmonitor.app",
            "POST",
            "/v1/client/sign_ins?_is_native=0",
        ))
        .expect("valid request");
        assert_eq!(validated.url.query(), Some("_is_native=1"));
    }

    #[test]
    fn rejects_paths_outside_the_frontend_api() {
        for path in [
            "/v2/client",
            "/v1/../admin",
            "/v1/%2e%2e/admin",
            "@evil.com/v1/client",
            "//evil.com/v1/client",
            "/v1",
            "v1/client",
        ] {
            assert!(
                validate_request(request("clerk.worldmonitor.app", "GET", path)).is_err(),
                "{path} must be rejected"
            );
        }
    }

    #[test]
    fn rejects_hosts_methods_and_bodies_outside_the_contract() {
        assert!(validate_request(request("evil.com", "GET", "/v1/client")).is_err());
        assert!(validate_request(request("clerk.worldmonitor.app:8443", "GET", "/v1/client")).is_err());
        assert!(validate_request(request("clerk.worldmonitor.app", "DELETE", "/v1/client")).is_err());

        let mut with_get_body = request("clerk.worldmonitor.app", "GET", "/v1/client");
        with_get_body.body = Some("a=b".to_string());
        assert!(validate_request(with_get_body).is_err());

        let mut oversized = request("clerk.worldmonitor.app", "POST", "/v1/client/sign_ins");
        oversized.body = Some("x".repeat(MAX_REQUEST_BODY_BYTES + 1));
        assert!(validate_request(oversized).is_err());

        let mut multipart = request("clerk.worldmonitor.app", "POST", "/v1/me/profile_image");
        multipart.content_type = Some("multipart/form-data; boundary=x".to_string());
        assert!(validate_request(multipart).is_err());

        let mut form = request("clerk.worldmonitor.app", "POST", "/v1/client/sign_ins");
        form.content_type = Some("application/x-www-form-urlencoded; charset=UTF-8".to_string());
        form.body = Some("identifier=a%40b.c".to_string());
        assert!(validate_request(form).is_ok());
    }

    #[test]
    fn refuses_a_body_without_an_allowed_content_type() {
        let mut untyped = request("clerk.worldmonitor.app", "POST", "/v1/client/sign_ins");
        untyped.body = Some("identifier=a%40b.c".to_string());
        assert!(validate_request(untyped).is_err());

        let bodiless = request("clerk.worldmonitor.app", "POST", "/v1/client/sessions/sess_1/touch");
        assert!(validate_request(bodiless).is_ok());
    }

    #[test]
    fn stops_reading_a_response_once_it_crosses_the_cap() {
        let mut body = Vec::new();
        assert!(append_capped(&mut body, &[1; 6], 10).is_ok());
        assert!(append_capped(&mut body, &[1; 4], 10).is_ok());
        assert!(append_capped(&mut body, &[1; 1], 10).is_err());
        assert_eq!(body.len(), 10, "the over-limit chunk is not buffered");
    }

    #[test]
    fn attaches_a_stored_token_only_to_the_host_that_issued_it() {
        let stored = ClerkClientToken {
            host: "clerk.worldmonitor.app".to_string(),
            token: "client-jwt".to_string(),
        };
        assert_eq!(token_for_host(Some(&stored), "clerk.worldmonitor.app"), Some("client-jwt"));
        assert_eq!(token_for_host(Some(&stored), "happy-otter-12.clerk.accounts.dev"), None);
        assert_eq!(token_for_host(None, "clerk.worldmonitor.app"), None);
    }

    #[test]
    fn stores_a_new_or_rotated_token_and_ignores_empty_or_unchanged_ones() {
        let host = "clerk.worldmonitor.app";
        let stored = ClerkClientToken { host: host.to_string(), token: "old".to_string() };

        assert_eq!(
            next_stored_token(None, host, Some("first")),
            Some(ClerkClientToken { host: host.to_string(), token: "first".to_string() })
        );
        assert_eq!(
            next_stored_token(Some(&stored), host, Some("rotated")),
            Some(ClerkClientToken { host: host.to_string(), token: "rotated".to_string() })
        );
        assert_eq!(next_stored_token(Some(&stored), host, Some("old")), None);
        assert_eq!(next_stored_token(Some(&stored), host, Some("  ")), None);
        assert_eq!(next_stored_token(Some(&stored), host, None), None);
    }
}
