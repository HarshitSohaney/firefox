# Cast Rust Implementation Design

## Architecture Overview

Moving Cast protocol implementation from JavaScript to Rust using Firefox's XPCOM and nsISocketTransport.

### Component Structure

```
JavaScript (UI Layer)
    ↓
nsICastDevice (XPCOM Interface)
    ↓
CastDevice (Rust Implementation)
    ↓
nsISocketTransport (Firefox Networking)
```

### Why This Approach?

1. **Type Safety**: Prost gives compile-time protobuf guarantees
2. **Performance**: Native encoding/decoding
3. **Firefox Integration**: Uses proven necko networking stack
4. **Proper Threading**: Works with Firefox's socket thread model
5. **TLS Support**: Built-in certificate handling via nsITLSSocketControl

## Implementation Plan

### Phase 1: Basic XPCOM Component ✅ **COMPLETE**
- [x] Create `nsICastDevice.idl` interface
- [x] Implement basic Rust XPCOM component
- [x] Export NS_NewCastDevice function
- [x] Build and verify IDL generation ✅ **BUILD SUCCESSFUL**
- [x] Add xpcom, nsstring, nserror dependencies
- [ ] Test component instantiation from JavaScript (direct call)
- [ ] Verify XPCOM refcounting works

**Status**: Rust XPCOM component compiles successfully into gkrust!
- IDL generated: `config/makefiles/xpidl/cast.xpt`
- Rust exports: `NS_NewCastDevice()` function available
- Ready for Phase 2: Socket connection

**Component Registration Note**: components.conf doesn't work with Rust-in-gkrust components.
The build system auto-detects them as "external" and rejects constructors.
**Current approach**: Export `NS_NewCastDevice()` function, callable via ctypes or C++ wrapper.

### Phase 2: Socket Connection
- [ ] Get `nsISocketTransportService` from XPCOM
- [ ] Create TLS transport to Cast device
- [ ] Open input/output streams
- [ ] Test basic connection (no data yet)

### Phase 3: Protobuf Integration
- [ ] Send encoded CONNECT message
- [ ] Receive and decode response
- [ ] Test message round-trip

### Phase 4: Protocol State Machine
- [ ] Implement connection handshake
- [ ] Add heartbeat (PING/PONG)
- [ ] Handle GET_STATUS
- [ ] Test full connection flow

### Phase 5: JavaScript Integration
- [ ] Replace CastDevice.sys.mjs with XPCOM calls
- [ ] Test from browser UI
- [ ] Add event callbacks for state changes

### Phase 6: Advanced Features
- [ ] App launching (DefaultMediaReceiver)
- [ ] Media namespace support
- [ ] Error handling and reconnection

## Key Interfaces

### nsICastDevice.idl
```idl
interface nsICastDevice : nsISupports {
  void connect(in AUTF8String address, in long port);
  void disconnect();
  void sendMessage(in AUTF8String namespace, in AUTF8String payload);

  attribute nsICastDeviceCallback callback;
  readonly attribute AUTF8String state;
};

interface nsICastDeviceCallback : nsISupports {
  void onStateChanged(in AUTF8String state);
  void onMessage(in AUTF8String namespace, in AUTF8String payload);
  void onError(in AUTF8String error);
};
```

### Rust Implementation Structure
```
browser/components/cast/src/
├── lib.rs                    # XPCOM exports
├── constants.rs              # Centralized constants (namespaces, IDs, ports)
├── state.rs                  # DeviceState enum
├── messages.rs               # Typed message structs with serde
├── cast_device.rs            # Main CastDevice component
├── stream_listener.rs        # Async message receiver
├── message.rs                # Protobuf encoding/decoding
├── video_encoder.rs          # VP8 encoding
├── handlers/
│   ├── mod.rs
│   ├── connection.rs         # CONNECT/CLOSE messages
│   ├── heartbeat.rs          # PING/PONG handling
│   └── receiver.rs           # GET_STATUS, LAUNCH
└── vpx_ffi.rs                # libvpx FFI bindings
```

## Testing Strategy

Each phase has specific tests:

1. **Component Creation**: Instantiate from JS, check it exists
2. **Connection**: Connect to real device, verify STATUS_CONNECTED
3. **Protobuf**: Send CONNECT, verify device doesn't reject
4. **State Machine**: Full handshake, verify ready state
5. **JavaScript**: Test from browser UI with real Cast device

## Current Status

**Rust XPCOM Implementation**:
- ✅ XPCOM component registration (Phase 1 complete)
- ✅ TLS connection via nsISocketTransport (Phase 2 complete)
- ✅ Protobuf encoding/decoding (Phase 3 complete)
- ✅ Connection state machine (Phase 4 complete)
- ✅ JavaScript integration (Phase 5 complete)
- ✅ App launching and media control (Phase 6 complete)
- ✅ **Code quality refactoring (December 2024)**
  - Type-safe state enum
  - Typed message structs with serde
  - Centralized constants
  - Handler delegation pattern

**Recent Improvements**: See [CODE_QUALITY_REFACTOR.md](./CODE_QUALITY_REFACTOR.md) for details on:
- Code organization improvements
- Type safety enhancements
- Memory management patterns

## References

- nsISocketTransport: `/netwerk/base/nsISocketTransport.idl`
- nsISocketTransportService: `/netwerk/base/nsISocketTransportService.idl`
- XPCOM Rust: `/xpcom/rust/xpcom/src/`
- Cast Protocol: Working JS implementation in `CastDevice.sys.mjs`

## Known Issues to Handle

1. **Certificate Validation**: Cast devices use self-signed certs
   - Need to implement `nsIBadCertListener2` in Rust
   - Override certificate validation for Cast connections

2. **Threading**: nsISocketTransport runs on socket thread
   - Need proper thread dispatch for callbacks to main thread
   - Use `NS_DispatchToMainThread`

3. **Async Operations**: Rust component must handle async I/O
   - Input/output streams are non-blocking
   - Need to implement `nsIInputStreamCallback` / `nsIOutputStreamCallback`

4. **Memory Management**: XPCOM refcounting
   - Use `RefPtr<T>` correctly
   - Ensure no leaks with `xpcom::RefCounted` trait

## Success Criteria

- Cast connection works from Rust (verified with real device)
- JavaScript can control Cast through XPCOM interface
- Performance is equal or better than JS implementation
- Code is maintainable and type-safe
