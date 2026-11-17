package com.seeker.browser

import java.net.URI
import java.net.URLDecoder

/**
 * Port of the desktop src/main/privacy.js + adblock.js: registrable domains, first-party groups,
 * tracking-parameter stripping, redirect-tracker unwrapping and the ad/tracker host list.
 */
object Privacy {
    private val MULTI = ("co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk nhs.uk co.in net.in org.in gov.in ac.in edu.in res.in nic.in firm.in gen.in ind.in " +
        "com.au net.au org.au edu.au gov.au co.nz org.nz govt.nz com.br com.mx com.ar co.jp ne.jp or.jp ac.jp com.cn com.hk com.sg com.my com.pk com.bd com.np com.lk " +
        "co.za co.ke com.ng com.eg com.tr com.sa ae.org co.il com.tw co.kr " +
        "github.io gitlab.io blogspot.com wordpress.com netlify.app vercel.app pages.dev herokuapp.com appspot.com web.app firebaseapp.com azurewebsites.net " +
        "cloudfront.net amazonaws.com s3.amazonaws.com glitch.me repl.co onrender.com fly.dev neocities.org substack.com medium.com tumblr.com wixsite.com weebly.com").split(" ").toSet()

    fun siteOf(hostIn: String?): String {
        val host = (hostIn ?: "").lowercase().trimEnd('.')
        if (host.isEmpty() || host.matches(Regex("^[\\d.]+$")) || host.contains(':') || !host.contains('.')) return host
        val parts = host.split('.')
        for (i in maxOf(0, parts.size - 4) until parts.size - 1) {
            if (parts.subList(i + 1, parts.size).joinToString(".") in MULTI) return parts.subList(i, parts.size).joinToString(".")
        }
        return parts.takeLast(2).joinToString(".")
    }

    fun hostOf(url: String?): String = try { URI(url ?: "").host ?: "" } catch (e: Exception) {
        Regex("^[a-z][a-z0-9+.-]*://([^/?#:@]+@)?([^/?#:]+)", RegexOption.IGNORE_CASE).find(url ?: "")?.groupValues?.get(2) ?: ""
    }
    private fun dec(s: String) = try { URLDecoder.decode(s, "UTF-8") } catch (e: Exception) { s }
    /** Raw query pairs (name decoded, raw piece kept) — pure JVM so it can be unit-tested. */
    private fun pairs(rawQuery: String?): List<Pair<String, String>> =
        (rawQuery ?: "").split('&').filter { it.isNotEmpty() }.map { dec(it.substringBefore('=')) to it }
    private fun param(rawQuery: String?, k: String): String? =
        pairs(rawQuery).firstOrNull { it.first == k }?.second?.let { if (it.contains('=')) dec(it.substringAfter('=')) else "" }

    private val PARTY_GROUPS = listOf(
        listOf("google.com", "youtube.com", "gmail.com", "gstatic.com", "googleusercontent.com", "googleapis.com", "google.co.in", "google.co.uk", "ggpht.com", "ytimg.com", "googlevideo.com", "withgoogle.com", "android.com", "blogger.com", "googleblog.com", "gvt1.com", "recaptcha.net"),
        listOf("microsoft.com", "live.com", "microsoftonline.com", "office.com", "outlook.com", "office365.com", "bing.com", "msn.com", "xbox.com", "skype.com", "sharepoint.com", "onedrive.com", "msauth.net", "msftauth.net", "azure.com", "github.com", "linkedin.com"),
        listOf("apple.com", "icloud.com", "apple-cloudkit.com", "mzstatic.com"),
        listOf("amazon.com", "amazon.in", "amazon.co.uk", "media-amazon.com", "ssl-images-amazon.com", "primevideo.com"),
        listOf("facebook.com", "fbcdn.net", "instagram.com", "cdninstagram.com", "whatsapp.com", "whatsapp.net", "messenger.com", "threads.net"),
        listOf("x.com", "twitter.com", "twimg.com"),
        listOf("yahoo.com", "yimg.com", "aol.com"),
        listOf("paypal.com", "paypalobjects.com"),
    )
    private val PARTY = HashMap<String, Int>().apply { PARTY_GROUPS.forEachIndexed { i, g -> g.forEach { put(it, i) } } }

    fun sameParty(a: String, b: String): Boolean {
        val sa = siteOf(a); val sb = siteOf(b)
        if (sa == sb) return true
        val ga = PARTY[sa]; val gb = PARTY[sb]
        return ga != null && ga == gb
    }

    fun isException(host: String, exceptions: Collection<String>): Boolean {
        val s = siteOf(host)
        return exceptions.any { e ->
            val x = e.lowercase().replace(Regex("^https?://"), "").replace(Regex("/.*$"), "").removePrefix("www.")
            x.isNotEmpty() && (siteOf(x) == s || sameParty(x, host))
        }
    }

