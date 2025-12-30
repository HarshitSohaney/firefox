/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::vpx_ffi::*;
use crate::webm_writer_ffi::WebMWriter;
use libc::c_uint;
use nserror::{nsresult, NS_OK};
use std::cell::RefCell;
use thin_vec::ThinVec;
use xpcom::{xpcom_method, RefPtr};

/// XPCOM video encoder component using VP9 codec.
/// Encodes RGBA frames to VP9 and wraps them in WebM container format.
#[xpcom::xpcom(implement(nsICastVideoEncoder), atomic)]
pub struct CastVideoEncoder {
    state: RefCell<EncoderState>,
}

/// Internal encoder state including VP9 context and WebM muxer.
struct EncoderState {
    vpx_ctx: Option<VpxContext>,
    muxer: Option<WebMWriter>,
    cached_header: Vec<u8>,
    width: u32,
    height: u32,
    frame_count: u64,
    fps: u32,
}

/// VP9 encoder context with image buffer for frame data.
struct VpxContext {
    ctx: Box<vpx_codec_ctx>,
    img: vpx_image_t,
    img_buffer: Vec<u8>,
}

impl CastVideoEncoder {
    pub fn new() -> RefPtr<Self> {
        CastVideoEncoder::allocate(InitCastVideoEncoder {
            state: RefCell::new(EncoderState {
                vpx_ctx: None,
                muxer: None,
                cached_header: Vec::new(),
                width: 0,
                height: 0,
                frame_count: 0,
                fps: 15,
            }),
        })
    }

    xpcom_method!(init => Init(width: u32, height: u32, bitrate: u32, fps: u32));
    fn init(&self, width: u32, height: u32, bitrate: u32, fps: u32) -> Result<(), nsresult> {
        let mut state = self.state.borrow_mut();

        unsafe {
            let iface = vpx_codec_vp8_cx();
            if iface.is_null() {
                eprintln!("CastVideoEncoder: vpx_codec_vp8_cx() returned null");
                return Err(nserror::NS_ERROR_FAILURE);
            }

            let mut cfg: Box<vpx_codec_enc_cfg_t> = Box::new(std::mem::zeroed());

            let ret = vpx_codec_enc_config_default(iface, cfg.as_mut(), 0);
            if ret != VPX_CODEC_OK {
                eprintln!(
                    "CastVideoEncoder: vpx_codec_enc_config_default failed: {}",
                    ret
                );
                return Err(nserror::NS_ERROR_FAILURE);
            }

            cfg.g_w = width;
            cfg.g_h = height;
            cfg.g_timebase.num = 1;
            cfg.g_timebase.den = 1000;
            cfg.rc_target_bitrate = bitrate / 1000;
            cfg.g_error_resilient = 1;
            cfg.g_lag_in_frames = 0;
            cfg.g_threads = 2;
            cfg.rc_end_usage = VPX_VBR;
            cfg.rc_min_quantizer = 4;
            cfg.rc_max_quantizer = 48;
            cfg.kf_mode = VPX_KF_AUTO;
            cfg.kf_max_dist = fps * 2;

            let mut ctx: Box<vpx_codec_ctx> = Box::new(std::mem::zeroed());

            let flags = 0;
            let ret = vpx_codec_enc_init_ver(
                ctx.as_mut(),
                iface,
                cfg.as_ref(),
                flags,
                VPX_ENCODER_ABI_VERSION,
            );
            if ret != VPX_CODEC_OK {
                eprintln!("CastVideoEncoder: vpx_codec_enc_init_ver failed: {}", ret);
                return Err(nserror::NS_ERROR_FAILURE);
            }

            vpx_codec_control(ctx.as_mut(), VP8E_SET_CPUUSED, -5);
            vpx_codec_control(ctx.as_mut(), VP8E_SET_STATIC_THRESHOLD, 0);
            vpx_codec_control(ctx.as_mut(), VP8E_SET_TOKEN_PARTITIONS, 2);

            let aligned = |v: u32, a: usize| -> usize {
                let v = v as usize;
                if v < a {
                    a
                } else {
                    (((v - 1) / a) + 1) * a
                }
            };

            let y_stride = aligned(width, I420_STRIDE_ALIGN);
            let y_size = y_stride * height as usize;
            let buffer_size = y_size * 3;

            let mut img_buffer = vec![0u8; buffer_size];

            let mut img: vpx_image_t = std::mem::zeroed();
            let img_ptr = vpx_img_wrap(
                &mut img as *mut vpx_image_t,
                VPX_IMG_FMT_I420,
                width,
                height,
                I420_STRIDE_ALIGN as c_uint,
                img_buffer.as_mut_ptr(),
            );

            if img_ptr.is_null() {
                vpx_codec_destroy(ctx.as_mut());
                return Err(nserror::NS_ERROR_OUT_OF_MEMORY);
            }

            let vpx_ctx = VpxContext {
                ctx,
                img,
                img_buffer,
            };
            state.vpx_ctx = Some(vpx_ctx);

            let muxer = WebMWriter::new(width as i32, height as i32)
                .map_err(|_| nserror::NS_ERROR_FAILURE)?;

            let header = muxer.get_header().map_err(|_| nserror::NS_ERROR_FAILURE)?;
            eprintln!(
                "CastVideoEncoder::init: Cached header of {} bytes",
                header.len()
            );

            state.cached_header = header;
            state.muxer = Some(muxer);
            state.width = width;
            state.height = height;
            state.fps = fps;
        }

        Ok(())
    }

