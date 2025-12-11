/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var gCastUI = {
  _castService: null,
  _discovery: null,
  _initialized: false,

  init() {
    console.log("gCastUI: Starting initialization...");

    try {
      const { gCastService } = ChromeUtils.importESModule(
        "resource:///modules/cast/CastServiceWrapper.sys.mjs"
      );
      this._castService = gCastService;
      this._castService.init();
      this._discovery = this._castService.getDeviceDiscovery();

      this._castService.addStateListener(this.onStateChange.bind(this));

      this._initialized = true;
      console.log("gCastUI: Initialized successfully");
    } catch (ex) {
      console.error("gCastUI: Failed to initialize:", ex);
      console.error("gCastUI: Error stack:", ex.stack);
    }
  },

  openPanel() {
    console.log("gCastUI: openPanel() called");
    console.log("gCastUI: Initialized?", this._initialized);

    if (!this._initialized) {
      console.error("gCastUI: Not initialized yet!");
      alert("Cast service not ready. Please try again.");
      return;
    }

    console.log("gCastUI: Showing IP prompt");
    const deviceIP = prompt(
      "Enter Cast device IP address:",
      "192.168.1.100"
    );

    console.log("gCastUI: User entered:", deviceIP);

    if (!deviceIP) {
      console.log("gCastUI: User cancelled");
      return;
    }

    console.log("gCastUI: Adding manual device");
    const device = this._discovery.addManualDevice(deviceIP);

    console.log("gCastUI: Starting cast to device:", device.id);
    this.startCasting(device.id);
  },

  async startCasting(deviceId) {
    try {
      console.log("gCastUI: Starting connection test to device", deviceId);

      await this._castService.testConnection(deviceId);

      console.log("gCastUI: Connection test successful!");
      alert("Connected successfully! Check console for messages.");
    } catch (ex) {
      console.error("gCastUI: Connection test failed:", ex);
      console.error("gCastUI: Error stack:", ex.stack);
      alert(`Connection failed: ${ex.message}\n\nCheck Browser Console for details.`);
    }
  },

  async stopCasting() {
    try {
      console.log("gCastUI: Stopping cast");
      await this._castService.stopCasting();
      console.log("gCastUI: Casting stopped");
    } catch (ex) {
      console.error("gCastUI: Failed to stop casting:", ex);
    }
  },

  showCastingNotification() {
    const notificationBox = gBrowser.getNotificationBox();

    const notification = notificationBox.appendNotification(
      "cast-active",
      {
        label: "Casting tab to device",
        priority: notificationBox.PRIORITY_INFO_HIGH,
      },
      [
        {
          label: "Stop Casting",
          callback: () => {
            this.stopCasting();
          },
        },
      ]
    );
  },

  onStateChange(state, session) {
    console.log("gCastUI: Cast state changed to", state);

    if (state === "idle" || state === "error") {
      const notificationBox = gBrowser.getNotificationBox();
      const notification = notificationBox.getNotificationWithValue("cast-active");
      if (notification) {
        notificationBox.removeNotification(notification);
      }
    }
  },
};

window.addEventListener("load", () => {
  gCastUI.init();
});
