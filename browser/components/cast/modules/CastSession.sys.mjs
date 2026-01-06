/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SimpleHTTPServer } from "resource:///modules/cast/SimpleHTTPServer.sys.mjs";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "logConsole", function () {
  return console.createInstance({
    prefix: "Cast:TabSession",
    maxLogLevel: Services.prefs.getBoolPref("browser.cast.log", false)
      ? "Debug"
      : "Warn",
  });
});

ChromeUtils.defineESModuleGetters(lazy, {
  CastMediaHandler: "resource:///modules/cast/CastMediaHandler.sys.mjs",
});

/**
 * Manages tab casting to a Cast device.
 * Handles screen capture, VP9 encoding, HTTP streaming, and media session coordination.
 */
export class CastSession {
  constructor(castDevice, window) {
    this.castDevice = castDevice;
    this.window = window;
    this.document = window.document;
    this.server = null;
    this.mediaHandler = null;
    this.state = "idle";
    this.browser = null;
    this.streamConnection = null;
    this.tabCloseListener = null;
    this.mediaRecorder = null;
    this.mediaStream = null;
    this.canvas = null;
    this.ctx = null;
    this.captureInterval = null;
    this.width = 0;
    this.height = 0;
    this.isCapturing = false;
    this.lastCaptureTime = 0;
    this._pendingFrames = 0;
    this._droppedFrames = 0;
    this._playbackStarted = false;
    this._measuredLagMs = 0;
    this._forceKeyframe = false;
    this._lastReceiverTime = 0;
    this._lastReceiverUpdate = 0;
    this._receiverBuffering = false;
    this._lastEncodedTimestamp = 0;
    this._playbackStartedTime = 0;
    this._initialLagMs = 0;

    this._audioEncoder = null;
    this._audioCaptureActor = null;
    this._audioEnabled = true;
    this._droppedAudioFrames = 0;
    this._audioFrameCount = 0;

    // Audio buffer for synchronized muxing
    this._audioBuffer = [];
    this._audioSamplesSent = 0;
    this._audioInitialized = false;

    // Centralized encoding state - when paused, neither audio nor video is sent
    this._encodingPaused = false;
  }

