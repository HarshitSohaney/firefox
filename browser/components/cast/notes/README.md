# Firefox Cast Technical Documentation

Technical documentation for the Firefox Cast implementation.

## Quick Start

**New to media/Cast?** Start here:
1. [VIDEO_ENCODING_CONCEPTS.md](./VIDEO_ENCODING_CONCEPTS.md) - Learn video encoding fundamentals
2. [CAST_PROTOCOL.md](./CAST_PROTOCOL.md) - Understand the Cast protocol
3. [STREAMING_FLOW.md](./STREAMING_FLOW.md) - See how it all works together

**Working on performance?**
- [LATENCY_OPTIMIZATION.md](./LATENCY_OPTIMIZATION.md) - Frame skipping and lag mitigation

**Understanding discovery?**
- [cast-mdns-architecture.md](./cast-mdns-architecture.md) - mDNS device discovery

**Research on alternative approaches?**
- [WEBRTC_CAST_RESEARCH.md](./WEBRTC_CAST_RESEARCH.md) - Why Chrome uses WebRTC

---

## Architecture Overview

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

## Data Flow

```
Browser Tab
  ↓ drawSnapshot() (GPU)
ImageBitmap
  ↓ drawImage() → getImageData() (GPU → CPU)
RGBA Array
  ↓ Pass to Rust XPCOM
video_encoder.rs
  ↓ rgba_to_i420()
I420 Buffer
  ↓ vpx_codec_encode()
VP8 Bitstream
  ↓ WebM muxing
WebM Cluster
  ↓ HTTP chunked encoding
Cast Device
  ↓ VP8 decode + buffer
Display on TV
```

## Key Files

### JavaScript
| File | Purpose |
|------|---------|
| `CastService.sys.mjs` | Device management |
| `CastSession.sys.mjs` | Capture & encode loop |
| `CastDevice.sys.mjs` | XPCOM wrapper |
| `CastMediaHandler.sys.mjs` | Media control |
| `CastDiscovery.sys.mjs` | mDNS discovery |
| `SimpleHTTPServer.sys.mjs` | HTTP streaming |

### Rust
| File | Purpose |
|------|---------|
| `cast_device.rs` | Cast protocol (TLS, messages) |
| `video_encoder.rs` | VP8 encoding |
| `stream_listener.rs` | Async message receiver |

## Latency Mitigation

The DefaultMediaReceiver app takes 3-5 seconds to launch. To prevent lag buildup:

1. **Pause during BUFFERING** - Don't send frames while receiver is buffering
2. **Frame skipping** - Skip frames if >1 second ahead of receiver playback
3. **Clock sync** - Resync timestamps when playback starts

See [LATENCY_OPTIMIZATION.md](./LATENCY_OPTIMIZATION.md) for details.

## Debugging

```bash
# Enable logging
MOZ_LOG=cast:5 ./mach run

# Browser Console
Services.prefs.setBoolPref("browser.cast.log", true);
```

## Limitations

- **HTTP streaming** - DefaultMediaReceiver expects seekable content, causing buffering issues
- **~1 second latency** - Inherent with HTTP approach
- **No audio** - Not yet implemented

Chrome achieves lower latency by using WebRTC/RTP with the Chrome Mirroring app instead of HTTP.

## Documentation Index

| File | Content |
|------|---------|
| [VIDEO_ENCODING_CONCEPTS.md](./VIDEO_ENCODING_CONCEPTS.md) | VP8, WebM, color spaces |
| [CAST_PROTOCOL.md](./CAST_PROTOCOL.md) | Protocol messages, namespaces |
| [STREAMING_FLOW.md](./STREAMING_FLOW.md) | End-to-end code walkthrough |
| [LATENCY_OPTIMIZATION.md](./LATENCY_OPTIMIZATION.md) | Frame skipping, lag fixes |
| [cast-mdns-architecture.md](./cast-mdns-architecture.md) | mDNS discovery |
| [WEBRTC_CAST_RESEARCH.md](./WEBRTC_CAST_RESEARCH.md) | Chrome's WebRTC approach |
| [RUST_DESIGN.md](./RUST_DESIGN.md) | Rust XPCOM design |
| [XPCOM_RUST_GUIDE.md](./XPCOM_RUST_GUIDE.md) | How XPCOM + Rust integration works |
| [FINAL_QUALITY_FIX.md](./FINAL_QUALITY_FIX.md) | Canvas quality settings |
