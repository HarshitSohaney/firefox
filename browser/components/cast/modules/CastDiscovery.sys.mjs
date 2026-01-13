/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "logConsole", function () {
  return console.createInstance({
    prefix: "Cast:Discovery",
    maxLogLevel: Services.prefs.getBoolPref("browser.cast.log", false)
      ? "Debug"
      : "Warn",
  });
});

ChromeUtils.defineESModuleGetters(lazy, {
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
});

/**
 * Discovers Cast devices on the local network using mDNS.
 * Sends DNS-SD queries and parses responses for _googlecast._tcp.local services.
 */
export class CastDiscovery {
  static MDNS_ADDR = "224.0.0.251";
  static MDNS_PORT = 5353;
  static SERVICE_TYPE = "_googlecast._tcp.local";
  // Check every 5 seconds for the cast devices
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

  /**
   * mDNS uses udp sockets, let's set one up to listen and communicate to
   * the mDNS addr
   */
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
        lazy.logConsole.debug("Stopping mDNS cast search");
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

      // Send query to find cast devices to the mDNS addr
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

  /**
   * Build mDNS query packet for Cast device discovery.
   * Constructs DNS query for _googlecast._tcp.local service.
   */
  #buildDnsQuery() {
    const serviceName = CastDiscovery.SERVICE_TYPE;
    const parts = serviceName.split(".");

    let query = "";

    // DNS Header (12 bytes):
    // - Bytes 0-1: Transaction ID (0x0000)
    query += String.fromCharCode(0x00, 0x00);
    // - Bytes 2-3: Flags (0x0000 - standard query)
    query += String.fromCharCode(0x00, 0x00);
    // - Bytes 4-5: Question count (0x0001 - one question)
    query += String.fromCharCode(0x00, 0x01);
    // Bytes 6-7: Answer count (0x0000)
    query += String.fromCharCode(0x00, 0x00);
    // Bytes 8-9: Authority record count (0x0000)
    query += String.fromCharCode(0x00, 0x00);
    // Bytes 10-11: Additional record count (0x0000)
    query += String.fromCharCode(0x00, 0x00);

    // length+part of service type
    // \x0b_googlecast\x04_tcp\x05local
    for (const part of parts) {
      query += String.fromCharCode(part.length);
      query += part;
    }
    query += String.fromCharCode(0x00);

    // PTR record
    query += String.fromCharCode(0x00, 0x0c);
    // IN class
    query += String.fromCharCode(0x00, 0x01);

    return query;
  }

  #handleResponse(data) {
    try {
      const response = this.#parseDnsResponse(data);

      if (response.answers.length || response.additionals.length) {
        lazy.logConsole.debug(
          "Received mDNS response with",
          response.answers.length,
          "answers and",
          response.additionals.length,
          "additionals"
        );

        for (const answer of response.answers) {
          lazy.logConsole.debug(
            "Answer type:",
            answer.type,
            "name:",
            answer.name
          );
          if (answer.type === "PTR") {
            this.#handlePtrRecord(answer, response);
          }
        }
      }
    } catch (error) {
      lazy.logConsole.error("Failed to parse DNS response:", error);
    }
  }

  /**
   * Parse mDNS response packet.
   * Extracts PTR, SRV, TXT, and A records from DNS packet format.
   *
   * DNS Packet Structure:
   * - Header (12 bytes): transaction ID, flags, counts for questions/answers/authority/additional
   * - Questions section: the queries being answered
   * - Answers section: direct responses to queries (PTR records listing devices)
   * - Additional section: related info to avoid follow-up queries (SRV/TXT/A records)
   *
   * @param {string} data Raw DNS packet data
   */
  #parseDnsResponse(data) {
    const response = {
      answers: [],
      additionals: [],
    };

    if (data.length < 12) {
      return response;
    }

    // Parse header: extract counts from bytes 4-11
    const questionCount = (data.charCodeAt(4) << 8) | data.charCodeAt(5);
    const answerCount = (data.charCodeAt(6) << 8) | data.charCodeAt(7);
    const additionalCount = (data.charCodeAt(10) << 8) | data.charCodeAt(11);

    let offset = 12;

    // Reads DNS name encoded as: length byte + characters, repeating, null-terminated.
    // Supports compression: if top 2 bits set (0xC0), next 2 bytes are pointer to name elsewhere.
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

    // Advances offset past a DNS name without reading it.
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

    // Skip questions section (name + 4 bytes for type/class)
    for (let i = 0; i < questionCount; i++) {
      offset += skipName(offset);
      offset += 4;
    }

    // Parse answer records
    for (let i = 0; i < answerCount && offset < data.length; i++) {
      const answer = {};
      answer.name = readName(offset);
      offset += skipName(offset);

      if (offset + 10 > data.length) {
        break;
      }

      const type = (data.charCodeAt(offset) << 8) | data.charCodeAt(offset + 1);
      offset += 2;

      offset += 2; // Skip class

      offset += 4; // Skip TTL

      const dataLength =
        (data.charCodeAt(offset) << 8) | data.charCodeAt(offset + 1);
      offset += 2;

      if (type === 12) {
        // PTR: Service pointer, points to instance name
        answer.type = "PTR";
        answer.target = readName(offset);
      } else if (type === 33) {
        // SRV: Service location (priority, weight, port, target hostname)
        answer.type = "SRV";
        answer.priority =
          (data.charCodeAt(offset) << 8) | data.charCodeAt(offset + 1);
        answer.weight =
          (data.charCodeAt(offset + 2) << 8) | data.charCodeAt(offset + 3);
        answer.port =
          (data.charCodeAt(offset + 4) << 8) | data.charCodeAt(offset + 5);
        answer.target = readName(offset + 6);
      } else if (type === 16) {
        // TXT: Text metadata as key=value pairs (e.g., fn=Living Room TV, md=Chromecast)
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

    // Parse additional records (same format, includes A records for IP addresses)
    for (let i = 0; i < additionalCount && offset < data.length; i++) {
      const additional = {};
      additional.name = readName(offset);
      offset += skipName(offset);

      if (offset + 10 > data.length) {
        break;
      }

      const type = (data.charCodeAt(offset) << 8) | data.charCodeAt(offset + 1);
      offset += 2;

      offset += 2; // Skip class

      offset += 4; // Skip TTL

      const dataLength =
        (data.charCodeAt(offset) << 8) | data.charCodeAt(offset + 1);
      offset += 2;

      if (type === 33) {
        // SRV record
        additional.type = "SRV";
        additional.priority =
          (data.charCodeAt(offset) << 8) | data.charCodeAt(offset + 1);
        additional.weight =
          (data.charCodeAt(offset + 2) << 8) | data.charCodeAt(offset + 3);
        additional.port =
          (data.charCodeAt(offset + 4) << 8) | data.charCodeAt(offset + 5);
        additional.target = readName(offset + 6);
      } else if (type === 16) {
        // TXT record
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
        // A: IPv4 address (4 bytes as dotted decimal)
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

  /**
   * Process PTR record pointing to Cast device.
   * Extracts device info from associated SRV, TXT, and A records.
   *
   * @param {object} ptrRecord PTR record with device instance name
   * @param {object} fullResponse Full DNS response containing all records
   */
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
      if (
        srvRecord &&
        record.name === srvRecord.target &&
        record.type === "A"
      ) {
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
}
