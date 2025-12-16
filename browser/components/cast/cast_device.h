/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef _cast_device_h_
#define _cast_device_h_

#include "nsISupportsUtils.h"

// {a1b2c3d4-e5f6-4a5b-9c8d-7e6f5a4b3c2d}
#define NS_CAST_DEVICE_CID \
  {0xa1b2c3d4, 0xe5f6, 0x4a5b, {0x9c, 0x8d, 0x7e, 0x6f, 0x5a, 0x4b, 0x3c, 0x2d}}

extern "C" {
nsresult NS_NewCastDevice(REFNSIID iid, void** result);
};

#endif  // _cast_device_h_
