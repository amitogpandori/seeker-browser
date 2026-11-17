package com.seeker.browser

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.seeker.browser.downloads.Downloads

class SeekerApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)
        SettingsActivity.applyTheme()
        Store.init(this)
        Shield.init(this)
        PageMemory.init(this)
        Downloads.init(this)
        if (Prefs.route != "direct") Route.apply(this)   // fail closed from the very first request
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CH_PROGRESS, getString(R.string.channel_downloads), NotificationManager.IMPORTANCE_LOW))
            nm.createNotificationChannel(NotificationChannel(CH_DONE, getString(R.string.channel_done), NotificationManager.IMPORTANCE_DEFAULT))
        }
    }

    companion object {
        const val CH_PROGRESS = "downloads"
        const val CH_DONE = "downloads_done"
    }
}
