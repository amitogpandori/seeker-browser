package com.seeker.browser

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.EditText
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.preference.EditTextPreference
import androidx.preference.Preference
import androidx.preference.PreferenceFragmentCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder

/** Settings (desktop: seeker://settings). */
class SettingsActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        EdgeToEdge.apply(this)
        findViewById<android.view.View>(R.id.back).setOnClickListener { finish() }
        if (savedInstanceState == null) supportFragmentManager.beginTransaction().replace(R.id.settingsHost, Fragment()).commit()
    }

    class Fragment : PreferenceFragmentCompat() {
        private val importFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            uri ?: return@registerForActivityResult
            try {
                val html = requireContext().contentResolver.openInputStream(uri)!!.use { it.readBytes().toString(Charsets.UTF_8) }
                toast("Imported ${Store.importBookmarksHtml(html)} bookmarks")
            } catch (e: Exception) { toast("Couldn't read that file") }
        }
        private val exportFile = registerForActivityResult(ActivityResultContracts.CreateDocument("text/html")) { uri ->
            uri ?: return@registerForActivityResult
            try { requireContext().contentResolver.openOutputStream(uri)!!.use { it.write(Store.exportBookmarksHtml().toByteArray()) }; toast("Bookmarks exported") }
            catch (e: Exception) { toast("Couldn't save the file") }
        }

        private fun toast(s: String) = Toast.makeText(requireContext(), s, Toast.LENGTH_SHORT).show()
        private fun click(key: String, f: () -> Unit) { findPreference<Preference>(key)?.setOnPreferenceClickListener { f(); true } }

        override fun onCreatePreferences(savedInstanceState: Bundle?, rootKey: String?) {
            setPreferencesFromResource(R.xml.settings, rootKey)
            val ctx = requireContext()
            findPreference<EditTextPreference>("dl_speed_limit")?.setOnBindEditTextListener { it.inputType = android.text.InputType.TYPE_CLASS_NUMBER }
            findPreference<Preference>("theme")?.setOnPreferenceChangeListener { _, v -> applyTheme(v as String); true }
            findPreference<Preference>("route")?.setOnPreferenceChangeListener { _, v ->
                if (v == "orbot" && !Route.orbotInstalled(ctx)) {
                    MaterialAlertDialogBuilder(ctx).setTitle("Orbot needed")
                        .setMessage("Tor on Android runs in Orbot, the official free app from the Tor Project. Install it, tap Start, then come back. Until Tor is connected Seeker sends nothing (it fails closed).")
                        .setPositiveButton("Get Orbot") { _, _ -> Route.openOrbot(ctx) }.setNegativeButton(R.string.cancel, null).show()
                }
                view?.post { Route.apply(ctx) }; true
            }
            findPreference<Preference>("proxy")?.setOnPreferenceChangeListener { _, _ -> view?.post { Route.apply(ctx) }; true }
            click("orbot") { Route.openOrbot(ctx) }
            click("import_bookmarks") { importFile.launch(arrayOf("text/html", "text/plain", "application/octet-stream")) }
            click("export_bookmarks") { exportFile.launch("seeker-bookmarks.html") }
            click("edit_shortcuts") { startActivity(Intent(ctx, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN, SeekerBridge.HOME).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)) }
            click("exceptions") { editExceptions() }
            click("forget_all") {
                MaterialAlertDialogBuilder(ctx).setTitle("Forget every site?").setMessage("All cookies, site storage and cache will be deleted. You'll be signed out of websites.")
                    .setPositiveButton("Forget") { _, _ -> Shield.forgetAll(); toast("Done") }.setNegativeButton(R.string.cancel, null).show()
            }
            findPreference<Preference>("clear_memory")?.apply {
                summary = "${PageMemory.count()} pages remembered"
                setOnPreferenceClickListener { PageMemory.clear(); summary = "0 pages remembered"; true }
            }
            click("ai") { startActivity(Intent(ctx, AiActivity::class.java).putExtra(AiActivity.EXTRA_SETTINGS, true)) }
            findPreference<Preference>("about")?.summary = "Version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) · same Seeker search, download engine and Privacy Shield as the desktop app"
            click("updates") { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/amitogpandori/seeker-browser/releases/tag/android-v${BuildConfig.VERSION_NAME}"))) }
            updateExceptionsSummary()
        }

        private fun updateExceptionsSummary() {
            findPreference<Preference>("exceptions")?.summary = Prefs.exceptions.sorted().joinToString(", ").ifEmpty { "None" }
        }

        private fun editExceptions() {
            val input = EditText(requireContext()).apply { setText(Prefs.exceptions.sorted().joinToString("\n")); minLines = 4 }
            MaterialAlertDialogBuilder(requireContext()).setTitle("Sites with Shield off")
                .setMessage("One site per line. The Shield doesn't block or change anything on these (useful for sign-in pages).")
                .setView(input.also { it.setPadding(48, 24, 48, 24) })
                .setPositiveButton("Save") { _, _ ->
                    Prefs.exceptions = input.text.split(Regex("[\\s,]+")).map { Privacy.hostOf(if (it.contains("://")) it else "https://$it").removePrefix("www.").lowercase() }.filter { it.contains('.') }.toSet()
                    updateExceptionsSummary()
                }.setNegativeButton(R.string.cancel, null).show()
        }
    }

    companion object {
        fun applyTheme(v: String = Prefs.theme) = AppCompatDelegate.setDefaultNightMode(when (v) {
            "light" -> AppCompatDelegate.MODE_NIGHT_NO
            "dark" -> AppCompatDelegate.MODE_NIGHT_YES
            else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
        })
    }
}
