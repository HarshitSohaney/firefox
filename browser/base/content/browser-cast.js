/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var gCastUI = {
  _castService: null,
  _discovery: null,
  _initialized: false,
  _connectedDeviceId: null,

  init() {
    console.warn("gCastUI: Starting initialization...");

    try {
      const { gCastService } = ChromeUtils.importESModule(
        "resource:///modules/cast/CastServiceWrapper.sys.mjs"
      );
      this._castService = gCastService;
      this._castService.init();
      this._discovery = this._castService.getDeviceDiscovery();

      this._castService.addStateListener(this.onStateChange.bind(this));

      this._initialized = true;
      console.warn("gCastUI: Initialized successfully");
    } catch (ex) {
      console.error("gCastUI: Failed to initialize:", ex);
      console.error("gCastUI: Error stack:", ex.stack);
    }
  },

  async openPanel() {
    console.warn("gCastUI: openPanel() called");
    console.warn("gCastUI: Initialized?", this._initialized);

    if (!this._initialized) {
      console.error("gCastUI: Not initialized yet!");
      alert("Cast service not ready. Please try again.");
      return;
    }

    console.warn("gCastUI: Showing IP prompt");
    const deviceIP = prompt("Enter Cast device IP address:", "192.168.1.100");

    console.warn("gCastUI: User entered:", deviceIP);

    if (!deviceIP) {
      console.warn("gCastUI: User cancelled");
      return;
    }

    try {
      console.warn("gCastUI: Adding manual device");
      const device = await this._discovery.addManualDevice(deviceIP);

      console.warn(
        "gCastUI: Device added successfully, starting cast to device:",
        device.id
      );
      this.startCasting(device.id);
    } catch (error) {
      console.error("gCastUI: Failed to add device:", error);
      alert(
        `Failed to add Cast device: ${error.message}\n\nMake sure the device is reachable and is a valid Cast device.`
      );
    }
  },

  async startCasting(deviceId) {
    try {
      console.warn("gCastUI: Starting connection test to device", deviceId);

      await this._castService.testConnection(deviceId);

      console.warn("gCastUI: Connection test successful!");

      this._connectedDeviceId = deviceId;
      this.showConnectedNotification();
    } catch (ex) {
      console.error("gCastUI: Connection test failed:", ex);
      console.error("gCastUI: Error stack:", ex.stack);
      alert(
        `Connection failed: ${ex.message}\n\nCheck Browser Console for details.`
      );
    }
  },

  showConnectedNotification() {
    const notificationBox = gBrowser.getNotificationBox();

    notificationBox.appendNotification(
      "cast-connected",
      {
        label: "Cast device connected. Click to cast this tab.",
        priority: notificationBox.PRIORITY_INFO_HIGH,
      },
      [
        {
          label: "Cast This Tab",
          callback: () => {
            this.startTabCasting(this._connectedDeviceId);
          },
        },
        {
          label: "Disconnect",
          callback: () => {
            this.stopCasting();
          },
        },
      ]
    );
  },

  async stopCasting() {
    try {
      console.warn("gCastUI: Stopping cast");
      await this._castService.stopCasting();
      await this._castService.stopTabCasting();
      console.warn("gCastUI: Casting stopped");
    } catch (ex) {
      console.error("gCastUI: Failed to stop casting:", ex);
    }
  },

  async startTabCasting(deviceId) {
    try {
      console.warn("gCastUI: Starting tab casting to device", deviceId);

      const browser = gBrowser.selectedBrowser;
      const result = await this._castService.startTabCasting(
        deviceId,
        browser,
        window,
        { fps: 15, bitrate: 2500000 }
      );

      console.warn("gCastUI: Tab casting started:", result);
      this.showCastingNotification();

      return result;
    } catch (ex) {
      console.error("gCastUI: Tab casting failed:", ex);
      alert(
        `Tab casting failed: ${ex.message}\n\nCheck Browser Console for details.`
      );
      throw ex;
    }
  },

  showCastingNotification() {
    const notificationBox = gBrowser.getNotificationBox();

    const connectedNotif =
      notificationBox.getNotificationWithValue("cast-connected");
    if (connectedNotif) {
      notificationBox.removeNotification(connectedNotif);
    }

    notificationBox.appendNotification(
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

  onStateChange(state, _session) {
    console.warn("gCastUI: Cast state changed to", state);

    if (state === "idle" || state === "error") {
      const notificationBox = gBrowser.getNotificationBox();

      const activeNotif =
        notificationBox.getNotificationWithValue("cast-active");
      if (activeNotif) {
        notificationBox.removeNotification(activeNotif);
      }

      const connectedNotif =
        notificationBox.getNotificationWithValue("cast-connected");
      if (connectedNotif) {
        notificationBox.removeNotification(connectedNotif);
      }
    }
  },
};

window.addEventListener("load", () => {
  gCastUI.init();
});
