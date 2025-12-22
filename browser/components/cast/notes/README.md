# Firefox Cast Technical Documentation

Welcome to the Firefox Cast technical documentation! This collection of documents provides comprehensive coverage of the Cast streaming implementation, from protocol basics to optimization techniques.

## Quick Start

**New to media/Cast?** Start here:
1. [VIDEO_ENCODING_CONCEPTS.md](./VIDEO_ENCODING_CONCEPTS.md) - Learn video encoding fundamentals
2. [CAST_PROTOCOL.md](./CAST_PROTOCOL.md) - Understand the Cast protocol
3. [STREAMING_FLOW.md](./STREAMING_FLOW.md) - See how it all works together

**Want to understand the code?**
- [STREAMING_FLOW.md](./STREAMING_FLOW.md) - Complete step-by-step code walkthrough

**Working on performance?**
- [LATENCY_OPTIMIZATION.md](./LATENCY_OPTIMIZATION.md) - How we reduced lag from 10s to 220ms

---

## Documentation Overview

### Core Concepts

#### [VIDEO_ENCODING_CONCEPTS.md](./VIDEO_ENCODING_CONCEPTS.md)
**For:** Developers new to video/media programming
**Topics:**
- Video encoding basics (compression, codecs, containers)
- Color spaces (RGB vs YUV, I420, chroma subsampling)
- VP8 codec architecture and configuration
- WebM container format and muxing
- Compression techniques (spatial, temporal, DCT, quantization)
- Real-time encoding constraints and optimization

**Key sections:**
- Why we use I420 color space (4:2:0 subsampling)
- How VP8 encoding works (keyframes vs P-frames)
- What the muxer does (wrapping VP8 in WebM)
- Real-time encoding trade-offs

#### [CAST_PROTOCOL.md](./CAST_PROTOCOL.md)
**For:** Understanding Cast device communication
**Topics:**
- Protocol overview (TLS, Protocol Buffers, namespaces)
- Message structure and framing
- Standard namespaces (connection, heartbeat, receiver, media)
- Connection flow (TLS → CONNECT → LAUNCH → LOAD)
- Media control commands (PLAY, PAUSE, SEEK, STOP)
- Heartbeat mechanism (PING/PONG every 5s)

**Key sections:**
- Protocol Buffer message format
- How namespaces work
- Complete connection sequence diagram
- Media session lifecycle

---

### Implementation Deep Dives

#### [STREAMING_FLOW.md](./STREAMING_FLOW.md)
**For:** Understanding how the code actually works
**Topics:**
- Complete end-to-end flow (button click → video on TV)
- Phase 1: Setup & Connection (certificate validation, TLS)
- Phase 2: Encoder Preparation (VP8 encoder, HTTP server)
- Phase 3: Stream Synchronization (waiting for Cast to connect)
- Phase 4: Continuous Encoding Loop (capture → encode → stream)
- Detailed code walkthrough with file references

**Key sections:**
- Why encoding only starts when Cast connects (fixes 10s lag)
- How captureFrame() works (snapshot → canvas → RGBA → VP8)
- Message flow through the system
- Timeline diagrams showing exact timing

#### [LATENCY_OPTIMIZATION.md](./LATENCY_OPTIMIZATION.md)
**For:** Understanding performance improvements
**Topics:**
- Problem statement (10s lag, poor quality, choppy playback)
- Root cause analysis (5 major issues identified)
- Solution overview (stream sync, direct encoding, etc.)
- Detailed optimization explanations with measurements
- Before/after comparisons
- Future improvement opportunities

**Key sections:**
- Issue 1: Stream synchronization (10s lag fix)
- Issue 2: requestIdleCallback removal (25ms saved)
- Issue 3: Direct VP8 encoding (100ms saved)
- Latency breakdown (total: 229ms)
- Best practices for low-latency streaming

---

## Architecture Overview

### High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser UI Layer                        │
│  browser-cast.js - User interaction, Cast button            │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                    Service Layer                             │
│  CastService.sys.mjs - Device management, session control   │
│  CastSession.sys.mjs - Frame capture, encoding coordination │
└────────┬─────────────────────────┬──────────────────────────┘
         │                         │
         ▼                         ▼
