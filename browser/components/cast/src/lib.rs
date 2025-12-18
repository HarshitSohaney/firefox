pub mod cast_device;
pub mod cert_override;
pub mod handlers;
pub mod message;
pub mod stream_listener;
pub mod video_encoder;
pub mod vpx_ffi;
pub mod webm_muxer;

pub use handlers::{ConnectionHandler, HeartbeatHandler, ReceiverHandler};
pub use message::CastMessage;

#[no_mangle]
pub unsafe extern "C" fn NS_NewCastDevice(
    iid: &xpcom::nsIID,
    result: *mut *mut libc::c_void,
) -> nserror::nsresult {
    println!("NS_NewCastDevice called from JS!");

    if result.is_null() {
        println!("NS_NewCastDevice: ERROR - result pointer is null!");
        return nserror::NS_ERROR_NULL_POINTER;
    }

    let device = cast_device::CastDevice::new();
    println!("NS_NewCastDevice: device created, calling QueryInterface");

    let rv = device.QueryInterface(iid, result);
    println!("NS_NewCastDevice: QueryInterface returned {:?}", rv);

    rv
}

#[no_mangle]
pub unsafe extern "C" fn NS_NewCastVideoEncoder(
    iid: &xpcom::nsIID,
    result: *mut *mut libc::c_void,
) -> nserror::nsresult {
    if result.is_null() {
        return nserror::NS_ERROR_NULL_POINTER;
    }

    let encoder = video_encoder::CastVideoEncoder::new();
    encoder.QueryInterface(iid, result)
}
