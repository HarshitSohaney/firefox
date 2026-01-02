# Google Cast Support for Firefox

Cast browser tabs to Chromecast and other Cast-enabled devices directly from Firefox.

## About Cast

This feature allows users to stream their Firefox tab content to any Cast-enabled device (Chromecast, Google TV, Cast-enabled smart TVs). It functions like a real-time screen share, capturing the browser tab and encoding it as a live video stream that the Cast device can display.

The implementation uses the Google Cast protocol, which has been reverse-engineered and documented publicly. Our implementation consists of:
- **Rust XPCOM components** for the protocol layer and video encoding
- **JavaScript modules** for UI integration, session management, and device discovery

### How It Works

1. **Device Discovery**: Firefox sends mDNS queries to find Cast devices on the local network
2. **Connection**: Establishes a TLS connection to the device on port 8009
3. **App Launch**: Launches the Default Media Receiver app on the Cast device
4. **Tab Capture**: Captures tab content using `drawSnapshot()` and encodes frames to VP8
5. **Streaming**: Serves the WebM video stream over HTTP; the Cast device fetches and plays it

## Why?

- **Highly requested feature** on Firefox Connect
- **No cables needed**: Share content wirelessly without HDMI or other physical connections
- **Practical use cases**:
  - Share photos or presentations with a group on a TV
  - Display web content on a larger screen for meetings
  - Stream video content from browser tabs
  - Demo websites and applications

## The Cast Protocol

The Cast protocol is Google's proprietary protocol for communicating with Cast-enabled devices.

### Key Characteristics

| Property | Value |
|----------|-------|
| Transport | TLS over TCP (port 8009) |
| Encoding | Protocol Buffers (binary) |
| Messaging | Namespace-based (similar to XMPP) |
| Communication | Bidirectional |

### Two-Channel Architecture

Cast uses separate channels for control and data:

| Channel | Port | Protocol | Purpose |
|---------|------|----------|---------|
| Control | 8009 | TLS + Protobuf | Device commands, app lifecycle, media control |
| Data | 8010 | HTTP | Video stream (WebM chunks) |

### Message Structure

```
Wire Format:
[4 bytes: length (big-endian)]
[N bytes: protobuf CastMessage]

CastMessage fields:
- protocol_version: 0
- source_id: "sender-0"
- destination_id: "receiver-0" or transportId
- namespace: "urn:x-cast:..."
- payload_type: STRING (0)
- payload_utf8: JSON message
```

### Namespaces

| Namespace | Purpose | Key Messages |
|-----------|---------|--------------|
| `urn:x-cast:com.google.cast.tp.connection` | Virtual connections | CONNECT, CLOSE |
| `urn:x-cast:com.google.cast.tp.heartbeat` | Keep-alive (5s interval) | PING, PONG |
| `urn:x-cast:com.google.cast.receiver` | App lifecycle | GET_STATUS, LAUNCH, STOP |
| `urn:x-cast:com.google.cast.media` | Media control | LOAD, PLAY, PAUSE, STOP |

For detailed protocol documentation, see [notes/CAST_PROTOCOL.md](notes/CAST_PROTOCOL.md).

## Key Concepts

### Sockets

A **socket** is an endpoint for network communication between two programs. It's like a phone line: once established, data can flow in both directions. Sockets are identified by an IP address and port number (e.g., `192.168.1.100:8009`).

**TCP (Transmission Control Protocol)** sockets guarantee reliable, ordered delivery of data. If a packet is lost, TCP automatically retransmits it. This is essential for video streaming where dropped frames would cause glitches.

**TLS (Transport Layer Security)** adds encryption on top of TCP. Data is encrypted before sending and decrypted on receipt, preventing eavesdropping. TLS also verifies the server's identity via certificates.

**In Cast:** We use two separate socket connections:

| Channel | Port | Direction | Purpose |
|---------|------|-----------|---------|
| **Control** | 8009 | Firefox -> Cast device | TLS + Protobuf. Send commands: connect, launch app, load media URL |
| **Video Stream** | 8010 | Cast device -> Firefox | HTTP. Cast device fetches the video stream from our HTTP server |

The video stream (port 8010) is where the actual tab content flows. Firefox runs an HTTP server (`SimpleHTTPServer.sys.mjs`) that serves the WebM-encoded video. When we tell the Cast device to play `http://<our-ip>:8010/stream.webm`, it opens a connection back to Firefox and pulls the video data. We respond with chunked transfer encoding, sending WebM clusters as fast as we encode them.

