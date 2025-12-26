/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  setInterval,
  clearInterval,
  clearTimeout,
  setTimeout,
} from "resource://gre/modules/Timer.sys.mjs";
import {
  CAST_NAMESPACES,
  CAST_APP_IDS,
  DEFAULT_CAST_PORT,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
} from "resource:///modules/cast/CastConstants.mjs";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "logConsole", function () {
  return console.createInstance({
    prefix: "Cast:Device",
    maxLogLevel: Services.prefs.getBoolPref("browser.cast.log", false)
      ? "Debug"
      : "Warn",
  });
});

/**
 *
 */
export class CastDevice {
  constructor(id, address, port = DEFAULT_CAST_PORT) {
    this.id = id;
    this.address = address;
    this.port = port;
    this.friendlyName = address;
    this.state = "disconnected";

    this._xpcomDevice = Cc["@mozilla.org/cast/device;1"].createInstance(
      Ci.nsICastDevice
    );
    this._xpcomDevice.callback = this._createCallback();

    this._heartbeatTimer = null;
    this._eventListeners = new Map();
    this._connectResolve = null;
    this._connectReject = null;
  }

  _createCallback() {
    return {
      QueryInterface: ChromeUtils.generateQI(["nsICastDeviceCallback"]),

      onStateChanged: state => {
        this.state = state;
        lazy.logConsole.debug(`State changed: ${state}`);
        this._emit("stateChanged", state);

        if (state === "connected" && this._connectResolve) {
          lazy.logConsole.debug(
            `Connection successful to ${this.address}:${this.port}`
          );
          this._connectResolve();
          this._connectResolve = null;
          this._connectReject = null;
        } else if (state === "error" && this._connectReject) {
          lazy.logConsole.warn(
            `Connection failed to ${this.address}:${this.port}`
          );
          this._connectReject(new Error("Connection failed"));
          this._connectResolve = null;
          this._connectReject = null;
        }
      },

      onMessage: (namespace, payload) => {
        const parsed = JSON.parse(payload);
        lazy.logConsole.debug(`<- Received [${namespace}]:`, parsed);
        this._emit("message", { namespace, payload: parsed });
      },

      onError: error => {
        lazy.logConsole.error(`Error: ${error}`);
        this._emit("error", new Error(error));
        if (this._connectReject) {
          this._connectReject(new Error(error));
          this._connectResolve = null;
          this._connectReject = null;
        }
      },
    };
  }

  async addCertificateOverride() {
    lazy.logConsole.debug(
      `Adding certificate override for ${this.address}:${this.port}`
    );
    await this._addCastCertOverride();
    lazy.logConsole.debug(`Certificate override added successfully`);
  }

