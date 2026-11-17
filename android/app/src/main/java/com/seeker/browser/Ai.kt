package com.seeker.browser

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

/** The desktop AI assistant's providers (src/main/ai.js): free and paid, OpenAI-compatible + Anthropic. */
object Ai {
    data class Provider(val id: String, val name: String, val base: String, val key: String, val help: String)

    val PROVIDERS = listOf(
        Provider("openrouter", "OpenRouter — many free & paid models", "https://openrouter.ai/api/v1", "yes", "Models ending in \":free\" cost nothing. Key: openrouter.ai/keys"),
        Provider("groq", "Groq — fast, free tier", "https://api.groq.com/openai/v1", "yes", "Key: console.groq.com/keys"),
        Provider("gemini", "Google Gemini — free tier", "https://generativelanguage.googleapis.com/v1beta/openai", "yes", "Key: aistudio.google.com/apikey"),
        Provider("openai", "OpenAI (ChatGPT) — paid", "https://api.openai.com/v1", "yes", "Key: platform.openai.com/api-keys"),
        Provider("anthropic", "Anthropic Claude — paid", "https://api.anthropic.com/v1", "yes", "Key: console.anthropic.com"),
        Provider("ollama", "Ollama — free, on your PC (LAN)", "http://192.168.1.2:11434/v1", "no", "Run Ollama on your PC with OLLAMA_HOST=0.0.0.0 and enter http://<PC-IP>:11434/v1."),
        Provider("lmstudio", "LM Studio — free, on your PC (LAN)", "http://192.168.1.2:1234/v1", "no", "Enable \"Serve on local network\" in LM Studio and enter http://<PC-IP>:1234/v1."),
        Provider("custom", "Custom (any OpenAI-compatible server)", "", "optional", "Enter the base URL ending in /v1."),
    )
    fun provider(id: String) = PROVIDERS.firstOrNull { it.id == id } ?: PROVIDERS.first()
    fun base(id: String) = (Prefs.aiBase(id).ifBlank { provider(id).base }).trimEnd('/')

    private fun endpoint(id: String): Triple<Provider, String, String?> {
        val p = provider(id)
        val base = base(id)
        if (base.isBlank()) throw IOException("Set a base URL for this provider in Settings → AI.")
        val key = SecureKeys.get(id)
        if (p.key == "yes" && key.isNullOrBlank()) throw IOException("Add your ${p.name.substringBefore(" —")} API key in Settings → AI.")
        // In Tor mode only local (LAN/loopback) AI is allowed, so the chat can't de-anonymise you
        if (Route.isTor && !isLocal(base)) throw IOException("In Tor mode only local AI (Ollama / LM Studio on your network) is allowed.")
        return Triple(p, base, key)
    }

    fun isLocal(url: String): Boolean {
        val h = Privacy.hostOf(url).lowercase()
        return h == "localhost" || h.startsWith("127.") || h == "::1" || h.startsWith("10.") || h.startsWith("192.168.") ||
            Regex("^172\\.(1[6-9]|2\\d|3[01])\\.").containsMatchIn(h) || h.endsWith(".local")
    }

    private fun headers(id: String, key: String?): Map<String, String> {
        if (id == "anthropic") return mapOf("content-type" to "application/json", "x-api-key" to (key ?: ""), "anthropic-version" to "2023-06-01")
        val h = mutableMapOf("content-type" to "application/json")
        if (!key.isNullOrBlank()) h["authorization"] = "Bearer $key"
        if (id == "openrouter") { h["HTTP-Referer"] = "https://github.com/seeker-browser"; h["X-Title"] = "Seeker Browser" }
        return h
    }

    private fun conn(url: String, id: String, key: String?, local: Boolean) =
        (if (local) java.net.URL(url).openConnection(java.net.Proxy.NO_PROXY) as java.net.HttpURLConnection else Route.open(url)).apply {
            connectTimeout = 15000; readTimeout = 120000
            headers(id, key).forEach { (k, v) -> setRequestProperty(k, v) }
        }