┌─────────────────────┐   ┌──────────────────────────────────┐
│  JavaScript Module  │   │     Rust XPCOM Components        │
│  CastDevice.sys.mjs │   │  cast_device.rs - Cast protocol  │
│  Wrapper for XPCOM  │   │  video_encoder.rs - VP8 encoding │
└──────────┬──────────┘   └────────┬─────────────────────────┘
           │                       │
           ▼                       ▼
┌──────────────────────────────────────────────────────────────┐
│                    Native Libraries                           │
│  libvpx - VP8 codec                                          │
│  WebMWriter - WebM muxing                                    │
│  nsISocketTransport - TLS networking                         │
└──────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Browser Tab
  ↓ drawSnapshot() (GPU)
ImageBitmap
  ↓ drawImage() → getImageData() (GPU → CPU)
RGBA Array (3.6 MB for 720p)
  ↓ Pass to Rust XPCOM
video_encoder.rs
  ↓ rgba_to_i420() (3ms)
I420 Buffer (1.4 MB)
  ↓ vpx_codec_encode() (4ms)
VP8 Bitstream (~8 KB)
  ↓ WebM muxing (1ms)
WebM Cluster (~8.5 KB)
  ↓ Return to JavaScript
HTTP Chunked Encoding
  ↓ TCP/TLS (5ms)
Cast Device
  ↓ VP8 Hardware Decode (3ms)
  ↓ Buffer (200ms)
Display on TV
```

### Component Responsibilities

**JavaScript Layer:**
- User interaction
- Frame capture orchestration
- HTTP server management
- Cast protocol coordination

**Rust Layer:**
- VP8 encoding (performance-critical)
- WebM muxing
- Cast protocol implementation
- TLS connection management

**C++ Layer (via FFI):**
- libvpx (VP8 codec)
- WebMWriter (container muxing)
- Gecko networking (nsISocketTransport)

---

## Key Files Reference

### JavaScript

| File | Purpose | Key Functions |
|------|---------|---------------|
| `browser-cast.js` | UI integration | `openPanel()`, `startCasting()` |
| `CastService.sys.mjs` | Device management | `addManualDevice()`, `testConnection()` |
| `CastSession.sys.mjs` | Capture & encode | `captureFrame()`, `handleStreamRequest()` |
| `CastDevice.sys.mjs` | XPCOM wrapper | `connect()`, `sendMessage()` |
| `CastMediaHandler.sys.mjs` | Media control | `load()`, `play()`, `pause()` |
| `SimpleHTTPServer.sys.mjs` | HTTP streaming | `registerPathHandler()`, `start()` |

### Rust

| File | Purpose | Key Functions |
|------|---------|---------------|
| `lib.rs` | XPCOM exports | `NS_NewCastDevice()`, `NS_NewCastVideoEncoder()` |
| `constants.rs` | Centralized constants | `CAST_PORT`, `namespaces::*` |
| `state.rs` | Device state enum | `DeviceState::as_str()` |
| `messages.rs` | Typed messages | `ReceiverMessage`, `HeartbeatMessage` |
| `cast_device.rs` | Cast protocol | `connect()`, `send_message()` |
| `video_encoder.rs` | VP8 encoding | `init()`, `encode_frame()` |
| `stream_listener.rs` | Async messages | `on_data_available()`, `handle_message()` |
| `message.rs` | Protocol Buffers | `CastMessage::encode_to_vec()` |
| `handlers/connection.rs` | Connection messages | `create_connect_message()` |
| `handlers/heartbeat.rs` | Heartbeat handling | `handle_message()` |
| `handlers/receiver.rs` | Receiver messages | `create_launch()`, `create_get_status()` |
| `webm_writer_ffi.rs` | WebM muxing | `write_frame()`, `get_header()` |

### Protocol Buffers

| File | Purpose |
|------|---------|
| `cast_channel.proto` | Cast protocol message definition |

---

## Common Tasks

### Adding a New Cast Protocol Message

1. Add typed message struct to `src/messages.rs`
2. Create function to construct message in appropriate handler
3. Send via `send_message_internal()` or `send_message_to()`
4. Handle response in `stream_listener.rs::handle_message()` using typed parsing

**Example:**
```rust
// 1. In src/messages.rs - Add typed message
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ReceiverMessage {
    LAUNCH {
        #[serde(rename = "requestId")]
        request_id: u32,
        #[serde(rename = "appId")]
        app_id: String,
    },
    // ... other variants
}

