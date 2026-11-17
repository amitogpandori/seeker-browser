package com.seeker.browser.downloads

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import android.webkit.URLUtil
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

/** The download list, the scheduler (max 3 at once) and persistence. UI and service observe it. */
object Downloads {
    const val MAX_ACTIVE = 3
    const val DEFAULT_CONNECTIONS = 8

    private lateinit var app: Context
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val main = Handler(Looper.getMainLooper())
    private val jobs = java.util.concurrent.ConcurrentHashMap<String, Job>()
    private val engines = java.util.concurrent.ConcurrentHashMap<String, Engine>()
    private fun stop(id: String) { jobs.remove(id)?.cancel(); engines.remove(id)?.abort() }
    val items = CopyOnWriteArrayList<DownloadItem>()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private var lastSave = 0L

    fun init(ctx: Context) {
        app = ctx.applicationContext
        try {
            val f = File(app.filesDir, "downloads.json")
            if (f.exists()) {
                val a = JSONArray(f.readText())
                for (i in 0 until a.length()) items.add(DownloadItem.from(a.getJSONObject(i)).also { if (it.isActive || it.status == Status.QUEUED) it.status = Status.PAUSED })
            }
        } catch (e: Exception) { /* corrupt: start empty */ }
        main.post(object : Runnable { override fun run() { tick(); main.postDelayed(this, 1000) } })
    }

    fun addListener(l: () -> Unit) { listeners.add(l) }
    fun removeListener(l: () -> Unit) { listeners.remove(l) }
    private fun changed() { main.post { listeners.forEach { it() } } }
    fun get(id: String) = items.firstOrNull { it.id == id }
    fun activeCount() = items.count { it.isActive }

    fun downloadDir(): File = (app.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: File(app.filesDir, "Download")).also { it.mkdirs() }

    fun add(url: String, fileName: String? = null, mime: String? = null, userAgent: String, cookies: String? = null,
            referrer: String? = null, incognito: Boolean = false, contentDisposition: String? = null, connections: Int = DEFAULT_CONNECTIONS): DownloadItem {
        require(url.startsWith("http://", true) || url.startsWith("https://", true)) { "Only http(s) links can be downloaded" }
        val name = sanitize(fileName ?: URLUtil.guessFileName(url, contentDisposition, mime))
        val it = DownloadItem(UUID.randomUUID().toString(), url, uniqueName(name), mime ?: guessMime(name), -1, connections, userAgent, cookies, referrer, incognito)
        it.filePath = File(downloadDir(), it.fileName).absolutePath
        items.add(0, it)
        save(true); changed(); process()
        return it
    }

    fun pause(id: String) { val it = get(id) ?: return; stop(id); if (it.isActive || it.status == Status.QUEUED) it.status = Status.PAUSED; it.speed = 0.0; save(true); changed(); process() }
    fun resume(id: String) { val it = get(id) ?: return; if (it.status == Status.PAUSED || it.status == Status.FAILED) { it.status = Status.QUEUED; it.error = null; save(true); changed(); process() } }
    fun pauseAll() { items.filter { it.isActive || it.status == Status.QUEUED }.forEach { pause(it.id) } }
    fun startAll() { items.filter { it.status == Status.PAUSED || it.status == Status.FAILED }.forEach { resume(it.id) } }
    fun clearCompleted() { items.removeAll { it.status == Status.COMPLETED }; save(true); changed() }
    fun remove(id: String, deleteFile: Boolean) {
        val it = get(id) ?: return
        stop(id)
        items.remove(it)
        File(it.filePath + ".part").delete()
        if (deleteFile) {
            File(it.filePath).delete()
            it.contentUri?.let { u -> try { app.contentResolver.delete(Uri.parse(u), null, null) } catch (e: Exception) { /* gone */ } }
        }
        save(true); changed(); process()
    }
    /** Forget all incognito downloads (the files themselves stay). */
    fun forgetIncognito() { items.filter { it.incognito }.forEach { if (it.status == Status.COMPLETED) items.remove(it) else remove(it.id, true) }; changed() }

    @Synchronized fun process() {
        var running = items.count { it.isActive }
        for (it in items.reversed()) {
            if (running >= MAX_ACTIVE) break
            if (it.status == Status.QUEUED && !jobs.containsKey(it.id)) { start(it); running++ }
        }
        if (running > 0) ContextCompat.startForegroundService(app, Intent(app, DownloadService::class.java))
    }

