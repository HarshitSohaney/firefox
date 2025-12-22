# Video Encoding Concepts

A comprehensive guide to video encoding concepts used in Firefox Cast, designed for developers new to media programming.

## Table of Contents

- [Video Encoding Basics](#video-encoding-basics)
- [Color Spaces](#color-spaces)
- [Video Codecs](#video-codecs)
- [Container Formats](#container-formats)
- [WebM Muxing](#webm-muxing)
- [Compression Techniques](#compression-techniques)
- [Real-time Encoding](#real-time-encoding)

---

## Video Encoding Basics

### What is Video Encoding?

Video encoding is the process of converting raw pixel data into a compressed format suitable for storage or transmission.

**Why compress?**
- Raw video is HUGE
- 1 second of 1280×720 @ 24fps RGB:
  ```
  1280 × 720 × 3 (RGB) × 24 frames = 66,355,200 bytes = 63 MB/sec
  ```
- Compressed (VP8 @ 4 Mbps):
  ```
  4,000,000 bits/sec ÷ 8 = 500,000 bytes = 488 KB/sec
  ```
- **Compression ratio: ~129:1**

### Encoding Pipeline

```
Raw Pixels (RGB/RGBA)
  ↓ Color space conversion
YUV (I420)
  ↓ Block-based transform
Frequency domain (DCT)
  ↓ Quantization
Compressed coefficients
  ↓ Entropy coding
Bitstream (VP8/H.264/etc.)
  ↓ Muxing
Container (WebM/MP4/etc.)
```

---

## Color Spaces

### RGB vs YUV

#### RGB Color Space

**What it is:**
- Red, Green, Blue components
- Each pixel has 3 values (or 4 with Alpha)
- Natural for displays and cameras

**Example pixel:**
```
Red:   255 (0xFF)
Green: 128 (0x80)
Blue:   64 (0x40)
Alpha: 255 (0xFF) - fully opaque
```

**Memory layout (1280×720 RGBA):**
```
Byte 0:   R (pixel 0,0)
Byte 1:   G (pixel 0,0)
Byte 2:   B (pixel 0,0)
Byte 3:   A (pixel 0,0)
Byte 4:   R (pixel 1,0)
...
Total: 1280 × 720 × 4 = 3,686,400 bytes
```

#### YUV Color Space

**What it is:**
- Y = Luma (brightness)
- U = Chroma blue (Cb)
- V = Chroma red (Cr)
- Separates brightness from color

**Why use YUV?**
1. **Human vision** - More sensitive to brightness than color
2. **Compression** - Can reduce color resolution without visible loss
3. **Video codecs** - VP8, H.264, etc. all work in YUV

**Conversion formulas (RGB → YUV):**
```
Y =  0.299×R + 0.587×G + 0.114×B
U = -0.169×R - 0.331×G + 0.500×B + 128
V =  0.500×R - 0.419×G - 0.081×B + 128
```

**Example:**
```
Input:  R=255, G=128, B=64
Output: Y=161, U=86, V=179
```

**File:** `browser/components/cast/src/video_encoder.rs:348-354`

```rust
let y_val = (0.299 * r + 0.587 * g + 0.114 * b) as u8;
let u_val = ((-0.169 * r - 0.331 * g + 0.500 * b) + 128.0) as u8;
let v_val = ((0.500 * r - 0.419 * g - 0.081 * b) + 128.0) as u8;
```

### Chroma Subsampling

#### 4:4:4 - No Subsampling

```
Y Y Y Y    U U U U    V V V V
Y Y Y Y    U U U U    V V V V
Y Y Y Y    U U U U    V V V V
Y Y Y Y    U U U U    V V V V

All planes: Full resolution
```

#### 4:2:2 - Horizontal Subsampling

```
Y Y Y Y    U   U      V   V
Y Y Y Y    U   U      V   V
Y Y Y Y    U   U      V   V
Y Y Y Y    U   U      V   V

Y: Full width, full height
U/V: Half width, full height
```

#### 4:2:0 - Horizontal & Vertical Subsampling (What we use!)

```
Y Y Y Y    U     V
Y Y Y Y
Y Y Y Y    U     V
Y Y Y Y

Y: Full width, full height (1280×720)
U: Half width, half height (640×360)
V: Half width, half height (640×360)
```

**I420 memory layout (1280×720):**
```
[Y plane: 1280×720 = 921,600 bytes]
  Y Y Y Y Y Y ...
  Y Y Y Y Y Y ...
  ...

[U plane: 640×360 = 230,400 bytes]
  U U U ...
  U U U ...
  ...

[V plane: 640×360 = 230,400 bytes]
  V V V ...
  V V V ...
  ...

Total: 921,600 + 230,400 + 230,400 = 1,382,400 bytes
```

**Comparison:**
- RGB (1280×720): 2,764,800 bytes (1280×720×3)
- I420 (1280×720): 1,382,400 bytes (50% smaller!)

**Why 4:2:0?**
- Human eye less sensitive to color than brightness
- 50% smaller than 4:4:4
- Minimal perceptual quality loss
- Standard for VP8, H.264, most codecs

**File:** `browser/components/cast/src/video_encoder.rs:341-363`

```rust
// Convert RGBA to I420
for y in 0..height {
  for x in 0..width {
    // Every pixel gets Y (luma)
    let y_val = (0.299 * r + 0.587 * g + 0.114 * b) as u8;
    y_plane[y * y_stride + x] = y_val;

    // Only even pixels (x%2==0, y%2==0) get U/V (chroma)
    if x % 2 == 0 && y % 2 == 0 {
      let u_val = ((-0.169 * r - 0.331 * g + 0.500 * b) + 128.0) as u8;
      let v_val = ((0.500 * r - 0.419 * g - 0.081 * b) + 128.0) as u8;

      u_plane[(y/2) * u_stride + (x/2)] = u_val;
      v_plane[(y/2) * v_stride + (x/2)] = v_val;
    }
  }
}
```

---

## Video Codecs

### What is a Codec?

**Codec** = **Co**der/**Dec**oder

A codec is an algorithm that:
- **Encodes**: Compresses raw video into bitstream
- **Decodes**: Decompresses bitstream back to pixels

### VP8 Codec

**File:** `browser/components/cast/src/video_encoder.rs:50-86`

#### Overview

- Developed by On2 Technologies
- Acquired and open-sourced by Google (2010)
- Royalty-free (no licensing fees)
- Used in WebRTC, WebM, Cast protocol

#### VP8 Architecture

**Key concepts:**

1. **Block-based encoding**
   - Divides frame into 16×16 macroblocks
   - Each macroblock subdivided into 4×4 or 8×8 blocks

2. **Intra-frame compression (I-frames/keyframes)**
   - Encoded independently (no reference to other frames)
   - Uses spatial prediction within frame
   - Larger size (~20-50 KB for 720p)

3. **Inter-frame compression (P-frames)**
   - References previous frame(s)
   - Stores only differences (motion vectors + residuals)
   - Much smaller (~5-15 KB for 720p)

#### VP8 Encoding Process

```
I420 Frame (1280×720)
  ↓
Divide into 16×16 macroblocks
  ↓
For each macroblock:
  If keyframe:
    ├─ Intra prediction (predict from neighbors)
    └─ DCT transform → Quantize → Entropy code
  If P-frame:
    ├─ Motion estimation (find similar block in previous frame)
    ├─ Motion compensation (calculate difference)
    └─ DCT transform → Quantize → Entropy code
  ↓
Bitstream (compressed VP8 data)
```

#### libvpx Configuration

**File:** `browser/components/cast/src/video_encoder.rs:56-72`

```rust
// Get default encoder config
vpx_codec_enc_config_default(iface, &mut cfg, 0);

// Our configuration
cfg.g_w = 1280;                  // Width in pixels
cfg.g_h = 720;                   // Height in pixels
cfg.g_timebase.num = 1;          // Timebase numerator
cfg.g_timebase.den = 1000;       // Timebase denominator (1ms precision)
cfg.rc_target_bitrate = 4000;    // Target bitrate (4000 kbps)
cfg.g_error_resilient = 1;       // Enable error resilience
cfg.g_lag_in_frames = 0;         // No frame delay (real-time)
cfg.g_threads = 2;               // Use 2 encoding threads
```

**Key parameters explained:**

- `g_timebase` - Timestamp precision
  - `num/den = 1/1000` means timestamps in milliseconds
  - Frame 0 at 0ms, Frame 1 at 42ms, etc.

- `rc_target_bitrate` - Target bitrate in kilobits/sec
  - 4000 kbps = 4 Mbps
  - Encoder tries to hit this average
  - May vary frame-to-frame

- `g_error_resilient` - Error resilience mode
  - Adds redundancy for packet loss
  - Slightly larger files
  - Better for streaming

- `g_lag_in_frames` - Look-ahead frames
  - 0 = No look-ahead (real-time)
  - Higher values = Better compression but more latency

- `g_threads` - Number of encoding threads
  - 2 threads = Good balance for most systems
  - More threads = Faster encoding but diminishing returns

#### VP8 Encoding Flags

**File:** `browser/components/cast/src/video_encoder.rs:153-158`

```rust
let should_force_kf = force_keyframe || frame_count % (fps as u64 * 2) == 0;

let flags = if should_force_kf {
  VPX_EFLAG_FORCE_KF  // Force keyframe
} else {
  0  // Allow encoder to decide
};
```

**Flags:**
- `VPX_EFLAG_FORCE_KF` - Force this frame to be keyframe
- `0` - Encoder automatically decides (usually P-frame)

**Keyframe strategy:**
- Every 1 second (24 frames at 24fps)
- Allows seeking
- Helps recover from packet loss
- Required when Cast device joins mid-stream

#### VP8 Deadline Modes

**File:** `browser/components/cast/src/video_encoder.rs:180`

```rust
vpx_codec_encode(
  ctx,
  &img,
  timestamp_ms,
  duration,
  flags,
  VPX_DL_REALTIME  // ← Realtime deadline
);
```

**Available deadlines:**

1. **VPX_DL_REALTIME** (What we use)
   - Prioritize speed over quality/compression
   - Target: < 10ms encode time
   - Good for live streaming

2. **VPX_DL_GOOD_QUALITY**
   - Balance speed and quality
   - Target: ~50ms encode time
   - Good for encoding files

3. **VPX_DL_BEST_QUALITY**
   - Prioritize quality/compression over speed
   - Target: Multiple seconds per frame
   - For offline encoding

**Comparison (1280×720 frame):**

| Deadline | Encode Time | Frame Size | Quality |
|----------|-------------|------------|---------|
| REALTIME | ~8ms | ~12 KB | Good |
| GOOD_QUALITY | ~50ms | ~8 KB | Better |
| BEST_QUALITY | ~2000ms | ~6 KB | Best |

### Other Codecs (Comparison)

#### H.264/AVC

**Pros:**
- Universal hardware support
- Better compression than VP8 (~30% smaller)
- Mature ecosystem

**Cons:**
- Patent licensing required
- Not WebM-compatible (uses MP4)
- Firefox avoids for licensing reasons

**When to use:**
- Recording to files
- Maximum compatibility needed

#### VP9

**Pros:**
- Better compression than VP8 (~40% smaller)
- Royalty-free
- WebM-compatible

**Cons:**
- Slower encoding (~3x slower than VP8)
- Not all Cast devices support it
- Higher CPU usage

**When to use:**
- Newer Cast devices (Chromecast gen 2+)
- When bandwidth is limited
- Recording to files

#### AV1

**Pros:**
- Best compression (~50% smaller than H.264)
- Royalty-free
- Future-proof

**Cons:**
- Very slow encoding (10-100x slower than VP8)
- Minimal hardware decoder support
- Not practical for real-time streaming yet

**When to use:**
- Offline encoding for archival
- YouTube uploads (server-side encode)

---

## Container Formats

### What is a Container?

A container format wraps compressed video (and audio) streams with:
- Metadata (resolution, codec, frame rate)
- Timestamps (when to display each frame)
- Structure (how to seek, find keyframes)
- Multiple tracks (video + audio + subtitles)

**Analogy:** Like a ZIP file for video

### Raw Codec vs Container

**Raw VP8 bitstream:**
```
[8432 bytes] [7891 bytes] [8104 bytes] [6543 bytes] ...
```
**Problem:** No timestamps, no metadata, unplayable!

**WebM container:**
```
[EBML Header: 31 bytes]
[Segment Info: 96 bytes]
  - Timecode scale
  - Duration
  - Muxing app

[Tracks: variable]
  - Track 1: Video
    - Codec: V_VP8
    - Width: 1280
    - Height: 720

[Cluster 1: timestamp 0ms]
  - Frame 0: keyframe, 8432 bytes
  - Frame 1: p-frame, 7891 bytes
  ...

[Cluster 2: timestamp 1000ms]
  - Frame 24: keyframe, 8104 bytes
  ...
```
**Result:** Playable, seekable video file!

### WebM Format

#### Overview

- Based on Matroska (MKV) container
- Subset designed for web
- Supports: VP8, VP9, AV1 video + Vorbis, Opus audio
- Uses EBML (Extensible Binary Meta Language)

#### EBML Structure

**EBML** is a binary XML-like format:

```
Element:
  [ID: variable bytes]
  [Size: variable bytes]
  [Data: variable bytes]
```

**Example - Simple element:**
```
Hex: 42 86 81 00
     ││ ││ ││
     ││ ││ └─ Data: 0x00
     ││ └─── Size: 1 byte
     └────── ID: EBMLVersion (0x4286)
```

#### WebM File Structure

**File:** `browser/components/cast/src/webm_writer_ffi.rs`

```
WebM File:
├─ EBML Header (ID: 0x1A45DFA3)
│  ├─ EBMLVersion: 1
│  ├─ EBMLReadVersion: 1
│  ├─ EBMLMaxIDLength: 4
│  ├─ EBMLMaxSizeLength: 8
│  ├─ DocType: "webm"
│  ├─ DocTypeVersion: 4
│  └─ DocTypeReadVersion: 2
│
├─ Segment (ID: 0x18538067)
│  ├─ SeekHead (optional, for seeking)
│  │
│  ├─ Info (ID: 0x1549A966)
│  │  ├─ TimecodeScale: 1000000 (1ms precision)
│  │  ├─ MuxingApp: "libwebm"
│  │  ├─ WritingApp: "Firefox Cast"
│  │  └─ Duration: (unknown for live streams)
│  │
│  ├─ Tracks (ID: 0x1654AE6B)
│  │  └─ TrackEntry (ID: 0xAE)
│  │     ├─ TrackNumber: 1
│  │     ├─ TrackUID: 1
│  │     ├─ TrackType: 1 (video)
│  │     ├─ CodecID: "V_VP8"
│  │     ├─ CodecName: "VP8"
│  │     └─ Video
│  │        ├─ PixelWidth: 1280
│  │        ├─ PixelHeight: 720
│  │        ├─ DisplayWidth: 1280
│  │        └─ DisplayHeight: 720
│  │
│  ├─ Cluster (ID: 0x1F43B675)
│  │  ├─ Timecode: 0 (cluster timestamp in ms)
│  │  ├─ SimpleBlock (ID: 0xA3)
│  │  │  ├─ Track Number: 1
│  │  │  ├─ Timecode: 0 (relative to cluster, signed int16)
│  │  │  ├─ Flags: 0x80 (keyframe flag)
│  │  │  └─ Frame Data: [VP8 bitstream]
│  │  │
│  │  ├─ SimpleBlock
│  │  │  ├─ Track Number: 1
│  │  │  ├─ Timecode: 42
│  │  │  ├─ Flags: 0x00
│  │  │  └─ Frame Data: [VP8 bitstream]
│  │  ...
│  │
│  ├─ Cluster (next cluster)
│  │  ├─ Timecode: 1000
│  │  ...
│  ...
```

---

## WebM Muxing

### What is Muxing?

**Muxing** (multiplexing) = Combining encoded video (and audio) streams into a container.

**Our muxer:** Firefox's `WebMWriter` (C++ implementation)

**File:** `browser/components/cast/src/webm_writer_ffi.rs`

### Muxer Workflow

#### Step 1: Create Muxer

**File:** `browser/components/cast/src/video_encoder.rs:117-124`

```rust
let muxer = WebMWriter::new(width, height)?;
// Creates C++ WebMWriter object
// Initializes track metadata (VP8, 1280x720)
```

**File:** `browser/components/cast/src/webm_writer_ffi.rs:73-109`

```rust
pub fn new(width: i32, height: i32) -> Result<Self, nsresult> {
  // Create C++ WebMWriter
  let mut writer_ptr = null_mut();
  NS_NewWebMWriter(&mut writer_ptr)?;

  // Create VP8 track metadata
  let mut metadata_ptr = null_mut();
  NS_NewVP8Metadata(width, height, width, height, &mut metadata_ptr)?;

  // Set track metadata
  WebMWriter_SetMetadata(writer_ptr, &metadata_ptr, 1)?;

  Ok(WebMWriter { ptr: writer_ptr })
}
```

#### Step 2: Get Header

**File:** `browser/components/cast/src/video_encoder.rs:120-123`

```rust
let header = muxer.get_header()?;
// Returns: WebM header bytes (EBML + Segment + Info + Tracks)
// Size: ~127 bytes
```

**File:** `browser/components/cast/src/webm_writer_ffi.rs:112-128`

```rust
pub fn get_header(&self) -> Result<Vec<u8>, nsresult> {
  let mut output_bufs = ThinVec::new();

  // GET_HEADER flag tells C++ to return just the header
  WebMWriter_GetContainerData(self.ptr, &mut output_bufs, GET_HEADER)?;

  // Concatenate all buffers
  let mut header = Vec::new();
  for buf in output_bufs.iter() {
    header.extend_from_slice(buf);
  }

  Ok(header)
}
```

**What's in the header:**

```
Offset | Hex                           | Description
-------|-------------------------------|------------------
0x00   | 1A 45 DF A3                  | EBML magic
0x04   | 9F                            | Size (variable)
0x05   | 42 86 81 01                  | EBMLVersion = 1
0x09   | 42 F7 81 01                  | EBMLReadVersion = 1
...
0x1F   | 15 49 A9 66                  | Info element
0x23   | 9D                            | Size
0x24   | 2A D7 B1 83 0F 42 40         | TimecodeScale = 1000000
...
0x4F   | 16 54 AE 6B                  | Tracks element
0x53   | B0                            | Size
0x54   | AE                            | TrackEntry
...
0x7E   | 86 88 56 5F 56 50 38         | CodecID = "V_VP8"
```

#### Step 3: Write Frames

**File:** `browser/components/cast/src/video_encoder.rs:210-215`

```rust
for (vp8_data, is_keyframe) in vp8_packets {
  let timestamp_us = (timestamp_ms * 1000) as i64;
  let webm_cluster = muxer.write_frame(&vp8_data, timestamp_us, is_keyframe)?;
  result.extend_from_slice(&webm_cluster);
}
```

**File:** `browser/components/cast/src/webm_writer_ffi.rs:130-185`

```rust
pub fn write_frame(&self, data: &[u8], timestamp_us: i64, is_keyframe: bool)
    -> Result<Vec<u8>, nsresult> {

  // Determine frame type
  let frame_type = if is_keyframe { VP8_I_FRAME } else { VP8_P_FRAME };

  // Duration for 24fps (in microseconds)
  let duration: u64 = 33333;        // 33.333ms
  let duration_base: u64 = 1_000_000; // 1 second

  // Create C++ EncodedFrame object
  let mut frame_ptr = null_mut();
  NS_NewEncodedFrame(
    timestamp_us,
    duration,
    duration_base,
    frame_type,
    data.as_ptr(),
    data.len(),
    &mut frame_ptr
  )?;

  // Write frame to muxer
  let frames = [frame_ptr];
  WebMWriter_WriteEncodedTrack(self.ptr, frames.as_ptr(), 1, 0)?;

  // Get resulting WebM cluster
  let mut output_bufs = ThinVec::new();
  WebMWriter_GetContainerData(self.ptr, &mut output_bufs, 0)?;

  // Concatenate buffers
  let mut cluster = Vec::new();
  for buf in output_bufs.iter() {
    cluster.extend_from_slice(buf);
  }

  Ok(cluster)
}
```

**What we get back (WebM Cluster):**

```
Offset | Hex                           | Description
-------|-------------------------------|------------------
0x00   | 1F 43 B6 75                  | Cluster ID
0x04   | 88 00 00 20 E0               | Size (variable)
0x09   | E7 81 00                     | Timecode = 0
0x0C   | A3                            | SimpleBlock ID
0x0D   | 87 00 00 20 D8               | Size
0x12   | 81                            | Track number = 1
0x13   | 00 00                         | Timecode (relative)
0x15   | 80                            | Flags (keyframe bit)
0x16   | [VP8 data: 8424 bytes]       | VP8 bitstream
```

### Cluster Strategy

**New cluster when:**
- Keyframe encountered
- Cluster exceeds size limit (~32 KB)
- Time threshold (every 1 second)

**Why clusters?**
- Enable seeking (jump to cluster boundary)
- Limit parsing overhead
- Recovery points for streaming

---

## Compression Techniques

### Spatial Compression (Intra-frame)

**Used in:** Keyframes (I-frames)

**Technique:** Predict pixels from nearby pixels

```
Example 4×4 block:

Actual pixels:
100 102 104 106
101 103 105 107
102 104 106 108
103 105 107 109

Horizontal prediction (predict from left):
100 +2 +2 +2
101 +2 +2 +2
102 +2 +2 +2
103 +2 +2 +2

Residuals (actual - predicted):
0 0 0 0
0 0 0 0
0 0 0 0
0 0 0 0

After DCT + quantization: Very small!
```

### Temporal Compression (Inter-frame)

**Used in:** P-frames (predicted frames)

**Technique:** Reference previous frame(s)

```
Previous frame (t-1):
[Car at position X=100, Y=100]

Current frame (t):
[Car at position X=105, Y=100]

Motion vector: (+5, 0)
Residual: Minimal (car looks same)

Encoded data:
- Motion vector: 2 bytes
- Small residual: 50 bytes
Total: ~52 bytes

vs. encoding entire car: ~500 bytes
```

### Transform Coding (DCT)

**DCT** = Discrete Cosine Transform

Converts spatial domain → frequency domain

**Example 8×8 block:**

```
Spatial domain (pixels):
100 100 100 100 100 100 100 100
100 100 100 100 100 100 100 100
100 100 100 100 100 100 100 100
100 100 100 100 100 100 100 100
100 100 100 100 100 100 100 100
100 100 100 100 100 100 100 100
100 100 100 100 100 100 100 100
100 100 100 100 100 100 100 100

After DCT:
800   0   0   0   0   0   0   0
  0   0   0   0   0   0   0   0
  0   0   0   0   0   0   0   0
  0   0   0   0   0   0   0   0
  0   0   0   0   0   0   0   0
  0   0   0   0   0   0   0   0
  0   0   0   0   0   0   0   0
  0   0   0   0   0   0   0   0

After quantization (divide by 10, round):
80   0   0   0   0   0   0   0
 0   0   0   0   0   0   0   0
...all zeros...

Compressed: Just "80, rest are zeros"
```

**Why it works:**
- Natural images have more low-frequency content
- High frequencies (details) can be removed with minimal loss
- Quantization makes many coefficients zero

### Quantization

**Purpose:** Reduce precision to achieve compression

**Example:**

```
Original DCT coefficients:
[800, 15.3, -8.7, 2.1, -1.4, 0.8, -0.3, 0.1]

Quantization table (divide by these values):
[10, 11, 12, 13, 14, 15, 16, 17]

Quantized (integer division):
[80, 1, 0, 0, 0, 0, 0, 0]

Reconstructed (multiply back):
[800, 11, 0, 0, 0, 0, 0, 0]

Lost: Small high-frequency details
Saved: 6 coefficients became zero → high compression
```

**Quality vs. Size:**
- Low quantization → High quality, large file
- High quantization → Low quality, small file

---

## Real-time Encoding

### Constraints

**Real-time encoding requirements:**
1. Encode time < frame duration
   - At 24fps: Must encode in < 42ms
   - At 60fps: Must encode in < 17ms

2. Low latency
   - No buffering/look-ahead
   - Immediate encoding

3. Consistent frame rate
   - Can't drop frames
   - Can't vary encoding time wildly

### VP8 Real-time Mode

**File:** `browser/components/cast/src/video_encoder.rs:180`

```rust
vpx_codec_encode(ctx, &img, timestamp_ms, duration, flags, VPX_DL_REALTIME);
```

**What VPX_DL_REALTIME does:**

1. **Simplified motion estimation**
   - Smaller search range (±16 pixels vs ±64)
   - Fewer search iterations (4 vs 16)
   - Faster but less optimal

2. **Reduced RDO (Rate-Distortion Optimization)**
   - Fewer mode decisions
   - Less exhaustive testing of prediction modes
   - Good-enough vs. perfect

3. **Simpler loop filter**
   - Minimal deblocking
   - Faster processing

4. **No 2-pass encoding**
   - Single pass only
   - Can't optimize bitrate distribution

**Result:**
- Encoding time: ~8ms (fits in 42ms budget)
- Quality: Good enough for streaming
- Bitrate control: Somewhat variable

### CPU Usage Optimization

**Threading:**

```rust
cfg.g_threads = 2;  // Use 2 threads
```

**Why 2?**
- 1 thread: Underutilizes CPU (can't encode fast enough)
- 2 threads: Good balance (nearly 2x speedup)
- 4 threads: Diminishing returns (~2.5x speedup)
- More overhead: Thread synchronization

**Frame-level parallelism:**
- Each frame divided into tiles
- Threads encode different tiles
- Synchronization at tile boundaries

### Memory Optimization

**Reuse buffers:**

```rust
struct VpxContext {
  ctx: Box<vpx_codec_ctx>,
  img: vpx_image_t,
  img_buffer: Vec<u8>,  // Reused every frame
}
```

**Why?**
- Allocation/deallocation is slow
- Reusing buffers reduces garbage
- Keeps memory hot in cache

---

## Related Documentation

- [STREAMING_FLOW.md](./STREAMING_FLOW.md) - Complete streaming flow
- [CAST_PROTOCOL.md](./CAST_PROTOCOL.md) - Cast protocol details
- [ARCHITECTURE_DEEP_DIVE.md](./ARCHITECTURE_DEEP_DIVE.md) - System architecture