  async connect() {
    if (this.state === "connected") {
      lazy.logConsole.debug(
        `Already connected to ${this.address}:${this.port}, skipping`
      );
      return Promise.resolve();
    }

    lazy.logConsole.debug(`Connecting to ${this.address}:${this.port}`);
    return new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;

      try {
        this._xpcomDevice.connect(this.address, this.port);
        this._startHeartbeat();
      } catch (error) {
        this._connectResolve = null;
        this._connectReject = null;
        lazy.logConsole.error(`Connect call failed: ${error}`);
        reject(error);
      }
    });
  }

  async _addCastCertOverride() {
    const overrideService = Cc[
      "@mozilla.org/security/certoverride;1"
    ].getService(Ci.nsICertOverrideService);

    const cert = await this._getCertForHost(this.address, this.port);

    if (!cert) {
      lazy.logConsole.error(
        `Failed to retrieve certificate for ${this.address}:${this.port}`
      );
      throw new Error("Could not retrieve certificate for Cast device");
    }

    lazy.logConsole.debug("Verifying certificate is self-signed");
    const issuer = cert.issuerName;
    const subject = cert.subjectName;

    // cast devices use self signed certs!!!
    if (issuer !== subject) {
      lazy.logConsole.warn(
        `Certificate verification failed: issuer=${issuer}, subject=${subject}`
      );
      throw new Error(
        "Certificate is not self-signed - not a valid Cast device"
      );
    }

    lazy.logConsole.debug("Certificate verified as self-signed");
    overrideService.rememberValidityOverride(
      this.address,
      this.port,
      {},
      cert,
      true
    );
  }

  async _getCertForHost(hostname, port) {
    lazy.logConsole.debug(`Fetching certificate from ${hostname}:${port}`);

    return new Promise((resolve, reject) => {
      let resolved = false;
      let timeout;
      let channel;

      const resolveOnce = cert => {
        if (resolved) {
          return;
        }
        resolved = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        lazy.logConsole.debug("Certificate retrieved successfully");
        resolve(cert);
      };

      const rejectOnce = error => {
        if (resolved) {
          return;
        }
        resolved = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        lazy.logConsole.error(`Failed to get certificate: ${error}`);
        reject(error);
      };

      timeout = setTimeout(() => {
        if (channel) {
          channel.cancel(Cr.NS_BINDING_ABORTED);
        }
        rejectOnce(new Error("Timeout fetching certificate (10s)"));
      }, 10000);

      try {
        const url = `https://${hostname}:${port}/`;
        lazy.logConsole.debug("Creating HTTPS request to:", url);

        const uri = Services.io.newURI(url);
        channel = Services.io.newChannelFromURI(
          uri,
          null,
          Services.scriptSecurityManager.getSystemPrincipal(),
          null,
          Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
          Ci.nsIContentPolicy.TYPE_OTHER
        );

        const listener = {
          QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),

          onStartRequest(_aRequest) {},

          onDataAvailable(_aRequest, _aInputStream, _aOffset, _aCount) {},

          onStopRequest(aRequest, aStatus) {
            try {
              const securityInfo = aRequest.securityInfo;

              if (securityInfo?.serverCert) {
                lazy.logConsole.debug("Found server certificate");
                resolveOnce(securityInfo.serverCert);
                return;
              }

              lazy.logConsole.warn(
                `No certificate available (status: 0x${aStatus.toString(16)})`
              );
              rejectOnce(
                new Error(
                  `No certificate available (status: 0x${aStatus.toString(16)})`
                )
              );
            } catch (e) {
              lazy.logConsole.error(`Exception in onStopRequest: ${e}`);
              rejectOnce(e);
            }
          },
        };

        channel.asyncOpen(listener);
      } catch (e) {
        lazy.logConsole.error(`Exception creating channel: ${e}`);
        rejectOnce(e);
      }
    });
  }

  _startHeartbeat() {
    if (this._heartbeatTimer) {
      return;
    }

    this._heartbeatTimer = setInterval(() => {
      try {
        this._xpcomDevice.sendMessage(
          CAST_NAMESPACES.HEARTBEAT,
          JSON.stringify({ type: "PING" })
        );
      } catch (error) {
        console.error("Cast heartbeat failed:", error);
      }
    }, DEFAULT_HEARTBEAT_INTERVAL_MS);
  }

  disconnect() {
    lazy.logConsole.debug(`Disconnecting from ${this.address}:${this.port}`);

    this.stopApp();

    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    this._xpcomDevice.disconnect();
    this.state = "disconnected";
    this._emit("stateChanged", this.state);
    lazy.logConsole.debug("Disconnected successfully");
  }

  sendMessage(namespace, payload) {
    try {
      const parsed = JSON.parse(payload);
      lazy.logConsole.debug(`-> Sending [${namespace}]:`, parsed);
    } catch (e) {
      lazy.logConsole.debug(`-> Sending [${namespace}]: ${payload}`);
    }
    this._xpcomDevice.sendMessage(namespace, payload);
  }

  sendMessageTo(destinationId, namespace, payload) {
    try {
      const parsed = JSON.parse(payload);
      lazy.logConsole.debug(
        `-> Sending to ${destinationId} [${namespace}]:`,
        parsed
      );
    } catch (e) {
      lazy.logConsole.debug(
        `-> Sending to ${destinationId} [${namespace}]: ${payload}`
      );
    }
    this._xpcomDevice.sendMessageTo(destinationId, namespace, payload);
  }

  async launchApp(appId = CAST_APP_IDS.DEFAULT_MEDIA_RECEIVER) {
    lazy.logConsole.debug(`Launching app: ${appId}`);
    const payload = JSON.stringify({
      type: "LAUNCH",
      requestId: Date.now(),
      appId,
    });

    this.sendMessage(CAST_NAMESPACES.RECEIVER, payload);
    const transportId = await this._waitForTransportId(5000);
    if (transportId) {
      lazy.logConsole.debug(
        `App launched successfully, transportId: ${transportId}`
      );
    } else {
      lazy.logConsole.warn(`App launch failed: no transportId received`);
    }
    return { success: true, transportId };
  }

  stopApp() {
    const sessionId = this._xpcomDevice.getAppSessionId();
    if (!sessionId) {
      lazy.logConsole.debug("No app session to stop");
      return;
    }

    lazy.logConsole.debug(`Stopping app session: ${sessionId}`);
    const payload = JSON.stringify({
      type: "STOP",
      requestId: Date.now(),
      sessionId,
    });

    this.sendMessage(CAST_NAMESPACES.RECEIVER, payload);
  }

  async _waitForTransportId(timeoutMs) {
    const startTime = Date.now();
    const pollInterval = 50;

    while (Date.now() - startTime < timeoutMs) {
      const transportId = this._xpcomDevice.getAppTransportId();
      if (transportId) {
        return transportId;
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    return null;
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
    const listeners = this._eventListeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(data);
        } catch (error) {
          console.error("Cast event listener error:", error);
        }
      }
    }
  }

  getAppTransportId() {
    return this._xpcomDevice.getAppTransportId() || null;
  }
}
