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

    fn handle_received_data(&self, data: &[u8]) {
        if data.len() < 4 {
            return;
        }

        let msg_length = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);

        if data.len() < (4 + msg_length as usize) {
            return;
        }

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

        // Delegate to handlers based on namespace
        match namespace {
            namespaces::HEARTBEAT => {
                if let Some(response) = HeartbeatHandler::handle_message(payload) {
                    if let Err(e) = device_ref.send_message_internal(namespace, &response) {
                        println!("CastStreamListener: Failed to send PONG: {:?}", e);
                    }
                }
            }
            namespaces::CONNECTION => {
                if let Ok(ConnectionMessage::CONNECTED) =
                    serde_json::from_str::<ConnectionMessage>(payload)
                {
                    println!("CastStreamListener: Received CONNECTED response");
                }
            }
            namespaces::RECEIVER => {
                self.handle_receiver_message(device_ref, payload);
            }
            _ => {}
        }
    }

    fn handle_receiver_message(&self, device: &crate::cast_device::CastDevice, payload: &str) {
        match serde_json::from_str::<ReceiverMessage>(payload) {
            Ok(ReceiverMessage::RECEIVER_STATUS { status, .. }) => {
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
