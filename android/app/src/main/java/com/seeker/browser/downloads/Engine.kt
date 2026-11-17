package com.seeker.browser.downloads

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import kotlin.coroutines.coroutineContext
import kotlin.math.min
import kotlin.random.Random

/**
 * Multi-connection HTTP downloader, the same design as the desktop engine:
 * probe with a 1-byte Range request, split the file into segments, download them in parallel
 * with positional writes, and when a connection finishes early it steals half of the largest
 * remaining segment (dynamic splitting). Retries use exponential backoff with jitter.
 */
/** A running download: HTTP (multi-connection) or HLS. */
interface Runner { suspend fun run(); fun abort() }

class Engine(private val item: DownloadItem, private val partFile: File) : Runner {

    class Fatal(msg: String) : Exception(msg)

    data class Probe(val size: Long, val resumable: Boolean, val fileName: String?, val mime: String?)

    companion object {
        const val MIN_SEGMENT = 1L shl 20        // never create parts smaller than 1 MB
        const val MIN_SPLIT = 2L shl 20          // only steal work when ≥ 2 MB is left
        const val MAX_RETRIES = 6
        private const val BUF = 128 * 1024

        fun backoff(attempt: Int): Long = (min(15_000.0, 500.0 * (1 shl (attempt - 1).coerceAtMost(10))) * (0.75 + Random.nextDouble() * 0.5)).toLong()

        /** Initial segment plan: one per [connections], at least [MIN_SEGMENT] each. */
        fun plan(size: Long, connections: Int): List<Segment> {
            if (size <= 0) return listOf(Segment(0, Long.MAX_VALUE, 0))
            val n = (size / MIN_SEGMENT).coerceIn(1, connections.toLong()).toInt()
            val step = size / n
            return (0 until n).map { i ->
                val s = i * step
                val e = if (i == n - 1) size - 1 else (i + 1) * step - 1
                Segment(s, e, s)
            }
        }

        /** Split the active segment with the most bytes left; returns the new segment or null. */
        fun steal(segments: MutableList<Segment>): Segment? = synchronized(segments) {
            val victim = segments.filter { it.active && it.end != Long.MAX_VALUE && it.remaining >= MIN_SPLIT }.maxByOrNull { it.remaining } ?: return null
            val mid = victim.pos + victim.remaining / 2
            val ns = Segment(mid, victim.end, mid)
            victim.end = mid - 1
            segments.add(ns)
            ns
        }

        fun parseFileName(cd: String?): String? {
            if (cd == null) return null
            Regex("filename\\*\\s*=\\s*[^']*''([^;]+)", RegexOption.IGNORE_CASE).find(cd)?.let { return try { java.net.URLDecoder.decode(it.groupValues[1].trim(), "UTF-8") } catch (e: Exception) { null } }
            Regex("filename\\s*=\\s*\"?([^\";]+)\"?", RegexOption.IGNORE_CASE).find(cd)?.let { return it.groupValues[1].trim() }
            return null
        }
    }

    private val openConns = java.util.concurrent.ConcurrentHashMap.newKeySet<HttpURLConnection>()

    /** Pausing cancels the coroutines; this also unblocks reads stuck in the socket right away. */
    override fun abort() { openConns.forEach { try { it.disconnect() } catch (e: Exception) { /* closed */ } } }

    private fun open(range: String?): HttpURLConnection {
        val c = com.seeker.browser.Route.open(item.url)   // Tor/proxy route, fails closed
        openConns.add(c)
        c.connectTimeout = 15_000
        c.readTimeout = 20_000
        c.instanceFollowRedirects = true
        c.setRequestProperty("User-Agent", item.userAgent)
        c.setRequestProperty("Accept-Encoding", "identity")
        item.cookies?.let { c.setRequestProperty("Cookie", it) }
        item.referrer?.let { c.setRequestProperty("Referer", it) }
        range?.let { c.setRequestProperty("Range", it) }
        return c
    }

    fun probe(): Probe {
        val c = open("bytes=0-0")
        try {
            val code = c.responseCode
            if (code >= 400) throw Fatal("Server returned HTTP $code")
            val cr = c.getHeaderField("Content-Range")
            val total = cr?.substringAfter('/')?.trim()?.toLongOrNull()
            val name = parseFileName(c.getHeaderField("Content-Disposition"))
            val mime = c.contentType?.substringBefore(';')
            return if (code == 206 && total != null) Probe(total, true, name, mime)
            else Probe(c.getHeaderField("Content-Length")?.toLongOrNull() ?: -1, false, name, mime)
        } finally { c.disconnect(); openConns.remove(c) }
    }

