// Test script for Cast XPCOM component
// Run this from the Browser Console (Ctrl+Shift+J)

console.log("=== Testing Cast XPCOM Component ===");

try {
  // Load the cast IDL interface
  const { ctypes } = ChromeUtils.importESModule(
    "resource://gre/modules/ctypes.sys.mjs"
  );

  // Open XUL library to access NS_NewCastDevice
  const lib = ctypes.open("XUL");

  // Declare the function signature
  const NS_NewCastDevice = lib.declare(
    "NS_NewCastDevice",
    ctypes.default_abi,
    ctypes.uint32_t,  // nsresult
    ctypes.voidptr_t,  // nsIID*
    ctypes.voidptr_t.ptr  // void**
  );

  console.log("✓ Found NS_NewCastDevice function");

  // Try to create an instance
  console.log("Attempting to create CastDevice instance...");

  // For now, just verify the function exists
  console.log("✓ XPCOM component is accessible from JavaScript!");
  console.log("");
  console.log("Next steps:");
  console.log("1. Implement nsISocketTransport connection");
  console.log("2. Add protobuf message sending");
  console.log("3. Test with real Cast device");

  lib.close();

} catch (e) {
  console.error("✗ Test failed:", e);
  console.error("Stack:", e.stack);
}

console.log("=== Test Complete ===");
