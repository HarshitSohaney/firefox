use serde_json::json;

pub struct ReceiverHandler {
    request_id_counter: u32,
}

impl ReceiverHandler {
    pub const NAMESPACE: &'static str = "urn:x-cast:com.google.cast.receiver";

    pub fn new() -> Self {
        ReceiverHandler {
            request_id_counter: 0,
        }
    }

    pub fn create_get_status(&mut self) -> String {
        self.request_id_counter += 1;
        json!({
            "type": "GET_STATUS",
            "requestId": self.request_id_counter
        })
        .to_string()
    }

    pub fn create_launch(&mut self, app_id: &str) -> String {
        self.request_id_counter += 1;
        json!({
            "type": "LAUNCH",
            "requestId": self.request_id_counter,
            "appId": app_id
        })
        .to_string()
    }

    pub fn create_stop(&mut self, session_id: &str) -> String {
        self.request_id_counter += 1;
        json!({
            "type": "STOP",
            "requestId": self.request_id_counter,
            "sessionId": session_id
        })
        .to_string()
    }
}
