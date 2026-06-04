/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export class FileFlowParent extends JSWindowActorParent {
  #qrId = null;
  #onSidebarFile = null;

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
    win.dispatchEvent(
      new win.CustomEvent("FileFlow:SessionStarted", {
        detail: { qrId: this.#qrId },
      })
    );

    this.#onSidebarFile = event => {
      const { bytes, contentType, filename } = event.detail;
      this.sendAsyncMessage("FileFlow:FileReady", {
        bytes,
        filename,
        contentType,
      });
      win.removeEventListener("FileFlow:SidebarFileReady", this.#onSidebarFile);
      this.#onSidebarFile = null;
      win.SidebarController.hide();
    };
    win.addEventListener("FileFlow:SidebarFileReady", this.#onSidebarFile);
  }

  didDestroy() {
    if (this.#onSidebarFile) {
      const win = this.browsingContext.topChromeWindow;
      win?.removeEventListener(
        "FileFlow:SidebarFileReady",
        this.#onSidebarFile
      );
      this.#onSidebarFile = null;
    }
  }
}
