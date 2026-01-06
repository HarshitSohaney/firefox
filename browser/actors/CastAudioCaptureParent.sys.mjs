/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export class CastAudioCaptureParent extends JSWindowActorParent {
  constructor() {
    super();
    this._audioCallback = null;
  }

  setAudioCallback(callback) {
    this._audioCallback = callback;
  }

  receiveMessage(message) {
    switch (message.name) {
      case "CastAudioCapture:AudioData":
        if (this._audioCallback) {
          this._audioCallback(message.data.samples);
        }
        break;
    }
  }
}
