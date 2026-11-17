package com.seeker.browser

import android.content.Context
import android.webkit.WebViewClient

/** Seeker's own error page (desktop: seeker://error) instead of WebView's grey "Webpage not available". */
object ErrorPage {
    private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    fun html(ctx: Context, url: String, code: Int, desc: String): String {
        val host = Privacy.hostOf(url).ifEmpty { url }
        var emoji = "🛰️"; var title = "This site can't be reached"; var text = "$host refused to connect or isn't available."
        val tips = mutableListOf<String>()
        when {
            desc == "PROXY_UNSUPPORTED" -> { emoji = "🧅"; title = "Can't route this browser"; text = "This phone's Android System WebView is too old to use Tor or a proxy, so Seeker blocks all pages instead of leaking your address."; tips += listOf("Update \"Android System WebView\" from Google Play", "Or set Connection to Direct in Settings") }
            Route.routed && Route.state != Route.State.READY -> {
                emoji = "🧅"; title = if (Route.isTor) "Waiting for Tor" else "Waiting for the proxy"
                text = Route.message.ifEmpty { "Seeker sends nothing until the secure connection is up." }
                if (Route.isTor) tips += listOf("Open Orbot and tap Start", "Or turn Tor off in Settings → Connection")
            }
            code == WebViewClient.ERROR_HOST_LOOKUP -> {
                text = "$host’s server address could not be found."
                tips += listOf("Check the spelling of the address", "Check your internet connection")
                if (host.endsWith(".onion") && !Route.isTor) tips.add(0, ".onion sites only open with Tor on (Settings → Connection → Tor)")
            }
            desc.contains("INTERNET_DISCONNECTED") -> { emoji = "📡"; title = "No internet"; text = "Your phone is offline."; tips += listOf("Turn on Wi-Fi or mobile data", "Turn off airplane mode") }
            code == WebViewClient.ERROR_TIMEOUT -> { text = "$host took too long to respond."; if (Route.isTor) tips += "Tor can be slow. Try again." }
            code == WebViewClient.ERROR_PROXY_AUTHENTICATION || code == WebViewClient.ERROR_CONNECT && Route.routed -> {
                title = if (Route.isTor) "Tor connection problem" else "Proxy connection problem"; text = "The connection through ${if (Route.isTor) "Tor" else "your proxy"} failed for this site."
            }
            code == WebViewClient.ERROR_FAILED_SSL_HANDSHAKE -> { emoji = "⚠️"; title = "Your connection is not private"; text = "Seeker couldn't make a secure connection to $host." }
            code == -999 -> { emoji = "⚠️"; title = "Your connection is not private"; text = "Seeker couldn't verify $host's security certificate, so the page was blocked to protect you." }
        }
        val t = try { ctx.assets.open("error.html").bufferedReader().readText() } catch (e: Exception) { "<h1>{{TITLE}}</h1><p>{{DESC}}</p><a href=\"{{URL}}\">Try again</a>" }
        return t.replace("{{HOST}}", esc(host)).replace("{{EMOJI}}", emoji).replace("{{TITLE}}", esc(title)).replace("{{DESC}}", esc(text))
            .replace("{{TIPS}}", tips.joinToString("") { "<li>${esc(it)}</li>" }).replace("{{URL}}", esc(url)).replace("{{CODE}}", esc("$desc ($code)"))
    }
}
