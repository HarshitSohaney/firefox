use crate::handlers::ConnectionHandler;
use crate::message::CastMessage;
use nserror::{nsresult, NS_ERROR_FAILURE, NS_ERROR_NOT_AVAILABLE, NS_OK};
use nsstring::{nsACString, nsCString};
use serde_json;
use std::cell::RefCell;
use std::ffi::CStr;
use thin_vec::ThinVec;
use xpcom::interfaces::{
    nsICastDeviceCallback, nsIInputStream, nsIInputStreamPump, nsIOutputStream, nsISocketTransport,
    nsISocketTransportService,
};
use xpcom::{xpcom_method, RefPtr};

#[xpcom::xpcom(implement(nsICastDevice), atomic)]
pub struct CastDevice {
    state: RefCell<nsCString>,
    callback: RefCell<Option<RefPtr<nsICastDeviceCallback>>>,
    transport: RefCell<Option<RefPtr<nsISocketTransport>>>,
    output_stream: RefCell<Option<RefPtr<nsIOutputStream>>>,
    input_stream: RefCell<Option<RefPtr<nsIInputStream>>>,
    input_pump: RefCell<Option<RefPtr<nsIInputStreamPump>>>,
    receive_buffer: RefCell<Vec<u8>>,
    app_session_id: RefCell<Option<String>>,
}

impl CastDevice {
    pub fn new() -> RefPtr<Self> {
        CastDevice::allocate(InitCastDevice {
            state: RefCell::new(nsCString::from("disconnected")),
            callback: RefCell::new(None),
            transport: RefCell::new(None),
            output_stream: RefCell::new(None),
            input_stream: RefCell::new(None),
            input_pump: RefCell::new(None),
            receive_buffer: RefCell::new(Vec::new()),
            app_session_id: RefCell::new(None),
        })
    }

    pub fn get_app_session_id(&self) -> Option<String> {
        self.app_session_id.borrow().clone()
    }

    pub fn set_app_session_id(&self, session_id: Option<String>) {
        *self.app_session_id.borrow_mut() = session_id;
    }

    fn notify_state_change(&self, state: &str) {
        *self.state.borrow_mut() = nsCString::from(state);
        if let Some(callback) = self.callback.borrow().as_ref() {
            unsafe {
                callback.OnStateChanged(&nsCString::from(state) as &nsACString);
            }
        }
    }

    xpcom_method!(connect => Connect(address: *const nsACString, port: i32));
    fn connect(&self, address: &nsACString, port: i32) -> Result<(), nsresult> {
        println!("CastDevice: Connecting to {}:{}", address, port);

        self.notify_state_change("connecting");

        // Get the socket transport service
        let sts_service = xpcom::components::SocketTransport::service::<nsISocketTransportService>()
            .map_err(|e| {
                println!("CastDevice: Failed to get socket transport service: {:?}", e);
                NS_ERROR_FAILURE
            })?;

        // Create TLS transport
        let mut socket_types = ThinVec::new();
        socket_types.push(nsCString::from("ssl"));

        let mut transport_ptr: *const nsISocketTransport = std::ptr::null();
        let rv = unsafe {
            sts_service.CreateTransport(
                &socket_types as *const _,
                address as *const _,
                port,
                std::ptr::null(),
                std::ptr::null(),
                &mut transport_ptr as *mut _,
            )
        };

        if rv.failed() || transport_ptr.is_null() {
            println!("CastDevice: Failed to create TLS transport");
            self.notify_state_change("error");
            return Err(NS_ERROR_FAILURE);
        }

        let transport: RefPtr<nsISocketTransport> = unsafe { RefPtr::from_raw(transport_ptr as *mut _).unwrap() };
        *self.transport.borrow_mut() = Some(transport.clone());

        // Open output stream
        let mut output_stream_ptr: *const nsIOutputStream = std::ptr::null();
        let rv = unsafe {
            transport.OpenOutputStream(0, 0, 0, &mut output_stream_ptr as *mut _)
        };

        if rv.failed() || output_stream_ptr.is_null() {
            println!("CastDevice: Failed to open output stream");
            self.notify_state_change("error");
            return Err(NS_ERROR_FAILURE);
        }

        let output_stream: RefPtr<nsIOutputStream> = unsafe { RefPtr::from_raw(output_stream_ptr as *mut _).unwrap() };
        *self.output_stream.borrow_mut() = Some(output_stream.clone());

        // TODO: Use nsITransportEventSink to wait for TLS handshake completion properly
        // For now, brief delay to allow TLS negotiation
        std::thread::sleep(std::time::Duration::from_millis(500));

        // Send CONNECT message
        let connect_payload = ConnectionHandler::create_connect_message();
        self.send_message_internal(ConnectionHandler::NAMESPACE, &connect_payload)?;

        // Send GET_STATUS immediately (some devices like Google TV don't send CONNECTED response)
        let get_status = serde_json::json!({
            "type": "GET_STATUS",
            "requestId": 1
        }).to_string();
        self.send_message_internal("urn:x-cast:com.google.cast.receiver", &get_status)?;

        // Open input stream and set up async reading
        let mut input_stream_ptr: *const nsIInputStream = std::ptr::null();
        let rv = unsafe {
            transport.OpenInputStream(0, 0, 0, &mut input_stream_ptr as *mut _)
        };

        if rv.failed() || input_stream_ptr.is_null() {
            println!("CastDevice: Failed to open input stream");
            self.notify_state_change("error");
            return Err(NS_ERROR_FAILURE);
        }

        let input_stream: RefPtr<nsIInputStream> =
            unsafe { RefPtr::from_raw(input_stream_ptr as *mut _).unwrap() };
        *self.input_stream.borrow_mut() = Some(input_stream.clone());

        // Create input stream pump for async message receiving
        let contract_id = CStr::from_bytes_with_nul(b"@mozilla.org/network/input-stream-pump;1\0")
            .map_err(|_| NS_ERROR_FAILURE)?;
        let pump = xpcom::create_instance::<nsIInputStreamPump>(contract_id)
            .ok_or(NS_ERROR_FAILURE)?;

        let rv = unsafe {
            pump.Init(input_stream.coerce(), 0, 0, false, std::ptr::null())
        };

        if rv.failed() {
            println!("CastDevice: Failed to initialize input stream pump");
            self.notify_state_change("error");
            return Err(NS_ERROR_FAILURE);
        }

        *self.input_pump.borrow_mut() = Some(pump.clone());

        // Start async message reading
        let listener = crate::stream_listener::CastStreamListener::new(RefPtr::new(self));
        let rv = unsafe { pump.AsyncRead(listener.coerce()) };

        if rv.failed() {
            println!("CastDevice: Failed to start async reading");
            self.notify_state_change("error");
            return Err(NS_ERROR_FAILURE);
        }

        println!("CastDevice: Connected successfully");
        self.notify_state_change("connected");

        Ok(())
    }

