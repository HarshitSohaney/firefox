# WebRTC Cast Protocol Research

## Executive Summary

HTTP-based tab casting (both LIVE and BUFFERED) failed because DefaultMediaReceiver expects seekable content with byte-range support. Chrome uses a completely different architecture: the **Chrome Mirroring** app with **Cast WebRTC protocol** that streams encrypted RTP packets directly over UDP.

## Why HTTP Failed

### What We Tried
- HTTP server with chunked transfer encoding
- VP8 encoder producing valid WebM
- DefaultMediaReceiver app (CC1AD845)
- Both LIVE and BUFFERED streamTypes

### Why It Failed
DefaultMediaReceiver expects:
- 206 Partial Content responses with Content-Range headers
- Seekable content (Range: bytes=X-Y support)
- Static files or HLS/DASH adaptive protocols
- **NOT** infinite chunked streams

**Result**: Cast device stuck in LOADING state forever, never transitions to PLAYING.

## Chrome's Architecture

### Different Cast Application
- **App ID**: `0F5096E8` (Chrome Mirroring)
- **NOT** DefaultMediaReceiver (CC1AD845)
- Specifically designed for real-time mirroring

### Protocol Namespaces
```
urn:x-cast:com.google.cast.webrtc    - OFFER/ANSWER negotiation
urn:x-cast:com.google.cast.media     - Media control (PLAY/PAUSE)
```

### Message Flow

```
Firefox                                    Cast Device
   |                                            |
   |-- LAUNCH (0F5096E8) ---------------------->|
   |<-- RECEIVER_STATUS (transportId) ----------|
   |                                            |
   |-- CONNECT (webrtc namespace) ------------->|
   |<-- CONNECTED ----------------------------- |
   |                                            |
   |-- OFFER (supportedStreams) --------------->|
   |    {                                       |
   |      opus audio: 48kHz, 2ch               |
   |      vp8 video: 1920x1080, 30fps          |
   |      AES keys for encryption              |
   |      SSRC identifiers                     |
   |    }                                       |
   |                                            |
   |<-- ANSWER (selected streams) --------------|
   |    {                                       |
   |      udpPort: 1234                        |
   |      sendIndexes: [0, 1]                  |
   |      ssrcs: [...]                         |
   |      display: 1920x1080@60fps             |
   |    }                                       |
   |                                            |
   |== UDP/RTP STREAMING ======================>|
   |   (encrypted VP8 + Opus)                  |
   |                                            |
   |<== RTCP FEEDBACK ========================= |
   |   (receiver reports, packet loss)         |
```

## OFFER Message Structure

Complete example from Chromium source:

```json
{
  "type": "OFFER",
  "seqNum": 123,
  "offer": {
    "castMode": "mirroring",
    "supportedStreams": [
      {
        "index": 0,
        "type": "audio_source",
        "codecName": "opus",
        "sampleRate": 48000,
        "channels": 2,
        "bitRate": 102000,
        "rtpPayloadType": 127,
        "rtpProfile": "cast",
        "ssrc": 264890,
        "targetDelay": 400,
        "timeBase": "1/48000",
        "aesKey": "65386FD9BCC30BC7FB6A4DD1D3B0FA5E",
        "aesIvMask": "64A6AAC2821880145271BB15B0188821",
        "rtpExtensions": ["adaptive_playout_delay"],
        "receiverRtcpEventLog": true
      },
      {
        "index": 1,
        "type": "video_source",
        "codecName": "vp8",
        "maxBitRate": 5000000,
        "maxFrameRate": "30000/1000",
        "renderMode": "video",
        "resolutions": [
          {"width": 1920, "height": 1080}
        ],
        "rtpPayloadType": 96,
        "rtpProfile": "cast",
        "ssrc": 748229,
        "targetDelay": 400,
        "timeBase": "1/90000",
        "aesKey": "65386FD9BCC30BC7FB6A4DD1D3B0FA5E",
        "aesIvMask": "64A6AAC2821880145271BB15B0188821",
        "rtpExtensions": ["adaptive_playout_delay"],
        "receiverRtcpEventLog": true
      }
    ]
  }
}
```

