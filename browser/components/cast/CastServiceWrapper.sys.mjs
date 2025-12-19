import { CastDevice } from "resource:///modules/cast/CastDevice.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "logConsole", function () {
  return console.createInstance({
    prefix: "Cast:Service",
    maxLogLevel: Services.prefs.getBoolPref("browser.cast.log", false)
      ? "Debug"
      : "Warn",
  });
});

ChromeUtils.defineESModuleGetters(lazy, {
  CastTabSession: "resource:///modules/cast/CastTabSession.sys.mjs",
});

class CastService {
  constructor() {
    this._devices = new Map();
    this._activeSession = null;
    this._tabSession = null;
    this._stateListeners = new Set();
    this._initialized = false;
  }

  init() {
    this._initialized = true;
  }

  getDeviceDiscovery() {
    return {
      addManualDevice: async ipAddress => {
        lazy.logConsole.debug(`Adding manual device: ${ipAddress}`);
        const deviceId = `manual-${ipAddress}`;
        const device = new CastDevice(deviceId, ipAddress);

        device.addEventListener("stateChanged", state => {
          this._notifyStateListeners(state, device);
        });

        device.addEventListener("error", error => {
          lazy.logConsole.error(`Device error for ${ipAddress}:`, error);
          this._notifyStateListeners("error", device);
        });

        this._devices.set(deviceId, device);

        try {
          await device.addCertificateOverride();
          lazy.logConsole.debug(`Manual device added successfully: ${ipAddress}`);
        } catch (error) {
          lazy.logConsole.error(`Failed to add device ${ipAddress}: ${error.message}`);
          this._devices.delete(deviceId);
          throw new Error(
            `Failed to validate Cast device certificate: ${error.message}`
          );
        }

        return device;
      },

      removeDevice: deviceId => {
        lazy.logConsole.debug(`Removing device: ${deviceId}`);
        const device = this._devices.get(deviceId);
        if (device) {
          device.disconnect();
          this._devices.delete(deviceId);
          lazy.logConsole.debug(`Device removed: ${deviceId}`);
        } else {
          lazy.logConsole.warn(`Device not found: ${deviceId}`);
        }
      },
    };
  }

  async testConnection(deviceId) {
    lazy.logConsole.debug(`Testing connection to device: ${deviceId}`);
    const device = this._devices.get(deviceId);
    if (!device) {
      lazy.logConsole.error(`Test connection failed: device not found (${deviceId})`);
      throw new Error("Device not found");
    }

    try {
      await device.connect();
      const launchResult = await device.launchApp("CC1AD845");

      this._activeSession = {
        device,
        sessionId: launchResult.status?.applications?.[0]?.sessionId,
      };

      this._notifyStateListeners("connected", device);
      lazy.logConsole.debug(`Test connection successful for device: ${deviceId}`);
      return true;
    } catch (error) {
      lazy.logConsole.error(`Test connection failed for device ${deviceId}:`, error);
      this._notifyStateListeners("error", device);
      throw error;
    }
  }

  async stopCasting() {
    if (!this._activeSession) {
      lazy.logConsole.debug("stopCasting: no active session");
      return;
    }

    lazy.logConsole.debug("Stopping casting session");
    const { device } = this._activeSession;

    try {
      const stopPayload = JSON.stringify({
        type: "STOP",
        requestId: Date.now(),
      });

      try {
        device.sendMessage("urn:x-cast:com.google.cast.receiver", stopPayload);
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (e) {
        lazy.logConsole.error("Error sending STOP:", e);
      }

      const appTransportId = device.getAppTransportId();
      if (appTransportId) {
        device.sendMessageTo(
          appTransportId,
          "urn:x-cast:com.google.cast.tp.connection",
          JSON.stringify({ type: "CLOSE" })
        );
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      device.sendMessageTo(
        "receiver-0",
        "urn:x-cast:com.google.cast.tp.connection",
        JSON.stringify({ type: "CLOSE" })
      );

      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (e) {
      lazy.logConsole.error("Error during disconnect sequence:", e);
    }

    try {
      device.disconnect();
      lazy.logConsole.debug("Casting stopped successfully");
    } finally {
      this._activeSession = null;
      this._notifyStateListeners("idle", null);
    }
  }

  async startTabCasting(deviceId, browser, window, options = {}) {
    lazy.logConsole.debug(`Starting tab casting for device: ${deviceId}`);
    const device = this._devices.get(deviceId);
    if (!device) {
      lazy.logConsole.error(`Tab casting failed: device not found (${deviceId})`);
      throw new Error("Device not found");
    }

    if (device.state !== "connected") {
      lazy.logConsole.debug("Device not connected, connecting first");
      await device.connect();
    }

    if (this._tabSession && this._tabSession.isActive()) {
      lazy.logConsole.warn("Tab casting already in progress");
      throw new Error("Tab casting already in progress");
    }

    if (!this._activeSession) {
      lazy.logConsole.debug("No active session, launching app");
      const launchResult = await device.launchApp("CC1AD845");
      this._activeSession = {
        device,
        sessionId: launchResult.status?.applications?.[0]?.sessionId,
      };
    }

    this._tabSession = new lazy.CastTabSession(device, window);

    try {
      const result = await this._tabSession.start(browser, options);
      this._notifyStateListeners("casting", device);
      lazy.logConsole.debug("Tab casting started successfully");
      return result;
    } catch (error) {
      lazy.logConsole.error("Tab casting failed:", error);
      this._tabSession = null;
      throw error;
    }
  }

  async stopTabCasting() {
    if (!this._tabSession) {
      lazy.logConsole.debug("stopTabCasting: no tab session");
      return;
    }

    lazy.logConsole.debug("Stopping tab casting");
    try {
      await this._tabSession.stop();
      lazy.logConsole.debug("Tab casting stopped successfully");
    } finally {
      this._tabSession = null;
      this._notifyStateListeners("connected", null);
    }
  }

  getTabSession() {
    return this._tabSession;
  }

  addStateListener(listener) {
    this._stateListeners.add(listener);
  }

  removeStateListener(listener) {
    this._stateListeners.delete(listener);
  }

  _notifyStateListeners(state, device) {
    for (const listener of this._stateListeners) {
      try {
        listener(state, device);
      } catch (error) {
        console.error("CastService: Error in state listener:", error);
      }
    }
  }

  cleanup() {
    lazy.logConsole.debug("Cleaning up Cast service");
    for (const [deviceId, device] of this._devices) {
      try {
        device.disconnect();
      } catch (e) {
        lazy.logConsole.warn(`Device cleanup error (${deviceId}):`, e);
      }
    }

    this._devices.clear();
    this._activeSession = null;
    this._tabSession = null;
    lazy.logConsole.debug("Cast service cleanup complete");
  }
}

export const gCastService = new CastService();
