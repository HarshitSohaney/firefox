/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Child-side actor running in the content process during tab casting.
 * Provides viewport information and extracts video URLs from pages.
 */
export class CastTabChild extends JSWindowActorChild {
  getViewportInfo() {
    const win = this.contentWindow;
    if (!win) {
      return null;
    }

    return {
      scrollX: win.scrollX,
      scrollY: win.scrollY,
      innerWidth: win.innerWidth,
      innerHeight: win.innerHeight,
    };
  }

  extractYouTubeUrl() {
    const win = this.contentWindow;
    if (!win) {
      return null;
    }

    try {
      const videoElement = win.document.querySelector("video");
      if (!videoElement) {
        return null;
      }

      if (videoElement.src && !videoElement.src.startsWith("blob:")) {
        return videoElement.src;
      }

      const sources = videoElement.querySelectorAll("source");
      for (const source of sources) {
        if (source.src && !source.src.startsWith("blob:")) {
          return source.src;
        }
      }

      return null;
    } catch (e) {
      console.error("CastTabChild: Error extracting YouTube URL:", e);
      return null;
    }
  }

  receiveMessage(message) {
    switch (message.name) {
      case "CastTab:GetViewportInfo":
        return this.getViewportInfo();
      case "ExtractYouTubeUrl":
        return this.extractYouTubeUrl();
    }
    return null;
  }
}
