# Message Logging Guide

## Overview

The Cast implementation now has clean, readable message logging that shows the conversation between Firefox and your Cast device.

## What Gets Logged

### Outgoing Messages (Firefox → Cast Device)
Format: `CastDevice: -> [namespace] TYPE [destination]`

### Incoming Messages (Cast Device → Firefox)
Format: `CastStreamListener: <- [namespace] TYPE`

## Example Session Output

Here's what a typical connection looks like:

```
CastDevice: Connecting to 10.0.0.171:8009
CastDevice: -> [connection] CONNECT
CastDevice: -> [receiver] GET_STATUS
CastDevice: Connected successfully
CastStreamListener: <- [receiver] RECEIVER_STATUS
CastStreamListener: Launching DefaultMediaReceiver
CastDevice: -> [receiver] LAUNCH
CastStreamListener: <- [receiver] LAUNCH_STATUS
CastStreamListener: <- [receiver] RECEIVER_STATUS
CastStreamListener: <- [multizone] MULTIZONE_STATUS
CastStreamListener: <- [receiver] RECEIVER_STATUS
CastStreamListener: Connecting to existing app transport: 85146ea8
CastDevice: -> [connection] CONNECT to 85146ea8
CastStreamListener: Connected to existing app
CastStreamListener: <- [receiver] RECEIVER_STATUS
CastStreamListener: Already connected to app
CastStreamListener: <- [media] MEDIA_STATUS
CastDevice: -> [heartbeat] PING
CastStreamListener: <- [heartbeat] PONG
CastDevice: -> [heartbeat] PING
CastStreamListener: <- [heartbeat] PONG
...
```

## Namespace Abbreviations

Full namespaces are shortened to the last part for readability:

| Full Namespace | Short Name |
|----------------|------------|
| `urn:x-cast:com.google.cast.tp.connection` | `connection` |
| `urn:x-cast:com.google.cast.tp.heartbeat` | `heartbeat` |
| `urn:x-cast:com.google.cast.receiver` | `receiver` |
| `urn:x-cast:com.google.cast.media` | `media` |
| `urn:x-cast:com.google.cast.multizone` | `multizone` |

## Message Types by Namespace

### Connection Namespace
**Outgoing:**
- `CONNECT` - Establish connection to device or app

**Incoming:**
- `CONNECTED` - Connection confirmed (some devices send this)
- `CLOSE` - Connection closed

### Heartbeat Namespace
**Outgoing:**
- `PING` - Keep-alive ping (every 5 seconds)
- `PONG` - Response to device's ping

**Incoming:**
- `PING` - Device asking for keep-alive
- `PONG` - Response to our ping

### Receiver Namespace
**Outgoing:**
- `GET_STATUS` - Query device state
- `LAUNCH` - Launch an application
- `STOP` - Stop an application

**Incoming:**
- `RECEIVER_STATUS` - Device state (apps, volume, etc.)
- `LAUNCH_STATUS` - Result of launch request
- `LAUNCH_ERROR` - Launch failed

### Media Namespace
**Outgoing (Phase 2):**
- `LOAD` - Load media URL
- `PLAY` - Start playback
- `PAUSE` - Pause playback
- `STOP` - Stop playback
- `SEEK` - Seek to position

**Incoming:**
- `MEDIA_STATUS` - Current playback state

### Multizone Namespace
**Incoming:**
- `MULTIZONE_STATUS` - Multi-room audio group info

## Understanding the Flow

### 1. Initial Connection
```
CastDevice: -> [connection] CONNECT          ← We say hello to platform
CastDevice: -> [receiver] GET_STATUS         ← Ask what's running
CastStreamListener: <- [receiver] RECEIVER_STATUS  ← Device tells us
```

### 2. App Launch (if needed)
```
CastStreamListener: Launching DefaultMediaReceiver
CastDevice: -> [receiver] LAUNCH             ← Start the app
CastStreamListener: <- [receiver] LAUNCH_STATUS   ← App starting
CastStreamListener: <- [receiver] RECEIVER_STATUS ← App running
```

### 3. App Connection
```
CastStreamListener: Connecting to existing app transport: 85146ea8
CastDevice: -> [connection] CONNECT to 85146ea8  ← Say hello to app
CastStreamListener: <- [receiver] RECEIVER_STATUS ← senderConnected: true
```

### 4. Ready State
```
CastStreamListener: <- [media] MEDIA_STATUS  ← Ready for media commands
```

### 5. Keep-Alive
```
CastDevice: -> [heartbeat] PING              ← Every 5 seconds
CastStreamListener: <- [heartbeat] PONG      ← Device responds
```

