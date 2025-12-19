# Cast Component Reorganization

This document describes the reorganization of the Cast component to follow Firefox conventions similar to BackupService.

## New Directory Structure

```
browser/components/cast/
├── CastService.sys.mjs          # Main singleton service
├── content/                     # UI content
│   └── browser-cast.js          # Browser UI integration
├── modules/                     # Core functionality modules
│   ├── CastConstants.mjs        # Constants and error codes
│   ├── CastDevice.sys.mjs       # Device management
│   ├── CastError.mjs            # Custom error class
│   ├── CastMediaHandler.sys.mjs # Media control protocol
│   ├── CastSession.sys.mjs      # Casting session management
│   └── SimpleHTTPServer.sys.mjs # HTTP server for streaming
├── actors/                      # JSWindowActors
│   ├── CastTabChild.sys.mjs     # Child process actor
│   └── CastTabParent.sys.mjs    # Parent process actor
├── src/                         # Rust implementation
│   ├── cast_device.rs
│   ├── video_encoder.rs
│   └── ...
├── nsICastDevice.idl            # XPCOM interface
├── nsICastVideoEncoder.idl      # XPCOM interface
├── components.conf              # XPCOM component registration
└── moz.build                    # Build configuration
```

## Key Changes

### 1. Main Service (CastService.sys.mjs)

Created a singleton service following BackupService patterns:

```javascript
export class CastService extends EventTarget {
  static #instance = null;

  static init() { ... }
  static uninit() { ... }
  static get() { ... }

  get state() { ... }
  stateUpdate() { ... }

  async addManualDevice(ipAddress, port) { ... }
  async startTabCasting(deviceId, browser, window, options) { ... }
  async stopCasting() { ... }
}

export const gCastService = CastService.init();
```

Features:
- Singleton pattern with proper lifecycle management
- State management with event dispatching
- Lazy console logging with preference-based log levels
- Clean API surface replacing old CastServiceWrapper

### 2. Error Handling (CastError.mjs)

Custom error class with serialization support:

```javascript
export class CastError extends Error {
  name = "CastError";

  constructor(message, cause) {
    super(message, { cause });
  }

  toMsg() { ... }
  static fromMsg(serialized) { ... }
}
```

### 3. Constants (CastConstants.mjs)

Centralized constants:

```javascript
export const CAST_ERRORS = Object.freeze({ ... });
export const CAST_STATES = Object.freeze({ ... });
export const CAST_NAMESPACES = Object.freeze({ ... });
export const CAST_APP_IDS = Object.freeze({ ... });
```

### 4. Module Improvements

All modules now use:
- Lazy console logging with proper prefixes
- Preference-based debug logging (`browser.cast.log`)
- Proper error handling with CastError
- Firefox coding conventions (minimal comments)

### 5. Renamed Components

- `CastTabSession.sys.mjs` → `CastSession.sys.mjs`
- `CastServiceWrapper.sys.mjs` → `CastService.sys.mjs` (rewritten)

## Firefox Patterns Applied

1. **Singleton Service Pattern**
   - Static `init()`, `uninit()`, `get()` methods
   - Single instance management
   - Proper cleanup on uninit

2. **Lazy Initialization**
   - `ChromeUtils.defineLazyGetter` for console
   - `ChromeUtils.defineESModuleGetters` for module imports

3. **State Management**
   - Immutable state objects via `Object.freeze(structuredClone())`
   - Event dispatching via `EventTarget`
   - `stateUpdate()` notifications

4. **Error Handling**
   - Custom error class with cause codes
   - Worker serialization support
   - Consistent error messages

5. **Logging**
   - Lazy console instances
   - Prefixed logging per module
   - Preference-based log levels

6. **Module Organization**
   - Clear separation of concerns
   - Logical folder structure
   - Proper import/export patterns

## Migration Notes

### Old API → New API

```javascript
// Old
const { gCastService } = ChromeUtils.importESModule(
  "resource:///modules/cast/CastServiceWrapper.sys.mjs"
);
gCastService.init();
const discovery = gCastService.getDeviceDiscovery();
await discovery.addManualDevice(ip);

// New
const { gCastService } = ChromeUtils.importESModule(
  "resource:///modules/cast/CastService.sys.mjs"
);
// Already initialized via module singleton
await gCastService.addManualDevice(ip);
```

### Import Paths

All cast modules are now under `resource:///modules/cast/`:

```javascript
import { CastError } from "resource:///modules/cast/CastError.mjs";
import { CAST_ERRORS, CAST_STATES } from "resource:///modules/cast/CastConstants.mjs";
import { CastDevice } from "resource:///modules/cast/CastDevice.sys.mjs";
```

## Build Configuration

The moz.build file has been updated with the new structure. Note that files must be listed in alphabetical order (case-insensitive):

```python
EXTRA_JS_MODULES.cast = [
    "actors/CastTabChild.sys.mjs",
    "actors/CastTabParent.sys.mjs",
    "CastService.sys.mjs",
    "modules/CastConstants.mjs",
    "modules/CastDevice.sys.mjs",
    "modules/CastError.mjs",
    "modules/CastMediaHandler.sys.mjs",
    "modules/CastSession.sys.mjs",
    "modules/SimpleHTTPServer.sys.mjs",
]
```

## Benefits

1. **Maintainability**: Clear structure makes code easier to understand and modify
2. **Consistency**: Follows established Firefox patterns (BackupService, etc.)
3. **Modularity**: Clean separation between UI, core logic, and actors
4. **Debuggability**: Improved logging with proper prefixes and log levels
5. **Error Handling**: Consistent error reporting with typed error codes
6. **Testability**: Singleton pattern makes mocking easier in tests

## References

- BackupService: `browser/components/backup/BackupService.sys.mjs`
- BackupError: `browser/components/backup/BackupError.mjs`
- Constants pattern: `browser/components/backup/common/backup-constants.mjs`
