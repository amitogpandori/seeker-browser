package com.seeker.browser

import android.content.Context
import android.content.SharedPreferences
import androidx.preference.PreferenceManager

/** Typed access to the Settings screen values (desktop: settings.json). */
object Prefs {
    lateinit var p: SharedPreferences
    val ready get() = ::p.isInitialized
    fun init(ctx: Context) {
        PreferenceManager.setDefaultValues(ctx, R.xml.settings, false)
        p = PreferenceManager.getDefaultSharedPreferences(ctx)
    }

    // General
    val homepage get() = p.getString("homepage", "")!!.trim()
    val theme get() = p.getString("theme", "system")!!
    val restoreTabs get() = p.getBoolean("restore_tabs", true)

    // Privacy Shield: off / standard / strict
    val shieldMode get() = p.getString("shield_mode", "standard")!!
    val shieldOn get() = shieldMode != "off"
    val strict get() = shieldMode == "strict"
    val adblock get() = p.getBoolean("adblock", true)
    val fingerprint get() = p.getBoolean("fingerprint", true) || strict
    val stripTracking get() = p.getBoolean("strip_tracking", true) || strict
    val blockThirdPartyCookies get() = p.getBoolean("block_3p_cookies", true) || strict
    val forgetOnClose get() = p.getBoolean("forget_on_close", false) || strict
    val lookLikeChrome get() = p.getBoolean("look_like_chrome", true)
    val doNotTrack get() = p.getBoolean("do_not_track", true)
    var exceptions: Set<String>
        get() = p.getStringSet("shield_exceptions", DEFAULT_EXCEPTIONS)!!
        set(v) { p.edit().putStringSet("shield_exceptions", v).apply() }
    val googleSignIn get() = p.getString("google_signin", "inapp")!!   // inapp | customtab

    // Route: direct / orbot / proxy
    val route get() = p.getString("route", "direct")!!
    val proxy get() = p.getString("proxy", "")!!.trim()

    // Downloads
    val connections get() = p.getString("dl_connections", "8")!!.toIntOrNull()?.coerceIn(1, 16) ?: 8
    val maxConcurrent get() = p.getString("dl_max_concurrent", "3")!!.toIntOrNull()?.coerceIn(1, 6) ?: 3
    val speedLimitKB get() = p.getString("dl_speed_limit", "0")!!.toLongOrNull()?.coerceAtLeast(0) ?: 0
    val clipboardCatch get() = p.getBoolean("dl_clipboard", true)
    val autoResume get() = p.getBoolean("dl_auto_resume", true)

    // Seeker / gestures
    val pageMemory get() = p.getBoolean("page_memory", true)
    val gestureSwipeTabs get() = p.getBoolean("gesture_swipe_tabs", true)
    val gesturePullRefresh get() = p.getBoolean("gesture_pull_refresh", true)

    // AI
    var aiProvider: String
        get() = p.getString("ai_provider", "openrouter")!!
        set(v) { p.edit().putString("ai_provider", v).apply() }
    var aiModel: String
        get() = p.getString("ai_model_${aiProvider}", "")!!
        set(v) { p.edit().putString("ai_model_${aiProvider}", v).apply() }
    fun aiBase(provider: String) = p.getString("ai_base_$provider", "")!!.trim()

    // the desktop default Shield-off list (sign-in sites)
    val DEFAULT_EXCEPTIONS = setOf("google.com", "youtube.com", "accounts.google.com")
}
