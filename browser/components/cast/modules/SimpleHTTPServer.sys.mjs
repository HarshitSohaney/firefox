/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimal HTTP server for streaming video to Cast devices.
 * Supports chunked transfer encoding and CORS headers.
 */
export class SimpleHTTPServer {
  constructor() {
    this.serverSocket = null;
    this.port = 0;
    this.handlers = new Map();
    this.activeConnections = new Set();
  }

  onSocketAccepted(serverSocket, transport) {
    const connection = {
      transport,
      outputStream: null,
      inputStream: null,
    };

    this.activeConnections.add(connection);

    try {
      connection.outputStream = transport.openOutputStream(0, 0, 0);
      connection.inputStream = transport
        .openInputStream(0, 8192, 1024)
        .QueryInterface(Ci.nsIAsyncInputStream);

      const self = this;
      connection.inputStream.asyncWait(
        {
          onInputStreamReady(stream) {
            self.handleRequest(connection, stream);
          },
        },
        0,
        0,
        Services.tm.mainThread
      );
    } catch (e) {
      console.error("SimpleHTTPServer: Error setting up connection:", e);
      this.closeConnection(connection);
    }
  }

  handleRequest(connection, inputStream) {
    try {
      const scriptableStream = Cc[
        "@mozilla.org/scriptableinputstream;1"
      ].createInstance(Ci.nsIScriptableInputStream);
      scriptableStream.init(inputStream);

      const available = scriptableStream.available();
      if (available === 0) {
        this.closeConnection(connection);
        return;
      }

      const requestData = scriptableStream.read(available);

      const requestLines = requestData.split("\r\n");
      const requestLine = requestLines[0];
      const [method, path] = requestLine.split(" ");

      if (method === "OPTIONS") {
        this.sendOptionsResponse(connection);
        return;
      }

      if (method === "HEAD") {
        this.sendHeadResponse(connection);
        return;
      }

      const handler = this.handlers.get(path);
      if (handler) {
        handler(connection, method);
      } else {
        this.send404(connection);
      }
    } catch (e) {
      console.error("SimpleHTTPServer: Error handling request:", e);
      this.closeConnection(connection);
    }
  }

  onStopListening(_serverSocket, _status) {}

  registerPathHandler(path, handler) {
    this.handlers.set(path, handler);
  }

  start(port = 0) {
    this.serverSocket = Cc[
      "@mozilla.org/network/server-socket;1"
    ].createInstance(Ci.nsIServerSocket);

    try {
      this.serverSocket.initDualStack(port, 4);
      this.port = this.serverSocket.port;

      const self = this;
      this.serverSocket.asyncListen({
        onSocketAccepted(socket, transport) {
          self.onSocketAccepted(socket, transport);
        },
        onStopListening(socket, status) {
          self.onStopListening(socket, status);
        },
      });

      return this.port;
    } catch (e) {
      console.error("SimpleHTTPServer: Failed to start server:", e);
      throw e;
    }
  }

  sendOptionsResponse(connection) {
    try {
      const response =
        "HTTP/1.1 200 OK\r\n" +
        "Access-Control-Allow-Origin: *\r\n" +
        "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n" +
        "Access-Control-Allow-Headers: Content-Type, Range\r\n" +
        "Access-Control-Max-Age: 86400\r\n" +
        "Content-Length: 0\r\n" +
        "\r\n";
      connection.outputStream.write(response, response.length);
      this.closeConnection(connection);
    } catch (e) {
      console.error("SimpleHTTPServer: Error sending OPTIONS response:", e);
    }
  }

  sendHeadResponse(connection) {
    try {
      const response =
        "HTTP/1.1 200 OK\r\n" +
        "Content-Type: video/webm\r\n" +
        "Cache-Control: no-cache, no-store, must-revalidate\r\n" +
        "Connection: keep-alive\r\n" +
        "Access-Control-Allow-Origin: *\r\n" +
        "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n" +
        "Access-Control-Allow-Headers: Content-Type, Range\r\n" +
        "Access-Control-Expose-Headers: Content-Length, Content-Range\r\n" +
        "\r\n";
      connection.outputStream.write(response, response.length);
      this.closeConnection(connection);
    } catch (e) {
      console.error("SimpleHTTPServer: Error sending HEAD response:", e);
    }
  }

  send404(connection) {
    try {
      const response = "HTTP/1.1 404 Not Found\r\n\r\n";
      connection.outputStream.write(response, response.length);
      this.closeConnection(connection);
    } catch (e) {
      console.error("SimpleHTTPServer: Error sending 404:", e);
    }
  }

  closeConnection(connection) {
    try {
      if (connection.outputStream) {
        connection.outputStream.close();
      }
      if (connection.inputStream) {
        connection.inputStream.close();
      }
      this.activeConnections.delete(connection);
    } catch (e) {
      console.error("SimpleHTTPServer: Error closing connection:", e);
    }
  }

  stop() {
    if (this.serverSocket) {
      this.serverSocket.close();
      this.serverSocket = null;
    }

    for (const connection of this.activeConnections) {
      this.closeConnection(connection);
    }
  }

  getLocalHostname() {
    try {
      const dnsService = Services.dns;
      let hostname = dnsService.myHostName;
      if (hostname && hostname.length) {
        if (!hostname.endsWith(".local")) {
          hostname += ".local";
        }
        console.warn(`SimpleHTTPServer: Got hostname: ${hostname}`);
        return hostname;
      }
    } catch (e) {
      console.error("SimpleHTTPServer: Error getting hostname:", e);
    }

    return null;
  }

  getLocalIP(castDeviceIP = null) {
    if (!castDeviceIP) {
      return "192.168.1.100";
    }

    const parts = castDeviceIP.split(".");
    if (parts.length === 4) {
      const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
      return `${subnet}.153`;
    }

    return "192.168.1.100";
  }
}
