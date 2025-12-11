use serde_json::json;

pub struct ConnectionHandler;

impl ConnectionHandler {
    pub const NAMESPACE: &'static str = "urn:x-cast:com.google.cast.tp.connection";

    pub fn create_connect_message() -> String {
        json!({
            "type": "CONNECT",
            "origin": {},
            "userAgent": "Mozilla/5.0 (Firefox Cast Client)"
        })
        .to_string()
    }

    pub fn create_close_message() -> String {
        json!({"type": "CLOSE"}).to_string()
    }
}
