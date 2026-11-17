package com.seeker.browser.downloads

import com.seeker.browser.Route
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import kotlin.coroutines.coroutineContext

/**
 * Saves an HLS stream (.m3u8, what most sites use for video) as one .ts file, like the desktop
 * media grabber: picks the best variant, downloads several segments in parallel and appends them
 * in order. Resumes from the last whole segment. Encrypted (DRM) streams are refused.
 */
class HlsEngine(private val item: DownloadItem, private val partFile: File) : Runner {
    private val open = java.util.concurrent.ConcurrentHashMap.newKeySet<HttpURLConnection>()
    override fun abort() { open.forEach { try { it.disconnect() } catch (e: Exception) { } } }

    private fun get(url: String): ByteArray {
        val c = Route.open(url)
        open.add(c)
        try {
            c.connectTimeout = 15000; c.readTimeout = 20000
            c.setRequestProperty("User-Agent", item.userAgent)
            item.cookies?.let { c.setRequestProperty("Cookie", it) }
            item.referrer?.let { c.setRequestProperty("Referer", it) }
            val code = c.responseCode
            if (code >= 400) { if (code in 400..499 && code != 408 && code != 429) throw Engine.Fatal("Server returned HTTP $code"); throw IOException("HTTP $code") }
            return c.inputStream.use { it.readBytes() }
        } finally { c.disconnect(); open.remove(c) }
    }

    private suspend fun getRetry(url: String): ByteArray {
        var attempt = 0
        while (true) {
            coroutineContext.ensureActive()
            try { return get(url) } catch (e: Engine.Fatal) { throw e } catch (e: IOException) {
                if (++attempt > Engine.MAX_RETRIES) throw e
                delay(Engine.backoff(attempt))
            }
        }
    }

    override suspend fun run() {
        var url = item.url
        var text = String(getRetry(url))
        if (Extras.isMaster(text)) {
            val best = Extras.parseMaster(text, url).firstOrNull() ?: throw Engine.Fatal("No playable stream in this playlist")
            url = best.url; text = String(getRetry(url))
        }
        if (!text.contains("#EXTM3U")) throw Engine.Fatal("Not an HLS playlist")
        if (!text.contains("#EXT-X-ENDLIST")) throw Engine.Fatal("This is a live stream; only finished videos can be saved")
        val media = Extras.parseMedia(text, url)
        if (media.encrypted) throw Engine.Fatal("This video is encrypted (DRM) and can't be downloaded")
        val parts = (listOfNotNull(media.init) + media.segments)
        if (parts.isEmpty()) throw Engine.Fatal("Empty playlist")
        if (item.hlsTotal != parts.size) { item.hlsDone = 0; item.received = 0 }
        item.hlsTotal = parts.size
        item.status = Status.DOWNLOADING
        RandomAccessFile(partFile, "rw").use { raf ->
            raf.setLength(item.received.coerceAtMost(raf.length()))       // drop a half-written segment
            raf.seek(raf.length())
            val par = item.connections.coerceIn(1, 6)
            coroutineScope {
                var i = item.hlsDone
                while (i < parts.size) {
                    coroutineContext.ensureActive()
                    val batch = (i until minOf(parts.size, i + par)).map { k -> async(Dispatchers.IO) { getRetry(parts[k]) } }
                    for (d in batch) {
                        val b = d.await()
                        GlobalThrottle.take(b.size); item.throttle.take(b.size)
                        raf.write(b)
                        item.received += b.size; item.windowBytes += b.size
                        item.hlsDone++
                    }
                    i = item.hlsDone
                }
            }
        }
        item.size = item.received
    }
}