### Key OFFER Fields

**castMode**: `"mirroring"` - indicates screen mirroring

**Audio Stream** (index 0):
- `codecName`: "opus" (required codec)
- `sampleRate`: 48000 Hz (standard)
- `channels`: 2 (stereo)
- `bitRate`: 102000 bps (~100kbps)
- `ssrc`: Synchronization Source identifier (random 32-bit)
- `rtpPayloadType`: 127 (dynamic RTP payload type)
- `targetDelay`: 400ms (playback buffer)
- `aesKey`: 32 hex chars (16 bytes) - AES-128 key
- `aesIvMask`: 32 hex chars (16 bytes) - IV mask for CTR mode

**Video Stream** (index 1):
- `codecName`: "vp8" (we already have this!)
- `maxBitRate`: 5000000 (5 Mbps)
- `maxFrameRate`: "30000/1000" (30 fps as fraction)
- `resolutions`: Array of supported resolutions
- `ssrc`: Different SSRC from audio
- `rtpPayloadType`: 96 (standard for VP8)
- `timeBase`: "1/90000" (90kHz RTP clock for video)
- Same encryption keys as audio

## ANSWER Message Structure

```json
{
  "type": "ANSWER",
  "seqNum": 820263768,
  "result": "ok",
  "answer": {
    "castMode": "mirroring",
    "udpPort": 1234,
    "sendIndexes": [0, 1],
    "ssrcs": [1233324, 2234222],
    "constraints": {
      "audio": {
        "maxSampleRate": 96000,
        "maxChannels": 5,
        "minBitRate": 32000,
        "maxBitRate": 320000
      },
      "video": {
        "maxPixelsPerSecond": 62208000,
        "minResolution": {"width": 320, "height": 240},
        "maxDimensions": {"width": 1920, "height": 1080, "frameRate": "60"},
        "minBitRate": 300000,
        "maxBitRate": 10000000,
        "maxDelay": 4000
      }
    },
    "display": {
      "dimensions": {"width": 1920, "height": 1080, "frameRate": "60000/1001"},
      "aspectRatio": "64:27",
      "scaling": "sender"
    },
    "receiverRtcpEventLog": [0, 1],
    "receiverRtcpDscp": [234, 567],
    "rtpExtensions": ["adaptive_playout_delay"]
  }
}
```

### Key ANSWER Fields

- `udpPort`: Port number to send RTP packets to (on Cast device IP)
- `sendIndexes`: Which streams from OFFER the receiver selected (e.g., [0, 1] = audio + video)
- `ssrcs`: Receiver's SSRC values for each selected stream
- `display`: Resolution and refresh rate of Cast device screen
- `constraints`: Capabilities and limits of the receiver
- `receiverRtcpEventLog`: Indexes of streams that support RTCP event logging
- `receiverRtcpDscp`: DSCP values for QoS

## RTP Streaming Protocol

After OFFER/ANSWER negotiation, stream encrypted RTP packets via UDP:

### RTP Packet Structure

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|V=2|P|X|  CC   |M|     PT      |       sequence number         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                           timestamp                           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|           synchronization source (SSRC) identifier            |
+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+
|            contributing source (CSRC) identifiers             |
|                             ....                              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   RTP Extension (optional)                    |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                         Payload (encrypted)                   |
|                             ....                              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### RTP Header Fields

- **V**: Version (2)
- **P**: Padding bit
- **X**: Extension bit
- **CC**: CSRC count
- **M**: Marker bit (1 for last fragment of frame)
- **PT**: Payload type (96 for VP8, 127 for Opus)
- **Sequence number**: Increments for each packet
- **Timestamp**: RTP timestamp (90kHz for video, 48kHz for audio)
- **SSRC**: From OFFER message

### Cast RTP Extension Header

Cast protocol uses "adaptive_playout_delay" RTP extension:

