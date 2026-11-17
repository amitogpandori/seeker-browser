package com.seeker.browser.downloads

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExtrasTest {
    @Test fun batchPatterns() {
        assertEquals(listOf("u1", "u2", "u3"), Extras.expandBatch("u[1-3]"))
        assertEquals(listOf("i08.jpg", "i09.jpg", "i10.jpg"), Extras.expandBatch("i[08-10].jpg"))
        assertEquals(listOf("a3", "a2"), Extras.expandBatch("a[3-2]"))
        assertEquals(listOf("xa1", "xa2", "xb1", "xb2"), Extras.expandBatch("x[a-b][1-2]"))
        assertEquals(listOf("plain"), Extras.expandBatch("plain"))
        assertTrue(runCatching { Extras.expandBatch("x[1-99999]") }.isFailure)
    }

    @Test fun categories() {
        assertEquals("Video", Extras.categoryOf("Movie.MKV"))
        assertEquals("Programs", Extras.categoryOf("seeker.apk"))
        assertEquals("General", Extras.categoryOf("noext"))
    }

    @Test fun hlsMasterAndMedia() {
        val master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720\nhttps://cdn.x/hi.m3u8\n"
        assertTrue(Extras.isMaster(master))
        val v = Extras.parseMaster(master, "https://site.com/v/master.m3u8")
        assertEquals("https://cdn.x/hi.m3u8", v[0].url)
        assertEquals("https://site.com/v/low/index.m3u8", v[1].url)
        assertEquals("1280x720", v[0].resolution)
        val media = Extras.parseMedia("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\nseg1.m4s\n#EXTINF:4,\n/abs/seg2.m4s\n#EXT-X-ENDLIST", "https://s.com/a/b.m3u8")
        assertFalse(media.encrypted)
        assertEquals("https://s.com/a/init.mp4", media.init)
        assertEquals(listOf("https://s.com/a/seg1.m4s", "https://s.com/abs/seg2.m4s"), media.segments)
        assertTrue(Extras.parseMedia("#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\nx.ts", "https://s.com/").encrypted)
        assertNull(Extras.parseMedia("#EXT-X-KEY:METHOD=NONE\nx.ts", "https://s.com/").init)
    }

    @Test fun throttleLimitsRate() = runBlocking {
        val t = Throttle { 1024L * 1024 }              // 1 MB/s
        val start = System.nanoTime()
        repeat(8) { t.take(64 * 1024) }               // 512 KB
        val ms = (System.nanoTime() - start) / 1_000_000
        assertTrue("took $ms ms", ms in 400..1500)
        val free = Throttle { 0 }
        val s2 = System.nanoTime(); repeat(100) { free.take(1 shl 20) }
        assertTrue((System.nanoTime() - s2) / 1_000_000 < 50)
    }
}
