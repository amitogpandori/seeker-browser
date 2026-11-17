package com.seeker.browser.downloads

import kotlinx.coroutines.delay
import java.net.URI
import kotlin.math.min

/** Pure helpers shared with the desktop engine (src/main/downloads.js) — unit-tested on the JVM. */
object Extras {
    val CATEGORIES = linkedMapOf(
        "Compressed" to listOf("zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "tgz", "cab"),
        "Documents" to listOf("pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "odt", "ods", "csv", "epub"),
        "Music" to listOf("mp3", "wav", "flac", "aac", "m4a", "ogg", "wma", "opus"),
        "Video" to listOf("mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts", "3gp", "mpg", "mpeg"),
        "Programs" to listOf("exe", "msi", "apk", "appx", "msix", "bat", "dmg", "deb", "rpm"),
        "Images" to listOf("jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "avif", "ico"),
    )
    fun categoryOf(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return CATEGORIES.entries.firstOrNull { ext in it.value }?.key ?: "General"
    }

    /** "https://x.com/img[01-12].jpg" or "[a-e]" → list of URLs (IDM batch download). */
    fun expandBatch(pattern: String): List<String> {
        val m = Regex("\\[([0-9]+|[a-zA-Z])-([0-9]+|[a-zA-Z])\\]").find(pattern) ?: return listOf(pattern)
        val (whole, a, b) = m.groupValues.let { Triple(it[0], it[1], it[2]) }
        val out = mutableListOf<String>()
        val first = pattern.substring(0, m.range.first); val rest = pattern.substring(m.range.last + 1)
        if (a.all { it.isDigit() } && b.all { it.isDigit() }) {
            val width = if (a.length > 1 && a.startsWith('0')) a.length else 0
            val from = a.toLong(); val to = b.toLong()
            require(kotlin.math.abs(to - from) <= 10000) { "Batch range too large" }
            val step = if (from <= to) 1 else -1
            var i = from
            while (if (step > 0) i <= to else i >= to) { out += expandBatch(first + i.toString().padStart(width, '0') + rest); i += step }
        } else if (a.length == 1 && b.length == 1 && !a[0].isDigit() && !b[0].isDigit()) {
            for (c in a[0]..b[0]) out += expandBatch(first + c + rest)
        } else return listOf(pattern)
        require(out.size <= 10000) { "Batch range too large" }
        check(whole.isNotEmpty())
        return out
    }

    data class Variant(val bandwidth: Long, val url: String, val resolution: String)
    data class Media(val encrypted: Boolean, val init: String?, val segments: List<String>)

    private fun resolve(base: String, ref: String) = URI(base).resolve(ref.trim().replace(" ", "%20")).toString()

    fun isMaster(text: String) = text.contains("#EXT-X-STREAM-INF")

    fun parseMaster(text: String, base: String): List<Variant> {
        val lines = text.split(Regex("\\r?\\n"))
        val out = mutableListOf<Variant>()
        for (i in lines.indices) {
            if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue
            val bw = Regex("BANDWIDTH=(\\d+)").find(lines[i])?.groupValues?.get(1)?.toLong() ?: 0
            val res = Regex("RESOLUTION=(\\d+x\\d+)").find(lines[i])?.groupValues?.get(1) ?: ""
            var j = i + 1
            while (j < lines.size && (lines[j].isBlank() || lines[j].startsWith("#"))) j++
            if (j < lines.size) out += Variant(bw, resolve(base, lines[j]), res)
        }
        return out.sortedByDescending { it.bandwidth }
    }

    fun parseMedia(text: String, base: String): Media {
        val lines = text.split(Regex("\\r?\\n")).map { it.trim() }
        val encrypted = lines.any { it.startsWith("#EXT-X-KEY") && !it.contains("METHOD=NONE") }
        val init = lines.firstOrNull { it.startsWith("#EXT-X-MAP") }?.let { Regex("URI=\"([^\"]+)\"").find(it)?.groupValues?.get(1) }
        return Media(encrypted, init?.let { resolve(base, it) }, lines.filter { it.isNotEmpty() && !it.startsWith("#") }.map { resolve(base, it) })
    }
}

/** Token bucket for the speed limiter; [rate] is bytes/second, 0 = unlimited. */
class Throttle(private val rate: () -> Long) {
    private var avail = 0.0
    private var last = System.nanoTime()
    suspend fun take(n: Int) {
        while (true) {
            val r = rate()
            if (r <= 0) return
            val wait = synchronized(this) {
                val now = System.nanoTime()
                avail = min(r.toDouble(), avail + (now - last) / 1e9 * r); last = now
                if (avail >= min(n.toDouble(), r.toDouble())) { avail -= n; 0L }
                else ((min(n.toDouble(), r.toDouble()) - avail) / r * 1000).toLong().coerceIn(5, 1000)
            }
            if (wait == 0L) return
            delay(wait)
        }
    }
}

/** Settings → Downloads → speed limit, shared by every download. */
val GlobalThrottle = Throttle { if (com.seeker.browser.Prefs.ready) com.seeker.browser.Prefs.speedLimitKB * 1024 else 0 }
