package com.seeker.browser

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.print.PrintAttributes
import android.print.PrintManager
import android.view.ActionMode
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.Menu
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.webkit.ProfileStore
import androidx.webkit.ScriptHandler
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import com.seeker.browser.downloads.Downloads
import com.seeker.browser.downloads.DownloadsActivity
import org.json.JSONArray
import java.net.URI
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs

class Tab(val web: WebView, val incognito: Boolean) {
    var title = "New Tab"
    @Volatile var url = ""
    var progress = 100
    /** the site (registrable domain) shown now, for "forget sites when closed" */
    var site = ""
    var shield: ScriptHandler? = null
    var shieldCfg = ""
    val blocked = AtomicInteger()
    /** video streams/files seen on this page (media grabber) */
    val media: MutableSet<String> = java.util.Collections.synchronizedSet(LinkedHashSet())
    var errorUrl: String? = null
    var loadingError = false
}

class MainActivity : AppCompatActivity() {
    companion object {
        const val EXTRA_OPEN = "open"
        private const val INCOGNITO_PROFILE = "seeker-incognito"
        private val MEDIA = Regex("\\.(m3u8|mp4|webm|m4v|mov|mkv|mp3|m4a)(\\?|$)", RegexOption.IGNORE_CASE)
        private val FILE_LINK = Regex("^https?://\\S+\\.(zip|rar|7z|apk|exe|msi|dmg|iso|pdf|mp4|mkv|webm|mp3|m4a|flac|tar|gz|xz|epub|docx?|xlsx?|pptx?)(\\?\\S*)?$", RegexOption.IGNORE_CASE)
    }

