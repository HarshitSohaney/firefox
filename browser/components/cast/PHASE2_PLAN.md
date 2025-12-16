# Phase 2: Tab Casting Implementation

## Overview

Phase 2 implements tab casting (real-time screen mirroring) for Firefox using a screenshot-based approach. The architecture is designed to be extensible for Phase 3 (full WebRTC streaming).

## Goals

1. Capture tab content as a continuous stream of screenshots
2. Encode screenshots as video frames (JPEG/PNG)
3. Stream frames to Cast device via HTTP server
4. Control playback using Cast Media namespace
5. Maintain architecture that can be upgraded to WebRTC

## Architecture

```
Tab Content
    ↓
Screenshot Capture (nsIDOMWindowUtils.drawWindow)
    ↓
Image Encoding (imgIEncoder)
    ↓
HTTP Server (nsIHttpServer)
    ↓
Cast Media Protocol (urn:x-cast:com.google.cast.media)
    ↓
Cast Device (DefaultMediaReceiver)
```

## Key Components

### 1. Tab Capture Service (JavaScript)
**File**: `CastTabCapture.sys.mjs`

Responsibilities:
- Capture tab screenshots using `nsIDOMWindowUtils.drawWindow()`
- Detect tab changes (scroll, navigation, DOM mutations)
- Throttle capture rate (target: 5-10 fps initially)
- Encode images as JPEG with quality/performance balance

```javascript
class CastTabCapture {
  constructor(browser)
  async start()
  async stop()

  // Events
  addEventListener("frame", cb)  // New frame captured
  addEventListener("error", cb)
}
```

### 2. HTTP Media Server (JavaScript)
**File**: `CastMediaServer.sys.mjs`

Responsibilities:
- Start local HTTP server on random port
- Serve MJPEG stream (Motion JPEG over HTTP)
- Handle CORS headers for Cast device access
- Provide manifest/metadata endpoints

```javascript
class CastMediaServer {
  constructor()
  async start()              // Returns URL
  async stop()

  setFrameSource(captureService)
  getMediaUrl()             // Returns http://localhost:PORT/stream.mjpeg
}
```

### 3. Media Protocol Handler (Rust)
**File**: `src/handlers/media.rs`

Responsibilities:
- Create LOAD message for media playback
- Handle MEDIA_STATUS responses
- Control playback (PLAY, PAUSE, STOP, SEEK)
- Track media session state

```rust
pub struct MediaHandler {
    media_session_id: Option<String>,
    request_id_counter: u32,
}

impl MediaHandler {
    pub const NAMESPACE: &'static str = "urn:x-cast:com.google.cast.media";

    pub fn create_load(
        &mut self,
        media_url: &str,
        content_type: &str,
        stream_type: &str,
    ) -> String;

    pub fn create_play(&mut self) -> String;
    pub fn create_pause(&mut self) -> String;
    pub fn create_stop(&mut self) -> String;
}
```

### 4. Cast Session Manager (JavaScript)
**File**: `CastSessionManager.sys.mjs`

Responsibilities:
- Coordinate tab capture + media server + Cast device
- Start/stop casting sessions
- Handle reconnection if Cast device disconnects
- Manage session lifecycle

```javascript
class CastSessionManager {
  async startTabCasting(browser, device)
  async stopTabCasting()

  // State
  state  // idle, capturing, streaming, error

  // Events
  addEventListener("stateChanged", cb)
}
```

## Data Flow

### Starting Tab Cast

1. User clicks Cast icon, selects tab + device
2. `CastSessionManager.startTabCasting(browser, device)`
3. Create `CastTabCapture` for browser
4. Create `CastMediaServer` and start HTTP server
5. Connect tab capture to media server
6. Device already connected from Phase 1
7. Send LOAD message with media URL:
   ```json
   {
     "type": "LOAD",
     "requestId": 123,
     "media": {
       "contentId": "http://192.168.1.100:8080/stream.mjpeg",
       "contentType": "video/jpeg",
       "streamType": "LIVE"
     }
   }
   ```
8. DefaultMediaReceiver starts fetching MJPEG stream
9. Screenshots displayed on TV in real-time

### Stopping Tab Cast

1. User clicks stop or disconnects
2. Send STOP message to Cast device
3. Stop tab capture service
4. Stop HTTP media server
5. Close Cast connection
6. Clean up resources

## Technical Decisions

### Screenshot Capture
- Use `nsIDOMWindowUtils.drawWindow()` for tab rendering
- Capture at 5-10 fps (configurable)
- Detect changes: MutationObserver + scroll events + timer fallback
- Only capture on changes to save CPU

### Image Encoding
- Start with JPEG (quality: 80, configurable)
- Use `imgIEncoder` component
- Consider WebP if Cast device supports it
- Balance quality vs. latency vs. bandwidth

### Transport Protocol
- MJPEG over HTTP (Motion JPEG)
- Simple, widely supported format
- Each frame is a complete JPEG image
- Low latency, good for screen casting

