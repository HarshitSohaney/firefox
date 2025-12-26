# Firefox Cast Implementation: mDNS Discovery & Architecture

## What is mDNS?

**mDNS (Multicast DNS)** is a protocol that allows devices on a local network to discover each other without needing a central DNS server. It's part of the Zeroconf (Zero Configuration Networking) suite.

### How mDNS Works

#### 1. The Basics

Traditional DNS requires a DNS server to resolve names like `google.com` to IP addresses. mDNS works differently:

- Uses **multicast** instead of unicast (sends to everyone on the network)
- Uses IP address `224.0.0.251` and port `5353`
- Devices announce themselves and answer queries directly
- No central server needed

#### 2. Service Discovery (DNS-SD)

mDNS is often used with **DNS-SD (DNS Service Discovery)** to find services on the network. Services are identified by names like:

```
_googlecast._tcp.local
```

Breaking this down:
- `_googlecast` - The service name
- `_tcp` - Transport protocol (TCP)
- `local` - Special domain for local network

#### 3. The Discovery Process

**Step 1: Query**

A client (Firefox) sends a multicast DNS query asking "Who provides `_googlecast._tcp.local` service?"

```
Query Packet:
- Destination: 224.0.0.251:5353 (multicast)
- Question: PTR record for "_googlecast._tcp.local"
```

**Step 2: Response**

Cast devices listening on the multicast address respond with DNS records:

```
Answer Section:
- PTR Record: Points to instance name
  "_googlecast._tcp.local" -> "Living-Room-TV._googlecast._tcp.local"

Additional Section:
- SRV Record: Hostname and port
  "Living-Room-TV._googlecast._tcp.local" -> host: Living-Room-TV.local, port: 8009

- TXT Record: Metadata key-value pairs
  fn=Living Room TV
  md=Chromecast

- A Record: IPv4 address
  "Living-Room-TV.local" -> 10.0.0.25
```

**Step 3: Device Information Extracted**

From these records, we get:
- **Friendly Name**: "Living Room TV" (from TXT `fn` field)
- **IP Address**: 10.0.0.25 (from A record)
- **Port**: 8009 (from SRV record)
- **Model**: "Chromecast" (from TXT `md` field)

### DNS Record Types Used

| Record | Purpose | Example |
|--------|---------|---------|
| **PTR** | Points to service instance name | `_googlecast._tcp.local` → `Device-123._googlecast._tcp.local` |
| **SRV** | Service location (hostname:port) | `Device-123._googlecast._tcp.local` → `Device-123.local:8009` |
| **TXT** | Metadata (key=value pairs) | `fn=Living Room TV`, `md=Chromecast` |
| **A** | IPv4 address | `Device-123.local` → `10.0.0.25` |

---

## Firefox Cast Implementation

### Component Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser UI                            │
│  ┌──────────────┐           ┌──────────────────────────┐   │
│  │ Cast Button  │───────────│    Cast Panel            │   │
│  │ (Toolbar)    │           │  - Device List           │   │
│  └──────────────┘           │  - Active Session UI     │   │
│                              │  - Stop Button           │   │
│                              └──────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     CastService.sys.mjs                      │
│  - Manages devices and sessions                              │
│  - Coordinates discovery and casting                         │
│  - Handles device connection lifecycle                       │
└─────────────────────────────────────────────────────────────┘
         │                      │                      │
         ▼                      ▼                      ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ CastDiscovery   │  │   CastDevice    │  │  CastSession    │
│   .sys.mjs      │  │    .sys.mjs     │  │   .sys.mjs      │
│                 │  │                 │  │                 │
│ - mDNS queries  │  │ - Device conn   │  │ - Tab capture   │
│ - DNS parsing   │  │ - TLS handshake │  │ - Video encode  │
│ - Device events │  │ - Cast protocol │  │ - HTTP server   │
└─────────────────┘  └─────────────────┘  └─────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                  nsIUDPSocket (XPCOM)                        │
│  - UDP multicast communication                               │
│  - Sends queries to 224.0.0.251:5353                        │
│  - Receives mDNS responses                                   │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. **CastDiscovery.sys.mjs**

Handles mDNS service discovery.

**Responsibilities:**
- Create UDP socket for multicast communication
- Send periodic mDNS queries for `_googlecast._tcp.local`
- Parse DNS responses (PTR, SRV, TXT, A records)
- Notify listeners when devices are found/lost