    private val tabs = mutableListOf<Tab>()
    private var current: Tab? = null
    private val closed = ArrayDeque<String>()
    private lateinit var root: View
    private lateinit var container: FrameLayout
    private lateinit var refresh: SwipeRefreshLayout
    private lateinit var address: EditText
    private lateinit var progress: ProgressBar
    private lateinit var tabCount: TextView
    private lateinit var toolbar: View
    private lateinit var incognitoIcon: ImageView
    private lateinit var incognitoBanner: TextView
    private lateinit var routeBanner: TextView
    private lateinit var findBar: LinearLayout
    private lateinit var findText: EditText
    private lateinit var findCount: TextView
    private val assets by lazy { WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build() }
    private val multiProfile by lazy { WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) }
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private var lastClip = 0L
    private val routeListener: () -> Unit = { onRouteChanged() }

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data)); fileCallback = null
    }
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val home get() = Prefs.homepage.takeIf { it.startsWith("http") } ?: SeekerBridge.HOME

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        root = findViewById(R.id.root)
        EdgeToEdge.apply(this, root)
        container = findViewById(R.id.webContainer)
        refresh = findViewById(R.id.refresh)
        address = findViewById(R.id.address)
        progress = findViewById(R.id.progress)
        tabCount = findViewById(R.id.tabCount)
        toolbar = findViewById(R.id.toolbar)
        incognitoIcon = findViewById(R.id.incognitoIcon)
        incognitoBanner = findViewById(R.id.incognitoBanner)
        routeBanner = findViewById(R.id.routeBanner)
        findBar = findViewById(R.id.findBar)
        findText = findViewById(R.id.findText)
        findCount = findViewById(R.id.findCount)

        // a crash or force-stop can leave incognito data behind: wipe it at start
        if (multiProfile) try { ProfileStore.getInstance().deleteProfile(INCOGNITO_PROFILE) } catch (e: Exception) { /* none */ }

        address.setOnEditorActionListener { _, id, ev ->
            if (id == EditorInfo.IME_ACTION_GO || ev?.keyCode == KeyEvent.KEYCODE_ENTER) { navigate(address.text.toString()); true } else false
        }
        address.setOnFocusChangeListener { _, has -> if (!has) showAddress() }
        tabCount.setOnClickListener { showTabs() }
        findViewById<ImageButton>(R.id.menuBtn).setOnClickListener { showMenu(it) }
        setupGestures()
        setupFind()

        refresh.setColorSchemeColors(ContextCompat.getColor(this, R.color.accent))
        refresh.setOnChildScrollUpCallback { _, _ -> (current?.web?.scrollY ?: 0) > 0 || customView != null }
        refresh.setOnRefreshListener { current?.web?.reload(); refresh.postDelayed({ refresh.isRefreshing = false }, 900) }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val t = current
                when {
                    customView != null -> customCallback?.onCustomViewHidden()
                    findBar.visibility == View.VISIBLE -> closeFind()
                    t != null && t.web.canGoBack() -> t.web.goBack()
                    tabs.size > 1 && t != null -> closeTab(t)
                    else -> moveTaskToBack(true)
                }
            }
        })

        Route.addListener(routeListener)
        if (Route.routed && Route.state == Route.State.DIRECT) Route.apply(this)
        onRouteChanged()

        if (!handleIntent(intent) && Prefs.restoreTabs) restoreSession()
        if (tabs.isEmpty()) newTab(home, false)
        if (Prefs.autoResume) Downloads.autoResume()
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); handleIntent(intent) }

    private fun handleIntent(i: Intent?): Boolean {
        i ?: return false
        i.getStringExtra(EXTRA_OPEN)?.let { current?.web?.loadUrl(it) ?: newTab(it, false); return true }
        if (i.action == Intent.ACTION_WEB_SEARCH) i.getStringExtra("query")?.let { newTab(SeekerBridge.searchUrl(it), false); return true }
        if (i.action == Intent.ACTION_VIEW) i.dataString?.takeIf { it.startsWith("http") }?.let { newTab(Shield.clean(it) ?: it, false); return true }
        if (i.action == Intent.ACTION_SEND) i.getStringExtra(Intent.EXTRA_TEXT)?.trim()?.let { t ->
            val link = Regex("https?://\\S+").find(t)?.value
            newTab(link?.let { Shield.clean(it) ?: it } ?: SeekerBridge.searchUrl(t), false); return true
        }
        return false
    }

    override fun onResume() {
        super.onResume()
        applySettings()
    }

    /** Settings may have changed: refresh shield scripts, cookies and user agent on every tab. */
    private fun applySettings() {
        val cfg = Shield.configJson()
        tabs.forEach { t ->
            if (t.shieldCfg != cfg) { t.shield = Shield.install(t.web, t.shield); t.shieldCfg = cfg }
            CookieManager.getInstance().setAcceptThirdPartyCookies(t.web, !Prefs.blockThirdPartyCookies)
            applyUserAgent(t.web)
        }
        refresh.isEnabled = Prefs.gesturePullRefresh
        onRouteChanged()
    }

    override fun onPause() {
        super.onPause()
        val urls = JSONArray()
        tabs.filter { !it.incognito && it.url.startsWith("http") || (!it.incognito && SeekerBridge.isSeekerUrl(it.url)) }.forEach { urls.put(it.url) }
        getSharedPreferences("seeker", MODE_PRIVATE).edit().putString("session", urls.toString())
            .putInt("sessionActive", tabs.filter { !it.incognito }.indexOf(current).coerceAtLeast(0)).apply()
        CookieManager.getInstance().flush()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) checkClipboard()
    }

    /** "Offer to download copied links": only when a new clip appears, and only for links to files. */
    private fun checkClipboard() {
        if (!Prefs.clipboardCatch || Build.VERSION.SDK_INT < 26) return
        val cm = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        val d = cm.primaryClipDescription ?: return
        if (d.timestamp == lastClip) return
        val first = lastClip == 0L
        lastClip = d.timestamp
        if (first && System.currentTimeMillis() - d.timestamp > 60_000) return
        if (!d.hasMimeType("text/*")) return
        val text = cm.primaryClip?.getItemAt(0)?.text?.toString()?.trim() ?: return
        if (!FILE_LINK.matches(text) || Downloads.items.any { it.url == text }) return
        Snackbar.make(container, "Download the copied link?", Snackbar.LENGTH_LONG).setAction("Download") { startDownload(current ?: return@setAction, text, null, null, null) }.show()
    }

    private fun restoreSession() {
        val p = getSharedPreferences("seeker", MODE_PRIVATE)
        val a = try { JSONArray(p.getString("session", "[]")) } catch (e: Exception) { JSONArray() }
        for (i in 0 until a.length()) newTab(a.getString(i), false, switch = false)
        tabs.getOrNull(p.getInt("sessionActive", 0))?.let { switchTo(it) }
    }

    // ------------------------------------------------------------------ gestures & find
    @SuppressLint("ClickableViewAccessibility")
    private fun setupGestures() {
        // swipe the address bar left/right to switch tabs (desktop: touchpad swipe / mouse gestures)
        val gd = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent) = true
            override fun onFling(e1: MotionEvent?, e2: MotionEvent, vx: Float, vy: Float): Boolean {
                if (!Prefs.gestureSwipeTabs || e1 == null || address.hasFocus() || tabs.size < 2) return false
                val dx = e2.x - e1.x; val dy = e2.y - e1.y
                if (abs(dx) < 120 || abs(dx) < 2 * abs(dy) || abs(vx) < 600) return false
                val i = tabs.indexOf(current)
                val next = if (dx < 0) (i + 1) % tabs.size else (i - 1 + tabs.size) % tabs.size
                switchTo(tabs[next])
                toast("${next + 1}/${tabs.size} · ${tabs[next].title}")
                return true
            }
        })
        val l = View.OnTouchListener { _, ev -> gd.onTouchEvent(ev); false }
        address.setOnTouchListener(l); toolbar.setOnTouchListener { v, ev -> gd.onTouchEvent(ev); if (ev.action == MotionEvent.ACTION_UP) v.performClick(); true }
    }

    private fun setupFind() {
        findText.setOnEditorActionListener { _, _, _ -> current?.web?.findNext(true); true }
        findText.addTextChangedListener(object : android.text.TextWatcher {
            override fun afterTextChanged(s: android.text.Editable?) { current?.web?.findAllAsync(s.toString()) }
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })
        findViewById<View>(R.id.findNext).setOnClickListener { current?.web?.findNext(true) }
        findViewById<View>(R.id.findPrev).setOnClickListener { current?.web?.findNext(false) }
        findViewById<View>(R.id.findClose).setOnClickListener { closeFind() }
    }
    private fun openFind() {
        findBar.visibility = View.VISIBLE; findText.requestFocus()
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(findText, 0)
        current?.web?.setFindListener { i, n, _ -> findCount.text = if (n == 0) "0/0" else "${i + 1}/$n" }
        if (findText.text.isNotEmpty()) current?.web?.findAllAsync(findText.text.toString())
    }
    private fun closeFind() {
        findBar.visibility = View.GONE; current?.web?.clearMatches(); findCount.text = ""
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(findText.windowToken, 0)
    }

    // ------------------------------------------------------------------ route (Tor / proxy)
    private fun onRouteChanged() {
        if (!::routeBanner.isInitialized) return
        val st = Route.state
        routeBanner.visibility = if (Route.routed) View.VISIBLE else View.GONE
        routeBanner.text = when (st) {
            Route.State.READY -> "🧅 " + Route.message
            Route.State.STARTING -> "⏳ " + Route.message + "  (nothing is sent until connected)"
            Route.State.FAILED -> "⚠ " + Route.message + "  · tap to retry"
            Route.State.DIRECT -> ""
        }
        routeBanner.setOnClickListener { if (st == Route.State.FAILED) { if (Route.isTor && Route.orbotInstalled(this)) Route.openOrbot(this); Route.apply(this) } }
        if (st == Route.State.READY) tabs.filter { it.errorUrl != null }.forEach { t -> t.errorUrl?.let { t.errorUrl = null; t.web.loadUrl(it) } }
    }

    // ------------------------------------------------------------------ tabs
    /** WebView's UA says "; wv" and "Version/4.0", which Google sign-in and some sites reject. */
    private val chromeMajor by lazy { Regex("Chrome/(\\d+)").find(WebSettings.getDefaultUserAgent(this))?.groupValues?.get(1) ?: "140" }
    private fun chromeUA(desktop: Boolean): String =
        if (desktop) "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$chromeMajor.0.0.0 Safari/537.36"
        else "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$chromeMajor.0.0.0 Mobile Safari/537.36"
    private val desktopMode = HashSet<WebView>()

    private fun applyUserAgent(web: WebView) {
        val desk = web in desktopMode
        val ua = if (Prefs.lookLikeChrome || desk) chromeUA(desk) else null
        if (web.settings.userAgentString != (ua ?: WebSettings.getDefaultUserAgent(this))) web.settings.userAgentString = ua
        if (WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA) && Prefs.lookLikeChrome) {
            val full = "$chromeMajor.0.0.0"
            WebSettingsCompat.setUserAgentMetadata(web.settings, UserAgentMetadata.Builder()
                .setBrandVersionList(listOf(
                    UserAgentMetadata.BrandVersion.Builder().setBrand("Google Chrome").setMajorVersion(chromeMajor).setFullVersion(full).build(),
                    UserAgentMetadata.BrandVersion.Builder().setBrand("Chromium").setMajorVersion(chromeMajor).setFullVersion(full).build(),
                    UserAgentMetadata.BrandVersion.Builder().setBrand("Not_A Brand").setMajorVersion("24").setFullVersion("24.0.0.0").build(),
                ))
                .setFullVersion(full).setMobile(!desk).setPlatform(if (desk) "Linux" else "Android").setPlatformVersion(if (desk) "" else "10.0.0").setModel("")
                .build())
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
    private fun createWebView(incognito: Boolean): WebView {
        val web = WebView(this)
        if (incognito && multiProfile) {
            ProfileStore.getInstance().getOrCreateProfile(INCOGNITO_PROFILE)
            WebViewCompat.setProfile(web, INCOGNITO_PROFILE)
        }
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = true
            displayZoomControls = false
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            if (incognito) cacheMode = WebSettings.LOAD_NO_CACHE
        }
        // (current WebView no longer sends the X-Requested-With app-id header, so nothing to strip)
        applyUserAgent(web)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, !Prefs.blockThirdPartyCookies)
        return web
    }

    private fun newTab(url: String, incognito: Boolean, switch: Boolean = true, opener: Tab? = null): Tab {
        if (incognito && !multiProfile && tabs.none { it.incognito }) {
            Toast.makeText(this, "This phone's WebView can't keep incognito cookies separate. History is still not saved.", Toast.LENGTH_LONG).show()
        }
        val web = createWebView(incognito)
        val tab = Tab(web, incognito)
        tab.shieldCfg = Shield.configJson()
        tab.shield = Shield.install(web, null)
        setupTab(tab)
        val at = opener?.let { tabs.indexOf(it) + 1 } ?: tabs.size
        tabs.add(at.coerceIn(0, tabs.size), tab)
        if (url.isNotEmpty()) web.loadUrl(url)
        if (switch || current == null) switchTo(tab) else updateChrome()
        return tab
    }

    private fun switchTo(tab: Tab) {
        if (findBar.visibility == View.VISIBLE) closeFind()
        current?.web?.let { container.removeView(it); it.onPause() }
        current = tab
        (tab.web.parent as? ViewGroup)?.removeView(tab.web)
        container.addView(tab.web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        tab.web.onResume()
        updateChrome()
    }

    private fun closeTab(tab: Tab) {
        val i = tabs.indexOf(tab)
        if (i < 0) return
        tabs.remove(tab)
        if (!tab.incognito && (tab.url.startsWith("http") || SeekerBridge.isSeekerUrl(tab.url))) { closed.addLast(tab.url); while (closed.size > 25) closed.removeFirst() }
        if (current == tab) {
            container.removeView(tab.web)
            current = null
            if (tabs.isEmpty()) newTab(home, false) else switchTo(tabs[(i - 1).coerceAtLeast(0).coerceAtMost(tabs.size - 1)])
        }
        desktopMode.remove(tab.web)
        tab.web.stopLoading(); tab.web.destroy()
        if (!tab.incognito) Shield.siteLeft(tab.site) { s -> tabs.any { it.site == s } }
        if (tab.incognito && tabs.none { it.incognito }) wipeIncognito()
        updateChrome()
    }

    private fun reopenClosed() {
        val u = closed.removeLastOrNull() ?: return toast("No recently closed tabs")
        newTab(u, false)
    }

    /** Last incognito tab closed: delete its cookies, storage and cache, and forget its downloads. */
    private fun wipeIncognito() {
        Downloads.forgetIncognito()
        if (multiProfile) container.postDelayed({
            try { ProfileStore.getInstance().deleteProfile(INCOGNITO_PROFILE) } catch (e: Exception) { /* still in use: wiped next start */ }
        }, 500)
    }

    private fun siteChanged(tab: Tab, url: String) {
        val s = if (url.startsWith("http")) Privacy.siteOf(Privacy.hostOf(url)) else ""
        if (s == tab.site) return
        val old = tab.site
        tab.site = s
        if (!tab.incognito && old.isNotEmpty()) Shield.siteLeft(old) { x -> tabs.any { it.site == x } }
    }

    private fun isGoogleSignIn(u: Uri) = u.host.equals("accounts.google.com", true)
    private fun openCustomTab(url: String) {
        try { CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, Uri.parse(url)) }
        catch (e: Exception) { toast("No browser for the sign-in sheet") }
    }

    private fun setupTab(tab: Tab) {
        val web = tab.web
        SeekerBridge.attach(web, { chromeUA(false) }, tab.incognito)
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                assets.shouldInterceptRequest(request.url)?.let { return it }
                val url = request.url.toString()
                // Tor/proxy chosen but this WebView can't be proxied: refuse everything rather than leak (fail closed)
                if (Route.routed && !Route.supported) return WebResourceResponse("text/html", "utf-8", 503, "Blocked",
                    emptyMap(), java.io.ByteArrayInputStream(if (request.isForMainFrame) ErrorPage.html(this@MainActivity, url, WebViewClient.ERROR_PROXY_AUTHENTICATION, "PROXY_UNSUPPORTED").toByteArray() else ByteArray(0)))
                if (!request.isForMainFrame && MEDIA.containsMatchIn(url) && tab.media.size < 50) tab.media.add(url)
                if (Shield.shouldBlock(url, tab.url, request.isForMainFrame)) { tab.blocked.incrementAndGet(); return Shield.blockedResponse() }
                return null
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                return when (u.scheme?.lowercase()) {
                    "http", "https" -> {
                        if (request.isForMainFrame && isGoogleSignIn(u) && Prefs.googleSignIn == "customtab") { openCustomTab(u.toString()); return true }
                        if (request.isForMainFrame && !request.isRedirect) Shield.clean(u.toString())?.let { view.loadUrl(it); return true }
                        false
                    }
                    "intent" -> {
                        try {
                            val i = Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME)
                            i.addCategory(Intent.CATEGORY_BROWSABLE); i.component = null; i.selector = null
                            try { startActivity(i) } catch (e: Exception) { i.getStringExtra("browser_fallback_url")?.takeIf { it.startsWith("http") }?.let { view.loadUrl(it) } }
                        } catch (e: Exception) { /* bad intent */ }
                        true
                    }
                    "mailto", "tel", "sms", "geo", "market", "whatsapp", "upi" -> {
                        try { startActivity(Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE)) } catch (e: Exception) { toast("No app can open this link") }
                        true
                    }
                    else -> true // javascript:, file:, content: … are never followed
                }
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                tab.url = url; tab.progress = 5
                if (tab.loadingError) tab.loadingError = false else tab.errorUrl = null
                if (!url.startsWith("data:")) { tab.blocked.set(0); tab.media.clear() }
                siteChanged(tab, url)
                if (tab == current) updateChrome()
            }

            override fun onPageFinished(view: WebView, url: String) {
                tab.url = url; tab.progress = 100
                tab.title = view.title?.takeIf { it.isNotBlank() } ?: tab.title
                if (tab == current) refresh.isRefreshing = false
                if (!tab.incognito && !SeekerBridge.isSeekerUrl(url) && tab.errorUrl == null) {
                    Store.recordVisit(url, tab.title)
                    if (Prefs.pageMemory && url.startsWith("http") && !Privacy.isSensitive(url)) {
                        view.evaluateJavascript("(document.body&&document.body.innerText||'').slice(0,20000)") { r ->
                            val text = try { org.json.JSONTokener(r).nextValue() as? String } catch (e: Exception) { null }
                            if (!text.isNullOrBlank()) Thread { PageMemory.add(url, tab.title, text) }.start()
                        }
                    }
                }
                if (tab == current) updateChrome()
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                tab.url = url
                siteChanged(tab, url)
                if (tab == current) updateChrome()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                val desc = error.description?.toString() ?: ""
                if (desc.contains("ERR_ABORTED") || error.errorCode == ERROR_UNSUPPORTED_SCHEME) return
                showError(tab, request.url.toString(), error.errorCode, desc)
            }

            @SuppressLint("WebViewClientOnReceivedSslError")
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()   // never proceed on a bad certificate
                if (error.url == tab.url || error.url == view.url || tab.progress < 100) showError(tab, error.url, -999, "ERR_CERT (${error.primaryError})")
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // the page crashed or Android reclaimed memory: replace this tab instead of crashing the app
                val url = tab.url; val i = tabs.indexOf(tab); val wasCurrent = tab == current
                tabs.remove(tab); if (wasCurrent) { container.removeView(view); current = null }
                try { view.destroy() } catch (e: Exception) { }
                val t = newTab(url, tab.incognito, switch = wasCurrent)
                tabs.remove(t); tabs.add(i.coerceIn(0, tabs.size), t)
                if (tabs.size == 1 || wasCurrent) switchTo(t)
                toast("The page crashed and was reloaded")
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, p: Int) { tab.progress = p; if (tab == current) updateProgress() }
            override fun onReceivedTitle(view: WebView, title: String?) {
                tab.title = title ?: tab.title
                if (!tab.incognito && tab.errorUrl == null) Store.updateTitle(view.url ?: "", tab.title)
                if (tab == current) updateChrome()
            }
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                if (!isUserGesture) return false // popups only from a tap
                val t = newTab("", tab.incognito, opener = tab)
                (resultMsg.obj as WebView.WebViewTransport).webView = t.web
                resultMsg.sendToTarget()
                return true
            }
            override fun onCloseWindow(window: WebView) { tabs.firstOrNull { it.web == window }?.let { closeTab(it) } }
            override fun onPermissionRequest(request: PermissionRequest) {
                // camera / microphone for websites: not supported (would need runtime permissions per site)
                request.deny()
            }
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                return try { pickFiles.launch(params.createIntent()); true } catch (e: Exception) { fileCallback = null; false }
            }
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                customView = view; customCallback = callback
                (window.decorView as ViewGroup).addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
            override fun onHideCustomView() {
                customView?.let { (window.decorView as ViewGroup).removeView(it) }
                customView = null; customCallback = null
            }
        }
        web.setDownloadListener { url, ua, cd, mime, _ -> startDownload(tab, url, ua, cd, mime) }
        web.setOnLongClickListener { linkMenu(tab) }
    }

    private fun showError(tab: Tab, url: String, code: Int, desc: String) {
        tab.errorUrl = url; tab.loadingError = true
        tab.web.loadDataWithBaseURL(url, ErrorPage.html(this, url, code, desc), "text/html", "utf-8", url)
    }

    private fun cookiesFor(tab: Tab, url: String): String? =
        if (tab.incognito && multiProfile) WebViewCompat.getProfile(tab.web).cookieManager.getCookie(url)
        else if (tab.incognito) null else CookieManager.getInstance().getCookie(url)

    private fun startDownload(tab: Tab, url: String, ua: String?, cd: String?, mime: String?, hls: Boolean = false) {
        if (!url.startsWith("http")) return toast("This kind of download (${url.substringBefore(':')}:) isn't supported")
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        try {
            val isHls = hls || Regex("\\.m3u8(\\?|$)", RegexOption.IGNORE_CASE).containsMatchIn(url) || mime?.contains("mpegurl", true) == true
            val name = if (isHls) (tab.title.ifBlank { "video" } + ".ts") else null
            val it = Downloads.add(url, fileName = name, mime = mime?.takeIf { m -> m.isNotBlank() && m != "application/octet-stream" && !isHls }, userAgent = ua ?: tab.web.settings.userAgentString,
                cookies = cookiesFor(tab, url), referrer = tab.url.takeIf { u -> u.startsWith("http") }, incognito = tab.incognito, contentDisposition = cd, hls = isHls)
            Snackbar.make(container, "Downloading ${it.fileName}", Snackbar.LENGTH_SHORT).setAction(R.string.downloads) { startActivity(Intent(this, DownloadsActivity::class.java)) }.show()
            if (tab.web.copyBackForwardList().size == 0 && tabs.size > 1) closeTab(tab) // a tab opened only for the download
        } catch (e: Exception) { toast(e.message ?: "Download failed") }
    }

    private fun linkMenu(tab: Tab): Boolean {
        val hit = tab.web.hitTestResult
        val link = hit.extra ?: return false
        val isImage = hit.type == WebView.HitTestResult.IMAGE_TYPE || hit.type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE
        val isLink = hit.type == WebView.HitTestResult.SRC_ANCHOR_TYPE || hit.type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE
        if (!isImage && !isLink) return false
        if (!link.startsWith("http")) return false
        val clean = Shield.clean(link) ?: link
        val opts = mutableListOf<Pair<String, () -> Unit>>()
        if (isLink) {
            opts += "Open in new tab" to { newTab(clean, tab.incognito, switch = false, opener = tab); toast("Opened in background") }
            if (!tab.incognito) opts += "Open in incognito tab" to { newTab(clean, true) }
            opts += "Download link" to { startDownload(tab, link, null, null, null) }
        }
        if (isImage) opts += "Download image" to { startDownload(tab, link, null, null, null) }
        opts += "Copy link" to {
            (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("link", clean)); toast(if (clean != link) "Clean link copied" else "Link copied")
        }
        opts += "Share link" to { startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, clean), null)) }
        if (isLink) opts += "Ask AI about this link" to { startActivity(Intent(this, AiActivity::class.java).putExtra(AiActivity.EXTRA_PROMPT, "What is likely on this page, and is it safe to open? $clean")) }
        MaterialAlertDialogBuilder(this).setTitle(clean.take(120)).setItems(opts.map { it.first }.toTypedArray()) { _, w -> opts[w].second() }.show()
        return true
    }

    /** Text selection menu gets "Ask AI" and "Search with Seeker" (desktop: right-click menu). */
    override fun onActionModeStarted(mode: ActionMode) {
        super.onActionModeStarted(mode)
        val web = current?.web ?: return
        if (!web.hasFocus()) return
        fun withSelection(f: (String) -> Unit) = web.evaluateJavascript("window.getSelection().toString()") { r ->
            (try { org.json.JSONTokener(r).nextValue() as? String } catch (e: Exception) { null })?.trim()?.takeIf { it.isNotEmpty() }?.let(f)
        }
        mode.menu.add(Menu.NONE, View.generateViewId(), 200, "Ask AI").setOnMenuItemClickListener {
            withSelection { s -> askAi(s.take(4000), "Explain this:\n\n\"${s.take(4000)}\"") }; mode.finish(); true
        }
        mode.menu.add(Menu.NONE, View.generateViewId(), 201, "Seeker search").setOnMenuItemClickListener {
            withSelection { s -> newTab(SeekerBridge.searchUrl(s.take(300)), current?.incognito == true, opener = current) }; mode.finish(); true
        }
    }

    private fun askAi(@Suppress("UNUSED_PARAMETER") selection: String?, prompt: String?) {
        val t = current
        val i = Intent(this, AiActivity::class.java)
        prompt?.let { i.putExtra(AiActivity.EXTRA_PROMPT, it) }
        if (t == null || !t.url.startsWith("http") || t.incognito) { startActivity(i); return }
        t.web.evaluateJavascript("(document.body&&document.body.innerText||'').slice(0,14000)") { r ->
            val text = try { org.json.JSONTokener(r).nextValue() as? String } catch (e: Exception) { null } ?: ""
            startActivity(i.putExtra(AiActivity.EXTRA_PAGE_TEXT, text).putExtra(AiActivity.EXTRA_PAGE_TITLE, t.title).putExtra(AiActivity.EXTRA_PAGE_URL, t.url))
        }
    }

    // ------------------------------------------------------------------ chrome
    private fun navigate(input: String) {
        val text = input.trim()
        if (text.isEmpty()) return
        address.clearFocus()
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(address.windowToken, 0)
        // "? question" or "ai question" asks the AI assistant (desktop: the same in the address bar)
        Regex("^(\\?|ai\\s)\\s*(.+)$", RegexOption.IGNORE_CASE).find(text)?.let { askAi(null, it.groupValues[2]); showAddress(); return }
        val url = when {
            Regex("^(https?|about):", RegexOption.IGNORE_CASE).containsMatchIn(text) -> Shield.clean(text) ?: text
            !text.contains(' ') && (Regex("^[\\w-]+(\\.[\\w-]+)+(:\\d+)?(/.*)?$").matches(text) || text.startsWith("localhost")) -> "https://$text"
            else -> SeekerBridge.searchUrl(text)
        }
        current?.web?.loadUrl(url) ?: newTab(url, false)
        current?.web?.requestFocus()
    }

    private fun showAddress() {
        val t = current
        val u = t?.errorUrl ?: t?.url ?: ""
        address.setText(when {
            SeekerBridge.isSeekerUrl(u) -> Uri.parse(u).getQueryParameter("q") ?: ""
            u.startsWith("data:") -> ""
            else -> u
        })
    }

    private fun updateProgress() {
        val p = current?.progress ?: 100
        progress.progress = p
        progress.visibility = if (p in 1..99) View.VISIBLE else View.INVISIBLE
    }

    private fun updateChrome() {
        val t = current
        tabCount.text = if (tabs.size > 99) ":D" else tabs.size.toString()
        if (!address.hasFocus()) showAddress()
        updateProgress()
        val inc = t?.incognito == true
        val bg = ContextCompat.getColor(this, if (inc) R.color.incognito else R.color.chrome)
        toolbar.setBackgroundColor(bg)
        root.setBackgroundColor(bg)                       // edge-to-edge: the status bar area shows this
        EdgeToEdge.lightBars(this, !inc && !EdgeToEdge.isNight(this))
        incognitoIcon.visibility = if (inc) View.VISIBLE else View.GONE
        incognitoBanner.visibility = if (inc && SeekerBridge.isSeekerUrl(t?.url) && t?.web?.canGoBack() == false) View.VISIBLE else View.GONE
        tabCount.setTextColor(ContextCompat.getColor(this, if (inc) R.color.incognito_text else R.color.text))
        address.hint = getString(if (inc) R.string.new_incognito_tab else R.string.address_hint)
    }

    private fun showMenu(anchor: View) {
        val t = current
        val url = t?.url ?: ""
        val web = url.startsWith("http")
        val canBookmark = web && t?.incognito == false
        PopupMenu(this, anchor).apply {
            menu.add(R.string.forward).setEnabled(t?.web?.canGoForward() == true).setOnMenuItemClickListener { t?.web?.goForward(); true }
            menu.add(R.string.reload).setOnMenuItemClickListener { t?.web?.reload(); true }
            menu.add(R.string.new_tab).setOnMenuItemClickListener { newTab(home, false); true }
            menu.add(R.string.new_incognito_tab).setOnMenuItemClickListener { newTab(SeekerBridge.HOME, true); true }
            if (closed.isNotEmpty()) menu.add(R.string.reopen_tab).setOnMenuItemClickListener { reopenClosed(); true }
            if (canBookmark) menu.add(if (Store.isBookmarked(url)) R.string.remove_bookmark else R.string.add_bookmark).setOnMenuItemClickListener {
                toast(if (Store.toggleBookmark(url, t?.title ?: url)) "Bookmarked" else "Bookmark removed"); true
            }
            menu.add(R.string.bookmarks).setOnMenuItemClickListener { startActivity(Intent(this@MainActivity, ListActivity::class.java).putExtra("mode", "bookmarks")); true }
            menu.add(R.string.history).setOnMenuItemClickListener { startActivity(Intent(this@MainActivity, ListActivity::class.java).putExtra("mode", "history")); true }
            menu.add(R.string.downloads).setOnMenuItemClickListener { startActivity(Intent(this@MainActivity, DownloadsActivity::class.java)); true }
            menu.add(R.string.ai_assistant).setOnMenuItemClickListener { askAi(null, null); true }
            if (web) menu.add(getString(R.string.shield) + " · ${t?.blocked?.get() ?: 0} blocked").setOnMenuItemClickListener { shieldDialog(); true }
            val media = t?.media?.toList().orEmpty()
            if (media.isNotEmpty()) menu.add("Download video/audio (${media.size})").setOnMenuItemClickListener { mediaDialog(media); true }
            if (web) menu.add(R.string.find_in_page).setOnMenuItemClickListener { openFind(); true }
            if (web) menu.add(R.string.share).setOnMenuItemClickListener {
                startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url), null)); true
            }
            if (web) menu.add(R.string.print).setOnMenuItemClickListener { print(); true }
            if (t != null && web && isGoogleSignIn(Uri.parse(url))) menu.add("Sign in with Google in a secure sheet").setOnMenuItemClickListener { openCustomTab(url); true }
            menu.add(R.string.desktop_site).setCheckable(true).setChecked(t?.web in desktopMode).setOnMenuItemClickListener {
                t?.web?.let { w -> if (!desktopMode.remove(w)) desktopMode.add(w); applyUserAgent(w); w.reload() }; true
            }
            menu.add(R.string.settings).setOnMenuItemClickListener { startActivity(Intent(this@MainActivity, SettingsActivity::class.java)); true }
            menu.add(R.string.clear_data).setOnMenuItemClickListener { clearData(); true }
        }.show()
    }

    private fun print() {
        val t = current ?: return
        val pm = getSystemService(PRINT_SERVICE) as PrintManager
        val name = t.title.ifBlank { "Seeker page" }
        pm.print(name, t.web.createPrintDocumentAdapter(name), PrintAttributes.Builder().build())
    }

    private fun mediaDialog(list: List<String>) {
        val t = current ?: return
        val labels = list.map { u ->
            val kind = if (u.contains(".m3u8", true)) "Stream (HLS)" else u.substringAfterLast('.').substringBefore('?').uppercase()
            "$kind · " + (Uri.parse(u).lastPathSegment ?: u).take(60)
        }
        MaterialAlertDialogBuilder(this).setTitle("Media on this page")
            .setItems(labels.toTypedArray()) { _, w -> startDownload(t, list[w], null, null, null) }
            .setNegativeButton(R.string.cancel, null).show()
    }

    private fun shieldDialog() {
        val t = current ?: return
        val host = Privacy.hostOf(t.url).removePrefix("www.")
        val site = Privacy.siteOf(host)
        val off = Privacy.isException(host, Prefs.exceptions)
        val msg = buildString {
            append(if (!Prefs.shieldOn) "The Shield is off in Settings.\n\n" else if (off) "The Shield is OFF for $site.\n\n" else "Protecting you on $site.\n\n")
            append("• ${t.blocked.get()} ads & trackers blocked on this page\n")
            append("• Anti-fingerprinting: ${if (Prefs.fingerprint && !off && Shield.docStartSupported) "on" else "off"}\n")
            append("• Link cleaning: ${if (Prefs.stripTracking) "on" else "off"}\n")
            append("• Third-party cookies: ${if (Prefs.blockThirdPartyCookies) "blocked" else "allowed"}\n")
            append("• Connection: ${if (Route.routed) Route.message else "direct"}")
        }
        MaterialAlertDialogBuilder(this).setTitle(R.string.shield).setMessage(msg)
            .setPositiveButton(if (off) "Turn Shield on here" else "Turn Shield off here") { _, _ ->
                Prefs.exceptions = if (off) Prefs.exceptions.filterNot { Privacy.siteOf(it) == site || it == host }.toSet() else Prefs.exceptions + site
                applySettings(); t.web.reload()
            }
            .setNeutralButton("Forget this site") { _, _ ->
                MaterialAlertDialogBuilder(this).setTitle("Forget $site?").setMessage("Deletes its cookies and site data. You'll be signed out of it.")
                    .setPositiveButton("Forget") { _, _ -> Shield.forget(site); t.web.reload(); toast("Forgot $site") }.setNegativeButton(R.string.cancel, null).show()
            }
            .setNegativeButton("Close", null).show()
    }

    private fun clearData() {
        MaterialAlertDialogBuilder(this).setTitle(R.string.clear_data)
            .setMessage("Delete history, cookies, site data, cache and page memory? Bookmarks and downloads are kept.")
            .setPositiveButton("Clear") { _, _ ->
                Store.clearHistory()
                PageMemory.clear()
                CookieManager.getInstance().removeAllCookies(null)
                android.webkit.WebStorage.getInstance().deleteAllData()
                tabs.forEach { it.web.clearCache(true); it.web.clearHistory() }
                closed.clear()
                toast("Browsing data cleared")
            }.setNegativeButton(R.string.cancel, null).show()
    }

    private fun showTabs() {
        val dlg = BottomSheetDialog(this)
        val root = LayoutInflater.from(this).inflate(R.layout.activity_list, null)
        root.findViewById<TextView>(R.id.title).text = getString(R.string.tabs) + " (${tabs.size})"
        root.findViewById<View>(R.id.search).visibility = View.GONE
        root.findViewById<View>(R.id.back).visibility = View.GONE
        root.findViewById<MaterialButton>(R.id.clear).apply {
            text = getString(R.string.new_tab)
            setOnClickListener { newTab(home, false); dlg.dismiss() }
        }
        val list = root.findViewById<RecyclerView>(R.id.list)
        list.layoutManager = LinearLayoutManager(this)
        list.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            override fun getItemCount() = tabs.size + 1
            override fun getItemViewType(p: Int) = if (p == tabs.size) 1 else 0
            override fun onCreateViewHolder(p: ViewGroup, type: Int): RecyclerView.ViewHolder {
                if (type == 1) return object : RecyclerView.ViewHolder(MaterialButton(this@MainActivity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                    text = getString(R.string.new_incognito_tab); setIconResource(R.drawable.ic_incognito)
                    layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { setMargins(36, 12, 36, 36) }
                    setOnClickListener { newTab(SeekerBridge.HOME, true); dlg.dismiss() }
                }) {}
                return object : RecyclerView.ViewHolder(LayoutInflater.from(p.context).inflate(R.layout.item_tab, p, false)) {}
            }
            override fun onBindViewHolder(h: RecyclerView.ViewHolder, p: Int) {
                if (p == tabs.size) return
                val t = tabs[p]
                val v = h.itemView
                val host = try { URI(t.url).host?.removePrefix("www.") } catch (e: Exception) { null }
                val seeker = SeekerBridge.isSeekerUrl(t.url)
                v.findViewById<TextView>(R.id.icon).text = if (t.incognito) "🕶" else if (seeker) "S" else host?.firstOrNull()?.uppercase() ?: "?"
                v.findViewById<TextView>(R.id.title).text = if (seeker && t.title.isBlank()) "Seeker" else t.title
                v.findViewById<TextView>(R.id.sub).text = (if (t.incognito) "Incognito · " else "") + (if (seeker) "Seeker search" else host ?: t.url)
                v.alpha = 1f
                v.backgroundTintList = if (t == current) ColorStateList.valueOf(ContextCompat.getColor(this@MainActivity, R.color.accent_soft)) else null
                v.setOnClickListener { switchTo(t); dlg.dismiss() }
                v.findViewById<View>(R.id.close).setOnClickListener {
                    closeTab(t)
                    if (tabs.isEmpty()) dlg.dismiss() else notifyDataSetChanged()
                    root.findViewById<TextView>(R.id.title).text = getString(R.string.tabs) + " (${tabs.size})"
                }
            }
        }
        dlg.setContentView(root)
        dlg.show()
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    override fun onDestroy() {
        Route.removeListener(routeListener)
        if (isFinishing) {
            tabs.forEach { it.web.destroy() }
            if (tabs.any { it.incognito }) { tabs.clear(); wipeIncognito() }
        }
        super.onDestroy()
    }
}