```
Firefox                                    Cast Device
   |                                            |
   |----[TLS:8009] LOAD url=:8010/stream.webm-->|
   |                                            |
   |<---[HTTP:8010] GET /stream.webm------------|
   |----[HTTP:8010] 200 OK, chunked------------>|
   |----[HTTP:8010] WebM header---------------->|
   |----[HTTP:8010] VP8 frame 1---------------->|
   |----[HTTP:8010] VP8 frame 2---------------->|
   |----[HTTP:8010] VP8 frame 3---------------->|
   |              ... continuous ...            |
```

This two-channel design separates control (what to play) from data (the actual video). The Cast device has an optimized HTTP video client, so we leverage that rather than streaming over the Cast protocol itself.

### Media Codecs

A **codec** (coder/decoder) compresses raw video into a smaller format for transmission, then decompresses it for playback. Without compression, 1 second of 720p video would be ~63 MB. With VP8 compression, it's ~500 KB (a 129:1 ratio).

**How video encoding works:**
1. **Color conversion**: Convert RGB pixels to YUV, which separates brightness from color
2. **Chroma subsampling**: Reduce color resolution (humans notice brightness more than color)
3. **Block transform**: Divide frame into 16x16 blocks, apply mathematical transforms
4. **Quantization**: Reduce precision of values (lossy step that achieves most compression)
5. **Entropy coding**: Encode remaining values efficiently

A **container format** (like WebM or MP4) wraps encoded video with metadata: timestamps, resolution, codec info. This allows players to seek and synchronize playback.

**In Cast:**
| Component | What It Is | Our Choice |
|-----------|------------|------------|
| Video codec | Compresses frames | VP8 (fast, royalty-free) |
| Container | Wraps frames with metadata | WebM (streaming-friendly) |
| Color space | Internal pixel format | I420/YUV (4:2:0 subsampling) |

**Why VP8 over VP9?** VP8 encodes ~3x faster. For real-time capture at 24fps, each frame must encode in under 42ms. VP9's better compression isn't worth the speed penalty.

For detailed encoding documentation, see [notes/VIDEO_ENCODING_CONCEPTS.md](notes/VIDEO_ENCODING_CONCEPTS.md).

### Internet Protocols

**Protocols** are standardized rules for how computers communicate. Each handles a specific job:

| Protocol | What It Does | Analogy |
|----------|--------------|---------|
| **TCP** | Reliable data delivery over IP networks | Certified mail (guaranteed delivery) |
| **UDP** | Fast, unreliable data delivery | Postcards (might not arrive) |
| **TLS** | Encrypts TCP connections | Sealed envelope |
| **HTTP** | Request/response for web content | Asking a librarian for a book |
| **DNS** | Translates names to IP addresses | Phone book lookup |
| **mDNS** | DNS without a central server (local network) | Shouting "who has X?" in a room |
| **Protobuf** | Binary serialization format | Efficient packing for shipping |

**In Cast:**
- **mDNS/UDP**: Discover Cast devices on local network
- **TLS/TCP**: Encrypted control channel (port 8009)
- **HTTP/TCP**: Video stream delivery (port 8010)
- **Protobuf**: Encode Cast protocol messages

### mDNS Device Discovery

**The problem:** How does Firefox find Cast devices without knowing their IP addresses?

**Traditional DNS** requires a central server that knows all names and addresses. This doesn't work for local devices like Chromecasts that join and leave networks dynamically.

**mDNS (Multicast DNS)** solves this by broadcasting queries to all devices on the network. Instead of asking a server, Firefox shouts "Who provides Google Cast service?" to everyone. Cast devices listening on the network respond directly with their information.

**How it works:**
1. Firefox sends a UDP packet to the multicast address `224.0.0.251:5353`
2. The packet asks: "Who has `_googlecast._tcp.local`?"
3. All Cast devices on the network hear this and respond with DNS records:
   - **PTR**: "I'm called Living-Room-TV"
   - **SRV**: "Connect to me at port 8009"
   - **TXT**: "My friendly name is 'Living Room TV', I'm a Chromecast"
   - **A**: "My IP address is 192.168.1.50"
4. Firefox parses these responses and builds a device list

**DNS-SD (DNS Service Discovery)** is the naming convention used with mDNS. Services are identified by names like `_googlecast._tcp.local` where `_googlecast` is the service type and `_tcp` indicates the transport.

For detailed discovery documentation, see [notes/cast-mdns-architecture.md](notes/cast-mdns-architecture.md).

### Rust and XPCOM in Firefox

**The problem:** We need high-performance video encoding (Rust is ideal) but also UI integration (JavaScript is ideal). How do we connect them?

