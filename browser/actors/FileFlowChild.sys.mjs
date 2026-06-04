/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export class FileFlowChild extends JSWindowActorChild {
  #pendingInput = null;
  #skipNextIntercept = false;
  #originalClick = null;

  actorCreated() {
    this.#patchClick();
  }

  didDestroy() {
    this.#restoreClick();
  }

  #patchClick() {
    let win = this.contentWindow;
    if (!win) {
      return;
    }
    let unwrapped = win.wrappedJSObject;
    let proto =
      unwrapped.HTMLInputElement && unwrapped.HTMLInputElement.prototype;
    if (!proto) {
      return;
    }

    this.#originalClick = Cu.unwaiveXrays(proto.click);

    let self = this;
    let original = this.#originalClick;
    Cu.exportFunction(
      function () {
        // Inside content scope, `this` is the HTMLInputElement.
        // Use xray wrapper to safely read properties.
        let input = Cu.waiveXrays(this);
        let xrayInput = Cu.unwaiveXrays(input);
        if (xrayInput.type === "file" && self.#acceptsImages(xrayInput)) {
          if (self.#skipNextIntercept) {
            self.#skipNextIntercept = false;
            original.call(xrayInput);
            return;
          }
          self.#pendingInput = xrayInput;
          self.sendAsyncMessage("FileFlow:InputClicked");
          return;
        }
        original.call(xrayInput);
      },
      proto,
      { defineAs: "click" }
    );
  }

  #restoreClick() {
    if (!this.#originalClick) {
      return;
    }
    let win = this.contentWindow;
    if (!win) {
      return;
    }
    let unwrapped = win.wrappedJSObject;
    let proto =
      unwrapped.HTMLInputElement && unwrapped.HTMLInputElement.prototype;
    if (!proto) {
      return;
    }
    Cu.exportFunction(this.#originalClick, proto, { defineAs: "click" });
    this.#originalClick = null;
  }

  handleEvent(event) {
    const target = event.target;
    if (
      target.tagName === "INPUT" &&
      target.type === "file" &&
      this.#acceptsImages(target)
    ) {
      if (this.#skipNextIntercept) {
        this.#skipNextIntercept = false;
        return;
      }
      event.preventDefault();
      this.#pendingInput = target;
      this.sendAsyncMessage("FileFlow:InputClicked");
    }
  }

  #acceptsImages(input) {
    const accept = input.getAttribute("accept");
    if (!accept) {
      return true;
    }
    return accept.includes("image");
  }

  receiveMessage(message) {
    switch (message.name) {
      case "FileFlow:FileReady":
        this.#injectFile(message.data);
        break;
      case "FileFlow:OpenPicker":
        this.#openNativePicker();
        break;
    }
  }

  #openNativePicker() {
    if (!this.#pendingInput) {
      return;
    }
    this.#skipNextIntercept = true;
    this.#pendingInput.click();
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
