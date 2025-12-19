use crate::handlers::ConnectionHandler;
use crate::message::CastMessage;
use nserror::{nsresult, NS_ERROR_FAILURE, NS_ERROR_NOT_AVAILABLE, NS_OK};
use nsstring::{nsACString, nsCString};
use serde_json;
use std::cell::RefCell;
use std::ffi::CStr;
use thin_vec::ThinVec;
use xpcom::interfaces::{
    nsICastDeviceCallback, nsIInputStream, nsIInputStreamPump,
    nsIOutputStream, nsISocketTransport, nsISocketTransportService,
};
use xpcom::{xpcom_method, RefPtr};

struct CastDeviceInner {
    state: nsCString,
    callback: Option<RefPtr<nsICastDeviceCallback>>,
    transport: Option<RefPtr<nsISocketTransport>>,
    output_stream: Option<RefPtr<nsIOutputStream>>,
    input_stream: Option<RefPtr<nsIInputStream>>,
    input_pump: Option<RefPtr<nsIInputStreamPump>>,
    receive_buffer: Vec<u8>,
    app_session_id: Option<String>,
    app_transport_id: Option<String>,
    address: nsCString,
    port: i32,
}

impl Default for CastDeviceInner {
    fn default() -> Self {
        Self {
            state: nsCString::from("disconnected"),
            callback: None,
            transport: None,
            output_stream: None,
            input_stream: None,
            input_pump: None,
            receive_buffer: Vec::new(),
            app_session_id: None,
            app_transport_id: None,
            address: nsCString::new(),
            port: 8009,
        }
    }
}

#[xpcom::xpcom(implement(nsICastDevice), atomic)]
pub struct CastDevice {
    inner: RefCell<CastDeviceInner>,
}

impl CastDevice {
    pub fn new() -> RefPtr<Self> {
        CastDevice::allocate(InitCastDevice {
            inner: RefCell::new(CastDeviceInner::default()),
        })
    }

    pub fn get_app_session_id(&self) -> Option<String> {
        self.inner.borrow().app_session_id.clone()
    }

    pub fn set_app_session_id(&self, session_id: Option<String>) {
        self.inner.borrow_mut().app_session_id = session_id;
    }

    pub fn get_transport_id(&self) -> Option<String> {
        self.inner.borrow().app_transport_id.clone()
    }

    pub fn set_transport_id(&self, transport_id: Option<String>) {
        self.inner.borrow_mut().app_transport_id = transport_id;
    }

    fn notify_state_change(&self, state: &str) {
        let mut inner = self.inner.borrow_mut();
        inner.state = nsCString::from(state);
        if let Some(ref callback) = inner.callback {
            unsafe {
                callback.OnStateChanged(&nsCString::from(state) as &nsACString);
            }
        }
    }

    xpcom_method!(connect => Connect(address: *const nsACString, port: i32));
    fn connect(&self, address: &nsACString, port: i32) -> Result<(), nsresult> {
        println!("CastDevice: Connecting to {}:{}", address, port);

        {
            let mut inner = self.inner.borrow_mut();
            inner.address = nsCString::from(address);
            inner.port = port;
        }

        self.notify_state_change("connecting");

        let sts_service = xpcom::components::SocketTransport::service::<nsISocketTransportService>()
            .map_err(|e| {
                println!("CastDevice: Failed to get socket transport service: {:?}", e);
                NS_ERROR_FAILURE
            })?;

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
        self.inner.borrow_mut().transport = Some(transport.clone());

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
        self.inner.borrow_mut().output_stream = Some(output_stream);

        std::thread::sleep(std::time::Duration::from_millis(500));

        let connect_payload = ConnectionHandler::create_connect_message();
        self.send_message_internal(ConnectionHandler::NAMESPACE, &connect_payload)?;

        let get_status = serde_json::json!({
            "type": "GET_STATUS",
            "requestId": 1
        }).to_string();
        self.send_message_internal("urn:x-cast:com.google.cast.receiver", &get_status)?;

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

        {
            let mut inner = self.inner.borrow_mut();
            inner.input_stream = Some(input_stream);
            inner.input_pump = Some(pump.clone());
        }

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
        let destination = if namespace == "urn:x-cast:com.google.cast.media" {
            if let Some(transport_id) = self.get_transport_id() {
                println!("CastDevice: Routing media message to app transport: {}", transport_id);
                transport_id
            } else {
                println!("CastDevice: WARNING - No transport ID, sending media message to receiver-0");
                "receiver-0".to_string()
            }
        } else {
            "receiver-0".to_string()
        };

        self.send_message_to(&destination, namespace, payload)
    }

