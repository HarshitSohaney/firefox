import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const { ctypes } = ChromeUtils.importESModule(
  "resource://gre/modules/ctypes.sys.mjs"
);

let lib = null;
let cast_encode_message = null;
let cast_decode_message = null;
let cast_free_string = null;
let cast_free_buffer = null;

function initLibrary() {
  if (lib) {
    return;
  }

  try {
    lib = ctypes.open("XUL");

    cast_encode_message = lib.declare(
      "cast_encode_message",
      ctypes.default_abi,
      ctypes.bool,
      ctypes.char.ptr,
      ctypes.char.ptr,
      ctypes.char.ptr,
      ctypes.char.ptr,
      ctypes.uint8_t.ptr.ptr,
      ctypes.size_t.ptr
    );

    cast_decode_message = lib.declare(
      "cast_decode_message",
      ctypes.default_abi,
      ctypes.bool,
      ctypes.uint8_t.ptr,
      ctypes.size_t,
      ctypes.char.ptr.ptr,
      ctypes.char.ptr.ptr,
      ctypes.char.ptr.ptr,
      ctypes.char.ptr.ptr
    );

    cast_free_string = lib.declare(
      "cast_free_string",
      ctypes.default_abi,
      ctypes.void_t,
      ctypes.char.ptr
    );

    cast_free_buffer = lib.declare(
      "cast_free_buffer",
      ctypes.default_abi,
      ctypes.void_t,
      ctypes.uint8_t.ptr,
      ctypes.size_t
    );
  } catch (e) {
    console.error("Failed to initialize Cast FFI:", e);
    throw e;
  }
}

export const CastFFI = {
  encodeMessage(sourceId, destinationId, namespace, payloadJson) {
    initLibrary();

    const sourceIdCStr = ctypes.char.array()(sourceId);
    const destinationIdCStr = ctypes.char.array()(destinationId);
    const namespaceCStr = ctypes.char.array()(namespace);
    const payloadCStr = ctypes.char.array()(payloadJson);

    const outBuffer = ctypes.uint8_t.ptr();
    const outLen = ctypes.size_t();

    const success = cast_encode_message(
      sourceIdCStr,
      destinationIdCStr,
      namespaceCStr,
      payloadCStr,
      outBuffer.address(),
      outLen.address()
    );

    if (!success) {
      throw new Error("Failed to encode Cast message");
    }

    const len = outLen.value;
    const buffer = ctypes.cast(
      outBuffer.value,
      ctypes.uint8_t.array(len).ptr
    ).contents;

    const result = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      result[i] = buffer[i];
    }

    cast_free_buffer(outBuffer.value, len);

    return result;
  },

  decodeMessage(messageBytes) {
    initLibrary();

    const len = messageBytes.length;
    const buffer = ctypes.uint8_t.array(len)();
    for (let i = 0; i < len; i++) {
      buffer[i] = messageBytes[i];
    }

    const outSourceId = ctypes.char.ptr();
    const outDestinationId = ctypes.char.ptr();
    const outNamespace = ctypes.char.ptr();
    const outPayload = ctypes.char.ptr();

    const success = cast_decode_message(
      buffer,
      len,
      outSourceId.address(),
      outDestinationId.address(),
      outNamespace.address(),
      outPayload.address()
    );

    if (!success) {
      throw new Error("Failed to decode Cast message");
    }

    const result = {
      sourceId: outSourceId.value.readString(),
      destinationId: outDestinationId.value.readString(),
      namespace: outNamespace.value.readString(),
      payload: outPayload.value.readString(),
    };

    cast_free_string(outSourceId.value);
    cast_free_string(outDestinationId.value);
    cast_free_string(outNamespace.value);
    cast_free_string(outPayload.value);

    return result;
  },
};
