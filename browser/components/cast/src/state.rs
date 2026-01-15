/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use nsstring::nsCString;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceState {
    Disconnected,
    Connecting,
    Connected,
    Launching,
    Streaming,
    Error,
}

impl DeviceState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Disconnected => "disconnected",
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Launching => "launching",
            Self::Streaming => "streaming",
            Self::Error => "error",
        }
    }

    pub fn to_nscstring(&self) -> nsCString {
        nsCString::from(self.as_str())
    }
}

impl fmt::Display for DeviceState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}
