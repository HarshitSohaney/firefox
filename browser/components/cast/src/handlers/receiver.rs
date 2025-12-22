/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::constants::{namespaces, DEFAULT_MEDIA_RECEIVER_APP_ID};
use crate::messages::ReceiverMessage;
use std::sync::atomic::{AtomicU32, Ordering};

pub struct ReceiverHandler {
    request_id_counter: AtomicU32,
}

impl ReceiverHandler {
    pub const NAMESPACE: &'static str = namespaces::RECEIVER;

    pub fn new() -> Self {
        ReceiverHandler {
            request_id_counter: AtomicU32::new(0),
        }
    }

    fn next_request_id(&self) -> u32 {
        self.request_id_counter.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn create_get_status(&self) -> String {
        serde_json::to_string(&ReceiverMessage::GET_STATUS {
            request_id: self.next_request_id(),
        })
        .unwrap()
    }

    pub fn create_launch(&self, app_id: Option<&str>) -> String {
        serde_json::to_string(&ReceiverMessage::LAUNCH {
            request_id: self.next_request_id(),
            app_id: app_id.unwrap_or(DEFAULT_MEDIA_RECEIVER_APP_ID).to_string(),
        })
        .unwrap()
    }

    pub fn create_stop(&self, session_id: &str) -> String {
        serde_json::to_string(&ReceiverMessage::STOP {
            request_id: self.next_request_id(),
            session_id: session_id.to_string(),
        })
        .unwrap()
    }
}

impl Default for ReceiverHandler {
    fn default() -> Self {
        Self::new()
    }
}
