/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Custom error type for Cast operations.
 * Includes error cause code and supports serialization for IPC.
 */
export class CastError extends Error {
  name = "CastError";

  constructor(message, cause) {
    super(message, { cause });
  }

  toMsg() {
    return {
      exn: CastError.name,
      message: this.message,
      cause: this.cause,
      stack: this.stack,
    };
  }

  static fromMsg(serialized) {
    const error = new CastError(serialized.message, serialized.cause);
    error.stack = serialized.stack;
    return error;
  }
}
