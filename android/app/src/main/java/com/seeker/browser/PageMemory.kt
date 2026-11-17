package com.seeker.browser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Private page memory (desktop: pageindex.json): pages you visit in normal tabs are searchable
 * from Seeker later. Stored only on the phone; never incognito/Tor, login, banking or email pages.
 */
object PageMemory {
    private lateinit var file: File
    private val items = mutableListOf<JSONObject>()
    private const val MAX = 1500

    fun init(ctx: Context) {
        file = File(ctx.filesDir, "pageindex.json")
        try { JSONArray(file.readText()).let { a -> for (i in 0 until a.length()) items.add(a.getJSONObject(i)) } } catch (e: Exception) { }
    }

    @Synchronized fun add(url: String, title: String, text: String) {
        if (!Prefs.pageMemory || Privacy.isSensitive(url) || text.length < 200) return
        items.removeAll { it.optString("url") == url }
        items.add(0, JSONObject().put("url", url).put("title", title).put("text", text.take(20000)).put("t", System.currentTimeMillis()))
        while (items.size > MAX) items.removeAt(items.size - 1)
        save()
    }

    @Synchronized fun clear() { items.clear(); save() }
    @Synchronized fun count() = items.size
    private fun save() { try { val a = JSONArray(); items.forEach { a.put(it) }; file.writeText(a.toString()) } catch (e: Exception) { } }

    /** Same shape as desktop searchPageIndex: [{title,url,snippet,source,score}] */
    @Synchronized fun search(q: String, n: Int): JSONArray {
        val terms = q.lowercase().split(Regex("\\W+")).filter { it.length > 2 }
        val out = JSONArray()
        if (terms.isEmpty()) return out
        items.map { it to score(it, terms) }.filter { it.second > 0 }.sortedByDescending { it.second }.take(n).forEach { (it, sc) ->
            val text = it.optString("text"); val i = terms.map { t -> text.lowercase().indexOf(t) }.filter { x -> x >= 0 }.minOrNull() ?: 0
            out.put(JSONObject().put("title", it.optString("title")).put("url", it.optString("url"))
                .put("snippet", text.substring(maxOf(0, i - 80), minOf(text.length, i + 200)).trim()).put("source", "Your pages").put("score", sc))
        }
        return out
    }

    private fun score(o: JSONObject, terms: List<String>): Double {
        val title = o.optString("title").lowercase(); val text = o.optString("text").lowercase()
        var s = 0.0; var hit = 0
        for (t in terms) {
            var c = 0; var i = text.indexOf(t); while (i >= 0 && c < 20) { c++; i = text.indexOf(t, i + 1) }
            if (title.contains(t)) s += 3
            if (c > 0) { s += 1 + Math.log(c.toDouble()); hit++ }
        }
        return if (hit * 2 >= terms.size) s else 0.0
    }
}
