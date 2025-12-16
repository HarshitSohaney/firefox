# Cast Implementation - Technical Overview

This document explains the core technical concepts behind the Firefox Cast implementation.

## Table of Contents

1. [FFI (Foreign Function Interface)](#1-ffi-foreign-function-interface)
2. [Cast Protocol (CASTV2)](#2-cast-protocol-castv2)
3. [Protocol Buffers (Protobuf)](#3-protocol-buffers-protobuf)
4. [Current Architecture](#4-current-architecture)

---

## 1. FFI (Foreign Function Interface)

**FFI** is a mechanism that allows code written in one programming language to call functions written in another language.

In the Cast implementation:
- **JavaScript** (browser UI) needs to call **Rust** (protocol logic)
- Rust compiles to native machine code
- JavaScript runs in SpiderMonkey VM

### How it works in Firefox:

**Rust side: Export a C-compatible function**
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

**JavaScript side: Call Rust via ctypes**
```javascript
const lib = ctypes.open("XUL");
const NS_NewCastDevice = lib.declare(
  "NS_NewCastDevice",
  ctypes.default_abi,
  ctypes.uint32_t,      // return type
  ctypes.voidptr_t,     // parameter 1
  ctypes.voidptr_t.ptr  // parameter 2
);
```

### Why use FFI here?

- **Performance**: Protobuf encoding/decoding is faster in native code
- **Type safety**: Rust's type system catches protocol errors at compile time
- **Memory efficiency**: No garbage collection overhead

---

## 2. Cast Protocol (CASTV2)

The **Cast protocol** is Google's proprietary protocol for communicating with Chromecast devices.

### Connection Flow

```
Firefox                                 Chromecast Device
   |                                           |
   |------ TLS handshake on port 8009 ------→ |
   |                                           |
   |------ CONNECT message -----------------→ |
   |       namespace: urn:x-cast:com.google.cast.tp.connection
   |                                           |
   |←----- (no response) ---------------------|
   |                                           |
   |------ PING -----------------------------→ |
   |       namespace: urn:x-cast:com.google.cast.tp.heartbeat
   |                                           |
   |←----- PONG -----------------------------|
   |                                           |
   |------ GET_STATUS ----------------------→ |
   |       namespace: urn:x-cast:com.google.cast.receiver
   |                                           |
   |←----- RECEIVER_STATUS -------------------|
   |       (device name, apps, volume, etc.)  |
   |                                           |
   |------ LAUNCH app ----------------------→ |
   |       appId: "CC1AD845" (DefaultMediaReceiver)
   |                                           |
   |←----- RECEIVER_STATUS -------------------|
   |       (app is now running)               |
```

### Protocol Namespaces

#### 1. Connection (`urn:x-cast:com.google.cast.tp.connection`)
- **CONNECT**: Establish connection
- **CLOSE**: Close connection

#### 2. Heartbeat (`urn:x-cast:com.google.cast.tp.heartbeat`)
- **PING**: Keep connection alive (every 5 seconds)
- **PONG**: Response to PING

#### 3. Receiver (`urn:x-cast:com.google.cast.receiver`)
- **GET_STATUS**: Query device status
- **LAUNCH**: Start an app
- **STOP**: Stop an app

#### 4. Media (`urn:x-cast:com.google.cast.media`) - Phase 2
- **LOAD**: Load media
- **PLAY/PAUSE**: Control playback

---

## 3. Protocol Buffers (Protobuf)

**Protobuf** is a language-neutral, platform-neutral data serialization format developed by Google.

### Why Protobuf vs JSON?

**JSON:**
```json
{
  "protocol_version": "CASTV2",
  "source_id": "sender-0",
  "destination_id": "receiver-0",
  "namespace": "urn:x-cast:com.google.cast.tp.connection",
  "payload_type": "STRING",
  "payload_utf8": "{\"type\":\"CONNECT\"}"
}
```
- Size: ~200 bytes
- Human-readable
- No schema enforcement

**Protobuf (binary):**
```
0a 06 43 41 53 54 56 32 12 08 73 65 6e 64 65 72...
```
- Size: ~50 bytes (75% smaller)
- Schema-enforced at compile time
- Type-safe

### Cast Protobuf Definition

The Cast protocol defines:

```protobuf
message CastMessage {
  required string protocol_version = 1;  // Always "CASTV2"
  required string source_id = 2;         // "sender-0"
  required string destination_id = 3;    // "receiver-0"
  required string namespace = 4;         // Protocol namespace
  required PayloadType payload_type = 5; // STRING or BINARY
  optional string payload_utf8 = 6;      // JSON payload
  optional bytes payload_binary = 7;     // Binary payload
}
```

### Message Framing

Cast uses length-prefixed framing:
```
[4 bytes: message length (big-endian)] [N bytes: protobuf payload]
```

Example:
```
00 00 00 2A  ← Length: 42 bytes
0a 06 43 41 53 54 56 32 12 08...  ← Protobuf message (42 bytes)
```

---

## 4. Current Architecture

### Phase 1 (COMPLETE): XPCOM Infrastructure

#### nsICastDevice.idl
Defines contract between JavaScript and Rust:
```idl
interface nsICastDevice : nsISupports {
  void connect(in AUTF8String address, in long port);
  void sendMessage(in AUTF8String namespace, in AUTF8String payload);
  // ...
};
```
- Compiled to `cast.xpt` type library

#### src/cast_device.rs
Implements the IDL interface in Rust:
```rust
#[xpcom::xpcom(implement(nsICastDevice), atomic)]
pub struct CastDevice {
    state: nsCString,
    callback: Option<RefPtr<nsICastDeviceCallback>>,
}
```
- Currently just stub methods (println statements)

#### src/lib.rs
Exports constructor function:
```rust
#[no_mangle]
pub unsafe extern "C" fn NS_NewCastDevice(...) -> nsresult {
    let device = cast_device::CastDevice::new();
    device.QueryInterface(iid, result)
}
```
- JavaScript can call this via ctypes or XPCOM

### Data Flow (When Implemented)

```
┌─────────────────────────────────────────────────┐
│ JavaScript Layer (UI)                           │
│ - CastServiceWrapper.sys.mjs                    │
│ - CastDevice.sys.mjs                            │
└────────────────┬────────────────────────────────┘
                 │ XPCOM Interface (IDL)
                 │ nsICastDevice::connect()
                 │ nsICastDevice::sendMessage()
                 ↓
┌─────────────────────────────────────────────────┐
│ Rust XPCOM Component (cast_device.rs)          │
│ - State management                              │
│ - Connection lifecycle                          │
└────────────────┬────────────────────────────────┘
                 │ Rust internal calls
                 ↓
┌─────────────────────────────────────────────────┐
│ Protocol Layer (Rust)                           │
│ - handlers/connection.rs                        │
│ - handlers/heartbeat.rs                         │
│ - handlers/receiver.rs                          │
└────────────────┬────────────────────────────────┘
                 │ Create CastMessage structs
                 ↓
┌─────────────────────────────────────────────────┐
│ Message Encoding (message.rs + prost)           │
│ - Serialize to protobuf bytes                   │
└────────────────┬────────────────────────────────┘
                 │ Raw bytes
                 ↓
┌─────────────────────────────────────────────────┐
│ Transport Layer (nsISocketTransport)            │
│ - TLS connection on port 8009                   │
│ - Frame: [4 bytes length][protobuf]             │
└────────────────┬────────────────────────────────┘
                 │ Network
                 ↓
            Chromecast Device
```

### Example: Sending CONNECT Message

**JavaScript calls:**
```javascript
let device = castService.getDeviceDiscovery().addManualDevice("10.0.0.128");
await device.connect();
```

**Rust receives (when implemented):**
```rust
fn connect(&self, address: &nsACString, port: i32) -> Result<(), nsresult> {
    // 1. Get socket transport service
    let service = SocketTransportService::service()?;

    // 2. Create TLS transport
    let transport = service.CreateTransport(
        &["ssl"], address, port, None, None
    )?;

    // 3. Create CONNECT message
    let connect_msg = ConnectionHandler::create_connect_message(
        "sender-0", "receiver-0"
    );

    // 4. Encode to protobuf
    let cast_msg = CastMessage {
        protocol_version: "CASTV2".to_string(),
        source_id: "sender-0".to_string(),
        destination_id: "receiver-0".to_string(),
        namespace: ConnectionHandler::NAMESPACE.to_string(),
        payload_type: PayloadType::String as i32,
        payload_utf8: Some(serde_json::to_string(&connect_msg)?),
        ..Default::default()
    };
    let bytes = cast_msg.encode_to_vec();

    // 5. Frame and send
    let length = (bytes.len() as u32).to_be_bytes();
    output_stream.write(&length)?;
    output_stream.write(&bytes)?;

    Ok(())
}
```

**On the wire:**
```
00 00 00 3F  ← 63 bytes
0a 06 43 41 53 54 56 32  ← "CASTV2"
12 08 73 65 6e 64 65 72 2d 30  ← "sender-0"
1a 0a 72 65 63 65 69 76 65 72 2d 30  ← "receiver-0"
22 2d 75 72 6e 3a 78 2d 63 61 73 74 3a...  ← namespace
28 00  ← payload_type: STRING
32 12 7b 22 74 79 70 65 22 3a 22 43...  ← "{\"type\":\"CONNECT\"}"
```

---

## Summary

| Component | Purpose |
|-----------|---------|
| **FFI** | Allows JavaScript to call Rust functions for performance-critical protocol logic |
| **Cast Protocol** | Multi-namespace protocol with connection handshake, heartbeat, and control messages |
| **Protobuf** | Efficient binary serialization with compile-time type safety (75% smaller than JSON) |

### Current Status

- ✅ XPCOM interface defined (nsICastDevice.idl)
- ✅ Rust component skeleton (cast_device.rs)
- ✅ Build integration complete
- ⏳ Next: Implement socket connection + protobuf encoding

---

## Related Documentation

- [RUST_DESIGN.md](./RUST_DESIGN.md) - Implementation plan and phases
- [SESSION_SUMMARY.md](./SESSION_SUMMARY.md) - Development session notes
- [nsICastDevice.idl](./nsICastDevice.idl) - XPCOM interface definition
