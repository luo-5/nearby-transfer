package io.github.nearbytransfer.android.feature.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nearbytransfer.android.R

private enum class MigrationDestination(val titleRes: Int) {
    DEVICES(R.string.nav_devices),
    TRANSFERS(R.string.nav_transfers),
    LIBRARIES(R.string.nav_libraries),
    SETTINGS(R.string.nav_settings),
}

/**
 * Navigation and visual shell only. It intentionally has no transfer, discovery,
 * persistence, or navigation side effects while the Java MVP owns production runtime.
 */
@Composable
fun NearbyTransferMigrationApp() {
    val destinations = MigrationDestination.entries
    val selected = MigrationDestination.DEVICES

    Scaffold(
        bottomBar = {
            NavigationBar {
                destinations.forEach { destination ->
                    NavigationBarItem(
                        selected = destination == selected,
                        onClick = { },
                        icon = {},
                        label = { Text(stringResource(destination.titleRes)) },
                    )
                }
            }
        },
    ) { paddingValues ->
        MigrationPlaceholder(
            destination = selected,
            contentPadding = paddingValues,
        )
    }
}

@Composable
private fun MigrationPlaceholder(
    destination: MigrationDestination,
    contentPadding: PaddingValues,
) {
    val descriptionRes = when (destination) {
        MigrationDestination.DEVICES -> R.string.devices_placeholder
        MigrationDestination.TRANSFERS -> R.string.transfers_placeholder
        MigrationDestination.LIBRARIES -> R.string.libraries_placeholder
        MigrationDestination.SETTINGS -> R.string.settings_placeholder
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(contentPadding)
            .padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.compose_migration_title),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
        )
        Text(
            text = stringResource(destination.titleRes),
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            text = stringResource(descriptionRes),
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.padding(top = 12.dp),
        )
        Text(
            text = stringResource(R.string.compose_migration_notice),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 32.dp),
        )
    }
}
