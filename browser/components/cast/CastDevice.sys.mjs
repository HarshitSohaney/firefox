/**
 * JavaScript wrapper for the Rust XPCOM Cast device component.
 * Provides a Promise-based API over the callback-based XPCOM interface.
 */

import {
  setInterval,
  clearInterval,
} from "resource://gre/modules/Timer.sys.mjs";

export class CastDevice {
  constructor(id, address, port = 8009) {
    this.id = id;
    this.address = address;
    this.port = port;
    this.friendlyName = address;
    this.state = "disconnected";

    // Create the Rust XPCOM component
    this._xpcomDevice = Cc["@mozilla.org/cast/device;1"].createInstance(
      Ci.nsICastDevice
    );

    // Set up callback to receive events from Rust
    this._xpcomDevice.callback = this._createCallback();

    this._heartbeatTimer = null;
    this._eventListeners = new Map();
    this._connectResolve = null;
    this._connectReject = null;
  }

  _createCallback() {
    const self = this;
    return {
      QueryInterface: ChromeUtils.generateQI(["nsICastDeviceCallback"]),

      onStateChanged(state) {
        console.log(`CastDevice: State changed to ${state}`);
        self.state = state;
        self._emit("stateChanged", state);

        // Resolve connect promise when we reach "connected" state
        if (state === "connected" && self._connectResolve) {
          const resolve = self._connectResolve;
          self._connectResolve = null;
          self._connectReject = null;
          resolve();
        }

        // Reject connect promise on error
        if (state === "error" && self._connectReject) {
          const reject = self._connectReject;
          self._connectResolve = null;
          self._connectReject = null;
          reject(new Error("Connection failed"));
        }
      },

      onMessage(namespace, payload) {
        console.log(`CastDevice: Received message on ${namespace}`);
        self._emit("message", { namespace, payload: JSON.parse(payload) });
      },

      onError(error) {
        console.error(`CastDevice: Error: ${error}`);
        self._emit("error", new Error(error));

        if (self._connectReject) {
          const reject = self._connectReject;
          self._connectResolve = null;
          self._connectReject = null;
          reject(new Error(error));
        }
      },
    };
  }

  async connect() {
    console.log(`CastDevice: Connecting to ${this.address}:${this.port}`);

    return new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;

      try {
        // Call Rust XPCOM connect - this is synchronous but connection happens async
        this._xpcomDevice.connect(this.address, this.port);

        // Start heartbeat from JavaScript side
        this._startHeartbeat();
      } catch (error) {
        this._connectResolve = null;
        this._connectReject = null;
        console.error("CastDevice: Connect call failed:", error);
        reject(error);
      }
    });
  }

  _startHeartbeat() {
    if (this._heartbeatTimer) {
      return; // Already started
    }

    this._heartbeatTimer = setInterval(() => {
      try {
        const payload = JSON.stringify({ type: "PING" });
        this._xpcomDevice.sendMessage(
          "urn:x-cast:com.google.cast.tp.heartbeat",
          payload
        );
      } catch (error) {
        console.error("CastDevice: Heartbeat failed:", error);
      }
    }, 5000);

    console.log("CastDevice: Started heartbeat");
  }

  async disconnect() {
    console.log("CastDevice: Disconnecting");

    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    try {
      this._xpcomDevice.disconnect();
    } catch (error) {
      console.error("CastDevice: Disconnect failed:", error);
    }

    this.state = "disconnected";
    this._emit("stateChanged", this.state);
  }

  async sendMessage(namespace, payload) {
    console.log(`CastDevice: Sending message to ${namespace}`);
    try {
      this._xpcomDevice.sendMessage(namespace, payload);
    } catch (error) {
      console.error("CastDevice: sendMessage failed:", error);
      throw error;
    }
  }

  async launchApp(appId = "CC1AD845") {
    console.log(`CastDevice: Launching app ${appId}`);
    const payload = JSON.stringify({
      type: "LAUNCH",
      requestId: Date.now(),
      appId,
    });

    try {
      await this.sendMessage("urn:x-cast:com.google.cast.receiver", payload);
      return { success: true };
    } catch (error) {
      console.error("CastDevice: Launch app failed:", error);
      throw error;
    }
  }

  addEventListener(event, callback) {
    if (!this._eventListeners.has(event)) {
      this._eventListeners.set(event, []);
    }
    this._eventListeners.get(event).push(callback);
  }

  removeEventListener(event, callback) {
    if (this._eventListeners.has(event)) {
      const listeners = this._eventListeners.get(event);
      const index = listeners.indexOf(callback);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  }

  _emit(event, data) {
    if (this._eventListeners.has(event)) {
      for (const listener of this._eventListeners.get(event)) {
        try {
          listener(data);
        } catch (error) {
          console.error("CastDevice: Error in event listener:", error);
        }
      }
    }
  }
}
