/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

pub const CAST_PORT: i32 = 8009;
pub const DEFAULT_MEDIA_RECEIVER_APP_ID: &str = "CC1AD845";
pub const SENDER_ID: &str = "sender-0";
pub const RECEIVER_ID: &str = "receiver-0";

pub mod namespaces {
    pub const CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
    pub const HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
    pub const RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
    pub const MEDIA: &str = "urn:x-cast:com.google.cast.media";
}
