package io.github.nearbytransfer.android.feature.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsUiStateTest {
    @Test
    fun defaultSettingsUiStateHasSensibleDefaults() {
        val state = SettingsUiState(
            deviceId = "0123456789abcdef",
            deviceName = "Android Phone",
            fingerprint = "0123456789abcdef0123456789abcdef",
        )

        assertEquals("0123456789abcdef", state.deviceId)
        assertEquals("Android Phone", state.deviceName)
        assertTrue(state.isLogFollowing)
        assertTrue(state.logEntries.isEmpty())
        assertNull(state.storageTreeUri)
    }

    @Test
    fun settingsUiStateWithLogsRetainsEntries() {
        val logs = listOf("Log entry 1", "Log entry 2")
        val state = SettingsUiState(
            logEntries = logs,
            isStorageDetailsExpanded = true,
        )

        assertEquals(2, state.logEntries.size)
        assertTrue(state.isStorageDetailsExpanded)
    }
}
