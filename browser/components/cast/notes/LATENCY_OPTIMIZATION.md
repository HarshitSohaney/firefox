# Latency Optimization Guide

Documentation of latency improvements made to Firefox Cast.

## Current Architecture

The Cast implementation uses HTTP streaming with VP8/WebM to the DefaultMediaReceiver app. This approach has inherent latency due to the receiver's buffering behavior.

## Latency Sources

### 1. App Startup Delay (3-5 seconds)

When casting starts:
1. Firefox sends LOAD command to Cast device
2. Cast device launches DefaultMediaReceiver app (takes 3-5 seconds)
3. App connects to our HTTP stream
4. App buffers before playing

**Problem:** If we start encoding immediately, frames accumulate while the app loads, causing permanent lag.

### 2. Receiver Buffering

The DefaultMediaReceiver buffers ~200ms before playback for smooth streaming.

### 3. Encoding/Network (~20-30ms)

- Capture: 5-10ms
- VP8 encode: 5-15ms
- Network: 5-10ms

## Current Mitigations

### Frame Skipping (CastSession.sys.mjs)

To prevent lag buildup, we track where the receiver is playing and skip frames when we get too far ahead:

```javascript
// Track receiver playback position from MEDIA_STATUS
updateReceiverTime(castCurrentTime) {
  this._lastReceiverTime = castCurrentTime;
  this._lastReceiverUpdate = Date.now();
}

getEstimatedReceiverTime() {
  const elapsed = (Date.now() - this._lastReceiverUpdate) / 1000;
  return this._lastReceiverTime + elapsed;
}

// In captureFrame - skip if too far ahead
const maxLagMs = 1000;
if (this._playbackStarted && this._streamStartTime) {
  const timestampMs = Date.now() - this._streamStartTime;
  const receiverTimeMs = this.getEstimatedReceiverTime() * 1000;
  const lagMs = timestampMs - receiverTimeMs;

  if (lagMs > maxLagMs) {
    // Skip frame - don't capture or send
    return;
  }
}
```

### Pause During Buffering

When the receiver reports BUFFERING state, we pause frame capture entirely to prevent backlog:

```javascript
if (this._playbackStarted && this._receiverBuffering) {
  return; // Don't capture while receiver is buffering
}

// In handleMediaMessage
if (status?.playerState === "BUFFERING") {
  this._receiverBuffering = true;
} else if (status?.playerState === "PLAYING") {
  this._receiverBuffering = false;
}
```

### Initial Clock Sync

When playback first starts, we measure the lag and resync:

```javascript
onPlaybackStarted(castCurrentTime) {
  const streamElapsedSec = (Date.now() - this._streamStartTime) / 1000;
  const lagSec = streamElapsedSec - castCurrentTime;

  if (lagSec > 0.5) {
    this._streamStartTime = Date.now() - castCurrentTime * 1000;
    this._forceKeyframe = true;
  }
}
```

## Why Not Lower Latency?

Chrome achieves sub-second latency for tab casting because it uses a completely different protocol:

- **Cast Streaming** (RTP/UDP) instead of HTTP
- **Chrome Mirroring app** (0F5096E8) instead of DefaultMediaReceiver
- Direct UDP packets with 400ms target latency

Implementing this would require significant work (see WEBRTC_CAST_RESEARCH.md).

## Latency Breakdown

| Component | Latency | Notes |
|-----------|---------|-------|
| Capture | 5-10ms | drawSnapshot() |
| Encoding | 5-15ms | VP8 in Rust |
| Network | 5-10ms | HTTP over WiFi |
| Receiver buffer | ~200ms | DefaultMediaReceiver |
| **Total** | **~250ms** | Best case, after sync |

## Frame Rate & Quality Settings

Current defaults (CastSession.sys.mjs):
- FPS: 30
- Bitrate: 15-25 Mbps
- Resolution: Up to 1920x1080
- Keyframe interval: Every 5 seconds

## Future Improvements

1. **Cast Streaming Protocol** - Implement RTP/UDP streaming with Chrome Mirroring app for sub-500ms latency
2. **Adaptive bitrate** - Reduce quality when network is congested
3. **Hardware encoding** - Use VideoToolbox/MediaCodec for faster encoding
