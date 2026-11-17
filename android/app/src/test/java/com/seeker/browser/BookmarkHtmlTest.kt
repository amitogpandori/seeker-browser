package com.seeker.browser

import org.junit.Assert.assertEquals
import org.junit.Test

class BookmarkHtmlTest {
    @Test fun parsesChromeExportAndRoundTrips() {
        val html = """<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
            <DT><H3>Bar</H3><DL><p>
            <DT><A HREF="https://a.com/?x=1&amp;y=2" ADD_DATE="1">A &amp; B</A>
            <DT><A HREF="javascript:alert(1)">bad</A>
            <DT><A HREF="http://b.org">  </A>
            </DL><p></DL>"""
        val got = BookmarkHtml.parse(html)
        assertEquals(listOf("https://a.com/?x=1&y=2" to "A & B", "http://b.org" to "http://b.org"), got)
        assertEquals(got, BookmarkHtml.parse(BookmarkHtml.write(got)))
    }
}
