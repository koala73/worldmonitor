use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use worldmonitor::{Client, Config, Error, USER_AGENT};

fn server(status: u16, content_type: &str, body: &str) -> (String, JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let task = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut request = String::new();
        let mut length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            request.push_str(&line);
            if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse().unwrap();
            }
            if line == "\r\n" {
                break;
            }
            assert!(!line.is_empty(), "request ended before headers");
        }
        let mut payload = vec![0; length];
        reader.read_exact(&mut payload).unwrap();
        request.push_str(&String::from_utf8(payload).unwrap());
        stream.write_all(response.as_bytes()).unwrap();
        request
    });
    (address, task)
}

fn client(address: &str, key: Option<&str>) -> Client {
    Client::new(Config {
        base_url: address.into(),
        mcp_url: format!("{address}/mcp"),
        api_key: key.map(str::to_owned),
        ..Config::default()
    })
    .unwrap()
}

fn rpc_result(result: Value) -> String {
    json!({"jsonrpc": "2.0", "id": 1, "result": result}).to_string()
}

#[test]
fn public_discovery_sends_identity_without_credentials() {
    for method in ["tools/list", "prompts/list", "resources/list"] {
        let (url, request) = server(200, "application/json", &rpc_result(json!({"items": []})));
        let client = client(&url, None);
        let result = match method {
            "tools/list" => client.list_tools(),
            "prompts/list" => client.list_prompts(),
            _ => client.list_resources(),
        }
        .unwrap();
        assert_eq!(result, json!({"items": []}));
        let request = request.join().unwrap();
        assert!(request.starts_with("POST /mcp HTTP/1.1"));
        assert!(request.contains(USER_AGENT));
        assert!(!request.to_lowercase().contains("x-worldmonitor-key:"));
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body, json!({"jsonrpc": "2.0", "id": 1, "method": method}));
    }
}

#[test]
fn arbitrary_tool_calls_preserve_arguments_and_tool_error_results() {
    let expected = json!({"content": [{"type": "text", "text": "unavailable"}], "isError": true});
    let (url, request) = server(200, "application/json", &rpc_result(expected.clone()));
    let result = client(&url, Some("test-secret"))
        .call_tool(
            "get_market_data",
            json!({"asset_class": "crypto", "limit": 5, "jmespath": "items"}),
        )
        .unwrap();
    assert_eq!(result, expected);
    let request = request.join().unwrap();
    assert!(request
        .to_lowercase()
        .contains("x-worldmonitor-key: test-secret"));
    let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(
        body["params"],
        json!({"name": "get_market_data", "arguments": {"asset_class": "crypto", "limit": 5, "jmespath": "items"}})
    );
}

#[test]
fn country_risk_uses_the_server_parameter_name() {
    let (url, request) = server(200, "application/json", &rpc_result(Value::Null));
    assert_eq!(client(&url, None).country_risk("IR").unwrap(), Value::Null);
    let request = request.join().unwrap();
    let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(
        body["params"],
        json!({"name": "get_country_risk", "arguments": {"country_code": "IR"}})
    );
}

#[test]
fn rest_encodes_query_and_returns_json() {
    let (url, request) = server(200, "application/json", r#"{"ok":true}"#);
    assert_eq!(
        client(&url, None)
            .get("/api/health", &[("country", "A B&")])
            .unwrap(),
        json!({"ok": true})
    );
    assert!(request
        .join()
        .unwrap()
        .starts_with("GET /api/health?country=A+B%26 HTTP/1.1"));
}

#[test]
fn mcp_errors_take_priority_over_http_status() {
    for status in [200, 401] {
        let body = json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32001, "message": "Authentication required", "data": {"reason": "key"}}});
        let (url, request) = server(status, "application/json", &body.to_string());
        let error = client(&url, None).list_tools().unwrap_err();
        assert!(error.to_string().contains("WORLDMONITOR_API_KEY"));
        assert!(
            matches!(error, Error::Mcp { code: -32001, data, .. } if data == json!({"reason": "key"}))
        );
        request.join().unwrap();
    }
}

#[test]
fn http_errors_keep_status_and_body() {
    for mcp in [true, false] {
        let (url, request) = server(429, "text/plain", "slow down");
        let client = client(&url, None);
        let error = if mcp {
            client.list_tools()
        } else {
            client.health()
        }
        .unwrap_err();
        assert!(matches!(error, Error::Http { status: 429, body } if body == "slow down"));
        request.join().unwrap();
    }
}

#[test]
fn malformed_and_mismatched_responses_fail() {
    for body in [
        "not json",
        "{}",
        r#"{"jsonrpc":"2.0","id":99,"result":{}}"#,
        r#"{"jsonrpc":"2.0","id":1,"error":{}}"#,
    ] {
        let (url, request) = server(200, "application/json", body);
        assert!(matches!(
            client(&url, None).list_tools(),
            Err(Error::Json(_) | Error::Protocol(_))
        ));
        request.join().unwrap();
    }
}

#[test]
fn sse_supports_notifications_multiline_data_and_crlf() {
    let body = concat!("event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\r\n\r\n",
        "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\r\ndata: \"result\":{\"tools\":[]}}\r\n\r\n",
        ": keepalive\r\n\r\n");
    let (url, request) = server(200, "text/event-stream; charset=utf-8", body);
    assert_eq!(
        client(&url, None).list_tools().unwrap(),
        json!({"tools": []})
    );
    request.join().unwrap();
}

#[test]
fn rejects_invalid_configuration_and_arguments() {
    for endpoint in [
        "file:///etc/passwd",
        "https://user:pass@example.com",
        "https://example.com/?key=secret",
        "https://example.com/#x",
    ] {
        assert!(Client::new(Config {
            mcp_url: endpoint.into(),
            ..Config::default()
        })
        .is_err());
    }
    assert!(Client::new(Config {
        timeout: Duration::ZERO,
        ..Config::default()
    })
    .is_err());
    assert!(Client::new(Config {
        api_key: Some("key\r\ninjected: yes".into()),
        ..Config::default()
    })
    .is_err());
    let client = Client::new(Config::default()).unwrap();
    for path in [
        "https://example.com",
        "//example.com",
        "/\\example.com",
        "/api/health?key=x",
        "/api/health#x",
    ] {
        assert!(matches!(client.get(path, &[]), Err(Error::InvalidInput(_))));
    }
    for args in [Value::Null, json!([]), json!("bad")] {
        assert!(matches!(
            client.call_tool("get_sources", args),
            Err(Error::InvalidInput(_))
        ));
    }
}

#[test]
fn redirects_are_not_followed() {
    let destination = TcpListener::bind("127.0.0.1:0").unwrap();
    destination.set_nonblocking(true).unwrap();
    let content_type = format!(
        "text/plain\r\nLocation: http://{}/stolen",
        destination.local_addr().unwrap()
    );
    let (url, request) = server(302, &content_type, "redirect");
    assert!(matches!(
        client(&url, Some("test-secret")).health(),
        Err(Error::Http { status: 302, .. })
    ));
    request.join().unwrap();
    assert_eq!(
        destination.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn requests_obey_the_configured_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (_stream, _) = listener.accept().unwrap();
        thread::sleep(Duration::from_millis(200));
    });
    let client = Client::new(Config {
        base_url: address,
        timeout: Duration::from_millis(50),
        ..Config::default()
    })
    .unwrap();
    assert!(matches!(client.health(), Err(Error::Transport(error)) if error.is_timeout()));
    server.join().unwrap();
}
