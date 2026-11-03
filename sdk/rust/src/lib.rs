#![doc = include_str!("../README.md")]
#![warn(missing_docs)]

use reqwest::blocking::{Client as HttpClient, RequestBuilder};
use reqwest::header::{HeaderValue, ACCEPT, CONTENT_TYPE};
use reqwest::Url;
use serde_json::{json, Value};
use std::{env, error, fmt, time::Duration};

/// The crate version, also used in the User-Agent.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Identifies the SDK to the World Monitor API edge.
pub const USER_AGENT: &str = concat!(
    "worldmonitor-rust/",
    env!("CARGO_PKG_VERSION"),
    " (+https://worldmonitor.app)"
);

/// Connection settings. `Default` is anonymous and does not read the environment.
pub struct Config {
    /// Optional subscription API key. Never included in Debug output.
    pub api_key: Option<String>,
    /// REST origin, without a path, query, or fragment.
    pub base_url: String,
    /// MCP endpoint, including its path.
    pub mcp_url: String,
    /// Deadline for each complete HTTP request.
    pub timeout: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            api_key: None,
            base_url: "https://api.worldmonitor.app".into(),
            mcp_url: "https://worldmonitor.app/mcp".into(),
            timeout: Duration::from_secs(30),
        }
    }
}

impl Config {
    /// Reads WORLDMONITOR_API_KEY (then WM_API_KEY), WORLDMONITOR_BASE_URL,
    /// and WORLDMONITOR_MCP_URL. Empty values use the defaults.
    pub fn from_env() -> Self {
        fn value(name: &str) -> Option<String> {
            env::var(name).ok().filter(|value| !value.is_empty())
        }
        Self {
            api_key: value("WORLDMONITOR_API_KEY").or_else(|| value("WM_API_KEY")),
            base_url: value("WORLDMONITOR_BASE_URL").unwrap_or_else(|| Self::default().base_url),
            mcp_url: value("WORLDMONITOR_MCP_URL").unwrap_or_else(|| Self::default().mcp_url),
            ..Self::default()
        }
    }
}

/// A request or configuration failure.
#[derive(Debug)]
pub enum Error {
    /// Invalid configuration or tool arguments.
    InvalidInput(&'static str),
    /// HTTP failure without a valid MCP error envelope.
    Http {
        /// HTTP status code.
        status: u16,
        /// Response body, for caller inspection.
        body: String,
    },
    /// JSON-RPC error. Authentication uses code -32001.
    Mcp {
        /// JSON-RPC error code.
        code: i64,
        /// Server error message.
        message: String,
        /// Optional server error details.
        data: Value,
    },
    /// Network, TLS, or timeout failure.
    Transport(reqwest::Error),
    /// Response is not valid JSON.
    Json(serde_json::Error),
    /// Response is not a matching JSON-RPC envelope.
    Protocol(&'static str),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(message) | Self::Protocol(message) => {
                write!(f, "worldmonitor: {message}")
            }
            Self::Http { status, .. } => write!(f, "worldmonitor: HTTP {status}"),
            Self::Mcp { code, message, .. } => {
                write!(f, "worldmonitor: MCP {code}: {message}")?;
                if *code == -32001 {
                    write!(
                        f,
                        " (set WORLDMONITOR_API_KEY; get a key at https://worldmonitor.app/pro)"
                    )?;
                }
                Ok(())
            }
            Self::Transport(error) => write!(f, "worldmonitor: {error}"),
            Self::Json(error) => write!(f, "worldmonitor: {error}"),
        }
    }
}

impl error::Error for Error {
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        match self {
            Self::Transport(error) => Some(error),
            Self::Json(error) => Some(error),
            _ => None,
        }
    }
}

