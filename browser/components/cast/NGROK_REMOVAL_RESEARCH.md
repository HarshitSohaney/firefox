# Removing ngrok Dependency - Research & Solutions

## Problem Statement

Currently, Firefox Cast tab streaming uses ngrok to create a public HTTPS tunnel because we believed Chromecast blocks RFC 1918 private IPs.

**Current Implementation:**
```javascript
const streamURL = "https://unobscenely-keyed-tatiana.ngrok-free.dev/stream.webm";
```

This is not viable for production because:
1. Requires users to install and run ngrok
2. ngrok free tier has limitations (time limits, connection limits)
3. Privacy concerns - all video data passes through ngrok servers
4. Unreliable (ngrok URLs change, service could be down)

## Research Findings

### Key Discovery: Cast Devices SUPPORT Private IPs by Default

**IMPORTANT**: Research shows that Cast devices **DO** support RFC 1918 private IP addresses by default. The security restriction works the opposite way:
- ✅ **Allowed by default**: RFC1918/RFC4193 private addresses (192.168.x.x, 10.x.x.x, etc.)
- ❌ **Blocked by default**: Publicly routable IP addresses

Source: [Chrome Enterprise MediaRouterCastAllowAllIPs Policy](https://admx.help/?Category=Chrome&Policy=Google.Policies.Chrome::MediaRouterCastAllowAllIPs)

### Why Does Our Current Implementation Need ngrok?

The reason we need ngrok currently is NOT because Cast blocks private IPs. The real issue is likely one of:

1. **Same-origin/CORS issues** - Cast devices might require HTTPS for security
2. **Certificate validation** - Cast might reject self-signed certificates on local IPs
3. **mDNS hostname resolution** - Cast devices expect `.local` hostnames instead of bare IPs
4. **Initial implementation assumption** - We assumed private IPs wouldn't work without testing

## Solution Options

### Option 1: Use mDNS .local Hostname (RECOMMENDED)

Chromecast devices use mDNS for service discovery and expect `.local` hostnames.

**How Chrome Does It:**
- Cast devices advertise as `{friendlyName}._googlecast._tcp.local`
- Example: `Upstairs-Chromecast.local` resolves to `192.168.0.52:8009`
- All cast communication happens over these `.local` names

**Implementation for Firefox:**
1. Register an mDNS service: `firefox-cast-{sessionId}.local`
2. Advertise on `_http._tcp.local` with port 8010
3. Use URL: `http://firefox-cast-{sessionId}.local:8010/stream.webm`

**Pros:**
- ✅ No external dependencies
- ✅ Works entirely on local network
- ✅ Standard Cast protocol approach
- ✅ No privacy concerns
- ✅ No HTTPS certificate issues

**Cons:**
- ❌ Requires implementing mDNS registration in Firefox
- ❌ Need to check if Firefox has mDNS support built-in
- ❌ mDNS might not work across VLANs (but neither does current discovery)

**Firefox Components Needed:**
- Search for existing mDNS support in `netwerk/` directory
- May need to use system APIs (Bonjour on macOS, Avahi on Linux, Windows APIs)

### Option 2: Test Direct Private IP Access

Since Cast devices DO support private IPs, we should test if our implementation works with a direct IP.

**Test:**
```javascript
const localIP = "192.168.1.100"; // Replace with actual local IP
const streamURL = `http://${localIP}:8010/stream.webm`;
```

**Why This Might Work:**
- HTTP LIVE streaming doesn't require HTTPS
- CORS headers are already set correctly
- Cast devices allow private IP connections

**Why This Might Fail:**
- Cast might still require hostname resolution
- Some Cast security policies might enforce hostname checks

**Action:** Try this first as it requires zero code changes!

### Option 3: Self-Signed Certificate + Trust Configuration

If Cast requires HTTPS but blocks self-signed certs:

**Implementation:**
1. Generate self-signed certificate for local IP
2. Configure Firefox to trust it
3. Use `https://${localIP}:8010/stream.webm`

**Pros:**
- ✅ Provides HTTPS if needed
- ✅ No external services

**Cons:**
- ❌ Cast device needs to trust certificate
- ❌ Complex certificate management
- ❌ Might not work due to Cast OS restrictions

### Option 4: Mozilla-Hosted Relay Service

If local networking truly doesn't work:

**Implementation:**
- Firefox establishes WebSocket to Mozilla relay server
- Cast device connects to relay server
- Server proxies video stream between Firefox and Cast

**Pros:**
- ✅ Guaranteed to work across any network
- ✅ Could work across different networks (e.g., mobile hotspot)

**Cons:**
- ❌ Requires Mozilla infrastructure
- ❌ Privacy concerns (video goes through Mozilla servers)
- ❌ Bandwidth costs for Mozilla
- ❌ Latency increase

## Recommended Implementation Plan

### Phase 1: Test Direct Private IP (IMMEDIATE)
1. Remove ngrok URL hardcoding
2. Get local IP using existing `getLocalIP()` method
3. Test with: `http://${localIP}:8010/stream.webm`
4. Verify if Cast device can connect

**If this works**: Problem solved! No further work needed.

### Phase 2: Implement mDNS Hostname (IF NEEDED)
1. Research Firefox's mDNS capabilities
   - Check `netwerk/dns/` directory
   - Look for Bonjour/Avahi integration
2. Implement mDNS service registration
   - Register `firefox-cast-{id}.local` hostname
   - Point to local IP on port 8010
3. Use mDNS hostname in stream URL
4. Test with Cast device

### Phase 3: Fallback Options (IF STILL NEEDED)
- Try HTTPS with self-signed certificate
- Consider Mozilla relay service (last resort)

## Network Requirements

According to Google's documentation:
- Sender needs routable path to receiver TCP ports 8008-8009 (control)
- Sender needs routable path to receiver UDP ports 1-65535 (streaming)

Our HTTP server on port 8010 should be accessible if:
- ✅ Firefox and Cast device on same WiFi network
- ✅ No firewall blocking port 8010
- ✅ Router allows LAN-to-LAN communication

## Next Steps

1. **Immediate**: Test direct private IP approach (change 1 line of code)
2. **If fails**: Investigate why (capture network logs from Cast device)
3. **Research**: Check Firefox's mDNS support in codebase
4. **Implement**: mDNS registration if needed
5. **Document**: Final solution in HTTP_STREAMING_SUCCESS.md

## Questions to Answer

- [ ] Does Firefox have built-in mDNS support?
- [ ] Can we use system mDNS APIs (dns-sd on macOS, Avahi on Linux)?
- [ ] Does Cast device require hostname vs IP for HTTP streaming?
- [ ] Does Cast device require HTTPS for custom streaming URLs?
- [ ] What exactly fails when we use a private IP directly?

## References

- [Chrome Enterprise Cast Policy](https://admx.help/?Category=Chrome&Policy=Google.Policies.Chrome::MediaRouterCastAllowAllIPs)
- [Cisco Chromecast mDNS Configuration](https://www.cisco.com/c/en/us/support/docs/wireless-mobility/wireless-mobility/119017-config-chromecast-mdns-wlc-00.html)
- [Chromecast Implementation Documentation](https://github.com/jloutsenhizer/CR-Cast/wiki/Chromecast-Implementation-Documentation-WIP)
- [Magic of Chromecast Under the Hood](https://imdeepika.medium.com/magic-of-chromecast-under-the-hood-f7418d895bd3)