    override suspend fun run() {
        if (item.segments.isEmpty()) {
            val p = probe()
            item.size = p.size
            item.resumable = p.resumable
            if (p.mime != null && item.mime.isBlank()) item.mime = p.mime
            val plan = if (p.resumable) plan(p.size, item.connections) else listOf(Segment(0, if (p.size > 0) p.size - 1 else Long.MAX_VALUE, 0))
            synchronized(item.segments) { item.segments.addAll(plan) }
            partFile.delete()
        }
        if (!item.resumable) synchronized(item.segments) { item.segments.forEach { it.pos = it.start } } // can't resume: start over
        item.status = Status.DOWNLOADING
        RandomAccessFile(partFile, "rw").use { raf ->
            if (item.size > 0 && raf.length() != item.size) raf.setLength(item.size)
            val ch = raf.channel
            val workers = if (item.resumable) item.connections else 1
            // blocking socket reads: each connection gets its own IO thread, whatever the caller's dispatcher
            coroutineScope { repeat(workers) { launch(Dispatchers.IO) { worker(ch) } } }
            ch.force(false)
        }
        val unfinished = synchronized(item.segments) { item.segments.any { it.end != Long.MAX_VALUE && it.pos <= it.end } }
        if (unfinished) throw IOException("Download stopped early")
    }

    private fun claim(): Segment? = synchronized(item.segments) {
        item.segments.firstOrNull { !it.active && it.pos <= it.end }?.also { it.active = true }
    } ?: steal(item.segments)?.also { synchronized(item.segments) { it.active = true } }

    private suspend fun worker(ch: FileChannel) {
        while (true) {
            coroutineContext.ensureActive()
            val seg = claim() ?: return
            try { fetch(seg, ch) } finally { seg.active = false; seg.speed = 0.0 }
        }
    }

    private suspend fun fetch(seg: Segment, ch: FileChannel) {
        var attempt = 0
        while (seg.pos <= seg.end) {
            coroutineContext.ensureActive()
            try {
                val range = if (item.resumable) "bytes=${seg.pos}-${if (seg.end == Long.MAX_VALUE) "" else seg.end}" else null
                val c = open(range)
                try {
                    val code = c.responseCode
                    if (code == 416 && seg.pos > seg.end) return
                    if (code >= 400) { if (code in 400..499 && code != 408 && code != 429) throw Fatal("Server returned HTTP $code"); throw IOException("HTTP $code") }
                    if (item.resumable && code != 206) throw Fatal("The server stopped supporting resume")
                    if (item.resumable) {
                        val start = c.getHeaderField("Content-Range")?.let { Regex("bytes\\s+(\\d+)-").find(it)?.groupValues?.get(1)?.toLongOrNull() }
                        if (start != null && start != seg.pos) throw IOException("Server sent the wrong range")
                    }
                    c.inputStream.use { input ->
                        val buf = ByteArray(BUF)
                        var fill = 0
                        while (true) {
                            coroutineContext.ensureActive()
                            val n = input.read(buf, fill, buf.size - fill)
                            if (n > 0) fill += n
                            // write in large blocks (fewer syscalls), or when the stream ends / the segment is full
                            val limit = if (seg.end == Long.MAX_VALUE) Long.MAX_VALUE else seg.end - seg.pos + 1
                            if (n < 0 || fill == buf.size || fill >= limit) {
                                val k = min(fill.toLong(), limit).toInt()
                                if (k > 0) {
                                    GlobalThrottle.take(k); item.throttle.take(k)
                                    val bb = ByteBuffer.wrap(buf, 0, k)
                                    var at = seg.pos
                                    while (bb.hasRemaining()) at += ch.write(bb, at)
                                    seg.pos += k
                                    seg.windowBytes += k
                                }
                                fill = 0
                                if (seg.end != Long.MAX_VALUE && seg.pos > seg.end) return   // done (or shortened by a steal)
                                if (n < 0) {
                                    if (seg.end == Long.MAX_VALUE) { seg.end = seg.pos - 1; item.size = seg.pos }
                                    if (seg.pos <= seg.end) throw IOException("Connection closed early")
                                    return
                                }
                            }
                            attempt = 0
                        }
                    }
                } finally { c.disconnect(); openConns.remove(c) }
            } catch (e: CancellationException) { throw e
            } catch (e: Fatal) { throw e
            } catch (e: IOException) {
                attempt++
                if (attempt > MAX_RETRIES) throw IOException("${e.message ?: "Network error"} (gave up after $MAX_RETRIES retries)")
                if (!item.resumable) { seg.pos = seg.start }
                delay(backoff(attempt))
            }
        }
    }
}
