#!/usr/bin/env python3
"""Regenerate android/app/src/main/assets/shield.js from the desktop shield (src/preload/tab-preload.js)."""
import os
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
src = open(os.path.join(root, 'src/preload/tab-preload.js')).read()
a = src.index('// SHIELD-START'); b = src.index('// SHIELD-END')
body = src[a + len('// SHIELD-START\n'):b]
def rep(old, new):
    global body
    assert old in body, 'desktop shield changed, update gen_shield.py: ' + old[:60]
    body = body.replace(old, new)
rep("""        if (noise) { if ('platformVersion' in out) out.platformVersion = '10.0.0'; if ('model' in out) out.model = ''; if ('architecture' in out) out.architecture = 'x86'; if ('bitness' in out) out.bitness = '64'; }\n""",
    """        if (noise && 'model' in out) out.model = 'K';\n""")
rep("""  if (!noise) return;\n""", """  // ---- Android extras: Global Privacy Control, and no WebRTC while routed through Tor/proxy (UDP would bypass it)
  if (o.gpc) { try { Object.defineProperty(win.Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true }); } catch { /* */ } }
  if (o.noRtc) {
    for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) { try { delete win[k]; Object.defineProperty(win, k, { value: undefined, configurable: false }); } catch { /* */ } }
  }
  if (!noise) return;\n""")
rep("return 'Google Inc. (Intel)'", "return 'Qualcomm'")
rep("return 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)'", "return 'Adreno (TM) 740'")
rep("const buckets = [[1366, 768], [1536, 864], [1920, 1080], [2560, 1440], [3840, 2160]];",
    "// common phone screens (CSS px), portrait; landscape is mirrored\n  const portrait = win.screen.height >= win.screen.width;\n  const buckets = [[360, 800], [384, 854], [393, 873], [412, 915], [430, 932], [480, 1067], [600, 1024], [800, 1280]].map(([w, hh]) => (portrait ? [w, hh] : [hh, w]));")
rep("getter(SP, 'availHeight', () => sh - 40);", "getter(SP, 'availHeight', () => sh);")
out = """// Seeker Privacy Shield for Android. Generated from the desktop src/preload/tab-preload.js
// (SHIELD-START..SHIELD-END) with phone values instead of Windows ones: Adreno GPU strings,
// phone screen sizes, plus Global Privacy Control and WebRTC removal in Tor/proxy mode.
// Injected at document start into every frame by MainActivity (addDocumentStartJavaScript).
// Regenerate with: python3 android/tools/gen_shield.py
(function () {
'use strict';
""" + body + """try { seekerShield(/*CFG*/{}/*CFG*/); } catch (e) { /* never break the page */ }
})();
"""
open(os.path.join(root, 'android/app/src/main/assets/shield.js'), 'w').write(out)
print('wrote shield.js')