    private fun start(item: DownloadItem) {
        item.status = Status.CONNECTING
        item.error = null
        val engine = Engine(item, File(item.filePath + ".part"))
        engines[item.id] = engine
        jobs[item.id] = scope.launch {
            try {
                engine.run()
                finish(item)
                item.status = Status.COMPLETED
                item.completedAt = System.currentTimeMillis()
                DownloadService.notifyDone(app, item)
            } catch (e: CancellationException) {
                // paused or removed
            } catch (e: Exception) {
                item.status = Status.FAILED
                item.error = e.message ?: e.javaClass.simpleName
                DownloadService.notifyFailed(app, item)
            } finally {
                item.speed = 0.0
                val me = coroutineContext[Job]
                if (jobs[item.id] == me) { jobs.remove(item.id); engines.remove(item.id) }
                save(true); changed(); process()
            }
        }
    }

    /** Rename the .part file and, on Android 10+, publish it to the public Downloads collection. */
    private fun finish(item: DownloadItem) {
        val part = File(item.filePath + ".part")
        val dest = File(item.filePath)
        if (!part.renameTo(dest)) { part.copyTo(dest, true); part.delete() }
        item.received = dest.length(); item.size = dest.length()
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                val cv = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, item.fileName)
                    put(MediaStore.Downloads.MIME_TYPE, item.mime.ifBlank { "application/octet-stream" })
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Seeker")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val r = app.contentResolver
                val uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv) ?: return
                r.openOutputStream(uri)?.use { out -> dest.inputStream().use { it.copyTo(out, 256 * 1024) } }
                r.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
                item.contentUri = uri.toString()
                dest.delete()
            } catch (e: Exception) { /* keep the app-private copy */ }
        }
    }

    /** Once a second: speeds (EMA), ETA, received bytes; persist every 5 s while active. */
    private fun tick() {
        var any = false
        for (it in items) {
            if (!it.isActive) continue
            any = true
            var rec = 0L; var inst = 0.0
            synchronized(it.segments) {
                for (s in it.segments) {
                    val endEx = if (s.end == Long.MAX_VALUE) s.pos else minOf(s.pos, s.end + 1)
                    rec += endEx - s.start
                    s.speed = if (s.active) s.speed * 0.6 + s.windowBytes * 0.4 else 0.0
                    inst += s.windowBytes
                    s.windowBytes = 0
                }
            }
            it.received = rec
            it.speed = if (it.speed == 0.0) inst else it.speed * 0.6 + inst * 0.4
            it.eta = if (it.size > 0 && it.speed > 1) ((it.size - rec) / it.speed).toLong() else -1
        }
        if (any) {
            if (System.currentTimeMillis() - lastSave > 5000) save(false)
            changed()
        }
    }

    @Synchronized fun save(force: Boolean) {
        if (!force && System.currentTimeMillis() - lastSave < 5000) return
        lastSave = System.currentTimeMillis()
        val a = JSONArray()
        items.filter { !it.incognito }.forEach { a.put(it.toJson()) }   // incognito downloads are never written to disk
        try {
            val f = File(app.filesDir, "downloads.json"); val tmp = File(app.filesDir, "downloads.json.tmp")
            tmp.writeText(a.toString()); tmp.renameTo(f)
        } catch (e: Exception) { /* disk full */ }
    }

    fun openIntent(item: DownloadItem): Intent? {
        val uri = item.contentUri?.let { Uri.parse(it) }
            ?: File(item.filePath).takeIf { it.exists() }?.let { androidx.core.content.FileProvider.getUriForFile(app, app.packageName + ".files", it) }
            ?: return null
        return Intent(Intent.ACTION_VIEW).setDataAndType(uri, item.mime.ifBlank { "*/*" }).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    private fun sanitize(n: String) = n.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]"), "_").trim().trimStart('.').ifBlank { "download" }.take(180)
    private fun guessMime(name: String) = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: ""
    private fun uniqueName(name: String): String {
        val taken = items.map { it.fileName }.toSet()
        val dir = downloadDir()
        if (name !in taken && !File(dir, name).exists()) return name
        val dot = name.lastIndexOf('.').takeIf { it > 0 } ?: name.length
        var i = 1
        while (true) { val c = "${name.substring(0, dot)} ($i)${name.substring(dot)}"; if (c !in taken && !File(dir, c).exists()) return c; i++ }
    }
}
