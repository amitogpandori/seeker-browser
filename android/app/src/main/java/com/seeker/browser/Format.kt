package com.seeker.browser

import java.util.Locale

object Format {
    fun bytes(n: Long): String {
        if (n < 1024) return "$n B"
        val u = arrayOf("KB", "MB", "GB", "TB")
        var v = n / 1024.0; var i = 0
        while (v >= 1024 && i < u.size - 1) { v /= 1024; i++ }
        return String.format(Locale.US, if (v >= 100) "%.0f %s" else if (v >= 10) "%.1f %s" else "%.2f %s", v, u[i])
    }
    fun speed(bps: Double) = bytes(bps.toLong()) + "/s"
    fun eta(sec: Long): String = when {
        sec < 0 -> ""
        sec < 60 -> "${sec}s left"
        sec < 3600 -> "${sec / 60}m ${sec % 60}s left"
        else -> "${sec / 3600}h ${(sec % 3600) / 60}m left"
    }
}
