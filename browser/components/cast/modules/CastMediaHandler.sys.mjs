/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { CAST_NAMESPACES } from "resource:///modules/cast/CastConstants.mjs";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "logConsole", function () {
  return console.createInstance({
    prefix: "Cast:Media",
    maxLogLevel: Services.prefs.getBoolPref("browser.cast.log", false)
      ? "Debug"
      : "Warn",
  });
});

/**
 * Handles Cast Media namespace protocol commands.
 * Manages media session lifecycle: load, play, pause, stop, seek.
 */
export class CastMediaHandler {
  static NAMESPACE = CAST_NAMESPACES.MEDIA;

  constructor(castDevice) {
    this.castDevice = castDevice;
    this.requestId = 1;
    this.mediaSessionId = null;
  }

  getNextRequestId() {
    return this.requestId++;
  }

  /**
   * Send a media control command to the Cast device.
   *
   * Cast Media Protocol Flow:
   * 1. All commands go to MEDIA namespace (urn:x-cast:com.google.cast.media)
   * 2. Commands are routed to the app's transport ID automatically by cast_device.rs
   * 3. Each command has a unique requestId for tracking responses
   * 4. Most commands (except LOAD) require a mediaSessionId from previous LOAD
   *
   * Command sequence for playing media:
   * - LOAD: Start loading media URL, get back mediaSessionId in MEDIA_STATUS
   * - PLAY: Resume playback (requires mediaSessionId)
   * - PAUSE: Pause playback (requires mediaSessionId)
   * - STOP: Stop playback and close media session
   *
   * @param {string} command Command type (LOAD, PLAY, PAUSE, STOP, SEEK, etc.)
   * @param {object} additionalFields Extra fields to include in message
   */
  async sendMediaCommand(command, additionalFields = {}) {
    const requestId = this.getNextRequestId();
    const message = {
      type: command,
      requestId,
      ...additionalFields,
    };

    // Include mediaSessionId for all commands except LOAD
    // (LOAD creates a new session, others operate on existing session)
    if (this.mediaSessionId && command !== "LOAD") {
      message.mediaSessionId = this.mediaSessionId;
    }

    const payload = JSON.stringify(message);

    try {
      lazy.logConsole.debug(`Sending media command: ${command}`);
      await this.castDevice.sendMessage(CastMediaHandler.NAMESPACE, payload);
      return requestId;
    } catch (e) {
      lazy.logConsole.error(`Error sending ${command}:`, e);
      throw e;
    }
  }

  /**
   * Load media on the Cast device.
   *
   * @param {string} contentId Media URL
   * @param {string} contentType MIME type (e.g., "video/webm")
   * @param {string} streamType "LIVE" or "BUFFERED"
   * @param {object} metadata Media metadata (title, etc.)
   * @param {boolean} _lowLatency Enable low-latency mode for live streams (not yet implemented)
   */
  async load(
    contentId,
    contentType,
    streamType = "LIVE",
    metadata = null,
    _lowLatency = false
  ) {
    lazy.logConsole.debug(`Loading media: ${contentId}`);
    const media = {
      contentId,
      contentType,
      streamType,
    };

    if (streamType === "LIVE") {
      media.duration = -1;
    }

    if (metadata) {
      media.metadata = metadata;
    }

    const loadCommand = {
      media,
      autoplay: true,
    };

    const requestId = await this.sendMediaCommand("LOAD", loadCommand);
    lazy.logConsole.debug(`Media load sent, requestId: ${requestId}`);
    return requestId;
  }

  async play() {
    if (!this.mediaSessionId) {
      throw new Error("No active media session");
    }
    return await this.sendMediaCommand("PLAY");
  }

  async pause() {
    if (!this.mediaSessionId) {
      throw new Error("No active media session");
    }
    return await this.sendMediaCommand("PAUSE");
  }

  async stop() {
    if (!this.mediaSessionId) {
      lazy.logConsole.debug("No active media session to stop");
      return;
    }
    await this.sendMediaCommand("STOP");
  }

  async seek(currentTime) {
    if (!this.mediaSessionId) {
      throw new Error("No active media session");
    }
    return await this.sendMediaCommand("SEEK", { currentTime });
  }

  async getStatus() {
    return await this.sendMediaCommand("GET_STATUS");
  }

  /**
   * Parse MEDIA_STATUS message from Cast device.
   *
   * MEDIA_STATUS is sent by the device in response to media commands
   * and periodically during playback to report status changes.
   *
   * Key fields in status:
   * - playerState: "IDLE", "BUFFERING", "PLAYING", "PAUSED"
   * - mediaSessionId: ID for this media session (needed for subsequent commands)
   * - currentTime: Playback position in seconds
   * - idleReason: "FINISHED", "ERROR", "CANCELLED", "INTERRUPTED"
   *
   * The mediaSessionId is extracted and stored for use in subsequent
   * PLAY, PAUSE, STOP commands.
   *
   * @param {string} payload JSON payload from MEDIA_STATUS message
   */
  handleMediaStatus(payload) {
    try {
      const message = JSON.parse(payload);

      if (message.status && message.status.length) {
        const status = message.status[0];
        lazy.logConsole.debug(`Media status: ${status.playerState}`);

        // Extract and store mediaSessionId for subsequent commands
        if (status.mediaSessionId) {
          this.mediaSessionId = status.mediaSessionId;
        }

        // Clear session ID when media finishes or errors
        if (status.idleReason === "FINISHED" || status.idleReason === "ERROR") {
          lazy.logConsole.debug(`Media idle reason: ${status.idleReason}`);
          this.mediaSessionId = null;
        }

        return {
          playerState: status.playerState,
          mediaSessionId: this.mediaSessionId,
          currentTime: status.currentTime,
          idleReason: status.idleReason,
        };
      }
    } catch (e) {
      lazy.logConsole.error("Error parsing MEDIA_STATUS:", e);
    }

    return null;
  }

  reset() {
    this.mediaSessionId = null;
  }
}
