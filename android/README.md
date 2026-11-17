# Seeker for Android

A native Kotlin browser built on the system WebView. Runs on Android 7.0+ (minSdk 24) and is built
for Android 16 (compile/target SDK 36). It has no native code, so it works on 16 KB page-size
devices such as the Pixel 10 series. Edge-to-edge and predictive back are supported.

## Install on a phone

Open **https://github.com/amitogpandori/seeker-browser/releases/tag/android-v1.0.0** on the phone
and tap `Seeker-Android-1.0.0.apk`. Allow "Install unknown apps" for your browser or Files app
when Android asks. Every build is signed with the same release key, so a new build installs over
the old one and keeps your data.

## Features (same as the desktop app where Android allows it)

- **Seeker search.** The new-tab page uses the *same* `engine.js`, `nlp.js`, `sources.js`, `app.js`
  and `seeker.css` as the desktop app; they are copied from `../src/pages/seeker` at build time.
  - The page reaches native code through `window.seeker` (`assets/seeker/android-bridge.js`): search.fetch,
    newtab.get/set, history.top and localindex.search.
  - The bridge is a WebMessageListener that only the bundled page's origin can reach.
  - New-tab shortcuts can be edited.
  - Page memory makes pages you've read searchable. It stays on the phone and skips incognito, login and banking pages.
- **AI assistant.** It uses the desktop providers: OpenRouter (free and paid models), Groq, Gemini, OpenAI,
  Anthropic, Ollama or LM Studio on your PC over the LAN, and any OpenAI-compatible server.
  - Answers stream in as they are written.
  - Page actions: summarise, key points, explain simply, translate.
  - "Ask AI" on selected text; type `? question` in the address bar.
  - API keys are encrypted with an Android Keystore key.
  - In Tor mode only local AI is allowed.
- **Privacy Shield** (`Privacy.kt`, `Shield.kt`, `assets/shield.js`):
  - Ad and tracker blocking.
  - Anti-fingerprinting script: canvas, WebGL, audio, hardware and screen noise.
    `shield.js` is generated from the desktop shield with phone values: `python3 tools/gen_shield.py`.
  - Link cleaning (tracking parameters and redirect wrappers).
  - Third-party cookie blocking and Global Privacy Control.
  - "Forget sites when you close them", per-site Shield off, and Forget this site / Forget everything.
  - A Shield panel with a per-page blocked count.
- **Tor / proxy** (`Route.kt`): all WebViews and the app's own requests (search, downloads, AI) go
  through Orbot or your proxy using ProxyController.
  - **Fails closed:** until the route is up, everything goes to a dead proxy.
  - WebRTC is disabled while routed.
- **Download manager.**
  - Multi-connection segmented downloads with dynamic splitting and retries.
  - Pause/resume that survives restarts, a queue (1–6 at once) and 1–16 connections.
  - Global and per-file speed limits.
  - Batch download (`[01-20]`), refresh an expired link, and SHA-256 checksums.
  - Categories, search, and an offer to download copied file links.
  - A video/HLS grabber (`.m3u8` saved as `.ts`; DRM streams are refused).
  - A foreground service with notifications. Files go to *Downloads/Seeker* through MediaStore.
- **Browser features.**
  - Tabs, incognito (a separate WebView profile, wiped on close), bookmarks and history (import/export bookmarks HTML).
  - Find in page, print or save as PDF, reopen closed tab, desktop site, share, error page.
  - Gestures: swipe the address bar to switch tabs, pull to refresh.
  - A Settings screen.
- **Google sign-in.**
  - The user agent and UA client hints look like Chrome, without the WebView "wv" marks.
  - Optional: "Sign in with Google in a secure sheet" (Custom Tab).

## Build

```bash
cd android
./gradlew testDebugUnitTest lintRelease assembleDebug   # JDK 17+ (21 recommended), Android SDK platform 36
```

Release signing comes from environment variables (`SEEKER_KEYSTORE`, `SEEKER_KEYSTORE_PASSWORD`,
`SEEKER_KEY_ALIAS`, `SEEKER_KEY_PASSWORD`). Without them, `assembleRelease` uses the debug key.
The keystore is **never committed**.

CI (`.github/workflows/android.yml`) runs on pushes to `feat/android` or by hand. It:
1. Runs the tests and lint.
2. Builds the release APK signed with the key from the repository secrets.
3. Verifies the APK: apksigner v2+v3, `zipalign -c -P 16`, target SDK, no `lib/`.
4. Publishes it to the **android-v&lt;version&gt;** GitHub Release as a prerelease. It is never "latest",
   so the desktop auto-updater and the Windows releases are unaffected.
