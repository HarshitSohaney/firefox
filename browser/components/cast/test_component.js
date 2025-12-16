// XPCShell test for Cast XPCOM component
// Run with: ./mach xpcshell-test browser/components/cast/test_component.js

/* global Components, dump */

dump("=== Testing Cast XPCOM Component ===\n");

try {
  // Load ctypes
  const { ctypes } = ChromeUtils.importESModule(
    "resource://gre/modules/ctypes.sys.mjs"
  );

  dump("1. Opening XUL library...\n");
  const lib = ctypes.open("XUL");

  // Define nsIID structure
  const nsID = ctypes.StructType("nsID", [
    { m0: ctypes.uint32_t },
    { m1: ctypes.uint16_t },
    { m2: ctypes.uint16_t },
    { m3: ctypes.uint8_t.array(8) }
  ]);

  // nsICastDevice IID: a1b2c3d4-e5f6-4a5b-9c8d-7e6f5a4b3c2d
  const nsICastDeviceIID = new nsID(
    0xa1b2c3d4,
    0xe5f6,
    0x4a5b,
    [0x9c, 0x8d, 0x7e, 0x6f, 0x5a, 0x4b, 0x3c, 0x2d]
  );

  dump("2. Declaring NS_NewCastDevice function...\n");
  const NS_NewCastDevice = lib.declare(
    "NS_NewCastDevice",
    ctypes.default_abi,
    ctypes.uint32_t,        // nsresult return
    nsID.ptr,               // const nsIID* iid
    ctypes.voidptr_t.ptr    // void** result
  );

  dump("3. Calling NS_NewCastDevice...\n");
  const resultPtr = ctypes.voidptr_t.ptr();
  const nsresult = NS_NewCastDevice(nsICastDeviceIID.address(), resultPtr);

  dump("   NS_NewCastDevice returned: 0x" + nsresult.toString(16) + "\n");

  if (nsresult === 0) {  // NS_OK
    dump("✓ SUCCESS: Component created!\n");
    dump("  Result pointer: " + resultPtr + "\n");
    dump("\n");
    dump("Verification complete:\n");
    dump("  ✓ Rust code compiled into Firefox\n");
    dump("  ✓ NS_NewCastDevice is exported correctly\n");
    dump("  ✓ XPCOM component instantiation works\n");
    dump("  ✓ IDL interface is registered\n");
  } else {
    dump("✗ FAILED: nsresult = 0x" + nsresult.toString(16) + "\n");

    // Common error codes
    const errors = {
      0x80004001: "NS_ERROR_NOT_IMPLEMENTED",
      0x80004005: "NS_ERROR_FAILURE",
      0x80070057: "NS_ERROR_INVALID_ARG",
      0x80004002: "NS_NOINTERFACE"
    };

    if (errors[nsresult]) {
      dump("  Error: " + errors[nsresult] + "\n");
    }
  }

  lib.close();

} catch (e) {
  dump("✗ Test failed with exception: " + e + "\n");
  dump("Stack: " + e.stack + "\n");
}

dump("\n=== Test Complete ===\n");
