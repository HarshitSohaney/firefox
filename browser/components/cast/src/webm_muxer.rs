pub struct WebMMuxer {
    width: u32,
    height: u32,
    timecode_scale: u32,
    cluster_timecode: u64,
}

impl WebMMuxer {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            timecode_scale: 1_000_000,
            cluster_timecode: 0,
        }
    }

    pub fn get_header(&self) -> Vec<u8> {
        let mut header = Vec::new();

        self.write_ebml_header(&mut header);
        self.write_segment_header(&mut header);
        self.write_segment_info(&mut header);
        self.write_tracks(&mut header);

        header
    }

    pub fn wrap_frame(
        &mut self,
        vp8_data: &[u8],
        timestamp_ms: u64,
        keyframe: bool,
    ) -> Vec<u8> {
        let mut cluster = Vec::new();

        if keyframe || timestamp_ms - self.cluster_timecode > 10000 {
            println!("WebMMuxer: Writing cluster header at timestamp {}ms", timestamp_ms);
            self.write_cluster_header(&mut cluster, timestamp_ms);
            self.cluster_timecode = timestamp_ms;
        }

        println!("WebMMuxer: Writing SimpleBlock - VP8 size: {}, timestamp: {}ms, keyframe: {}, relative_timecode: {}",
                 vp8_data.len(), timestamp_ms, keyframe, (timestamp_ms - self.cluster_timecode) as i16);
        println!("  VP8 first 32 bytes: {:02x?}", &vp8_data[..vp8_data.len().min(32)]);

        self.write_simple_block(&mut cluster, vp8_data, timestamp_ms, keyframe);

        println!("  Cluster chunk size: {} bytes", cluster.len());
        println!("  Cluster first 32 bytes: {:02x?}", &cluster[..cluster.len().min(32)]);

        cluster
    }

    fn write_ebml_header(&self, out: &mut Vec<u8>) {
        self.write_element_id(out, 0x1A45DFA3);
        let header_data = self.build_ebml_header_data();
        self.write_element_size(out, header_data.len());
        out.extend_from_slice(&header_data);
    }

    fn build_ebml_header_data(&self) -> Vec<u8> {
        let mut data = Vec::new();

        self.write_element_id(&mut data, 0x4286);
        self.write_element_size(&mut data, 1);
        data.push(1);

        self.write_element_id(&mut data, 0x42F7);
        self.write_element_size(&mut data, 1);
        data.push(1);

        self.write_element_id(&mut data, 0x42F2);
        self.write_element_size(&mut data, 1);
        data.push(4);

        self.write_element_id(&mut data, 0x42F3);
        self.write_element_size(&mut data, 1);
        data.push(8);

        self.write_element_id(&mut data, 0x4282);
        let doctype = b"webm";
        self.write_element_size(&mut data, doctype.len());
        data.extend_from_slice(doctype);

        self.write_element_id(&mut data, 0x4287);
        self.write_element_size(&mut data, 1);
        data.push(2);

        self.write_element_id(&mut data, 0x4285);
        self.write_element_size(&mut data, 1);
        data.push(2);

        data
    }

    fn write_segment_header(&self, out: &mut Vec<u8>) {
        self.write_element_id(out, 0x18538067);
        out.push(0xFF);
    }

    fn write_segment_info(&self, out: &mut Vec<u8>) {
        self.write_element_id(out, 0x1549A966);
        let info_data = self.build_segment_info_data();
        self.write_element_size(out, info_data.len());
        out.extend_from_slice(&info_data);
    }

    fn build_segment_info_data(&self) -> Vec<u8> {
        let mut data = Vec::new();

        self.write_element_id(&mut data, 0x2AD7B1);
        self.write_element_size(&mut data, 4);
        data.extend_from_slice(&self.timecode_scale.to_be_bytes());

        self.write_element_id(&mut data, 0x4D80);
        let muxing_app = b"Firefox Cast";
        self.write_element_size(&mut data, muxing_app.len());
        data.extend_from_slice(muxing_app);

        self.write_element_id(&mut data, 0x5741);
        let writing_app = b"Firefox Cast";
        self.write_element_size(&mut data, writing_app.len());
        data.extend_from_slice(writing_app);

        data
    }

    fn write_tracks(&self, out: &mut Vec<u8>) {
        self.write_element_id(out, 0x1654AE6B);
        let tracks_data = self.build_tracks_data();
        self.write_element_size(out, tracks_data.len());
        out.extend_from_slice(&tracks_data);
    }

    fn build_tracks_data(&self) -> Vec<u8> {
        let mut data = Vec::new();

        self.write_element_id(&mut data, 0xAE);
        let track_data = self.build_track_entry();
        self.write_element_size(&mut data, track_data.len());
        data.extend_from_slice(&track_data);

        data
    }

    fn build_track_entry(&self) -> Vec<u8> {
        let mut data = Vec::new();

        self.write_element_id(&mut data, 0xD7);
        self.write_element_size(&mut data, 1);
        data.push(1);

        self.write_element_id(&mut data, 0x73C5);
        self.write_element_size(&mut data, 1);
        data.push(1);

        self.write_element_id(&mut data, 0x83);
        self.write_element_size(&mut data, 1);
        data.push(1);

        self.write_element_id(&mut data, 0x86);
        let codec_id = b"V_VP8";
        self.write_element_size(&mut data, codec_id.len());
        data.extend_from_slice(codec_id);

        self.write_element_id(&mut data, 0xE0);
        let video_data = self.build_video_track();
        self.write_element_size(&mut data, video_data.len());
        data.extend_from_slice(&video_data);

        data
    }

    fn build_video_track(&self) -> Vec<u8> {
        let mut data = Vec::new();

        self.write_element_id(&mut data, 0xB0);
        self.write_element_size(&mut data, std::mem::size_of::<u32>());
        data.extend_from_slice(&self.width.to_be_bytes());

        self.write_element_id(&mut data, 0xBA);
        self.write_element_size(&mut data, std::mem::size_of::<u32>());
        data.extend_from_slice(&self.height.to_be_bytes());

        data
    }

    fn write_cluster_header(&self, out: &mut Vec<u8>, timecode: u64) {
        self.write_element_id(out, 0x1F43B675);
        out.push(0xFF);

        self.write_element_id(out, 0xE7);
        self.write_element_size(out, 8);
        out.extend_from_slice(&timecode.to_be_bytes());
    }

    fn write_simple_block(
        &self,
        out: &mut Vec<u8>,
        data: &[u8],
        timestamp_ms: u64,
        keyframe: bool,
    ) {
        self.write_element_id(out, 0xA3);

        let relative_timecode = (timestamp_ms - self.cluster_timecode) as i16;

        let block_data_size = 4 + data.len();
        self.write_element_size(out, block_data_size);

        out.push(0x81);

        out.extend_from_slice(&relative_timecode.to_be_bytes());

        let flags = if keyframe { 0x80 } else { 0x00 };
        out.push(flags);

        out.extend_from_slice(data);
    }

    fn write_element_id(&self, out: &mut Vec<u8>, id: u32) {
        if id <= 0xFF {
            out.push(id as u8);
        } else if id <= 0xFFFF {
            out.extend_from_slice(&(id as u16).to_be_bytes());
        } else if id <= 0xFFFFFF {
            out.push((id >> 16) as u8);
            out.push((id >> 8) as u8);
            out.push(id as u8);
        } else {
            out.extend_from_slice(&id.to_be_bytes());
        }
    }

    fn write_element_size(&self, out: &mut Vec<u8>, size: usize) {
        if size < 127 {
            out.push(0x80 | (size as u8));
        } else if size < 16383 {
            out.push(0x40 | ((size >> 8) as u8));
            out.push(size as u8);
        } else if size < 2097151 {
            out.push(0x20 | ((size >> 16) as u8));
            out.push((size >> 8) as u8);
            out.push(size as u8);
        } else {
            out.push(0x10 | ((size >> 24) as u8));
            out.push((size >> 16) as u8);
            out.push((size >> 8) as u8);
            out.push(size as u8);
        }
    }
}
