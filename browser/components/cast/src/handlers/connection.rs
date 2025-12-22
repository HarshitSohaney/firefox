/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::constants::namespaces;
use crate::messages::ConnectionMessage;

pub struct ConnectionHandler;

impl ConnectionHandler {
    pub const NAMESPACE: &'static str = namespaces::CONNECTION;

    pub fn create_connect_message() -> String {
        serde_json::to_string(&ConnectionMessage::CONNECT).unwrap()
    }

    pub fn create_close_message() -> String {
        serde_json::to_string(&ConnectionMessage::CLOSE).unwrap()
    }
}
