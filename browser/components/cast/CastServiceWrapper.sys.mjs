import { CastDevice } from "resource:///modules/cast/CastDevice.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CastTabSession: "resource:///modules/cast/CastTabSession.sys.mjs",
});

XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "certOverrideService",
  "@mozilla.org/security/certoverride;1",
  Ci.nsICertOverrideService
);

class CastService {
  constructor() {
    this._devices = new Map();
    this._activeSession = null;
    this._tabSession = null;
    this._stateListeners = new Set();
    this._initialized = false;
  }

  init() {
    if (this._initialized) {
      return;
    }

    console.log("CastService: Initializing");

    try {
      // CRITICAL: Set XPCSHELL_TEST_PROFILE_DIR *BEFORE* calling cert override service
      // This enables setDisableAllSecurityChecksAndLetAttackersInterceptMyData
      const env = Cc["@mozilla.org/process/environment;1"].getService(
        Ci.nsIEnvironment
      );
      env.set("XPCSHELL_TEST_PROFILE_DIR", "1");

      Services.prefs.setBoolPref(
        "network.stricttransportsecurity.preloadlist",
        false
      );
      Services.prefs.setIntPref("security.cert_pinning.enforcement_level", 0);

      lazy.certOverrideService.setDisableAllSecurityChecksAndLetAttackersInterceptMyData(
        true
      );

      console.log(
        "CastService: Certificate validation disabled for Cast development"
      );
      console.warn(
        "WARNING: TLS certificate validation is disabled! This is for Cast development only."
      );
    } catch (e) {
      console.error("CastService: Failed to disable cert validation:", e);
    }

    this._initialized = true;
  }

  getDeviceDiscovery() {
    return {
      addManualDevice: ipAddress => {
        const deviceId = `manual-${ipAddress}`;
        const device = new CastDevice(deviceId, ipAddress);

        device.addEventListener("stateChanged", state => {
          this._notifyStateListeners(state, device);
        });

        device.addEventListener("error", error => {
          console.error("CastService: Device error:", error);
          this._notifyStateListeners("error", device);
        });

        this._devices.set(deviceId, device);
        console.log("CastService: Added manual device:", deviceId);

        return device;
      },

      removeDevice: deviceId => {
        const device = this._devices.get(deviceId);
        if (device) {
          device.disconnect();
          this._devices.delete(deviceId);
          console.log("CastService: Removed device:", deviceId);
        }
      },
    };
  }

  async testConnection(deviceId) {
    const device = this._devices.get(deviceId);
    if (!device) {
      throw new Error("Device not found");
    }

    console.log("CastService: Testing connection to", deviceId);

    try {
      await device.connect();
      console.log("CastService: Connection successful!");

      console.log("CastService: Launching DefaultMediaReceiver...");
      const launchResult = await device.launchApp("CC1AD845");
      console.log("CastService: Launch result:", launchResult);

      this._activeSession = {
        device,
        sessionId: launchResult.status?.applications?.[0]?.sessionId,
      };

      this._notifyStateListeners("connected", device);

      return true;
    } catch (error) {
      console.error("CastService: Connection failed:", error);
      this._notifyStateListeners("error", device);
      throw error;
    }
  }

  async stopCasting() {
    if (!this._activeSession) {
      return;
    }

    const { device } = this._activeSession;

    try {
      await device.disconnect();
    } finally {
      this._activeSession = null;
      this._notifyStateListeners("idle", null);
    }
  }

  async startTabCasting(deviceId, browser, window, options = {}) {
    const device = this._devices.get(deviceId);
    if (!device) {
      throw new Error("Device not found");
    }

    if (device.state !== "connected") {
      await device.connect();
    }

    if (this._tabSession && this._tabSession.isActive()) {
      throw new Error("Tab casting already in progress");
    }

    console.log("CastService: Launching DefaultMediaReceiver...");
    const launchResult = await device.launchApp("CC1AD845");
    console.log("CastService: Launch result:", launchResult);

    this._activeSession = {
      device,
      sessionId: launchResult.status?.applications?.[0]?.sessionId,
    };

    console.log("CastService: Starting tab casting...");

    this._tabSession = new lazy.CastTabSession(device, window);

    try {
      const result = await this._tabSession.start(browser, options);
      console.log("CastService: Tab casting started successfully");
      this._notifyStateListeners("casting", device);
      return result;
    } catch (error) {
      console.error("CastService: Failed to start tab casting:", error);
      this._tabSession = null;
      this._activeSession = null;
      throw error;
    }
  }

  async stopTabCasting() {
    if (!this._tabSession) {
      return;
    }

    console.log("CastService: Stopping tab casting...");

    try {
      await this._tabSession.stop();
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
    for (const [deviceId, device] of this._devices) {
      try {
        device.disconnect();
      } catch (e) {
        console.warn(`CastService: Error cleaning up device ${deviceId}:`, e);
      }
    }

    this._devices.clear();
    this._activeSession = null;
    this._tabSession = null;

    try {
      lazy.certOverrideService.setDisableAllSecurityChecksAndLetAttackersInterceptMyData(
        false
      );
      console.log("CastService: Certificate validation re-enabled");
    } catch (e) {
      console.warn("CastService: Could not re-enable cert validation:", e);
    }

    console.log("CastService: Cleanup complete");
  }
}

export const gCastService = new CastService();
