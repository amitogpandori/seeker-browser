package com.seeker.browser

import android.content.res.Configuration
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/** Android 15+ always draws apps edge-to-edge: pad the content by the system bars, cutout and keyboard. */
object EdgeToEdge {
    fun apply(a: ComponentActivity, root: View = a.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0)) {
        a.enableEdgeToEdge()
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        lightBars(a, !isNight(a))
    }
    fun isNight(a: ComponentActivity) = (a.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    fun lightBars(a: ComponentActivity, light: Boolean) {
        WindowCompat.getInsetsController(a.window, a.window.decorView).apply { isAppearanceLightStatusBars = light; isAppearanceLightNavigationBars = light }
    }
}
