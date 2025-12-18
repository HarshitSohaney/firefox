import {
  setInterval,
  clearInterval,
} from "resource://gre/modules/Timer.sys.mjs";
import { SimpleHTTPServer } from "resource:///modules/cast/SimpleHTTPServer.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CastMediaHandler: "resource:///modules/cast/CastMediaHandler.sys.mjs",
});

export class CastTabSession {
  constructor(castDevice, window) {
    this.castDevice = castDevice;
    this.window = window;
    this.document = window.document;
    this.encoder = null;
    this.server = null;
    this.mediaHandler = null;
    this.mediaStream = null;
    this.state = "idle";
    this.browser = null;
    this.videoElement = null;
    this.canvas = null;
    this.ctx = null;
    this.captureInterval = null;
    this.streamConnection = null;
    this.width = 0;
    this.height = 0;
  }

  async start(browser, options = {}) {
    if (this.state !== "idle") {
      throw new Error(`Cannot start session in state: ${this.state}`);
    }

    this.browser = browser;
    this.setState("starting");

    try {
      console.log("CastTabSession: Requesting display media...");
      this.mediaStream = await this.window.navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" },
        audio: false,
      });

      this.videoElement = this.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "video"
      );
      this.videoElement.srcObject = this.mediaStream;
      this.videoElement.muted = true;
      this.videoElement.autoplay = true;

      await new Promise(resolve => {
        this.videoElement.onloadedmetadata = resolve;
      });

      this.width = this.videoElement.videoWidth || 1280;
      this.height = this.videoElement.videoHeight || 720;

      this.canvas = this.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "canvas"
      );
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.ctx = this.canvas.getContext("2d");

      this.encoder = Cc["@mozilla.org/cast/video-encoder;1"].createInstance(
        Ci.nsICastVideoEncoder
      );
      this.encoder.init(
        this.width,
        this.height,
        options.bitrate || 2000000,
        options.fps || 15
      );

      this.server = new SimpleHTTPServer();
      this.server.registerPathHandler("/stream.webm", connection => {
        this.handleStreamRequest(connection);
      });
      const port = this.server.start(8010);
      const castDeviceIP = this.castDevice.address;
      console.log(`CastTabSession: Cast device IP is ${castDeviceIP}`);
      const localIP = this.server.getLocalIP(castDeviceIP);
      // const streamURL = `http://${localIP}:${port}/stream.webm`;
      const streamURL = "https://unobscenely-keyed-tatiana.ngrok-free.dev/stream.webm";

      console.log(`CastTabSession: Stream URL: ${streamURL}`);

      const fps = options.fps || 15;
      const intervalMs = 1000 / fps;
      this.captureInterval = setInterval(() => {
        this.captureAndEncode();
      }, intervalMs);

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
      await this.mediaHandler.load(streamURL, "video/webm", "BUFFERED", metadata);

      this.setState("streaming");
      console.log("CastTabSession: Tab casting started successfully");

      return {
        streamURL,
        state: this.state,
      };
    } catch (error) {
      console.error("CastTabSession: Error starting session:", error);
      this.setState("error");
      await this.cleanup();
      throw error;
    }
  }

  handleStreamRequest(connection) {
    console.log("CastTabSession: Client connected for WebM stream");

    try {
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

      console.log("CastTabSession: Sending HTTP headers with chunked encoding");
      connection.outputStream.write(headers, headers.length);

      console.log("CastTabSession: Getting WebM header from encoder");
      const header = this.encoder.getHeader();
      console.log(`CastTabSession: Got WebM header, ${header.length} bytes`);

      this.writeChunk(connection.outputStream, header);
      console.log("CastTabSession: WebM header chunk sent and flushed");

      this.streamConnection = connection;
    } catch (e) {
      console.error("CastTabSession: Error in handleStreamRequest:", e);
      console.error(e.stack);
      if (this.server) {
        this.server.closeConnection(connection);
      }
    }
  }

  writeChunk(outputStream, data) {
    const chunkSize = data.length.toString(16);
    const chunkHeader = `${chunkSize}\r\n`;

    outputStream.write(chunkHeader, chunkHeader.length);

    const binaryStream = Cc["@mozilla.org/binaryoutputstream;1"]
      .createInstance(Ci.nsIBinaryOutputStream);
    binaryStream.setOutputStream(outputStream);
    binaryStream.writeByteArray(data);

    const chunkFooter = "\r\n";
    outputStream.write(chunkFooter, chunkFooter.length);
    outputStream.flush();
  }

  captureAndEncode() {
    if (!this.canvas || !this.ctx || !this.videoElement || !this.encoder) {
      return;
    }

    try {
      this.ctx.drawImage(
        this.videoElement,
        0,
        0,
        this.canvas.width,
        this.canvas.height
      );

      const imageData = this.ctx.getImageData(
        0,
        0,
        this.canvas.width,
        this.canvas.height
      );
      const rgbaArray = new Uint8Array(imageData.data.buffer);

      const webmCluster = this.encoder.encodeFrame(rgbaArray, false);

      if (this.streamConnection && webmCluster.length > 0) {
        try {
          this.writeChunk(this.streamConnection.outputStream, webmCluster);
        } catch (e) {
          console.error("CastTabSession: Error writing to stream:", e);
          this.streamConnection = null;
        }
      }
    } catch (e) {
      console.error("CastTabSession: Error capturing frame:", e);
      console.error(e.stack);
    }
  }

  async stop() {
    if (this.state === "idle") {
      return;
    }

    this.setState("stopping");

    try {
      if (this.mediaHandler) {
        await this.mediaHandler.stop();
      }
    } catch (e) {
      console.error("CastTabSession: Error stopping media:", e);
    }

    await this.cleanup();
    this.setState("idle");
    console.log("CastTabSession: Session stopped");
  }

  async cleanup() {
    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }

    if (this.encoder) {
      try {
        this.encoder.shutdown();
      } catch (e) {
        console.error("CastTabSession: Error shutting down encoder:", e);
      }
      this.encoder = null;
    }

    if (this.streamConnection && this.server) {
      try {
        this.server.closeConnection(this.streamConnection);
      } catch (e) {
        console.error("CastTabSession: Error closing stream connection:", e);
      }
      this.streamConnection = null;
    }

    if (this.server) {
      this.server.stop();
      this.server = null;
    }

    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.srcObject = null;
      this.videoElement = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    if (this.mediaHandler) {
      this.mediaHandler.reset();
      this.mediaHandler = null;
    }

    this.canvas = null;
    this.ctx = null;
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
        if (status) {
          console.log(
            `CastTabSession: Media status - ${status.playerState}`
          );

          if (status.idleReason === "ERROR") {
            console.error("CastTabSession: Media playback error");
            this.setState("error");
          }
        }
      } else if (message.type === "LOAD_FAILED") {
        console.error("CastTabSession: LOAD_FAILED:", message);
        this.setState("error");
      } else if (message.type === "LOAD_CANCELLED") {
        console.log("CastTabSession: LOAD_CANCELLED");
        this.setState("idle");
      }
    } catch (e) {
      console.error("CastTabSession: Error handling media message:", e);
    }
  }

  setState(newState) {
    console.log(`CastTabSession: ${this.state} -> ${newState}`);
    this.state = newState;
  }

  getState() {
    return this.state;
  }

  isActive() {
    return this.state === "streaming" || this.state === "starting";
  }
}
