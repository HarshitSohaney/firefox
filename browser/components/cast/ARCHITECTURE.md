# Cast Architecture - Clean and Simple

## Overview

Firefox Cast implementation uses **Rust XPCOM components** for the protocol layer with JavaScript wrappers for UI integration.

## Why XPCOM? (Not FFI)

We use **XPCOM** (Cross-Platform Component Object Model) instead of direct FFI:

### XPCOM Approach ✅ (What We Use)
- Firefox's official component system
- Automatic memory management
- Built-in callback support for async events
- Reference counting, QueryInterface, etc.
- Clean separation between JS and Rust

### FFI Approach ❌ (What We Rejected)
- FFI = Foreign Function Interface
- Direct C-style function calls from JS to Rust
- Manual memory management (unsafe, error-prone)
- No built-in callback support
- Would need wrapper objects anyway

**Decision:** XPCOM is the Firefox way. FFI would be reinventing the wheel.

## File Structure (Clean)

```
browser/components/cast/
│
├── JavaScript Layer
│   ├── CastDevice.sys.mjs              ← Wrapper around Rust XPCOM
│   └── CastServiceWrapper.sys.mjs      ← High-level service
│
├── XPCOM Interface
│   ├── nsICastDevice.idl               ← Interface definition (JS ↔ Rust)
│   ├── components.conf                 ← Component registration
│   └── cast_device.h                   ← C++ header for registration
│
├── Rust Implementation (src/)
│   ├── lib.rs                          ← Crate root, exports NS_NewCastDevice
│   ├── cast_device.rs                  ← XPCOM component (TLS, connection)
│   ├── stream_listener.rs              ← Async message receiver
│   ├── message.rs                      ← Protocol Buffer messages
│   └── handlers/                       ← Protocol helpers
│       ├── mod.rs
│       ├── connection.rs               ← CONNECT message helper
│       ├── heartbeat.rs                ← PING/PONG helper
│       └── receiver.rs                 ← GET_STATUS/LAUNCH helpers
│
└── Build Configuration
    ├── Cargo.toml                      ← Rust dependencies
    └── moz.build                       ← Firefox build integration
```

## How It Works

### 1. Component Creation

**JavaScript (CastDevice.sys.mjs:20-22):**
```javascript
this._xpcomDevice = Cc["@mozilla.org/cast/device;1"].createInstance(
  Ci.nsICastDevice
);
```

**Rust (lib.rs:11-29):**
```rust
#[no_mangle]
pub unsafe extern "C" fn NS_NewCastDevice(
    iid: &xpcom::nsIID,
    result: *mut *mut libc::c_void,
) -> nserror::nsresult {
    let device = cast_device::CastDevice::new();
    device.QueryInterface(iid, result)
}
```

### 2. Method Calls

**JavaScript calls:**
```javascript
await this._xpcomDevice.connect(address, port);
```

**Rust receives:**
```rust
xpcom_method!(connect => Connect(address: *const nsACString, port: i32));
fn connect(&self, address: &nsACString, port: i32) -> Result<(), nsresult> {
    // Implementation
}
```

### 3. Callbacks (Async Events)

**JavaScript sets callback:**
```javascript
this._xpcomDevice.callback = {
  onStateChanged(state) { /* handle state */ },
  onMessage(namespace, payload) { /* handle message */ },
  onError(error) { /* handle error */ }
};
```

**Rust calls back:**
```rust
fn notify_state_change(&self, state: &str) {
    if let Some(callback) = self.callback.borrow().as_ref() {
        unsafe {
            callback.OnStateChanged(&nsCString::from(state) as &nsACString);
        }
    }
}
```

## Data Flow

```
User clicks Cast icon
    ↓
CastServiceWrapper.addManualDevice(ip)
    ↓
new CastDevice(id, ip) [JavaScript]
    ↓
Creates Cc["@mozilla.org/cast/device;1"] [XPCOM]
    ↓
Calls NS_NewCastDevice() [Rust]
    ↓
Creates CastDevice::new() [Rust struct]
    ↓
device.connect() [JavaScript calls XPCOM]
    ↓
Connect() method [Rust implementation]
    ↓
- Create TLS transport (nsISocketTransport)
    - Open output stream
    - Send CONNECT message
    - Open input stream
    - Create stream listener (CastStreamListener)
    - Start async reading (nsIInputStreamPump)
    ↓
Callback: onStateChanged("connected") [Rust → JS]
    ↓
Promise resolves [JavaScript]
    ↓
UI updates, alert shown
```

