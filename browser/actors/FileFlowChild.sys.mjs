/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export class FileFlowChild extends JSWindowActorChild {
  #pendingInput = null;
  #observer = null;

  static #IMAGE_EXTENSIONS = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp",
    ".svg",
    ".avif",
    ".ico",
    ".heif",
    ".heic",
    ".tiff",
    ".tif",
  ]);

  actorCreated() {
    this.#observer = {
      observe: subject => this.#onPickerOpening(subject),
      QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
    };
    Services.obs.addObserver(this.#observer, "file-input-picker-opening");
  }

  didDestroy() {
    if (this.#observer) {
      try {
        Services.obs.removeObserver(
          this.#observer,
          "file-input-picker-opening"
        );
      } catch (e) {}
      this.#observer = null;
    }
  }

  handleEvent() {}

  #onPickerOpening(subject) {
    if (subject?.ownerDocument !== this.document) {
      return;
    }
    if (subject.type === "file" && this.#acceptsImages(subject)) {
      subject.setAttribute("data-file-picker-intercepted", "true");
      this.#pendingInput = subject;
      this.sendAsyncMessage("FileFlow:InputClicked");
    }
  }

  #acceptsImages(input) {
    const accept = input.getAttribute("accept");
    if (!accept) {
      return true;
    }
    return accept.split(",").some(token => {
      const t = token.trim().toLowerCase();
      return t.startsWith("image") || FileFlowChild.#IMAGE_EXTENSIONS.has(t);
    });
  }

  receiveMessage(message) {
    switch (message.name) {
      case "FileFlow:FileReady":
        this.#injectFile(message.data);
        break;
    }
  }

  #injectFile({ bytes, filename, contentType }) {
    if (!this.#pendingInput) {
      return;
    }
    const array = new Uint8Array(bytes);
    const contentFile = new this.contentWindow.File(
      [Cu.cloneInto(array, this.contentWindow)],
      filename,
      Cu.cloneInto({ type: contentType }, this.contentWindow)
    );
    this.#pendingInput.mozSetFileArray([contentFile]);
    this.#pendingInput.dispatchEvent(
      new this.contentWindow.Event("change", { bubbles: true })
    );
    this.#pendingInput = null;
  }
}
