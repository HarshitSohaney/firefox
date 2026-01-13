/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "logConsole", function () {
  return console.createInstance({
    prefix: "Cast:MediaSession",
    maxLogLevel: Services.prefs.getBoolPref("browser.cast.log", false)
      ? "Debug"
      : "Warn",
  });
});

ChromeUtils.defineESModuleGetters(lazy, {
  CastMediaHandler: "resource:///modules/cast/CastMediaHandler.sys.mjs",
});

/**
 * Manages casting of remote media URLs (not tab content).
 * Simpler than CastSession as the Cast device fetches content directly.
 */
export class CastMediaSession {
  constructor(castDevice) {
    this.castDevice = castDevice;
    this.mediaHandler = null;
    this.state = "idle";
    this.mediaUrl = null;
    this.contentType = null;
    this._messageListener = null;
  }

  async start(mediaUrl, contentType, metadata = null) {
    if (this.state !== "idle") {
      lazy.logConsole.warn(
        `Cannot start media session in state: ${this.state}`
      );
      throw new Error(`Cannot start media session in state: ${this.state}`);
    }

    lazy.logConsole.debug(`Starting media session for ${mediaUrl}`);

    this.mediaUrl = mediaUrl;
    this.contentType = contentType;
    this.setState("starting");

    try {
      this.mediaHandler = new lazy.CastMediaHandler(this.castDevice);

      this._messageListener = ({ namespace, payload }) => {
        if (namespace === lazy.CastMediaHandler.NAMESPACE) {
          this.handleMediaMessage(JSON.stringify(payload));
        }
      };
      this.castDevice.addEventListener("message", this._messageListener);

      const defaultMetadata = {
        metadataType: 0,
        title: "Firefox Media Cast",
      };

      const finalMetadata = metadata || defaultMetadata;

      await this.mediaHandler.load(
        mediaUrl,
        contentType,
        "BUFFERED",
        finalMetadata
      );

      lazy.logConsole.debug("Media LOAD sent to Cast device");
      this.setState("playing");

      return {
        mediaUrl,
        contentType,
        state: this.state,
      };
    } catch (error) {
      lazy.logConsole.error("Error starting media session:", error);
      this.setState("error");
      await this.cleanup();
      throw error;
    }
  }

  async stop() {
    if (this.state === "idle") {
      lazy.logConsole.debug("stop: already idle");
      return;
    }

    lazy.logConsole.debug("Stopping media session");
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
    lazy.logConsole.debug("Media session stopped");
  }

  async cleanup() {
    if (this._messageListener) {
      this.castDevice.removeEventListener("message", this._messageListener);
      this._messageListener = null;
    }

    if (this.mediaHandler) {
      this.mediaHandler.reset();
      this.mediaHandler = null;
    }

    this.mediaUrl = null;
    this.contentType = null;
  }

  handleMediaMessage(payload) {
    if (!this.mediaHandler) {
      return;
    }

    try {
      const message = JSON.parse(payload);

      if (message.type === "MEDIA_STATUS") {
        const status = this.mediaHandler.handleMediaStatus(payload);

        if (
          status?.playerState === "IDLE" &&
          status?.idleReason === "FINISHED"
        ) {
          lazy.logConsole.debug("Media playback finished");
          this.setState("finished");
        } else if (status?.idleReason === "ERROR") {
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
    return this.state === "playing" || this.state === "starting";
  }
}