    pub fn send_message_to(
        &self,
        destination_id: &str,
        namespace: &str,
        payload: &str,
    ) -> Result<(), nsresult> {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(payload) {
            let msg_type = parsed["type"].as_str().unwrap_or("unknown");
            let namespace_short = namespace.split('.').last().unwrap_or(namespace);
            let dest_suffix = if destination_id == "receiver-0" {
                String::from("")
            } else {
                format!(" to {}", &destination_id[..8.min(destination_id.len())])
            };
            println!("CastDevice: -> [{}] {}{}", namespace_short, msg_type, dest_suffix);
        }

        let inner = self.inner.borrow();
        let stream = inner.output_stream.as_ref().ok_or(NS_ERROR_NOT_AVAILABLE)?;

        let cast_message = CastMessage::new(
            "sender-0".to_string(),
            destination_id.to_string(),
            namespace.to_string(),
            payload.to_string(),
        );

        let message_bytes = cast_message.encode_to_vec().map_err(|_| NS_ERROR_FAILURE)?;

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

        let mut inner = self.inner.borrow_mut();

        if let Some(pump) = inner.input_pump.take() {
            unsafe {
                pump.Cancel(NS_ERROR_FAILURE);
            }
        }

        if let Some(stream) = inner.input_stream.take() {
            unsafe {
                stream.Close();
            }
        }

        if let Some(stream) = inner.output_stream.take() {
            unsafe {
                stream.Close();
            }
        }

        if let Some(transport) = inner.transport.take() {
            unsafe {
                transport.Close(NS_OK);
            }
        }

        inner.receive_buffer.clear();
        inner.app_session_id = None;
        inner.app_transport_id = None;

        drop(inner);
        self.notify_state_change("disconnected");

        println!("CastDevice: Disconnected successfully");
        Ok(())
    }

    xpcom_method!(send_message => SendMessage(namespace: *const nsACString, payload: *const nsACString));
    fn send_message(&self, namespace: &nsACString, payload: &nsACString) -> Result<(), nsresult> {
        self.send_message_internal(&namespace.to_utf8(), &payload.to_utf8())
    }

    xpcom_method!(send_message_to_xpcom => SendMessageTo(destination_id: *const nsACString, namespace: *const nsACString, payload: *const nsACString));
    fn send_message_to_xpcom(&self, destination_id: &nsACString, namespace: &nsACString, payload: &nsACString) -> Result<(), nsresult> {
        self.send_message_to(&destination_id.to_utf8(), &namespace.to_utf8(), &payload.to_utf8())
    }

    xpcom_method!(get_callback => GetCallback() -> *const nsICastDeviceCallback);
    pub fn get_callback(&self) -> Result<RefPtr<nsICastDeviceCallback>, nsresult> {
        self.inner.borrow().callback.as_ref().cloned().ok_or(NS_ERROR_NOT_AVAILABLE)
    }

    xpcom_method!(set_callback => SetCallback(callback: *const nsICastDeviceCallback));
    fn set_callback(&self, callback: Option<&nsICastDeviceCallback>) -> Result<(), nsresult> {
        self.inner.borrow_mut().callback = callback.map(RefPtr::new);
        Ok(())
    }

    xpcom_method!(get_state => GetState() -> nsACString);
    fn get_state(&self) -> Result<nsCString, nsresult> {
        Ok(self.inner.borrow().state.clone())
    }

    xpcom_method!(get_app_transport_id => GetAppTransportId() -> nsACString);
    fn get_app_transport_id(&self) -> Result<nsCString, nsresult> {
        Ok(self.inner.borrow().app_transport_id.as_ref()
            .map(|s| nsCString::from(s.as_str()))
            .unwrap_or_else(nsCString::new))
    }
}