```
RTP Extension Header:
  Extension ID: Negotiated during OFFER/ANSWER
  Extension Data: Playout delay value in milliseconds
```

### AES Encryption

**Algorithm**: AES-128-CTR (Counter mode)

**Key**: From OFFER message (16 bytes)

**IV Construction**:
```
IV = SSRC (4 bytes) || RTP timestamp (4 bytes) || Counter (8 bytes)
IV = IV XOR aesIvMask
```

**Encryption**:
```
Encrypted payload = AES-CTR(key, IV, plaintext_payload)
```

Only the RTP payload is encrypted, not the RTP header.

## Implementation Requirements

### Phase 1: Protocol Implementation

**Files to Create:**
1. `CastWebRTCSession.sys.mjs` - OFFER/ANSWER message handling
2. `CastRTPStreamer.sys.mjs` - RTP packet streaming (or Rust XPCOM)
3. `nsICastRTPStreamer.idl` - XPCOM interface for RTP streaming
4. `src/rtp_streamer.rs` - Rust RTP packet builder and UDP sender

**Functionality Needed:**

1. **Launch Chrome Mirroring App**
   - Change from CC1AD845 to 0F5096E8
   - Connect to webrtc namespace

2. **Generate Crypto Keys**
   - Random AES-128 key (16 bytes)
   - Random AES IV mask (16 bytes)
   - Random SSRC values (32-bit integers)

3. **Build OFFER Message**
   - Audio stream: Opus, 48kHz, 2ch (skip for video-only initially)
   - Video stream: VP8, 1920x1080 or 1280x720, 30fps
   - Include encryption keys and SSRC

4. **Parse ANSWER Message**
   - Extract udpPort
   - Extract sendIndexes (which streams accepted)
   - Extract receiver SSRCs
   - Store display dimensions

5. **Create UDP Socket**
   - Bind to local port
   - Send to Cast device IP + udpPort from ANSWER

6. **Build RTP Packets**
   - RTP header (12 bytes minimum)
   - RTP extension for playout delay
   - VP8 payload descriptor
   - Encrypted VP8 frame data

7. **Encrypt Payload**
   - AES-128-CTR mode
   - IV = SSRC || timestamp || counter XOR ivMask
   - Encrypt only payload, not RTP header

8. **Send RTP Packets**
   - One packet per VP8 frame (or fragment large frames)
   - Increment sequence number
   - Calculate RTP timestamp (90kHz clock)
   - Send via UDP socket

9. **Handle RTCP Feedback**
   - Receive RTCP receiver reports
   - Adjust bitrate based on packet loss
   - Handle NACK (negative acknowledgments)

### Phase 2: Audio Support

10. **Audio Capture**
    - Capture tab audio via getDisplayMedia
    - Encode to Opus format

11. **Audio RTP Streaming**
    - Build RTP packets with Opus payload
    - 48kHz RTP timestamp clock
    - Synchronize with video SSRC

### What We Already Have (Can Reuse)