impl From<reqwest::Error> for Error {
    fn from(error: reqwest::Error) -> Self {
        Self::Transport(error.without_url())
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

/// A blocking MCP and REST client. Use outside an async runtime.
pub struct Client {
    http: HttpClient,
    api_key: Option<HeaderValue>,
    base_url: Url,
    mcp_url: Url,
}

impl Client {
    /// Creates a client with explicit settings.
    pub fn new(config: Config) -> Result<Self, Error> {
        let base_url = endpoint(&config.base_url)?;
        let mcp_url = endpoint(&config.mcp_url)?;
        if base_url.path() != "/" {
            return Err(Error::InvalidInput(
                "base_url must be an origin without a path",
            ));
        }
        if config.timeout.is_zero() {
            return Err(Error::InvalidInput("timeout must be greater than zero"));
        }
        let api_key = config
            .api_key
            .filter(|key| !key.is_empty())
            .map(|key| {
                let mut header = HeaderValue::from_str(&key)
                    .map_err(|_| Error::InvalidInput("invalid API key header"))?;
                header.set_sensitive(true);
                Ok::<_, Error>(header)
            })
            .transpose()?;
        Ok(Self {
            http: HttpClient::builder()
                .timeout(config.timeout)
                .redirect(reqwest::redirect::Policy::none())
                .user_agent(USER_AGENT)
                .build()?,
            api_key,
            base_url,
            mcp_url,
        })
    }

    /// Creates a client from the documented environment variables.
    pub fn from_env() -> Result<Self, Error> {
        Self::new(Config::from_env())
    }

    /// Calls any MCP tool. Arguments must be a JSON object.
    /// Returns the JSON-RPC result, including MCP content and isError fields.
    pub fn call_tool(&self, name: &str, arguments: Value) -> Result<Value, Error> {
        if !arguments.is_object() {
            return Err(Error::InvalidInput("tool arguments must be a JSON object"));
        }
        self.rpc(
            "tools/call",
            Some(json!({"name": name, "arguments": arguments})),
        )
    }

    /// Lists MCP tools. No API key is required.
    pub fn list_tools(&self) -> Result<Value, Error> {
        self.rpc("tools/list", None)
    }

    /// Lists public MCP prompt templates.
    pub fn list_prompts(&self) -> Result<Value, Error> {
        self.rpc("prompts/list", None)
    }

    /// Lists public MCP resources.
    pub fn list_resources(&self) -> Result<Value, Error> {
        self.rpc("resources/list", None)
    }

    /// Fetches JSON from a host-relative REST path with encoded query parameters.
    pub fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value, Error> {
        if !path.starts_with('/') || path.starts_with("//") || path.contains(['\\', '?', '#']) {
            return Err(Error::InvalidInput(
                "use a host-relative path and separate query parameters",
            ));
        }
        let url = self
            .base_url
            .join(path)
            .map_err(|_| Error::InvalidInput("invalid REST path"))?;
        if url.origin() != self.base_url.origin() {
            return Err(Error::InvalidInput(
                "REST path must keep the configured origin",
            ));
        }
        let request = self
            .http
            .get(url)
            .header(ACCEPT, "application/json")
            .query(query);
        let (status, _, body) = self.response(request)?;
        if !(200..300).contains(&status) {
            return Err(Error::Http { status, body });
        }
        Ok(serde_json::from_str(&body)?)
    }

    /// Returns the REST API health response.
    pub fn health(&self) -> Result<Value, Error> {
        self.get("/api/health", &[])
    }

    /// Returns country risk data for an ISO alpha-2 country code.
    pub fn country_risk(&self, country_code: &str) -> Result<Value, Error> {
        self.call_tool("get_country_risk", json!({"country_code": country_code}))
    }

    fn rpc(&self, method: &str, params: Option<Value>) -> Result<Value, Error> {
        let mut envelope = json!({"jsonrpc": "2.0", "id": 1, "method": method});
        if let Some(params) = params {
            envelope["params"] = params;
        }
        let request = self
            .http
            .post(self.mcp_url.clone())
            .header(ACCEPT, "application/json, text/event-stream")
            .json(&envelope);
        let (status, content_type, body) = self.response(request)?;
        let payload = if content_type.split(';').next() == Some("text/event-stream") {
            sse_payload(&body).unwrap_or_else(|| body.clone())
        } else {
            body.clone()
        };
        let parsed = serde_json::from_str::<Value>(&payload);
        if let Ok(value) = &parsed {
            if let Some(error) = value.get("error") {
                if let (Some(code), Some(message)) =
                    (error["code"].as_i64(), error["message"].as_str())
                {
                    return Err(Error::Mcp {
                        code,
                        message: message.to_owned(),
                        data: error.get("data").cloned().unwrap_or(Value::Null),
                    });
                }
            }
        }
        if !(200..300).contains(&status) {
            return Err(Error::Http { status, body });
        }
        let value = parsed?;
        if value["jsonrpc"] != "2.0" || value["id"] != 1 || value.get("error").is_some() {
            return Err(Error::Protocol("invalid or mismatched JSON-RPC response"));
        }
        value
            .get("result")
            .cloned()
            .ok_or(Error::Protocol("missing JSON-RPC result"))
    }

    fn response(&self, mut request: RequestBuilder) -> Result<(u16, String, String), Error> {
        if let Some(key) = &self.api_key {
            request = request.header("X-WorldMonitor-Key", key);
        }
        let response = request.send()?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_owned();
        Ok((status, content_type, response.text()?))
    }
}

fn endpoint(value: &str) -> Result<Url, Error> {
    let url = Url::parse(value).map_err(|_| Error::InvalidInput("invalid endpoint URL"))?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::InvalidInput(
            "endpoints require HTTP(S), a host, and no credentials, query, or fragment",
        ));
    }
    Ok(url)
}

fn sse_payload(body: &str) -> Option<String> {
    let normalized = body.replace("\r\n", "\n");
    for event in normalized.rsplit("\n\n") {
        let data = event
            .lines()
            .filter_map(|line| {
                line.strip_prefix("data:")
                    .map(|value| value.strip_prefix(' ').unwrap_or(value))
            })
            .collect::<Vec<_>>()
            .join("\n");
        if let Ok(value) = serde_json::from_str::<Value>(&data) {
            if value.get("result").is_some() || value.get("error").is_some() {
                return Some(data);
            }
        }
    }
    None
}
