package io.github.nearbytransfer.android.migration

import androidx.activity.ComponentActivity
import android.os.Bundle
import androidx.activity.compose.setContent
import io.github.nearbytransfer.android.BuildConfig
import io.github.nearbytransfer.android.feature.home.NearbyTransferMigrationApp
import io.github.nearbytransfer.android.ui.theme.NearbyTransferTheme

/**
 * Debug-only entry point for the Compose migration shell.
 *
 * MainActivity intentionally remains the launcher until feature parity, trusted-peer
 * persistence, and a tested migration path are available.
 */
class ComposeMigrationActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!BuildConfig.ENABLE_COMPOSE_SHELL) {
            finish()
            return
        }

        setContent {
            NearbyTransferTheme {
                NearbyTransferMigrationApp()
            }
        }
    }
}