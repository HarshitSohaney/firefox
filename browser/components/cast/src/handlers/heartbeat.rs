use serde_json::json;

pub struct HeartbeatHandler;

impl HeartbeatHandler {
    pub const NAMESPACE: &'static str = "urn:x-cast:com.google.cast.tp.heartbeat";

    pub fn create_ping() -> String {
        json!({"type": "PING"}).to_string()
    }

    pub fn create_pong() -> String {
        json!({"type": "PONG"}).to_string()
    }

    pub fn handle_message(payload: &str) -> Option<String> {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(payload) {
            if parsed["type"] == "PING" {
                return Some(Self::create_pong());
            }
        }
        None
    }
}
