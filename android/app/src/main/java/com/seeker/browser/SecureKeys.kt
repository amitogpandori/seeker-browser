package com.seeker.browser

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** AI API keys are encrypted with a key that never leaves the Android Keystore (desktop: Windows safeStorage). */
object SecureKeys {
    private const val ALIAS = "seeker-ai-keys"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        g.init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        return g.generateKey()
    }

    fun set(provider: String, value: String) {
        if (value.isBlank()) { Prefs.p.edit().remove("ai_key_$provider").apply(); return }
        val c = Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE, key())
        val out = c.iv + c.doFinal(value.trim().toByteArray())
        Prefs.p.edit().putString("ai_key_$provider", Base64.encodeToString(out, Base64.NO_WRAP)).apply()
    }

    fun get(provider: String): String? {
        val b64 = Prefs.p.getString("ai_key_$provider", null) ?: return null
        return try {
            val all = Base64.decode(b64, Base64.NO_WRAP)
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, all, 0, 12))
            String(c.doFinal(all, 12, all.size - 12))
        } catch (e: Exception) { null }
    }

    fun has(provider: String) = Prefs.p.contains("ai_key_$provider")
}
