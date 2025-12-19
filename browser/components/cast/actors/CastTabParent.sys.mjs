export class CastTabParent extends JSWindowActorParent {
  async getViewportInfo() {
    try {
      return await this.sendQuery("CastTab:GetViewportInfo");
    } catch (e) {
      console.error("CastTabParent: Error getting viewport info:", e);
      return null;
    }
  }
}
