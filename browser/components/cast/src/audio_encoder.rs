/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use nserror::{nsresult, NS_OK};
use std::cell::RefCell;
use std::os::raw::c_void;
use thin_vec::ThinVec;
use xpcom::{xpcom_method, RefPtr};

extern "C" {
    fn CastOpusEncoder_Create(
        sample_rate: u32,
        channels: u32,
        bitrate: u32,
        result: *mut *mut c_void,
    ) -> nsresult;
    fn CastOpusEncoder_Destroy(encoder: *mut c_void);
    fn CastOpusEncoder_GetLookahead(encoder: *mut c_void) -> u32;
    fn CastOpusEncoder_GetChannels(encoder: *mut c_void) -> u32;
    fn CastOpusEncoder_GetSampleRate(encoder: *mut c_void) -> u32;
    fn CastOpusEncoder_GetFrameSize(encoder: *mut c_void) -> i32;
    fn CastOpusEncoder_Encode(
        encoder: *mut c_void,
        pcm_data: *const f32,
        sample_count: usize,
        output: *mut u8,
        output_capacity: usize,
        output_len: *mut usize,
    ) -> nsresult;
    fn CastOpusEncoder_Flush(
        encoder: *mut c_void,
        output: *mut u8,
        output_capacity: usize,
        output_len: *mut usize,
    ) -> nsresult;
}

const MAX_OPUS_PACKET_SIZE: usize = 4096;

#[xpcom::xpcom(implement(nsICastAudioEncoder), atomic)]
pub struct CastAudioEncoder {
    state: RefCell<AudioEncoderState>,
}

struct AudioEncoderState {
    encoder_ptr: *mut c_void,
    channels: u32,
    sample_rate: u32,
    lookahead: u32,
}

impl CastAudioEncoder {
    pub fn new() -> RefPtr<Self> {
        CastAudioEncoder::allocate(InitCastAudioEncoder {
            state: RefCell::new(AudioEncoderState {
                encoder_ptr: std::ptr::null_mut(),
                channels: 0,
                sample_rate: 0,
                lookahead: 0,
            }),
        })
    }

    xpcom_method!(init => Init(sample_rate: u32, channels: u32, bitrate: u32));
    fn init(&self, sample_rate: u32, channels: u32, bitrate: u32) -> Result<(), nsresult> {
        let mut state = self.state.borrow_mut();

        if !state.encoder_ptr.is_null() {
            return Err(nserror::NS_ERROR_ALREADY_INITIALIZED);
        }

        unsafe {
            let mut encoder_ptr: *mut c_void = std::ptr::null_mut();
            let rv = CastOpusEncoder_Create(sample_rate, channels, bitrate, &mut encoder_ptr);
            if rv != NS_OK {
                eprintln!("CastAudioEncoder: Failed to create Opus encoder");
                return Err(rv);
            }

            state.encoder_ptr = encoder_ptr;
            state.channels = CastOpusEncoder_GetChannels(encoder_ptr);
            state.sample_rate = CastOpusEncoder_GetSampleRate(encoder_ptr);
            state.lookahead = CastOpusEncoder_GetLookahead(encoder_ptr);

            eprintln!(
                "CastAudioEncoder: Initialized {}ch@{}Hz, lookahead={}",
                state.channels, state.sample_rate, state.lookahead
            );
        }

        Ok(())
    }

    xpcom_method!(encode_frame => EncodeFrame(pcm_data: *const ThinVec<u8>, timestamp_ms: i64) -> ThinVec<u8>);
    fn encode_frame(
        &self,
        pcm_data: &ThinVec<u8>,
        _timestamp_ms: i64,
    ) -> Result<ThinVec<u8>, nsresult> {
        let state = self.state.borrow();

        if state.encoder_ptr.is_null() {
            return Err(nserror::NS_ERROR_NOT_INITIALIZED);
        }

        if pcm_data.len() % 4 != 0 {
            eprintln!(
                "CastAudioEncoder: Invalid PCM data size {}, must be multiple of 4 (float32)",
                pcm_data.len()
            );
            return Err(nserror::NS_ERROR_INVALID_ARG);
        }

        let float_data = unsafe {
            std::slice::from_raw_parts(pcm_data.as_ptr() as *const f32, pcm_data.len() / 4)
        };

        let mut output = vec![0u8; MAX_OPUS_PACKET_SIZE];
        let mut output_len: usize = 0;

        unsafe {
            let rv = CastOpusEncoder_Encode(
                state.encoder_ptr,
                float_data.as_ptr(),
                float_data.len(),
                output.as_mut_ptr(),
                output.len(),
                &mut output_len,
            );

            if rv != NS_OK {
                eprintln!("CastAudioEncoder: Encode failed");
                return Err(rv);
            }
        }

        let mut result = ThinVec::with_capacity(output_len);
        result.extend_from_slice(&output[..output_len]);
        Ok(result)
    }

    xpcom_method!(flush => Flush(timestamp_ms: i64) -> ThinVec<u8>);
    fn flush(&self, _timestamp_ms: i64) -> Result<ThinVec<u8>, nsresult> {
        let state = self.state.borrow();

        if state.encoder_ptr.is_null() {
            return Ok(ThinVec::new());
        }

        let mut output = vec![0u8; MAX_OPUS_PACKET_SIZE];
        let mut output_len: usize = 0;

        unsafe {
            let rv = CastOpusEncoder_Flush(
                state.encoder_ptr,
                output.as_mut_ptr(),
                output.len(),
                &mut output_len,
            );

            if rv != NS_OK {
                return Ok(ThinVec::new());
            }
        }

        let mut result = ThinVec::with_capacity(output_len);
        result.extend_from_slice(&output[..output_len]);
        Ok(result)
    }

    xpcom_method!(get_lookahead => GetLookahead() -> u32);
    fn get_lookahead(&self) -> Result<u32, nsresult> {
        let state = self.state.borrow();
        Ok(state.lookahead)
    }

    xpcom_method!(get_channels => GetChannels() -> u32);
    fn get_channels(&self) -> Result<u32, nsresult> {
        let state = self.state.borrow();
        Ok(state.channels)
    }

    xpcom_method!(get_sample_rate => GetSampleRate() -> u32);
    fn get_sample_rate(&self) -> Result<u32, nsresult> {
        let state = self.state.borrow();
        Ok(state.sample_rate)
    }

    xpcom_method!(shutdown => Shutdown());
    fn shutdown(&self) -> Result<(), nsresult> {
        let mut state = self.state.borrow_mut();

        if !state.encoder_ptr.is_null() {
            unsafe {
                CastOpusEncoder_Destroy(state.encoder_ptr);
            }
            state.encoder_ptr = std::ptr::null_mut();
        }

        Ok(())
    }
}

impl Drop for AudioEncoderState {
    fn drop(&mut self) {
        if !self.encoder_ptr.is_null() {
            unsafe {
                CastOpusEncoder_Destroy(self.encoder_ptr);
            }
        }
    }
}