  /**
   * Start casting the tab to the Cast device.
   *
   * @param {object} browser The browser element containing the tab to cast
   * @param {object} options Configuration options (fps, bitrate)
   */
  async start(browser, options = {}) {
    if (this.state !== "idle") {
      lazy.logConsole.warn(`Cannot start session in state: ${this.state}`);
      throw new Error(`Cannot start session in state: ${this.state}`);
    }

    this.browser = browser;
    this.setState("starting");

    try {
      lazy.logConsole.debug("Setting up optimized canvas capture for tab");

      this.width = browser.clientWidth || 1280;
      this.height = browser.clientHeight || 720;

      const minWidth = 1280;
      const minHeight = 720;
      const maxWidth = 1920;
      const maxHeight = 1080;
      let canvasWidth = this.width;
      let canvasHeight = this.height;

      lazy.logConsole.debug(
        `Browser size: ${this.width}x${this.height}, devicePixelRatio: ${this.window.devicePixelRatio}`
      );

      // Scale UP if below minimum (ensures at least 720p quality)
      if (canvasWidth < minWidth || canvasHeight < minHeight) {
        const widthRatio = minWidth / canvasWidth;
        const heightRatio = minHeight / canvasHeight;
        const scaleRatio = Math.max(widthRatio, heightRatio);
        canvasWidth = Math.floor(canvasWidth * scaleRatio);
        canvasHeight = Math.floor(canvasHeight * scaleRatio);
        lazy.logConsole.debug(
          `Scaling UP from ${this.width}x${this.height} to ${canvasWidth}x${canvasHeight} (minimum 720p)`
        );
      }

      // Scale DOWN if above maximum
      if (canvasWidth > maxWidth || canvasHeight > maxHeight) {
        const widthRatio = maxWidth / canvasWidth;
        const heightRatio = maxHeight / canvasHeight;
        const scaleRatio = Math.min(widthRatio, heightRatio);
        canvasWidth = Math.floor(canvasWidth * scaleRatio);
        canvasHeight = Math.floor(canvasHeight * scaleRatio);
        lazy.logConsole.debug(
          `Scaling DOWN from ${this.width}x${this.height} to ${canvasWidth}x${canvasHeight}`
        );
      }

      // VP8/VP9 require even dimensions for I420 chroma subsampling
      canvasWidth = canvasWidth & ~1;
      canvasHeight = canvasHeight & ~1;

      this.canvas = this.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "canvas"
      );
      this.canvas.width = canvasWidth;
      this.canvas.height = canvasHeight;
      this.ctx = this.canvas.getContext("2d", {
        alpha: false,
        willReadFrequently: true,
      });

      this.fps = options.fps || 60;
      this.bitrate = options.bitrate || 25000000;

      lazy.logConsole.debug(
        `Canvas ${canvasWidth}x${canvasHeight} @ ${this.fps}fps, ${Math.floor(this.bitrate / 1000)}kbps`
      );

      this._encoder = Cc["@mozilla.org/cast/video-encoder;1"].createInstance(
        Ci.nsICastVideoEncoder
      );

      if (this._audioEnabled) {
        this._audioEncoder = Cc[
          "@mozilla.org/cast/audio-encoder;1"
        ].createInstance(Ci.nsICastAudioEncoder);
        const audioBitrate = 128000;
        const audioSampleRate = 48000;
        const audioChannels = 2;
        this._audioEncoder.init(audioSampleRate, audioChannels, audioBitrate);

        const preskip = this._audioEncoder.lookahead;
        this._encoder.initWithAudio(
          canvasWidth,
          canvasHeight,
          this.bitrate,
          this.fps,
          audioChannels,
          audioSampleRate,
          preskip
        );

        lazy.logConsole.debug(
          `Audio encoder initialized: ${audioChannels}ch@${audioSampleRate}Hz, preskip=${preskip}`
        );
      } else {
        this._encoder.init(
          canvasWidth,
          canvasHeight,
          this.bitrate,
          this.fps
        );
      }

      this._webmHeader = this._encoder.getHeader();
      this._frameCount = 0;
      this._encodingStarted = false;
      this._streamStartTime = null;

      lazy.logConsole.debug(
        `Rust encoder initialized, WebM header: ${this._webmHeader.length} bytes`
      );

      this.server = new SimpleHTTPServer();
      this.server.registerPathHandler("/stream.webm", connection => {
        this.handleStreamRequest(connection);
      });
      const port = this.server.start(8010);

      const hostname = this.server.getLocalHostname();
      const streamURL = hostname
        ? `http://${hostname}:${port}/stream.webm`
        : `http://${this.server.getLocalIP(this.castDevice.address)}:${port}/stream.webm`;

      lazy.logConsole.debug(
        `Stream URL: ${streamURL} (using ${hostname ? "hostname" : "IP"})`
      );

      const gBrowser = this.window.gBrowser;
      this.tabCloseListener = event => {
        const tab = event.target;
        if (tab.linkedBrowser === this.browser) {
          lazy.logConsole.debug("Tab closing, stopping cast");
          this.stop();
        }
      };
      gBrowser.tabContainer.addEventListener("TabClose", this.tabCloseListener);

      this.mediaHandler = new lazy.CastMediaHandler(this.castDevice);

      this.castDevice.addEventListener("message", ({ namespace, payload }) => {
        if (namespace === lazy.CastMediaHandler.NAMESPACE) {
          this.handleMediaMessage(JSON.stringify(payload));
        }
      });

      const metadata = {
        metadataType: 0,
        title: "Firefox Tab Cast",
      };
      await this.mediaHandler.load(
        streamURL,
        "video/webm",
        "LIVE",
        metadata,
        true
      );

      lazy.logConsole.debug(
        "Media LOAD sent to Cast device. Waiting for MEDIA_STATUS response..."
      );

      this.setState("streaming");

      return {
        streamURL,
        state: this.state,
      };
    } catch (error) {
      lazy.logConsole.error("Error starting session:", error);
      this.setState("error");
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Handle HTTP request from Cast device for video stream.
   * Sends WebM header and starts frame encoding once ready.
   *
   * @param {object} connection HTTP connection object with input/output streams
   */
  handleStreamRequest(connection) {
    try {
      const connectTime = Date.now();
      lazy.logConsole.debug(
        `Cast device connected to stream at ${connectTime}`
      );

      const headers =
        "HTTP/1.1 200 OK\r\n" +
        "Content-Type: video/webm\r\n" +
        "Cache-Control: no-cache, no-store, must-revalidate, max-age=0\r\n" +
        "Pragma: no-cache\r\n" +
        "Expires: 0\r\n" +
        "Connection: keep-alive\r\n" +
        "Transfer-Encoding: chunked\r\n" +
        "Access-Control-Allow-Origin: *\r\n" +
        "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n" +
        "Access-Control-Allow-Headers: Content-Type, Range\r\n" +
        "Access-Control-Expose-Headers: Content-Length, Content-Range\r\n" +
        "\r\n";

      connection.outputStream.write(headers, headers.length);

      if (this._webmHeader && this._webmHeader.length) {
        lazy.logConsole.debug(
          `Sending WebM header: ${this._webmHeader.length} bytes`
        );
        this.writeChunk(connection.outputStream, this._webmHeader);
      }

      this.streamConnection = connection;
      this._frameCount = 0;

      lazy.logConsole.debug(
        "Cast device connected, starting capture immediately"
      );
      this.startCaptureLoop();
    } catch (e) {
      lazy.logConsole.error("Error in handleStreamRequest:", e);
      if (this.server) {
        this.server.closeConnection(connection);
      }
    }
  }

  /**
   * Write data as HTTP chunked transfer encoding.
   *
   * @param {nsIOutputStream} outputStream HTTP output stream
   * @param {Array<number>} data Byte array to send
   */
  writeChunk(outputStream, data) {
    const chunkSize = data.length.toString(16);
    const chunkHeader = `${chunkSize}\r\n`;

    outputStream.write(chunkHeader, chunkHeader.length);

    const binaryStream = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(
      Ci.nsIBinaryOutputStream
    );
    binaryStream.setOutputStream(outputStream);
    binaryStream.writeByteArray(data);

    const chunkFooter = "\r\n";
    outputStream.write(chunkFooter, chunkFooter.length);
    outputStream.flush();

    if (this._pendingFrames > 0) {
      this._pendingFrames--;
    }
  }

  startCaptureLoop() {
    if (this._encodingStarted) {
      lazy.logConsole.warn(
        "startCaptureLoop called but encoding already started!"
      );
      return;
    }

    this._encodingStarted = true;
    this._streamStartTime = Date.now();
    this._nextFrameTime = this._streamStartTime;
    lazy.logConsole.debug(
      `Both stream connection and MEDIA_STATUS ready! Starting capture at: ${this._streamStartTime}`
    );

    lazy.logConsole.debug(
      `Audio enabled: ${this._audioEnabled}, encoder: ${!!this._audioEncoder}`
    );
    if (this._audioEnabled && this._audioEncoder) {
      lazy.logConsole.debug("Starting audio capture...");
      this.startAudioCapture();
    } else {
      lazy.logConsole.warn("Audio capture NOT started - disabled or no encoder");
    }

    const intervalMs = 1000 / this.fps;
    lazy.logConsole.debug(
      `Started capture loop at ${this.fps} FPS (interval: ${intervalMs}ms)`
    );

    const captureLoop = async () => {
      if (!this._encodingStarted || !this.canvas) {
        return;
      }

      const now = Date.now();

      if (now >= this._nextFrameTime) {
        await this.captureFrame();
        this._nextFrameTime += intervalMs;
      }

      if (this._encodingStarted) {
        this.captureInterval = this.window.requestAnimationFrame(captureLoop);
      }
    };

    this.captureInterval = this.window.requestAnimationFrame(captureLoop);
  }

  async startAudioCapture() {
    lazy.logConsole.debug("startAudioCapture: Beginning audio capture setup");
    try {
      // Enable audioCapture media source and bypass permission prompts
      Services.prefs.setBoolPref(
        "media.getusermedia.audio.capture.enabled",
        true
      );
      Services.prefs.setBoolPref("media.navigator.permission.disabled", true);

      const windowGlobal = this.browser.browsingContext?.currentWindowGlobal;
      if (!windowGlobal) {
        lazy.logConsole.warn("No currentWindowGlobal for audio capture");
        return;
      }

      lazy.logConsole.debug("startAudioCapture: Getting CastAudioCapture actor");
      this._audioCaptureActor = windowGlobal.getActor("CastAudioCapture");
      this._audioCaptureActor.setAudioCallback(samples => {
        this.handleAudioData(samples);
      });

      lazy.logConsole.debug("startAudioCapture: Sending Start query");
      const result = await this._audioCaptureActor.sendQuery(
        "CastAudioCapture:Start"
      );

      if (!result.success) {
        lazy.logConsole.error("Failed to start audio capture:", result.error);
        this._audioCaptureActor = null;
        return;
      }

      lazy.logConsole.debug(
        `Audio capture started: ${result.sampleRate}Hz, callback set: ${!!this._audioCaptureActor}`
      );
    } catch (e) {
      lazy.logConsole.error("Failed to start audio capture:", e);
      this._audioCaptureActor = null;
    }
  }

  handleAudioData(samples) {
    if (!this._streamStartTime) {
      return;
    }

    this._audioBuffer.push({
      samples: new Float32Array(samples),
    });

    this._audioFrameCount++;
    if (this._audioFrameCount % 100 === 1) {
      lazy.logConsole.debug(
        `Audio received: frame ${this._audioFrameCount}, buffer size ${this._audioBuffer.length}, samples ${samples.length}`
      );
    }
  }

  processBufferedAudio(videoTimestampMs) {
    if (!this._audioEncoder || !this._encoder || !this.streamConnection) {
      lazy.logConsole.warn("processBufferedAudio: missing encoder or connection");
      return;
    }

    const OPUS_FRAME_SAMPLES = 960;
    const SAMPLE_RATE = 48000;

    // Initialize audio time to match video on first call
    if (!this._audioInitialized) {
      this._audioSamplesSent = Math.floor((videoTimestampMs / 1000) * SAMPLE_RATE);
      this._audioInitialized = true;
      lazy.logConsole.debug(
        `Audio initialized at ${videoTimestampMs}ms (${this._audioSamplesSent} samples)`
      );
    }

    // If no audio buffered, send silent frame to keep stream flowing
    if (this._audioBuffer.length === 0) {
      this.sendAudioFrame(null, OPUS_FRAME_SAMPLES, SAMPLE_RATE);
      return;
    }

    // Process all buffered audio with monotonic timestamps
    const bufferSize = this._audioBuffer.length;
    while (this._audioBuffer.length) {
      const audioChunk = this._audioBuffer.shift();
      this.sendAudioFrame(audioChunk.samples, OPUS_FRAME_SAMPLES, SAMPLE_RATE);
    }
    if (this._frameCount % 60 === 0) {
      lazy.logConsole.debug(`Processed ${bufferSize} audio chunks at video ts ${videoTimestampMs}ms`);
    }
  }

  sendAudioFrame(samples, frameSamples, sampleRate) {
    if (!this._audioEncoder || !this._encoder || !this.streamConnection) {
      return;
    }

    try {
      // Calculate timestamp from samples sent (monotonic)
      const timestampMs = (this._audioSamplesSent / sampleRate) * 1000;

      // Use provided samples or create silence
      let pcmBytes;
      if (samples) {
        pcmBytes = new Uint8Array(samples.buffer);
      } else {
        const silentPcm = new Float32Array(frameSamples * 2);
        pcmBytes = new Uint8Array(silentPcm.buffer);
      }

      const opusData = this._audioEncoder.encodeFrame(
        Array.from(pcmBytes),
        timestampMs
      );

      if (opusData && opusData.length) {
        const webmCluster = this._encoder.writeAudioFrame(
          opusData,
          timestampMs,
          frameSamples
        );

        if (webmCluster && webmCluster.length) {
          this.writeChunk(this.streamConnection.outputStream, webmCluster);
          if (this._audioSamplesSent % (sampleRate * 2) < frameSamples) {
            lazy.logConsole.debug(
              `Audio sent: ts=${timestampMs.toFixed(0)}ms, opus=${opusData.length}B, cluster=${webmCluster.length}B`
            );
          }
        }

        // Increment samples sent for next frame's timestamp
        this._audioSamplesSent += frameSamples;
      } else if (this._audioSamplesSent === 0) {
        lazy.logConsole.warn("Audio encode returned empty data");
      }
    } catch (e) {
      lazy.logConsole.error("Error encoding audio:", e);
    }
  }

  sendSilentAudioFrame() {
    const OPUS_FRAME_SAMPLES = 960;
    const SAMPLE_RATE = 48000;
    this.sendAudioFrame(null, OPUS_FRAME_SAMPLES, SAMPLE_RATE);
  }

  onPlaybackStarted(castCurrentTime) {
    this._lastReceiverTime = castCurrentTime;
    this._lastReceiverUpdate = Date.now();

    if (this._playbackStarted) {
      return;
    }

    this._playbackStarted = true;
    this._playbackStartedTime = Date.now();
    const streamElapsedSec = (Date.now() - this._streamStartTime) / 1000;
    const lagSec = streamElapsedSec - castCurrentTime;

    lazy.logConsole.debug(
      `Cast PLAYING: currentTime=${castCurrentTime.toFixed(2)}s, ` +
        `stream=${streamElapsedSec.toFixed(2)}s, startup lag=${lagSec.toFixed(2)}s`
    );

    // If we have significant startup lag, reinitialize the encoder
    // This creates a timestamp discontinuity that should make the receiver skip ahead
    if (lagSec > 1 && this._encoder) {
      lazy.logConsole.debug(
        `Reinitializing encoder to skip ${lagSec.toFixed(1)}s startup lag`
      );
      this._encoder.init(
        this.canvas.width,
        this.canvas.height,
        this.bitrate,
        this.fps
      );
      this._streamStartTime = Date.now();
      this._lastEncodedTimestamp = 0;
      this._forceKeyframe = true;
    }

    this._measuredLagMs = 0;
    this._initialLagMs = 0;
  }

  updateReceiverTime(castCurrentTime) {
    this._lastReceiverTime = castCurrentTime;
    this._lastReceiverUpdate = Date.now();
  }

  getEstimatedReceiverTime() {
    if (!this._lastReceiverUpdate) {
      return 0;
    }
    const elapsed = (Date.now() - this._lastReceiverUpdate) / 1000;
    return this._lastReceiverTime + elapsed;
  }

  getMeasuredLag() {
    return this._measuredLagMs || 0;
  }

  isAheadOfReceiver(maxLagMs) {
    if (!this._streamStartTime) {
      return false;
    }
    const timestampMs = Date.now() - this._streamStartTime;
    const receiverTimeMs = this.getEstimatedReceiverTime() * 1000;
    return timestampMs - receiverTimeMs > maxLagMs;
  }

  async captureFrame() {
    if (!this.browser || !this._encoder || !this.canvas) {
      return;
    }

    if (this.isCapturing) {
      return;
    }

    // Lag reduction: if lag has grown too much, resync by adjusting our clock to receiver's position
    // This effectively "skips" the accumulated lag and starts fresh
    const gracePeriodMs = 4000;
    const maxLagGrowthMs = 1000;
    if (
      this._playbackStartedTime &&
      Date.now() - this._playbackStartedTime > gracePeriodMs &&
      this._lastReceiverUpdate &&
      this._initialLagMs !== undefined
    ) {
      const receiverTimeMs = this.getEstimatedReceiverTime() * 1000;
      const currentLagMs = (Date.now() - this._streamStartTime) - receiverTimeMs;
      const lagGrowthMs = currentLagMs - this._initialLagMs;

      if (lagGrowthMs > maxLagGrowthMs) {
        // Hard reset: reinitialize encoder to reset timestamp state
        // This allows timestamps to start fresh from 0
        lazy.logConsole.debug(
          `Lag grew by ${lagGrowthMs.toFixed(0)}ms - reinitializing encoder to catch up`
        );

        // Reinitialize encoder (clears internal timestamp tracking)
        this._encoder.init(this.canvas.width, this.canvas.height, this.bitrate, this.fps);

        // Reset our timestamp tracking to start fresh
        this._streamStartTime = Date.now();
        this._lastEncodedTimestamp = 0;
        this._initialLagMs = 0;
        this._forceKeyframe = true;
        this._playbackStartedTime = Date.now(); // Reset grace period
      }
    }

    // Centralized pause check - affects both audio and video
    if (this._playbackStarted) {
      const shouldPause =
        this._receiverBuffering || this.isAheadOfReceiver(1000);

      if (shouldPause && !this._encodingPaused) {
        // Transitioning to paused - clear audio buffer so we start fresh
        this._encodingPaused = true;
        this._audioBuffer = [];
        lazy.logConsole.debug("Encoding paused (buffering/lag)");
      } else if (!shouldPause && this._encodingPaused) {
        // Transitioning to unpaused
        this._encodingPaused = false;
        this._forceKeyframe = true;
        lazy.logConsole.debug("Encoding resumed");
      }
 
      if (this._encodingPaused) {
         this._droppedFrames++;
        // Still send silent audio to keep Cast device happy
        if (this._audioEnabled && this._audioInitialized) {
          this.sendSilentAudioFrame();
         }
         return;
      }
    }

    this.isCapturing = true;

    try {
      const browsingContext = this.browser.browsingContext;
      if (!browsingContext) {
        this.isCapturing = false;
        return;
      }

      const scale = 1;
      const flags =
        browsingContext.currentWindowGlobal.DRAWSNAPSHOT_DRAW_CARET |
        browsingContext.currentWindowGlobal.DRAWSNAPSHOT_USE_WIDGET_LAYERS;
      const snapshot = await browsingContext.currentWindowGlobal.drawSnapshot(
        null,
        scale,
        "rgb(255, 255, 255)",
        flags
      );

      if (!this.ctx) {
        this.ctx = this.canvas.getContext("2d", {
          alpha: false,
          willReadFrequently: true,
        });
      }

      this.ctx.drawImage(snapshot, 0, 0, this.canvas.width, this.canvas.height);
      snapshot.close();

      const imageData = this.ctx.getImageData(
        0,
        0,
        this.canvas.width,
        this.canvas.height
      );
      const rgbaData = new Uint8Array(imageData.data.buffer);

      const now = Date.now();
      let timestampMs = now - this._streamStartTime;

      // VP8 encoder requires monotonically increasing timestamps
      if (timestampMs <= this._lastEncodedTimestamp) {
        timestampMs = this._lastEncodedTimestamp + 1;
      }
      this._lastEncodedTimestamp = timestampMs;

      const forceKeyframe =
        this._forceKeyframe || this._frameCount % (this.fps * 5) === 0;
      this._forceKeyframe = false;

      if (this._frameCount % 60 === 0) {
        lazy.logConsole.debug(
          `Frame ${this._frameCount}: timestamp=${timestampMs}ms, keyframe=${forceKeyframe}`
        );
      }

      const webmCluster = this._encoder.encodeFrame(
        rgbaData,
        forceKeyframe,
        timestampMs
      );

      if (this.streamConnection && webmCluster && webmCluster.length) {
        if (this._pendingFrames > 60) {
          this._droppedFrames++;
          if (this._droppedFrames % 30 === 1) {
            lazy.logConsole.warn(
              `Dropped ${this._droppedFrames} frames, pending: ${this._pendingFrames}`
            );
          }
        } else {
          this._pendingFrames++;
          this.writeChunk(this.streamConnection.outputStream, webmCluster);

          // Process buffered audio with video timestamp for sync
          if (this._audioEnabled) {
            this.processBufferedAudio(timestampMs);
          }
        }
      }

      this._frameCount++;
      this.lastCaptureTime = Date.now();
    } catch (e) {
      lazy.logConsole.error("Error capturing frame:", e);
    } finally {
      this.isCapturing = false;
    }
  }

  async stop() {
    if (this.state === "idle") {
      lazy.logConsole.debug("stop: already idle");
      return;
    }

    lazy.logConsole.debug("Stopping tab session");
    this.setState("stopping");

    try {
      if (this.mediaHandler) {
        await this.mediaHandler.stop();
      }
    } catch (e) {
      lazy.logConsole.error("Error stopping media:", e);
    }

    await this.cleanup();
    this.setState("idle");
    lazy.logConsole.debug("Tab session stopped");
  }

  async cleanup() {
    if (this.captureInterval) {
      this.window.cancelAnimationFrame(this.captureInterval);
      this.captureInterval = null;
    }

    if (this._audioCaptureActor) {
      try {
        lazy.logConsole.debug("Stopping audio capture");
        this._audioCaptureActor.sendAsyncMessage("CastAudioCapture:Stop");
      } catch (e) {
        lazy.logConsole.error("Error stopping audio capture:", e);
      }
      this._audioCaptureActor = null;
    }

    if (this._audioEncoder) {
      try {
        lazy.logConsole.debug("Shutting down audio encoder");
        this._audioEncoder.shutdown();
      } catch (e) {
        lazy.logConsole.error("Error shutting down audio encoder:", e);
      }
      this._audioEncoder = null;
    }

    if (this._encoder) {
      try {
        lazy.logConsole.debug("Shutting down encoder");
        this._encoder.shutdown();
      } catch (e) {
        lazy.logConsole.error("Error shutting down encoder:", e);
      }
      this._encoder = null;
    }

    this.canvas = null;
    this.ctx = null;
    this._webmHeader = null;
    this._frameCount = 0;
    this._encodingStarted = false;
    this._streamStartTime = null;
    this._playbackStarted = false;
    this._measuredLagMs = 0;
    this._forceKeyframe = false;
    this._lastReceiverTime = 0;
    this._lastReceiverUpdate = 0;
    this._receiverBuffering = false;
    this._lastEncodedTimestamp = 0;
    this._playbackStartedTime = 0;
    this._initialLagMs = 0;
    this._droppedAudioFrames = 0;
    this._audioBuffer = [];
    this._audioFrameCount = 0;
    this._audioSamplesSent = 0;
    this._audioInitialized = false;
    this._encodingPaused = false;

    if (this.tabCloseListener) {
      try {
        const gBrowser = this.window.gBrowser;
        gBrowser.tabContainer.removeEventListener(
          "TabClose",
          this.tabCloseListener
        );
      } catch (e) {
        lazy.logConsole.error("Error removing tab close listener:", e);
      }
      this.tabCloseListener = null;
    }

    if (this.streamConnection && this.server) {
      try {
        this.server.closeConnection(this.streamConnection);
      } catch (e) {
        lazy.logConsole.error("Error closing stream connection:", e);
      }
      this.streamConnection = null;
    }

    if (this.server) {
      this.server.stop();
      this.server = null;
    }

    if (this.mediaHandler) {
      this.mediaHandler.reset();
      this.mediaHandler = null;
    }

    this.browser = null;
  }

  handleMediaMessage(payload) {
    if (!this.mediaHandler) {
      return;
    }

    try {
      const message = JSON.parse(payload);

      if (message.type === "MEDIA_STATUS") {
        const status = this.mediaHandler.handleMediaStatus(payload);
        lazy.logConsole.debug(
          `MEDIA_STATUS: playerState=${status?.playerState}, currentTime=${status?.currentTime?.toFixed(2)}`
        );

        if (status?.idleReason === "ERROR") {
          lazy.logConsole.error("Media playback error");
          this.setState("error");
        }

        if (status?.playerState === "BUFFERING") {
          this._receiverBuffering = true;
        } else if (status?.playerState === "PLAYING") {
          this._receiverBuffering = false;
          if (this._streamStartTime) {
            if (!this._playbackStarted) {
              this.onPlaybackStarted(status.currentTime || 0);
            } else {
              this.updateReceiverTime(status.currentTime || 0);
            }
          }
        }
      } else if (message.type === "LOAD_FAILED") {
        lazy.logConsole.error("LOAD_FAILED:", message);
        this.setState("error");
      } else if (message.type === "LOAD_CANCELLED") {
        lazy.logConsole.debug("LOAD_CANCELLED");
        this.setState("idle");
      }
    } catch (e) {
      lazy.logConsole.error("Error handling media message:", e);
    }
  }

  setState(newState) {
    this.state = newState;
  }

  getState() {
    return this.state;
  }

  isActive() {
    return this.state === "streaming" || this.state === "starting";
  }
}
