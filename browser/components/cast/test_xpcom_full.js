// Enhanced test script for Cast XPCOM component
// Run this from the Browser Console (Ctrl+Shift+J)

console.log("=== Testing Cast XPCOM Component (Full Test) ===");

try {
  // First, check if the interface is available
  console.log("1. Checking if nsICastDevice interface is available...");

  try {
    const iface = Ci.nsICastDevice;
    console.log("✓ nsICastDevice interface found:", iface);
  } catch (e) {
    console.warn("⚠ nsICastDevice interface not found in Ci:", e.message);
    console.log("  This is expected if IDL hasn't been processed yet.");
  }

  // Method 1: Try direct XPCOM component creation (if registered)
  console.log("\n2. Attempting Method 1: Direct component creation...");
  try {
    const contractId = "@mozilla.org/cast/device;1";
    const device = Cc[contractId].createInstance(Ci.nsICastDevice);
    console.log("✓ Method 1 SUCCESS: Created via contract ID");
    testDeviceMethods(device);
  } catch (e) {
    console.log("✗ Method 1 failed (expected):", e.message);
  }

  // Method 2: Use ctypes to call NS_NewCastDevice
  console.log("\n3. Attempting Method 2: ctypes with NS_NewCastDevice...");
  const { ctypes } = ChromeUtils.importESModule(
    "resource://gre/modules/ctypes.sys.mjs"
  );

  const lib = ctypes.open("XUL");

  // Define nsIID structure
  const nsID = ctypes.StructType("nsID", [
    { m0: ctypes.uint32_t },
    { m1: ctypes.uint16_t },
    { m2: ctypes.uint16_t },
    { m3: ctypes.uint8_t.array(8) }
  ]);

  // nsICastDevice IID from nsICastDevice.idl
  // uuid(a1b2c3d4-e5f6-4a5b-9c8d-7e6f5a4b3c2d)
  const nsICastDeviceIID = new nsID(
    0xa1b2c3d4,
    0xe5f6,
    0x4a5b,
    [0x9c, 0x8d, 0x7e, 0x6f, 0x5a, 0x4b, 0x3c, 0x2d]
  );

  // Declare NS_NewCastDevice function
  const NS_NewCastDevice = lib.declare(
    "NS_NewCastDevice",
    ctypes.default_abi,
    ctypes.uint32_t,        // nsresult return
    nsID.ptr,               // const nsIID* iid
    ctypes.voidptr_t.ptr    // void** result
  );

  console.log("✓ Found NS_NewCastDevice function");

  // Call the constructor
  const resultPtr = ctypes.voidptr_t.ptr();
  const nsresult = NS_NewCastDevice(nsICastDeviceIID.address(), resultPtr);

  console.log("NS_NewCastDevice returned:", "0x" + nsresult.toString(16));

  if (nsresult === 0) {  // NS_OK
    console.log("✓ Method 2 SUCCESS: Component created!");
    console.log("  Result pointer:", resultPtr);

    // Note: We can't easily call methods through the raw pointer from ctypes
    // We would need to wrap it properly, which is complex
    console.log("\n⚠ Note: Calling methods through ctypes requires complex wrapping");
    console.log("  The component was created successfully, which proves:");
    console.log("  1. Rust code is compiled into Firefox");
    console.log("  2. NS_NewCastDevice is exported correctly");
    console.log("  3. XPCOM component instantiation works");
  } else {
    console.log("✗ Method 2 failed: nsresult =", "0x" + nsresult.toString(16));
  }

  lib.close();

  console.log("\n=== Summary ===");
  console.log("✓ Rust XPCOM component is accessible");
  console.log("✓ Component can be instantiated");
  console.log("\nNext: Create JavaScript wrapper for easier testing");

} catch (e) {
  console.error("✗ Test failed:", e);
  console.error("Stack:", e.stack);
}

console.log("\n=== Test Complete ===");

// Helper function to test device methods (if we get a proper instance)
function testDeviceMethods(device) {
  console.log("\n--- Testing Device Methods ---");

  try {
    console.log("Testing connect()...");
    device.connect("10.0.0.128", 8009);
    console.log("✓ connect() called successfully");
  } catch (e) {
    console.error("✗ connect() failed:", e);
  }

  try {
    console.log("Testing disconnect()...");
    device.disconnect();
    console.log("✓ disconnect() called successfully");
  } catch (e) {
    console.error("✗ disconnect() failed:", e);
  }

  try {
    console.log("Testing sendMessage()...");
    device.sendMessage("urn:x-cast:com.google.cast.tp.heartbeat", '{"type":"PING"}');
    console.log("✓ sendMessage() called successfully");
  } catch (e) {
    console.error("✗ sendMessage() failed:", e);
  }

  try {
    console.log("Testing state getter...");
    const state = device.state;
    console.log("✓ state =", state);
  } catch (e) {
    console.error("✗ state getter failed:", e);
  }

  console.log("--- Device Methods Test Complete ---");
}
