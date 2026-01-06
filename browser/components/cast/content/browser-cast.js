/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var gCastService;

/**
 * UI controller for the Cast device selection panel.
 * Displays available devices, manages manual device addition, and controls active sessions.
 */
var CastPanel = {
  _initialized: false,
  _deviceItems: new Map(),

  get panel() {
    return document.getElementById("castPanel");
  },

  get deviceList() {
    return document.getElementById("castPanel-deviceList");
  },

  get emptyState() {
    return document.getElementById("castPanel-emptyState");
  },

  get activeSession() {
    return document.getElementById("castPanel-activeSession");
  },

  get castingLabel() {
    return document.getElementById("castPanel-castingLabel");
  },

  init() {
    console.warn("CastPanel: Starting initialization...");

    try {
      const { gCastService: service } = ChromeUtils.importESModule(
        "resource:///modules/cast/CastService.sys.mjs"
      );
      gCastService = service;

      gCastService.addEventListener(
        "CastService:StateUpdate",
        this.onStateUpdate.bind(this)
      );
      gCastService.addEventListener(
        "CastService:DeviceAdded",
        this.onDeviceAdded.bind(this)
      );
      gCastService.addEventListener(
        "CastService:DeviceRemoved",
        this.onDeviceRemoved.bind(this)
      );

      const manualAddButton = document.getElementById("castPanel-manualAdd");
      manualAddButton.addEventListener("command", () => this.onManualAdd());

      const stopButton = document.getElementById("castPanel-stopButton");
      stopButton.addEventListener("command", () => this.onStopCasting());

      this._initialized = true;
      console.warn("CastPanel: Initialized successfully");
    } catch (ex) {
      console.error("CastPanel: Failed to initialize:", ex);
      console.error("CastPanel: Error stack:", ex.stack);
    }
  },

  onPanelShowing(_aEvent) {
    console.warn("CastPanel: Panel showing");
    if (!this._initialized) {
      return;
    }

    this.updateDeviceList();
    this.updateActiveSession();

    if (gCastService.startDiscovery) {
      gCastService.startDiscovery().catch(err => {
        console.error("CastPanel: Failed to start discovery:", err);
      });
    }
  },

  onPanelHiding(_aEvent) {
    console.warn("CastPanel: Panel hiding");
  },

  updateDeviceList() {
    this.deviceList.innerHTML = "";
    this._deviceItems.clear();

    const state = gCastService.state;
    const devices = state.devices || [];

    if (devices.length === 0) {
      this.emptyState.hidden = false;
      this.deviceList.hidden = true;
    } else {
      this.emptyState.hidden = true;
      this.deviceList.hidden = false;

      for (const device of devices) {
        this.addDeviceItem(device);
      }
    }
  },

  addDeviceItem(device) {
    const state = gCastService.state;
    const isActive = state.activeDeviceId === device.id;

    const item = document.createXULElement("richlistitem");
    item.setAttribute("deviceId", device.id);
    item.className = "cast-device-item";
    if (isActive) {
      item.classList.add("casting");
    }

    const label = document.createXULElement("label");
    label.textContent = device.friendlyName || device.address || device.id;
    label.className = "cast-device-name";
    item.appendChild(label);

    if (isActive) {
      const statusLabel = document.createXULElement("label");
      statusLabel.textContent = "Casting";
      statusLabel.className = "cast-device-status";
      item.appendChild(statusLabel);
    }

    item.addEventListener("command", () => this.onDeviceSelected(device.id));
    item.addEventListener("click", () => this.onDeviceSelected(device.id));

    this.deviceList.appendChild(item);
    this._deviceItems.set(device.id, item);
  },

  onDeviceSelected(deviceId) {
    console.warn("CastPanel: Device selected:", deviceId);

    if (!gCastService) {
      console.error("CastPanel: Cast service not initialized");
      return;
    }

    const browser = gBrowser.selectedBrowser;
    gCastService
      .startTabCasting(deviceId, browser, window, {
        fps: 30,
        bitrate: 15000000,
      })
      .then(() => {
        console.warn("CastPanel: Casting started successfully");
        this.updateActiveSession();
        CastButton.updateIndicator();
        PanelMultiView.hidePopup(this.panel);
      })
      .catch(error => {
        console.error("CastPanel: Failed to start casting:", error);
        alert(`Failed to start casting: ${error.message}`);
      });
  },

  async onManualAdd() {
    const deviceIP = prompt("Enter Cast device IP address:", "1.1.1.1");

    if (!deviceIP) {
      return;
    }

    try {
      console.warn("CastPanel: Adding manual device:", deviceIP);
      const device = await gCastService.addManualDevice(deviceIP);

      console.warn("CastPanel: Device added, testing connection");
      await gCastService.testConnection(device.id);

      console.warn("CastPanel: Connection successful, starting casting");
      const browser = gBrowser.selectedBrowser;
      await gCastService.startTabCasting(device.id, browser, window, {
        fps: 30,
        bitrate: 15000000,
      });

      this.updateActiveSession();
      CastButton.updateIndicator();
      PanelMultiView.hidePopup(this.panel);
    } catch (error) {
      console.error("CastPanel: Manual device add/cast failed:", error);
      alert(`Failed to add or cast to device: ${error.message}`);
    }
  },

  onStopCasting() {
    console.warn("CastPanel: Stopping casting");
    gCastService
      .stopCasting()
      .then(() => {
        console.warn("CastPanel: Casting stopped");
        this.updateActiveSession();
        CastButton.updateIndicator();
      })
      .catch(error => {
        console.error("CastPanel: Failed to stop casting:", error);
      });
  },

  onStateUpdate() {
    console.warn("CastPanel: State updated");
    this.updateDeviceList();
    this.updateActiveSession();
    CastButton.updateIndicator();
  },

  onDeviceAdded(event) {
    console.warn("CastPanel: Device added:", event.detail);
    this.updateDeviceList();
  },

  onDeviceRemoved(event) {
    console.warn("CastPanel: Device removed:", event.detail);
    this.updateDeviceList();
  },

  updateActiveSession() {
    const state = gCastService.state;
    const isActive = state.activeSessionCount > 0;

    if (isActive) {
      this.activeSession.hidden = false;
      const activeDevice = gCastService.getActiveDevice();
      if (activeDevice) {
        const deviceName = activeDevice.friendlyName || activeDevice.address;
        this.castingLabel.textContent = `Casting to ${deviceName}`;
      } else {
        this.castingLabel.textContent = "Casting...";
      }
    } else {
      this.activeSession.hidden = true;
    }
  },
};

var CastButton = {
  _initialized: false,

  get button() {
    return document.getElementById("cast-button");
  },

  init() {
    console.warn("CastButton: Initializing");
    if (!gCastService) {
      console.warn("CastButton: Cast service not available");
      return;
    }

    this._initialized = true;
    this.updateIndicator();
  },

  updateIndicator() {
    if (!this._initialized || !this.button) {
      return;
    }

    const state = gCastService.state;
    const isActive = state.activeSessionCount > 0;

    if (isActive) {
      this.button.setAttribute("attention", "true");
    } else {
      this.button.removeAttribute("attention");
    }
  },
};

window.addEventListener("load", () => {
  CastPanel.init();
  CastButton.init();
});