    /// Encode a single RGBA frame to VP9 and wrap in WebM cluster.
    ///
    /// Frame Encoding Pipeline:
    /// 1. Input: RGBA pixels (width * height * 4 bytes)
    /// 2. Convert RGBA to I420 planar YUV format for VP9
    /// 3. Encode with VP9 codec (target bitrate, keyframe control)
    /// 4. Wrap compressed frame in WebM cluster container
    /// 5. Output: WebM cluster bytes ready for HTTP streaming
    ///
    /// VP9 Encoding:
    /// - Uses libvpx VP9 encoder
    /// - Configured for low-latency (no B-frames)
    /// - Variable bitrate with target bitrate from init()
    /// - Keyframes forced periodically or on demand
    ///
    /// WebM Container:
    /// - Each frame becomes a WebM Cluster element
    /// - Cluster contains: timestamp + SimpleBlock (compressed frame)
    /// - Cast device parses clusters to extract VP9 frames
    ///
    /// Buffer Flow:
    /// RGBA Array -> I420 Buffer -> VP9 Encoder -> Compressed Frame -> WebM Writer -> Cluster Bytes
    ///
    /// @param rgba_data RGBA pixel buffer (width * height * 4 bytes)
    /// @param force_keyframe True to force this frame to be a keyframe
    /// @param timestamp_ms Presentation timestamp in milliseconds
    /// @returns WebM cluster containing the encoded frame
    xpcom_method!(encode_frame => EncodeFrame(rgba_data: *const ThinVec<u8>, force_keyframe: bool, timestamp_ms: i64) -> ThinVec<u8>);
    fn encode_frame(
        &self,
        rgba_data: &ThinVec<u8>,
        force_keyframe: bool,
        timestamp_ms: i64,
    ) -> Result<ThinVec<u8>, nsresult> {
        let mut state = self.state.borrow_mut();

        let width = state.width;
        let height = state.height;
        let fps = state.fps;
        let frame_count = state.frame_count;

        let expected_size = (width * height * 4) as usize;
        if rgba_data.len() != expected_size {
            eprintln!(
                "CastVideoEncoder: Invalid frame size, expected {}, got {}",
                expected_size,
                rgba_data.len()
            );
            return Err(nserror::NS_ERROR_INVALID_ARG);
        }

        if frame_count % 60 == 0 {
            eprintln!(
                "CastVideoEncoder: Frame {}: timestamp_ms={}",
                frame_count, timestamp_ms
            );
        }

        let should_force_kf = force_keyframe || frame_count % (fps as u64 * 2) == 0;
        let flags = if should_force_kf {
            VPX_EFLAG_FORCE_KF
        } else {
            0
        };

        if state.vpx_ctx.is_none() || state.muxer.is_none() {
            return Err(nserror::NS_ERROR_NOT_INITIALIZED);
        }

        {
            // Convert RGBA to I420 planar YUV format
            // RGBA input: [R,G,B,A,R,G,B,A,...] (4 bytes per pixel)
            // I420 output: [Y...Y, U...U, V...V] (3 planes, 1.5 bytes per pixel)
            // This conversion is required by VP9 which operates on YUV color space
            let vpx_ctx = state.vpx_ctx.as_mut().unwrap();
            rgba_to_i420(rgba_data, width, height, &mut vpx_ctx.img)?;
        }

        // Collect compressed VP9 packets from encoder
        // May produce multiple packets per frame
        let mut vp8_packets: Vec<(Vec<u8>, bool)> = Vec::new();

        unsafe {
            let vpx_ctx = state.vpx_ctx.as_mut().unwrap();

            let ret = vpx_codec_encode(
                vpx_ctx.ctx.as_mut(),
                &vpx_ctx.img as *const vpx_image_t,
                timestamp_ms as i64,
                1000 / fps as u64,
                flags,
                VPX_DL_REALTIME,
            );

            if ret != VPX_CODEC_OK {
                eprintln!("CastVideoEncoder: vpx_codec_encode failed: {}", ret);
                return Err(nserror::NS_ERROR_FAILURE);
            }

            let mut iter: vpx_codec_iter_t = std::mem::zeroed();

            loop {
                let pkt = vpx_codec_get_cx_data(vpx_ctx.ctx.as_mut(), &mut iter);
                if pkt.is_null() {
                    break;
                }

                if (*pkt).kind == VPX_CODEC_CX_FRAME_PKT {
                    let frame = &(*pkt).data.frame;
                    let vp8_data = std::slice::from_raw_parts(frame.buf as *const u8, frame.sz);
                    let is_keyframe = (frame.flags & 1) != 0;
                    vp8_packets.push((vp8_data.to_vec(), is_keyframe));
                }
            }
        }

        // Wrap VP9 frames in WebM container format
        // Each frame becomes a WebM Cluster that can be streamed individually
        let mut result = ThinVec::new();
        let muxer = state.muxer.as_ref().unwrap();
        for (vp8_data, is_keyframe) in vp8_packets {
            let timestamp_us = (timestamp_ms * 1000) as i64;
            let webm_cluster = muxer
                .write_frame(&vp8_data, timestamp_us, is_keyframe)
                .map_err(|_| nserror::NS_ERROR_FAILURE)?;
            result.extend_from_slice(&webm_cluster);
        }

        state.frame_count += 1;
        Ok(result)
    }

