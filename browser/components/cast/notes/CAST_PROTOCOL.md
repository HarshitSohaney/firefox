# Cast Protocol Documentation

Complete technical reference for the Google Cast protocol as implemented in Firefox Cast.

## Table of Contents

- [Protocol Overview](#protocol-overview)
- [Transport Layer](#transport-layer)
- [Message Structure](#message-structure)
- [Namespaces](#namespaces)
- [Connection Flow](#connection-flow)
- [Media Control](#media-control)
- [Heartbeat](#heartbeat)

---

## Protocol Overview

### What is the Cast Protocol?

The Cast protocol is Google's proprietary protocol for communicating with Cast-enabled devices (Chromecast, Google TV, Cast-enabled TVs, etc.).

**Key characteristics:**
- **Binary protocol** using Protocol Buffers
- **Namespace-based** messaging (like XMPP)
- **Bidirectional** communication
- **Transport:** TLS over TCP (port 8009)

### Protocol Stack

```
┌─────────────────────────────────────┐
│  Application Layer                  │
│  (JSON messages in namespaces)      │
├─────────────────────────────────────┤
│  Cast Protocol Layer                │
│  (Protocol Buffer framing)          │
├─────────────────────────────────────┤
│  TLS Layer                          │
│  (Encrypted TCP connection)         │
├─────────────────────────────────────┤
│  TCP Layer                          │
│  (Port 8009)                        │
└─────────────────────────────────────┘
```

---

## Transport Layer

### TCP Connection

**Endpoint:** `<cast-device-ip>:8009`

**Example:**
```
192.168.1.171:8009
```

**Protocol:** TLS 1.2+ with self-signed certificate

### Certificate Handling

Cast devices use **self-signed certificates**.

**File:** `browser/components/cast/modules/CastDevice.sys.mjs:106-136`

```javascript
async _addCastCertOverride() {
  const overrideService = Cc["@mozilla.org/security/certoverride;1"]
    .getService(Ci.nsICertOverrideService);

  // Fetch certificate
  const cert = await this._getCertForHost(this.address, this.port);

  // Verify it's self-signed
  const issuer = cert.issuerName;
  const subject = cert.subjectName;

  if (issuer !== subject) {
    throw new Error("Certificate is not self-signed");
  }

  // Add permanent override
  overrideService.rememberValidityOverride(
    this.address,
    this.port,
    {},
    cert,
    true
  );
}
```

**Why self-signed?**
- Cast devices generate their own certificates
- No Certificate Authority involved
- Must manually verify and trust

### Connection Establishment

**File:** `browser/components/cast/src/cast_device.rs:86-199`

```rust
// 1. Create TLS socket transport
let sts_service = SocketTransport::service::<nsISocketTransportService>()?;
let transport = sts_service.CreateTransport(
  &["ssl"],              // Use TLS
  address,               // e.g., "192.168.1.171"
  port,                  // 8009
  null(),
  null()
)?;

// 2. Open bidirectional streams
let output_stream = transport.OpenOutputStream(0, 0, 0)?;
let input_stream = transport.OpenInputStream(0, 0, 0)?;

// 3. Start async reading
let pump = create_instance::<nsIInputStreamPump>(...)?;
pump.AsyncRead(listener)?;
```

**Result:** Bidirectional TLS channel established.

---

## Message Structure

### Protocol Buffer Definition

**File:** `browser/components/cast/src/cast_channel.proto`

```protobuf
syntax = "proto2";

package cast.channel;

message CastMessage {
  enum ProtocolVersion {
    CASTV2_1_0 = 0;
  }

  // Always CASTV2_1_0
  required ProtocolVersion protocol_version = 1;

  // Source identifier (sender)
  // Usually "sender-0" for senders
  required string source_id = 2;

  // Destination identifier (receiver)
  // "receiver-0" for device receiver
  // App transport ID for apps
  required string destination_id = 3;

  // Message namespace
  // e.g., "urn:x-cast:com.google.cast.tp.connection"
  required string namespace = 4;

  enum PayloadType {
    STRING = 0;
    BINARY = 1;
  }

  // Always STRING in practice
  required PayloadType payload_type = 5;

  // JSON string payload
  optional string payload_utf8 = 6;

  // Binary payload (rarely used)
  optional bytes payload_binary = 7;
}
```

### Message Framing

**Wire format:**

```
[4 bytes: message length, big-endian]
[N bytes: Protocol Buffer CastMessage]
```

**Example:**

```
Hex dump:
00 00 00 47  ← Length: 71 bytes (0x47)
08 00 12 08  ← Start of protobuf message
73 65 6E 64  ← "send"
65 72 2D 30  ← "er-0"
...
```

**File:** `browser/components/cast/src/stream_listener.rs:71-82`

```rust
fn handle_received_data(&self, data: &[u8]) {
  if data.len() < 4 {
    return;  // Need at least length prefix
  }

  // Parse length (big-endian u32)
  let msg_length = u32::from_be_bytes([
    data[0], data[1], data[2], data[3]
  ]);

  if data.len() < (4 + msg_length as usize) {
    return;  // Incomplete message
  }

  let msg_bytes = &data[4..(4 + msg_length as usize)];

  // Decode Protocol Buffer
  match CastMessage::decode(msg_bytes) {
    Ok(message) => self.handle_message(&message.namespace, &message.payload_utf8),
    Err(e) => println!("Failed to decode message: {:?}", e),
  }
}
```

### Creating Messages

**File:** `browser/components/cast/src/message.rs`

```rust
pub struct CastMessage {
  pub protocol_version: i32,
  pub source_id: String,
  pub destination_id: String,
  pub namespace: String,
  pub payload_type: i32,
  pub payload_utf8: Option<String>,
  pub payload_binary: Option<Vec<u8>>,
}

impl CastMessage {
  pub fn new(
    source_id: String,
    destination_id: String,
    namespace: String,
    payload: String,
  ) -> Self {
    CastMessage {
      protocol_version: 0,  // CASTV2_1_0
      source_id,
      destination_id,
      namespace,
      payload_type: 0,  // STRING
      payload_utf8: Some(payload),
      payload_binary: None,
    }
  }

  pub fn encode_to_vec(&self) -> Result<Vec<u8>, EncodeError> {
    let mut buf = Vec::new();

    // Encode protobuf
    prost::Message::encode(self, &mut buf)?;

    // Add length prefix
    let len = buf.len() as u32;
    let len_bytes = len.to_be_bytes();

    let mut result = Vec::with_capacity(4 + buf.len());
    result.extend_from_slice(&len_bytes);
    result.extend_from_slice(&buf);

    Ok(result)
  }
}
```

**Example message creation:**

```rust
let message = CastMessage::new(
  "sender-0".to_string(),
  "receiver-0".to_string(),
  "urn:x-cast:com.google.cast.tp.connection".to_string(),
  r#"{"type":"CONNECT"}"#.to_string()
);

let bytes = message.encode_to_vec()?;
// bytes now contains: [length][protobuf CastMessage]
```

---

## Namespaces

### What are Namespaces?

Namespaces group related Cast protocol messages, similar to XML namespaces or XMPP namespaces.

**Format:** `urn:x-cast:<domain>`

### Standard Namespaces

#### Connection Namespace

**Namespace:** `urn:x-cast:com.google.cast.tp.connection`

**Purpose:** Establish/tear down virtual connections

**Messages:**

**CONNECT:**
```json
{
  "type": "CONNECT",
  "origin": {},
  "userAgent": "Firefox Cast",
  "connType": 0
}
```

**Sent:** On initial connection and when connecting to apps

**CLOSE:**
```json
{
  "type": "CLOSE"
}
```

**Sent:** When disconnecting

**File:** `browser/components/cast/src/handlers/connection.rs`

```rust
pub struct ConnectionHandler;

impl ConnectionHandler {
  pub const NAMESPACE: &'static str = "urn:x-cast:com.google.cast.tp.connection";

  pub fn create_connect_message() -> String {
    serde_json::json!({
      "type": "CONNECT",
      "origin": {},
      "userAgent": "Firefox Cast",
      "connType": 0
    }).to_string()
  }

  pub fn create_close_message() -> String {
    serde_json::json!({
      "type": "CLOSE"
    }).to_string()
  }
}
```

#### Heartbeat Namespace

**Namespace:** `urn:x-cast:com.google.cast.tp.heartbeat`

**Purpose:** Keep connection alive

**Messages:**

**PING:**
```json
{
  "type": "PING"
}
```

**Sent:** Every 5 seconds by sender

**PONG:**
```json
{
  "type": "PONG"
}
```

**Sent:** By receiver in response to PING

**File:** `browser/components/cast/src/handlers/heartbeat.rs`

```rust
pub struct HeartbeatHandler;

impl HeartbeatHandler {
  pub const NAMESPACE: &'static str = "urn:x-cast:com.google.cast.tp.heartbeat";

  pub fn create_ping() -> String {
    serde_json::json!({
      "type": "PING"
    }).to_string()
  }

  pub fn create_pong() -> String {
    serde_json::json!({
      "type": "PONG"
    }).to_string()
  }
}
```

**Implementation:**

**File:** `browser/components/cast/modules/CastDevice.sys.mjs:229-244`

```javascript
_startHeartbeat() {
  this._heartbeatTimer = setInterval(() => {
    try {
      this._xpcomDevice.sendMessage(
        "urn:x-cast:com.google.cast.tp.heartbeat",
        JSON.stringify({ type: "PING" })
      );
    } catch (error) {
      console.error("Cast heartbeat failed:", error);
    }
  }, 5000);  // Every 5 seconds
}
```

#### Receiver Namespace

**Namespace:** `urn:x-cast:com.google.cast.receiver`

**Purpose:** Control receiver apps (launch, stop, get status)

**Messages:**

**GET_STATUS:**
```json
{
  "type": "GET_STATUS",
  "requestId": 1
}
```

**Purpose:** Query current receiver state

**Response: RECEIVER_STATUS:**
```json
{
  "type": "RECEIVER_STATUS",
  "requestId": 1,
  "status": {
    "applications": [
      {
        "appId": "CC1AD845",
        "displayName": "Default Media Receiver",
        "namespaces": [
          {"name": "urn:x-cast:com.google.cast.media"},
          {"name": "urn:x-cast:com.google.cast.cac"}
        ],
        "sessionId": "abc123",
        "statusText": "Ready To Cast",
        "transportId": "web-1"
      }
    ],
    "volume": {
      "controlType": "attenuation",
      "level": 0.5,
      "muted": false,
      "stepInterval": 0.05
    }
  }
}
```

**LAUNCH:**
```json
{
  "type": "LAUNCH",
  "requestId": 2,
  "appId": "CC1AD845"
}
```

**Purpose:** Launch receiver app

**AppIDs:**
- `CC1AD845` - Default Media Receiver
- `E8C28D3C` - YouTube
- `233637DE` - Netflix
- Custom app IDs for custom receivers

**STOP:**
```json
{
  "type": "STOP",
  "requestId": 3,
  "sessionId": "abc123"
}
```

**Purpose:** Stop running app

**File:** `browser/components/cast/src/handlers/receiver.rs`

```rust
pub struct ReceiverHandler;

impl ReceiverHandler {
  pub const NAMESPACE: &'static str = "urn:x-cast:com.google.cast.receiver";

  pub fn create_get_status(request_id: i32) -> String {
    serde_json::json!({
      "type": "GET_STATUS",
      "requestId": request_id
    }).to_string()
  }

  pub fn create_launch(request_id: i32, app_id: &str) -> String {
    serde_json::json!({
      "type": "LAUNCH",
      "requestId": request_id,
      "appId": app_id
    }).to_string()
  }
}
```

#### Media Namespace

**Namespace:** `urn:x-cast:com.google.cast.media`

**Purpose:** Control media playback (load, play, pause, seek)

**Important:** Messages sent to app's `transportId`, not `receiver-0`

**Messages:**

**LOAD:**
```json
{
  "type": "LOAD",
  "requestId": 123,
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

**Purpose:** Load media URL

**streamType values:**
- `BUFFERED` - File with known duration
- `LIVE` - Live stream (our case)

**Response: MEDIA_STATUS:**
```json
{
  "type": "MEDIA_STATUS",
  "requestId": 123,
  "status": [
    {
      "mediaSessionId": 1,
      "playbackRate": 1,
      "playerState": "PLAYING",
      "currentTime": 5.2,
      "supportedMediaCommands": 15,
      "volume": {
        "level": 1,
        "muted": false
      },
      "media": {
        "contentId": "http://192.168.1.123:8010/stream.webm",
        "streamType": "LIVE",
        "contentType": "video/webm"
      }
    }
  ]
}
```

**playerState values:**
- `IDLE` - Not playing
- `BUFFERING` - Loading media
- `PLAYING` - Currently playing
- `PAUSED` - Paused

**PLAY:**
```json
{
  "type": "PLAY",
  "requestId": 124,
  "mediaSessionId": 1
}
```

**PAUSE:**
```json
{
  "type": "PAUSE",
  "requestId": 125,
  "mediaSessionId": 1
}
```

**SEEK:**
```json
{
  "type": "SEEK",
  "requestId": 126,
  "mediaSessionId": 1,
  "currentTime": 30.5
}
```

**STOP:**
```json
{
  "type": "STOP",
  "requestId": 127,
  "mediaSessionId": 1
}
```

**File:** `browser/components/cast/modules/CastMediaHandler.sys.mjs`

```javascript
export class CastMediaHandler {
  static NAMESPACE = "urn:x-cast:com.google.cast.media";

  async load(contentId, contentType, streamType, metadata) {
    const message = {
      type: "LOAD",
      requestId: this.nextRequestId++,
      media: {
        contentId,
        contentType,
        streamType,
        metadata
      },
      autoplay: true,
      currentTime: 0
    };

    // Send to app's transport ID, not receiver-0
    const transportId = this.device.getAppTransportId();
    this.device.sendMessageTo(
      transportId,
      CastMediaHandler.NAMESPACE,
      JSON.stringify(message)
    );

    return this.waitForResponse(message.requestId);
  }
}
```

---

## Connection Flow

### Full Connection Sequence

```
Firefox                          Cast Device
   │                                 │
   ├─────── TLS Handshake ──────────>│
   │<────── Certificate ─────────────┤
   │                                 │
   ├─ CONNECT (connection ns) ──────>│
   │  destination: "receiver-0"      │
   │                                 │
   ├─ GET_STATUS (receiver ns) ─────>│
   │  destination: "receiver-0"      │
   │                                 │
   │<───── RECEIVER_STATUS ──────────┤
   │  (no apps running)              │
   │                                 │
   ├─ LAUNCH (receiver ns) ──────────>│
   │  appId: "CC1AD845"              │
   │  destination: "receiver-0"      │
   │                                 │
   │<───── RECEIVER_STATUS ──────────┤
   │  apps: [{transportId: "web-1"}] │
   │                                 │
   ├─ CONNECT (connection ns) ──────>│
   │  destination: "web-1"           │
   │                                 │
   ├─ LOAD (media ns) ──────────────>│
   │  destination: "web-1"           │
   │  contentId: "http://..."        │
   │                                 │
   │<───── MEDIA_STATUS ─────────────┤
   │  playerState: "BUFFERING"       │
   │                                 │
   │                [Cast device makes HTTP request]
   │                                 │
   │<───── HTTP GET /stream.webm ────┤
   │                                 │
   ├─────── HTTP 200 + WebM ────────>│
   │                                 │
   │<───── MEDIA_STATUS ─────────────┤
   │  playerState: "PLAYING"         │
   │                                 │
   ├─ PING (heartbeat) ─────────────>│
   │<──── PONG ──────────────────────┤
   │                                 │
   │       (every 5 seconds)         │
```

### Detailed Flow Explanation

#### Step 1: Establish TLS Connection

**File:** `browser/components/cast/src/cast_device.rs:97-125`

```rust
let sts_service = SocketTransport::service::<nsISocketTransportService>()?;

let mut socket_types = ThinVec::new();
socket_types.push(nsCString::from("ssl"));

let transport = sts_service.CreateTransport(
  &socket_types,
  address,  // "192.168.1.171"
  port,     // 8009
  null(),
  null()
)?;
```

**Result:** Encrypted TCP connection established

#### Step 2: Send CONNECT to receiver-0

**File:** `browser/components/cast/src/cast_device.rs:143-144`

```rust
let connect_payload = ConnectionHandler::create_connect_message();
self.send_message_internal(ConnectionHandler::NAMESPACE, &connect_payload)?;
```

**Wire protocol:**
```
CastMessage {
  protocol_version: 0,
  source_id: "sender-0",
  destination_id: "receiver-0",
  namespace: "urn:x-cast:com.google.cast.tp.connection",
  payload_type: 0,
  payload_utf8: '{"type":"CONNECT","origin":{},"userAgent":"Firefox Cast","connType":0}'
}
```

**Purpose:** Virtual connection to device receiver

#### Step 3: Request Receiver Status

**File:** `browser/components/cast/src/cast_device.rs:146-150`

```rust
let get_status = serde_json::json!({
  "type": "GET_STATUS",
  "requestId": 1
}).to_string();
self.send_message_internal("urn:x-cast:com.google.cast.receiver", &get_status)?;
```

**Purpose:** Find out what apps are running

#### Step 4: Receive RECEIVER_STATUS

**File:** `browser/components/cast/src/stream_listener.rs:154-185`

```rust
if namespace == "urn:x-cast:com.google.cast.receiver" {
  let parsed: Value = serde_json::from_str(payload)?;

  if parsed["type"] == "RECEIVER_STATUS" {
    if let Some(apps) = parsed["status"]["applications"].as_array() {
      if apps.is_empty() {
        // No app running, need to launch
        self.launch_default_media_receiver()?;
      } else {
        // App already running
        if let Some(transport_id) = apps[0]["transportId"].as_str() {
          self.connect_to_app(transport_id)?;
        }
      }
    }
  }
}
```

#### Step 5: Launch App (if needed)

If no app running:

```rust
let launch = serde_json::json!({
  "type": "LAUNCH",
  "requestId": 2,
  "appId": "CC1AD845"  // Default Media Receiver
}).to_string();

self.send_message("urn:x-cast:com.google.cast.receiver", &launch);
```

Wait for RECEIVER_STATUS with app info.

#### Step 6: Connect to App

Once app is running:

```rust
let connect = serde_json::json!({
  "type": "CONNECT"
}).to_string();

self.send_message_to(
  transport_id,  // e.g., "web-1"
  "urn:x-cast:com.google.cast.tp.connection",
  &connect
);
```

**Purpose:** Virtual connection to the app (not just device)

#### Step 7: Load Media

**File:** `browser/components/cast/modules/CastMediaHandler.sys.mjs:30-69`

```javascript
async load(contentId, contentType, streamType, metadata) {
  const message = {
    type: "LOAD",
    requestId: this.nextRequestId++,
    media: {
      contentId: "http://192.168.1.123:8010/stream.webm",
      contentType: "video/webm",
      streamType: "LIVE",
      metadata: {
        metadataType: 0,
        title: "Firefox Tab Cast"
      }
    },
    autoplay: true,
    currentTime: 0
  };

  const transportId = this.device.getAppTransportId();
  this.device.sendMessageTo(
    transportId,
    "urn:x-cast:com.google.cast.media",
    JSON.stringify(message)
  );
}
```

**Purpose:** Tell Cast device to play this URL

#### Step 8: Cast Device Connects

Cast device makes HTTP request:

```http
GET /stream.webm HTTP/1.1
Host: 192.168.1.123:8010
```

This triggers our HTTP handler, which starts encoding!

---

## Media Control

### Media Session Lifecycle

```
IDLE
  ↓ LOAD command
BUFFERING
  ↓ Enough data buffered
PLAYING
  ↓ PAUSE command
PAUSED
  ↓ PLAY command
PLAYING
  ↓ STOP command or end of stream
IDLE
```

### Media Commands

**File:** `browser/components/cast/modules/CastMediaHandler.sys.mjs`

```javascript
async play() {
  const message = {
    type: "PLAY",
    requestId: this.nextRequestId++,
    mediaSessionId: this.mediaSessionId
  };

  this.sendToApp(CastMediaHandler.NAMESPACE, message);
}

async pause() {
  const message = {
    type: "PAUSE",
    requestId: this.nextRequestId++,
    mediaSessionId: this.mediaSessionId
  };

  this.sendToApp(CastMediaHandler.NAMESPACE, message);
}

async seek(currentTime) {
  const message = {
    type: "SEEK",
    requestId: this.nextRequestId++,
    mediaSessionId: this.mediaSessionId,
    currentTime
  };

  this.sendToApp(CastMediaHandler.NAMESPACE, message);
}

async stop() {
  const message = {
    type: "STOP",
    requestId: this.nextRequestId++,
    mediaSessionId: this.mediaSessionId
  };

  this.sendToApp(CastMediaHandler.NAMESPACE, message);
}
```

### Handling MEDIA_STATUS Updates

**File:** `browser/components/cast/modules/CastMediaHandler.sys.mjs:71-109`

```javascript
handleMediaStatus(payload) {
  const message = JSON.parse(payload);

  if (message.type !== "MEDIA_STATUS") {
    return null;
  }

  if (!message.status || message.status.length === 0) {
    return null;
  }

  const status = message.status[0];

  // Store media session ID
  if (status.mediaSessionId) {
    this.mediaSessionId = status.mediaSessionId;
  }

  // Handle state changes
  switch (status.playerState) {
    case "IDLE":
      if (status.idleReason === "ERROR") {
        console.error("Cast media error");
      }
      break;

    case "BUFFERING":
      console.log("Cast device buffering...");
      break;

    case "PLAYING":
      console.log("Cast device playing");
      break;

    case "PAUSED":
      console.log("Cast device paused");
      break;
  }

  return status;
}
```

---

## Heartbeat

### Purpose

Keep the TLS connection alive and detect disconnections.

### Implementation

**File:** `browser/components/cast/modules/CastDevice.sys.mjs:229-244`

```javascript
_startHeartbeat() {
  if (this._heartbeatTimer) {
    return;
  }

  this._heartbeatTimer = setInterval(() => {
    try {
      this._xpcomDevice.sendMessage(
        "urn:x-cast:com.google.cast.tp.heartbeat",
        JSON.stringify({ type: "PING" })
      );
    } catch (error) {
      console.error("Cast heartbeat failed:", error);
      // Connection likely dead, should reconnect
    }
  }, 5000);
}
```

### Handling PONG

**File:** `browser/components/cast/src/stream_listener.rs:121-151`

```rust
fn handle_message(&self, namespace: &str, payload: &str) {
  match namespace {
    "urn:x-cast:com.google.cast.tp.heartbeat" => {
      let parsed: Value = serde_json::from_str(payload)?;
      if parsed["type"] == "PONG" {
        // Heartbeat successful
        println!("CastStreamListener: <- [heartbeat] PONG");
      }
    }
    // ... other namespaces
  }
}
```

### Timeout Handling

If no PONG received within 10 seconds:
1. Log error
2. Close connection
3. Notify UI of disconnection
4. Clean up resources

**Implementation would be:**

```javascript
_startHeartbeat() {
  let lastPongTime = Date.now();

  // Send PING every 5 seconds
  this._heartbeatTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastPongTime > 10000) {
      console.error("No PONG received, connection dead");
      this.disconnect();
      return;
    }

    this._xpcomDevice.sendMessage(
      "urn:x-cast:com.google.cast.tp.heartbeat",
      JSON.stringify({ type: "PING" })
    );
  }, 5000);

  // Update on PONG
  this._xpcomDevice.addEventListener("message", ({ namespace, payload }) => {
    if (namespace === "urn:x-cast:com.google.cast.tp.heartbeat") {
      const msg = JSON.parse(payload);
      if (msg.type === "PONG") {
        lastPongTime = Date.now();
      }
    }
  });
}
```

---

## Protocol Debugging

### Enabling Logs

**Firefox:**
```bash
MOZ_LOG=cast:5 ./mach run
```

**Output:**
```
CastDevice: Connecting to 192.168.1.171:8009
CastDevice: -> [connection] CONNECT
CastDevice: -> [receiver] GET_STATUS
CastStreamListener: <- [receiver] RECEIVER_STATUS
CastStreamListener: <- [heartbeat] PONG
```

### Wireshark Capture

**Filter:** `tcp.port == 8009`

**Issue:** TLS encryption prevents seeing message contents

**Solution:** Man-in-the-middle with custom CA (complex, not recommended)

### Chrome Cast Logger

Use Chrome's built-in Cast logger:
1. Open Chrome
2. Navigate to `chrome://webrtc-internals`
3. View Cast protocol messages

---

## Related Documentation

- [STREAMING_FLOW.md](./STREAMING_FLOW.md) - Complete streaming flow
- [VIDEO_ENCODING_CONCEPTS.md](./VIDEO_ENCODING_CONCEPTS.md) - Video encoding
- [ARCHITECTURE_DEEP_DIVE.md](./ARCHITECTURE_DEEP_DIVE.md) - System architecture
