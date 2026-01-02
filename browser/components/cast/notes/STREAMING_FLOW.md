# Complete Cast Streaming Flow

This document provides a detailed, step-by-step explanation of how Firefox Cast streaming works from button click to video on TV.

## Table of Contents

- [Overview](#overview)
- [Phase 1: Setup & Connection](#phase-1-setup--connection)
- [Phase 2: Encoder Preparation](#phase-2-encoder-preparation)
- [Phase 3: Continuous Encoding Loop](#phase-3-continuous-encoding-loop)
- [Timeline Diagram](#timeline-diagram)
- [Data Flow](#data-flow)

---

## Overview

The Cast streaming system consists of 3 distinct phases:

1. **Setup & Connection** - Establish Cast protocol connection
2. **Encoder Preparation** - Initialize VP8 encoder and HTTP server
3. **Continuous Encoding** - Capture, encode, and stream frames

**Key Insight:** Encoding starts immediately when the Cast device connects to the HTTP stream. The system uses real timestamps based on when encoding started, allowing the Cast device to buffer appropriately.

---

## Phase 1: Setup & Connection

### Step 1.1: User Initiates Cast

**File:** `browser/components/cast/content/browser-cast.js:152-180`

```javascript
User clicks Cast icon
  ↓
CastPanel.onManualAdd()
  ↓
prompt("Enter Cast device IP address:", "192.168.1.100")
  ↓
User enters IP (e.g., "192.168.1.171")
```

**User sees:** Input dialog requesting Cast device IP address.

### Step 1.2: Add Device (Certificate Exception)

**File:** `browser/components/cast/CastService.sys.mjs:148-186`

```javascript
await castService.addManualDevice("192.168.1.171", 8009)
```

**What happens:**

1. Create `CastDevice` object (JavaScript wrapper)
2. Call `device.addCertificateOverride()`
   - Makes HTTPS request to `https://192.168.1.171:8009/`
   - Retrieves self-signed certificate from TLS handshake
   - Validates certificate is self-signed (issuer === subject)
   - Adds exception via `rememberValidityOverride()` so Firefox trusts the device
3. **No Cast protocol connection yet** - only certificate preparation

**File:** `browser/components/cast/modules/CastDevice.sys.mjs:223-295`

**Important:** This step validates SSL/TLS will work. The actual Cast connection happens next.

### Step 1.3: Establish Cast Protocol Connection

**File:** `browser/components/cast/content/browser-cast.js:163-171`

```javascript
await gCastService.testConnection(device.id)
  ↓
await device.connect()  // ← ACTUAL CAST CONNECTION
```

**File:** `browser/components/cast/modules/CastDevice.sys.mjs:231-254`

This calls into Rust XPCOM component:

**File:** `browser/components/cast/src/cast_device.rs:133-259`

**Detailed steps:**

```rust
// 1. Create TLS socket transport
let sts_service = xpcom::components::SocketTransport::service()?;
let transport = sts_service.CreateTransport(["ssl"], address, port)?;

// 2. Open output stream (for sending messages)
let output_stream = transport.OpenOutputStream(0, 0, 0)?;

// 3. Open input stream (for receiving messages)
let input_stream = transport.OpenInputStream(0, 0, 0)?;

// 4. Create input pump for async reading
let pump = create_instance::<nsIInputStreamPump>(...)?;
pump.Init(input_stream, ...)?;

// 5. Create stream listener (handles incoming messages)
let listener = CastStreamListener::new(RefPtr::new(self));

// 6. Start async reading (BEFORE sending any messages!)
pump.AsyncRead(listener.coerce())?;

// 7. NOW send CONNECT message
let connect_payload = ConnectionHandler::create_connect_message();
self.send_message_internal("urn:x-cast:com.google.cast.tp.connection", &connect_payload)?;

// 8. Request receiver status
let get_status = receiver_handler.create_get_status();
self.send_message_internal("urn:x-cast:com.google.cast.receiver", &get_status)?;

// 9. Notify JavaScript layer
self.notify_state_change(DeviceState::Connected);
```

**Console output:**
```
CastDevice: Connecting to 192.168.1.171:8009
CastDevice: Async listener started, sending initial messages
CastDevice: -> [connection] CONNECT
CastDevice: -> [receiver] GET_STATUS
CastDevice: Connected successfully
```

**Cast device receives:**
```
← TLS handshake
← CONNECT message (namespace: urn:x-cast:com.google.cast.tp.connection)
← GET_STATUS message (namespace: urn:x-cast:com.google.cast.receiver)
→ RECEIVER_STATUS response
```

**What's established:**
- Bidirectional TLS connection
- Cast protocol session
- Heartbeat mechanism (PING/PONG every 5 seconds)
- Async message listener for device responses

---

## Phase 2: Encoder Preparation

### Step 2.1: Start Tab Casting

**File:** `browser/components/cast/content/browser-cast.js:167-171`

```javascript
await gCastService.startTabCasting(device.id, browser, window, {
  fps: 30,
  bitrate: 15000000  // 15 Mbps
})
```

**File:** `browser/components/cast/modules/CastSession.sys.mjs:62-214`

### Step 2.2: Calculate Canvas Dimensions

**Lines 74-114:**

```javascript
// Get browser dimensions
this.width = browser.clientWidth || 1280;
this.height = browser.clientHeight || 720;

// Minimum dimensions (ensures at least 720p quality)
const minWidth = 1280;
const minHeight = 720;
// Maximum dimensions
const maxWidth = 1920;
const maxHeight = 1080;

let canvasWidth = this.width;
let canvasHeight = this.height;

// Scale UP if below minimum
if (canvasWidth < minWidth || canvasHeight < minHeight) {
  const widthRatio = minWidth / canvasWidth;
  const heightRatio = minHeight / canvasHeight;
  const scaleRatio = Math.max(widthRatio, heightRatio);
  canvasWidth = Math.floor(canvasWidth * scaleRatio);
  canvasHeight = Math.floor(canvasHeight * scaleRatio);
}

// Scale DOWN if above maximum
if (canvasWidth > maxWidth || canvasHeight > maxHeight) {
  const widthRatio = maxWidth / canvasWidth;
  const heightRatio = maxHeight / canvasHeight;
  const scaleRatio = Math.min(widthRatio, heightRatio);
  canvasWidth = Math.floor(canvasWidth * scaleRatio);
  canvasHeight = Math.floor(canvasHeight * scaleRatio);
}

// VP8 requires even dimensions for I420 chroma subsampling
canvasWidth = canvasWidth & ~1;
canvasHeight = canvasHeight & ~1;
```

**Example:**
- Browser: 800x600 → Scaled UP to: 1280x960 (minimum 720p)
- Browser: 1920x1080 → No scaling: 1920x1080
- Browser: 2560x1440 → Scaled DOWN to: 1920x1080

### Step 2.3: Create Canvas

**Lines 116-125:**

```javascript
this.canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
this.canvas.width = canvasWidth;
this.canvas.height = canvasHeight;

this.ctx = this.canvas.getContext("2d", {
  alpha: false,           // No transparency
  willReadFrequently: true  // We read pixels every frame
});
```

**Purpose:** Canvas is used for getting RGBA pixel data from snapshots.

### Step 2.4: Initialize Rust VP8 Encoder

**Lines 134-142:**

```javascript
this.fps = options.fps || 60;
const videoBitsPerSecond = options.bitrate || 25000000;  // 25 Mbps default

// Create Rust XPCOM component
this._encoder = Cc["@mozilla.org/cast/video-encoder;1"]
  .createInstance(Ci.nsICastVideoEncoder);

// Initialize encoder
this._encoder.init(canvasWidth, canvasHeight, videoBitsPerSecond, this.fps);
```

**This calls Rust:** `browser/components/cast/src/video_encoder.rs:54-181`

**What happens in Rust:**

```rust
// Get VP8 encoder interface from libvpx
let iface = vpx_codec_vp8_cx();

// Get default encoder config
let mut cfg: vpx_codec_enc_cfg_t = zeroed();
vpx_codec_enc_config_default(iface, &mut cfg, 0);

// Configure for our use case
cfg.g_w = 1280;              // Width
cfg.g_h = 720;               // Height
cfg.g_timebase.num = 1;      // Timebase numerator
cfg.g_timebase.den = 1000;   // Timebase denominator (1ms precision)
cfg.rc_target_bitrate = 15000; // kbps (converted from bps)
cfg.g_error_resilient = 1;   // Enable error resilience
cfg.g_lag_in_frames = 0;     // No frame delay (real-time)
cfg.g_threads = 4;           // Use 4 threads
cfg.rc_end_usage = VPX_VBR;  // Variable bitrate
cfg.rc_min_quantizer = 4;    // Quality range
cfg.rc_max_quantizer = 48;
cfg.kf_mode = VPX_KF_AUTO;   // Auto keyframes
cfg.kf_max_dist = fps * 5;   // Max keyframe interval (5 seconds)

// Initialize VP8 encoder context
let mut ctx: vpx_codec_ctx = zeroed();
vpx_codec_enc_init_ver(&mut ctx, iface, &cfg, 0, VPX_ENCODER_ABI_VERSION);

// Encoder tuning for real-time performance
vpx_codec_control(ctx, VP8E_SET_CPUUSED, 4);
vpx_codec_control(ctx, VP8E_SET_STATIC_THRESHOLD, 0);
vpx_codec_control(ctx, VP8E_SET_TOKEN_PARTITIONS, 2);

// Create I420 image buffer (YUV 4:2:0 format)
let y_stride = align(width, 32);  // Align to 32 bytes
let y_size = y_stride * height;
let buffer_size = y_size * 3;     // Y + U + V planes
let mut img_buffer = vec![0u8; buffer_size];

let mut img: vpx_image_t = zeroed();
vpx_img_wrap(&mut img, VPX_IMG_FMT_I420, width, height, 32, img_buffer.as_mut_ptr());

// Create WebM muxer
let muxer = WebMWriter::new(width, height)?;
```

**Console output:**
```
Canvas 1280x720 @ 30fps, 15000kbps
Rust encoder initialized, WebM header: 127 bytes
```

### Step 2.5: Get WebM Header

**Lines 144:**

```javascript
this._webmHeader = this._encoder.getHeader();
// Returns: Array of bytes (~127 bytes)
```

**File:** `browser/components/cast/src/video_encoder.rs:306-317`

**What's in the header:**

```
[EBML Header: ~31 bytes]
  EBML magic: 0x1A45DFA3
  DocType: "webm"
  DocTypeVersion: 4

[Segment: ~96 bytes]
  [Info]
    TimecodeScale: 1000000 (1ms precision)
    MuxingApp: "libwebm"

  [Tracks]
    [Track 1: Video]
      TrackNumber: 1
      TrackType: 1 (video)
      CodecID: "V_VP8"
      PixelWidth: 1280
      PixelHeight: 720
```

**Purpose:** This header is sent ONCE at the beginning of the stream so the Cast device knows:
- File format (WebM)
- Video codec (VP8)
- Video dimensions (1280x720)
- Timestamp precision

### Step 2.6: Start HTTP Server

**Lines 153-166:**

```javascript
this.server = new SimpleHTTPServer();

// Register handler for /stream.webm endpoint
this.server.registerPathHandler("/stream.webm", connection => {
  this.handleStreamRequest(connection);  // ← Called when Cast connects
});

const port = this.server.start(8010);

// Determine local IP to give Cast device
const hostname = this.server.getLocalHostname();
const streamURL = hostname
  ? `http://${hostname}:${port}/stream.webm`
  : `http://${this.server.getLocalIP(this.castDevice.address)}:${port}/stream.webm`;
```

**Example URLs:**
- `http://Harshits-MacBook.local:8010/stream.webm` (using mDNS hostname - Cast device multicasts query to all local devices)
- `http://192.168.1.123:8010/stream.webm` (using IP address - no DNS/mDNS lookup needed)

**Console output:**
```
Stream URL: http://192.168.1.123:8010/stream.webm (using IP)
```

**How mDNS works (for .local hostnames):**
When the Cast device receives a URL with a `.local` hostname:
1. Cast device sends mDNS query to multicast address `224.0.0.251` (IPv4) or `ff02::fb` (IPv6) on port 5353
2. The multicast packet is delivered by the network switch/WiFi access point to ALL devices on the local network
3. The device that owns that hostname (Firefox host) receives the query and responds directly with its IP address
4. No router DNS lookup or central server involved - it's direct peer-to-peer communication

**Important:** Server is now listening, but NO encoding is happening yet!

### Step 2.7: Tell Cast Device to Load Stream

**Lines 178-196:**

```javascript
this.mediaHandler = new lazy.CastMediaHandler(this.castDevice);

// Listen for media status messages
this.castDevice.addEventListener("message", ({ namespace, payload }) => {
  if (namespace === lazy.CastMediaHandler.NAMESPACE) {
    this.handleMediaMessage(JSON.stringify(payload));
  }
});

const metadata = {
  metadataType: 0,
  title: "Firefox Tab Cast",
};

await this.mediaHandler.load(streamURL, "video/webm", "LIVE", metadata, true);
```

**File:** `browser/components/cast/modules/CastMediaHandler.sys.mjs`

**Cast protocol message sent:**

```json
{
  "type": "LOAD",
  "requestId": 1,
  "media": {
    "contentId": "http://192.168.1.123:8010/stream.webm",
    "contentType": "video/webm",
    "streamType": "LIVE",
    "duration": -1,
    "metadata": {
      "metadataType": 0,
      "title": "Firefox Tab Cast"
    }
  },
  "autoplay": true
}
```

**Sent to:** `urn:x-cast:com.google.cast.media` namespace

**Console output:**
```
Media LOAD sent to Cast device. Waiting for MEDIA_STATUS response...
```

**Critical:** At this point:
- Encoder initialized
- HTTP server running
- Cast device knows the URL
- NOT encoding yet
- Waiting for Cast device to connect to HTTP stream...

---

## Phase 3: Continuous Encoding Loop

### Step 3.1: Cast Device Connects to HTTP Stream

**Timeline:**

```
T+0ms:    Cast device receives LOAD message
T+500ms:  Cast device initializes media player
T+1000ms: Cast device prepares network stack
T+2000ms: Cast device resolves hostname (if using .local domain)
           - Multicasts mDNS query to 224.0.0.251 (all local devices)
           - Firefox host responds directly with its IP
T+5000ms: Cast device makes HTTP GET request
```

**Why the delay?**
- Media player initialization
- mDNS resolution (multicast query to all local devices, no router/DNS server involved)
- Buffer allocation
- UI updates on Cast device

### Step 3.2: Handle Stream Request

**HTTP request from Cast device:**

```http
GET /stream.webm HTTP/1.1
Host: 192.168.1.123:8010
User-Agent: Mozilla/5.0 (CrKey ...) Chrome/...
Accept: */*
Range: bytes=0-
Connection: keep-alive
```

**This triggers:** `handleStreamRequest(connection)`

**File:** `browser/components/cast/modules/CastSession.sys.mjs:222-263`

**Lines 229-243:**

```javascript
lazy.logConsole.debug(`Cast device connected to stream at ${Date.now()}`);

const headers =
  "HTTP/1.1 200 OK\r\n" +
  "Content-Type: video/webm\r\n" +
  "Cache-Control: no-cache, no-store, must-revalidate, max-age=0\r\n" +
  "Pragma: no-cache\r\n" +
  "Expires: 0\r\n" +
  "Connection: keep-alive\r\n" +
  "Transfer-Encoding: chunked\r\n" +
  "Access-Control-Allow-Origin: *\r\n" +
  "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n" +
  "Access-Control-Allow-Headers: Content-Type, Range\r\n" +
  "Access-Control-Expose-Headers: Content-Length, Content-Range\r\n" +
  "\r\n";

connection.outputStream.write(headers, headers.length);
```

**Why these headers?**
- `Content-Type: video/webm` - Tells Cast device this is a WebM video
- `Cache-Control: no-cache` - Don't cache (it's live!)
- `Transfer-Encoding: chunked` - Indefinite length stream
- `CORS headers` - Allow cross-origin access

### Step 3.3: Send WebM Header

**Lines 245-250:**

```javascript
if (this._webmHeader && this._webmHeader.length) {
  lazy.logConsole.debug(`Sending WebM header: ${this._webmHeader.length} bytes`);
  this.writeChunk(connection.outputStream, this._webmHeader);
}
```

**HTTP chunked encoding format:**

```
7f\r\n
[127 bytes of WebM header]\r\n
```

**Breakdown:**
- `7f` = Hexadecimal for 127 (chunk size)
- `\r\n` = CRLF (chunk header terminator)
- `[127 bytes]` = Actual WebM header data
- `\r\n` = CRLF (chunk terminator)

### Step 3.4: Start Capture Loop Immediately

**Lines 252-256:**

```javascript
this.streamConnection = connection;
this._frameCount = 0;

lazy.logConsole.debug("Cast device connected, starting capture immediately");
this.startCaptureLoop();
```

**File:** `browser/components/cast/modules/CastSession.sys.mjs:292-330`

```javascript
startCaptureLoop() {
  if (this._encodingStarted) {
    return;
  }

  this._encodingStarted = true;
  this._streamStartTime = Date.now();
  this._nextFrameTime = this._streamStartTime;

  const intervalMs = 1000 / this.fps;  // 30 FPS = 33.33ms

  const captureLoop = async () => {
    if (!this._encodingStarted || !this.canvas) {
      return;  // Cleanup happened
    }

    const now = Date.now();

    if (now >= this._nextFrameTime) {
      await this.captureFrame();
      this._nextFrameTime += intervalMs;  // Accumulate for precision
    }

    if (this._encodingStarted) {
      this.captureInterval = this.window.requestAnimationFrame(captureLoop);
    }
  };

  this.captureInterval = this.window.requestAnimationFrame(captureLoop);
}
```

**Console output:**
```
Cast device connected to stream at 1766430166792
Both stream connection and MEDIA_STATUS ready! Starting capture at: 1766430166792
Started capture loop at 30 FPS (interval: 33.333ms)
```

**Key features:**
- `requestAnimationFrame` instead of `setInterval` (better timing precision)
- Scheduled frame timing with `_nextFrameTime` accumulator (prevents drift)
- Real timestamps from `Date.now() - _streamStartTime`
- Defensive checks prevent race condition with cleanup

### Step 3.5: Capture Frame Overview

**File:** `browser/components/cast/modules/CastSession.sys.mjs:377-486`

**High-level flow:**

```
captureFrame() called every ~33ms
  ↓
Take snapshot of browser content
  ↓
Draw snapshot to canvas
  ↓
Get RGBA pixel data from canvas
  ↓
Call Rust encoder with RGBA data and real timestamp
  ↓
Rust: Convert RGBA → I420 (YUV)
  ↓
Rust: Encode with libvpx VP8
  ↓
Rust: Mux into WebM cluster
  ↓
Write WebM cluster to HTTP stream
  ↓
Cast device receives and decodes
```

### Step 3.6: Guard Against Concurrent Captures

**Lines 377-388:**

```javascript
async captureFrame() {
  if (!this.browser || !this._encoder || !this.canvas) {
    return;  // Not ready
  }

  if (this.isCapturing) {
    return;  // Already capturing, skip this tick
  }

  // Skip frames if receiver is buffering
  if (this._playbackStarted && this._receiverBuffering) {
    return;
  }

  this.isCapturing = true;
```

**Why needed?**
- Capture is async (uses `await`)
- If frame capture takes > 33ms, next interval fires
- This prevents multiple captures running simultaneously

### Step 3.7: Take Snapshot

**Lines 410-426:**

```javascript
const browsingContext = this.browser.browsingContext;
if (!browsingContext) {
  this.isCapturing = false;
  return;
}

const scale = 1;
const flags =
  browsingContext.currentWindowGlobal.DRAWSNAPSHOT_DRAW_CARET |
  browsingContext.currentWindowGlobal.DRAWSNAPSHOT_USE_WIDGET_LAYERS;

const snapshot = await browsingContext.currentWindowGlobal.drawSnapshot(
  null,   // null = capture entire visible viewport
  scale,
  "rgb(255, 255, 255)",  // White background color
  flags
);
```

**What is `drawSnapshot`?**
- Gecko internal API
- Renders browser content to GPU surface
- Returns `ImageBitmap` (GPU texture)
- Very fast (hardware-accelerated)

**Parameters:**
- `rect` - Area to capture (null = entire viewport)
- `scale` - Device pixel ratio (1.0)
- `backgroundColor` - Used for transparency
- `flags` - DRAW_CARET shows cursor, USE_WIDGET_LAYERS uses composited layers

**Result:** `ImageBitmap` object (GPU memory, not accessible to JS directly)

### Step 3.8: Draw to Canvas

**Lines 428-436:**

```javascript
if (!this.ctx) {
  this.ctx = this.canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true  // We read pixels every frame
  });
}

this.ctx.drawImage(snapshot, 0, 0, this.canvas.width, this.canvas.height);
snapshot.close();  // Release GPU memory immediately
```

**What happens:**
- `drawImage()` copies GPU surface → Canvas
- If dimensions differ, performs scaling
  - Example: 1920x1080 snapshot → 1280x720 canvas (bilinear interpolation)
- `snapshot.close()` releases GPU texture (prevents memory leak)

**Canvas now contains:** RGBA pixels of current browser view

### Step 3.9: Get RGBA Pixel Data

**Lines 438-444:**

```javascript
const imageData = this.ctx.getImageData(
  0, 0,
  this.canvas.width,   // e.g., 1280
  this.canvas.height   // e.g., 720
);

const rgbaData = new Uint8Array(imageData.data.buffer);
```

**What is `ImageData`?**
- JavaScript object containing raw pixel data
- `data` property is `Uint8ClampedArray`
- Format: R, G, B, A, R, G, B, A, ...
- Size: width × height × 4 bytes

**Example:**
- Canvas: 1280×720
- Bytes: 1280 × 720 × 4 = 3,686,400 bytes (3.5 MB)

**Memory layout:**
```
Byte 0: Red (pixel 0,0)
Byte 1: Green (pixel 0,0)
Byte 2: Blue (pixel 0,0)
Byte 3: Alpha (pixel 0,0)
Byte 4: Red (pixel 1,0)
...
```

### Step 3.10: Calculate Real Timestamp

**Lines 446-451:**

```javascript
const now = Date.now();
const timestampMs = now - this._streamStartTime;

const forceKeyframe =
  this._forceKeyframe || this._frameCount % (this.fps * 5) === 0;
this._forceKeyframe = false;
```

**Real timestamps:**
- `_streamStartTime` is set when encoding starts
- Each frame's timestamp is `Date.now() - _streamStartTime`
- This gives accurate presentation timestamps in milliseconds

**When are keyframes forced?**
- Frame 0, 150, 300, 450... (every 5 seconds at 30fps)
- Keyframes are larger but allow seeking/recovery
- Can also force keyframe after resync

### Step 3.11: Encode Frame

**Lines 459-463:**

```javascript
const webmCluster = this._encoder.encodeFrame(
  rgbaData,
  forceKeyframe,
  timestampMs
);
```

**This calls Rust:** `browser/components/cast/src/video_encoder.rs:210-304`

**Rust encoding process:**

#### Step 3.11a: Convert RGBA to I420

**File:** `browser/components/cast/src/video_encoder.rs:414-455`

```rust
fn rgba_to_i420(rgba: &[u8], width: u32, height: u32, img: &mut vpx_image_t) {
  // For each pixel:
  for y in 0..height {
    for x in 0..width {
      let rgba_idx = ((y * width + x) * 4) as usize;
      let r = rgba[rgba_idx] as i32;
      let g = rgba[rgba_idx + 1] as i32;
      let b = rgba[rgba_idx + 2] as i32;

      // Convert RGB to Y (luma) using BT.601 coefficients
      let y_val = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
      y_plane[y * y_stride + x] = y_val.clamp(16, 235) as u8;

      // Convert RGB to U and V (chroma) - only for even pixels (4:2:0 subsampling)
      if x % 2 == 0 && y % 2 == 0 {
        let u_val = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
        let v_val = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;

        u_plane[(y/2) * u_stride + (x/2)] = u_val.clamp(16, 240) as u8;
        v_plane[(y/2) * v_stride + (x/2)] = v_val.clamp(16, 240) as u8;
      }
    }
  }
}
```

**What is I420?**
- YUV color space (instead of RGB)
- Y plane: Full resolution (1280×720)
- U plane: Half resolution (640×360) - 4:2:0 chroma subsampling
- V plane: Half resolution (640×360)
- Total: 1280×720 + 640×360 + 640×360 = 1,382,400 bytes

**Why convert?**
- VP8 expects YUV input
- Human vision more sensitive to brightness (Y) than color (UV)
- Chroma subsampling saves bandwidth without visible quality loss

#### Step 3.11b: Encode with libvpx

**File:** `browser/components/cast/src/video_encoder.rs:256-271`

```rust
let flags = if force_keyframe {
  VPX_EFLAG_FORCE_KF  // Force keyframe
} else {
  0  // Regular frame
};

let ret = vpx_codec_encode(
  vpx_ctx.ctx.as_mut(),
  &vpx_ctx.img as *const vpx_image_t,  // I420 image
  timestamp_ms as i64,                  // PTS (presentation timestamp)
  1000 / fps as u64,                    // Duration in ms
  flags,                                // Flags (keyframe, etc.)
  VPX_DL_REALTIME                       // Deadline: REALTIME (low latency)
);
```

**libvpx encoding parameters:**
- `VPX_DL_REALTIME` - Prioritize speed over compression
- `timestamp_ms` - When to display this frame (real timestamp)
- `duration` - How long to display (33ms at 30fps)
- `flags` - Force keyframe or allow inter-frame

**Output:** VP8 compressed bitstream (~5-20 KB typically)

#### Step 3.11c: Extract Encoded Packets

**File:** `browser/components/cast/src/video_encoder.rs:273-288`

```rust
let mut iter: vpx_codec_iter_t = std::mem::zeroed();
let mut vp8_packets: Vec<(Vec<u8>, bool)> = Vec::new();

loop {
  let pkt = vpx_codec_get_cx_data(vpx_ctx.ctx.as_mut(), &mut iter);
  if pkt.is_null() {
    break;  // No more packets
  }

  if (*pkt).kind == VPX_CODEC_CX_FRAME_PKT {
    let frame = &(*pkt).data.frame;
    let vp8_data = std::slice::from_raw_parts(frame.buf as *const u8, frame.sz);
    let is_keyframe = (frame.flags & 1) != 0;

    vp8_packets.push((vp8_data.to_vec(), is_keyframe));
  }
}
```

**What we get:**
- Usually 1 packet per frame
- Sometimes multiple packets (rare)
- Each packet contains raw VP8 bitstream
- Keyframe flag indicates if this is an I-frame

#### Step 3.11d: Mux into WebM

**File:** `browser/components/cast/src/video_encoder.rs:290-301`

```rust
let mut result = ThinVec::new();
let muxer = state.muxer.as_ref().unwrap();

for (vp8_data, is_keyframe) in vp8_packets {
  let timestamp_us = (timestamp_ms * 1000) as i64;
  let webm_cluster = muxer.write_frame(&vp8_data, timestamp_us, is_keyframe)?;
  result.extend_from_slice(&webm_cluster);
}
```

**Muxer wraps VP8 in WebM structure:**

```
[Cluster: variable size]
  [Cluster Header]
    Cluster ID: 0x1F43B675
    Timecode: 0 (relative cluster timestamp)

  [SimpleBlock]
    Track Number: 1
    Timestamp: 0 (relative to cluster)
    Flags: 0x80 (keyframe bit)
    Data Size: 8432
    [VP8 compressed frame data: 8432 bytes]
```

**Returns:** Complete WebM cluster (typically 8-20 KB)

### Step 3.12: Write to HTTP Stream

**Lines 465-477:**

```javascript
if (this.streamConnection && webmCluster && webmCluster.length) {
  if (this._pendingFrames > 60) {
    // Drop frame if too far behind
    this._droppedFrames++;
  } else {
    this._pendingFrames++;
    this.writeChunk(this.streamConnection.outputStream, webmCluster);
  }
}

this._frameCount++;
this.lastCaptureTime = Date.now();
```

**File:** `browser/components/cast/modules/CastSession.sys.mjs:271-290`

```javascript
writeChunk(outputStream, data) {
  // Convert size to hexadecimal
  const chunkSize = data.length.toString(16);  // e.g., "20e8"
  const chunkHeader = `${chunkSize}\r\n`;

  // Write chunk header
  outputStream.write(chunkHeader, chunkHeader.length);

  // Write chunk data
  const binaryStream = Cc["@mozilla.org/binaryoutputstream;1"]
    .createInstance(Ci.nsIBinaryOutputStream);
  binaryStream.setOutputStream(outputStream);
  binaryStream.writeByteArray(data);

  // Write chunk terminator
  const chunkFooter = "\r\n";
  outputStream.write(chunkFooter, chunkFooter.length);
  outputStream.flush();  // Send immediately to network

  if (this._pendingFrames > 0) {
    this._pendingFrames--;
  }
}
```

**HTTP wire format:**

```
20e8\r\n
[8424 bytes of WebM cluster]\r\n
1f3c\r\n
[8004 bytes of WebM cluster]\r\n
...continues...
```

**Cast device TCP stream:**
```
← Chunk: Frame 0 (keyframe, 8424 bytes)
← Chunk: Frame 1 (inter-frame, 6012 bytes)
← Chunk: Frame 2 (inter-frame, 5891 bytes)
...
← Chunk: Frame 150 (keyframe, 9103 bytes)
...
```

### Step 3.13: Cast Device Processing

**Cast device:**
1. Receives HTTP chunks
2. Buffers ~200ms worth of video
3. Parses WebM structure
4. Extracts VP8 frames
5. Decodes VP8 with hardware decoder
6. Renders to display at 30fps

**Buffering strategy:**
```
T+5000ms: Receives Frame 0
T+5010ms: Buffers...
T+5200ms: Starts playback (200ms buffer)
T+5200ms: Displays Frame 0
T+5233ms: Displays Frame 1
T+5266ms: Displays Frame 2
```

---

## Timeline Diagram

### Complete Flow Timeline

```
Time    | Firefox                          | Cast Device
--------|----------------------------------|---------------------------
T+0ms   | User clicks Cast button          |
T+50ms  | addManualDevice()                |
T+500ms | Certificate exception added      |
T+1000ms| device.connect()                 | Receives CONNECT
T+1100ms| TLS handshake                    | TLS handshake
T+1200ms| Send CONNECT, GET_STATUS         | Processes messages
T+1300ms| startTabCasting()                | Sends RECEIVER_STATUS
T+1400ms| Initialize encoder               |
T+1500ms| Start HTTP server                |
T+1600ms| Send LOAD command                | Receives LOAD
T+2000ms|                                  | Initialize media player
T+3000ms|                                  | Resolve hostname (mDNS)
T+5000ms| handleStreamRequest() triggered! | Makes HTTP GET request
T+5001ms| Send HTTP headers                | Receives headers
T+5002ms| Send WebM header                 | Receives WebM header
T+5003ms| Start capture loop NOW           |
T+5003ms| captureFrame() - Frame 0         |
T+5010ms| Encode complete                  | Receives Frame 0
T+5011ms| Send Frame 0                     | Starts buffering
T+5036ms| captureFrame() - Frame 1         |
T+5043ms| Send Frame 1                     | Receives Frame 1
T+5069ms| captureFrame() - Frame 2         |
T+5076ms| Send Frame 2                     | Receives Frame 2
T+5200ms|                                  | Start playback!
T+5200ms|                                  | Display Frame 0
T+5233ms|                                  | Display Frame 1
T+5266ms|                                  | Display Frame 2
...     | Continues every ~33ms            | Continues playback
```

### Latency Breakdown

```
Component                    | Latency
-----------------------------|----------
Capture (drawSnapshot)       | ~5ms
Canvas operations            | ~2ms
RGBA → I420 conversion       | ~3ms
VP8 encoding                 | ~8ms
WebM muxing                  | ~1ms
HTTP write                   | ~1ms
Network transmission (LAN)   | ~5ms
Cast device buffering        | ~200ms
-----------------------------|----------
TOTAL                        | ~225ms
```

---

## Data Flow

### Memory Flow (Single Frame)

```
Browser DOM (GPU)
  ↓ drawSnapshot() - 5ms
ImageBitmap (GPU surface) [1920×1080, ~8MB GPU memory]
  ↓ drawImage() - 2ms (with scaling)
Canvas (1280×720)
  ↓ getImageData() - 2ms (GPU → CPU transfer)
Uint8Array (RGBA) [3,686,400 bytes, CPU memory]
  ↓ encoder.encodeFrame() → Rust
I420 buffer [1,382,400 bytes, CPU memory]
  ↓ vpx_codec_encode() - 8ms
VP8 bitstream [~8,000 bytes, CPU memory]
  ↓ WebM muxer
WebM cluster [~8,500 bytes with overhead]
  ↓ writeChunk()
HTTP socket buffer
  ↓ TCP/IP
Cast device [VP8 decoder → Display]
```

### Network Flow

```
Firefox Process              Wire Protocol              Cast Device
---------------              -------------              -----------
WebM header (127 bytes)  →   HTTP headers          →
                         →   7f\r\n                →   Parse headers
                         →   [127 bytes]\r\n       →   "It's WebM!"
                                                   →   "VP8, 1280x720"

Frame 0 (8424 bytes)     →   20e8\r\n              →
                         →   [8424 bytes]\r\n      →   Parse cluster
                         →                             Extract VP8
                         →                             Decode frame
                         →                             Buffer frame

Frame 1 (6012 bytes)     →   1774\r\n              →
                         →   [6012 bytes]\r\n      →   Parse cluster
                         →                             Extract VP8
                         →                             Decode frame
                         →                             Buffer frame

...continues...              ...                       Start playback
                                                       Display frames
```

---

## Key Takeaways

1. **Encoding starts when Cast device connects to HTTP stream** - No complex two-condition synchronization needed

2. **Real timestamps from stream start** - Each frame has accurate presentation timestamp based on `Date.now() - streamStartTime`

3. **Three-layer encoding pipeline:**
   - JavaScript: Capture & coordination
   - Rust: VP8 encoding (fast, safe)
   - C++ (libvpx): Actual compression

4. **HTTP chunked encoding enables streaming:**
   - No `Content-Length` header needed
   - Indefinite stream length
   - Cast device starts playing while receiving

5. **WebM muxer is essential:**
   - Wraps raw VP8 in container
   - Provides timestamps
   - Enables playback on Cast devices

6. **Latency is dominated by Cast device buffering:**
   - Encoding: ~20ms
   - Network: ~5ms
   - Cast buffering: ~200ms
   - Total: ~225ms (acceptable for tab casting)

7. **Adaptive frame dropping** prevents buffer buildup when network or encoder falls behind

---

## Related Documentation

- [VIDEO_ENCODING_CONCEPTS.md](./VIDEO_ENCODING_CONCEPTS.md) - Deep dive into VP8, I420, muxing
- [CAST_PROTOCOL.md](./CAST_PROTOCOL.md) - Cast protocol messages and namespaces
- [ARCHITECTURE_DEEP_DIVE.md](./ARCHITECTURE_DEEP_DIVE.md) - System architecture
- [LATENCY_OPTIMIZATION.md](./LATENCY_OPTIMIZATION.md) - How we reduced latency
