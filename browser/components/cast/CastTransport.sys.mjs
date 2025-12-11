export class CastTransport {
  constructor(host, port = 8009) {
    this._host = host;
    this._port = port;
    this._socket = null;
    this._receiveBuffer = new Uint8Array(0);
    this._eventListeners = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this._socket = new TCPSocket(this._host, this._port, {
        useSecureTransport: true,
        binaryType: "arraybuffer",
      });

      this._socket.onopen = () => {
        console.log("CastTransport: Connected to", this._host);
        this._emit("connected");
        resolve();
      };

      this._socket.ondata = event => {
        console.log(
          "CastTransport: Received data:",
          event.data.byteLength,
          "bytes"
        );
        this._handleData(new Uint8Array(event.data));
      };

      this._socket.onerror = event => {
        const errorMsg = `Socket error: ${event.name || "Unknown"} - ${
          event.message || "No message"
        } (code: ${event.errorCode || "N/A"})`;
        console.error("CastTransport: Error details:", errorMsg);
        console.error("CastTransport: Full event:", event);
        this._emit("error", event);
        reject(new Error(errorMsg));
      };

      this._socket.onclose = () => {
        console.log("CastTransport: Closed");
        this._emit("close");
      };
    });
  }

  send(messageBytes) {
    if (!this._socket) {
      throw new Error("Socket not connected");
    }

    if (this._socket.readyState !== "open") {
      throw new Error(`Socket not open (state: ${this._socket.readyState})`);
    }

    const length = messageBytes.length;
    const frame = new Uint8Array(4 + length);
    new DataView(frame.buffer).setUint32(0, length, false);
    frame.set(messageBytes, 4);

    this._socket.send(frame.buffer);
    console.log("CastTransport: Sent message:", length, "bytes");
  }

  _handleData(data) {
    const newBuffer = new Uint8Array(
      this._receiveBuffer.length + data.length
    );
    newBuffer.set(this._receiveBuffer);
    newBuffer.set(data, this._receiveBuffer.length);
    this._receiveBuffer = newBuffer;

    while (this._receiveBuffer.length >= 4) {
      const length = new DataView(this._receiveBuffer.buffer).getUint32(
        0,
        false
      );

      if (this._receiveBuffer.length < 4 + length) {
        break;
      }

      const message = this._receiveBuffer.slice(4, 4 + length);
      this._receiveBuffer = this._receiveBuffer.slice(4 + length);

      console.log("CastTransport: Received message:", length, "bytes");
      this._emit("message", message);
    }
  }

  close() {
    if (this._socket) {
      this._socket.close();
      this._socket = null;
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
          console.error("CastTransport: Error in event listener:", error);
        }
      }
    }
  }
}
