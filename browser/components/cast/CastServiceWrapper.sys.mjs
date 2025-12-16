import { CastDevice } from "resource:///modules/cast/CastDevice.sys.mjs";

class CastService {
  constructor() {
    this._devices = new Map();
    this._activeSession = null;
    this._stateListeners = new Set();
    this._initialized = false;
  }

  init() {
    if (this._initialized) {
      return;
    }

    console.log("CastService: Initializing");

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
    console.log("CastService: Cleanup");
  }
}

export const gCastService = new CastService();
