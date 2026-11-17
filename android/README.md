# Seeker for Android

A native Kotlin browser built on the system WebView (minSdk 24 / Android 7.0+).

- **Tabs** with a tab switcher, address bar (URLs or Seeker search), back/forward, desktop-site toggle, share.
- **Seeker search** on the new tab page, using the *same* `engine.js`, `nlp.js`, `sources.js`, `app.js`
  and `seeker.css` as the desktop app. They are copied from `../src/pages/seeker` at build time.
  `assets/seeker/android-bridge.js` provides `window.seeker` (search.fetch, newtab.get/set, history.top)
  through a WebMessageListener that only the bundled page's origin can reach.
- **Incognito tabs**: no history, and on WebView 110+ a separate profile (cookies, storage, cache)
  that is deleted when the last incognito tab closes. On older WebViews the app warns that
  cookies are shared.
- **Bookmarks and history** (searchable, can be cleared).
- **Download manager** styled like the desktop one: multi-connection segmented downloads with
  dynamic splitting, retries with backoff, pause/resume (it survives app restarts), a foreground
  service with per-download progress notifications and Pause/Resume/Cancel buttons, a list with
  filters, search, total speed, per-download speed/ETA/connections and a segment bar.
  Finished files go to *Downloads/Seeker* (Android 10+).

Not included yet: Tor (the desktop app bundles a Tor binary; Android would need tor-android/Orbot).

## Build

```bash
cd android
./gradlew testDebugUnitTest assembleDebug   # needs JDK 17+ and the Android SDK (platform 35)
# APK: app/build/outputs/apk/debug/app-debug.apk
```

CI: `.github/workflows/android.yml` builds the APK on pushes to `feat/android` (or when run by hand)
and uploads it as the `seeker-android-debug-apk` artifact.
