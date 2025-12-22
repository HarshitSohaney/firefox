/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const CAST_ERRORS = Object.freeze({
  NONE: 0,
  UNINITIALIZED: 1,
  DEVICE_NOT_FOUND: 2,
  CONNECTION_FAILED: 3,
  CERTIFICATE_INVALID: 4,
  LAUNCH_APP_FAILED: 5,
  MEDIA_LOAD_FAILED: 6,
  CAPTURE_FAILED: 7,
  ENCODING_FAILED: 8,
  NETWORK_ERROR: 9,
  TIMEOUT: 10,
  ALREADY_CONNECTED: 11,
  NOT_CONNECTED: 12,
  INVALID_STATE: 13,
  INVALID_URL: 14,
  UNKNOWN: 99,
});

export function castErrorString(errorCodeToLookup) {
  for (const [errorName, errorCode] of Object.entries(CAST_ERRORS)) {
    if (errorCode == errorCodeToLookup) {
      return errorName;
    }
  }
  return "UNDEFINED_ERROR";
}

export const CAST_STATES = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  LAUNCHING: "launching",
  STREAMING: "streaming",
  ERROR: "error",
  DISCONNECTING: "disconnecting",
});

// Default media receiver id
export const CAST_APP_IDS = Object.freeze({
  DEFAULT_MEDIA_RECEIVER: "CC1AD845",
});

export const CAST_NAMESPACES = Object.freeze({
  CONNECTION: "urn:x-cast:com.google.cast.tp.connection",
  HEARTBEAT: "urn:x-cast:com.google.cast.tp.heartbeat",
  RECEIVER: "urn:x-cast:com.google.cast.receiver",
  MEDIA: "urn:x-cast:com.google.cast.media",
});

export const DEFAULT_CAST_PORT = 8009;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10000;
