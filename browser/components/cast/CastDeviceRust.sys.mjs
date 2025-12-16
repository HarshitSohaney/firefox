// JavaScript wrapper for Rust XPCOM CastDevice component

export class CastDeviceRust {
  constructor(id, address, port = 8009) {
    this._id = id;
    this._address = address;
    this._port = port;
    this._rustComponent = null;

    console.log(`CastDeviceRust: Creating wrapper for ${address}:${port}`);

    // Try to create the Rust XPCOM component
    try {
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

      // nsICastDevice IID from IDL
      const nsICastDeviceIID = new nsID(
        0xa1b2c3d4,
        0xe5f6,
        0x4a5b,
        [0x9c, 0x8d, 0x7e, 0x6f, 0x5a, 0x4b, 0x3c, 0x2d]
      );

      // Declare the function
      const NS_NewCastDevice = lib.declare(
        "NS_NewCastDevice",
        ctypes.default_abi,
        ctypes.uint32_t,
        nsID.ptr,
        ctypes.voidptr_t.ptr
      );

      // Call it
      const resultPtr = ctypes.voidptr_t.ptr();
      const nsresult = NS_NewCastDevice(nsICastDeviceIID.address(), resultPtr);

      console.log(`CastDeviceRust: NS_NewCastDevice returned: 0x${nsresult.toString(16)}`);

      if (nsresult === 0) {
        console.log("CastDeviceRust: ✓ Rust component created successfully!");
        this._rustComponent = resultPtr;
      } else {
        console.warn("CastDeviceRust: ✗ Failed to create Rust component");
        console.warn(`  Error code: 0x${nsresult.toString(16)}`);
        console.warn("  Common error codes:");
        console.warn("    0x80004001 = NS_ERROR_NOT_IMPLEMENTED");
        console.warn("    0x80004002 = NS_NOINTERFACE");
        console.warn("    0x80004005 = NS_ERROR_FAILURE");
        console.warn("    0x80070057 = NS_ERROR_INVALID_ARG");
      }

      lib.close();
    } catch (e) {
      console.error("CastDeviceRust: Exception creating Rust component:", e);
      console.error("Stack:", e.stack);
    }
  }

  get id() {
    return this._id;
  }

  get address() {
    return this._address;
  }

  async connect() {
    console.log(`CastDeviceRust: connect() called for ${this._address}:${this._port}`);

    if (!this._rustComponent) {
      throw new Error("Rust component not initialized");
    }

    // For now, just test that we can call it
    // In the future, we'll call the actual Rust connect() method via XPCOM
    console.log("CastDeviceRust: Rust component exists, connection would happen here");

    // Placeholder
    return { success: true, message: "Rust component initialized" };
  }

  async disconnect() {
    console.log("CastDeviceRust: disconnect() called");
  }

  async sendMessage(namespace, payload) {
    console.log(`CastDeviceRust: sendMessage(${namespace}, ${payload})`);
  }
}
