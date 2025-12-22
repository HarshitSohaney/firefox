/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use libc::{c_int, c_long, c_uchar, c_uint, c_ulong, c_void, size_t};
use std::mem::ManuallyDrop;

pub const VPX_IMG_FMT_I420: u32 = 0x102;
pub const VPX_CODEC_OK: i32 = 0;
pub const VPX_DL_REALTIME: c_ulong = 1;
pub const VPX_EFLAG_FORCE_KF: c_long = 1 << 0;
pub const VPX_CODEC_USE_OUTPUT_PARTITION: c_ulong = 0x20000;

pub const VPX_CODEC_CX_FRAME_PKT: c_int = 0;

#[repr(C)]
pub struct vpx_rational {
    pub num: c_int,
    pub den: c_int,
}

#[repr(C)]
pub struct vpx_codec_ctx {
    _data: [u8; 2048],
}

#[repr(C)]
pub struct vpx_codec_iface {
    _private: [u8; 0],
}

#[repr(C)]
pub struct vpx_image_t {
    pub fmt: c_uint,
    pub cs: c_uint,
    pub range: c_uint,
    pub w: c_uint,
    pub h: c_uint,
    pub bit_depth: c_uint,
    pub d_w: c_uint,
    pub d_h: c_uint,
    pub r_w: c_uint,
    pub r_h: c_uint,
    pub x_chroma_shift: c_uint,
    pub y_chroma_shift: c_uint,
    pub planes: [*mut c_uchar; 4],
    pub stride: [c_int; 4],
    pub bps: c_int,
    pub user_priv: *mut c_void,
    pub img_data: *mut c_uchar,
    pub img_data_owner: c_int,
    pub self_allocd: c_int,
    pub fb_priv: *mut c_void,
}

#[repr(C)]
pub struct vpx_codec_enc_cfg_t {
    pub g_usage: c_uint,
    pub g_threads: c_uint,
    pub g_profile: c_uint,
    pub g_w: c_uint,
    pub g_h: c_uint,
    pub g_bit_depth: c_uint,
    pub g_input_bit_depth: c_uint,
    pub g_timebase: vpx_rational,
    pub g_error_resilient: c_uint,
    pub g_pass: c_int,
    pub g_lag_in_frames: c_uint,
    pub rc_dropframe_thresh: c_uint,
    pub rc_resize_allowed: c_uint,
    pub rc_scaled_width: c_uint,
    pub rc_scaled_height: c_uint,
    pub rc_resize_up_thresh: c_uint,
    pub rc_resize_down_thresh: c_uint,
    pub rc_end_usage: c_int,
    pub rc_twopass_stats_in: *mut c_void,
    pub rc_firstpass_mb_stats_in: *mut c_void,
    pub rc_target_bitrate: c_uint,
    _padding: [u8; 512],
}

#[repr(C)]
pub struct vpx_codec_cx_pkt_t {
    pub kind: c_int,
    pub data: vpx_codec_cx_pkt_data,
}

#[repr(C)]
pub union vpx_codec_cx_pkt_data {
    pub frame: ManuallyDrop<vpx_codec_cx_pkt_frame>,
    _padding: [u8; 128],
}

#[repr(C)]
pub struct vpx_codec_cx_pkt_frame {
    pub buf: *const c_void,
    pub sz: size_t,
    pub pts: i64,
    pub duration: c_ulong,
    pub flags: c_uint,
    pub partition_id: c_int,
}

#[repr(C)]
pub struct vpx_codec_iter_t {
    _private: *mut c_void,
}

pub const VPX_ENCODER_ABI_VERSION: c_int = 37;

extern "C" {
    pub fn vpx_codec_vp8_cx() -> *const vpx_codec_iface;

    pub fn vpx_codec_enc_config_default(
        iface: *const vpx_codec_iface,
        cfg: *mut vpx_codec_enc_cfg_t,
        usage: c_uint,
    ) -> c_int;

    pub fn vpx_codec_enc_init_ver(
        ctx: *mut vpx_codec_ctx,
        iface: *const vpx_codec_iface,
        cfg: *const vpx_codec_enc_cfg_t,
        flags: c_ulong,
        ver: c_int,
    ) -> c_int;

    pub fn vpx_codec_encode(
        ctx: *mut vpx_codec_ctx,
        img: *const vpx_image_t,
        pts: i64,
        duration: c_ulong,
        flags: c_long,
        deadline: c_ulong,
    ) -> c_int;

    pub fn vpx_codec_get_cx_data(
        ctx: *mut vpx_codec_ctx,
        iter: *mut vpx_codec_iter_t,
    ) -> *const vpx_codec_cx_pkt_t;

    pub fn vpx_codec_destroy(ctx: *mut vpx_codec_ctx) -> c_int;

    pub fn vpx_img_alloc(
        img: *mut vpx_image_t,
        fmt: c_uint,
        d_w: c_uint,
        d_h: c_uint,
        align: c_uint,
    ) -> *mut vpx_image_t;

    pub fn vpx_img_wrap(
        img: *mut vpx_image_t,
        fmt: c_uint,
        d_w: c_uint,
        d_h: c_uint,
        align: c_uint,
        img_data: *mut c_uchar,
    ) -> *mut vpx_image_t;

    pub fn vpx_img_free(img: *mut vpx_image_t);
}

pub const I420_STRIDE_ALIGN: usize = 16;
