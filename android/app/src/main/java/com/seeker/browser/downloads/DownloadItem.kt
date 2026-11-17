package com.seeker.browser.downloads

import org.json.JSONArray
import org.json.JSONObject

enum class Status { QUEUED, CONNECTING, DOWNLOADING, PAUSED, COMPLETED, FAILED }

/** One HTTP range handled by one connection. [end] is inclusive; [pos] is the next byte to write. */
class Segment(var start: Long, @Volatile var end: Long, @Volatile var pos: Long) {
    @Volatile var active = false
    @Volatile var speed = 0.0
    var windowBytes = 0L
    val remaining get() = end - pos + 1
    fun toJson(): JSONObject = JSONObject().put("s", start).put("e", end).put("p", pos)
    companion object { fun from(o: JSONObject) = Segment(o.getLong("s"), o.getLong("e"), o.getLong("p")) }
}

class DownloadItem(
    val id: String,
    @Volatile var url: String,
    @Volatile var fileName: String,
    var mime: String,
    @Volatile var size: Long,
    var connections: Int,
    val userAgent: String,
    val cookies: String?,
    val referrer: String?,
    val incognito: Boolean,
    val createdAt: Long = System.currentTimeMillis(),
) {
    @Volatile var status = Status.QUEUED
    @Volatile var received = 0L
    @Volatile var resumable = false
    @Volatile var error: String? = null
    @Volatile var completedAt = 0L
    @Volatile var speed = 0.0
    @Volatile var eta = -1L
    @Volatile var filePath = ""
    @Volatile var contentUri: String? = null
    /** "http" or "hls" (a video stream saved as .ts) */
    @Volatile var kind = "http"
    @Volatile var hlsDone = 0
    @Volatile var hlsTotal = 0
    /** per-file speed limit in KB/s, 0 = none (there is also a global one in Settings) */
    @Volatile var limitKB = 0L
    @Volatile var sha256: String? = null
    @Volatile var windowBytes = 0L
    /** was running when the app was killed (auto-resume candidates); not persisted */
    @Volatile var interrupted = false
    val throttle = Throttle { limitKB * 1024 }
    val category get() = Extras.categoryOf(fileName)
    val segments = mutableListOf<Segment>()

    val progress: Float get() = if (kind == "hls") (if (hlsTotal > 0) hlsDone.toFloat() / hlsTotal else 0f) else if (size > 0) (received.toFloat() / size).coerceIn(0f, 1f) else 0f
    val isActive get() = status == Status.CONNECTING || status == Status.DOWNLOADING
    val liveConnections get() = synchronized(segments) { segments.count { it.active } }

    fun segmentsCopy(): List<Segment> = synchronized(segments) { segments.map { s -> Segment(s.start, s.end, s.pos).also { it.active = s.active; it.speed = s.speed } } }

    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("url", url).put("name", fileName).put("mime", mime).put("size", size)
        .put("conn", connections).put("ua", userAgent).put("cookies", cookies ?: "").put("ref", referrer ?: "")
        .put("created", createdAt).put("status", status.name).put("received", received).put("resumable", resumable)
        .put("error", error ?: "").put("completed", completedAt).put("path", filePath).put("uri", contentUri ?: "")
        .put("kind", kind).put("hlsDone", hlsDone).put("hlsTotal", hlsTotal).put("limit", limitKB).put("sha", sha256 ?: "")
        .put("segs", JSONArray().also { a -> synchronized(segments) { segments.forEach { a.put(it.toJson()) } } })

    companion object {
        fun from(o: JSONObject): DownloadItem = DownloadItem(
            o.getString("id"), o.getString("url"), o.getString("name"), o.optString("mime"), o.optLong("size"),
            o.optInt("conn", 8), o.optString("ua"), o.optString("cookies").ifEmpty { null }, o.optString("ref").ifEmpty { null }, false,
            o.optLong("created"),
        ).apply {
            status = try { Status.valueOf(o.optString("status")) } catch (e: Exception) { Status.PAUSED }
            received = o.optLong("received"); resumable = o.optBoolean("resumable")
            error = o.optString("error").ifEmpty { null }; completedAt = o.optLong("completed")
            filePath = o.optString("path"); contentUri = o.optString("uri").ifEmpty { null }
            kind = o.optString("kind", "http"); hlsDone = o.optInt("hlsDone"); hlsTotal = o.optInt("hlsTotal")
            limitKB = o.optLong("limit"); sha256 = o.optString("sha").ifEmpty { null }
            o.optJSONArray("segs")?.let { a -> for (i in 0 until a.length()) segments.add(Segment.from(a.getJSONObject(i))) }
        }
    }
}
