package io.github.nearbytransfer.android.migration

import android.content.Context
import android.content.Intent
import io.github.nearbytransfer.android.BuildConfig

/**
 * Keeps experimental Compose navigation opt-in while the Java MVP is the launcher.
 * A future settings/debug menu may use this instead of knowing the activity class.
 */
object ComposeMigrationEntry {
    fun createIntentOrNull(context: Context): Intent? {
        if (!BuildConfig.ENABLE_COMPOSE_SHELL) return null
        return Intent(context, ComposeMigrationActivity::class.java)
    }
}