    xpcom_method!(get_header => GetHeader() -> ThinVec<u8>);
    fn get_header(&self) -> Result<ThinVec<u8>, nsresult> {
        let state = self.state.borrow();

        if state.cached_header.is_empty() {
            eprintln!("CastVideoEncoder::get_header: ERROR - No cached header!");
            return Err(nserror::NS_ERROR_NOT_INITIALIZED);
        }

        eprintln!(
            "CastVideoEncoder::get_header: Returning cached header of {} bytes",
            state.cached_header.len()
        );
        let mut result = ThinVec::with_capacity(state.cached_header.len());
        result.extend_from_slice(&state.cached_header);

        Ok(result)
    }

    xpcom_method!(dump_test_webm => DumpTestWebM(frames: u32));
    fn dump_test_webm(&self, frames: u32) -> Result<(), nsresult> {
        eprintln!(
            "DumpTestWebM: Starting dump of {} frames to /tmp/test_webm.webm",
            frames
        );

        let state = self.state.borrow();

        if state.muxer.is_none() || state.vpx_ctx.is_none() {
            eprintln!("DumpTestWebM: ERROR - encoder not initialized");
            return Err(nserror::NS_ERROR_NOT_INITIALIZED);
        }
        drop(state);

        let header = self.get_header()?;
        eprintln!("DumpTestWebM: Got header of {} bytes", header.len());
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(&header);

        let state = self.state.borrow();
        let width = state.width as usize;
        let height = state.height as usize;
        let fps = state.fps;
        drop(state);

        let frame_size = width * height * 4;
        let mut rgba = vec![0u8; frame_size];

        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 4;
                rgba[i] = (x % 256) as u8;
                rgba[i + 1] = (y % 256) as u8;
                rgba[i + 2] = ((x + y) % 256) as u8;
                rgba[i + 3] = 255;
            }
        }

        let rgba_thin = ThinVec::from(rgba);
        for i in 0..frames {
            eprintln!("DumpTestWebM: Encoding frame {}/{}", i + 1, frames);
            let timestamp_ms = ((i as u64) * 1000) / (fps as u64);
            let cluster = self.encode_frame(&rgba_thin, i == 0, timestamp_ms as i64)?;
            eprintln!(
                "DumpTestWebM: Frame {} generated {} bytes",
                i + 1,
                cluster.len()
            );
            out.extend_from_slice(&cluster);
        }

        use std::fs::File;
        use std::io::Write;
        eprintln!(
            "DumpTestWebM: Writing {} bytes to /tmp/test_webm.webm",
            out.len()
        );
        let mut f = File::create("/tmp/test_webm.webm").map_err(|e| {
            eprintln!("DumpTestWebM: ERROR - Failed to create file: {:?}", e);
            nserror::NS_ERROR_FAILURE
        })?;
        f.write_all(&out).map_err(|e| {
            eprintln!("DumpTestWebM: ERROR - Failed to write file: {:?}", e);
            nserror::NS_ERROR_FAILURE
        })?;
        f.flush().map_err(|e| {
            eprintln!("DumpTestWebM: ERROR - Failed to flush file: {:?}", e);
            nserror::NS_ERROR_FAILURE
        })?;
        eprintln!("DumpTestWebM: Successfully wrote /tmp/test_webm.webm");
        Ok(())
    }

    xpcom_method!(shutdown => Shutdown());
    fn shutdown(&self) -> Result<(), nsresult> {
        let mut state = self.state.borrow_mut();

        if let Some(_vpx_ctx) = state.vpx_ctx.take() {
            // VpxContext Drop will handle cleanup
        }

        state.muxer = None;
        Ok(())
    }
}

