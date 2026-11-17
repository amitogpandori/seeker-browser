package com.seeker.browser

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebResourceResponse
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.UUID

/**
 * Privacy Shield (desktop: privacy.js + adblock.js + the tab preload shield):
 * ad/tracker blocking, anti-fingerprinting script, link cleaning, third-party cookie blocking
 * and "forget this site when its last tab closes".
 */
object Shield {
    private lateinit var app: Context
    private var template = ""
    private val seed = UUID.randomUUID().toString()          // new noise every app session
    private val mark = "__sk" + UUID.randomUUID().toString().take(8)
    private val evt = "sk" + UUID.randomUUID().toString().take(8)
    private val main by lazy { Handler(Looper.getMainLooper()) }
    private val pendingForget = HashMap<String, Runnable>()
    val docStartSupported get() = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)

    fun init(ctx: Context) {
        app = ctx.applicationContext
        template = try { app.assets.open("shield.js").bufferedReader().readText() } catch (e: Exception) { "" }
    }

    fun configJson(): String = JSONObject()
        .put("mark", mark).put("evt", evt).put("seed", seed)
        .put("noise", Prefs.shieldOn && Prefs.fingerprint)
        .put("gpc", Prefs.shieldOn && Prefs.doNotTrack)
        .put("noRtc", Route.routed)
        .put("exceptions", JSONArray(Prefs.exceptions.toList()))
        .toString()

    /** Adds the shield script to a WebView (runs before page scripts, in every frame). */
    fun install(web: WebView, old: ScriptHandler?): ScriptHandler? {
        old?.remove()
        if (!docStartSupported || template.isEmpty()) return null
        val cfg = configJson()
        val js = template.replace("/*CFG*/{}/*CFG*/", cfg)
        return WebViewCompat.addDocumentStartJavaScript(web, js, setOf("*"))
    }

    private val EMPTY get() = WebResourceResponse("text/plain", "utf-8", 200, "Blocked by Seeker", mapOf("Access-Control-Allow-Origin" to "*"), ByteArrayInputStream(ByteArray(0)))

    /** Should this subresource be blocked? [pageUrl] is the tab's top-level page. */
    fun shouldBlock(url: String, pageUrl: String?, isMainFrame: Boolean): Boolean {
        if (isMainFrame || !Prefs.shieldOn || !Prefs.adblock) return false
        val top = Privacy.hostOf(pageUrl)
        if (top.isNotEmpty() && Privacy.isException(top, Prefs.exceptions)) return false
        if (!Privacy.isBlocked(url)) return false
        // a site's own first-party analytics host is still blocked; first-party content is never blocked here
        return true
    }
    fun blockedResponse() = EMPTY

    /** Link cleaning for a navigation; returns the cleaned URL or null when nothing changes. */
    fun clean(url: String): String? {
        if (!Prefs.shieldOn || !Prefs.stripTracking) return null
        if (Privacy.isException(Privacy.hostOf(url), Prefs.exceptions)) return null
        val out = Privacy.unwrapRedirect(url) ?: Privacy.cleanUrl(url)
        return out.takeIf { it != url }
    }

    // ---------------------------------------------------------------- forget sites
    /** Called when a tab leaves [site] (closed or navigated away). [stillOpen] says whether any tab still shows it. */
    fun siteLeft(site: String, stillOpen: (String) -> Boolean) {
        if (!Prefs.shieldOn || !Prefs.forgetOnClose || site.isEmpty()) return
        if (Privacy.isException(site, Prefs.exceptions)) return
        if (Store.bookmarks().any { Privacy.siteOf(Privacy.hostOf(it.url)) == site }) return
        pendingForget.remove(site)?.let { main.removeCallbacks(it) }
        val r = Runnable { pendingForget.remove(site); if (!stillOpen(site)) forget(site) }
        pendingForget[site] = r
        main.postDelayed(r, 15_000)            // short grace period, like the desktop app
    }

    fun forget(site: String) {
        val cm = CookieManager.getInstance()
        val hosts = listOf(site, "www.$site")
        for (h in hosts) for (scheme in listOf("https", "http")) {
            val url = "$scheme://$h"
            cm.getCookie(url)?.split(";")?.map { it.substringBefore('=').trim() }?.filter { it.isNotEmpty() }?.forEach { name ->
                for (d in listOf("", "; Domain=$site", "; Domain=.$site", "; Domain=$h")) cm.setCookie(url, "$name=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/$d")
            }
            WebStorage.getInstance().deleteOrigin(url)
        }
        cm.flush()
    }

    fun forgetAll() {
        CookieManager.getInstance().removeAllCookies(null)
        CookieManager.getInstance().flush()
        WebStorage.getInstance().deleteAllData()
        WebView(app).apply { clearCache(true); destroy() }
    }
}
