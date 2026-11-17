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
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.seeker.browser.downloads.Downloads
import com.seeker.browser.downloads.DownloadsActivity
import org.json.JSONArray
import java.net.URI

class Tab(val web: WebView, val incognito: Boolean) {
    var title = "New Tab"
    var url = ""
    var progress = 100
}

class MainActivity : AppCompatActivity() {
    companion object {
        const val EXTRA_OPEN = "open"
        private const val INCOGNITO_PROFILE = "seeker-incognito"
    }

    private val tabs = mutableListOf<Tab>()
    private var current: Tab? = null
    private lateinit var container: FrameLayout
    private lateinit var address: EditText
    private lateinit var progress: ProgressBar
    private lateinit var tabCount: TextView
    private lateinit var toolbar: View
    private lateinit var incognitoIcon: ImageView
    private lateinit var incognitoBanner: TextView
    private val assets by lazy { WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build() }
    private val multiProfile by lazy { WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) }
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data)); fileCallback = null
    }
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        container = findViewById(R.id.webContainer)
        address = findViewById(R.id.address)
        progress = findViewById(R.id.progress)
        tabCount = findViewById(R.id.tabCount)
        toolbar = findViewById(R.id.toolbar)
        incognitoIcon = findViewById(R.id.incognitoIcon)
        incognitoBanner = findViewById(R.id.incognitoBanner)

        // a crash or force-stop can leave incognito data behind: wipe it at start
        if (multiProfile) try { ProfileStore.getInstance().deleteProfile(INCOGNITO_PROFILE) } catch (e: Exception) { /* none */ }

        address.setOnEditorActionListener { _, id, ev ->
            if (id == EditorInfo.IME_ACTION_GO || ev?.keyCode == KeyEvent.KEYCODE_ENTER) { navigate(address.text.toString()); true } else false
        }
        address.setOnFocusChangeListener { _, has -> if (!has) showAddress() }
        tabCount.setOnClickListener { showTabs() }
        findViewById<ImageButton>(R.id.menuBtn).setOnClickListener { showMenu(it) }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val t = current
                when {
                    customView != null -> customCallback?.onCustomViewHidden()
                    t != null && t.web.canGoBack() -> t.web.goBack()
                    tabs.size > 1 && t != null -> closeTab(t)
                    else -> moveTaskToBack(true)
                }
            }
        })

        if (!handleIntent(intent)) restoreSession()
        if (tabs.isEmpty()) newTab(SeekerBridge.HOME, false)
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); handleIntent(intent) }

    private fun handleIntent(i: Intent?): Boolean {
        i ?: return false
        i.getStringExtra(EXTRA_OPEN)?.let { current?.web?.loadUrl(it) ?: newTab(it, false); return true }
        if (i.action == Intent.ACTION_WEB_SEARCH) i.getStringExtra("query")?.let { newTab(SeekerBridge.searchUrl(it), false); return true }
        if (i.action == Intent.ACTION_VIEW) i.dataString?.takeIf { it.startsWith("http") }?.let { newTab(it, false); return true }
        return false
    }

    override fun onPause() {
        super.onPause()
        val urls = JSONArray()
        tabs.filter { !it.incognito && it.url.isNotEmpty() }.forEach { urls.put(it.url) }
        getSharedPreferences("seeker", MODE_PRIVATE).edit().putString("session", urls.toString())
            .putInt("sessionActive", tabs.filter { !it.incognito }.indexOf(current).coerceAtLeast(0)).apply()
        CookieManager.getInstance().flush()
    }

    private fun restoreSession() {
        val p = getSharedPreferences("seeker", MODE_PRIVATE)
        val a = try { JSONArray(p.getString("session", "[]")) } catch (e: Exception) { JSONArray() }
        for (i in 0 until a.length()) newTab(a.getString(i), false, switch = false)
        tabs.getOrNull(p.getInt("sessionActive", 0))?.let { switchTo(it) }
    }

    // ------------------------------------------------------------------ tabs
    @SuppressLint("SetJavaScriptEnabled")
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
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        return web
    }

    private fun newTab(url: String, incognito: Boolean, switch: Boolean = true, opener: Tab? = null): Tab {
        if (incognito && !multiProfile && tabs.none { it.incognito }) {
            Toast.makeText(this, "This phone's WebView can't keep incognito cookies separate. History is still not saved.", Toast.LENGTH_LONG).show()
        }
        val web = createWebView(incognito)
        val tab = Tab(web, incognito)
        setupTab(tab)
        val at = opener?.let { tabs.indexOf(it) + 1 } ?: tabs.size
        tabs.add(at.coerceIn(0, tabs.size), tab)
        if (url.isNotEmpty()) web.loadUrl(url)
        if (switch || current == null) switchTo(tab) else updateChrome()
        return tab
    }

    private fun switchTo(tab: Tab) {
        current?.web?.let { container.removeView(it); it.onPause() }
        current = tab
        (tab.web.parent as? ViewGroup)?.removeView(tab.web)
        container.addView(tab.web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        tab.web.onResume()
        updateChrome()
    }

    private fun closeTab(tab: Tab) {
        val i = tabs.indexOf(tab)
        tabs.remove(tab)
        if (current == tab) {
            container.removeView(tab.web)
            current = null
            if (tabs.isEmpty()) newTab(SeekerBridge.HOME, false) else switchTo(tabs[(i - 1).coerceAtLeast(0).coerceAtMost(tabs.size - 1)])
        }
        tab.web.stopLoading(); tab.web.destroy()
        if (tab.incognito && tabs.none { it.incognito }) wipeIncognito()
        updateChrome()
    }

    /** Last incognito tab closed: delete its cookies, storage and cache, and forget its downloads. */
    private fun wipeIncognito() {
        Downloads.forgetIncognito()
        if (multiProfile) container.postDelayed({
            try { ProfileStore.getInstance().deleteProfile(INCOGNITO_PROFILE) } catch (e: Exception) { /* still in use: wiped next start */ }
        }, 500)
    }

    private fun setupTab(tab: Tab) {
        val web = tab.web
        SeekerBridge.attach(web, { web.settings.userAgentString }, tab.incognito)
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = assets.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                return when (u.scheme?.lowercase()) {
                    "http", "https" -> false
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
                if (tab == current) updateChrome()
            }

            override fun onPageFinished(view: WebView, url: String) {
                tab.url = url; tab.progress = 100
                tab.title = view.title?.takeIf { it.isNotBlank() } ?: tab.title
                if (!tab.incognito && !SeekerBridge.isSeekerUrl(url)) Store.recordVisit(url, tab.title)
                if (tab == current) updateChrome()
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                tab.url = url
                if (tab == current) updateChrome()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, p: Int) { tab.progress = p; if (tab == current) updateProgress() }
            override fun onReceivedTitle(view: WebView, title: String?) {
                tab.title = title ?: tab.title
                if (!tab.incognito) Store.updateTitle(view.url ?: "", tab.title)
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
                // camera / microphone for websites are not supported yet
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

    private fun cookiesFor(tab: Tab, url: String): String? =
        if (tab.incognito && multiProfile) WebViewCompat.getProfile(tab.web).cookieManager.getCookie(url)
        else if (tab.incognito) null else CookieManager.getInstance().getCookie(url)

    private fun startDownload(tab: Tab, url: String, ua: String?, cd: String?, mime: String?) {
        if (!url.startsWith("http")) return toast("This kind of download (${url.substringBefore(':')}:) isn't supported yet")
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        try {
            val it = Downloads.add(url, mime = mime?.takeIf { m -> m.isNotBlank() && m != "application/octet-stream" }, userAgent = ua ?: tab.web.settings.userAgentString,
                cookies = cookiesFor(tab, url), referrer = tab.url.takeIf { u -> u.startsWith("http") }, incognito = tab.incognito, contentDisposition = cd)
            Toast.makeText(this, "Downloading ${it.fileName}", Toast.LENGTH_SHORT).show()
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
        val opts = mutableListOf<Pair<String, () -> Unit>>()
        if (isLink) {
            opts += "Open in new tab" to { newTab(link, tab.incognito, switch = false, opener = tab); toast("Opened in background") }
            if (!tab.incognito) opts += "Open in incognito tab" to { newTab(link, true) }
            opts += "Download link" to { startDownload(tab, link, null, null, null) }
        }
        if (isImage) opts += "Download image" to { startDownload(tab, link, null, null, null) }
        opts += "Copy link" to {
            (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("link", link)); toast("Link copied")
        }
        opts += "Share link" to { startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link), null)) }
        MaterialAlertDialogBuilder(this).setTitle(link.take(120)).setItems(opts.map { it.first }.toTypedArray()) { _, w -> opts[w].second() }.show()
        return true
    }

    // ------------------------------------------------------------------ chrome
    private fun navigate(input: String) {
        val text = input.trim()
        if (text.isEmpty()) return
        val url = when {
            Regex("^(https?|about):", RegexOption.IGNORE_CASE).containsMatchIn(text) -> text
            !text.contains(' ') && (Regex("^[\\w-]+(\\.[\\w-]+)+(:\\d+)?(/.*)?$").matches(text) || text.startsWith("localhost")) -> "https://$text"
            else -> SeekerBridge.searchUrl(text)
        }
        current?.web?.loadUrl(url) ?: newTab(url, false)
        address.clearFocus()
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(address.windowToken, 0)
        current?.web?.requestFocus()
    }

    private fun showAddress() {
        val u = current?.url ?: ""
        address.setText(when {
            SeekerBridge.isSeekerUrl(u) -> Uri.parse(u).getQueryParameter("q") ?: ""
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
        window.statusBarColor = bg
        incognitoIcon.visibility = if (inc) View.VISIBLE else View.GONE
        incognitoBanner.visibility = if (inc && SeekerBridge.isSeekerUrl(t?.url) && t?.web?.canGoBack() == false) View.VISIBLE else View.GONE
        tabCount.setTextColor(ContextCompat.getColor(this, if (inc) R.color.incognito_text else R.color.text))
        address.hint = getString(if (inc) R.string.new_incognito_tab else R.string.address_hint)
    }

    private fun showMenu(anchor: View) {
        val t = current
        val url = t?.url ?: ""
        val canBookmark = url.startsWith("http") && t?.incognito == false
        PopupMenu(this, anchor).apply {
            menu.add(R.string.forward).setEnabled(t?.web?.canGoForward() == true).setOnMenuItemClickListener { t?.web?.goForward(); true }
            menu.add(R.string.reload).setOnMenuItemClickListener { t?.web?.reload(); true }
            menu.add(R.string.new_tab).setOnMenuItemClickListener { newTab(SeekerBridge.HOME, false); true }
            menu.add(R.string.new_incognito_tab).setOnMenuItemClickListener { newTab(SeekerBridge.HOME, true); true }
            if (canBookmark) menu.add(if (Store.isBookmarked(url)) R.string.remove_bookmark else R.string.add_bookmark).setOnMenuItemClickListener {
                toast(if (Store.toggleBookmark(url, t?.title ?: url)) "Bookmarked" else "Bookmark removed"); true
            }
            menu.add(R.string.bookmarks).setOnMenuItemClickListener { startActivity(Intent(this@MainActivity, ListActivity::class.java).putExtra("mode", "bookmarks")); true }
            menu.add(R.string.history).setOnMenuItemClickListener { startActivity(Intent(this@MainActivity, ListActivity::class.java).putExtra("mode", "history")); true }
            menu.add(R.string.downloads).setOnMenuItemClickListener { startActivity(Intent(this@MainActivity, DownloadsActivity::class.java)); true }
            if (url.startsWith("http")) menu.add(R.string.share).setOnMenuItemClickListener {
                startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url), null)); true
            }
            menu.add(R.string.desktop_site).setCheckable(true).setChecked(t?.web?.settings?.userAgentString?.contains("X11; Linux x86_64") == true).setOnMenuItemClickListener {
                t?.web?.let { w ->
                    val desk = !w.settings.userAgentString.contains("X11; Linux x86_64")
                    w.settings.userAgentString = if (desk) WebSettings.getDefaultUserAgent(this@MainActivity).replace(Regex("\\(Linux; Android[^)]*\\)"), "(X11; Linux x86_64)").replace(" Mobile", "") else null
                    w.reload()
                }; true
            }
            menu.add(R.string.clear_data).setOnMenuItemClickListener { clearData(); true }
        }.show()
    }

    private fun clearData() {
        MaterialAlertDialogBuilder(this).setTitle(R.string.clear_data)
            .setMessage("Delete history, cookies, site data and cache? Bookmarks and downloads are kept.")
            .setPositiveButton("Clear") { _, _ ->
                Store.clearHistory()
                CookieManager.getInstance().removeAllCookies(null)
                android.webkit.WebStorage.getInstance().deleteAllData()
                tabs.forEach { it.web.clearCache(true); it.web.clearHistory() }
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
            setOnClickListener { newTab(SeekerBridge.HOME, false); dlg.dismiss() }
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
        if (isFinishing) {
            tabs.forEach { it.web.destroy() }
            if (tabs.any { it.incognito }) { tabs.clear(); wipeIncognito() }
        }
        super.onDestroy()
    }
}
