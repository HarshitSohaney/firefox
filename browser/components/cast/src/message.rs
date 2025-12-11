use prost::Message;

include!(concat!(env!("OUT_DIR"), "/extensions.api.cast_channel.rs"));

impl CastMessage {
    pub fn new(
        source_id: String,
        destination_id: String,
        namespace: String,
        payload_json: String,
    ) -> Self {
        CastMessage {
            protocol_version: "CASTV2-1-0".to_string(),
            source_id,
            destination_id,
            namespace,
            payload_type: PayloadType::String.into(),
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
