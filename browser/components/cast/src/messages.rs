/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum HeartbeatMessage {
    PING,
    PONG,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ConnectionMessage {
    CONNECT,
    CLOSE,
    CONNECTED,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ReceiverMessage {
    GET_STATUS {
        #[serde(rename = "requestId")]
        request_id: u32,
    },
    RECEIVER_STATUS {
        #[serde(rename = "requestId")]
        request_id: Option<u32>,
        status: ReceiverStatus,
    },
    LAUNCH {
        #[serde(rename = "requestId")]
        request_id: u32,
        #[serde(rename = "appId")]
        app_id: String,
    },
    LAUNCH_ERROR {
        #[serde(rename = "requestId")]
        request_id: u32,
        reason: Option<String>,
    },
    STOP {
        #[serde(rename = "requestId")]
        request_id: u32,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReceiverStatus {
    #[serde(default)]
    pub applications: Vec<Application>,
    #[serde(default)]
    pub volume: Option<Volume>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Application {
    #[serde(rename = "appId")]
    pub app_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "transportId")]
    pub transport_id: String,
    #[serde(rename = "displayName", default)]
    pub display_name: Option<String>,
    #[serde(rename = "senderConnected", default)]
    pub sender_connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Volume {
    pub level: Option<f32>,
    pub muted: Option<bool>,
}