### HTTP Server
- Use `nsIHttpServer` (built into Firefox)
- Random available port (avoid conflicts)
- Single endpoint: `/stream.mjpeg`
- MIME type: `multipart/x-mixed-replace; boundary=frame`

### Frame Format
```
--frame
Content-Type: image/jpeg
Content-Length: 12345

[JPEG binary data]
--frame
Content-Type: image/jpeg
Content-Length: 23456

[JPEG binary data]
--frame
...
```

## Performance Considerations

### CPU Usage
- Target 5-10 fps (not 30 fps) to reduce CPU load
- Only capture on tab changes (scroll, click, navigation)
- Use JPEG quality 70-80 (not 100) for faster encoding
- Consider resolution scaling (capture at 720p even if tab is 1080p)

### Network Usage
- MJPEG bandwidth ≈ 500KB/s - 2MB/s (depends on content)
- Use quality settings to control bandwidth
- Consider adaptive quality based on network conditions

### Memory Usage
- Reuse canvas/buffer between captures
- Limit HTTP server queue depth (drop old frames if backed up)
- Clean up resources on stop

## Extension Points for Phase 3 (WebRTC)

The architecture is designed for easy upgrade to WebRTC:

1. **Keep same capture source**: `CastTabCapture.sys.mjs`
2. **Replace transport layer**:
   - Remove `CastMediaServer` (HTTP)
   - Add `CastWebRTCTransport` (WebRTC)
3. **Change Cast protocol**:
   - Use `urn:x-cast:com.google.cast.webrtc` namespace
   - Send OFFER with SDP
   - Handle ANSWER from Cast device
4. **Use Firefox WebRTC stack**:
   - Use existing `RTCPeerConnection` APIs
   - Stream via `MediaStreamTrack` from canvas
   - Lower latency, better quality

## File Changes Required

### New Files
1. `/browser/components/cast/CastTabCapture.sys.mjs`
2. `/browser/components/cast/CastMediaServer.sys.mjs`
3. `/browser/components/cast/CastSessionManager.sys.mjs`
4. `/browser/components/cast/src/handlers/media.rs`

### Modified Files
1. `/browser/components/cast/src/lib.rs` - Export media handler
2. `/browser/components/cast/src/handlers/mod.rs` - Add media module
3. `/browser/components/cast/CastServiceWrapper.sys.mjs` - Add session manager
4. `/browser/base/content/browser-cast.js` - Add tab casting UI
5. `/browser/components/cast/moz.build` - Register new modules

### New Dependencies
None required - all APIs available in Firefox:
- `nsIDOMWindowUtils` - Tab screenshot capture
- `imgIEncoder` - Image encoding
- `nsIHttpServer` - HTTP server
- Existing Cast protocol from Phase 1

## Testing Strategy

### Manual Testing
1. Click Cast icon in toolbar
2. Select tab to cast
3. Select Cast device (from Phase 1 manual IP entry)
4. Verify Cast device shows tab content
5. Scroll tab - verify Cast device updates
6. Navigate to new URL - verify Cast device updates
7. Click stop - verify streaming stops

### Expected Behavior
- Initial connection: < 2 seconds
- Frame latency: 200-500ms (acceptable for tab casting)
- Smooth scrolling visible on Cast device
- No audio (Phase 2 only does video)

### Known Limitations
- No audio streaming (Phase 3 with WebRTC)
- Higher latency than WebRTC (200-500ms vs 50-100ms)
- Higher CPU usage than WebRTC (JPEG encoding vs hardware encoding)
- No adaptive quality (fixed JPEG quality)

## Success Criteria

Phase 2 complete when:
- ✅ Can cast tab content to Cast device
- ✅ Tab updates (scroll, navigation, clicks) appear on Cast device
- ✅ Latency acceptable for demo purposes (< 1 second)
- ✅ Can start and stop casting cleanly
- ✅ CPU usage reasonable (< 30% on modern CPU)
- ✅ No memory leaks during extended casting
- ✅ Architecture ready for Phase 3 WebRTC upgrade

## Future Work (Phase 3)

After Phase 2 working:
1. Replace MJPEG with WebRTC streaming
2. Add audio capture and streaming
3. Implement adaptive quality/bitrate
4. Add hardware-accelerated video encoding
5. Reduce latency to < 100ms
6. Support 1080p/4K streaming
7. Add presenter mode (cursor highlighting, etc.)

## Timeline

**Not providing time estimates per instructions** - breaking into concrete steps:

1. Implement `CastTabCapture.sys.mjs` (screenshot capture)
2. Implement `CastMediaServer.sys.mjs` (HTTP MJPEG server)
3. Implement `src/handlers/media.rs` (Cast media protocol)
4. Implement `CastSessionManager.sys.mjs` (orchestration)
5. Update UI in `browser-cast.js` (tab selection)
6. Integration testing and debugging
7. Performance optimization
8. Documentation and cleanup
