export class CastTabChild extends JSWindowActorChild {
  getViewportInfo() {
    const win = this.contentWindow;
    if (!win) {
      return null;
    }

    return {
      scrollX: win.scrollX,
      scrollY: win.scrollY,
      innerWidth: win.innerWidth,
      innerHeight: win.innerHeight,
    };
  }

  receiveMessage(message) {
    switch (message.name) {
      case "CastTab:GetViewportInfo":
        return this.getViewportInfo();
    }
    return null;
  }
}
