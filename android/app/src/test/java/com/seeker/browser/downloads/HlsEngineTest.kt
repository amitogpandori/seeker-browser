package com.seeker.browser.downloads

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread
import kotlin.random.Random

class HlsEngineTest {
    private val segs = (0 until 7).map { Random(it).nextBytes(50_000 + it * 1000) }
    private var encrypted = false
    private lateinit var socket: ServerSocket
    private val base get() = "http://127.0.0.1:${socket.localPort}"

    private fun body(path: String): ByteArray? = when {
        path == "/master.m3u8" -> "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhi.m3u8\n".toByteArray()
        path == "/hi.m3u8" -> buildString {
            append("#EXTM3U\n#EXT-X-TARGETDURATION:4\n"); if (encrypted) append("#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n")
            segs.indices.forEach { append("#EXTINF:4,\nseg$it.ts\n") }; append("#EXT-X-ENDLIST\n")
        }.toByteArray()
        path.startsWith("/seg") -> segs[path.removePrefix("/seg").removeSuffix(".ts").toInt()]
        else -> null
    }

    @Before fun start() {
        socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        thread(isDaemon = true) {
            while (true) {
                val c = try { socket.accept() } catch (e: Exception) { break }
                thread(isDaemon = true) {
                    try {
                        c.use {
                            val r = it.getInputStream().bufferedReader(Charsets.ISO_8859_1)
                            val path = r.readLine()?.split(" ")?.getOrNull(1) ?: return@use
                            while (true) { val l = r.readLine() ?: break; if (l.isEmpty()) break }
                            val b = body(path)
                            val out = it.getOutputStream()
                            if (b == null) out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                            else { out.write("HTTP/1.1 200 OK\r\nContent-Length: ${b.size}\r\nConnection: close\r\n\r\n".toByteArray()); out.write(b) }
                            out.flush()
                        }
                    } catch (e: Exception) { }
                }
            }
        }
    }
    @After fun stop() { socket.close() }

    private fun item() = DownloadItem("h", "$base/master.m3u8", "v.ts", "video/mp2t", -1, 3, "test", null, null, false).also { it.kind = "hls" }

    @Test fun savesBestVariantInOrder() = runBlocking<Unit> {
        val f = File.createTempFile("hls", ".part"); f.delete()
        val it = item()
        HlsEngine(it, f).run()
        val expect = segs.fold(ByteArray(0)) { a, b -> a + b }
        assertArrayEquals(expect, f.readBytes())
        assertEquals(segs.size, it.hlsDone); assertEquals(expect.size.toLong(), it.size)
        f.delete()
    }

    @Test fun resumesFromLastWholeSegment() = runBlocking<Unit> {
        val f = File.createTempFile("hls", ".part")
        val it = item()
        // pretend 3 segments were saved, plus half of the 4th (an interrupted write)
        f.writeBytes(segs[0] + segs[1] + segs[2] + segs[3].copyOf(1000))
        it.hlsTotal = segs.size; it.hlsDone = 3; it.received = (segs[0].size + segs[1].size + segs[2].size).toLong()
        HlsEngine(it, f).run()
        assertArrayEquals(segs.fold(ByteArray(0)) { a, b -> a + b }, f.readBytes())
        f.delete()
    }

    @Test fun refusesEncryptedStreams() = runBlocking<Unit> {
        encrypted = true
        val f = File.createTempFile("hls", ".part")
        val r = runCatching { HlsEngine(item(), f).run() }
        assertTrue(r.exceptionOrNull()?.message?.contains("encrypted") == true)
        f.delete()
    }
}
