/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export class CastAudioCaptureChild extends JSWindowActorChild {
  constructor() {
    super();
    this._audioContext = null;
    this._stream = null;
    this._capturing = false;
    this._scriptProcessor = null;
    this._pendingMessages = 0;
  }

  receiveMessage(message) {
    switch (message.name) {
      case "CastAudioCapture:Start":
        return this.startCapture();
      case "CastAudioCapture:Stop":
        return this.stopCapture();
    }
    return null;
  }

  async startCapture() {
    if (this._capturing) {
      return { success: true, alreadyCapturing: true };
    }

    try {
      const constraints = {
        audio: { mediaSource: "audioCapture" },
        video: false,
      };

      const getUserMediaPromise =
        this.contentWindow.navigator.mediaDevices.getUserMedia(constraints);
      const timeoutPromise = new Promise((_, reject) => {
        this.contentWindow.setTimeout(
          () => reject(new Error("getUserMedia timeout")),
          5000
        );
      });

      this._stream = await Promise.race([getUserMediaPromise, timeoutPromise]);

      if (!this._stream || this._stream.getAudioTracks().length === 0) {
        return { success: false, error: "No audio tracks in stream" };
      }

      // Create AudioContext at 48kHz for Opus
      this._audioContext = new this.contentWindow.AudioContext({
        sampleRate: 48000,
      });
      const sampleRate = this._audioContext.sampleRate;

      // Resume if needed
      if (this._audioContext.state === "suspended") {
        await this._audioContext.resume();
      }

      // Create source from stream
      this._source = this._audioContext.createMediaStreamSource(this._stream);

      // Use ScriptProcessorNode for consistent audio capture
      // Buffer size of 1024 at 48kHz = ~21ms per callback
      const bufferSize = 1024;
      this._scriptProcessor = this._audioContext.createScriptProcessor(
        bufferSize,
        1, // mono input (from audioCapture)
        1  // mono output
      );

      this._capturing = true;
      this._pendingMessages = 0;

      this._scriptProcessor.onaudioprocess = event => {
        if (!this._capturing) {
          return;
        }

        // Throttle if too many pending messages
        if (this._pendingMessages > 10) {
          return;
        }

        // Copy channel data using copyFromChannel
        const inputBuffer = event.inputBuffer;
        const monoData = new this.contentWindow.Float32Array(inputBuffer.length);
        inputBuffer.copyFromChannel(monoData, 0);

        // Use waiveXrays to access TypedArray data without Xray restrictions
        const monoUnwrapped = Cu.waiveXrays(monoData);

        // Duplicate mono to stereo for Opus encoder
        const stereoSamples = new Float32Array(monoUnwrapped.length * 2);
        for (let i = 0; i < monoUnwrapped.length; i++) {
          stereoSamples[i * 2] = monoUnwrapped[i];
          stereoSamples[i * 2 + 1] = monoUnwrapped[i];
        }

        this._pendingMessages++;
        this.sendAsyncMessage("CastAudioCapture:AudioData", {
          samples: Array.from(stereoSamples),
          sampleRate,
        });

        // Decrement pending after a short delay
        this.contentWindow.setTimeout(() => {
          this._pendingMessages--;
        }, 50);
      };

      // Connect: source -> scriptProcessor -> destination
      // Must connect to destination for onaudioprocess to fire
      this._source.connect(this._scriptProcessor);
      this._scriptProcessor.connect(this._audioContext.destination);

      return { success: true, sampleRate };
    } catch (e) {
      console.error("CastAudioCapture: startCapture failed:", e);
      return { success: false, error: e.message };
    }
  }

  stopCapture() {
    this._capturing = false;

    if (this._scriptProcessor) {
      this._scriptProcessor.onaudioprocess = null;
      this._scriptProcessor.disconnect();
      this._scriptProcessor = null;
    }

    if (this._source) {
      this._source.disconnect();
      this._source = null;
    }

    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }

    if (this._audioContext) {
      this._audioContext.close().catch(() => {});
      this._audioContext = null;
    }

    return { success: true };
  }

  didDestroy() {
    this.stopCapture();
  }
}
