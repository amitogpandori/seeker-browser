package com.seeker.browser.downloads

import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

/** Runs the real multi-connection engine against a local HTTP server (JVM, no device needed). */
class EngineTest {
    private val data = Random(7).nextBytes(12 * 1024 * 1024 + 12345)
    private val rangeRequests = AtomicInteger()
    private var throttle = 0L          // ms per 64 KB, to keep connections busy so stealing happens
    private var noRanges = false
    private var failFirst = AtomicInteger(0)
    private val base get() = "http://127.0.0.1:${server.port}"

    /** Minimal HTTP/1.1 server (one request per connection) — android.jar has no com.sun HttpServer. */
    private inner class TinyServer {
        val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        val port get() = socket.localPort
        @Volatile var running = true
        fun start() = thread(isDaemon = true) {
            while (running) {
                val c = try { socket.accept() } catch (e: Exception) { break }
                thread(isDaemon = true) { try { c.use { handle(it) } } catch (e: Exception) { } }
            }
        }
        private fun handle(c: Socket) {
            val r = c.getInputStream().bufferedReader(Charsets.ISO_8859_1)
            r.readLine() ?: return
            val headers = HashMap<String, String>()
            while (true) { val l = r.readLine() ?: break; if (l.isEmpty()) break; val i = l.indexOf(':'); if (i > 0) headers[l.substring(0, i).trim().lowercase()] = l.substring(i + 1).trim() }
            val out = c.getOutputStream()
            fun head(code: Int, msg: String, h: Map<String, Any>) {
                val sb = StringBuilder("HTTP/1.1 $code $msg\r\nConnection: close\r\n")
                h.forEach { (k, v) -> sb.append("$k: $v\r\n") }
                out.write(sb.append("\r\n").toString().toByteArray(Charsets.ISO_8859_1))
            }
            if (failFirst.getAndDecrement() > 0) { head(503, "Unavailable", mapOf("Content-Length" to 0)); return }
            val m = headers["range"]?.let { Regex("bytes=(\\d+)-(\\d*)").find(it) }
            if (m != null && !noRanges) {
                rangeRequests.incrementAndGet()
                val s = m.groupValues[1].toInt()
                val e = m.groupValues[2].takeIf { it.isNotEmpty() }?.toInt()?.coerceAtMost(data.size - 1) ?: (data.size - 1)
                head(206, "Partial Content", mapOf("Content-Range" to "bytes $s-$e/${data.size}", "Accept-Ranges" to "bytes", "Content-Length" to (e - s + 1)))
                var p = s
                val pause = if (s == 0) throttle * 4 else throttle   // the first connection is slow, like a congested server
                while (p <= e) { val n = minOf(65536, e - p + 1); out.write(data, p, n); p += n; if (pause > 0) Thread.sleep(pause) }
            } else {
                head(200, "OK", mapOf("Content-Length" to data.size))
                out.write(data)
            }
            out.flush()
        }
    }
    private lateinit var server: TinyServer

    @Before fun start() { server = TinyServer(); server.start() }
    @After fun stop() { server.running = false; server.socket.close() }

