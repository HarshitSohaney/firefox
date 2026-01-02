# Cast Architecture

## Overview

Firefox Cast implementation uses **Rust XPCOM components** for the protocol layer and video encoding, with JavaScript modules for UI integration, session management, and device discovery.

## Why XPCOM? (Not FFI)

We use **XPCOM** (Cross-Platform Component Object Model) instead of direct FFI:

### XPCOM Approach (What We Use)
- Firefox's official component system
- Automatic memory management
- Built-in callback support for async events
- Reference counting, QueryInterface, etc.
- Clean separation between JS and Rust

### FFI Approach (What We Rejected)
- FFI = Foreign Function Interface
- Direct C-style function calls from JS to Rust
- Manual memory management (unsafe, error-prone)
- No built-in callback support
- Would need wrapper objects anyway

**Decision:** XPCOM is the Firefox way. FFI would be reinventing the wheel.

## File Structure

```
browser/components/cast/
|
+-- Service Layer
|   +-- CastService.sys.mjs            # Singleton service managing devices and sessions
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
+-- XPCOM Interfaces
|   +-- nsICastDevice.idl              # Device protocol interface (JS <-> Rust)
|   +-- nsICastVideoEncoder.idl        # Video encoder interface (JS <-> Rust)
|   +-- components.conf                # Component registration
|   +-- cast_device.h                  # C++ header for device registration
|   +-- cast_video_encoder.h           # C++ header for encoder registration
|
+-- Rust Implementation (src/)
|   +-- lib.rs                         # Crate root, exports XPCOM constructors
|   +-- cast_device.rs                 # Device XPCOM component (TLS, protocol)
|   +-- stream_listener.rs             # Async message receiver
|   +-- message.rs                     # Protocol Buffer message structures
|   +-- messages.rs                    # Message handling utilities
|   +-- state.rs                       # DeviceState enum
|   +-- constants.rs                   # Protocol constants
|   +-- video_encoder.rs               # VP9 encoder XPCOM component
|   +-- vpx_ffi.rs                     # FFI bindings to libvpx
|   +-- webm_writer_ffi.rs             # FFI bindings for WebM muxing
|   +-- handlers/
|       +-- mod.rs                     # Handler module exports
|       +-- connection.rs              # CONNECT message helper
|       +-- heartbeat.rs               # PING/PONG helper
|       +-- receiver.rs                # GET_STATUS/LAUNCH helpers
|
+-- Build Configuration
    +-- Cargo.toml                     # Rust dependencies
    +-- moz.build                      # Firefox build integration
```

## Component Descriptions

### Service Layer

**CastService.sys.mjs**
Singleton service managing Cast device discovery, connections, and casting sessions. Coordinates between device management, mDNS discovery, and active casting operations.

### JavaScript Modules

**CastDevice.sys.mjs**
JavaScript wrapper around the Rust XPCOM device component. Provides Promise-based API over callback-based XPCOM, manages event listeners, handles heartbeat timer.

**CastSession.sys.mjs**
Manages tab casting to a Cast device. Handles screen capture, VP9 encoding via the Rust encoder, HTTP streaming through SimpleHTTPServer, and media session coordination.

**CastMediaSession.sys.mjs**
Manages casting of remote media URLs (not tab content). Simpler than CastSession as the Cast device fetches content directly from the URL.

**CastMediaHandler.sys.mjs**
Handles Cast Media namespace protocol commands. Manages media session lifecycle: load, play, pause, stop, seek.

**CastDiscovery.sys.mjs**
Discovers Cast devices on the local network using mDNS. Sends DNS-SD queries and parses responses for _googlecast._tcp.local services.

**SimpleHTTPServer.sys.mjs**
Minimal HTTP server for streaming video to Cast devices. Supports chunked transfer encoding and CORS headers.

**CastConstants.mjs**
Defines error codes (CAST_ERRORS), states (CAST_STATES), app IDs (CAST_APP_IDS), namespaces (CAST_NAMESPACES), and default configuration values.

**CastError.mjs**
Custom error type for Cast operations. Includes error cause code and supports serialization for IPC.

### Rust Components

**cast_device.rs**
Core Cast protocol implementation as XPCOM component. Handles TLS connection via nsISocketTransport, message encoding/decoding (Protocol Buffers), and JavaScript callbacks.

**video_encoder.rs**
XPCOM video encoder component using VP9 codec. Encodes RGBA frames to VP9 and wraps them in WebM container format.

**stream_listener.rs**
Async message receiver implementing nsIStreamListener. Parses message frames (4-byte length + protobuf), decodes messages, routes by namespace.

**message.rs**
Protocol Buffer message structures using prost crate.

**state.rs**
DeviceState enum (Disconnected, Connecting, Connected, Launching, Streaming, Error).

