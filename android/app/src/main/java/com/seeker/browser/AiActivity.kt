package com.seeker.browser

import android.content.ClipData
import android.content.ClipboardManager
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import java.util.concurrent.Executors

/**
 * AI assistant (desktop: the AI side panel, src/main/ai.js). Free and paid providers, your own
 * keys (encrypted on the phone), streaming answers, and page actions: summarise, explain, translate.
 */
class AiActivity : AppCompatActivity() {
    companion object {
        const val EXTRA_PROMPT = "prompt"
        const val EXTRA_PAGE_TITLE = "pageTitle"
        const val EXTRA_PAGE_URL = "pageUrl"
        const val EXTRA_PAGE_TEXT = "pageText"
        const val EXTRA_SETTINGS = "settings"
    }

    private val pool = Executors.newSingleThreadExecutor()
    private val history = mutableListOf<Pair<String, String>>()
    @Volatile private var cancel = false
    private var busy = false
    private lateinit var msgs: LinearLayout
    private lateinit var scroll: ScrollView
    private lateinit var input: EditText
    private lateinit var send: MaterialButton
    private lateinit var sub: TextView
    private lateinit var panel: LinearLayout
    private var pageTitle = ""; private var pageUrl = ""; private var pageText = ""

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun color(id: Int) = ContextCompat.getColor(this, id)
    private fun text(s: String, size: Float = 15f, c: Int = R.color.text) = TextView(this).apply { text = s; textSize = size; setTextColor(color(c)) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pageTitle = intent.getStringExtra(EXTRA_PAGE_TITLE) ?: ""
        pageUrl = intent.getStringExtra(EXTRA_PAGE_URL) ?: ""
        pageText = intent.getStringExtra(EXTRA_PAGE_TEXT) ?: ""

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(color(R.color.bg)) }
        // top bar
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setBackgroundColor(color(R.color.chrome)); minimumHeight = dp(56) }
        bar.addView(ImageButton(this).apply { setImageResource(R.drawable.ic_back); contentDescription = getString(R.string.back); background = null; setOnClickListener { finish() } }, LinearLayout.LayoutParams(dp(48), dp(48)))
        val titles = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        titles.addView(text(getString(R.string.ai_assistant), 18f).apply { setTypeface(typeface, android.graphics.Typeface.BOLD) })
        sub = text("", 12f, R.color.muted); titles.addView(sub)
        bar.addView(titles, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(MaterialButton(this, null, androidx.appcompat.R.attr.borderlessButtonStyle).apply { text = "⚙ Model"; setOnClickListener { togglePanel() } })
        root.addView(bar)

        panel = buildPanel(); panel.visibility = View.GONE
        root.addView(panel)

        if (pageText.isNotBlank()) {
            val chips = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(dp(8), dp(6), dp(8), 0) }
            listOf(
                "Summarise" to "Summarise this page in 5 short bullet points, then one line on why it matters.",
                "Key points" to "List the key facts and numbers from this page.",
                "Explain simply" to "Explain this page simply, as if to a 12-year-old.",
                "Translate" to "Translate the main content of this page into English (or into Hindi if it is already English).",
            ).forEach { (label, q) ->
                chips.addView(MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply { text = label; setOnClickListener { ask(q) } },
                    LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(6) })
            }
            root.addView(HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(chips) })
        }

        msgs = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), dp(8), dp(12), dp(8)) }
        scroll = ScrollView(this).apply { addView(msgs) }
        root.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        bubble("assistant", if (pageText.isNotBlank()) "Ask anything about “${pageTitle.ifBlank { pageUrl }}”, or tap an action above." else "Hi! Ask me anything. Pick a free model with ⚙ Model if you haven't yet.")

        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(8), dp(6), dp(8), dp(8)); setBackgroundColor(color(R.color.panel)) }
        input = EditText(this).apply {
            hint = "Message the AI…"; maxLines = 5; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            imeOptions = EditorInfo.IME_ACTION_SEND
        }
        row.addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        send = MaterialButton(this).apply { text = "Send"; setOnClickListener { if (busy) cancel = true else ask(input.text.toString()) } }
        row.addView(send)
        root.addView(row)
        setContentView(root)
        EdgeToEdge.apply(this, root)

        updateSub()
        intent.getStringExtra(EXTRA_PROMPT)?.takeIf { it.isNotBlank() }?.let { ask(it) }
        if (intent.getBooleanExtra(EXTRA_SETTINGS, false) || Prefs.aiModel.isBlank()) togglePanel(true)
    }

    private fun updateSub() {
        val p = Ai.provider(Prefs.aiProvider)
        sub.text = p.name.substringBefore(" —") + " · " + Prefs.aiModel.ifBlank { "no model picked" } + if (Route.isTor) " · Tor: local AI only" else ""
    }

    private fun togglePanel(show: Boolean = panel.visibility != View.VISIBLE) { panel.visibility = if (show) View.VISIBLE else View.GONE }

    private fun buildPanel(): LinearLayout {
        val p = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(10), dp(16), dp(10)); setBackgroundColor(color(R.color.panel)) }
        p.addView(text("Provider", 13f, R.color.muted))
        val spin = Spinner(this)
        spin.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, Ai.PROVIDERS.map { it.name })
        spin.setSelection(Ai.PROVIDERS.indexOfFirst { it.id == Prefs.aiProvider }.coerceAtLeast(0))
        p.addView(spin)
        val help = text("", 12f, R.color.muted); p.addView(help)
        val base = EditText(this).apply { hint = "Base URL"; setSingleLine(); inputType = InputType.TYPE_TEXT_VARIATION_URI }
        p.addView(base)
        val key = EditText(this).apply { setSingleLine(); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        p.addView(key)
        val btns = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val save = MaterialButton(this).apply { text = "Save" }
        val models = MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply { text = "Pick model…" }
        btns.addView(save); btns.addView(models, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8) })
        p.addView(btns)
        val model = text("", 13f); p.addView(model)

        fun load() {
            val pr = Ai.PROVIDERS[spin.selectedItemPosition]
            help.text = pr.help
            base.setText(Prefs.aiBase(pr.id).ifBlank { pr.base })
            base.visibility = if (pr.id in setOf("ollama", "lmstudio", "custom")) View.VISIBLE else View.GONE
            key.visibility = if (pr.key == "no") View.GONE else View.VISIBLE
            key.setText("")
            key.hint = if (SecureKeys.has(pr.id)) "API key saved ✓ (type to replace, or clear)" else "API key"
            model.text = "Model: " + (Prefs.p.getString("ai_model_${pr.id}", "") ?: "").ifBlank { "none picked" }
        }
        spin.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(a: AdapterView<*>?, v: View?, pos: Int, id: Long) { Prefs.aiProvider = Ai.PROVIDERS[pos].id; load(); updateSub() }
            override fun onNothingSelected(a: AdapterView<*>?) {}
        }
        fun persist() {
            val pr = Ai.PROVIDERS[spin.selectedItemPosition]
            if (base.visibility == View.VISIBLE) Prefs.p.edit().putString("ai_base_${pr.id}", base.text.toString().trim()).apply()
            if (key.text.isNotEmpty()) SecureKeys.set(pr.id, key.text.toString())
        }
        save.setOnClickListener {
            persist(); load(); updateSub()
            Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
        }
        save.setOnLongClickListener { SecureKeys.set(Ai.PROVIDERS[spin.selectedItemPosition].id, ""); load(); Toast.makeText(this, "Key removed", Toast.LENGTH_SHORT).show(); true }
        models.setOnClickListener {
            persist()
            val pid = Ai.PROVIDERS[spin.selectedItemPosition].id
            models.isEnabled = false; models.text = "Loading…"
            pool.execute {
                val r = try { Result.success(Ai.listModels(pid)) } catch (e: Exception) { Result.failure(e) }
                runOnUiThread {
                    models.isEnabled = true; models.text = "Pick model…"
                    r.onFailure { MaterialAlertDialogBuilder(this).setTitle("Couldn't load models").setMessage(it.message).setPositiveButton("OK", null).show() }
                    r.onSuccess { list ->
                        if (list.isEmpty()) { Toast.makeText(this, "No models found", Toast.LENGTH_SHORT).show(); return@onSuccess }
                        MaterialAlertDialogBuilder(this).setTitle("Pick a model" + if (pid == "openrouter") " (FREE ones first)" else "")
                            .setItems(list.map { it.label }.toTypedArray()) { _, w -> Prefs.aiModel = list[w].id; load(); updateSub(); togglePanel(false) }.show()
                    }
                }
            }
        }
        load()
        return p
    }

    private fun bubble(role: String, s: String): TextView {
        val tv = text(s).apply {
            setTextIsSelectable(true)
            setPadding(dp(12), dp(8), dp(12), dp(8))
            background = ContextCompat.getDrawable(this@AiActivity, R.drawable.bg_card)
            if (role == "user") backgroundTintList = android.content.res.ColorStateList.valueOf(color(R.color.accent_soft))
            setOnLongClickListener {
                (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("ai", text))
                Toast.makeText(this@AiActivity, "Copied", Toast.LENGTH_SHORT).show(); true
            }
        }
        msgs.addView(tv, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(6); gravity = if (role == "user") Gravity.END else Gravity.START
            if (role == "user") marginStart = dp(40) else marginEnd = dp(24)
        })
        scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
        return tv
    }

    private fun ask(q: String) {
        val question = q.trim()
        if (question.isEmpty() || busy) return
        input.setText("")
        bubble("user", question)
        history += "user" to question
        val out = bubble("assistant", "…")
        busy = true; cancel = false; send.text = "Stop"
        val system = buildString {
            append("You are the assistant built into the Seeker web browser on Android. Be concise and accurate; use short paragraphs and bullet points.")
            if (pageText.isNotBlank()) append("\n\nThe user is reading this page:\nTitle: $pageTitle\nURL: $pageUrl\n---\n${pageText.take(12000)}\n---\nAnswer about this page when the question refers to it.")
        }
        val provider = Prefs.aiProvider; val model = Prefs.aiModel
        val msgsCopy = history.toList()
        pool.execute {
            var last = 0L
            val r = try {
                Result.success(Ai.chat(provider, model, system, msgsCopy, { cancel }) { full ->
                    val now = System.currentTimeMillis()
                    if (now - last > 60) { last = now; runOnUiThread { out.text = full; scroll.post { scroll.fullScroll(View.FOCUS_DOWN) } } }
                })
            } catch (e: Exception) { Result.failure(e) }
            runOnUiThread {
                busy = false; send.text = "Send"
                r.onSuccess { out.text = it.ifBlank { if (cancel) "(stopped)" else "(empty answer)" }; history += "assistant" to it }
                r.onFailure { out.text = "⚠ ${it.message ?: "Error"}"; out.setTextColor(color(R.color.danger)); history.removeAt(history.size - 1) }
            }
        }
    }

    override fun onDestroy() { cancel = true; pool.shutdown(); super.onDestroy() }
}