✅ **VP8 Encoder**: `nsICastVideoEncoder` fully working
✅ **Tab Capture**: `getDisplayMedia()` for video frames
✅ **Cast Connection**: XPCOM Cast device with message sending
✅ **Protocol Buffers**: Message serialization
✅ **WebM Muxer**: (won't need for RTP, but good reference)

### What We Need to Build

❌ **OFFER/ANSWER Message Construction**: JSON building in JS
❌ **Crypto Key Generation**: Random AES keys and IVs
❌ **UDP Socket**: nsIUDPSocket for packet sending
❌ **RTP Packet Builder**: Header construction + payload
❌ **AES Encryption**: AES-128-CTR mode
❌ **RTP Timestamp Management**: 90kHz clock for video
❌ **Sequence Number Tracking**: Per-stream counters
❌ **RTCP Handler**: Receiver reports and feedback
❌ **Opus Encoder**: Audio encoding (Phase 2)

## Complexity Assessment

### Easy Tasks (1-2 hours each)
- Change app ID to 0F5096E8
- Generate random crypto keys
- Build OFFER JSON message
- Parse ANSWER JSON message

### Medium Tasks (4-8 hours each)
- UDP socket creation and management
- RTP header construction
- AES-128-CTR encryption implementation
- RTP timestamp calculation

### Hard Tasks (1-2 days each)
- VP8 RTP payload format (RFC 7741)
- RTP packet fragmentation for large frames
- RTCP feedback handling
- Adaptive bitrate based on network conditions

### Very Hard Tasks (3-5 days)
- Audio capture and Opus encoding
- Audio/video synchronization
- Full RTCP implementation with statistics

## Estimated Timeline

**Video-only tab casting**: 1-2 weeks of focused work
**Video + audio**: Additional 1 week
**Polish and optimization**: Additional 1 week

**Total**: 2-4 weeks for complete implementation

## Alternative Approaches

### Option 1: Leverage Firefox WebRTC Stack
Firefox already has:
- Complete RTP/RTCP implementation
- AES encryption
- Opus encoder
- VP8 RTP packetization
- UDP transport

**Question**: Can we access these components via XPCOM/privileged JS?

### Option 2: Use Rust RTP Library
Crates like `webrtc` or `rtp-rs` provide:
- RTP packet building
- SRTP encryption
- RTCP handling

**Advantage**: Much faster implementation
**Disadvantage**: Need to integrate as Rust dependency

### Option 3: Simpler Cast App
**Question**: Does a simpler Cast receiver app exist that accepts:
- HLS streams?
- DASH streams?
- RTMP streams?

This might be easier than implementing full RTP.

## Firefox Components We Can Leverage

### ✅ Available Components

#### 1. nsIUDPSocket (XPCOM Interface)
**Location**: `netwerk/base/nsIUDPSocket.idl`

**Capabilities**:
- Create UDP sockets with `init(port, loopbackOnly, principal)`
- Send datagrams to host:port with `send(host, port, data)`
- Send to specific address with `sendWithAddr(addr, data)`
- Async receive with `asyncListen(listener)`
- Full control over buffer sizes, multicast, etc.

**Usage from JS**:
```javascript
const socket = Cc["@mozilla.org/network/udp-socket;1"].createInstance(Ci.nsIUDPSocket);
socket.init(-1, false, Services.scriptSecurityManager.getSystemPrincipal());
socket.asyncListen({
  onPacketReceived(socket, message) {
    console.log("Received packet:", message.data);
  },
  onStopListening(socket, status) {}
});
socket.send("10.242.34.184", 1234, new Uint8Array([...]));
```

**Status**: ✅ Ready to use, no wrapper needed

#### 2. Web Crypto API (SubtleCrypto)
**Location**: Standard Web API, available in privileged JS

**Capabilities**:
- AES-128-CTR encryption (exactly what we need!)
- Generate random keys
- Import/export keys

**Usage from JS**:
```javascript
// Generate AES key
const key = await crypto.subtle.generateKey(
  { name: "AES-CTR", length: 128 },
  true,
  ["encrypt", "decrypt"]
);

// Encrypt RTP payload
const iv = new Uint8Array(16); // SSRC || timestamp || counter XOR ivMask
const encrypted = await crypto.subtle.encrypt(
  { name: "AES-CTR", counter: iv, length: 128 },
  key,
  payload
);
```

**Status**: ✅ Ready to use, no wrapper needed

#### 3. libopus (Opus Audio Encoder)
**Location**: `media/libopus/`

**Interface**: C API (`opus_encoder_create`, `opus_encode`, etc.)

**Capabilities**:
- Encode audio to Opus format
- Configure bitrate, sample rate, channels
- Frame-based encoding (20ms frames typical)

**Current Status**: ❌ No XPCOM wrapper exists

**Options**:
- Create nsIOpusEncoder XPCOM interface (similar to nsICastVideoEncoder)
- Or use Firefox's existing OpusTrackEncoder (see `dom/media/encoder/OpusTrackEncoder.h`)

**Recommended**: Create simple XPCOM wrapper for opus library

#### 4. libwebrtc RTP Components
**Location**: `third_party/libwebrtc/modules/rtp_rtcp/`

**Classes**:
- `RtpPacket` - RTP packet header builder
- `RtpPacketToSend` - Outgoing RTP packet
- `RtpPacketizerVp8` - VP8 RTP payload formatter (RFC 7741)
- `RtpPacketizerOpus` - Opus RTP payload formatter (RFC 7587)

**Current Status**: ❌ C++ only, no XPCOM wrapper

**Challenge**: These are C++ classes in libwebrtc, not XPCOM components

**Options**:
1. **Create XPCOM wrapper**: `nsIRTPStreamer` that wraps libwebrtc classes
2. **Manual RTP building**: Build RTP headers manually in JS/Rust (simpler for our use case)

**Recommendation**: Manual RTP building (RTP header is simple, only 12 bytes)

### 🔨 Components We Need to Build

#### 1. RTP Packet Builder (Simple)
Since RTP header is only 12 bytes, we can build it manually without libwebrtc:

```rust
// In Rust (browser/components/cast/src/rtp_packet.rs)
pub struct RtpPacketBuilder {
    payload_type: u8,
    sequence_number: u16,
    timestamp: u32,
    ssrc: u32,
}

impl RtpPacketBuilder {
    pub fn build_packet(&mut self, payload: &[u8], marker: bool) -> Vec<u8> {
        let mut packet = Vec::with_capacity(12 + payload.len());

        // Byte 0: V=2, P=0, X=0, CC=0
        packet.push(0b10000000);

        // Byte 1: M bit + PT
        let m_bit = if marker { 0x80 } else { 0x00 };
        packet.push(m_bit | self.payload_type);

        // Bytes 2-3: Sequence number
        packet.extend_from_slice(&self.sequence_number.to_be_bytes());
        self.sequence_number = self.sequence_number.wrapping_add(1);

        // Bytes 4-7: Timestamp
        packet.extend_from_slice(&self.timestamp.to_be_bytes());

        // Bytes 8-11: SSRC
        packet.extend_from_slice(&self.ssrc.to_be_bytes());

        // Payload
        packet.extend_from_slice(payload);

        packet
    }
}
```

**Complexity**: Low (1-2 hours)

#### 2. VP8 RTP Payload Descriptor
VP8 needs a payload descriptor before the VP8 data (RFC 7741):

```
 0 1 2 3 4 5 6 7
+-+-+-+-+-+-+-+-+
|X|R|N|S|R| PID | (REQUIRED)
+-+-+-+-+-+-+-+-+
X:   |I|L|T|K| RSV   | (OPTIONAL)
     +-+-+-+-+-+-+-+-+
I:   |M| PictureID   | (OPTIONAL)
     +-+-+-+-+-+-+-+-+
L:   |   TL0PICIDX   | (OPTIONAL)
     +-+-+-+-+-+-+-+-+
```

For simple mirroring, we only need 1 byte:
```rust
fn build_vp8_descriptor(keyframe: bool) -> Vec<u8> {
    let s_bit = if keyframe { 0x10 } else { 0x00 };
    vec![s_bit] // X=0, R=0, N=0, S=keyframe, PID=0
}
```

**Complexity**: Low (1 hour)

#### 3. AES-128-CTR Encryption Wrapper
Wrap SubtleCrypto for RTP payload encryption:

```javascript
// CastCrypto.sys.mjs
export class CastCrypto {
  constructor(aesKey, aesIvMask) {
    this.key = null;
    this.ivMask = new Uint8Array(aesIvMask);
    this.init(aesKey);
  }

  async init(keyHex) {
    const keyBytes = this.hexToBytes(keyHex);
    this.key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-CTR" },
      false,
      ["encrypt"]
    );
  }

  async encryptPayload(ssrc, timestamp, payload) {
    // Build IV: SSRC || timestamp || counter
    const iv = new Uint8Array(16);
    const view = new DataView(iv.buffer);
    view.setUint32(0, ssrc, false); // Big endian
    view.setUint32(4, timestamp, false);
    // Bytes 8-15: counter (starts at 0)

    // XOR with ivMask
    for (let i = 0; i < 16; i++) {
      iv[i] ^= this.ivMask[i];
    }

    return await crypto.subtle.encrypt(
      { name: "AES-CTR", counter: iv, length: 128 },
      this.key,
      payload
    );
  }
}
```

**Complexity**: Low (2 hours)

#### 4. Opus Encoder XPCOM Wrapper (Phase 2)
For audio support, create a simple wrapper around libopus:

```rust
// browser/components/cast/src/opus_encoder.rs
#[xpcom::xpcom(implement(nsIOpusEncoder), atomic)]
pub struct OpusEncoder {
    encoder: RefCell<Option<*mut opus_sys::OpusEncoder>>,
}

impl OpusEncoder {
    xpcom_method!(init => Init(
        sample_rate: i32,
        channels: i32,
        bitrate: i32
    ));

    xpcom_method!(encode => Encode(
        pcm_data: *const ThinVec<i16>
    ) -> ThinVec<u8>);
}
```

**Complexity**: Medium (similar to VP8 encoder, 4-6 hours)

### Summary: What We Have vs What We Need

| Component | Status | Effort | Notes |
|-----------|--------|--------|-------|
| UDP Socket | ✅ nsIUDPSocket | Ready | No work needed |
| AES Encryption | ✅ SubtleCrypto | Ready | No work needed |
| VP8 Encoder | ✅ nsICastVideoEncoder | Ready | Already built! |
| Tab Capture | ✅ getDisplayMedia | Ready | Already works |
| Cast Protocol | ✅ CastDevice | Ready | Already works |
| RTP Packet Builder | ❌ Need to build | 1-2 hours | Simple, 12-byte header |
| VP8 Payload Descriptor | ❌ Need to build | 1 hour | Simple, 1-byte descriptor |
| Crypto Wrapper | ❌ Need to build | 2 hours | Wrap SubtleCrypto |
| OFFER/ANSWER Builder | ❌ Need to build | 2-3 hours | JSON construction in JS |
| Opus Encoder | ❌ Need to build | 4-6 hours | XPCOM wrapper (Phase 2) |

**Total Effort for Video-Only**: ~6-8 hours of focused work
**Total Effort with Audio**: ~10-14 hours

This is **much faster** than the original 1-2 week estimate because we can leverage Firefox's existing components!

## Implementation Plan

### Phase 1: Protocol Foundation (2-3 hours)

**Goal**: Launch Chrome Mirroring app and complete OFFER/ANSWER negotiation

**Tasks**:
1. Create `CastWebRTCSession.sys.mjs`
   - Generate random AES keys (16 bytes hex)
   - Generate random SSRC values
   - Build OFFER message JSON (video-only initially)
   - Parse ANSWER message
   - Extract udpPort and selected streams

2. Update `CastTabSession.sys.mjs`
   - Change app ID from CC1AD845 to 0F5096E8
   - Connect to webrtc namespace
   - Send OFFER and wait for ANSWER
   - Store negotiated parameters

**Test**: Verify Chrome Mirroring app launches and returns ANSWER

### Phase 2: RTP Streaming (3-4 hours)

**Goal**: Stream unencrypted VP8 frames via RTP/UDP

**Tasks**:
1. Create RTP packet builder in Rust
   - `browser/components/cast/src/rtp_packet.rs`
   - Build 12-byte RTP header
   - Add VP8 payload descriptor (1 byte)
   - Manage sequence numbers and timestamps

2. Create nsICastRTPStreamer XPCOM interface
   - `nsICastRTPStreamer.idl`
   - `initStreaming(udpPort, ssrc, payloadType)`
   - `sendFrame(vp8Data, timestamp, keyframe)`

3. Update `CastTabSession.sys.mjs`
   - Create UDP socket with nsIUDPSocket
   - Create RTP streamer
   - Send VP8 frames as RTP packets instead of HTTP chunks
   - Calculate RTP timestamps (90kHz clock)

**Test**: Verify RTP packets reach Cast device (may not play yet without encryption)

### Phase 3: Encryption (2 hours)

**Goal**: Encrypt RTP payloads with AES-128-CTR

**Tasks**:
1. Create `CastCrypto.sys.mjs`
   - Wrap SubtleCrypto for AES-CTR
   - Implement IV generation (SSRC || timestamp || counter XOR ivMask)
   - Async encryption method

2. Update RTP streaming
   - Encrypt payload before building RTP packet
   - Only encrypt payload, not RTP header

**Test**: End-to-end video streaming should work!

### Phase 4: Audio Support (4-6 hours, optional)

**Goal**: Add Opus audio streaming

**Tasks**:
1. Create nsIOpusEncoder XPCOM interface
2. Implement Rust wrapper for libopus
3. Capture audio from getDisplayMedia
4. Encode and stream as separate RTP stream
5. Synchronize audio/video SSRC

### File Structure

```
browser/components/cast/
├── CastWebRTCSession.sys.mjs       NEW - OFFER/ANSWER handling
├── CastCrypto.sys.mjs              NEW - AES encryption wrapper
├── CastTabSession.sys.mjs          MODIFY - Use WebRTC instead of HTTP
├── nsICastRTPStreamer.idl          NEW - RTP streaming interface
├── src/
│   ├── rtp_packet.rs               NEW - RTP packet builder
│   ├── rtp_streamer.rs             NEW - XPCOM RTP streamer
│   └── opus_encoder.rs             NEW - Opus encoder wrapper (Phase 4)
```

### Quick Start: Minimal Working Example

For fastest path to working demo:

1. **Use existing components**:
   - nsIUDPSocket for UDP
   - SubtleCrypto for encryption
   - nsICastVideoEncoder for VP8

2. **Build RTP manually in JavaScript** (prototype):
```javascript
function buildRtpPacket(vp8Data, seqNum, timestamp, ssrc, keyframe) {
  const rtpHeader = new Uint8Array(12);
  const vp8Descriptor = new Uint8Array(1);

  // RTP header
  rtpHeader[0] = 0x80; // V=2
  rtpHeader[1] = 96; // PT=96 for VP8
  new DataView(rtpHeader.buffer).setUint16(2, seqNum);
  new DataView(rtpHeader.buffer).setUint32(4, timestamp);
  new DataView(rtpHeader.buffer).setUint32(8, ssrc);

  // VP8 payload descriptor
  vp8Descriptor[0] = keyframe ? 0x10 : 0x00;

  // Combine
  const packet = new Uint8Array(13 + vp8Data.length);
  packet.set(rtpHeader, 0);
  packet.set(vp8Descriptor, 12);
  packet.set(vp8Data, 13);

  return packet;
}
```

3. **Test without encryption first**, then add it once RTP works

## Next Steps

## References

- [Chromium Cast Mirroring Components](https://chromium.googlesource.com/chromium/src/+/HEAD/components/mirroring/)
- [Chromium Cast Protocol Examples](https://chromium.googlesource.com/openscreen/+/HEAD/cast/protocol/castv2/)
- [Cast V2 Protocol Discussion](https://github.com/thibauts/node-castv2-client/issues/14)
- [Chromecast Protocol Blog](https://kyteinsky.github.io/p/chromecast-protocol/)
- [RFC 3550 - RTP Protocol](https://www.rfc-editor.org/rfc/rfc3550)
- [RFC 7741 - RTP Payload Format for VP8](https://www.rfc-editor.org/rfc/rfc7741)
- [RFC 7587 - RTP Payload Format for Opus](https://www.rfc-editor.org/rfc/rfc7587)