**FFI (Foreign Function Interface)** is the standard way to call code written in one language from another. You define C-style function signatures and call across the boundary. However, FFI requires manual memory management and doesn't support callbacks well.

**XPCOM (Cross-Platform Component Object Model)** is Firefox's component system. Components are defined by interfaces (IDL files), implemented in any language (Rust, C++, JavaScript), and accessed uniformly. XPCOM provides:
- **Reference counting**: Automatic memory management
- **QueryInterface**: Runtime type checking
- **Callbacks**: Components can call back into JavaScript
- **Thread safety**: Built-in marshaling between threads

**In Cast:** We define two XPCOM interfaces:
- `nsICastDevice`: Connect to devices, send/receive Cast protocol messages
- `nsICastVideoEncoder`: Encode RGBA frames to VP8/WebM

JavaScript creates these components and calls methods on them. The Rust implementation handles the heavy lifting (TLS, protobuf parsing, VP8 encoding via libvpx). When events occur (message received, state changed), Rust invokes JavaScript callbacks.

```
JavaScript (CastSession.sys.mjs)
       ↓ createInstance()
nsICastVideoEncoder (XPCOM interface)
       ↓ implemented by
video_encoder.rs (Rust)
       ↓ calls
libvpx (C library via FFI)
```

For detailed Rust design documentation, see [notes/RUST_DESIGN.md](notes/RUST_DESIGN.md).

## Challenges

### Certificate Overrides

Cast devices use self-signed certificates for TLS. Firefox normally rejects these, so we call `rememberValidityOverride()` to add an exception before connecting. The certificate must be verified as self-signed (issuer equals subject) to prevent accepting arbitrary certificates.

### Live Stream Buffering

The Default Media Receiver app treats our stream as a live broadcast and expects continuous data. This creates several challenges:

1. **Startup delay**: The Cast device buffers 3-5 seconds of data before playback begins, causing an initial delay even though encoding starts immediately

2. **Lag accumulation**: If frames are encoded faster than playback, lag accumulates indefinitely. Our solution: track receiver playback position and skip frames when more than 1 second ahead

3. **Timestamp synchronization**: Timestamps must be continuous for the live stream. The frame-skipping heuristic handles this for video but complicates audio integration (future work)

For detailed latency documentation, see [notes/LATENCY_OPTIMIZATION.md](notes/LATENCY_OPTIMIZATION.md).

### Video Quality at FFI Boundary

Early versions had blurry output despite high bitrate settings:

1. **Canvas interpolation**: Default `imageSmoothingQuality: "low"` caused blur when scaling. Fix: set to `"high"` for Lanczos-like interpolation

2. **Color space conversion**: Initial RGBA to I420 conversion used incorrect coefficients, producing washed-out colors. Fix: use BT.709 HD color space with proper limited range (16-235 for Y)

For detailed quality fixes, see [notes/FINAL_QUALITY_FIX.md](notes/FINAL_QUALITY_FIX.md).

## File Structure

```
browser/components/cast/
|
+-- Service Layer
|   +-- CastService.sys.mjs            # Singleton managing devices and sessions
|
+-- JavaScript Modules (modules/)
|   +-- CastDevice.sys.mjs             # Wrapper around Rust XPCOM device
|   +-- CastSession.sys.mjs            # Tab casting (capture, encode, stream)
|   +-- CastMediaSession.sys.mjs       # Remote URL casting
|   +-- CastMediaHandler.sys.mjs       # Media namespace protocol
|   +-- CastDiscovery.sys.mjs          # mDNS device discovery
|   +-- SimpleHTTPServer.sys.mjs       # HTTP server for video streaming
|   +-- CastConstants.mjs              # Error codes, states, namespaces
|   +-- CastError.mjs                  # Custom error type
|
+-- UI (content/)
|   +-- browser-cast.js                # Browser UI integration
|   +-- castPanel.inc.xhtml            # Cast panel markup
|
+-- XPCOM Interfaces
|   +-- nsICastDevice.idl              # Device protocol interface
|   +-- nsICastVideoEncoder.idl        # Video encoder interface
|   +-- components.conf                # Component registration
|   +-- cast_device.h                  # C++ header for device FFI
|   +-- cast_video_encoder.h           # C++ header for encoder FFI
|
+-- Rust Implementation (src/)
|   +-- lib.rs                         # Crate root, XPCOM exports
|   +-- cast_device.rs                 # Device component (TLS, protocol)
|   +-- video_encoder.rs               # VP8 encoder component
|   +-- stream_listener.rs             # Async message receiver
|   +-- message.rs                     # Protocol Buffer structures
|   +-- messages.rs                    # Message handling utilities
|   +-- state.rs                       # DeviceState enum
|   +-- constants.rs                   # Protocol constants
|   +-- vpx_ffi.rs                     # libvpx FFI bindings
|   +-- webm_writer_ffi.rs             # WebM muxer FFI bindings
|   +-- handlers/
|       +-- mod.rs                     # Handler module exports
|       +-- connection.rs              # CONNECT/CLOSE helper
|       +-- heartbeat.rs               # PING/PONG helper
|       +-- receiver.rs                # GET_STATUS/LAUNCH helpers
|
+-- Build Configuration
|   +-- Cargo.toml                     # Rust dependencies
|   +-- moz.build                      # Firefox build integration
|
+-- Documentation (notes/)
    +-- CAST_PROTOCOL.md               # Detailed protocol docs
    +-- VIDEO_ENCODING_CONCEPTS.md     # VP8/WebM encoding
    +-- STREAMING_FLOW.md              # End-to-end flow
    +-- LATENCY_OPTIMIZATION.md        # Frame skipping, lag fixes
    +-- cast-mdns-architecture.md      # mDNS discovery
    +-- RUST_DESIGN.md                 # Rust XPCOM design
    +-- FINAL_QUALITY_FIX.md           # Quality improvements
```

