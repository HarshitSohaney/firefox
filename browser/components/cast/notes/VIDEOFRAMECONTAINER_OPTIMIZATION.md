# VideoFrameContainer Optimization Opportunity

## Current Implementation

The Cast implementation currently uses a canvas-based capture approach:

**File:** `browser/components/cast/modules/CastSession.sys.mjs:283-362`

```javascript
// Current approach:
1. drawSnapshot() from browsingContext -> ImageBitmap
2. ctx.drawImage(snapshot) -> Canvas
3. ctx.getImageData() -> RGBA pixel data (copies memory)
4. Pass Uint8Array to Rust encoder
5. Convert RGBA -> I420 in Rust
6. Encode with VP8
```

**Performance characteristics:**
- Multiple memory copies (ImageBitmap -> Canvas -> ImageData -> Rust)
- Color conversion overhead (RGBA -> I420)
- JavaScript/Rust boundary crossings
- Canvas 2D context not optimized for video streaming

## Proposed Optimization: Use VideoFrameContainer

Firefox has optimized video frame infrastructure designed for efficient video processing:

**Key Components:**

### 1. VideoFrameContainer (dom/media/VideoFrameContainer.h:31-151)
- Thread-safe video frame management
- Integrates with ImageContainer for GPU-accelerated rendering
- Used by MediaDecoder, WebRTC, Picture-in-Picture
- Handles frame timing, principal handles, intrinsic sizing

### 2. ImageContainer (gfx/layers/client/ImageContainer.h)
- GPU texture management
- Zero-copy frame passing
- Support for multiple image formats (I420, NV12, etc.)
- Efficient compositor integration

### 3. WebCodecs VideoFrame API
- Modern web API for video frame manipulation
- Direct access to decoded video frames
- Supports I420/NV12 formats natively
- Can clone frames without pixel copies

## Implementation Strategy

### Phase 1: Direct VideoFrame Access

Instead of canvas capture, access video frames directly from the browser:

```javascript
// Proposed approach:
const videoElement = browser.contentDocument.querySelector('video');
if (videoElement && !videoElement.paused) {
  // Get VideoFrameContainer from video element
  const frameContainer = videoElement.mozVideoFrameContainer;

  // Access current frame without copying
  const image = frameContainer.GetImageContainer().GetCurrentImage();

  // Pass image data directly to Rust encoder
  // Image is already in YUV format (I420/NV12) - no conversion!
}
```

### Phase 2: Tab Content as VideoFrame Stream

For tab casting (non-video content), use CanvasCaptureMediaStreamTrack:

```javascript
// Create MediaStream from canvas at native framerate
const stream = canvas.captureStream(fps);

// Use MediaStreamTrackProcessor (WebCodecs API)
const processor = new MediaStreamTrackProcessor({ track: stream.getVideoTracks()[0] });
const reader = processor.readable.getReader();

while (true) {
  const { value: videoFrame, done } = await reader.read();
  if (done) break;

  // videoFrame is already in efficient format
  // Access I420 planes directly:
  const yPlane = new Uint8Array(videoFrame.allocationSize({ planeIndex: 0 }));
  const uPlane = new Uint8Array(videoFrame.allocationSize({ planeIndex: 1 }));
  const vPlane = new Uint8Array(videoFrame.allocationSize({ planeIndex: 2 }));

  videoFrame.copyTo(yPlane, { planeIndex: 0 });
  videoFrame.copyTo(uPlane, { planeIndex: 1 });
  videoFrame.copyTo(vPlane, { planeIndex: 2 });

  // Pass planes to Rust encoder - already in I420 format!
  this._encoder.encodeFrameI420(yPlane, uPlane, vPlane, timestamp);

  videoFrame.close();
}
```

### Phase 3: Zero-Copy GPU Path

Ideal implementation using Firefox internals:

