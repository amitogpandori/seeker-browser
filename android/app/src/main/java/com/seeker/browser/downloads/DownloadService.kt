package com.seeker.browser.downloads

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import com.seeker.browser.Format
import com.seeker.browser.R
import com.seeker.browser.SeekerApp

/** Keeps downloads running in the background with a progress notification per download. */
class DownloadService : Service() {
    private val listener: () -> Unit = { refresh() }
    private val shown = HashSet<String>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ServiceCompat.startForeground(this, SUMMARY_ID, summary(),
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0)
        Downloads.addListener(listener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getStringExtra(EXTRA_ID)
        when (intent?.action) {
            ACTION_PAUSE -> id?.let { Downloads.pause(it) }
            ACTION_RESUME -> id?.let { Downloads.resume(it) }
            ACTION_CANCEL -> id?.let { Downloads.remove(it, true); NotificationManagerCompat.from(this).cancel(it.hashCode()) }
        }
        refresh()
        return START_NOT_STICKY
    }

    override fun onDestroy() { Downloads.removeListener(listener); super.onDestroy() }

    private fun refresh() {
        val nm = NotificationManagerCompat.from(this)
        val active = Downloads.items.filter { it.isActive || it.status == Status.QUEUED }
        try {
            nm.notify(SUMMARY_ID, summary())
            for (it in active) { nm.notify(it.id.hashCode(), progress(it)); shown.add(it.id) }
            // paused ones keep a notification with a Resume button
            for (it in Downloads.items.filter { it.status == Status.PAUSED && it.id in shown }) nm.notify(it.id.hashCode(), progress(it))
        } catch (e: SecurityException) { /* notifications not allowed */ }
        if (Downloads.items.none { it.isActive || it.status == Status.QUEUED }) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(this, 0,
        Intent(this, DownloadsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE)

    private fun action(act: String, id: String): PendingIntent {
        val i = Intent(this, DownloadService::class.java).setAction(act).putExtra(EXTRA_ID, id)
        val f = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        return if (Build.VERSION.SDK_INT >= 26) PendingIntent.getForegroundService(this, (act + id).hashCode(), i, f)
        else PendingIntent.getService(this, (act + id).hashCode(), i, f)
    }

    private fun summary(): Notification {
        val act = Downloads.items.filter { it.isActive }
        val speed = act.sumOf { it.speed }
        return NotificationCompat.Builder(this, SeekerApp.CH_PROGRESS)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(if (act.isEmpty()) "Seeker downloads" else "${act.size} downloading · ${Format.speed(speed)}")
            .setContentIntent(openApp())
            .setGroup(GROUP).setGroupSummary(true)
            .setOngoing(true).setSilent(true).setOnlyAlertOnce(true)
            .build()
    }

    private fun progress(it: DownloadItem): Notification {
        val b = NotificationCompat.Builder(this, SeekerApp.CH_PROGRESS)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(it.fileName)
            .setContentIntent(openApp())
            .setGroup(GROUP).setSilent(true).setOnlyAlertOnce(true)
            .setOngoing(it.isActive)
        val pct = (it.progress * 100).toInt()
        when (it.status) {
            Status.PAUSED -> {
                b.setContentText("Paused · ${Format.bytes(it.received)}${if (it.size > 0) " of " + Format.bytes(it.size) else ""}")
                b.setProgress(100, pct, false)
                b.addAction(R.drawable.ic_play, getString(R.string.resume), action(ACTION_RESUME, it.id))
            }
            Status.QUEUED, Status.CONNECTING -> { b.setContentText(if (it.status == Status.QUEUED) "Queued" else "Connecting…"); b.setProgress(0, 0, true) }
            else -> {
                b.setContentText(listOfNotNull(
                    if (it.size > 0) "$pct%" else null,
                    Format.speed(it.speed),
                    Format.eta(it.eta).ifEmpty { null },
                    "${it.liveConnections} conn",
                ).joinToString(" · "))
                b.setProgress(100, pct, it.size <= 0)
                b.addAction(R.drawable.ic_pause, getString(R.string.pause), action(ACTION_PAUSE, it.id))
            }
        }
        b.addAction(R.drawable.ic_close, getString(R.string.cancel), action(ACTION_CANCEL, it.id))
        return b.build()
    }

    companion object {
        const val ACTION_PAUSE = "pause"
        const val ACTION_RESUME = "resume"
        const val ACTION_CANCEL = "cancel"
        const val EXTRA_ID = "id"
        private const val SUMMARY_ID = 1
        private const val GROUP = "seeker.downloads"

        fun notifyDone(ctx: Context, item: DownloadItem) {
            val open = Downloads.openIntent(item)
            val pi = if (open != null) PendingIntent.getActivity(ctx, item.id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE) else null
            val n = NotificationCompat.Builder(ctx, SeekerApp.CH_DONE)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle(item.fileName)
                .setContentText("Download complete · ${Format.bytes(item.size)}")
                .setContentIntent(pi).setAutoCancel(true)
                .build()
            try { NotificationManagerCompat.from(ctx).notify(item.id.hashCode(), n) } catch (e: SecurityException) { /* not allowed */ }
        }

        fun notifyFailed(ctx: Context, item: DownloadItem) {
            val n = NotificationCompat.Builder(ctx, SeekerApp.CH_DONE)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle("Download failed: ${item.fileName}")
                .setContentText(item.error ?: "Error")
                .setContentIntent(PendingIntent.getActivity(ctx, 0, Intent(ctx, DownloadsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE))
                .setAutoCancel(true)
                .build()
            try { NotificationManagerCompat.from(ctx).notify(item.id.hashCode(), n) } catch (e: SecurityException) { /* not allowed */ }
        }
    }
}