impl Drop for VpxContext {
    fn drop(&mut self) {
        unsafe {
            vpx_codec_destroy(self.ctx.as_mut());
        }
    }
}

fn rgba_to_i420(
    rgba: &[u8],
    width: u32,
    height: u32,
    img: &mut vpx_image_t,
) -> Result<(), nsresult> {
    unsafe {
        if img.planes[0].is_null() || img.planes[1].is_null() || img.planes[2].is_null() {
            return Err(nserror::NS_ERROR_NOT_INITIALIZED);
        }

        let y_stride = img.stride[0] as usize;
        let u_stride = img.stride[1] as usize;

        let y_plane_size = y_stride * height as usize;
        let uv_plane_size = u_stride * ((height + 1) / 2) as usize;

        let y_plane = std::slice::from_raw_parts_mut(img.planes[0], y_plane_size);
        let u_plane = std::slice::from_raw_parts_mut(img.planes[1], uv_plane_size);
        let v_plane = std::slice::from_raw_parts_mut(img.planes[2], uv_plane_size);

        for y in 0..height {
            for x in 0..width {
                let rgba_idx = ((y * width + x) * 4) as usize;
                let r = rgba[rgba_idx] as i32;
                let g = rgba[rgba_idx + 1] as i32;
                let b = rgba[rgba_idx + 2] as i32;

                let y_val = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
                let y_idx = y as usize * y_stride + x as usize;
                y_plane[y_idx] = y_val.clamp(16, 235) as u8;

                if x % 2 == 0 && y % 2 == 0 {
                    let u_val = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
                    let v_val = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;

                    let uv_y = (y / 2) as usize;
                    let uv_x = (x / 2) as usize;
                    let uv_idx = uv_y * u_stride + uv_x;

                    u_plane[uv_idx] = u_val.clamp(16, 240) as u8;
                    v_plane[uv_idx] = v_val.clamp(16, 240) as u8;
                }
            }
        }
    }

    Ok(())
}
