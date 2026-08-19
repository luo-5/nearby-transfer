package io.github.nearbytransfer.android

import android.app.Application
import io.github.nearbytransfer.android.core.recovery.V2StartupRecoveryRunner

/** Application-level hooks that must run before the legacy Java activity is created. */
class NearbyTransferApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        if (!isRunningUnderRobolectric()) {
            V2StartupRecoveryRunner(this).startAsync()
        }
    }

    private fun isRunningUnderRobolectric(): Boolean = try {
        Class.forName("org.robolectric.RuntimeEnvironment")
        true
    } catch (_: Throwable) {
        false
    }
}