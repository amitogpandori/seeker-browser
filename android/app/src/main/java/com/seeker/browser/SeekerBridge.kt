package com.seeker.browser

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Native side of window.seeker for the bundled Seeker search page. Only the app's own asset
 * origin can talk to it (WebMessageListener origin rules), never a website.
 */
object SeekerBridge {
    const val ORIGIN = "https://appassets.androidplatform.net"
    const val HOME = "$ORIGIN/assets/seeker/index.html"
    private val pool = Executors.newFixedThreadPool(6)
    private val main = Handler(Looper.getMainLooper())
    private const val MAX_BYTES = 3 * 1024 * 1024

    fun isSeekerUrl(url: String?) = url != null && url.startsWith("$ORIGIN/assets/seeker/")
    fun searchUrl(q: String) = "$HOME?q=${Uri.encode(q)}"

    fun attach(web: WebView, userAgent: () -> String, incognito: Boolean) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        WebViewCompat.addWebMessageListener(web, "SeekerNative", setOf(ORIGIN)) { _, message: WebMessageCompat, origin, isMainFrame, reply: JavaScriptReplyProxy ->
            if (!isMainFrame || origin.toString() != ORIGIN) return@addWebMessageListener
            val req = try { JSONObject(message.data ?: return@addWebMessageListener) } catch (e: Exception) { return@addWebMessageListener }
            val id = req.optInt("id")
            val args = req.optJSONArray("args") ?: JSONArray()
            val send = { result: Any?, error: String? ->
                val out = JSONObject().put("id", id)
                if (error != null) out.put("error", error) else out.put("result", result ?: JSONObject.NULL)
                main.post { try { reply.postMessage(out.toString()) } catch (e: Exception) { /* page gone */ } }
            }
            when (req.optString("name")) {
                "search.fetch" -> pool.execute {
                    try { send(fetch(args.optString(0), args.optJSONObject(1) ?: JSONObject(), userAgent()), null) }
                    catch (e: Exception) { send(null, e.message ?: "Network error") }
                }
                "newtab.get" -> send(Store.newtab(), null)
                "newtab.set" -> if (incognito) send(Store.newtab(), null) else send(Store.setNewtab(args.optJSONObject(0) ?: JSONObject()), null)
                "history.top" -> send(if (incognito) JSONArray() else Store.topSites(args.optInt(0, 8)), null)
                "localindex.search" -> pool.execute { send(PageMemory.search(args.optString(0), args.optInt(1, 6).coerceIn(1, 20)), null) }
                else -> send(null, "Unknown call")
            }
        }
    }

    private fun fetch(url: String, opt: JSONObject, ua: String): JSONObject {
        require(url.startsWith("http://", true) || url.startsWith("https://", true)) { "Only http(s) URLs" }
        val c = Route.open(url)   // Tor/proxy route; refuses while the route is not ready
        try {
            val timeout = opt.optInt("timeout", 9000).coerceIn(1000, 20000)
            c.connectTimeout = timeout; c.readTimeout = timeout
            c.instanceFollowRedirects = true
            c.setRequestProperty("User-Agent", ua)
            c.setRequestProperty("Accept-Language", "en-GB,en;q=0.9,hi;q=0.6")
            c.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8")
            opt.optJSONObject("headers")?.let { h -> h.keys().forEach { k -> if (!k.equals("cookie", true)) c.setRequestProperty(k, h.optString(k)) } }
            val code = c.responseCode
            val ct = c.contentType ?: ""
            val stream = if (code >= 400) c.errorStream else c.inputStream
            var text = ""
            if (stream != null && !Regex("^(image|video|audio|font)/|pdf|zip|octet-stream").containsMatchIn(ct)) {
                stream.use { s ->
                    val buf = java.io.ByteArrayOutputStream(); val b = ByteArray(32 * 1024); var total = 0
                    while (total < MAX_BYTES) { val n = s.read(b); if (n < 0) break; buf.write(b, 0, n); total += n }
                    val cs = Regex("charset=([\\w-]+)", RegexOption.IGNORE_CASE).find(ct)?.groupValues?.get(1)
                    text = try { buf.toString(cs ?: "UTF-8") } catch (e: Exception) { buf.toString("UTF-8") }
                }
            }
            return JSONObject().put("status", code).put("url", c.url.toString()).put("contentType", ct).put("text", text)
        } finally { c.disconnect() }
    }
}
