/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

pub mod cast_device;
pub mod constants;
pub mod handlers;
pub mod message;
pub mod messages;
pub mod state;
pub mod stream_listener;
pub mod video_encoder;
pub mod vpx_ffi;
pub mod webm_writer_ffi;

pub use handlers::{ConnectionHandler, HeartbeatHandler, ReceiverHandler};
pub use message::CastMessage;
pub use state::DeviceState;

// Debug output: Use MOZ_LOG=cast:5 for production logging instead of println!
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
