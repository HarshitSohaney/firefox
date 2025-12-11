import { CastTransport } from "resource:///modules/cast/CastTransport.sys.mjs";
import {
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
} from "resource://gre/modules/Timer.sys.mjs";

export class CastDevice {
  constructor(id, address, port = 8009) {
    this.id = id;
    this.address = address;
    this.port = port;
    this.friendlyName = address;
    this.state = "disconnected";

    this._transport = null;
    this._heartbeatTimer = null;
    this._requestId = 0;
    this._requestCallbacks = new Map();
    this._eventListeners = new Map();
  }

  async connect() {
    this.state = "connecting";
    this._emit("stateChanged", this.state);

    try {
      this._transport = new CastTransport(this.address, this.port);

      this._transport.addEventListener("message", msgBytes => {
        this._handleMessage(msgBytes);
      });

      this._transport.addEventListener("error", error => {
        console.error("CastDevice: Transport error", error);
        this.state = "disconnected";
        this._emit("stateChanged", this.state);
        this._emit("error", error);
      });

      this._transport.addEventListener("close", () => {
        console.log("CastDevice: Transport closed");
        this.state = "disconnected";
        this._emit("stateChanged", this.state);
        this._emit("_connectionClosed");
        if (this._heartbeatTimer) {
          clearInterval(this._heartbeatTimer);
          this._heartbeatTimer = null;
        }
      });

      await this._transport.connect();

      await this._sendConnect();

      console.log(
        "CastDevice: Waiting for device response before proceeding..."
      );
      await this._waitForDeviceReady();

      this._startHeartbeat();

      console.log("CastDevice: Device ready, sending GET_STATUS...");
      const status = await this._sendGetStatus();
      console.log("CastDevice: Got status:", status);

      this.friendlyName =
        status.status?.applications?.[0]?.displayName || this.address;

      this.state = "ready";
      this._emit("stateChanged", this.state);

      return true;
    } catch (error) {
      console.error("CastDevice: Connection failed:", error);
      this.state = "disconnected";
      this._emit("stateChanged", this.state);
      throw error;
    }
  }

  async _sendConnect() {
    const payload = JSON.stringify({
      type: "CONNECT",
    });
    await this._sendMessage(
      "urn:x-cast:com.google.cast.tp.connection",
      payload
    );
    console.log("CastDevice: Sent CONNECT");
  }

