package io.github.nearbytransfer.android

import android.app.Application
import io.github.nearbytransfer.android.core.data.local.NearbyTransferDatabase
import io.github.nearbytransfer.android.core.recovery.V2StartupRecoveryRunner

/** Application-level hooks that must run before the legacy Java activity is created. */
class NearbyTransferApplication : Application() {
    /** Application-scoped Room database singleton; never closed by individual callers. */
    val database: NearbyTransferDatabase by lazy { NearbyTransferDatabase.getInstance(this) }

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
