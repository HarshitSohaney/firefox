/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::constants::namespaces;
use crate::handlers::{ConnectionHandler, HeartbeatHandler};
use crate::message::CastMessage;
use crate::messages::{ConnectionMessage, ReceiverMessage};
use nserror::{nsresult, NS_OK};
use nsstring::{nsACString, nsCString};
use prost::Message;
use serde_json;
use std::cell::RefCell;
use xpcom::interfaces::{nsIInputStream, nsIRequest};
use xpcom::{xpcom_method, RefPtr};

/// Async stream listener for receiving Cast protocol messages.
/// Implements nsIStreamListener to handle incoming data from the Cast device.
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
            println!(
                "CastStreamListener: Stream stopped with error: {:?}",
                status
            );
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

    /// Parse incoming Cast protocol messages from the stream.
    ///
    /// Cast Protocol Receive Flow:
    /// 1. Read 4-byte big-endian length prefix
    /// 2. Read exactly that many bytes as protobuf message body
    /// 3. Decode protobuf to CastMessage
    /// 4. Extract JSON payload from payload_utf8 field
    /// 5. Route to appropriate handler based on namespace
    ///
    /// Example received wire format for PONG:
    /// ```text
    /// [0x00, 0x00, 0x00, 0x4C]  <- 76 bytes
    /// [protobuf containing:
    ///   protocol_version: 0
    ///   source_id: "receiver-0"
    ///   destination_id: "sender-0"
    ///   namespace: "urn:x-cast:com.google.cast.tp.heartbeat"
    ///   payload_utf8: "{\"type\":\"PONG\"}"
    /// ]
    /// ```
    ///
    /// Note: Currently this assumes the entire message arrives in one data chunk.
    /// A production implementation would need to buffer partial messages.
    fn handle_received_data(&self, data: &[u8]) {
        if data.len() < 4 {
            return;
        }

        // Read 4-byte message length prefix (big-endian)
        let msg_length = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);

        if data.len() < (4 + msg_length as usize) {
            return;
        }

        // Extract protobuf message bytes (after 4-byte length prefix)
        let msg_bytes = &data[4..(4 + msg_length as usize)];

        match CastMessage::decode(msg_bytes) {
            Ok(message) => {
                if let Some(payload) = &message.payload_utf8 {
                    // Log incoming message with shortened namespace
                    let namespace_short = message
                        .namespace
                        .split('.')
                        .last()
                        .unwrap_or(&message.namespace);

                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(payload) {
                        let msg_type = parsed["type"].as_str().unwrap_or("unknown");
                        println!("CastStreamListener: <- [{}] {}", namespace_short, msg_type);
                    } else {
                        println!(
                            "CastStreamListener: <- [{}] (non-JSON payload)",
                            namespace_short
                        );
                    }

                    self.handle_message(&message.namespace, payload);
                }
            }
            Err(e) => {
                println!("CastStreamListener: Failed to decode message: {:?}", e);
            }
        }
    }

    /// Route Cast protocol messages to appropriate handlers.
    ///
    /// Cast Protocol Namespace Handling:
    ///
    /// 1. HEARTBEAT (urn:x-cast:com.google.cast.tp.heartbeat)
    ///    - Device sends PING every 5 seconds
    ///    - We must respond with PONG or device will disconnect
    ///
    /// 2. CONNECTION (urn:x-cast:com.google.cast.tp.connection)
    ///    - We send CONNECT to establish virtual connection
    ///    - Device responds with CONNECTED
    ///    - Must CONNECT before using receiver/media namespaces
    ///
    /// 3. RECEIVER (urn:x-cast:com.google.cast.receiver)
    ///    - RECEIVER_STATUS: Device reports running apps and their states
    ///    - We parse this to get app session ID and transport ID
    ///    - If no app running, we LAUNCH DefaultMediaReceiver (CC1AD845)
    ///    - Once app is running, we CONNECT to its transport ID
    ///
    /// 4. MEDIA (urn:x-cast:com.google.cast.media)
    ///    - Forwarded to JavaScript (not handled in Rust)
    ///    - Used for LOAD, PLAY, PAUSE, STOP commands
    ///    - Device sends MEDIA_STATUS updates
    ///
    /// All messages are forwarded to JavaScript callback for UI updates.
    fn handle_message(&self, namespace: &str, payload: &str) {
        let device = self.device.borrow();
        let device_ref = match device.as_ref() {
            Some(d) => d,
            None => return,
        };

        // Forward all messages to JavaScript callback for UI/session management
        if let Ok(callback) = device_ref.get_callback() {
            unsafe {
                let ns_cstring = nsCString::from(namespace);
                let payload_cstring = nsCString::from(payload);
                callback.OnMessage(&ns_cstring as &nsACString, &payload_cstring as &nsACString);
            }
        }

        // Handle protocol messages that require automatic responses
        match namespace {
            namespaces::HEARTBEAT => {
                // Heartbeat keepalive: Respond to PING with PONG
                if let Some(response) = HeartbeatHandler::handle_message(payload) {
                    if let Err(e) = device_ref.send_message_internal(namespace, &response) {
                        println!("CastStreamListener: Failed to send PONG: {:?}", e);
                    }
                }
            }
            namespaces::CONNECTION => {
                // Connection confirmation: Just log CONNECTED response
                if let Ok(ConnectionMessage::CONNECTED) =
                    serde_json::from_str::<ConnectionMessage>(payload)
                {
                    println!("CastStreamListener: Received CONNECTED response");
                }
            }
            namespaces::RECEIVER => {
                // Receiver status: Handle app lifecycle (launch, connect to app)
                self.handle_receiver_message(device_ref, payload);
            }
            _ => {}
        }
    }

    /// Handle receiver status messages and manage app lifecycle.
    ///
    /// Cast App Lifecycle Protocol:
    ///
    /// 1. Initial State: No app running
    ///    - RECEIVER_STATUS with empty applications array
    ///    - We send LAUNCH message with app ID (CC1AD845 = DefaultMediaReceiver)
    ///
    /// 2. App Launching: RECEIVER_STATUS with app in applications array
    ///    - Parse app.sessionId (e.g., "12345678-abcd-1234-abcd-123456789abc")
    ///    - Parse app.transportId (e.g., "web-12345")
    ///    - Store both IDs in device state
    ///
    /// 3. App Running: Send CONNECT to app's transport ID
    ///    - This establishes virtual connection to the app instance
    ///    - Now we can send media messages to the app
    ///
    /// The transport ID is critical: media commands must go to the app's
    /// transport ID, not to receiver-0. Without this, LOAD commands fail.
    fn handle_receiver_message(&self, device: &crate::cast_device::CastDevice, payload: &str) {
        match serde_json::from_str::<ReceiverMessage>(payload) {
            Ok(ReceiverMessage::RECEIVER_STATUS { status, .. }) => {
                // No apps running: Launch the default media receiver app
                if status.applications.is_empty() {
                    if device.get_app_session_id().is_none() {
                        println!("CastStreamListener: Launching DefaultMediaReceiver");
                        let launch = device.create_launch_message(None);

                        if let Err(e) = device.send_message_internal(namespaces::RECEIVER, &launch)
                        {
                            println!("CastStreamListener: Failed to send LAUNCH: {:?}", e);
                        } else {
                            println!("CastStreamListener: App launched successfully");
                        }
                    }
                // App is running: Extract session/transport IDs and connect to app
                } else if let Some(app) = status.applications.first() {
                    if device.get_app_session_id() != Some(app.session_id.clone()) {
                        device.set_app_session_id(Some(app.session_id.clone()));
                    }

                    if device.get_transport_id() != Some(app.transport_id.clone()) {
                        println!(
                            "CastStreamListener: Setting transport ID: {}",
                            app.transport_id
                        );
                        device.set_transport_id(Some(app.transport_id.clone()));
                    }

                    if !app.sender_connected {
                        println!(
                            "CastStreamListener: Connecting to existing app transport: {}",
                            app.transport_id
                        );
                        let connect = ConnectionHandler::create_connect_message();

                        if let Err(e) = device.send_message_to(
                            &app.transport_id,
                            namespaces::CONNECTION,
                            &connect,
                        ) {
                            println!("CastStreamListener: Failed to connect to app: {:?}", e);
                        } else {
                            println!("CastStreamListener: Connected to existing app");
                        }
                    } else {
                        println!("CastStreamListener: Already connected to app");
                    }
                }
            }
            Ok(ReceiverMessage::LAUNCH_ERROR { reason, .. }) => {
                println!("CastStreamListener: Launch failed: {:?}", reason);
            }
            Err(_) => {}
            _ => {}
        }
    }
}
