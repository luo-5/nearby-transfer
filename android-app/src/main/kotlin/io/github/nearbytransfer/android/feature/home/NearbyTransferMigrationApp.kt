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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nearbytransfer.android.R
import io.github.nearbytransfer.android.feature.devices.DevicesScreen
import io.github.nearbytransfer.android.feature.devices.DevicesUiState
import io.github.nearbytransfer.android.feature.libraries.LibrariesScreen
import io.github.nearbytransfer.android.feature.libraries.LibrariesUiState
import io.github.nearbytransfer.android.feature.settings.SettingsScreen
import io.github.nearbytransfer.android.feature.settings.SettingsUiState
import io.github.nearbytransfer.android.feature.transfers.TransfersScreen
import io.github.nearbytransfer.android.feature.transfers.TransfersUiState

enum class MigrationDestination(val titleRes: Int) {
    DEVICES(R.string.nav_devices),
    TRANSFERS(R.string.nav_transfers),
    LIBRARIES(R.string.nav_libraries),
    SETTINGS(R.string.nav_settings),
}

/**
 * Modern Compose application shell. Connects state-driven feature screens
 * with responsive Material3 navigation.
 */
@Composable
fun NearbyTransferMigrationApp(
    devicesState: DevicesUiState = DevicesUiState(),
    transfersState: TransfersUiState = TransfersUiState(),
    librariesState: LibrariesUiState = LibrariesUiState(),
    settingsState: SettingsUiState = SettingsUiState(),
    initialDestination: MigrationDestination = MigrationDestination.DEVICES,
) {
    val destinations = MigrationDestination.entries
    var selectedDestination by remember { mutableStateOf(initialDestination) }

    Scaffold(
        bottomBar = {
            NavigationBar {
                destinations.forEach { destination ->
                    NavigationBarItem(
                        selected = destination == selectedDestination,
                        onClick = { selectedDestination = destination },
                        icon = {},
                        label = { Text(stringResource(destination.titleRes)) },
                    )
                }
            }
        },
    ) { paddingValues ->
        when (selectedDestination) {
            MigrationDestination.DEVICES -> DevicesScreen(
                state = devicesState,
                contentPadding = paddingValues,
            )
            MigrationDestination.TRANSFERS -> TransfersScreen(
                state = transfersState,
                contentPadding = paddingValues,
            )
            MigrationDestination.SETTINGS -> SettingsScreen(
                state = settingsState,
                contentPadding = paddingValues,
            )
            MigrationDestination.LIBRARIES -> LibrariesScreen(
                state = librariesState,
                contentPadding = paddingValues,
            )
        }
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
