export class CastMediaHandler {
  static NAMESPACE = "urn:x-cast:com.google.cast.media";

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
    console.log(`CastMediaHandler: Sending ${command}:`, payload);

    try {
      await this.castDevice.sendMessage(
        CastMediaHandler.NAMESPACE,
        payload
      );
      return requestId;
    } catch (e) {
      console.error(`CastMediaHandler: Error sending ${command}:`, e);
      throw e;
    }
  }

  async load(contentId, contentType, streamType = "LIVE", metadata = null) {
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
      autoplay: false,
    };

    console.log("CastMediaHandler: LOAD command:", JSON.stringify(loadCommand, null, 2));

    return await this.sendMediaCommand("LOAD", loadCommand);
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
      throw new Error("No active media session");
    }
    return await this.sendMediaCommand("STOP");
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
      console.log("CastMediaHandler: Received MEDIA_STATUS:", message);

      if (message.status && message.status.length > 0) {
        const status = message.status[0];
        if (status.mediaSessionId) {
          this.mediaSessionId = status.mediaSessionId;
        }

        const playerState = status.playerState;
        console.log(
          `CastMediaHandler: Player state: ${playerState}, session: ${this.mediaSessionId}`
        );

        if (status.idleReason) {
          console.log(
            `CastMediaHandler: Idle reason: ${status.idleReason}`
          );
          if (status.idleReason === "FINISHED" || status.idleReason === "ERROR") {
            this.mediaSessionId = null;
          }
        }

        return {
          playerState,
          mediaSessionId: this.mediaSessionId,
          currentTime: status.currentTime,
          idleReason: status.idleReason,
        };
      }
    } catch (e) {
      console.error("CastMediaHandler: Error parsing MEDIA_STATUS:", e);
    }

    return null;
  }

  reset() {
    this.mediaSessionId = null;
    this.pendingRequests.clear();
  }
}
