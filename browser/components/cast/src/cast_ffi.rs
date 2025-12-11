use crate::message::CastMessage;
use crate::handlers::{ConnectionHandler, HeartbeatHandler, ReceiverHandler};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::slice;

#[no_mangle]
pub extern "C" fn cast_encode_message(
    source_id: *const c_char,
    destination_id: *const c_char,
    namespace: *const c_char,
    payload_json: *const c_char,
    out_buffer: *mut *mut u8,
    out_len: *mut usize,
) -> bool {
    let source_id = unsafe {
        if source_id.is_null() {
            return false;
        }
        match CStr::from_ptr(source_id).to_str() {
            Ok(s) => s.to_string(),
            Err(_) => return false,
        }
    };

    let destination_id = unsafe {
        if destination_id.is_null() {
            return false;
        }
        match CStr::from_ptr(destination_id).to_str() {
            Ok(s) => s.to_string(),
            Err(_) => return false,
        }
    };

    let namespace = unsafe {
        if namespace.is_null() {
            return false;
        }
        match CStr::from_ptr(namespace).to_str() {
            Ok(s) => s.to_string(),
            Err(_) => return false,
        }
    };

    let payload_json = unsafe {
        if payload_json.is_null() {
            return false;
        }
        match CStr::from_ptr(payload_json).to_str() {
            Ok(s) => s.to_string(),
            Err(_) => return false,
        }
    };

    let message = CastMessage::new(source_id, destination_id, namespace, payload_json);

    match message.encode_to_vec() {
        Ok(bytes) => {
            let len = bytes.len();
            let ptr = Box::into_raw(bytes.into_boxed_slice()) as *mut u8;

            unsafe {
                *out_buffer = ptr;
                *out_len = len;
            }
            true
        }
        Err(_) => false,
    }
}

#[no_mangle]
pub extern "C" fn cast_decode_message(
    buffer: *const u8,
    len: usize,
    out_source_id: *mut *mut c_char,
    out_destination_id: *mut *mut c_char,
    out_namespace: *mut *mut c_char,
    out_payload: *mut *mut c_char,
) -> bool {
    let bytes = unsafe {
        if buffer.is_null() || len == 0 {
            return false;
        }
        slice::from_raw_parts(buffer, len)
    };

    match CastMessage::decode_from_slice(bytes) {
        Ok(message) => {
            unsafe {
                if let Ok(cstr) = CString::new(message.source_id) {
                    *out_source_id = cstr.into_raw();
                } else {
                    return false;
                }

                if let Ok(cstr) = CString::new(message.destination_id) {
                    *out_destination_id = cstr.into_raw();
                } else {
                    return false;
                }

                if let Ok(cstr) = CString::new(message.namespace) {
                    *out_namespace = cstr.into_raw();
                } else {
                    return false;
                }

                let payload = message.payload_utf8.unwrap_or_default();
                if let Ok(cstr) = CString::new(payload) {
                    *out_payload = cstr.into_raw();
                } else {
                    return false;
                }
            }
            true
        }
        Err(_) => false,
    }
}

#[no_mangle]
pub extern "C" fn cast_create_connect_message() -> *mut c_char {
    match CString::new(ConnectionHandler::create_connect_message()) {
        Ok(cstr) => cstr.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn cast_create_ping_message() -> *mut c_char {
    match CString::new(HeartbeatHandler::create_ping()) {
        Ok(cstr) => cstr.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn cast_free_string(s: *mut c_char) {
    if !s.is_null() {
        unsafe {
            drop(CString::from_raw(s));
        }
    }
}

#[no_mangle]
pub extern "C" fn cast_free_buffer(buffer: *mut u8, len: usize) {
    if !buffer.is_null() && len > 0 {
        unsafe {
            drop(Box::from_raw(slice::from_raw_parts_mut(buffer, len)));
        }
    }
}
