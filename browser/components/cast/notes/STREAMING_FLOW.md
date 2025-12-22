# Complete Cast Streaming Flow

This document provides a detailed, step-by-step explanation of how Firefox Cast streaming works from button click to video on TV.

## Table of Contents

- [Overview](#overview)
- [Phase 1: Setup & Connection](#phase-1-setup--connection)
- [Phase 2: Encoder Preparation](#phase-2-encoder-preparation)
- [Phase 3: Stream Synchronization](#phase-3-stream-synchronization)
- [Phase 4: Continuous Encoding Loop](#phase-4-continuous-encoding-loop)
- [Timeline Diagram](#timeline-diagram)
- [Data Flow](#data-flow)

---

## Overview

The Cast streaming system consists of 4 distinct phases:

1. **Setup & Connection** - Establish Cast protocol connection
2. **Encoder Preparation** - Initialize VP8 encoder and HTTP server
3. **Stream Synchronization** - Wait for Cast device to connect
4. **Continuous Encoding** - Capture, encode, and stream frames

**Key Insight:** Encoding only starts when BOTH conditions are met: (1) Cast device acknowledges LOAD via MEDIA_STATUS, AND (2) Cast device connects to HTTP stream. This prevents accumulated buffer lag while avoiding chicken-and-egg deadlock.

---

## Phase 1: Setup & Connection

### Step 1.1: User Initiates Cast

**File:** `browser/components/cast/content/browser-cast.js:28-62`

```javascript
User clicks Cast icon
  ↓
gCastUI.openPanel()
  ↓
prompt("Enter Cast device IP address:")
  ↓
User enters IP (e.g., "192.168.1.171")
```

**User sees:** Input dialog requesting Cast device IP address.

### Step 1.2: Add Device (Certificate Validation)

**File:** `browser/components/cast/CastService.sys.mjs:121-162`

```javascript
await castService.addManualDevice("192.168.1.171", 8009)
```

**What happens:**

1. Create `CastDevice` object (JavaScript wrapper)
2. Call `device.addCertificateOverride()`
   - Makes HTTPS request to `https://192.168.1.171:8009/`
   - Retrieves self-signed certificate
   - Validates certificate is self-signed (issuer === subject)
   - Adds exception to Firefox's certificate override service
3. **No Cast protocol connection yet** - only certificate preparation

**File:** `browser/components/cast/modules/CastDevice.sys.mjs:82-136`

**Important:** This step just validates SSL/TLS will work. The actual Cast connection happens next.

### Step 1.3: Establish Cast Protocol Connection

**File:** `browser/components/cast/content/browser-cast.js:65-81`

```javascript
await castService.testConnection(deviceId)
  ↓
await device.connect()  // ← ACTUAL CAST CONNECTION
```

**File:** `browser/components/cast/modules/CastDevice.sys.mjs:88-103`

This calls into Rust XPCOM component:

**File:** `browser/components/cast/src/cast_device.rs:86-199`

**Detailed steps:**

```rust
// 1. Create TLS socket transport
let sts_service = SocketTransport::service::<nsISocketTransportService>()?;
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
let get_status = json!({"type": "GET_STATUS", "requestId": 1}).to_string();
self.send_message_internal("urn:x-cast:com.google.cast.receiver", &get_status)?;

// 9. Notify JavaScript layer
self.notify_state_change("connected");
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

**File:** `browser/components/cast/content/browser-cast.js:120-143`

```javascript
await castService.startTabCasting(deviceId, browser, window, {
  fps: 24,
  bitrate: 4000000  // 4 Mbps
})
```

**File:** `browser/components/cast/modules/CastSession.sys.mjs:44-161`

### Step 2.2: Calculate Canvas Dimensions

**Lines 56-73:**

```javascript
// Get browser dimensions
this.width = browser.clientWidth || 1280;
this.height = browser.clientHeight || 720;

// Enforce maximum dimensions
const maxWidth = 1280;
const maxHeight = 720;

// Scale down if necessary (maintain aspect ratio)
if (canvasWidth > maxWidth || canvasHeight > maxHeight) {
  const widthRatio = maxWidth / canvasWidth;
  const heightRatio = maxHeight / canvasHeight;
  const scaleRatio = Math.min(widthRatio, heightRatio);
  canvasWidth = Math.floor(canvasWidth * scaleRatio);
  canvasHeight = Math.floor(canvasHeight * scaleRatio);
}
```

**Example:**
- Browser: 1920x1080 → Scaled to: 1280x720
- Browser: 800x600 → No scaling: 800x600

### Step 2.3: Create Canvas

**Lines 75-84:**

```javascript
this.canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
this.canvas.width = canvasWidth;   // e.g., 1280
this.canvas.height = canvasHeight; // e.g., 720

this.ctx = this.canvas.getContext("2d", {
  alpha: false,           // No transparency
  willReadFrequently: false
});
```

**Purpose:** Canvas is used temporarily for getting RGBA pixel data from snapshots.

### Step 2.4: Initialize Rust VP8 Encoder

**Lines 86-104:**

```javascript
this.fps = 24;
const videoBitsPerSecond = 4000000;  // 4 Mbps

// Create Rust XPCOM component
this._encoder = Cc["@mozilla.org/cast/video-encoder;1"]
  .createInstance(Ci.nsICastVideoEncoder);

// Initialize encoder
this._encoder.init(canvasWidth, canvasHeight, videoBitsPerSecond, this.fps);
```

**This calls Rust:** `browser/components/cast/src/video_encoder.rs:46-131`

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
cfg.rc_target_bitrate = 4000; // 4000 kbps (converted from bps)
cfg.g_error_resilient = 1;   // Enable error resilience
cfg.g_lag_in_frames = 0;     // No frame delay (real-time)
cfg.g_threads = 2;           // Use 2 threads

// Initialize VP8 encoder context
let mut ctx: vpx_codec_ctx = zeroed();
vpx_codec_enc_init_ver(&mut ctx, iface, &cfg, 0, VPX_ENCODER_ABI_VERSION);

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
CastVideoEncoder::init: Initialized VP8 encoder (1280x720, 4000kbps, 24fps)
```

### Step 2.5: Get WebM Header

**Lines 98-104:**

```javascript
this._webmHeader = this._encoder.getHeader();
// Returns: Array of bytes (~127 bytes)
```

**File:** `browser/components/cast/src/video_encoder.rs:221-235`

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

**Lines 106-133:**

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
- `http://Harshits-MacBook.local:8010/stream.webm` (using mDNS hostname)
- `http://192.168.1.123:8010/stream.webm` (using IP address)

**Console output:**
```
Stream URL: http://192.168.1.123:8010/stream.webm (using fallback IP)
```

**Important:** Server is now listening, but NO encoding is happening yet!

### Step 2.7: Tell Cast Device to Load Stream

**Lines 139-147:**

```javascript
this.mediaHandler = new CastMediaHandler(this.castDevice);

const metadata = {
  metadataType: 0,
  title: "Firefox Tab Cast",
};

await this.mediaHandler.load(streamURL, "video/webm", "LIVE", metadata);
```

**File:** `browser/components/cast/modules/CastMediaHandler.sys.mjs`

**Cast protocol message sent:**

```json
{
  "type": "LOAD",
  "requestId": 1234567890,
  "media": {
    "contentId": "http://192.168.1.123:8010/stream.webm",
    "contentType": "video/webm",
    "streamType": "LIVE",
    "metadata": {
      "metadataType": 0,
      "title": "Firefox Tab Cast"
    }
  },
  "autoplay": true,
  "currentTime": 0
}
```

**Sent to:** `urn:x-cast:com.google.cast.media` namespace

**Cast device response:**
```json
{
  "type": "MEDIA_STATUS",
  "status": [{
    "mediaSessionId": 1,
    "media": { ... },
    "playerState": "BUFFERING",
    "currentTime": 0
  }]
}
```

**Console output:**
```
Waiting for Cast device to connect to stream before encoding...
```

**Critical:** At this point:
- ✅ Encoder initialized
- ✅ HTTP server running
- ✅ Cast device knows the URL
- ❌ NOT encoding yet
- ❌ No frames being captured
- ⏳ Waiting for Cast device to connect...

---

## Phase 3: Stream Synchronization

### Step 3.1: Cast Device Processes LOAD Command

**Timeline:**

```
T+0ms:    Cast device receives LOAD message
T+500ms:  Cast device initializes media player
T+1000ms: Cast device prepares network stack
T+2000ms: Cast device resolves hostname (if using mDNS)
T+5000ms: Cast device makes HTTP GET request
```

**Why the delay?**
- Media player initialization
- DNS/mDNS resolution
- Buffer allocation
- UI updates on Cast device

### Step 3.2: Cast Device Makes HTTP Request

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

**File:** `browser/components/cast/modules/CastSession.sys.mjs:163-209`

### Step 3.3: Send HTTP Response

**Lines 165-181:**

```javascript
lazy.logConsole.debug("Cast device connected to stream! Starting encoding now...");

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

### Step 3.4: Send WebM Header Immediately

**Lines 183-186:**

```javascript
if (this._webmHeader && this._webmHeader.length > 0) {
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

**What Cast device gets:**
```
HTTP/1.1 200 OK
Content-Type: video/webm
...

7f
[EBML header + Segment Info + Track metadata]

← Stream continues with frame data...
```

**Console output:**
```
Cast device connected to stream! Starting encoding now...
Sending WebM header: 127 bytes
```

### Step 3.5: Synchronization Wait - Two Conditions Required

**Critical synchronization:** Encoding only starts when BOTH conditions are met:

1. **MEDIA_STATUS received** from Cast device (confirms LOAD acknowledged)
2. **HTTP stream connection** established (Cast device connected to our server)

**Why this approach?**
- Starting too early → Pre-buffered frames cause lag
- Waiting for PLAYING → Chicken-and-egg problem (needs frames to start playing)
- **Solution:** Wait for MEDIA_STATUS acknowledgment, THEN start encoding

**File:** `browser/components/cast/modules/CastSession.sys.mjs:166-208`

#### Case A: MEDIA_STATUS Arrives First (Typical Flow)

**Timeline:**
```
T+0ms:    LOAD sent to Cast device
T+100ms:  MEDIA_STATUS received (playerState: IDLE/LOADING)
          → Set _receivedMediaStatus = true
T+5000ms: Cast device connects to HTTP stream
          → Check: _receivedMediaStatus == true? YES
          → Start encoding immediately!
```

**Code in handleStreamRequest():**
```javascript
if (this._receivedMediaStatus) {
  lazy.logConsole.debug("Media status already received, starting encoding now");
  this.startCaptureLoop();
} else {
  lazy.logConsole.debug("Waiting for first MEDIA_STATUS before starting encoding...");
  this._pendingStreamConnection = true;
}
```

#### Case B: Stream Connection Arrives First (Race Condition)

**Timeline:**
```
T+0ms:    LOAD sent to Cast device
T+100ms:  Cast device connects to HTTP stream (fast network)
          → Set _pendingStreamConnection = true
          → Wait...
T+200ms:  MEDIA_STATUS received
          → Check: _pendingStreamConnection == true? YES
          → Start encoding now!
```

**Code in handleMediaMessage():**
```javascript
if (!this._receivedMediaStatus) {
  this._receivedMediaStatus = true;
  lazy.logConsole.debug("Received first MEDIA_STATUS");

  if (this._pendingStreamConnection && this.streamConnection) {
    lazy.logConsole.debug("Stream connection is ready, starting encoding now");
    this._pendingStreamConnection = false;
    this.startCaptureLoop();
  }
}
```

### Step 3.6: Start Capture Loop (When Both Conditions Met)

**File:** `browser/components/cast/modules/CastSession.sys.mjs:227-252`

```javascript
startCaptureLoop() {
  this._encodingStarted = true;
  this._streamStartTime = Date.now();
  this._nextFrameTime = this._streamStartTime;

  const intervalMs = 1000 / this.fps;  // 24 FPS = 41.666ms

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
Both stream connection and MEDIA_STATUS ready! Starting capture at: 1766430166792
Started capture loop at 24 FPS (interval: 41.666666666666664ms)
```

**Key improvements:**
- `requestAnimationFrame` instead of `setInterval` (better timing precision)
- Scheduled frame timing with `_nextFrameTime` accumulator (prevents drift)
- Real timestamps from `_streamStartTime` (not synthetic)
- Defensive checks prevent race condition with cleanup

**Timeline from this moment:**
```
T+5100ms: Both conditions met → startCaptureLoop() called
T+5100ms: Frame 0 captured (timestamp: 0ms)
T+5142ms: Frame 1 captured (timestamp: 42ms)
T+5183ms: Frame 2 captured (timestamp: 83ms)
...every ~42ms at precise intervals...
```

---

## Phase 4: Continuous Encoding Loop

### Step 4.1: Capture Frame Overview

**File:** `browser/components/cast/modules/CastSession.sys.mjs:228-303`

**High-level flow:**

```
captureFrame() called every ~42ms
  ↓
Get scroll position from content process
  ↓
Take snapshot of browser content
  ↓
Draw snapshot to canvas
  ↓
Get RGBA pixel data from canvas
  ↓
Call Rust encoder with RGBA data
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

### Step 4.2: Guard Against Concurrent Captures

**Lines 229-237:**

```javascript
async captureFrame() {
  if (!this.browser || !this._encoder || !this.canvas) {
    return;  // Not ready
  }

  if (this.isCapturing) {
    return;  // Already capturing, skip this tick
  }

  this.isCapturing = true;
```

**Why needed?**
- Capture is async (uses `await`)
- If frame capture takes > 42ms, next interval fires
- This prevents multiple captures running simultaneously

### Step 4.3: Get Scroll Position

**Lines 240-262:**

```javascript
const browsingContext = this.browser.browsingContext;
const scale = browsingContext.overrideDPPX || this.window.devicePixelRatio || 1;

let scrollX = 0, scrollY = 0;

try {
  // Get actor in content process
  const actor = this.browser.browsingContext.currentWindowGlobal.getActor("CastTab");

  // Ask content process for viewport position
  const viewportInfo = await actor.getViewportInfo();
  if (viewportInfo) {
    scrollX = viewportInfo.scrollX || 0;
    scrollY = viewportInfo.scrollY || 0;
  }
} catch (e) {
  lazy.logConsole.error("Failed to get viewport info:", e);
}
```

**File:** `browser/components/cast/actors/CastTabChild.sys.mjs`

**Why get scroll position?**
- Browser content might be scrolled
- We want to capture the visible viewport, not top-left of page
- Content process knows exact scroll position

**Example:**
- User scrolled to middle of long page
- scrollX = 0, scrollY = 2000
- We capture from (0, 2000) to (1280, 2720)

### Step 4.4: Take Snapshot

**Lines 264-269:**

```javascript
const rect = new DOMRect(scrollX, scrollY, this.width, this.height);

const snapshot = await browsingContext.currentWindowGlobal.drawSnapshot(
  rect,
  scale,
  "rgb(255, 255, 255)"  // White background color
);
```

**What is `drawSnapshot`?**
- Gecko internal API
- Renders browser content to GPU surface
- Returns `ImageBitmap` (GPU texture)
- Very fast (hardware-accelerated)

**Parameters:**
- `rect` - Area to capture (x, y, width, height)
- `scale` - Device pixel ratio (e.g., 2.0 for Retina displays)
- `backgroundColor` - Used for transparency

**Result:** `ImageBitmap` object (GPU memory, not accessible to JS directly)

### Step 4.5: Draw to Canvas

**Lines 271-279:**

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

### Step 4.6: Get RGBA Pixel Data

**Lines 281-287:**

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

### Step 4.7: Encode Frame

**Lines 289-290:**

```javascript
const forceKeyframe = this._frameCount % this.fps === 0;
const webmCluster = this._encoder.encodeFrame(rgbaData, forceKeyframe);
```

**When are keyframes forced?**
- Frame 0, 24, 48, 72... (every 1 second at 24fps)
- Keyframes are larger but allow seeking/recovery

**This calls Rust:** `browser/components/cast/src/video_encoder.rs:133-219`

**Rust encoding process:**

#### Step 4.7a: Convert RGBA to I420

**File:** `browser/components/cast/src/video_encoder.rs:320-368`

```rust
fn rgba_to_i420(rgba: &[u8], width: u32, height: u32, img: &mut vpx_image_t) {
  // For each pixel:
  for y in 0..height {
    for x in 0..width {
      let rgba_idx = ((y * width + x) * 4) as usize;
      let r = rgba[rgba_idx] as f32;
      let g = rgba[rgba_idx + 1] as f32;
      let b = rgba[rgba_idx + 2] as f32;

      // Convert RGB to Y (luma)
      let y_val = (0.299 * r + 0.587 * g + 0.114 * b) as u8;
      y_plane[y * y_stride + x] = y_val;

      // Convert RGB to U and V (chroma) - only for even pixels (4:2:0 subsampling)
      if x % 2 == 0 && y % 2 == 0 {
        let u_val = ((-0.169 * r - 0.331 * g + 0.500 * b) + 128.0) as u8;
        let v_val = ((0.500 * r - 0.419 * g - 0.081 * b) + 128.0) as u8;

        u_plane[(y/2) * u_stride + (x/2)] = u_val;
        v_plane[(y/2) * v_stride + (x/2)] = v_val;
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

#### Step 4.7b: Encode with libvpx

**File:** `browser/components/cast/src/video_encoder.rs:171-186`

```rust
let timestamp_ms = (frame_count * 1000) / (fps as u64);
let duration = 1000 / fps as u64;  // Duration of this frame in ms

let flags = if force_keyframe {
  VPX_EFLAG_FORCE_KF  // Force keyframe
} else {
  0  // Regular frame
};

let ret = vpx_codec_encode(
  vpx_ctx.ctx.as_mut(),
  &vpx_ctx.img as *const vpx_image_t,  // I420 image
  timestamp_ms as i64,                  // PTS (presentation timestamp)
  duration as u64,                       // Duration in ms
  flags,                                 // Flags (keyframe, etc.)
  VPX_DL_REALTIME                       // Deadline: REALTIME (low latency)
);
```

**libvpx encoding parameters:**
- `VPX_DL_REALTIME` - Prioritize speed over compression
- `timestamp_ms` - When to display this frame
- `duration` - How long to display (41ms at 24fps)
- `flags` - Force keyframe or allow inter-frame

**Output:** VP8 compressed bitstream (~5-20 KB typically)

#### Step 4.7c: Extract Encoded Packets

**File:** `browser/components/cast/src/video_encoder.rs:188-206`

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

#### Step 4.7d: Mux into WebM

**File:** `browser/components/cast/src/video_encoder.rs:208-216`

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

### Step 4.8: Write to HTTP Stream

**Lines 292-297:**

```javascript
if (this.streamConnection && webmCluster && webmCluster.length > 0) {
  this.writeChunk(this.streamConnection.outputStream, webmCluster);
}

this._frameCount++;
this.lastCaptureTime = Date.now();
```

**File:** `browser/components/cast/modules/CastSession.sys.mjs:211-226`

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
← Chunk: Frame 24 (keyframe, 9103 bytes)
...
```

### Step 4.9: Cast Device Processing

**Cast device:**
1. Receives HTTP chunks
2. Buffers ~200ms worth of video
3. Parses WebM structure
4. Extracts VP8 frames
5. Decodes VP8 with hardware decoder
6. Renders to display at 24fps

**Buffering strategy:**
```
T+5000ms: Receives Frame 0
T+5010ms: Buffers...
T+5200ms: Starts playback (200ms buffer)
T+5200ms: Displays Frame 0
T+5242ms: Displays Frame 1
T+5283ms: Displays Frame 2
```

---

## Timeline Diagram

### Complete Flow Timeline

```
Time    | Firefox                          | Cast Device
--------|----------------------------------|---------------------------
T+0ms   | User clicks Cast button          |
T+50ms  | addManualDevice()                |
T+500ms | Certificate validation           |
T+1000ms| device.connect()                 | Receives CONNECT
T+1100ms| TLS handshake                    | TLS handshake
T+1200ms| Send CONNECT, GET_STATUS         | Processes messages
T+1300ms| startTabCasting()                | Sends RECEIVER_STATUS
T+1400ms| Initialize encoder               |
T+1500ms| Start HTTP server                |
T+1600ms| Send LOAD command                | Receives LOAD
T+1700ms| Condition 1: MEDIA_STATUS rcvd ✓ | Sends MEDIA_STATUS (IDLE)
T+2000ms|                                  | Initialize media player
T+3000ms|                                  | Resolve hostname
T+5000ms| Condition 2: Stream connected ✓  | Makes HTTP GET request
T+5000ms| handleStreamRequest() triggered! |
T+5001ms| Send HTTP headers                | Receives headers
T+5002ms| Send WebM header                 | Receives WebM header
T+5003ms| BOTH CONDITIONS MET!             |
T+5003ms| Start capture loop NOW           |
T+5003ms| captureFrame() - Frame 0         |
T+5010ms| Encode complete                  | Receives Frame 0
T+5011ms| Send Frame 0                     | Starts buffering
T+5045ms| captureFrame() - Frame 1         |
T+5052ms| Send Frame 1                     | Receives Frame 1
T+5087ms| captureFrame() - Frame 2         |
T+5094ms| Send Frame 2                     | Receives Frame 2
T+5200ms|                                  | Start playback!
T+5200ms|                                  | Display Frame 0
T+5242ms|                                  | Display Frame 1
T+5283ms|                                  | Display Frame 2
...     | Continues every ~42ms            | Continues playback
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

1. **Encoding only starts when Cast device connects** - Solves the 10-second lag problem

2. **Three-layer encoding pipeline:**
   - JavaScript: Capture & coordination
   - Rust: VP8 encoding (fast, safe)
   - C++ (libvpx): Actual compression

3. **HTTP chunked encoding enables streaming:**
   - No `Content-Length` header needed
   - Indefinite stream length
   - Cast device starts playing while receiving

4. **WebM muxer is essential:**
   - Wraps raw VP8 in container
   - Provides timestamps
   - Enables playback on Cast devices

5. **Latency is dominated by Cast device buffering:**
   - Encoding: ~20ms
   - Network: ~5ms
   - Cast buffering: ~200ms
   - Total: ~225ms (acceptable for tab casting)

---

## Related Documentation

- [VIDEO_ENCODING_CONCEPTS.md](./VIDEO_ENCODING_CONCEPTS.md) - Deep dive into VP8, I420, muxing
- [CAST_PROTOCOL.md](./CAST_PROTOCOL.md) - Cast protocol messages and namespaces
- [ARCHITECTURE_DEEP_DIVE.md](./ARCHITECTURE_DEEP_DIVE.md) - System architecture
- [LATENCY_OPTIMIZATION.md](./LATENCY_OPTIMIZATION.md) - How we reduced latency