    private val TRACK = Regex("^(utm_[a-z_]+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|yclid|twclid|ttclid|li_fat_id|igshid|igsh|mc_cid|mc_eid|_hsenc|_hsmi|__hssc|__hstc|__hsfp|hsctatracking|mkt_tok|vero_conv|vero_id|oly_anon_id|oly_enc_id|rb_clickid|s_kwcid|ef_id|epik|wickedid|_openstat|spm|scm|trk|trkCampaign|sc_cid|ncid|cmpid|icid|ref_src|ref_url|referrer_id|zanpid|irclickid|cjevent|ranMID|ranEAID|ranSiteID|_branch_match_id|_kx|sr_share|si|feature|pp|xmt|guccounter|guce_referrer|guce_referrer_sig|ga_source|ga_medium|ga_campaign|ga_term|ga_content)$", RegexOption.IGNORE_CASE)
    private val GENERIC = setOf("si", "feature", "pp", "spm", "scm", "trk", "icid", "ncid", "cmpid")
    private val GENERIC_ON = setOf("youtube.com", "youtu.be", "spotify.com", "aliexpress.com", "linkedin.com", "instagram.com", "yahoo.com")

    fun cleanUrl(url: String): String {
        val m = Regex("^(https?://[^?#]+)(\\?[^#]*)?(#.*)?$", RegexOption.IGNORE_CASE).find(url) ?: return url
        val base = m.groupValues[1]; val query = m.groupValues[2].removePrefix("?"); val frag = m.groupValues[3].removePrefix("#")
        val site = siteOf(hostOf(url))
        val ps = pairs(query)
        val kept = ps.filter { (k, _) -> !(TRACK.matches(k) && (k !in GENERIC || site in GENERIC_ON)) }
        val badHash = Regex("^(utm_|xtor=)").containsMatchIn(frag)
        if (kept.size == ps.size && !badHash) return url
        return base + (if (kept.isEmpty()) "" else "?" + kept.joinToString("&") { it.second }) + (if (frag.isEmpty() || badHash) "" else "#$frag")
    }

    fun unwrapRedirect(url: String): String? {
        val u = try { URI(url) } catch (e: Exception) { return null }
        val h = (u.host ?: return null).lowercase().removePrefix("www."); val p = u.rawPath ?: ""
        val rq = u.rawQuery
        fun q(k: String) = param(rq, k)
        val target = when {
            Regex("^google\\.[a-z.]+$").matches(h) && p == "/url" -> q("q") ?: q("url")
            (h == "l.facebook.com" || h == "lm.facebook.com") && p == "/l.php" -> q("u")
            h == "l.instagram.com" -> q("u")
            h == "youtube.com" && p == "/redirect" -> q("q")
            h == "out.reddit.com" -> q("url")
            h == "href.li" -> dec(rq ?: "")
            h == "steamcommunity.com" && p == "/linkfilter/" -> q("url") ?: q("u")
            h == "away.vk.com" && p == "/away.php" -> q("to")
            Regex("(^|\\.)safelinks\\.protection\\.outlook\\.com$").containsMatchIn(h) -> q("url")
            h == "click.linksynergy.com" -> q("murl")
            h == "disq.us" && p == "/url" -> (q("url") ?: "").replace(Regex(":[\\w-]+$"), "")
            h == "slack-redir.net" && p == "/link" -> q("url")
            h == "deref-gmx.net" || h == "deref-web.de" -> q("redirectUrl")
            else -> null
        }
        if (target == null || !Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(target)) return null
        return cleanUrl(target)
    }

    private val AD_HOSTS = """
        doubleclick.net googlesyndication.com googleadservices.com google-analytics.com googletagservices.com
        adservice.google.com pagead2.googlesyndication.com analytics.google.com
        adnxs.com adsrvr.org advertising.com adform.net adroll.com amazon-adsystem.com
        criteo.com criteo.net casalemedia.com contextweb.com demdex.net everesttech.net exelator.com
        moatads.com mathtag.com openx.net outbrain.com pubmatic.com quantserve.com rubiconproject.com
        scorecardresearch.com sharethrough.com smartadserver.com spotxchange.com taboola.com teads.tv
        yieldmo.com zedo.com media.net revcontent.com mgid.com adcolony.com applovin.com
        hotjar.com mouseflow.com fullstory.com crazyegg.com clarity.ms
        connect.facebook.net ads-twitter.com analytics.twitter.com static.ads-twitter.com
        ads.linkedin.com px.ads.linkedin.com bat.bing.com ads.yahoo.com
        adsafeprotected.com doubleverify.com serving-sys.com 2mdn.net imasdk.googleapis.com
        popads.net popcash.net propellerads.com adcash.com exoclick.com juicyads.com trafficjunky.net
        onclickads.net adsterra.com hilltopads.net clickadu.com
        app-measurement.com firebase-analytics.com googletagmanager.com
    """.split(Regex("\\s+")).filter { it.isNotBlank() }.toSet()

    fun isBlocked(url: String): Boolean {
        val host = hostOf(url).lowercase()
        if (host.isEmpty()) return false
        val parts = host.split('.')
        for (i in 0 until parts.size - 1) if (parts.subList(i, parts.size).joinToString(".") in AD_HOSTS) return true
        return false
    }

    /** Pages never kept in the private page memory (desktop: login, banking, email). */
    fun isSensitive(url: String): Boolean =
        Regex("(login|signin|sign-in|account|auth|bank|checkout|payment|password|mail\\.|webmail|wallet|upi|netbanking)", RegexOption.IGNORE_CASE).containsMatchIn(url)
}
