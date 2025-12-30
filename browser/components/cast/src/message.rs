/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Cast Protocol v2 message definitions.
//!
//! The Cast protocol uses Protocol Buffers for message serialization.
//! Messages are framed with a 4-byte big-endian length prefix when sent over TCP.
//!
//! Wire format:
//! ```text
//! [4 bytes: message length (big-endian u32)]
//! [N bytes: protobuf-encoded CastMessage]
//! ```
//!
//! The CastMessage protobuf contains:
//! - protocol_version: Always 0 for Cast v2
//! - source_id: Sender identifier (e.g., "sender-0")
//! - destination_id: Receiver identifier (e.g., "receiver-0" or app transport ID)
//! - namespace: Protocol namespace (e.g., "urn:x-cast:com.google.cast.tp.connection")
//! - payload_type: String (0) or Binary (1)
//! - payload_utf8: JSON string payload for String type
//! - payload_binary: Raw bytes for Binary type

use prost::Message;

/// Payload type enum for Cast messages.
/// String payloads contain JSON, binary payloads contain raw data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
pub enum PayloadType {
    String = 0,
    Binary = 1,
}

/// Cast Protocol v2 message structure.
/// This matches the cast_channel.proto definition used by Chrome and Cast devices.
#[derive(Clone, PartialEq, Message)]
pub struct CastMessage {
    #[prost(enumeration = "i32", required, tag = "1")]
    pub protocol_version: i32,
    #[prost(string, required, tag = "2")]
    pub source_id: String,
    #[prost(string, required, tag = "3")]
    pub destination_id: String,
    #[prost(string, required, tag = "4")]
    pub namespace: String,
    #[prost(enumeration = "i32", required, tag = "5")]
    pub payload_type: i32,
    #[prost(string, optional, tag = "6")]
    pub payload_utf8: Option<String>,
    #[prost(bytes, optional, tag = "7")]
    pub payload_binary: Option<Vec<u8>>,
}

impl CastMessage {
    /// Create a new Cast message with JSON payload.
    /// Most Cast protocol messages use JSON payloads in standard namespaces:
    /// - urn:x-cast:com.google.cast.tp.connection (CONNECT, CLOSE)
    /// - urn:x-cast:com.google.cast.tp.heartbeat (PING, PONG)
    /// - urn:x-cast:com.google.cast.receiver (LAUNCH, STOP, GET_STATUS, RECEIVER_STATUS)
    /// - urn:x-cast:com.google.cast.media (LOAD, PLAY, PAUSE, STOP, MEDIA_STATUS)
    pub fn new(
        source_id: String,
        destination_id: String,
        namespace: String,
        payload_json: String,
    ) -> Self {
        CastMessage {
            protocol_version: 0,
            source_id,
            destination_id,
            namespace,
            payload_type: PayloadType::String as i32,
            payload_utf8: Some(payload_json),
            payload_binary: None,
        }
    }

    /// Encode message to protobuf bytes (without length prefix).
    /// Use this for preparing the message body that will be framed with a 4-byte length.
    pub fn encode_to_vec(&self) -> Result<Vec<u8>, prost::EncodeError> {
        let mut buf = Vec::new();
        self.encode(&mut buf)?;
        Ok(buf)
    }

    /// Decode message from protobuf bytes (without length prefix).
    /// This expects just the protobuf message body, not the framed format.
    pub fn decode_from_slice(buf: &[u8]) -> Result<Self, prost::DecodeError> {
        CastMessage::decode(buf)
    }
}
