# Phase 2: Direct Video Casting

Research and implementation plan for detecting video elements and casting them directly (instead of tab casting).

## Table of Contents

- [Overview](#overview)
- [Video Detection](#video-detection)
- [Cast Protocol for Different Content](#cast-protocol-for-different-content)
- [Implementation Plan](#implementation-plan)
- [YouTube Special Case](#youtube-special-case)

---

## Overview

### Goals

1. **Detect video elements** on web pages that user wants to cast
2. **Offer direct video casting** instead of tab casting when appropriate
3. **Handle YouTube specially** by launching the YouTube Cast app directly
4. **Fall back to tab casting** if video detection fails

### User Experience

```
User watching YouTube video
  ↓
Clicks Cast button
  ↓
Firefox detects YouTube video
  ↓
Dialog: "Cast this video?" or "Cast this tab?"
  ↓
If video selected → Launch YouTube app with video ID
If tab selected → Use existing tab casting
```

---

## Video Detection

### Inspiration: Firefox Picture-in-Picture

**File:** `toolkit/actors/PictureInPictureChild.sys.mjs:273-286`

Firefox PiP uses this algorithm to find the best video to use:

```javascript
findVideoToPiP(doc) {
  let video = doc.activeElement;
  if (!HTMLVideoElement.isInstance(video)) {
    let listOfVideos = [...doc.querySelectorAll("video")].filter(
      video => !isNaN(video.duration)
    );
    // Get the first non-paused video, otherwise the longest video
    video =
      listOfVideos.filter(v => !v.paused)[0] ||
      listOfVideos.sort((a, b) => b.duration - a.duration)[0];
  }
  return video;
}
```

**Logic:**
1. Check if active element is a `<video>`
2. Query all `<video>` elements in document
3. Filter out videos with invalid duration (NaN)
4. **Prefer**: First non-paused video
5. **Fallback**: Longest video by duration
6. **Reasoning**: Skips preview/sidebar videos

### Fullscreen Detection

User entering fullscreen is a strong signal they want to cast that video.

**Detection:**
```javascript
// Listen for fullscreen changes
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) {
    const elem = document.fullscreenElement;
    if (HTMLVideoElement.isInstance(elem)) {
      // User fullscreened a video!
      // Offer to cast this specific video
    }
  }
});
```

**In our CastTabChild actor:**
```javascript
export class CastTabChild extends JSWindowActorChild {
  actorCreated() {
    this.contentWindow.document.addEventListener('fullscreenchange',
      this.onFullscreenChange.bind(this));
  }

  onFullscreenChange() {
    const elem = this.contentWindow.document.fullscreenElement;
    if (HTMLVideoElement.isInstance(elem)) {
      this.sendAsyncMessage("Cast:VideoFullscreen", {
        videoSrc: elem.currentSrc || elem.src,
        videoUrl: this.contentWindow.location.href,
        duration: elem.duration,
        currentTime: elem.currentTime,
        paused: elem.paused
      });
    }
  }

  getVideoInfo() {
    const doc = this.contentWindow.document;

    // Try active element first
    let video = doc.activeElement;

    if (!HTMLVideoElement.isInstance(video)) {
      // Find all valid videos
      let videos = [...doc.querySelectorAll("video")].filter(
        v => !isNaN(v.duration) && v.duration > 0
      );

      // Prefer playing video, fallback to longest
      video = videos.filter(v => !v.paused)[0] ||
              videos.sort((a, b) => b.duration - a.duration)[0];
    }

    if (!video) {
      return null;
    }

    return {
      src: video.currentSrc || video.src,
      pageUrl: this.contentWindow.location.href,
      duration: video.duration,
      currentTime: video.currentTime,
      paused: video.paused,
      width: video.videoWidth,
      height: video.videoHeight,
      poster: video.poster,
      title: doc.title
    };
  }
}
```

---

## Cast Protocol for Different Content

### Default Media Receiver vs Application-Specific Receivers

**Two approaches to casting:**

1. **Default Media Receiver (CC1AD845)**: Generic player for any media URL
2. **Application-Specific Receivers**: Apps like YouTube, Netflix, etc.

### LOAD Command Structure

Based on Google Cast documentation:

**LOAD Request Format:**
```json
{
  "type": "LOAD",
  "requestId": 123,
  "media": {
    "contentId": "https://example.com/video.mp4",
    "contentType": "video/mp4",
    "streamType": "BUFFERED",
    "duration": 120.5,
    "metadata": {
      "metadataType": 0,
      "title": "My Video",
      "subtitle": "example.com",
      "images": [
        { "url": "https://example.com/thumb.jpg" }
      ]
    }
  },
  "autoplay": true,
  "currentTime": 0
}
```

**Required Fields:**
- `media.contentId` (string): URL or unique identifier
- `media.contentType` (string): MIME type (e.g., "video/mp4", "video/webm")

**Optional Fields:**
- `media.streamType`: "BUFFERED" (VOD) or "LIVE"
- `media.duration`: Length in seconds (for VOD)
- `media.metadata`: Display information
- `autoplay`: Start playing immediately
- `currentTime`: Start position in seconds

**Namespace:** `urn:x-cast:com.google.cast.media`

### Direct Video URL Casting

For a direct video URL (e.g., MP4, WebM file):

```javascript
const loadRequest = {
  type: "LOAD",
  requestId: this.getNextRequestId(),
  media: {
    contentId: videoUrl,  // Direct URL: https://example.com/video.mp4
    contentType: "video/mp4",
    streamType: "BUFFERED",
    duration: videoDuration,
    metadata: {
      metadataType: 0,
      title: pageTitle,
      subtitle: pageHostname,
      images: [{ url: posterUrl }]
    }
  },
  autoplay: true,
  currentTime: videoCurrentTime  // Resume where user was watching
};
```

**File:** `browser/components/cast/modules/CastMediaHandler.sys.mjs`

Our existing `load()` method already supports this! Just need to:
1. Detect the video element
2. Extract URL, duration, currentTime
3. Call `mediaHandler.load(videoUrl, mimeType, "BUFFERED", metadata)`

---

## YouTube Special Case

### Why YouTube is Special

YouTube videos don't expose direct MP4/WebM URLs. Instead, YouTube uses:
- Adaptive streaming (DASH/HLS)
- DRM for some content
- Dynamic URLs that expire
- Multiple quality levels

**Solution:** Use YouTube's own Cast receiver app.

### YouTube Cast App

**App ID:** `233637DE`

**How it works:**
1. Launch YouTube app on Cast device
2. Send video ID (not full URL)
3. YouTube app handles:
   - Quality selection
   - Adaptive streaming
   - Authentication (if signed in)
   - Recommendations/autoplay

### Detecting YouTube Videos

```javascript
function isYouTubeVideo(pageUrl, videoSrc) {
  const url = new URL(pageUrl);

  // Check hostname
  if (!url.hostname.match(/(?:www\.)?youtube\.com/) &&
      !url.hostname.match(/(?:www\.)?youtu\.be/)) {
    return false;
  }

  // Extract video ID
  let videoId = null;

  // youtube.com/watch?v=VIDEO_ID
  if (url.pathname === '/watch') {
    videoId = url.searchParams.get('v');
  }

  // youtu.be/VIDEO_ID
  if (url.hostname.match(/youtu\.be/)) {
    videoId = url.pathname.substring(1);
  }

  // youtube.com/embed/VIDEO_ID
  if (url.pathname.startsWith('/embed/')) {
    videoId = url.pathname.split('/')[2];
  }

  return videoId;
}
```

### YouTube LOAD Message

**Different from generic media!**

For YouTube, we need to:

1. **Launch the YouTube app** (not Default Media Receiver):

```javascript
// LAUNCH command on receiver namespace
const launchPayload = {
  type: "LAUNCH",
  requestId: this.getNextRequestId(),
  appId: "233637DE"  // YouTube app
};

this.castDevice.sendMessage(
  "urn:x-cast:com.google.cast.receiver",
  JSON.stringify(launchPayload)
);
```

2. **Wait for app to launch** (get transportId from RECEIVER_STATUS)

3. **Send YouTube-specific LOAD** on media namespace:

```javascript
const loadPayload = {
  type: "LOAD",
  requestId: this.getNextRequestId(),
  media: {
    contentId: videoId,  // Just "dQw4w9WgXcQ", not full URL!
    contentType: "video/youtube",  // Special content type
    streamType: "BUFFERED",
    metadata: {
      metadataType: 0,
      title: videoTitle
    }
  },
  autoplay: true
};
```

**Note:** Some implementations use a custom namespace for YouTube, but the standard media namespace should work with contentType "video/youtube".

---

## Implementation Plan

### Phase 2A: Generic Video Detection

**Goal:** Detect and cast any HTML5 video with a direct URL.

#### Step 1: Extend CastTabChild Actor

**File:** `browser/components/cast/actors/CastTabChild.sys.mjs`

```javascript
export class CastTabChild extends JSWindowActorChild {
  actorCreated() {
    // Listen for fullscreen changes
    this.contentWindow.document.addEventListener(
      'fullscreenchange',
      this.onFullscreenChange.bind(this)
    );
  }

  onFullscreenChange() {
    const elem = this.contentWindow.document.fullscreenElement;
    if (elem && HTMLVideoElement.isInstance(elem)) {
      const videoInfo = this.extractVideoInfo(elem);
      if (videoInfo) {
        this.sendAsyncMessage("Cast:VideoFullscreen", videoInfo);
      }
    }
  }

  receiveMessage(message) {
    switch (message.name) {
      case "Cast:GetVideoInfo":
        return this.getVideoInfo();
    }
  }

  getVideoInfo() {
    const doc = this.contentWindow.document;

    // Try active element first
    let video = doc.activeElement;

    if (!HTMLVideoElement.isInstance(video)) {
      let videos = [...doc.querySelectorAll("video")].filter(
        v => !isNaN(v.duration) && v.duration > 0
      );

      video = videos.filter(v => !v.paused)[0] ||
              videos.sort((a, b) => b.duration - a.duration)[0];
    }

    if (!video) {
      return null;
    }

    return this.extractVideoInfo(video);
  }

  extractVideoInfo(video) {
    const src = video.currentSrc || video.src;
    if (!src || src.startsWith('blob:')) {
      // Can't cast blob URLs or videos without src
      return null;
    }

    const pageUrl = this.contentWindow.location.href;

    return {
      src,
      pageUrl,
      duration: video.duration,
      currentTime: video.currentTime,
      paused: video.paused,
      width: video.videoWidth,
      height: video.videoHeight,
      poster: video.poster,
      title: this.contentWindow.document.title,
      mimeType: this.guessMimeType(src)
    };
  }

  guessMimeType(src) {
    const url = new URL(src, this.contentWindow.location.href);
    const path = url.pathname.toLowerCase();

    if (path.endsWith('.mp4')) return 'video/mp4';
    if (path.endsWith('.webm')) return 'video/webm';
    if (path.endsWith('.ogg') || path.endsWith('.ogv')) return 'video/ogg';
    if (path.endsWith('.m3u8')) return 'application/x-mpegURL';

    return 'video/mp4';  // Default fallback
  }
}
```

#### Step 2: Update Cast UI

**File:** `browser/components/cast/content/browser-cast.js`

When user clicks Cast button:

```javascript
async openPanel() {
  if (!this._initialized) {
    alert("Cast service not ready. Please try again.");
    return;
  }

  // Check if there's a video on the page
  const browser = gBrowser.selectedBrowser;
  const videoInfo = await browser.browsingContext.currentWindowGlobal
    .getActor("CastTab")
    .sendQuery("Cast:GetVideoInfo");

  if (videoInfo) {
    // Found a video! Offer choice
    this.showVideoOrTabChoice(videoInfo);
  } else {
    // No video, proceed with tab casting
    this.showDeviceList();
  }
}

showVideoOrTabChoice(videoInfo) {
  const isYouTube = this.isYouTubeVideo(videoInfo.pageUrl);

  const videoLabel = isYouTube
    ? "Cast this YouTube video"
    : "Cast this video";

  const items = [
    {
      label: videoLabel,
      tooltip: videoInfo.src,
      callback: () => this.castVideo(videoInfo)
    },
    {
      label: "Cast this tab",
      tooltip: "Stream entire tab to Cast device",
      callback: () => this.showDeviceList()
    }
  ];

  PopupNotifications.show(
    gBrowser.selectedBrowser,
    "cast-video-choice",
    "What would you like to cast?",
    "cast-notification-icon",
    null,
    null,
    {
      popupIconURL: "chrome://browser/skin/cast.svg",
      items
    }
  );
}

async castVideo(videoInfo) {
  // User selected to cast the video directly
  const deviceId = await this.selectDevice();
  if (!deviceId) return;

  try {
    if (this.isYouTubeVideo(videoInfo.pageUrl)) {
      await this._castService.castYouTubeVideo(deviceId, videoInfo);
    } else {
      await this._castService.castVideo(deviceId, videoInfo);
    }
  } catch (ex) {
    console.error("Failed to cast video:", ex);
    alert(`Failed to cast video: ${ex.message}`);
  }
}

isYouTubeVideo(pageUrl) {
  try {
    const url = new URL(pageUrl);
    return url.hostname.match(/(?:www\.)?youtube\.com/) ||
           url.hostname.match(/(?:www\.)?youtu\.be/);
  } catch {
    return false;
  }
}
```

#### Step 3: Add Video Casting Methods

**File:** `browser/components/cast/CastService.sys.mjs`

```javascript
async castVideo(deviceId, videoInfo) {
  const device = this.#devices.get(deviceId);
  if (!device) {
    throw new Error("Device not found");
  }

  // Ensure connected
  if (device.state !== "connected") {
    await device.connect();
  }

  // Launch Default Media Receiver
  await device.launchApp("CC1AD845");  // Default Media Receiver

  // Create media handler
  const mediaHandler = new lazy.CastMediaHandler(device);

  // Prepare metadata
  const metadata = {
    metadataType: 0,
    title: videoInfo.title,
    images: videoInfo.poster ? [{ url: videoInfo.poster }] : []
  };

  // Load the video
  await mediaHandler.load(
    videoInfo.src,
    videoInfo.mimeType,
    "BUFFERED",  // Not LIVE for regular videos
    metadata
  );

  // Optional: Seek to current position if user was already watching
  if (videoInfo.currentTime > 0 && !videoInfo.paused) {
    await mediaHandler.seek(videoInfo.currentTime);
  }

  lazy.logConsole.debug(`Casting video: ${videoInfo.src}`);
}
```

### Phase 2B: YouTube Special Handling

**File:** `browser/components/cast/CastService.sys.mjs`

```javascript
async castYouTubeVideo(deviceId, videoInfo) {
  const device = this.#devices.get(deviceId);
  if (!device) {
    throw new Error("Device not found");
  }

  if (device.state !== "connected") {
    await device.connect();
  }

  // Extract YouTube video ID
  const videoId = this.extractYouTubeVideoId(videoInfo.pageUrl);
  if (!videoId) {
    throw new Error("Could not extract YouTube video ID");
  }

  lazy.logConsole.debug(`Launching YouTube app for video: ${videoId}`);

  // Launch YouTube app (not Default Media Receiver!)
  await device.launchApp("233637DE");  // YouTube app ID

  // Wait for app to be ready (get transportId)
  const transportId = await device._waitForTransportId(5000);
  if (!transportId) {
    throw new Error("YouTube app failed to launch");
  }

  // Create media handler
  const mediaHandler = new lazy.CastMediaHandler(device);

  // Load with YouTube-specific format
  const metadata = {
    metadataType: 0,
    title: videoInfo.title
  };

  // For YouTube, contentId is just the video ID, not full URL
  await mediaHandler.load(
    videoId,              // Just "dQw4w9WgXcQ"
    "video/youtube",      // Special contentType
    "BUFFERED",
    metadata
  );

  lazy.logConsole.debug(`YouTube video loaded: ${videoId}`);
}

extractYouTubeVideoId(pageUrl) {
  try {
    const url = new URL(pageUrl);

    // youtube.com/watch?v=VIDEO_ID
    if (url.pathname === '/watch') {
      return url.searchParams.get('v');
    }

    // youtu.be/VIDEO_ID
    if (url.hostname.match(/youtu\.be/)) {
      return url.pathname.substring(1).split('?')[0];
    }

    // youtube.com/embed/VIDEO_ID
    if (url.pathname.startsWith('/embed/')) {
      return url.pathname.split('/')[2].split('?')[0];
    }

    return null;
  } catch {
    return null;
  }
}
```

**File:** `browser/components/cast/modules/CastDevice.sys.mjs`

Ensure `launchApp()` accepts appId parameter:

```javascript
async launchApp(appId = "CC1AD845") {
  lazy.logConsole.debug(`Launching app: ${appId}`);
  const payload = JSON.stringify({
    type: "LAUNCH",
    requestId: Date.now(),
    appId,
  });

  this.sendMessage("urn:x-cast:com.google.cast.receiver", payload);
  const transportId = await this._waitForTransportId(5000);
  if (transportId) {
    lazy.logConsole.debug(`App launched successfully, transportId: ${transportId}`);
  } else {
    lazy.logConsole.warn(`App launch failed: no transportId received`);
  }
  return { success: true, transportId };
}
```

---

## Testing Plan

### Test Case 1: Generic MP4 Video

1. Navigate to page with `<video src="https://example.com/video.mp4">`
2. Click Cast button
3. Should show: "Cast this video" or "Cast this tab"
4. Select "Cast this video"
5. Video should play on Cast device using Default Media Receiver

### Test Case 2: YouTube Video

1. Navigate to `https://www.youtube.com/watch?v=dQw4w9WgXcQ`
2. Click Cast button
3. Should show: "Cast this YouTube video" or "Cast this tab"
4. Select "Cast this YouTube video"
5. Video should play on Cast device using YouTube app
6. Should show YouTube UI on TV (not web page)

### Test Case 3: Fullscreen Trigger

1. Navigate to page with video
2. Click fullscreen on video player
3. Cast button should highlight or show notification
4. Clicking Cast should default to "Cast this video"

### Test Case 4: No Video Fallback

1. Navigate to page without videos
2. Click Cast button
3. Should directly show device list for tab casting
4. No "Cast this video" option

### Test Case 5: Blob URL (Unsupported)

1. Navigate to site with blob: video source
2. Click Cast button
3. Should fall back to tab casting only
4. No video option (blob URLs can't be cast directly)

---

## Future Enhancements

### Phase 2C: Additional Platform Support

- **Netflix**: App ID `CA5E8412`, requires authentication
- **Spotify**: App ID `CC32E753`, music casting
- **Twitch**: App ID `2A08E863`
- **Vimeo**: May work with Default Media Receiver

### Phase 2D: Advanced Features

- **Resume playback**: Remember position when recasting
- **Playlist support**: Queue multiple videos
- **Quality selection**: Let user choose resolution
- **Subtitle/CC**: Cast text tracks
- **Video trimming**: Cast only portion of video

---

## References

- [Google Cast Developer Documentation](https://developers.google.com/cast)
- [MediaInfo API Reference](https://developers.google.com/cast/docs/reference/web_sender/chrome.cast.media.MediaInfo)
- [LoadRequest API Reference](https://developers.google.com/cast/docs/reference/web_sender/chrome.cast.media.LoadRequest)
- [Firefox Picture-in-Picture Implementation](https://searchfox.org/mozilla-central/source/toolkit/actors/PictureInPictureChild.sys.mjs)
- [castv2-youtube GitHub](https://github.com/xat/castv2-youtube)
- [ytcast GitHub](https://github.com/MarcoLucidi01/ytcast)
