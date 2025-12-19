use nserror::{nsresult, NS_OK};
use std::os::raw::c_void;
use thin_vec::ThinVec;

#[repr(C)]
pub struct VP8Metadata {
    vtable: *const c_void,
    ref_count: usize,
    width: i32,
    height: i32,
    display_width: i32,
    display_height: i32,
}

#[repr(C)]
pub struct EncodedFrame {
    vtable: *const c_void,
    ref_count: usize,
}

extern "C" {
    fn NS_NewWebMWriter(result: *mut *mut c_void) -> nsresult;
    fn WebMWriter_SetMetadata(
        writer: *mut c_void,
        metadata: *const *const c_void,
        metadata_count: usize,
    ) -> nsresult;
    fn WebMWriter_WriteEncodedTrack(
        writer: *mut c_void,
        frames: *const *const c_void,
        frame_count: usize,
        flags: u32,
    ) -> nsresult;
    fn WebMWriter_GetContainerData(
        writer: *mut c_void,
        output_bufs: *mut ThinVec<ThinVec<u8>>,
        flags: u32,
    ) -> nsresult;
    fn WebMWriter_Release(writer: *mut c_void);

    fn NS_NewVP8Metadata(
        width: i32,
        height: i32,
        display_width: i32,
        display_height: i32,
        result: *mut *mut c_void,
    ) -> nsresult;
    fn TrackMetadataBase_AddRef(metadata: *mut c_void);
    fn TrackMetadataBase_Release(metadata: *mut c_void);

    fn NS_NewEncodedFrame(
        time_us: i64,
        duration: u64,
        duration_base: u64,
        frame_type: u32,
        data: *const u8,
        data_len: usize,
        result: *mut *mut c_void,
    ) -> nsresult;
    fn EncodedFrame_AddRef(frame: *mut c_void);
    fn EncodedFrame_Release(frame: *mut c_void);
}

const VP8_I_FRAME: u32 = 0;
const VP8_P_FRAME: u32 = 1;
const GET_HEADER: u32 = 1 << 1;

pub struct WebMWriter {
    ptr: *mut c_void,
}

impl WebMWriter {
    pub fn new(width: i32, height: i32) -> Result<Self, nsresult> {
        unsafe {
            let mut writer_ptr: *mut c_void = std::ptr::null_mut();
            let rv = NS_NewWebMWriter(&mut writer_ptr);
            if rv != NS_OK {
                return Err(rv);
            }

            let mut metadata_ptr: *mut c_void = std::ptr::null_mut();
            let rv = NS_NewVP8Metadata(
                width,
                height,
                width,
                height,
                &mut metadata_ptr,
            );
            if rv != NS_OK {
                WebMWriter_Release(writer_ptr);
                return Err(rv);
            }

            let metadata_array = [metadata_ptr];
            let rv = WebMWriter_SetMetadata(
                writer_ptr,
                metadata_array.as_ptr() as *const *const c_void,
                1,
            );

            TrackMetadataBase_Release(metadata_ptr);

            if rv != NS_OK {
                WebMWriter_Release(writer_ptr);
                return Err(rv);
            }

            Ok(WebMWriter { ptr: writer_ptr })
        }
    }

    pub fn get_header(&self) -> Result<Vec<u8>, nsresult> {
        unsafe {
            let mut output_bufs = ThinVec::<ThinVec<u8>>::new();
            let rv = WebMWriter_GetContainerData(self.ptr, &mut output_bufs, GET_HEADER);
            if rv != NS_OK {
                eprintln!("WebMWriter::get_header: GetContainerData failed with rv={:?}", rv);
                return Err(rv);
            }

            let mut header = Vec::new();
            for buf in output_bufs.iter() {
                header.extend_from_slice(buf);
            }
            eprintln!("WebMWriter::get_header: Generated header of {} bytes", header.len());
            Ok(header)
        }
    }

    pub fn write_frame(
        &self,
        data: &[u8],
        timestamp_us: i64,
        is_keyframe: bool,
    ) -> Result<Vec<u8>, nsresult> {
        unsafe {
            let frame_type = if is_keyframe { VP8_I_FRAME } else { VP8_P_FRAME };
            let duration: u64 = 33333;
            let duration_base: u64 = 1_000_000;

            let mut frame_ptr: *mut c_void = std::ptr::null_mut();
            let rv = NS_NewEncodedFrame(
                timestamp_us,
                duration,
                duration_base,
                frame_type,
                data.as_ptr(),
                data.len(),
                &mut frame_ptr,
            );
            if rv != NS_OK {
                eprintln!("WebMWriter::write_frame: NS_NewEncodedFrame failed with rv={:?}", rv);
                return Err(rv);
            }

            let frames = [frame_ptr];
            let rv = WebMWriter_WriteEncodedTrack(
                self.ptr,
                frames.as_ptr() as *const *const c_void,
                1,
                0,
            );

            EncodedFrame_Release(frame_ptr);

            if rv != NS_OK {
                eprintln!("WebMWriter::write_frame: WriteEncodedTrack failed with rv={:?}", rv);
                return Err(rv);
            }

            let mut output_bufs = ThinVec::<ThinVec<u8>>::new();
            let rv = WebMWriter_GetContainerData(self.ptr, &mut output_bufs, 0);
            if rv != NS_OK {
                eprintln!("WebMWriter::write_frame: GetContainerData failed with rv={:?}", rv);
                return Err(rv);
            }

            let mut cluster = Vec::new();
            for buf in output_bufs.iter() {
                cluster.extend_from_slice(buf);
            }
            eprintln!("WebMWriter::write_frame: Generated cluster of {} bytes (keyframe={})", cluster.len(), is_keyframe);
            Ok(cluster)
        }
    }
}

impl Drop for WebMWriter {
    fn drop(&mut self) {
        unsafe {
            if !self.ptr.is_null() {
                WebMWriter_Release(self.ptr);
            }
        }
    }
}