// 2. In handlers/receiver.rs - Create constructor
use crate::constants::DEFAULT_MEDIA_RECEIVER_APP_ID;
use crate::messages::ReceiverMessage;

pub fn create_launch(&self, app_id: Option<&str>) -> String {
    serde_json::to_string(&ReceiverMessage::LAUNCH {
        request_id: self.next_request_id(),
        app_id: app_id.unwrap_or(DEFAULT_MEDIA_RECEIVER_APP_ID).to_string(),
    }).unwrap()
}

// 3. In cast_device.rs - Send message
let launch = device.create_launch_message(None);
self.send_message_internal(namespaces::RECEIVER, &launch)?;

// 4. In stream_listener.rs - Type-safe handling
use crate::messages::ReceiverMessage;
use crate::constants::namespaces;

match serde_json::from_str::<ReceiverMessage>(payload) {
    Ok(ReceiverMessage::RECEIVER_STATUS { status, .. }) => {
        // Type-safe field access, no unwraps needed
        if let Some(app) = status.applications.first() {
            println!("App: {}", app.session_id);
        }
    }
    Err(_) => {} // Parse error, ignore
    _ => {} // Other message types
}
```

### Modifying Encoding Parameters

**Location:** `browser/components/cast/src/video_encoder.rs:56-72`

```rust
cfg.g_w = width;                  // Resolution
cfg.g_h = height;
cfg.rc_target_bitrate = 4000;    // Bitrate (kbps)
cfg.g_error_resilient = 1;       // Error resilience
cfg.g_lag_in_frames = 0;         // Latency (0 = realtime)
cfg.g_threads = 2;               // Thread count
```

### Adjusting Keyframe Frequency

**Location:** `browser/components/cast/modules/CastSession.sys.mjs:289`

```javascript
// Current: Every 1 second (24 frames at 24fps)
const forceKeyframe = this._frameCount % this.fps === 0;

// More frequent (every 0.5 seconds):
const forceKeyframe = this._frameCount % (this.fps / 2) === 0;

