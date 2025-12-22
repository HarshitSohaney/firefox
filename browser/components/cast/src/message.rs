/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use prost::Message;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
pub enum PayloadType {
    String = 0,
    Binary = 1,
}

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

    pub fn encode_to_vec(&self) -> Result<Vec<u8>, prost::EncodeError> {
        let mut buf = Vec::new();
        self.encode(&mut buf)?;
        Ok(buf)
    }

    pub fn decode_from_slice(buf: &[u8]) -> Result<Self, prost::DecodeError> {
        CastMessage::decode(buf)
    }
}