**Key Code:**
```javascript
// Create UDP socket
this.#socket = Cc["@mozilla.org/network/udp-socket;1"]
  .createInstance(Ci.nsIUDPSocket);

// Use ephemeral port (OS assigns available port)
this.#socket.init(0, false, Services.scriptSecurityManager.getSystemPrincipal(), true);

// Send multicast query to 224.0.0.251:5353
this.#socket.send("224.0.0.251", 5353, queryData, queryData.length);
```

**Why Ephemeral Port?**
- System mDNS services (like macOS Bonjour) already use port 5353
- Using port 0 lets the OS assign any available port
- Cast devices respond via **unicast** back to our source port
- We don't need to receive on 5353 to get responses

#### 2. **CastService.sys.mjs**

Central coordinator for Cast functionality.

**Responsibilities:**
- Manage device registry (`#devices` Map)
- Manage active casting sessions (`#sessions` Map)
- Start/stop discovery
- Handle device connection flow
- Dispatch events for UI updates

**Device Connection Flow:**
```javascript
async connectAndLaunchApp(deviceId) {
  const device = this.#devices.get(deviceId);

  // 1. Add certificate override (Cast uses self-signed certs)
  await device.addCertificateOverride();

  // 2. Establish TLS connection
  await device.connect();

  // 3. Launch default media receiver app
  await device.launchApp();

  return result;
}
```

#### 3. **CastDevice.sys.mjs**

Represents a single Cast device.

**Responsibilities:**
- TLS connection to device (port 8009)
- Cast protocol message handling
- Heartbeat (PING/PONG) to keep connection alive
- Certificate validation override
- App launch and management

**Connection States:**
- `disconnected` - No connection
- `connecting` - TLS handshake in progress
- `connected` - Ready to cast
- `error` - Connection failed

#### 4. **CastSession.sys.mjs**

Manages an active casting session.

**Responsibilities:**
- Capture tab content via Canvas API
- Encode video to WebM (VP8/VP9)
- Serve video stream via HTTP
- Send Cast protocol LOAD command
- Handle session lifecycle

---

## Complete Flow: From Discovery to Casting

### Phase 1: Discovery

```
User Opens Panel
       │
       ▼
CastPanel.onPanelShowing()
       │
       ▼
CastService.startDiscovery()
       │
       ▼
CastDiscovery.start()
       │
       ├──> Create UDP socket on ephemeral port
       ├──> Send mDNS query for "_googlecast._tcp.local"
       └──> Set 5-second interval for periodic queries
              │
              ▼
       ┌──────────────────────────────────┐
       │  Multicast to 224.0.0.251:5353   │
       │  "Who has _googlecast._tcp?"     │
       └──────────────────────────────────┘
              │
              ▼
       ┌──────────────────────────────────┐
       │   Cast Device Responds           │
       │   (Unicast back to our port)     │
       │                                  │
       │   PTR: Device-Name._googlecast   │
       │   SRV: hostname:8009             │
       │   TXT: fn="Living Room TV"       │
       │   A:   10.0.0.25                 │
       └──────────────────────────────────┘
              │
              ▼
CastDiscovery.#handleResponse()
       │
       ├──> Parse DNS packet
       ├──> Extract device info
       └──> Fire onDeviceFound callback
              │
              ▼
CastService.#onDeviceDiscovered()
       │
       ├──> Create CastDevice instance
       ├──> Add to #devices Map
       └──> Dispatch "CastService:DeviceAdded" event
              │
              ▼
CastPanel.onDeviceAdded()
       │
       └──> Add device to panel UI list
```

### Phase 2: User Selects Device

```
User Clicks Device in Panel
       │
       ▼
CastPanel.onDeviceSelected()
       │
       ▼
CastService.startTabCasting(deviceId, browser, window)
       │
       ▼
CastService.connectAndLaunchApp(deviceId)
       │
       ├──> Step 1: Add Certificate Override
       │    │
       │    └──> device.addCertificateOverride()
       │         │
       │         └──> TLS handshake to get cert
       │              Add to certOverrideService
       │              (Cast devices use self-signed certs)
       │
       ├──> Step 2: Connect
       │    │
       │    └──> device.connect()
       │         │
       │         ├──> Open TLS connection to device:8009
       │         ├──> Send CONNECT message
       │         ├──> Send GET_STATUS to receiver
       │         └──> Start heartbeat (PING every 5s)
       │
       └──> Step 3: Launch App
            │
            └──> device.launchApp()
                 │
                 └──> Send LAUNCH with appId="CC1AD845"
                      (Default Media Receiver)
```

### Phase 3: Start Casting

