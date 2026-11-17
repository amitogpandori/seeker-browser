package com.seeker.browser

import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ImageButton
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import java.net.URI
import java.text.DateFormat
import java.util.Date

/** Bookmarks or history (extra "mode"), searchable, tap to open in the browser. */
class ListActivity : AppCompatActivity() {
    private var history = false
    private var query = ""
    private var rows: List<Entry> = emptyList()
    private val adapter = Adapter()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_list)
        history = intent.getStringExtra("mode") == "history"
        findViewById<TextView>(R.id.title).setText(if (history) R.string.history else R.string.bookmarks)
        findViewById<View>(R.id.back).setOnClickListener { finish() }
        findViewById<View>(R.id.clear).setOnClickListener {
            MaterialAlertDialogBuilder(this).setMessage(if (history) "Clear all history?" else "Remove all bookmarks?")
                .setPositiveButton("Clear") { _, _ -> if (history) Store.clearHistory() else Store.clearBookmarks(); refresh() }
                .setNegativeButton(R.string.cancel, null).show()
        }
        findViewById<EditText>(R.id.search).addTextChangedListener(object : TextWatcher {
            override fun afterTextChanged(s: Editable?) { query = s.toString().trim().lowercase(); refresh() }
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })
        findViewById<RecyclerView>(R.id.list).apply { layoutManager = LinearLayoutManager(this@ListActivity); adapter = this@ListActivity.adapter }
        refresh()
    }

    private fun refresh() {
        val all = if (history) Store.history() else Store.bookmarks()
        rows = all.filter { query.isEmpty() || it.url.lowercase().contains(query) || it.title.lowercase().contains(query) }.take(1000)
        adapter.notifyDataSetChanged()
    }

    private inner class VH(v: View) : RecyclerView.ViewHolder(v) {
        val icon: TextView = v.findViewById(R.id.icon)
        val title: TextView = v.findViewById(R.id.title)
        val sub: TextView = v.findViewById(R.id.sub)
        val close: ImageButton = v.findViewById(R.id.close)
    }

    private inner class Adapter : RecyclerView.Adapter<VH>() {
        override fun getItemCount() = rows.size
        override fun onCreateViewHolder(p: ViewGroup, t: Int) = VH(LayoutInflater.from(p.context).inflate(R.layout.item_tab, p, false))
        override fun onBindViewHolder(h: VH, pos: Int) {
            val e = rows[pos]
            val host = try { URI(e.url).host?.removePrefix("www.") ?: e.url } catch (x: Exception) { e.url }
            h.icon.text = host.firstOrNull()?.uppercase() ?: "?"
            h.title.text = e.title.ifBlank { host }
            h.sub.text = if (history) "${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(e.time))} · $host" else e.url
            h.itemView.setOnClickListener {
                startActivity(Intent(this@ListActivity, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN, e.url).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                finish()
            }
            h.close.setOnClickListener { if (history) Store.removeHistory(e) else Store.removeBookmark(e.url); refresh() }
        }
    }
}