## Key Components

### CastDevice.sys.mjs (JavaScript Wrapper)
**Purpose:** Provide Promise-based API over callback-based XPCOM

**Responsibilities:**
- Create XPCOM component instance
- Set up callback handlers
- Convert callbacks to Promises
- Manage event listeners
- Handle heartbeat timer

**Why needed:** XPCOM is callback-based, modern JS is Promise-based. This wrapper bridges the gap.

### cast_device.rs (Rust XPCOM Component)
**Purpose:** Core Cast protocol implementation

**Responsibilities:**
- TLS connection via nsISocketTransport
- Message encoding/decoding (Protocol Buffers)
- Send messages to Cast device
- Manage connection state
- Call JavaScript callbacks

**Why Rust:** Type safety, memory safety, excellent protobuf support (prost crate).

### stream_listener.rs (Async Message Receiver)
**Purpose:** Handle incoming messages from Cast device

**Responsibilities:**
- Implement nsIStreamListener pattern
- Parse message frames (4-byte length + protobuf)
- Decode Protocol Buffer messages
- Route messages by namespace
- Handle protocol logic (PING→PONG, app connection, etc.)

**Why separate:** Async I/O requires callback pattern (OnDataAvailable). Clean separation of concerns.

### message.rs (Protocol Buffers)
**Purpose:** Define Cast protocol message structure

**Uses:** `prost` crate for compile-time protobuf

```rust
#[derive(Clone, PartialEq, Message)]
pub struct CastMessage {
    #[prost(enumeration = "i32", required, tag = "1")]
    pub protocol_version: i32,
    #[prost(string, required, tag = "2")]
    pub source_id: String,
    // ... etc
}
```

## Message Flow Example

### Sending CONNECT

**JavaScript:**
```javascript
// User code doesn't directly send CONNECT, happens during connect()
await device.connect();
```

**Rust (cast_device.rs:95-97):**
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

**Rust (stream_listener.rs:69-87):**
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

**Rust (stream_listener.rs:121-185):**
```rust
if namespace == "urn:x-cast:com.google.cast.receiver" {
    if parsed["type"] == "RECEIVER_STATUS" {
        // Check if app running
        // If not: LAUNCH DefaultMediaReceiver
        // If yes: CONNECT to app's transportId
    }
}
```

## Why This Architecture?

### Advantages

1. **Type Safety:** Rust's type system prevents entire classes of bugs
2. **Memory Safety:** No use-after-free, no buffer overflows
3. **Performance:** Rust is as fast as C++, faster than JavaScript
4. **Firefox Integration:** XPCOM is the standard way
5. **Async I/O:** nsIStreamListener pattern handles async messages cleanly
6. **Clean Separation:** JavaScript for UI, Rust for protocol

### Alternatives Considered

**Pure JavaScript + TCPSocket:**
- ❌ Manual protobuf encoding/decoding (error-prone)
- ❌ More complex state management
- ❌ Slower performance
- ❌ Less type safety

**JavaScript + FFI to Rust:**
- ❌ Manual memory management
- ❌ Callback complexity
- ❌ Not the Firefox way

**Pure Rust + JSM:**
- ❌ Would need JavaScript wrapper anyway for UI
- ❌ More boilerplate

**XPCOM (chosen):**
- ✅ Best of both worlds
- ✅ Firefox standard
- ✅ Clean, maintainable

## Common Questions

### Q: Why not use C++ for the XPCOM component?

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

**A:** Negligible. XPCOM calls are essentially virtual function calls. The real work (TLS, protobuf) happens in Rust.

### Q: Can we call Rust directly from browser-cast.js?

**A:** No. browser-cast.js has no access to XPCOM. It must go through the ESM module system (CastServiceWrapper → CastDevice → XPCOM).

## Debugging Tips

### Enable Rust Logging
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

## Phase 2 Additions (Upcoming)

For tab casting, we'll add:
- **CastMediaHandler.sys.mjs** - Media namespace protocol
- **CastTabCapture.sys.mjs** - Tab screenshot capture
- **CastMediaServer.sys.mjs** - HTTP MJPEG server
- **src/handlers/media.rs** - Media protocol messages

The architecture will remain the same: Rust for protocol, JavaScript for higher-level orchestration.
