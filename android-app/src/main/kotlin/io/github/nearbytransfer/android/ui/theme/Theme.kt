package io.github.nearbytransfer.android.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Color(0xFF0D9488),
    onPrimary = Color.White,
    secondary = Color(0xFF155E75),
    background = Color(0xFFF7FAFA),
    surface = Color.White,
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF5EEAD4),
    secondary = Color(0xFF67E8F9),
)

@Composable
fun NearbyTransferTheme(
    darkTheme: Boolean = false,
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}