## Destination Annotations

When sending to a specific app (not the platform), the destination transport ID is shown:

```
CastDevice: -> [connection] CONNECT to 85146ea8
                                    ^^^^^^^^
                                    First 8 chars of transport ID
```

- No suffix = message to `receiver-0` (platform)
- `to 85146ea8` = message to specific app transport

## Debugging Tips

### Check Message Flow
Look for this pattern:
1. `CONNECT` sent
2. `GET_STATUS` sent
3. `RECEIVER_STATUS` received
4. Either `LAUNCH` sent OR `CONNECT to [transportId]` sent
5. `RECEIVER_STATUS` with `senderConnected: true`
6. `MEDIA_STATUS` received

If any step is missing, something went wrong.

### Common Issues

**Problem: No responses at all**
```
CastDevice: -> [connection] CONNECT
CastDevice: -> [receiver] GET_STATUS
(nothing else)
```
**Likely cause:** Network issue, wrong IP, firewall blocking

**Problem: RECEIVER_STATUS but never connects to app**
```
CastStreamListener: <- [receiver] RECEIVER_STATUS
(no "Connecting to existing app" or "Launching")
```
**Likely cause:** Bug in parsing RECEIVER_STATUS response

**Problem: App launched but senderConnected stays false**
```
CastStreamListener: Launching DefaultMediaReceiver
CastStreamListener: <- [receiver] RECEIVER_STATUS
(senderConnected still false)
```
**Likely cause:** Missing CONNECT to transport ID

### Enable Even More Logging

If you need to see full message payloads, edit `stream_listener.rs` and add:

```rust
println!("Full payload: {}", payload);
```

Or in `cast_device.rs`:
```rust
println!("Sending: {}", payload);
```

## Filtering Logs

### See only connection messages:
```bash
./mach run 2>&1 | grep -E "connection|CONNECT"
```

### See only receiver messages:
```bash
./mach run 2>&1 | grep "receiver"
```

### Exclude heartbeat (less noise):
```bash
./mach run 2>&1 | grep -v "heartbeat"
```

### See only state changes:
```bash
./mach run 2>&1 | grep -E "State changed|Launching|Connected to"
```

## Log Output Locations

Messages appear in different places depending on how you run Firefox:

### Terminal (./mach run)
All Rust logs (`println!`) appear in the terminal where you ran `./mach run`

### Browser Console (Cmd+Shift+J)
JavaScript logs (`console.log`) appear in Browser Console

### Both
Connection flow involves both:
- Rust logs: Message protocol details
- JS logs: High-level state ("Connection successful!")

## Example: Complete Connection Sequence

```
Terminal (Rust):
────────────────────────────────────────────────────────
CastDevice: Connecting to 10.0.0.171:8009
CastDevice: -> [connection] CONNECT
CastDevice: -> [receiver] GET_STATUS
CastDevice: Connected successfully
CastStreamListener: <- [receiver] RECEIVER_STATUS
CastStreamListener: Launching DefaultMediaReceiver
CastDevice: -> [receiver] LAUNCH
CastStreamListener: <- [receiver] LAUNCH_STATUS
CastStreamListener: <- [receiver] RECEIVER_STATUS
CastStreamListener: Connecting to existing app transport: 85146ea8
CastDevice: -> [connection] CONNECT to 85146ea8
CastStreamListener: <- [receiver] RECEIVER_STATUS
CastStreamListener: Already connected to app
CastStreamListener: <- [media] MEDIA_STATUS

Browser Console (JavaScript):
────────────────────────────────────────────────────────
CastDevice: Connecting to 10.0.0.171:8009
CastDevice: State changed to connecting
CastDevice: State changed to connected
CastDevice: Started heartbeat
CastService: Connection successful!
CastService: Launching DefaultMediaReceiver...
```

## Performance Note

Logging has minimal performance impact:
- Only logs message type and namespace (not full payloads)
- Simple string operations
- No file I/O
- Can be disabled by commenting out `println!` calls

For production, consider:
1. Adding a `MOZ_LOG` level check
2. Removing or reducing logs
3. Using Firefox's standard logging system

## Next Steps: Phase 2 Logging

When we add media streaming in Phase 2, you'll see:

```
CastDevice: -> [media] LOAD
CastStreamListener: <- [media] MEDIA_STATUS (BUFFERING)
CastStreamListener: <- [media] MEDIA_STATUS (PLAYING)
CastStreamListener: <- [media] MEDIA_STATUS (IDLE)
```

This will help debug video streaming and playback control.
