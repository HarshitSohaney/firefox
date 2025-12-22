/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  CAST_ERRORS,
  CAST_STATES,
  DEFAULT_CAST_PORT,
} from "resource:///modules/cast/CastConstants.mjs";
import { CastError } from "resource:///modules/cast/CastError.mjs";

const CAST_ENABLED_PREF_NAME = "browser.cast.enabled";
const CAST_LOG_PREF_NAME = "browser.cast.log";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "logConsole", function () {
  return console.createInstance({
    prefix: "CastService",
    maxLogLevel: Services.prefs.getBoolPref(CAST_LOG_PREF_NAME, false)
      ? "Debug"
      : "Warn",
  });
});

ChromeUtils.defineESModuleGetters(lazy, {
  CastDevice: "resource:///modules/cast/CastDevice.sys.mjs",
  CastSession: "resource:///modules/cast/CastSession.sys.mjs",
});

export class CastService extends EventTarget {
  static #instance = null;

  #devices = new Map();
  #sessions = new Map();
  #stateListeners = new Set();
  #initialized = false;

  #_state = {
    enabled: false,
    devices: [],
    activeSessionCount: 0,
  };

  static init() {
    if (this.#instance) {
      return this.#instance;
    }

    lazy.logConsole.debug("Initializing CastService");
    this.#instance = new CastService();
    this.#instance.#initialize();
    this.#instance.#registerObserver();
    return this.#instance;
  }

  static uninit() {
    if (this.#instance) {
      lazy.logConsole.debug("Uninitializing CastService");
      this.#instance.#cleanup();
      this.#instance = null;
    }
  }

  static get() {
    if (!this.#instance) {
      throw new CastError("CastService not initialized", CAST_ERRORS.UNINITIALIZED);
    }
    return this.#instance;
  }

  constructor() {
    super();
    lazy.logConsole.debug("CastService instantiated");
  }

  #registerObserver() {
    const observer = {
      QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
      observe: (subject, topic, data) => {
        if (topic === "quit-application") {
          lazy.logConsole.debug("Firefox quitting, cleaning up Cast sessions and devices");
          this.cleanupOnQuit();
        }
      }
    };
    Services.obs.addObserver(observer, "quit-application", false);
  }

  #initialize() {
    if (this.#initialized) {
      return;
    }

    this.#_state.enabled = Services.prefs.getBoolPref(
      CAST_ENABLED_PREF_NAME,
      true
    );

    this.#initialized = true;
    lazy.logConsole.debug("CastService initialized successfully");
  }

  #cleanup() {
    for (const [deviceId, device] of this.#devices) {
      try {
        device.disconnect();
      } catch (e) {
        lazy.logConsole.error(`Error disconnecting device ${deviceId}:`, e);
      }
    }
    this.#devices.clear();

    for (const [sessionId, session] of this.#sessions) {
      try {
        session.stop();
      } catch (e) {
        lazy.logConsole.error(`Error stopping session ${sessionId}:`, e);
      }
    }
    this.#sessions.clear();

    this.#stateListeners.clear();
    this.#initialized = false;
  }

  get state() {
    return Object.freeze(structuredClone(this.#_state));
  }

  stateUpdate() {
    this.dispatchEvent(new CustomEvent("CastService:StateUpdate"));
  }

  async addManualDevice(ipAddress, port = DEFAULT_CAST_PORT) {
    lazy.logConsole.debug(`Adding manual device: ${ipAddress}:${port}`);

    const deviceId = `manual-${ipAddress}`;
    if (this.#devices.has(deviceId)) {
      lazy.logConsole.debug(`Device ${deviceId} already exists, returning existing device`);
      return this.#devices.get(deviceId);
    }

    const device = new lazy.CastDevice(deviceId, ipAddress, port);

    device.addEventListener("stateChanged", state => {
      lazy.logConsole.debug(`Device ${deviceId} state changed: ${state}`);
      this.#notifyStateListeners(state, device);
    });

    device.addEventListener("error", error => {
      lazy.logConsole.error(`Device ${deviceId} error:`, error);
      this.#notifyStateListeners(CAST_STATES.ERROR, device);
    });

    this.#devices.set(deviceId, device);

    try {
      // sends a TLS handshake through a channel using uri https://{hostname}:{port}
      // which sends back the cert. Then we can use the certOverrideService to add an exception
      await device.addCertificateOverride();
      lazy.logConsole.debug(`Device ${deviceId} added successfully`);
      this.#updateDeviceList();
      return device;
    } catch (error) {
      lazy.logConsole.error(`Failed to add device ${deviceId}:`, error);
      this.#devices.delete(deviceId);
      throw new CastError(
        `Failed to validate Cast device certificate: ${error.message}`,
        CAST_ERRORS.CERTIFICATE_INVALID
      );
    }
  }

  removeDevice(deviceId) {
    lazy.logConsole.debug(`Removing device: ${deviceId}`);
    const device = this.#devices.get(deviceId);
    if (device) {
      device.disconnect();
      this.#devices.delete(deviceId);
      this.#updateDeviceList();
      lazy.logConsole.debug(`Device ${deviceId} removed`);
    } else {
      lazy.logConsole.warn(`Device ${deviceId} not found`);
    }
  }

  async testConnection(deviceId) {
    lazy.logConsole.debug(`Testing connection to device: ${deviceId}`);
    const device = this.#devices.get(deviceId);
    if (!device) {
      throw new CastError(
        `Device ${deviceId} not found`,
        CAST_ERRORS.DEVICE_NOT_FOUND
      );
    }

    try {
      await device.connect();
      const result = await device.launchApp();
      lazy.logConsole.debug(
        `Connection test successful for ${deviceId}`,
        result
      );
      return result;
    } catch (error) {
      lazy.logConsole.error(`Connection test failed for ${deviceId}:`, error);
      throw new CastError(
        `Connection test failed: ${error.message}`,
        CAST_ERRORS.CONNECTION_FAILED
      );
    }
  }

  async startTabCasting(deviceId, browser, window, options = {}) {
    lazy.logConsole.debug(`Starting tab casting for device: ${deviceId}`);

    const device = this.#devices.get(deviceId);
    if (!device) {
      throw new CastError(
        `Device ${deviceId} not found`,
        CAST_ERRORS.DEVICE_NOT_FOUND
      );
    }

    const sessionId = `session-${deviceId}-${Date.now()}`;
    const session = new lazy.CastSession(device, window);

    this.#sessions.set(sessionId, session);

    try {
      const result = await session.start(browser, options);
      this.#_state.activeSessionCount = this.#sessions.size;
      this.stateUpdate();
      lazy.logConsole.debug(`Tab casting started for ${deviceId}`, result);
      return result;
    } catch (error) {
      this.#sessions.delete(sessionId);
      lazy.logConsole.error(`Failed to start tab casting for ${deviceId}:`, error);
      throw new CastError(
        `Tab casting failed: ${error.message}`,
        CAST_ERRORS.CAPTURE_FAILED
      );
    }
  }

  async stopTabCasting(deviceId) {
    lazy.logConsole.debug(`Stopping tab casting for device: ${deviceId}`);

    for (const [sessionId, session] of this.#sessions) {
      if (sessionId.includes(deviceId)) {
        try {
          await session.stop();
          this.#sessions.delete(sessionId);
        } catch (error) {
          lazy.logConsole.error(`Error stopping session ${sessionId}:`, error);
        }
      }
    }

    this.#_state.activeSessionCount = this.#sessions.size;
    this.stateUpdate();
  }

  async stopCasting() {
    lazy.logConsole.debug("Stopping all casting");

    for (const [sessionId, session] of this.#sessions) {
      try {
        await session.stop();
      } catch (error) {
        lazy.logConsole.error(`Error stopping session ${sessionId}:`, error);
      }
    }

    this.#sessions.clear();
    this.#_state.activeSessionCount = 0;
    this.stateUpdate();
  }

  addStateListener(listener) {
    this.#stateListeners.add(listener);
  }

  removeStateListener(listener) {
    this.#stateListeners.delete(listener);
  }

  async cleanupOnQuit() {
    await this.stopCasting();
    for (const device of this.#devices.values()) {
      try {
        device.disconnect();
      } catch (error) {
        lazy.logConsole.error(`Error disconnecting device ${device.id}:`, error);
      }
    }
  }

  #notifyStateListeners(state, device) {
    for (const listener of this.#stateListeners) {
      try {
        listener(state, device);
      } catch (error) {
        lazy.logConsole.error("Error in state listener:", error);
      }
    }
  }

  #updateDeviceList() {
    this.#_state.devices = Array.from(this.#devices.values()).map(device => ({
      id: device.id,
      address: device.address,
      port: device.port,
      state: device.state,
      friendlyName: device.friendlyName,
    }));
    this.stateUpdate();
  }
}

export const gCastService = CastService.init();