```rust
// In Rust XPCOM component:
xpcom_method!(encode_image => EncodeImage(image: *const layers::Image));

fn encode_image(&self, image: &layers::Image) -> Result<ThinVec<u8>, nsresult> {
    // Get planar data from GPU texture or shared memory
    match image.GetFormat() {
        ImageFormat::PLANAR_YCBCR => {
            // Already in YUV format!
            let data = image.GetDataAs::<PlanarYCbCrImage>();
            let y = data.GetYChannel();
            let u = data.GetCbChannel();
            let v = data.GetCrChannel();

            // Encode directly from GPU memory
            self.encode_i420_planes(y, u, v)
        }
        ImageFormat::NV12 => {
            // NV12 can be converted to I420 efficiently
            self.convert_nv12_to_i420_and_encode(image)
        }
        _ => {
            // Fallback to current canvas approach
            Err(NS_ERROR_NOT_IMPLEMENTED)
        }
    }
}
```

## Expected Performance Improvements

### Memory Savings
- **Current:** 4 copies of frame data (Snapshot -> Canvas -> ImageData -> Rust I420)
  - 1280x720 RGBA = 3.6 MB per frame × 4 copies = 14.4 MB per frame
- **Optimized:** 1 copy (VideoFrame -> Rust encoder)
  - 1280x720 I420 = 1.3 MB per frame × 1 copy = 1.3 MB per frame
- **Savings:** 91% reduction in memory bandwidth

### CPU Savings
- **Current:** RGBA->I420 conversion + multiple memcpy operations
  - ~15ms per frame @ 1280x720
- **Optimized:** Direct I420 access
  - ~2ms per frame @ 1280x720
- **Savings:** 85% reduction in CPU time

### Latency Reduction
- **Current:** ~40ms encoding latency (capture + conversion + encode)
- **Optimized:** ~15ms encoding latency (encode only)
- **Savings:** 62% reduction, brings total latency to ~135ms

## Implementation Complexity

### Easy (2-3 days):
- Use MediaStreamTrackProcessor API
- Modify XPCOM interface to accept I420 planes
- Test with existing capture mechanism

### Medium (1-2 weeks):
- Direct VideoFrameContainer integration for video elements
- Handle mixed content (video + overlays)
- Fallback logic for incompatible sources

### Hard (3-4 weeks):
- Zero-copy GPU path using layers::Image
- Thread-safe frame queue management
- Handle all image formats (PLANAR_YCBCR, NV12, RGBA, etc.)

## Similar Implementations in Firefox

### Picture-in-Picture
- Uses WindowGlobalParent::DrawSnapshot() (same as current Cast)
- Could also benefit from VideoFrameContainer approach

### WebRTC
- Uses VideoFrameConverter for format conversion
- Has optimized I420 handling paths
- Reference: dom/media/webrtc/libwebrtcglue/VideoFrameConverter.cpp

### Screen Capture
- DesktopCapturer uses efficient platform APIs
- Reference: dom/media/systemservices/video_engine/desktop_capture_impl.cc

## Next Steps

1. **Prototype Phase 1** - Use WebCodecs MediaStreamTrackProcessor
   - Low risk, well-supported API
   - Immediate performance gains

2. **Benchmark** - Compare canvas vs VideoFrame approach
   - Measure memory usage, CPU time, frame latency

3. **Implement Phase 2** - Direct VideoFrameContainer access
   - Higher performance for video content specifically

4. **Consider Phase 3** - Zero-copy GPU path
   - Maximum performance, but significant engineering effort

## References

- VideoFrameContainer: dom/media/VideoFrameContainer.h
- ImageContainer: gfx/layers/client/ImageContainer.h
- PlanarYCbCrImage: gfx/layers/PlanarYCbCrImage.h
- WebCodecs VideoFrame: https://w3c.github.io/webcodecs/#videoframe-interface
- MediaStreamTrackProcessor: https://w3c.github.io/mediacapture-transform/
