use crate::vpx_ffi::*;
use crate::webm_muxer::WebMMuxer;
use libc::c_uint;
use nserror::{nsresult, NS_OK};
use std::cell::RefCell;
use thin_vec::ThinVec;
use xpcom::{xpcom_method, RefPtr};

#[xpcom::xpcom(implement(nsICastVideoEncoder), atomic)]
pub struct CastVideoEncoder {
    state: RefCell<EncoderState>,
}

struct EncoderState {
    vpx_ctx: Option<VpxContext>,
    muxer: Option<WebMMuxer>,
    width: u32,
    height: u32,
    frame_count: u64,
    fps: u32,
}

struct VpxContext {
    ctx: Box<vpx_codec_ctx>,
    img: vpx_image_t,
    img_buffer: Vec<u8>,
}

impl CastVideoEncoder {
    pub fn new() -> RefPtr<Self> {
        println!("CastVideoEncoder::new() called");
        CastVideoEncoder::allocate(InitCastVideoEncoder {
            state: RefCell::new(EncoderState {
                vpx_ctx: None,
                muxer: None,
                width: 0,
                height: 0,
                frame_count: 0,
                fps: 15,
            }),
        })
    }

    xpcom_method!(init => Init(width: u32, height: u32, bitrate: u32, fps: u32));
    fn init(&self, width: u32, height: u32, bitrate: u32, fps: u32) -> Result<(), nsresult> {
        println!("CastVideoEncoder::init called with {}x{} @ {}bps, {}fps", width, height, bitrate, fps);
        let mut state = self.state.borrow_mut();

        unsafe {
            println!("CastVideoEncoder: Getting VP8 encoder interface...");
            let iface = vpx_codec_vp8_cx();
            if iface.is_null() {
                println!("CastVideoEncoder: ERROR - vpx_codec_vp8_cx() returned null!");
                return Err(nserror::NS_ERROR_FAILURE);
            }
            println!("CastVideoEncoder: Got VP8 encoder interface successfully");

            let mut cfg: Box<vpx_codec_enc_cfg_t> = Box::new(std::mem::zeroed());

            println!("CastVideoEncoder: Getting default encoder config...");
            let ret = vpx_codec_enc_config_default(iface, cfg.as_mut(), 0);
            if ret != VPX_CODEC_OK {
                println!("CastVideoEncoder: ERROR - vpx_codec_enc_config_default failed with code: {}", ret);
                return Err(nserror::NS_ERROR_FAILURE);
            }
            println!("CastVideoEncoder: Got default config successfully");

            cfg.g_w = width;
            cfg.g_h = height;
            cfg.g_timebase.num = 1;
            cfg.g_timebase.den = 1000;
            cfg.rc_target_bitrate = bitrate / 1000;
            cfg.g_error_resilient = 1;
            cfg.g_lag_in_frames = 0;
            cfg.g_threads = 2;

            println!("CastVideoEncoder: Config set - {}x{}, bitrate {}kbps", width, height, bitrate / 1000);

            let mut ctx: Box<vpx_codec_ctx> = Box::new(std::mem::zeroed());

            println!("CastVideoEncoder: Initializing encoder with ABI version {}...", VPX_ENCODER_ABI_VERSION);
            let flags = 0;
            let ret = vpx_codec_enc_init_ver(
                ctx.as_mut(),
                iface,
                cfg.as_ref(),
                flags,
                VPX_ENCODER_ABI_VERSION,
            );
            if ret != VPX_CODEC_OK {
                println!("CastVideoEncoder: ERROR - vpx_codec_enc_init_ver failed with code: {}", ret);
                return Err(nserror::NS_ERROR_FAILURE);
            }
            println!("CastVideoEncoder: Encoder initialized successfully");

            println!("CastVideoEncoder: Allocating I420 buffer (matching libvpx's actual layout)...");
            let aligned = |v: u32, a: usize| -> usize {
                let v = v as usize;
                if v < a { a } else { (((v - 1) / a) + 1) * a }
            };

            let y_stride = aligned(width, I420_STRIDE_ALIGN);
            let y_size = y_stride * height as usize;
            let buffer_size = y_size * 3;

            let mut img_buffer = vec![0u8; buffer_size];
            let buffer_start = img_buffer.as_ptr() as usize;
            let buffer_end = buffer_start + buffer_size;
            println!("CastVideoEncoder: Allocated {} bytes for I420 buffer", buffer_size);
            println!("CastVideoEncoder: Buffer range: 0x{:x} - 0x{:x}", buffer_start, buffer_end);

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
                println!("CastVideoEncoder: ERROR - vpx_img_wrap failed!");
                vpx_codec_destroy(ctx.as_mut());
                return Err(nserror::NS_ERROR_OUT_OF_MEMORY);
            }

            println!("CastVideoEncoder: Image wrapped successfully");
            println!("CastVideoEncoder: Image planes - Y: {:?}, U: {:?}, V: {:?}",
                     img.planes[0], img.planes[1], img.planes[2]);
            println!("CastVideoEncoder: Image dimensions - {}x{}, stride: {:?}",
                     img.d_w, img.d_h, &img.stride[0..3]);

            let img_bytes = std::slice::from_raw_parts(
                &img as *const vpx_image_t as *const u8,
                std::mem::size_of::<vpx_image_t>()
            );
            println!("CastVideoEncoder: vpx_image_t raw bytes (first 100):");
            for chunk in img_bytes.chunks(16).take(7) {
                println!("  {:02x?}", chunk);
            }

            let y_ptr = img.planes[0] as usize;
            let u_ptr = img.planes[1] as usize;
            let v_ptr = img.planes[2] as usize;
            println!("CastVideoEncoder: Plane addresses - Y: 0x{:x}, U: 0x{:x}, V: 0x{:x}", y_ptr, u_ptr, v_ptr);
            if y_ptr < buffer_start || y_ptr >= buffer_end {
                println!("CastVideoEncoder: WARNING - Y plane outside buffer!");
            }
            if u_ptr < buffer_start || u_ptr >= buffer_end {
                println!("CastVideoEncoder: WARNING - U plane outside buffer!");
            }
            if v_ptr < buffer_start || v_ptr >= buffer_end {
                println!("CastVideoEncoder: WARNING - V plane outside buffer!");
            }

            let vpx_ctx = VpxContext { ctx, img, img_buffer };
            state.vpx_ctx = Some(vpx_ctx);
            state.muxer = Some(WebMMuxer::new(width, height));
            state.width = width;
            state.height = height;
            state.fps = fps;
        }