    private fun errorText(code: Int, body: String): String {
        if (code == 401 || code == 403) return "The API key was rejected ($code). Check it in Settings → AI."
        if (code == 429) return "Rate limit or quota reached. Wait a bit, or pick another model/provider."
        val msg = try { JSONObject(body).let { j -> j.optJSONObject("error")?.optString("message") ?: j.optString("error").ifBlank { j.optString("message") } } } catch (e: Exception) { body }
        return "AI server error $code: ${msg.take(300)}"
    }

    data class Model(val id: String, val label: String, val free: Boolean)

    fun listModels(id: String): List<Model> {
        val (_, base, key) = endpoint(id)
        val local = isLocal(base)
        if (id == "ollama") {
            val c = conn(base.removeSuffix("/v1") + "/api/tags", id, key, local)
            val j = JSONObject(c.inputStream.bufferedReader().readText())
            val a = j.optJSONArray("models") ?: JSONArray()
            return (0 until a.length()).map { a.getJSONObject(it).let { m -> Model(m.getString("name"), m.getString("name"), true) } }
        }
        val c = conn("$base/models", id, key, local)
        val code = c.responseCode
        val body = (if (code >= 400) c.errorStream else c.inputStream)?.bufferedReader()?.readText() ?: ""
        if (code >= 400) throw IOException(errorText(code, body))
        val j = JSONObject(body)
        val a = j.optJSONArray("data") ?: j.optJSONArray("models") ?: JSONArray()
        return (0 until a.length()).mapNotNull { i ->
            val m = a.getJSONObject(i)
            val mid = (m.optString("id").ifBlank { m.optString("name") }).removePrefix("models/")
            if (mid.isBlank() || Regex("embed|whisper|tts|dall-e|moderation|image|audio|transcribe|realtime", RegexOption.IGNORE_CASE).containsMatchIn(mid)) return@mapNotNull null
            val pr = m.optJSONObject("pricing")
            val free = id == "openrouter" && (mid.endsWith(":free") || (pr != null && pr.optString("prompt") == "0" && pr.optString("completion") == "0"))
            Model(mid, (m.optString("display_name").ifBlank { m.optString("name").ifBlank { mid } }) + if (free) "  · FREE" else "", free)
        }.sortedWith(compareByDescending<Model> { it.free }.thenBy { it.id })
    }

    /** Streams a chat completion; onDelta gets the full text so far. Returns the final text. */
    fun chat(id: String, model: String, system: String?, messages: List<Pair<String, String>>, cancelled: () -> Boolean, onDelta: (String) -> Unit): String {
        val (_, base, key) = endpoint(id)
        if (model.isBlank()) throw IOException("Pick a model in Settings → AI (or tap ⚙ in the assistant).")
        val msgs = JSONArray()
        val body = JSONObject().put("model", model).put("stream", true)
        val url: String
        if (id == "anthropic") {
            url = "$base/messages"
            messages.forEach { msgs.put(JSONObject().put("role", it.first).put("content", it.second)) }
            body.put("max_tokens", 2048).put("messages", msgs)
            if (!system.isNullOrBlank()) body.put("system", system)
        } else {
            url = "$base/chat/completions"
            if (!system.isNullOrBlank()) msgs.put(JSONObject().put("role", "system").put("content", system))
            messages.forEach { msgs.put(JSONObject().put("role", it.first).put("content", it.second)) }
            body.put("messages", msgs)
        }
        val c = conn(url, id, key, isLocal(base))
        c.requestMethod = "POST"; c.doOutput = true
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        val code = c.responseCode
        if (code >= 400) throw IOException(errorText(code, c.errorStream?.bufferedReader()?.readText() ?: ""))
        val full = StringBuilder()
        c.inputStream.bufferedReader().use { r ->
            while (!cancelled()) {
                val line = r.readLine() ?: break
                if (!line.startsWith("data:")) continue
                val data = line.removePrefix("data:").trim()
                if (data == "[DONE]") break
                val piece = try {
                    val j = JSONObject(data)
                    if (id == "anthropic") j.optJSONObject("delta")?.optString("text") ?: ""
                    else j.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("delta")?.optString("content") ?: ""
                } catch (e: Exception) { "" }
                if (piece.isNotEmpty()) { full.append(piece); onDelta(full.toString()) }
            }
        }
        c.disconnect()
        return full.toString()
    }
}