    pub fn send_message_internal(
        &self,
        namespace: &str,
        payload: &str,
    ) -> Result<(), nsresult> {
        self.send_message_to("receiver-0", namespace, payload)
    }

    pub fn send_message_to(
        &self,
        destination_id: &str,
        namespace: &str,
        payload: &str,
    ) -> Result<(), nsresult> {
        // Log outgoing message with shortened namespace
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(payload) {
            let msg_type = parsed["type"].as_str().unwrap_or("unknown");
            let namespace_short = namespace.split('.').last().unwrap_or(namespace);
            let dest_suffix = if destination_id == "receiver-0" {
                String::from("")
            } else {
                format!(" to {}", &destination_id[..8])
            };
            println!("CastDevice: -> [{}] {}{}", namespace_short, msg_type, dest_suffix);
        }

        let output_stream = self.output_stream.borrow();
        let stream = output_stream.as_ref().ok_or(NS_ERROR_NOT_AVAILABLE)?;

        let cast_message = CastMessage::new(
            "sender-0".to_string(),
            destination_id.to_string(),
            namespace.to_string(),
            payload.to_string(),
        );

        let message_bytes = cast_message.encode_to_vec().map_err(|_| NS_ERROR_FAILURE)?;

        // Frame: [4 bytes length (big-endian)][protobuf bytes]
        let length = (message_bytes.len() as u32).to_be_bytes();
        let mut framed_message = Vec::with_capacity(4 + message_bytes.len());
        framed_message.extend_from_slice(&length);
        framed_message.extend_from_slice(&message_bytes);

        let mut bytes_written = 0u32;
        let rv = unsafe {
            stream.Write(
                framed_message.as_ptr() as *const i8,
                framed_message.len() as u32,
                &mut bytes_written as *mut _,
            )
        };

        if rv.failed() {
            return Err(NS_ERROR_FAILURE);
        }

        Ok(())
    }

    xpcom_method!(disconnect => Disconnect());
    fn disconnect(&self) -> Result<(), nsresult> {
        println!("CastDevice::disconnect called");
        Ok(())
    }

    xpcom_method!(send_message => SendMessage(namespace: *const nsACString, payload: *const nsACString));
    fn send_message(&self, namespace: &nsACString, payload: &nsACString) -> Result<(), nsresult> {
        println!(
            "CastDevice::sendMessage called: {} - {}",
            namespace, payload
        );

        let ns_str = namespace.to_utf8();
        let payload_str = payload.to_utf8();

        self.send_message_internal(&ns_str, &payload_str)
    }

    xpcom_method!(get_callback => GetCallback() -> *const nsICastDeviceCallback);
    fn get_callback(&self) -> Result<RefPtr<nsICastDeviceCallback>, nsresult> {
        match &*self.callback.borrow() {
            Some(cb) => Ok(cb.clone()),
            None => Err(NS_ERROR_NOT_AVAILABLE),
        }
    }

    xpcom_method!(set_callback => SetCallback(callback: *const nsICastDeviceCallback));
    fn set_callback(&self, callback: Option<&nsICastDeviceCallback>) -> Result<(), nsresult> {
        println!("CastDevice::setCallback called");
        *self.callback.borrow_mut() = callback.map(|cb| RefPtr::new(cb));
        Ok(())
    }

    xpcom_method!(get_state => GetState() -> nsACString);
    fn get_state(&self) -> Result<nsCString, nsresult> {
        Ok(self.state.borrow().clone())
    }
}