        println!("CastVideoEncoder: Init completed successfully!");
        Ok(())
    }

    xpcom_method!(encode_frame => EncodeFrame(rgba_data: *const ThinVec<u8>, force_keyframe: bool) -> ThinVec<u8>);
    fn encode_frame(
        &self,
        rgba_data: &ThinVec<u8>,
        force_keyframe: bool,
    ) -> Result<ThinVec<u8>, nsresult> {
        println!("CastVideoEncoder::encode_frame called, {} bytes", rgba_data.len());
        let mut state = self.state.borrow_mut();

        let width = state.width;
        let height = state.height;
        let fps = state.fps;
        let frame_count = state.frame_count;

        let expected_size = (width * height * 4) as usize;
        if rgba_data.len() != expected_size {
            println!("CastVideoEncoder: ERROR - Invalid size, expected {}, got {}", expected_size, rgba_data.len());
            return Err(nserror::NS_ERROR_INVALID_ARG);
        }

        let timestamp_ms = (frame_count * 1000) / (fps as u64);
        let should_force_kf = force_keyframe || frame_count % (fps as u64 * 2) == 0;
        let flags = if should_force_kf {
            VPX_EFLAG_FORCE_KF
        } else {
            0
        };

        if should_force_kf {
            println!("CastVideoEncoder: Forcing keyframe on frame {}", frame_count);
        }

        if state.vpx_ctx.is_none() || state.muxer.is_none() {
            println!("CastVideoEncoder: ERROR - Not initialized");
            return Err(nserror::NS_ERROR_NOT_INITIALIZED);
        }

        // println!("CastVideoEncoder: Converting RGBA to I420...");
        {
            let vpx_ctx = state.vpx_ctx.as_mut().unwrap();
            // println!("CastVideoEncoder: Before conversion, planes - Y: {:?}, U: {:?}, V: {:?}",
            //          vpx_ctx.img.planes[0], vpx_ctx.img.planes[1], vpx_ctx.img.planes[2]);
            rgba_to_i420(rgba_data, width, height, &mut vpx_ctx.img)?;
        }
        // println!("CastVideoEncoder: Conversion complete");

        let mut vp8_packets: Vec<(Vec<u8>, bool)> = Vec::new();

        // println!("CastVideoEncoder: Encoding frame {} at timestamp {}ms...", frame_count, timestamp_ms);
        unsafe {
            let vpx_ctx = state.vpx_ctx.as_mut().unwrap();

            // println!("CastVideoEncoder: Image before encode - fmt={}, w={}, h={}, d_w={}, d_h={}",
            //          vpx_ctx.img.fmt, vpx_ctx.img.w, vpx_ctx.img.h, vpx_ctx.img.d_w, vpx_ctx.img.d_h);
            // println!("CastVideoEncoder: Image strides BEFORE encode - Y={}, U={}, V={}",
            //          vpx_ctx.img.stride[0], vpx_ctx.img.stride[1], vpx_ctx.img.stride[2]);
            // println!("CastVideoEncoder: Image x_chroma_shift={}, y_chroma_shift={}",
            //          vpx_ctx.img.x_chroma_shift, vpx_ctx.img.y_chroma_shift);

            let ret = vpx_codec_encode(
                vpx_ctx.ctx.as_mut(),
                &vpx_ctx.img as *const vpx_image_t,
                timestamp_ms as i64,
                1000 / fps as u64,
                flags,
                VPX_DL_REALTIME,
            );

            if ret != VPX_CODEC_OK {
                println!("CastVideoEncoder: ERROR - vpx_codec_encode failed with code: {} (VPX_CODEC_INVALID_PARAM=8)", ret);
                return Err(nserror::NS_ERROR_FAILURE);
            }
            // println!("CastVideoEncoder: Encode successful, extracting packets...");

            let mut iter: vpx_codec_iter_t = std::mem::zeroed();
            let mut _packet_count = 0;

            loop {
                let pkt = vpx_codec_get_cx_data(vpx_ctx.ctx.as_mut(), &mut iter);
                if pkt.is_null() {
                    // println!("CastVideoEncoder: No more packets (got {} total)", packet_count);
                    break;
                }

                _packet_count += 1;
                // println!("CastVideoEncoder: Got packet {}, kind={}", packet_count, (*pkt).kind);

                if (*pkt).kind == VPX_CODEC_CX_FRAME_PKT {
                    let frame = &(*pkt).data.frame;
                    let vp8_data = std::slice::from_raw_parts(
                        frame.buf as *const u8,
                        frame.sz,
                    );
                    let is_keyframe = (frame.flags & 1) != 0;
                    println!("CastVideoEncoder: Got VP8 frame packet, {} bytes, keyframe={}, pts={}", frame.sz, is_keyframe, frame.pts);
                    println!("  First 32 bytes: {:02x?}", &vp8_data[..vp8_data.len().min(32)]);
                    vp8_packets.push((vp8_data.to_vec(), is_keyframe));
                } else {
                    // println!("CastVideoEncoder: Skipping non-frame packet");
                }
            }
        }
        // println!("CastVideoEncoder: Got {} VP8 frame packets total", vp8_packets.len());

        let mut result = ThinVec::new();
        // println!("CastVideoEncoder: Muxing to WebM...");
        let muxer = state.muxer.as_mut().unwrap();
        for (vp8_data, is_keyframe) in vp8_packets {
            let webm_cluster = muxer.wrap_frame(&vp8_data, timestamp_ms, is_keyframe);
            result.extend_from_slice(&webm_cluster);
        }

        state.frame_count += 1;
        // println!("CastVideoEncoder::encode_frame complete, returning {} bytes", result.len());
        Ok(result)
    }

    xpcom_method!(get_header => GetHeader() -> ThinVec<u8>);
    fn get_header(&self) -> Result<ThinVec<u8>, nsresult> {
        let state = self.state.borrow();
        let muxer = state.muxer.as_ref().ok_or(nserror::NS_ERROR_NOT_INITIALIZED)?;

        let header = muxer.get_header();

        println!("WebM header ({} bytes), first 128:", header.len());
        for chunk in header.chunks(32).take(4) {
            println!("  {:02x?}", chunk);
        }

        let mut result = ThinVec::with_capacity(header.len());
        result.extend_from_slice(&header);

        Ok(result)
    }

    xpcom_method!(dump_test_webm => DumpTestWebM(frames: u32));
    fn dump_test_webm(&self, frames: u32) -> Result<(), nsresult> {
        println!("DumpTestWebM: dumping {} frames to /tmp/test_webm.webm", frames);
        let state = self.state.borrow();

        if state.muxer.is_none() || state.vpx_ctx.is_none() {
            return Err(nserror::NS_ERROR_NOT_INITIALIZED);
        }
        drop(state);

        let header = self.get_header()?;
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(&header);

        let state = self.state.borrow();
        let width = state.width as usize;
        let height = state.height as usize;
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
            let cluster = self.encode_frame(&rgba_thin, i == 0)?;
            out.extend_from_slice(&cluster);
        }

        use std::fs::File;
        use std::io::Write;
        let mut f = File::create("/tmp/test_webm.webm").map_err(|_| nserror::NS_ERROR_FAILURE)?;
        f.write_all(&out).map_err(|_| nserror::NS_ERROR_FAILURE)?;
        f.flush().map_err(|_| nserror::NS_ERROR_FAILURE)?;
        println!("DumpTestWebM: wrote /tmp/test_webm.webm ({} bytes)", out.len());
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
        // println!("rgba_to_i420: width={}, height={}", width, height);
        // println!("rgba_to_i420: img dimensions - w={}, h={}, d_w={}, d_h={}",
        //          img.w, img.h, img.d_w, img.d_h);
        // println!("rgba_to_i420: strides - Y={}, U={}, V={}",
        //          img.stride[0], img.stride[1], img.stride[2]);

        if img.planes[0].is_null() || img.planes[1].is_null() || img.planes[2].is_null() {
            println!("rgba_to_i420: ERROR - Image planes are null!");
            return Err(nserror::NS_ERROR_NOT_INITIALIZED);
        }

        let y_stride = img.stride[0] as usize;
        let u_stride = img.stride[1] as usize;
        let _v_stride = img.stride[2] as usize;

        let y_plane_size = y_stride * height as usize;
        let uv_plane_size = u_stride * ((height + 1) / 2) as usize;

        // println!("rgba_to_i420: Creating Y slice - ptr: {:?}, size: {}", img.planes[0], y_plane_size);
        let y_plane = std::slice::from_raw_parts_mut(img.planes[0], y_plane_size);
        // println!("rgba_to_i420: Y slice created");

        // println!("rgba_to_i420: Creating U slice - ptr: {:?}, size: {}", img.planes[1], uv_plane_size);
        let u_plane = std::slice::from_raw_parts_mut(img.planes[1], uv_plane_size);
        // println!("rgba_to_i420: U slice created");

        // println!("rgba_to_i420: Creating V slice - ptr: {:?}, size: {}", img.planes[2], uv_plane_size);
        let v_plane = std::slice::from_raw_parts_mut(img.planes[2], uv_plane_size);
        // println!("rgba_to_i420: V slice created");

        // println!("rgba_to_i420: Starting conversion loop...");
        for y in 0..height {
            // if y % 100 == 0 {
            //     println!("rgba_to_i420: Processing row {}/{}", y, height);
            // }
            for x in 0..width {
                let rgba_idx = ((y * width + x) * 4) as usize;
                let r = rgba[rgba_idx] as f32;
                let g = rgba[rgba_idx + 1] as f32;
                let b = rgba[rgba_idx + 2] as f32;

                let y_val = (0.299 * r + 0.587 * g + 0.114 * b) as u8;
                let y_idx = y as usize * y_stride + x as usize;
                y_plane[y_idx] = y_val;

                if x % 2 == 0 && y % 2 == 0 {
                    let u_val = ((-0.169 * r - 0.331 * g + 0.500 * b) + 128.0) as u8;
                    let v_val = ((0.500 * r - 0.419 * g - 0.081 * b) + 128.0) as u8;

                    let uv_y = (y / 2) as usize;
                    let uv_x = (x / 2) as usize;
                    let uv_idx = uv_y * u_stride + uv_x;

                    u_plane[uv_idx] = u_val;
                    v_plane[uv_idx] = v_val;
                }
            }
        }
        // println!("rgba_to_i420: Conversion loop completed");
    }

    Ok(())
}
