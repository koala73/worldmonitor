use serde_json::json;
use worldmonitor::Client;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::from_env()?;
    let result = client.call_tool("get_sources", json!({"view": "summary"}))?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