## Development

### Building

```bash
./mach build
```

### Testing

```bash
./mach test browser/components/cast/
```

### Debugging

Enable Cast logging:
```bash
MOZ_LOG=cast:5 ./mach run
```

Or in the Browser Console:
```javascript
Services.prefs.setBoolPref("browser.cast.log", true);
```

### Quick XPCOM Test

```javascript
// Browser Console
const device = Cc["@mozilla.org/cast/device;1"].createInstance(Ci.nsICastDevice);
device.connect("192.168.1.100", 8009);
// Should see Rust logs in terminal
```

## Current Limitations

- **No audio**: Audio encoding not yet implemented
- **~1 second latency**: Inherent with HTTP streaming approach
- **Live stream only**: Cannot seek; Cast device treats it as a live broadcast
- **DefaultMediaReceiver only**: Custom receiver apps not supported

## Future Work

### P0: Required for Ship

| Item | Description |
|------|-------------|
| Testing infrastructure | Mochitest/xpcshell tests, mock Cast device for CI |
| Audio support | Add Opus encoding, mux audio+video in WebM |
| Permissions model | User consent UI, casting indicator |
| Adaptive bitrate | Adjust based on network conditions |

### P1: High Value

| Item | Description |
|------|-------------|
| Media element casting | Detect `<video>` elements and cast directly |
| Hardware encoding | Use VideoToolbox (macOS) / MediaFoundation (Windows) |
| Error recovery | Automatic reconnection on network interruption |

### P2: Nice to Have

| Item | Description |
|------|-------------|
| Cast Streaming Protocol | RTP/UDP for <500ms latency (requires Chrome Mirroring app) |
| VP9 codec | Better compression, but slower encoding |
| Multi-device | Cast to multiple devices simultaneously |

## Demo

### Running Cast

1. Build Firefox:
   ```bash
   ./mach build
   ```

2. Run with Cast logging enabled:
   ```bash
   MOZ_LOG=cast:5 ./mach run
   ```

3. Ensure a Cast device is on the same network

4. Open the Cast panel in Firefox (cast button in toolbar)

5. Select a device from the discovered list

6. The current tab will begin streaming to the Cast device

### What to Expect

- **3-5 second startup delay**: The Cast device buffers before playback begins
- **0.5-2 second latency**: Ongoing delay between browser and display
- **Good video quality**: VP8 at 4 Mbps provides clear playback
- **No audio**: Current implementation is video-only

### Generating Test Video

For testing the encoder without a Cast device:
```javascript
// Browser Console
const enc = Cc["@mozilla.org/cast/video-encoder;1"]
  .createInstance(Ci.nsICastVideoEncoder);
enc.init(1280, 720, 2000000, 30);
enc.dumpTestWebM(300); // Generates /tmp/test_output.webm (300 frames)
```

Play the output with any media player to verify encoding quality.

## Documentation

For detailed technical documentation:

- [ARCHITECTURE.md](ARCHITECTURE.md) - High-level architecture overview
- [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md) - Technical implementation details
- [notes/](notes/) - In-depth documentation on specific topics

## References

- [Chrome Cast SDK](https://developers.google.com/cast) - Official Cast documentation
- [pychromecast](https://github.com/home-assistant-libs/pychromecast) - Python Cast implementation (reference)
- [libvpx](https://chromium.googlesource.com/webm/libvpx/) - VP8/VP9 codec
