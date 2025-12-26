/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "logConsole", function () {
  return console.createInstance({
    prefix: "CastDiscovery",
    maxLogLevel: "Debug",
  });
});

ChromeUtils.defineESModuleGetters(lazy, {
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
});

export class CastDiscovery {
  static MDNS_ADDR = "224.0.0.251";
  static MDNS_PORT = 5353;
  static SERVICE_TYPE = "_googlecast._tcp.local";
  static QUERY_INTERVAL = 5000;

  #socket = null;
  #devices = new Map();
  #listeners = new Set();
  #queryTimer = null;
  #running = false;

  async start() {
    if (this.#running) {
      lazy.logConsole.debug("Discovery already running");
      return;
    }

    lazy.logConsole.debug("Starting mDNS discovery");

    try {
      this.#running = true;
      await this.#createSocket();
      await this.#sendQuery();

      this.#queryTimer = lazy.setInterval(() => {
        this.#sendQuery().catch(err => {
          lazy.logConsole.error("Failed to send periodic query:", err);
        });
      }, CastDiscovery.QUERY_INTERVAL);

      lazy.logConsole.debug("mDNS discovery started successfully");
    } catch (error) {
      lazy.logConsole.error("Failed to start discovery:", error);
      this.#running = false;
      throw error;
    }
  }

  stop() {
    if (!this.#running) {
      return;
    }

    lazy.logConsole.debug("Stopping mDNS discovery");

    if (this.#queryTimer) {
      lazy.clearInterval(this.#queryTimer);
      this.#queryTimer = null;
    }

    if (this.#socket) {
      try {
        this.#socket.close();
      } catch (e) {
        lazy.logConsole.error("Error closing socket:", e);
      }
      this.#socket = null;
    }

    this.#running = false;
    lazy.logConsole.debug("mDNS discovery stopped");
  }

  addListener(callback) {
    this.#listeners.add(callback);
  }

  removeListener(callback) {
    this.#listeners.delete(callback);
  }

  async #createSocket() {
    this.#socket = Cc["@mozilla.org/network/udp-socket;1"].createInstance(
      Ci.nsIUDPSocket
    );

    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIUDPSocketListener"]),

      onPacketReceived: (_socket, message) => {
        try {
          const data = message.data;
          this.#handleResponse(data);
        } catch (e) {
          lazy.logConsole.error("Error handling packet:", e);
        }
      },

      onStopListening: (_socket, status) => {
        if (status !== Cr.NS_OK) {
          lazy.logConsole.error("Socket stopped listening with error:", status);
        }
      },
    };

    this.#socket.init(
      0,
      false,
      Services.scriptSecurityManager.getSystemPrincipal(),
      true
    );

    this.#socket.asyncListen(listener);

    const localPort = this.#socket.port;
    lazy.logConsole.debug("Socket listening on local port", localPort);
  }

  async #sendQuery() {
    if (!this.#socket) {
      return;
    }

    try {
      const query = this.#buildDnsQuery();
      const queryBytes = Array.from(query, c => c.charCodeAt(0));

      const rawData = new Uint8Array(queryBytes);

      this.#socket.send(
        CastDiscovery.MDNS_ADDR,
        CastDiscovery.MDNS_PORT,
        rawData,
        rawData.length
      );

      lazy.logConsole.debug("Sent mDNS query for", CastDiscovery.SERVICE_TYPE);
    } catch (error) {
      lazy.logConsole.error("Failed to send query:", error);
      throw error;
    }
  }

  #buildDnsQuery() {
    const serviceName = CastDiscovery.SERVICE_TYPE;
    const parts = serviceName.split(".");

    let query = "";

    query += String.fromCharCode(0x00, 0x00);
    query += String.fromCharCode(0x00, 0x00);
    query += String.fromCharCode(0x00, 0x01);
    query += String.fromCharCode(0x00, 0x00);
    query += String.fromCharCode(0x00, 0x00);
    query += String.fromCharCode(0x00, 0x00);

    for (const part of parts) {
      query += String.fromCharCode(part.length);
      query += part;
    }
    query += String.fromCharCode(0x00);

    query += String.fromCharCode(0x00, 0x0c);
    query += String.fromCharCode(0x00, 0x01);

    return query;
  }

  #handleResponse(data) {
    try {
      const response = this.#parseDnsResponse(data);

      if (response.answers.length > 0 || response.additionals.length > 0) {
        lazy.logConsole.debug(
          "Received mDNS response with",
          response.answers.length,
          "answers and",
          response.additionals.length,
          "additionals"
        );

        for (const answer of response.answers) {
          lazy.logConsole.debug("Answer type:", answer.type, "name:", answer.name);
          if (answer.type === "PTR") {
            this.#handlePtrRecord(answer, response);
          }
        }
      }
    } catch (error) {
      lazy.logConsole.error("Failed to parse DNS response:", error);
    }
  }

  #parseDnsResponse(data) {
    const response = {
      answers: [],
      additionals: [],
    };

    if (data.length < 12) {
      return response;
    }

    const questionCount = (data.charCodeAt(4) << 8) | data.charCodeAt(5);
    const answerCount = (data.charCodeAt(6) << 8) | data.charCodeAt(7);
    const additionalCount = (data.charCodeAt(10) << 8) | data.charCodeAt(11);

    let offset = 12;

    const readName = pos => {
      let name = "";
      let length = data.charCodeAt(pos);

      while (length > 0) {
        if ((length & 0xc0) === 0xc0) {
          const pointer = ((length & 0x3f) << 8) | data.charCodeAt(pos + 1);
          name += readName(pointer);
          return name;
        }

        pos++;
        for (let i = 0; i < length; i++) {
          name += data.charAt(pos++);
        }
        length = data.charCodeAt(pos);
        if (length > 0) {
          name += ".";
        }
      }
      return name;
    };

    const skipName = pos => {
      let length = data.charCodeAt(pos);
      let skipped = 0;

      while (length > 0) {
        if ((length & 0xc0) === 0xc0) {
          return skipped + 2;
        }
        skipped += length + 1;
        pos += length + 1;
        length = data.charCodeAt(pos);
      }
      return skipped + 1;
    };

    for (let i = 0; i < questionCount; i++) {
      offset += skipName(offset);
      offset += 4;
    }

    for (let i = 0; i < answerCount && offset < data.length; i++) {
      const answer = {};
      answer.name = readName(offset);
      offset += skipName(offset);

      if (offset + 10 > data.length) {
        break;
      }

      const type = (data.charCodeAt(offset) << 8) | data.charCodeAt(offset + 1);
      offset += 2;

      const recordClass =
        (data.charCodeAt(offset) << 8) | data.charCodeAt(offset + 1);
      offset += 2;

      const ttl =
        (data.charCodeAt(offset) << 24) |
        (data.charCodeAt(offset + 1) << 16) |
        (data.charCodeAt(offset + 2) << 8) |
        data.charCodeAt(offset + 3);
      offset += 4;

      const dataLength =
        (data.charCodeAt(offset) << 8) | data.charCodeAt(offset + 1);
      offset += 2;

      if (type === 12) {
        answer.type = "PTR";
        answer.target = readName(offset);
      } else if (type === 33) {
        answer.type = "SRV";
        answer.priority =
          (data.charCodeAt(offset) << 8) | data.charCodeAt(offset + 1);
        answer.weight =
          (data.charCodeAt(offset + 2) << 8) | data.charCodeAt(offset + 3);
        answer.port =
          (data.charCodeAt(offset + 4) << 8) | data.charCodeAt(offset + 5);
        answer.target = readName(offset + 6);
      } else if (type === 16) {
        answer.type = "TXT";
        answer.txt = {};
        let txtOffset = offset;
        while (txtOffset < offset + dataLength) {
          const txtLen = data.charCodeAt(txtOffset++);
          if (txtLen > 0) {
            const txt = data.substring(txtOffset, txtOffset + txtLen);
            const eqPos = txt.indexOf("=");
            if (eqPos > 0) {
              const key = txt.substring(0, eqPos);
              const value = txt.substring(eqPos + 1);
              answer.txt[key] = value;
            }
            txtOffset += txtLen;
          }
        }
      }

      offset += dataLength;
      response.answers.push(answer);
    }

    for (let i = 0; i < additionalCount && offset < data.length; i++) {
      const additional = {};
      additional.name = readName(offset);
      offset += skipName(offset);

      if (offset + 10 > data.length) {
        break;
      }

      const type = (data.charCodeAt(offset) << 8) | data.charCodeAt(offset + 1);
      offset += 2;

      const recordClass =
        (data.charCodeAt(offset) << 8) | data.charCodeAt(offset + 1);
      offset += 2;

      const ttl =
        (data.charCodeAt(offset) << 24) |
        (data.charCodeAt(offset + 1) << 16) |
        (data.charCodeAt(offset + 2) << 8) |
        data.charCodeAt(offset + 3);
      offset += 4;

      const dataLength =
        (data.charCodeAt(offset) << 8) | data.charCodeAt(offset + 1);
      offset += 2;

      if (type === 33) {
        additional.type = "SRV";
        additional.priority =
          (data.charCodeAt(offset) << 8) | data.charCodeAt(offset + 1);
        additional.weight =
          (data.charCodeAt(offset + 2) << 8) | data.charCodeAt(offset + 3);
        additional.port =
          (data.charCodeAt(offset + 4) << 8) | data.charCodeAt(offset + 5);
        additional.target = readName(offset + 6);
      } else if (type === 16) {
        additional.type = "TXT";
        additional.txt = {};
        let txtOffset = offset;
        while (txtOffset < offset + dataLength) {
          const txtLen = data.charCodeAt(txtOffset++);
          if (txtLen > 0) {
            const txt = data.substring(txtOffset, txtOffset + txtLen);
            const eqPos = txt.indexOf("=");
            if (eqPos > 0) {
              const key = txt.substring(0, eqPos);
              const value = txt.substring(eqPos + 1);
              additional.txt[key] = value;
            }
            txtOffset += txtLen;
          }
        }
      } else if (type === 1) {
        additional.type = "A";
        additional.address =
          data.charCodeAt(offset) +
          "." +
          data.charCodeAt(offset + 1) +
          "." +
          data.charCodeAt(offset + 2) +
          "." +
          data.charCodeAt(offset + 3);
      }

      offset += dataLength;
      response.additionals.push(additional);
    }

    return response;
  }

  #handlePtrRecord(ptrRecord, fullResponse) {
    const instanceName = ptrRecord.target;

    lazy.logConsole.debug("Found Cast device:", instanceName);

    let srvRecord = null;
    let txtRecord = null;
    let aRecord = null;

    const allRecords = [...fullResponse.answers, ...fullResponse.additionals];

    for (const record of allRecords) {
      if (record.name === instanceName) {
        if (record.type === "SRV") {
          srvRecord = record;
        } else if (record.type === "TXT") {
          txtRecord = record;
        }
      }
      if (srvRecord && record.name === srvRecord.target && record.type === "A") {
        aRecord = record;
      }
    }

    if (srvRecord) {
      const device = {
        name: instanceName,
        host: aRecord?.address || srvRecord.target,
        port: srvRecord.port || 8009,
        friendlyName: txtRecord?.txt?.fn || instanceName,
        model: txtRecord?.txt?.md || "Unknown",
      };

      lazy.logConsole.debug("Device info:", device);

      this.#devices.set(instanceName, device);
      this.#notifyDeviceFound(device);
    } else {
      lazy.logConsole.debug("No SRV record found for", instanceName);
    }
  }

  #notifyDeviceFound(device) {
    lazy.logConsole.debug("Notifying device found:", device.friendlyName);
    for (const listener of this.#listeners) {
      try {
        listener.onDeviceFound?.(device);
      } catch (e) {
        lazy.logConsole.error("Error in device found listener:", e);
      }
    }
  }

  #notifyDeviceLost(name) {
    lazy.logConsole.debug("Notifying device lost:", name);
    for (const listener of this.#listeners) {
      try {
        listener.onDeviceLost?.(name);
      } catch (e) {
        lazy.logConsole.error("Error in device lost listener:", e);
      }
    }
  }
}
