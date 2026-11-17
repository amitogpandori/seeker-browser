package com.seeker.browser

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

data class Entry(val url: String, val title: String, val time: Long)

/** Bookmarks, history and new-tab shortcuts (normal tabs only; incognito never writes here). */
object Store {
    private lateinit var prefs: SharedPreferences
    private val bookmarks = mutableListOf<Entry>()
    private val history = mutableListOf<Entry>()
    private const val MAX_HISTORY = 5000

    fun init(ctx: Context) {
        prefs = ctx.getSharedPreferences("seeker", Context.MODE_PRIVATE)
        bookmarks.clear(); bookmarks.addAll(load("bookmarks"))
        history.clear(); history.addAll(load("history"))
    }

    private fun load(key: String): List<Entry> = try {
        val a = JSONArray(prefs.getString(key, "[]"))
        (0 until a.length()).map { a.getJSONObject(it).let { o -> Entry(o.getString("url"), o.optString("title"), o.optLong("t")) } }
    } catch (e: Exception) { emptyList() }

    private fun save(key: String, list: List<Entry>) {
        val a = JSONArray()
        list.forEach { a.put(JSONObject().put("url", it.url).put("title", it.title).put("t", it.time)) }
        prefs.edit().putString(key, a.toString()).apply()
    }

    // ----- bookmarks
    fun bookmarks(): List<Entry> = bookmarks.toList()
    fun isBookmarked(url: String) = bookmarks.any { it.url == url }
    fun toggleBookmark(url: String, title: String): Boolean {
        val had = bookmarks.removeAll { it.url == url }
        if (!had) bookmarks.add(0, Entry(url, title.ifBlank { url }, System.currentTimeMillis()))
        save("bookmarks", bookmarks)
        return !had
    }
    fun removeBookmark(url: String) { bookmarks.removeAll { it.url == url }; save("bookmarks", bookmarks) }
    /** Netscape bookmark file (Chrome/Edge/Firefox/Seeker desktop export). Returns how many were added. */
    fun importBookmarksHtml(html: String): Int {
        val have = bookmarks.map { it.url }.toMutableSet()
        var n = 0
        for (m in BookmarkHtml.parse(html)) if (have.add(m.first)) { bookmarks.add(Entry(m.first, m.second, System.currentTimeMillis())); n++ }
        save("bookmarks", bookmarks)
        return n
    }
    fun exportBookmarksHtml(): String = BookmarkHtml.write(bookmarks.map { it.url to it.title })

    fun clearBookmarks() { bookmarks.clear(); save("bookmarks", bookmarks) }

    // ----- history
    fun history(): List<Entry> = history.toList()
    fun recordVisit(url: String, title: String) {
        if (!url.startsWith("http")) return
        val now = System.currentTimeMillis()
        val last = history.firstOrNull()
        if (last != null && last.url == url && now - last.time < 30 * 60_000) history[0] = Entry(url, title.ifBlank { last.title }, now)
        else history.add(0, Entry(url, title, now))
        while (history.size > MAX_HISTORY) history.removeAt(history.size - 1)
        save("history", history)
    }
    fun updateTitle(url: String, title: String) {
        val i = history.indexOfFirst { it.url == url }
        if (i == 0 && title.isNotBlank()) { history[0] = history[0].copy(title = title); save("history", history) }
    }
    fun removeHistory(e: Entry) { history.remove(e); save("history", history) }
    fun clearHistory() { history.clear(); save("history", history) }

    /** Most visited sites for the Seeker new-tab shortcuts (same shape as desktop history.top). */
    fun topSites(n: Int): JSONArray {
        val hidden = newtab().optJSONArray("hidden")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() } ?: emptySet()
        val counts = LinkedHashMap<String, Pair<String, Int>>()
        for (h in history.take(3000)) {
            val origin = try { URI(h.url).let { "${it.scheme}://${it.host}" } } catch (e: Exception) { continue }
            val c = counts[origin]
            counts[origin] = Pair(c?.first ?: h.title, (c?.second ?: 0) + 1)
        }
        val out = JSONArray()
        counts.entries.filter { "${it.key}/" !in hidden && it.key !in hidden }
            .sortedByDescending { it.value.second }.take(n)
            .forEach { out.put(JSONObject().put("url", "${it.key}/").put("title", it.value.first).put("n", it.value.second)) }
        return out
    }

    // ----- Seeker new-tab settings (desktop: settings.newtab)
    fun newtab(): JSONObject = try { JSONObject(prefs.getString("newtab", null) ?: "{}") } catch (e: Exception) { JSONObject() }
        .apply { if (!has("shortcuts")) put("shortcuts", "mostVisited"); if (!has("custom")) put("custom", JSONArray()); if (!has("hidden")) put("hidden", JSONArray()) }

    fun setNewtab(patch: JSONObject): JSONObject {
        val nt = newtab()
        patch.keys().forEach { nt.put(it, patch.get(it)) }
        val custom = nt.optJSONArray("custom") ?: JSONArray()
        val safe = JSONArray()
        for (i in 0 until custom.length()) { val c = custom.optJSONObject(i) ?: continue; if (c.optString("url").matches(Regex("^https?://.*", RegexOption.IGNORE_CASE)) && safe.length() < 24) safe.put(c) }
        nt.put("custom", safe)
        prefs.edit().putString("newtab", nt.toString()).apply()
        return nt
    }
}