// Less frequent (every 2 seconds):
const forceKeyframe = this._frameCount % (this.fps * 2) === 0;
```

### Changing FPS or Bitrate

**Location:** `browser/components/cast/content/browser-cast.js:129`

```javascript
const result = await this._castService.startTabCasting(
  deviceId,
  browser,
  window,
  { fps: 30, bitrate: 6000000 }  // 30 FPS @ 6 Mbps
);
```

### Debugging Cast Protocol Messages

**Enable logging:**
```bash
MOZ_LOG=cast:5 ./mach run
```

**View messages:**
```
CastDevice: -> [connection] CONNECT
CastStreamListener: <- [receiver] RECEIVER_STATUS
CastDevice: -> [media] LOAD
```

---

## Performance Characteristics

### Current Measurements

| Metric | Value | Notes |
|--------|-------|-------|
| Startup latency | ~1 second | Time to first frame on TV |
| Ongoing latency | ~225ms | Per-frame glass-to-glass |
| Frame rate | 24 fps | Configurable (15-60) |
| Resolution | Up to 1280×720 | Configurable |
| Bitrate | 4 Mbps | Configurable (2-10 typical) |
| CPU usage | ~25% | One core on MacBook Pro M1 |
| Network bandwidth | 4 Mbps | Steady state |

### Latency Breakdown

| Component | Latency | Percentage |
|-----------|---------|------------|
| Capture | 10ms | 4% |
| Encoding | 8ms | 4% |
| Network | 7ms | 3% |
| Cast buffering | 200ms | 89% |
| **Total** | **225ms** | **100%** |

**Bottleneck:** Cast device buffering (unavoidable with default receiver)

---

## Troubleshooting

### Common Issues

#### "Failed to add Cast device"
**Cause:** Certificate validation failed
**Solution:**
- Verify Cast device IP is correct
- Check device is on same network
- Try restarting Cast device

#### "Connection test failed"
**Cause:** Cast protocol connection failed
**Solution:**
- Check port 8009 is not blocked
- Verify TLS handshake succeeds
- Check logs: `MOZ_LOG=cast:5 ./mach run`

#### "Cast device never connects to stream"
**Cause:** HTTP server not reachable
**Solution:**
- Verify hostname resolution (mDNS)
- Try IP address instead of hostname
- Check firewall rules (port 8010)

#### "Video plays but is 10 seconds behind"
**Cause:** Stream synchronization bug (should be fixed)
**Solution:**
- Verify you have latest code
- Check `_encodingStarted` flag works
- Verify `handleStreamRequest()` starts capture

#### "Choppy playback"
**Cause:** Low frame rate or dropped frames
**Solution:**
- Increase FPS (24 → 30)
- Check CPU usage (should be < 50%)
- Verify stable network connection

#### "Poor quality"
**Cause:** Low bitrate or resolution
**Solution:**
- Increase bitrate (4 → 6 Mbps)
- Check resolution not being downscaled
- Verify VP8 encoding quality settings

---

## Future Work

### Short Term
- [ ] Add audio support (Opus encoding)
- [ ] Implement seek/pause controls in UI
- [ ] Add quality presets (Low/Medium/High)
- [ ] Network bandwidth adaptation

### Medium Term
- [ ] Hardware encoding (VideoToolbox/MediaCodec)
- [ ] VP9 codec option (better compression)
- [ ] Variable frame rate based on content
- [ ] Direct GPU encoding (skip CPU transfer)

### Long Term
- [ ] WebRTC data channel (ultra-low latency)
- [ ] Custom Cast receiver app
- [ ] Multi-device streaming
- [ ] Screen + camera picture-in-picture

---

## Contributing

### Before Making Changes

1. Read relevant documentation
2. Understand the component you're modifying
3. Profile performance impact
4. Test with actual Cast device

### Testing Changes

```bash
# Build
./mach build

# Run with logging
MOZ_LOG=cast:5 ./mach run

# Test with your Cast device
# 1. Click Cast button
# 2. Enter device IP
# 3. Click "Cast This Tab"
# 4. Observe latency, quality, smoothness
```

### Code Style

- Follow existing patterns
- Minimize comments (per CLAUDE.md)
- Use meaningful variable names
- Handle errors properly
- Add logging for debugging

---

## Additional Resources

### External Documentation

- [Cast Protocol](https://developers.google.com/cast/docs/reference) - Official Cast protocol docs
- [VP8 Spec](https://datatracker.ietf.org/doc/html/rfc6386) - VP8 codec specification
- [WebM Spec](https://www.webmproject.org/docs/container/) - WebM container format
- [libvpx](https://chromium.googlesource.com/webm/libvpx/) - VP8/VP9 codec library

### Related Firefox Code

- `dom/media/encoder/` - Media encoding infrastructure
- `dom/media/webm/` - WebM muxing implementation
- `xpcom/rust/xpcom/` - Rust XPCOM bindings

### Project Files

- [ARCHITECTURE.md](../ARCHITECTURE.md) - Original architecture overview
- [RUST_DESIGN.md](./RUST_DESIGN.md) - Rust component design
- [CODE_QUALITY_REFACTOR.md](./CODE_QUALITY_REFACTOR.md) - December 2024 refactoring details
- [CLEANUP_SUMMARY.md](./CLEANUP_SUMMARY.md) - Code cleanup summary

---

## Questions?

If you have questions about:
- **Video encoding concepts** → [VIDEO_ENCODING_CONCEPTS.md](./VIDEO_ENCODING_CONCEPTS.md)
- **Cast protocol** → [CAST_PROTOCOL.md](./CAST_PROTOCOL.md)
- **Code flow** → [STREAMING_FLOW.md](./STREAMING_FLOW.md)
- **Performance** → [LATENCY_OPTIMIZATION.md](./LATENCY_OPTIMIZATION.md)

Still confused? The documentation might be incomplete. Feel free to:
1. Add clarifying notes to the relevant .md file
2. Create a new document for complex topics
3. Update this README with better organization

Happy coding! 🎥
