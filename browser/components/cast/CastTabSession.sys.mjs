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

export class CastTabSession {
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
  }

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

      const maxWidth = 1280;
      const maxHeight = 720;
      let canvasWidth = this.width;
      let canvasHeight = this.height;

      if (canvasWidth > maxWidth || canvasHeight > maxHeight) {
        const widthRatio = maxWidth / canvasWidth;
        const heightRatio = maxHeight / canvasHeight;
        const scaleRatio = Math.min(widthRatio, heightRatio);
        canvasWidth = Math.floor(canvasWidth * scaleRatio);
        canvasHeight = Math.floor(canvasHeight * scaleRatio);
        lazy.logConsole.debug(
          `Scaling down from ${this.width}x${this.height} to ${canvasWidth}x${canvasHeight}`
        );
      }

      this.canvas = this.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "canvas"
      );
      this.canvas.width = canvasWidth;
      this.canvas.height = canvasHeight;
      this.ctx = this.canvas.getContext("2d", {
        alpha: false,
        willReadFrequently: false,
      });

      const fps = options.fps || 15;
      const videoBitsPerSecond = options.bitrate || 2500000;

      lazy.logConsole.debug(
        `Canvas ${canvasWidth}x${canvasHeight} @ ${fps}fps, ${Math.floor(videoBitsPerSecond / 1000)}kbps`
      );

      this.mediaStream = this.canvas.captureStream(fps);

      this.mediaRecorder = new this.window.MediaRecorder(this.mediaStream, {
        mimeType: "video/webm;codecs=vp8",
        videoBitsPerSecond,
      });

      this.mediaRecorder.ondataavailable = event => {
        if (event.data && event.data.size > 0 && this.streamConnection) {
          event.data.arrayBuffer().then(buffer => {
            try {
              const data = new Uint8Array(buffer);
              this.writeChunk(this.streamConnection.outputStream, data);
            } catch (e) {
              lazy.logConsole.error("Error writing chunk:", e);
            }
          });
        }
      };

      this.mediaRecorder.onerror = event => {
        lazy.logConsole.error("MediaRecorder error:", event);
        this.setState("error");
      };

      this.mediaRecorder.start(100);

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
        `Stream URL: ${streamURL} (using ${hostname ? "system hostname" : "fallback IP"})`
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
      await this.mediaHandler.load(streamURL, "video/webm", "LIVE", metadata);

      const intervalMs = 1000 / fps;
      this.captureInterval = this.window.setInterval(() => {
        const now = Date.now();
        if (now - this.lastCaptureTime < intervalMs * 0.9) {
          return;
        }

        if (this.window.requestIdleCallback) {
          this.window.requestIdleCallback(
            () => this.captureFrame(),
            { timeout: intervalMs / 2 }
          );
        } else {
          this.captureFrame();
        }
      }, intervalMs);

      lazy.logConsole.debug("Started optimized capture loop");

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

  handleStreamRequest(connection) {
    try {
      lazy.logConsole.debug("Stream connection established");

      const headers =
        "HTTP/1.1 200 OK\r\n" +
        "Content-Type: video/webm\r\n" +
        "Cache-Control: no-cache, no-store, must-revalidate\r\n" +
        "Connection: keep-alive\r\n" +
        "Transfer-Encoding: chunked\r\n" +
        "Access-Control-Allow-Origin: *\r\n" +
        "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n" +
        "Access-Control-Allow-Headers: Content-Type, Range\r\n" +
        "Access-Control-Expose-Headers: Content-Length, Content-Range\r\n" +
        "\r\n";

      connection.outputStream.write(headers, headers.length);

      this.streamConnection = connection;
      lazy.logConsole.debug("Ready to stream MediaRecorder chunks");
    } catch (e) {
      lazy.logConsole.error("Error in handleStreamRequest:", e);
      if (this.server) {
        this.server.closeConnection(connection);
      }
    }
  }

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
  }

  async captureFrame() {
    if (!this.canvas || !this.ctx || !this.browser) {
      return;
    }

    if (this.isCapturing) {
      return;
    }

    this.isCapturing = true;

    try {
      const browsingContext = this.browser.browsingContext;
      if (!browsingContext) {
        this.isCapturing = false;
        return;
      }

      const scale =
        browsingContext.overrideDPPX || this.window.devicePixelRatio || 1;

      let scrollX = 0;
      let scrollY = 0;

      try {
        const actor =
          this.browser.browsingContext.currentWindowGlobal.getActor("CastTab");
        const viewportInfo = await actor.getViewportInfo();
        if (viewportInfo) {
          scrollX = viewportInfo.scrollX || 0;
          scrollY = viewportInfo.scrollY || 0;
        }
      } catch (e) {
        lazy.logConsole.error("Failed to get viewport info:", e);
      }

      const rect = new DOMRect(scrollX, scrollY, this.width, this.height);
      const snapshot = await browsingContext.currentWindowGlobal.drawSnapshot(
        rect,
        scale,
        "rgb(255, 255, 255)"
      );

      this.ctx.drawImage(snapshot, 0, 0, this.canvas.width, this.canvas.height);
      snapshot.close();

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
      this.window.clearInterval(this.captureInterval);
      this.captureInterval = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      try {
        lazy.logConsole.debug("Stopping MediaRecorder");
        this.mediaRecorder.stop();
      } catch (e) {
        lazy.logConsole.error("Error stopping MediaRecorder:", e);
      }
    }
    this.mediaRecorder = null;

    if (this.mediaStream) {
      try {
        lazy.logConsole.debug("Stopping media stream tracks");
        this.mediaStream.getTracks().forEach(track => track.stop());
      } catch (e) {
        lazy.logConsole.error("Error stopping media stream:", e);
      }
      this.mediaStream = null;
    }

    this.canvas = null;
    this.ctx = null;

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
        if (status?.idleReason === "ERROR") {
          lazy.logConsole.error("Media playback error");
          this.setState("error");
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
