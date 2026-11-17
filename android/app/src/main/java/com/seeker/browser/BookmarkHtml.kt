package com.seeker.browser

/** Netscape bookmark file format, pure Kotlin so it can be unit-tested. */
object BookmarkHtml {
    private fun unescape(s: String) = s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")
    private fun escape(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    fun parse(html: String): List<Pair<String, String>> =
        Regex("<a\\s[^>]*href\\s*=\\s*\"([^\"]+)\"[^>]*>(.*?)</a>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL)).findAll(html)
            .map { unescape(it.groupValues[1]).trim() to unescape(it.groupValues[2].replace(Regex("<[^>]+>"), "")).trim() }
            .filter { it.first.matches(Regex("^https?://.+", RegexOption.IGNORE_CASE)) }
            .map { if (it.second.isEmpty()) it.first to it.first else it }
            .toList()

    fun write(items: List<Pair<String, String>>): String = buildString {
        append("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n")
        append("    <DT><H3>Seeker</H3>\n    <DL><p>\n")
        for ((u, t) in items) append("        <DT><A HREF=\"").append(escape(u)).append("\">").append(escape(t)).append("</A>\n")
        append("    </DL><p>\n</DL><p>\n")
    }
}
