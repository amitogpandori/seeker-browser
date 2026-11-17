package com.seeker.browser

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.net.URL
import java.util.concurrent.Executors

/**
 * "Route all browsing through Tor or your own proxy" (desktop Settings → Privacy → route).
 * Tor comes from Orbot: when Orbot runs, all WebViews and the app's own requests (search,
 * downloads, AI) go through Orbot's HTTP proxy. It FAILS CLOSED: while Orbot is starting or
 * not reachable, everything goes to a dead proxy and the app's own requests are refused.
 */
object Route {
    const val ORBOT = "org.torproject.android"
    private const val ORBOT_HTTP = 8118
    private const val ORBOT_SOCKS = 9050
    private const val BLACKHOLE = "http://127.0.0.1:1"

    enum class State { DIRECT, STARTING, READY, FAILED }
    @Volatile var state = State.DIRECT; private set
    @Volatile private var javaProxy: Proxy? = null
    @Volatile var message = ""; private set
    private val listeners = mutableListOf<() -> Unit>()
    private val bg = Executors.newSingleThreadExecutor()
    private val main by lazy { Handler(Looper.getMainLooper()) }
    private var seq = 0

    val supported get() = WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)
    val routed get() = Prefs.route != "direct"
    val isTor get() = Prefs.route == "orbot"
    fun orbotInstalled(ctx: Context) = try { ctx.packageManager.getPackageInfo(ORBOT, 0); true } catch (e: PackageManager.NameNotFoundException) { false }
    fun addListener(l: () -> Unit) { listeners.add(l) }
    fun removeListener(l: () -> Unit) { listeners.remove(l) }
    private fun set(s: State, msg: String) { state = s; message = msg; main.post { listeners.toList().forEach { it() } } }

    /** Proxy for HttpURLConnection. Throws while a route is configured but not ready (fail closed). */
    fun proxy(): Proxy {
        if (!Prefs.ready || !routed) return Proxy.NO_PROXY
        return javaProxy ?: throw IOException(if (isTor) "Waiting for Tor (Orbot) — nothing is sent until it is connected" else "Waiting for the proxy")
    }
    fun open(url: String): HttpURLConnection = URL(url).openConnection(proxy()) as HttpURLConnection

    fun apply(ctx: Context) {
        val app = ctx.applicationContext
        val my = ++seq
        javaProxy = null
        if (!routed) {
            if (supported) ProxyController.getInstance().clearProxyOverride({ it.run() }, {})
            set(State.DIRECT, ""); return
        }
        if (!supported) { set(State.FAILED, "This phone's WebView can't use a proxy. Update Android System WebView."); return }
        override(BLACKHOLE)                     // fail closed right away
        set(State.STARTING, if (isTor) "Connecting to Tor…" else "Connecting to proxy…")
        bg.execute {
            try {
                val (webRule, jp) = if (isTor) {
                    if (!orbotInstalled(app)) throw IOException("Orbot is not installed. Install Orbot from Google Play to use Tor.")
                    startOrbot(app)
                    var found: Pair<String, Proxy>? = null
                    for (i in 0 until 90) {               // Orbot can take a while to bootstrap
                        if (my != seq) return@execute
                        if (portOpen(ORBOT_HTTP)) { found = "http://127.0.0.1:$ORBOT_HTTP" to Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved("127.0.0.1", ORBOT_HTTP)); break }
                        if (portOpen(ORBOT_SOCKS)) { found = "socks5://127.0.0.1:$ORBOT_SOCKS" to Proxy(Proxy.Type.SOCKS, InetSocketAddress.createUnresolved("127.0.0.1", ORBOT_SOCKS)); break }
                        Thread.sleep(1000)
                    }
                    found ?: throw IOException("Orbot isn't running. Open Orbot and tap Start, then try again.")
                } else {
                    val p = Prefs.proxy
                    val m = Regex("^(https?|socks5?)://([^:/]+):(\\d+)/?$", RegexOption.IGNORE_CASE).find(p) ?: throw IOException("Enter the proxy as http://host:port or socks5://host:port in Settings")
                    val type = if (m.groupValues[1].startsWith("socks", true)) Proxy.Type.SOCKS else Proxy.Type.HTTP
                    p to Proxy(type, InetSocketAddress.createUnresolved(m.groupValues[2], m.groupValues[3].toInt()))
                }
                if (my != seq) return@execute
                main.post { override(webRule) { if (my == seq) { javaProxy = jp; set(State.READY, if (isTor) "Connected through Tor (Orbot)" else "Connected through proxy") } } }
            } catch (e: Exception) {
                if (my == seq) set(State.FAILED, e.message ?: "Route failed")
            }
        }
    }

    private fun override(rule: String, done: () -> Unit = {}) {
        val cfg = ProxyConfig.Builder().addProxyRule(rule).build()   // no direct fallback
        ProxyController.getInstance().setProxyOverride(cfg, { it.run() }, done)
    }

    private fun portOpen(port: Int) = try { Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 300); true } } catch (e: Exception) { false }

    fun startOrbot(ctx: Context) {
        try {
            ctx.sendBroadcast(Intent("org.torproject.android.intent.action.START").setPackage(ORBOT)
                .putExtra("org.torproject.android.intent.extra.PACKAGE_NAME", ctx.packageName))
        } catch (e: Exception) { /* old Orbot */ }
    }
    fun openOrbot(ctx: Context) {
        val i = ctx.packageManager.getLaunchIntentForPackage(ORBOT)
            ?: Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://play.google.com/store/apps/details?id=$ORBOT"))
        ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
