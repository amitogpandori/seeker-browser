package com.seeker.browser.downloads

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat
import com.seeker.browser.R

/** Progress bar that draws each connection's range, like the desktop download manager. */
class SegmentBar @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : View(ctx, attrs) {
    private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ContextCompat.getColor(ctx, R.color.seg_track) }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ContextCompat.getColor(ctx, R.color.accent) }
    private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ContextCompat.getColor(ctx, R.color.ok) }
    private var segs: List<Segment> = emptyList()
    private var size = 0L
    private var progress = 0f
    private val r = RectF()

    fun set(item: DownloadItem) {
        size = item.size
        progress = item.progress
        segs = if (item.status == Status.COMPLETED) emptyList() else item.segmentsCopy()
        fill.color = ContextCompat.getColor(context, when (item.status) {
            Status.FAILED -> R.color.danger
            Status.PAUSED -> R.color.muted
            Status.COMPLETED -> R.color.ok
            else -> R.color.accent
        })
        if (item.status == Status.COMPLETED) progress = 1f
        invalidate()
    }

    override fun onDraw(c: Canvas) {
        val w = width.toFloat(); val h = height.toFloat(); val rad = h / 2
        r.set(0f, 0f, w, h); c.drawRoundRect(r, rad, rad, track)
        if (size > 0 && segs.isNotEmpty() && segs.all { it.end != Long.MAX_VALUE }) {
            for (s in segs) {
                val x0 = s.start * w / size
                val x1 = (minOf(s.pos, s.end + 1)) * w / size
                if (x1 > x0) { r.set(x0, 0f, x1, h); c.drawRect(r, fill) }
                if (s.active && s.pos <= s.end) { r.set(x1 - 2f, 0f, x1 + 1f, h); c.drawRect(r, edge) } // live edge
            }
        } else if (progress > 0) { r.set(0f, 0f, w * progress, h); c.drawRoundRect(r, rad, rad, fill) }
    }
}
