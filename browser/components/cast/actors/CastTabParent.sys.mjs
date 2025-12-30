/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parent-side actor for communicating with content processes during tab casting.
 * Retrieves viewport information and handles video fullscreen events.
 */
export class CastTabParent extends JSWindowActorParent {
  async getViewportInfo() {
    try {
      return await this.sendQuery("CastTab:GetViewportInfo");
    } catch (e) {
      console.error("CastTabParent: Error getting viewport info:", e);
      return null;
    }
  }

  receiveMessage(message) {
    switch (message.name) {
      case "CastTab:VideoFullscreen":
        this.handleVideoFullscreen(message.data);
        break;
    }
  }

  handleVideoFullscreen(data) {
    const browser = this.browsingContext?.top.embedderElement;
    if (!browser) {
      return;
    }

    const window = browser.ownerGlobal;
    if (window?.gCastUI) {
      if (data.entered) {
        window.gCastUI.onVideoFullscreen(data.videoUrl);
      } else {
        window.gCastUI.onVideoFullscreenExit();
      }
    }
  }
}