    private fun item(conn: Int = 4) = DownloadItem("t", "$base/file.bin", "file.bin", "", -1, conn, "test", null, null, false)
    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b)

    @Test fun planSplitsIntoConnectionsWithMinimumSize() {
        val p = Engine.plan(10L shl 20, 8)
        assertEquals(8, p.size)
        assertEquals(0, p.first().start); assertEquals((10L shl 20) - 1, p.last().end)
        for (i in 1 until p.size) assertEquals(p[i - 1].end + 1, p[i].start)
        assertEquals(1, Engine.plan(500_000, 8).size)          // small file: one connection
        assertEquals(3, Engine.plan(3L shl 20, 8).size)        // never below 1 MB per part
        assertEquals(Long.MAX_VALUE, Engine.plan(-1, 8).single().end) // unknown size
    }

    @Test fun stealSplitsTheLargestActiveSegment() {
        val segs = mutableListOf(Segment(0, 9_999_999, 1_000_000).apply { active = true }, Segment(10_000_000, 19_999_999, 19_000_000).apply { active = true })
        val ns = Engine.steal(segs)
        assertNotNull(ns)
        assertEquals(5_500_000, ns!!.start); assertEquals(9_999_999, ns.end)
        assertEquals(5_499_999, segs[0].end)
        val tiny = mutableListOf(Segment(0, 1_000_000, 0).apply { active = true })
        assertEquals(null, Engine.steal(tiny))                 // < 2 MB left: no split
    }

    @Test fun backoffGrowsAndIsCapped() {
        assertTrue(Engine.backoff(1) in 375..625)
        assertTrue(Engine.backoff(3) in 1500..2500)
        assertTrue(Engine.backoff(30) <= 18750)
    }

    @Test fun parsesContentDisposition() {
        assertEquals("report 2026.pdf", Engine.parseFileName("attachment; filename*=UTF-8''report%202026.pdf"))
        assertEquals("a.zip", Engine.parseFileName("attachment; filename=\"a.zip\""))
    }

    @Test fun multiSegmentDownloadIsByteExact() = runBlocking {
        val f = File.createTempFile("seeker-dl", ".part")
        val it = item(6)
        throttle = 2
        var maxLive = 0
        val mon = launch(kotlinx.coroutines.Dispatchers.IO) { while (true) { maxLive = maxOf(maxLive, it.liveConnections); delay(20) } }
        Engine(it, f).run()
        mon.cancel()
        assertTrue("connections ran in parallel (max live $maxLive)", maxLive >= 4)
        assertTrue(it.resumable)
        assertTrue(it.segments.size >= 6)
        assertArrayEquals(sha(data), sha(f.readBytes()))
    }

    @Test fun pauseAndResumeContinuesWhereItStopped() = runBlocking {
        throttle = 20
        val f = File.createTempFile("seeker-dl", ".part")
        val it = item(4)
        val e1 = Engine(it, f)
        val job = launch(kotlinx.coroutines.Dispatchers.IO) { try { e1.run() } catch (x: Exception) { } }
        delay(400)
        job.cancel(); e1.abort(); job.join()
        val done = it.segments.sumOf { s -> minOf(s.pos, s.end + 1) - s.start }
        assertTrue("some progress before pause", done > 0)
        assertTrue("not finished before pause", done < data.size)
        throttle = 0
        val before = rangeRequests.get()
        Engine(it, f).run()
        assertTrue(rangeRequests.get() > before)
        assertArrayEquals(sha(data), sha(f.readBytes()))
    }

    @Test fun dynamicSplittingKeepsConnectionsBusy() = runBlocking {
        throttle = 4
        val f = File.createTempFile("seeker-dl", ".part")
        val it = item(4)
        Engine(it, f).run()
        assertTrue("segments were split (got ${it.segments.size})", it.segments.size > 4)
        assertArrayEquals(sha(data), sha(f.readBytes()))
    }

    @Test fun serverWithoutRangesUsesOneConnection() = runBlocking {
        noRanges = true
        val f = File.createTempFile("seeker-dl", ".part")
        val it = item(8)
        Engine(it, f).run()
        assertEquals(false, it.resumable)
        assertEquals(1, it.segments.size)
        assertArrayEquals(sha(data), sha(f.readBytes()))
    }

    @Test fun transientErrorsAreRetried() = runBlocking {
        val f = File.createTempFile("seeker-dl", ".part")
        val it = item(2)
        Engine(it, f).probe().let { p -> it.size = p.size; it.resumable = p.resumable; it.segments.addAll(Engine.plan(p.size, 2)) }
        failFirst.set(2)       // first two segment requests get HTTP 503
        Engine(it, f).run()
        assertArrayEquals(sha(data), sha(f.readBytes()))
    }
}
