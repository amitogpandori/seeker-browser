package com.seeker.browser.downloads

import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.WebSettings
import android.widget.EditText
import android.widget.ImageButton
import android.widget.PopupMenu
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.seeker.browser.Format
import com.seeker.browser.R
import java.text.DateFormat
import java.util.Date

/** Download manager screen, styled after the desktop seeker://downloads page. */
class DownloadsActivity : AppCompatActivity() {
    private enum class Filter(val label: String, val test: (DownloadItem) -> Boolean) {
        ALL("All", { true }),
        ACTIVE("Downloading", { it.isActive || it.status == Status.QUEUED }),
        UNFINISHED("Unfinished", { it.status != Status.COMPLETED }),
        DONE("Finished", { it.status == Status.COMPLETED }),
        FAILED("Failed", { it.status == Status.FAILED }),
    }

    private var filter = Filter.ALL
    private var query = ""
    private var shown: List<DownloadItem> = emptyList()
    private lateinit var adapter: Adapter
    private lateinit var empty: TextView
    private lateinit var totSpeed: TextView
    private lateinit var totSub: TextView
    private val listener: () -> Unit = { refresh() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_downloads)
        empty = findViewById(R.id.empty)
        totSpeed = findViewById(R.id.totSpeed)
        totSub = findViewById(R.id.totSub)
        findViewById<View>(R.id.back).setOnClickListener { finish() }
        findViewById<View>(R.id.add).setOnClickListener { addUrl() }
        findViewById<View>(R.id.more).setOnClickListener { v ->
            PopupMenu(this, v).apply {
                menu.add(R.string.pause_all).setOnMenuItemClickListener { Downloads.pauseAll(); true }
                menu.add(R.string.start_all).setOnMenuItemClickListener { Downloads.startAll(); true }
                menu.add(R.string.clear_completed).setOnMenuItemClickListener { Downloads.clearCompleted(); true }
            }.show()
        }
        findViewById<EditText>(R.id.search).addTextChangedListener(object : TextWatcher {
            override fun afterTextChanged(s: Editable?) { query = s.toString().trim().lowercase(); refresh() }
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })
        val chips = findViewById<ChipGroup>(R.id.filters)
        Filter.values().forEach { f ->
            chips.addView(Chip(this).apply {
                text = f.label; isCheckable = true; isChecked = f == filter; id = View.generateViewId()
                setOnClickListener { filter = f; refresh() }
            })
        }
        adapter = Adapter()
        findViewById<RecyclerView>(R.id.list).apply {
            layoutManager = LinearLayoutManager(this@DownloadsActivity)
            adapter = this@DownloadsActivity.adapter
            itemAnimator = null
        }
        intent.getStringExtra("url")?.let { addUrl(it) }
    }

    override fun onStart() { super.onStart(); Downloads.addListener(listener); refresh() }
    override fun onStop() { Downloads.removeListener(listener); super.onStop() }

    private fun refresh() {
        val next = Downloads.items.filter { filter.test(it) && (query.isEmpty() || it.fileName.lowercase().contains(query) || it.url.lowercase().contains(query)) }
        val sameRows = next.map { it.id } == shown.map { it.id }
        shown = next
        if (sameRows) adapter.notifyItemRangeChanged(0, shown.size, "tick") else adapter.notifyDataSetChanged()
        empty.visibility = if (shown.isEmpty()) View.VISIBLE else View.GONE
        val act = Downloads.items.filter { it.isActive }
        val speed = act.sumOf { it.speed }
        totSpeed.text = Format.speed(speed)
        val left = act.filter { it.size > 0 }.sumOf { it.size - it.received }
        totSub.text = if (act.isEmpty()) "idle" else "${act.size} active" + (if (speed > 1 && left > 0) " · " + Format.eta((left / speed).toLong()) else "")
    }

    private fun addUrl(prefill: String = "") {
        val input = EditText(this).apply { hint = "https://…"; setText(prefill); setSingleLine() }
        MaterialAlertDialogBuilder(this).setTitle(R.string.add_url).setView(input.also { it.setPadding(48, 24, 48, 24) })
            .setPositiveButton("Download") { _, _ ->
                try { Downloads.add(input.text.toString().trim(), userAgent = WebSettings.getDefaultUserAgent(this)) }
                catch (e: Exception) { Toast.makeText(this, e.message, Toast.LENGTH_LONG).show() }
            }.setNegativeButton(R.string.cancel, null).show()
    }

    private fun iconFor(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "mp4", "mkv", "webm", "avi", "mov", "m4v", "ts" -> "🎬"
        "mp3", "m4a", "flac", "wav", "ogg", "opus", "aac" -> "🎵"
        "zip", "rar", "7z", "tar", "gz", "xz", "bz2" -> "🗜️"
        "apk", "exe", "msi", "dmg", "deb" -> "💿"
        "pdf", "doc", "docx", "txt", "epub", "xls", "xlsx", "ppt", "pptx", "odt" -> "📄"
        "jpg", "jpeg", "png", "gif", "webp", "svg", "heic" -> "🖼️"
        else -> "📦"
    }

    private fun meta(it: DownloadItem): CharSequence {
        val size = if (it.size > 0) Format.bytes(it.size) else "unknown size"
        return when (it.status) {
            Status.COMPLETED -> "✓ ${Format.bytes(it.size)} · ${DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(it.completedAt))}"
            Status.FAILED -> "⚠ ${it.error ?: "Failed"} · ${Format.bytes(it.received)} of $size"
            Status.PAUSED -> "${(it.progress * 100).toInt()}% · ${Format.bytes(it.received)} of $size · Paused"
            Status.QUEUED -> "Queued"
            Status.CONNECTING -> "Connecting…"
            Status.DOWNLOADING -> listOfNotNull(
                if (it.size > 0) "${(it.progress * 100).toInt()}%" else null,
                "${Format.bytes(it.received)} of $size",
                "↓ ${Format.speed(it.speed)}",
                Format.eta(it.eta).ifEmpty { null },
                "${it.liveConnections} connections",
            ).joinToString(" · ")
        }
    }

    private inner class VH(v: View) : RecyclerView.ViewHolder(v) {
        val icon: TextView = v.findViewById(R.id.icon)
        val name: TextView = v.findViewById(R.id.name)
        val meta: TextView = v.findViewById(R.id.meta)
        val primary: ImageButton = v.findViewById(R.id.primary)
        val remove: ImageButton = v.findViewById(R.id.remove)
        val bar: SegmentBar = v.findViewById(R.id.bar)
    }

    private inner class Adapter : RecyclerView.Adapter<VH>() {
        override fun getItemCount() = shown.size
        override fun onCreateViewHolder(p: ViewGroup, t: Int) = VH(LayoutInflater.from(p.context).inflate(R.layout.item_download, p, false))
        override fun onBindViewHolder(h: VH, pos: Int) {
            val d = shown[pos]
            h.icon.text = iconFor(d.fileName)
            h.name.text = d.fileName
            h.meta.text = meta(d)
            h.meta.setTextColor(ContextCompat.getColor(this@DownloadsActivity, when (d.status) { Status.FAILED -> R.color.danger; Status.COMPLETED -> R.color.ok; else -> R.color.muted }))
            h.bar.set(d)
            h.bar.visibility = if (d.status == Status.COMPLETED) View.GONE else View.VISIBLE
            val (icon, label, action) = when (d.status) {
                Status.DOWNLOADING, Status.CONNECTING, Status.QUEUED -> Triple(R.drawable.ic_pause, R.string.pause) { Downloads.pause(d.id) }
                Status.PAUSED -> Triple(R.drawable.ic_play, R.string.resume) { Downloads.resume(d.id) }
                Status.FAILED -> Triple(R.drawable.ic_retry, R.string.retry) { Downloads.resume(d.id) }
                Status.COMPLETED -> Triple(R.drawable.ic_open, R.string.open) { open(d) }
            }
            h.primary.setImageResource(icon)
            h.primary.contentDescription = getString(label)
            h.primary.setOnClickListener { action() }
            h.remove.setOnClickListener { confirmRemove(d) }
            h.itemView.setOnClickListener { if (d.status == Status.COMPLETED) open(d) }
        }
    }

    private fun open(it: DownloadItem) {
        val i = Downloads.openIntent(it) ?: return Toast.makeText(this, "The file is gone", Toast.LENGTH_SHORT).show()
        try { startActivity(i) } catch (e: Exception) { Toast.makeText(this, "No app can open this file", Toast.LENGTH_SHORT).show() }
    }

    private fun confirmRemove(it: DownloadItem) {
        if (it.status != Status.COMPLETED) { Downloads.remove(it.id, true); return }
        MaterialAlertDialogBuilder(this).setTitle(it.fileName)
            .setItems(arrayOf("Remove from list", "Delete file")) { _, w -> Downloads.remove(it.id, w == 1) }
            .show()
    }
}