  async _waitForDeviceReady() {
    return new Promise((resolve, reject) => {
      let resolved = false;

      const cleanup = () => {
        this._eventListeners.get("_firstMessage")?.splice(0);
        this._eventListeners.get("_connectionClosed")?.splice(0);
      };

      const messageHandler = () => {
        if (!resolved) {
          resolved = true;
          console.log("CastDevice: Received response from device, ready!");
          cleanup();
          resolve();
        }
      };

      const closeHandler = () => {
        if (!resolved) {
          resolved = true;
          console.error("CastDevice: Connection closed while waiting for device");
          cleanup();
          reject(new Error("Device closed connection during handshake"));
        }
      };

      if (!this._eventListeners.has("_firstMessage")) {
        this._eventListeners.set("_firstMessage", []);
      }
      this._eventListeners.get("_firstMessage").push(messageHandler);

      if (!this._eventListeners.has("_connectionClosed")) {
        this._eventListeners.set("_connectionClosed", []);
      }
      this._eventListeners.get("_connectionClosed").push(closeHandler);

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          console.warn(
            "CastDevice: No response from device after 2s, proceeding anyway..."
          );
          resolve();
        }
      }, 2000);
    });
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      const payload = JSON.stringify({ type: "PING" });
      this._sendMessage(
        "urn:x-cast:com.google.cast.tp.heartbeat",
        payload
      ).catch(error => {
        console.error("CastDevice: Heartbeat failed:", error);
      });
    }, 5000);
    console.log("CastDevice: Started heartbeat");
  }

  async _sendGetStatus() {
    const requestId = ++this._requestId;
    const payload = JSON.stringify({
      type: "GET_STATUS",
      requestId,
    });
    return await this._sendRequest(
      "urn:x-cast:com.google.cast.receiver",
      payload,
      requestId
    );
  }

  async launchApp(appId = "CC1AD845") {
    const requestId = ++this._requestId;
    const payload = JSON.stringify({
      type: "LAUNCH",
      requestId,
      appId,
    });
    return await this._sendRequest(
      "urn:x-cast:com.google.cast.receiver",
      payload,
      requestId
    );
  }

  async _sendMessage(namespace, payloadJson) {
    const message = this._encodeMessage(
      "sender-0",
      "receiver-0",
      namespace,
      payloadJson
    );
    this._transport.send(message);
  }

  async _sendRequest(namespace, payloadJson, requestId) {
    return new Promise((resolve, reject) => {
      this._requestCallbacks.set(requestId, {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this._requestCallbacks.delete(requestId);
          reject(new Error("Request timeout"));
        }, 10000),
      });
      this._sendMessage(namespace, payloadJson);
    });
  }

  _handleMessage(msgBytes) {
    try {
      console.log("CastDevice: Decoding message of", msgBytes.length, "bytes");
      const decoded = this._decodeMessage(msgBytes);
      console.log("CastDevice: Decoded message:", {
        namespace: decoded.namespace,
        source: decoded.source_id,
        dest: decoded.destination_id,
        payloadLength: decoded.payload?.length || 0,
      });
      const payload = JSON.parse(decoded.payload);

      console.log(
        "CastDevice: Received:",
        decoded.namespace,
        payload.type || payload
      );

      this._emit("_firstMessage");

      if (
        decoded.namespace === "urn:x-cast:com.google.cast.tp.heartbeat" &&
        payload.type === "PING"
      ) {
        const pong = JSON.stringify({ type: "PONG" });
        this._sendMessage(decoded.namespace, pong);
      }

      if (payload.requestId && this._requestCallbacks.has(payload.requestId)) {
        const { resolve, timeout } = this._requestCallbacks.get(
          payload.requestId
        );
        clearTimeout(timeout);
        this._requestCallbacks.delete(payload.requestId);
        resolve(payload);
      }
    } catch (error) {
      console.error("CastDevice: Error handling message:", error);
    }
  }

  _encodeMessage(sourceId, destinationId, namespace, payloadJson) {
    const message = {
      protocol_version: 0,
      source_id: sourceId,
      destination_id: destinationId,
      namespace,
      payload_type: 0,
      payload_utf8: payloadJson,
    };

    console.log("CastDevice: Encoding message:", {
      namespace,
      payload: payloadJson,
    });
    const encoded = this._encodeProtobuf(message);
    console.log("CastDevice: Encoded to", encoded.length, "bytes");
    const hexDump = Array.from(encoded.slice(0, Math.min(50, encoded.length)))
      .map(b => b.toString(16).padStart(2, "0"))
      .join(" ");
    console.log("CastDevice: First bytes (hex):", hexDump);
    return encoded;
  }

  _decodeMessage(bytes) {
    return this._decodeProtobuf(bytes);
  }

  _encodeProtobuf(message) {
    const encoder = new TextEncoder();
    const buffers = [];

    function writeVarint(value) {
      const varint = [];
      while (value > 127) {
        varint.push((value & 0x7f) | 0x80);
        value >>= 7;
      }
      varint.push(value & 0x7f);
      return new Uint8Array(varint);
    }

    function writeString(fieldNumber, value) {
      const encoded = encoder.encode(value);
      const tag = (fieldNumber << 3) | 2;
      buffers.push(writeVarint(tag));
      buffers.push(writeVarint(encoded.length));
      buffers.push(encoded);
    }

    function writeEnum(fieldNumber, value) {
      const tag = (fieldNumber << 3) | 0;
      buffers.push(writeVarint(tag));
      buffers.push(writeVarint(value));
    }

    writeEnum(1, message.protocol_version);
    writeString(2, message.source_id);
    writeString(3, message.destination_id);
    writeString(4, message.namespace);
    writeEnum(5, message.payload_type);
    if (message.payload_utf8) {
      writeString(6, message.payload_utf8);
    }

    const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of buffers) {
      result.set(buf, offset);
      offset += buf.length;
    }

    return result;
  }

  _decodeProtobuf(bytes) {
    const decoder = new TextDecoder();
    let offset = 0;

    function readVarint() {
      let value = 0;
      let shift = 0;
      while (offset < bytes.length) {
        const byte = bytes[offset++];
        value |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) {
          break;
        }
        shift += 7;
      }
      return value;
    }

    function readString() {
      const length = readVarint();
      const str = decoder.decode(bytes.slice(offset, offset + length));
      offset += length;
      return str;
    }

    const message = {};

    while (offset < bytes.length) {
      const tag = readVarint();
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      if (wireType === 0) {
        const value = readVarint();
        if (fieldNumber === 1) {
          message.protocol_version = value;
        } else if (fieldNumber === 5) {
          message.payload_type = value;
        }
      } else if (wireType === 2) {
        const str = readString();
        if (fieldNumber === 2) {
          message.source_id = str;
        } else if (fieldNumber === 3) {
          message.destination_id = str;
        } else if (fieldNumber === 4) {
          message.namespace = str;
        } else if (fieldNumber === 6) {
          message.payload = str;
        }
      }
    }

    return message;
  }

  async disconnect() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    if (this._transport) {
      this._transport.close();
      this._transport = null;
    }

    this.state = "disconnected";
    this._emit("stateChanged", this.state);
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
