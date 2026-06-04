/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const FILEFLOW_BASE = "https://fileflow.harshitsohaney.com";
const POLL_INTERVAL_MS = 2000;

export class FileFlowParent extends JSWindowActorParent {
  #pollTimer = null;
  #qrId = null;

  receiveMessage(message) {
    if (message.name === "FileFlow:InputClicked") {
      this.#handleInputClicked();
    }
  }

  async #handleInputClicked() {
    const win = this.browsingContext.topChromeWindow;
    if (!win) {
      return;
    }
    this.#qrId = crypto.randomUUID();
    await win.SidebarController.show("viewFilesSidebar");

    const detail = { qrId: this.#qrId };
    win.dispatchEvent(
      new win.CustomEvent("FileFlow:SessionStarted", { detail })
    );

    this.#startPolling();
  }

  #startPolling() {
    this.#stopPolling();
    const poll = async () => {
      this.#pollTimer = null;
      try {
        const resp = await fetch(`${FILEFLOW_BASE}/status/${this.#qrId}`);
        if (resp.ok) {
          const data = await resp.json();
          if (data.ready) {
            await this.#fetchAndSendFile();
            return;
          }
        }
      } catch {
        // Network error; retry on next interval.
      }
      this.#pollTimer = lazy.setTimeout(poll, POLL_INTERVAL_MS);
    };
    this.#pollTimer = lazy.setTimeout(poll, POLL_INTERVAL_MS);
  }

  #stopPolling() {
    if (this.#pollTimer) {
      lazy.clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  async #fetchAndSendFile() {
    try {
      const resp = await fetch(`${FILEFLOW_BASE}/file/${this.#qrId}`);
      if (!resp.ok) {
        return;
      }
      const contentType = resp.headers.get("content-type") || "image/png";
      const blob = await resp.blob();
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      const filename = `fileflow-image.${this.#extensionFromMime(contentType)}`;

      this.sendAsyncMessage("FileFlow:FileReady", {
        bytes,
        filename,
        contentType,
      });

      const win = this.browsingContext.topChromeWindow;
      if (win) {
        win.dispatchEvent(
          new win.CustomEvent("FileFlow:FileReceived", {
            detail: { bytes, contentType, filename },
          })
        );
        win.SidebarController.hide();
      }
    } catch {
      // File fetch failed; caller can retry if needed.
    }
  }

  #extensionFromMime(mime) {
    const map = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/svg+xml": "svg",
    };
    return map[mime] || "png";
  }

  didDestroy() {
    this.#stopPolling();
  }
}
