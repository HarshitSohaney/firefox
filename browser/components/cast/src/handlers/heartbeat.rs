/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::constants::namespaces;
use crate::messages::HeartbeatMessage;

pub struct HeartbeatHandler;

impl HeartbeatHandler {
    pub const NAMESPACE: &'static str = namespaces::HEARTBEAT;

    pub fn create_ping() -> String {
        serde_json::to_string(&HeartbeatMessage::PING).expect("serializing HeartbeatMessage")
    }

    pub fn create_pong() -> String {
        serde_json::to_string(&HeartbeatMessage::PONG).expect("serializing HeartbeatMessage")
    }

    pub fn handle_message(payload: &str) -> Option<String> {
        match serde_json::from_str::<HeartbeatMessage>(payload) {
            Ok(HeartbeatMessage::PING) => Some(Self::create_pong()),
            _ => None,
        }
    }
}
