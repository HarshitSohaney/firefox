/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef mozilla_browser_cast_audio_capture_h
#define mozilla_browser_cast_audio_capture_h

#include "nsISupports.h"

extern "C" {

nsresult NS_NewCastAudioCapture(const nsIID& aIID, void** aResult);
}

#endif
