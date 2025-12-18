use crate::message::CastMessage;
use nserror::{nsresult, NS_OK};
use nsstring::{nsACString, nsCString};
use prost::Message;
use serde_json;
use std::cell::RefCell;
use xpcom::interfaces::{nsIInputStream, nsIRequest};
use xpcom::{xpcom_method, RefPtr};

#[xpcom::xpcom(implement(nsIStreamListener, nsIRequestObserver), atomic)]
pub struct CastStreamListener {
    device: RefCell<Option<RefPtr<crate::cast_device::CastDevice>>>,
}

impl CastStreamListener {
    pub fn new(device: RefPtr<crate::cast_device::CastDevice>) -> RefPtr<Self> {
        CastStreamListener::allocate(InitCastStreamListener {
            device: RefCell::new(Some(device)),
        })
    }

    xpcom_method!(on_start_request => OnStartRequest(request: *const nsIRequest));
    fn on_start_request(&self, _request: &nsIRequest) -> Result<(), nsresult> {
        Ok(())
    }

    xpcom_method!(on_stop_request => OnStopRequest(request: *const nsIRequest, status: nsresult));
    fn on_stop_request(&self, _request: &nsIRequest, status: nsresult) -> Result<(), nsresult> {
        if status.failed() {
            println!("CastStreamListener: Stream stopped with error: {:?}", status);
        }
        Ok(())
    }

    xpcom_method!(on_data_available => OnDataAvailable(
        request: *const nsIRequest,
        input_stream: *const nsIInputStream,
        offset: u64,
        count: u32
    ));
    fn on_data_available(
        &self,
        _request: &nsIRequest,
        input_stream: &nsIInputStream,
        _offset: u64,
        count: u32,
    ) -> Result<(), nsresult> {
        let mut buffer = vec![0u8; count as usize];
        let mut bytes_read = 0u32;

        let rv = unsafe {
            input_stream.Read(
                buffer.as_mut_ptr() as *mut i8,
                count,
                &mut bytes_read as *mut _,
            )
        };

        if rv.failed() {
            return Err(rv);
        }

        if bytes_read > 0 {
            self.handle_received_data(&buffer[..bytes_read as usize]);
        }

        Ok(())
    }

    fn handle_received_data(&self, data: &[u8]) {
        if data.len() >= 4 {
            let msg_length = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);

            if data.len() >= (4 + msg_length as usize) {
                let msg_bytes = &data[4..(4 + msg_length as usize)];
                match CastMessage::decode(msg_bytes) {
                    Ok(message) => {
                        if let Some(payload) = &message.payload_utf8 {
                            // Log incoming message with shortened namespace
                            let namespace_short = message.namespace
                                .split('.')
                                .last()
                                .unwrap_or(&message.namespace);

                            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(payload) {
                                let msg_type = parsed["type"].as_str().unwrap_or("unknown");
                                println!("CastStreamListener: <- [{}] {}", namespace_short, msg_type);
                            } else {
                                println!("CastStreamListener: <- [{}] (non-JSON payload)", namespace_short);
                            }

                            self.handle_message(&message.namespace, payload);
                        }
                    }
                    Err(e) => {
                        println!("CastStreamListener: Failed to decode message: {:?}", e);
                    }
                }
            }
        }
    }

    fn handle_message(&self, namespace: &str, payload: &str) {
        let device = self.device.borrow();
        let device_ref = match device.as_ref() {
            Some(d) => d,
            None => return,
        };

        // Forward all messages to JavaScript callback
        if let Ok(callback) = device_ref.get_callback() {
            unsafe {
                let ns_cstring = nsCString::from(namespace);
                let payload_cstring = nsCString::from(payload);
                callback.OnMessage(&ns_cstring as &nsACString, &payload_cstring as &nsACString);
            }
        }

        // Handle heartbeat PING
        if namespace == "urn:x-cast:com.google.cast.tp.heartbeat" {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(payload) {
                if parsed["type"] == "PING" {
                    let pong = serde_json::json!({"type": "PONG"}).to_string();
                    if let Err(e) = device_ref.send_message_internal(namespace, &pong) {
                        println!("CastStreamListener: Failed to send PONG: {:?}", e);
                    }
                }
            }
        }

        // Handle connection CONNECTED (some devices send this, others don't)
        if namespace == "urn:x-cast:com.google.cast.tp.connection" {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(payload) {
                if parsed["type"] == "CONNECTED" {
                    println!("CastStreamListener: Received CONNECTED response");
                }
            }
        }

        // Handle receiver status
        if namespace == "urn:x-cast:com.google.cast.receiver" {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(payload) {
                if parsed["type"] == "RECEIVER_STATUS" {
                    let applications = parsed["status"]["applications"].as_array();
                    let has_app = applications.map_or(false, |apps| !apps.is_empty());

                    if !has_app {
                        // Only launch if we haven't already launched
                        if device_ref.get_app_session_id().is_none() {
                            println!("CastStreamListener: Launching DefaultMediaReceiver");
                            let launch = serde_json::json!({
                                "type": "LAUNCH",
                                "requestId": 2,
                                "appId": "CC1AD845"
                            }).to_string();

                            if let Err(e) = device_ref.send_message_internal(
                                "urn:x-cast:com.google.cast.receiver",
                                &launch
                            ) {
                                println!("CastStreamListener: Failed to send LAUNCH: {:?}", e);
                            } else {
                                println!("CastStreamListener: App launched successfully");
                            }
                        }
                    } else {
                        // App already running - connect to it
                        if let Some(apps) = applications {
                            if let Some(app) = apps.get(0) {
                                let session_id = app["sessionId"].as_str().map(|s| s.to_string());
                                let transport_id = app["transportId"].as_str();
                                let sender_connected = app["senderConnected"].as_bool().unwrap_or(false);

                                // Track the session ID
                                if let Some(sid) = session_id.clone() {
                                    if device_ref.get_app_session_id() != Some(sid.clone()) {
                                        device_ref.set_app_session_id(Some(sid));
                                    }
                                }

                                // Track the transport ID
                                if let Some(tid) = transport_id {
                                    if device_ref.get_transport_id() != Some(tid.to_string()) {
                                        println!("CastStreamListener: Setting transport ID: {}", tid);
                                        device_ref.set_transport_id(Some(tid.to_string()));
                                    }
                                }

                                if !sender_connected {
                                    if let Some(tid) = transport_id {
                                        println!("CastStreamListener: Connecting to existing app transport: {}", tid);
                                        let connect = serde_json::json!({"type": "CONNECT"}).to_string();

                                        if let Err(e) = device_ref.send_message_to(
                                            tid,
                                            "urn:x-cast:com.google.cast.tp.connection",
                                            &connect
                                        ) {
                                            println!("CastStreamListener: Failed to connect to app: {:?}", e);
                                        } else {
                                            println!("CastStreamListener: Connected to existing app");
                                        }
                                    }
                                } else {
                                    println!("CastStreamListener: Already connected to app");
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