**vpx_ffi.rs / webm_writer_ffi.rs**
FFI bindings to libvpx for VP9 encoding and WebM container writing.

**handlers/**
Protocol helpers for connection, heartbeat, and receiver namespaces.

## Data Flow

### Device Discovery
```
CastService.init()
    |
CastDiscovery.start()
    |
Send mDNS query for _googlecast._tcp.local
    |
Parse DNS-SD responses
    |
CastService receives device info via callback
    |
Create CastDevice instances
```

### Tab Casting
```
User clicks Cast icon
    |
CastService.startCasting(device, tab)
    |
new CastSession(device, window)
    |
CastSession.start()
    |
    +-- CastDevice.connect() [XPCOM -> Rust TLS connection]
    +-- SimpleHTTPServer.start() [HTTP server for video]
    +-- CastMediaHandler.load(streamUrl) [Tell device to fetch stream]
    |
Tab capture starts (canvas screenshot loop)
    |
    +-- CastVideoEncoder.encodeFrame() [Rust VP9 encoding]
    +-- HTTP chunked response to Cast device
    |
Device plays video stream
```

### Remote Media Casting
```
CastService.castUrl(device, mediaUrl)
    |
new CastMediaSession(device)
    |
CastMediaSession.start(mediaUrl)
    |
CastDevice.connect() [if not connected]
    |
CastMediaHandler.load(mediaUrl)
    |
Device fetches and plays media directly
```

## Message Flow Example

### Sending CONNECT

**Rust (cast_device.rs):**
```rust
let connect_payload = ConnectionHandler::create_connect_message();
self.send_message_internal(ConnectionHandler::NAMESPACE, &connect_payload)?;
```

**Wire format:**
```
[4 bytes: message length (big-endian)]
[N bytes: protobuf message]

Protobuf:
- protocol_version: 0
- source_id: "sender-0"
- destination_id: "receiver-0"
- namespace: "urn:x-cast:com.google.cast.tp.connection"
- payload_type: 0 (STRING)
- payload_utf8: "{\"type\":\"CONNECT\"}"
```

### Receiving RECEIVER_STATUS

**Wire:** Device sends framed protobuf message

**Rust (stream_listener.rs):**
```rust
fn handle_received_data(&self, data: &[u8]) {
    // Parse 4-byte length
    let msg_length = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);

    // Decode protobuf
    let message = CastMessage::decode(msg_bytes)?;

    // Route by namespace
    self.handle_message(&message.namespace, payload);
}
```

## Why This Architecture?

### Advantages

1. **Type Safety:** Rust's type system prevents entire classes of bugs
2. **Memory Safety:** No use-after-free, no buffer overflows
3. **Performance:** Rust is as fast as C++, faster than JavaScript
4. **Firefox Integration:** XPCOM is the standard way
5. **Async I/O:** nsIStreamListener pattern handles async messages cleanly
6. **Clean Separation:** JavaScript for UI/orchestration, Rust for protocol/encoding

### Alternatives Considered

**Pure JavaScript + TCPSocket:**
- Manual protobuf encoding/decoding (error-prone)
- More complex state management
- Slower performance for video encoding
- Less type safety

**JavaScript + FFI to Rust:**
- Manual memory management
- Callback complexity
- Not the Firefox way

**XPCOM (chosen):**
- Best of both worlds
- Firefox standard
- Clean, maintainable

## Common Questions

### Q: Why not use C++ for the XPCOM components?

**A:** Rust provides:
- Memory safety without garbage collection
- Excellent protobuf support (prost crate)
- Modern error handling (Result types)
- Better developer experience
- Growing use in Firefox codebase

### Q: Why keep JavaScript at all?

**A:** JavaScript provides:
- Easy UI integration
- Promise-based async (better than callbacks)
- Event system for UI updates
- Service lifecycle management
- Easier testing and debugging

### Q: What's the performance overhead of XPCOM?

**A:** Negligible. XPCOM calls are essentially virtual function calls. The real work (TLS, protobuf, VP9 encoding) happens in Rust.

## Debugging Tips

### Enable Logging
```bash
MOZ_LOG=cast:5 ./mach run
```

### Check XPCOM Registration
```javascript
// In Browser Console
typeof Cc["@mozilla.org/cast/device;1"]
// Should return "object", not "undefined"
```

### Test Direct XPCOM Call
```javascript
const device = Cc["@mozilla.org/cast/device;1"].createInstance(Ci.nsICastDevice);
device.connect("10.0.0.171", 8009);
// Should see Rust logs in terminal
```

### Verify IDL Compiled
```bash
ls obj-*/dist/xpcrs/rt/nsICastDevice.rs
# Should exist after build
```