```
Device Connected & App Launched
       │
       ▼
Create CastSession
       │
       ▼
session.start(browser, options)
       │
       ├──> Step 1: Setup Canvas Capture
       │    │
       │    ├──> Scale tab content to target resolution
       │    ├──> Create CanvasCaptureMediaStream
       │    └──> Extract video track
       │
       ├──> Step 2: Initialize Video Encoder
       │    │
       │    ├──> Call Rust encoder (libcastencoder)
       │    ├──> Configure VP8/VP9 codec
       │    └──> Generate WebM header
       │
       ├──> Step 3: Start HTTP Server
       │    │
       │    ├──> SimpleHTTPServer on random port
       │    ├──> Serve WebM stream at /stream.webm
       │    └──> Stream URL: http://hostname:port/stream.webm
       │
       └──> Step 4: Send LOAD Command
            │
            └──> Cast protocol message:
                 {
                   type: "LOAD",
                   media: {
                     contentId: "http://hostname:8010/stream.webm",
                     contentType: "video/webm",
                     streamType: "LIVE"
                   }
                 }
                      │
                      ▼
              ┌────────────────────────────┐
              │    Cast Device            │
              │                           │
              │  1. Fetches WebM stream   │
              │  2. Decodes video         │
              │  3. Displays on screen    │
              └────────────────────────────┘
```

### Phase 4: Stop Casting

```
User Clicks "Stop Casting"
       │
       ▼
CastPanel.onStopCasting()
       │
       ▼
CastService.stopTabCasting(deviceId)
       │
       ├──> Step 1: Stop Session
       │    │
       │    └──> session.stop()
       │         │
       │         ├──> Stop canvas capture
       │         ├──> Shutdown encoder
       │         └──> Stop HTTP server
       │
       └──> Step 2: Disconnect Device
            │
            └──> device.disconnect()
                 │
                 ├──> Send STOP to media receiver
                 ├──> Clear heartbeat timer
                 ├──> Close TLS connection
                 └──> Set state to "disconnected"
```

---

## Technical Details

### DNS Packet Structure

mDNS uses standard DNS packet format:

```
Header (12 bytes):
  - Transaction ID: 0x0000 (always 0 for queries)
  - Flags: 0x0000 (standard query)
  - Questions: 1
  - Answer RRs: 0
  - Authority RRs: 0
  - Additional RRs: 0

Question Section:
  - Name: "_googlecast._tcp.local" (encoded as length-prefixed labels)
  - Type: 12 (PTR)
  - Class: 1 (IN - Internet)

Answer Section: (in response)
  - Name compression using pointers (0xC0XX)
  - Multiple records (PTR, SRV, TXT, A)
```

### Parsing Algorithm

```javascript
// Skip question section first
for (let i = 0; i < questionCount; i++) {
  offset += skipName(offset);  // Skip QNAME
  offset += 4;                 // Skip QTYPE + QCLASS
}

// Parse answer section
for (let i = 0; i < answerCount; i++) {
  const name = readName(offset);
  offset += skipName(offset);

  const type = (data[offset] << 8) | data[offset + 1];
  offset += 2;

  // ... parse based on type
}

// Parse additional section (SRV, TXT, A records usually here)
```

### Why Self-Signed Certificates?

Cast devices use self-signed TLS certificates because:
- They're local devices, not internet services
- No central CA for local network devices
- Each device generates its own certificate

Firefox normally rejects self-signed certs, so we:
1. Initiate TLS handshake to retrieve certificate
2. Add exception via `certOverrideService`
3. Future connections are trusted

---

## Security Considerations

1. **Local Network Only**: mDNS only works on local network (TTL=1)
2. **TLS Encryption**: All Cast protocol messages use TLS
3. **Certificate Pinning**: Could validate Cast cert fingerprints
4. **User Consent**: User must click device to cast
5. **No Authentication**: Cast protocol doesn't require passwords (assumed trusted network)

---

## Performance Considerations

1. **Periodic Queries**: Every 5 seconds to catch new devices
2. **Ephemeral Port**: Avoids conflicts with system mDNS
3. **Unicast Responses**: Devices respond directly, not to multicast group
4. **Heartbeat**: 5-second PING to detect disconnections
5. **Certificate Caching**: Override persists across restarts

---

## Debugging Tips

Enable Cast logging:
```
about:config
browser.cast.log = true
```

Console output will show:
- mDNS queries sent
- DNS responses received
- Device discovery events
- Connection state changes
- Cast protocol messages

Common issues:
- **No devices found**: Check firewall allows UDP 5353
- **Certificate errors**: `addCertificateOverride()` may have failed
- **Connection drops**: Check network stability, heartbeat logs
- **Black screen**: Video encoder issues, check canvas capture
