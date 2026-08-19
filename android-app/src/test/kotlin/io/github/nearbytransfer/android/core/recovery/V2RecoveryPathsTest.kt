package io.github.nearbytransfer.android.core.recovery

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.nio.file.Files

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class V2RecoveryPathsTest {
    @Test
    fun stagingRootIsResolvedInsideTheRealAppFilesDirectory() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val root = V2RecoveryPaths.stagingRoot(context)
        val realFilesRoot = context.filesDir.toPath().toAbsolutePath().normalize().toRealPath()

        assertTrue(root.startsWith(realFilesRoot))
        assertTrue(root != realFilesRoot)
        assertFalse(Files.isSymbolicLink(root))
        assertTrue(Files.isSameFile(root, root.toRealPath()))
    }
}
