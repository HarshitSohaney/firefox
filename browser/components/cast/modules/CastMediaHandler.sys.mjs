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
 *
 */
export class CastMediaHandler {
  static NAMESPACE = CAST_NAMESPACES.MEDIA;

  constructor(castDevice) {
    this.castDevice = castDevice;
    this.requestId = 1;
    this.mediaSessionId = null;
    this.pendingRequests = new Map();
  }

  getNextRequestId() {
    return this.requestId++;
  }

  async sendMediaCommand(command, additionalFields = {}) {
    const requestId = this.getNextRequestId();
    const message = {
      type: command,
      requestId,
      ...additionalFields,
    };

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

  async load(contentId, contentType, streamType = "LIVE", metadata = null) {
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

  handleMediaStatus(payload) {
    try {
      const message = JSON.parse(payload);

      if (message.status && message.status.length) {
        const status = message.status[0];
        lazy.logConsole.debug(`Media status: ${status.playerState}`);
        if (status.mediaSessionId) {
          this.mediaSessionId = status.mediaSessionId;
        }

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
    this.pendingRequests.clear();
  }
}
