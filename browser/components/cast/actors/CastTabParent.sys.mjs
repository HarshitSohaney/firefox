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
