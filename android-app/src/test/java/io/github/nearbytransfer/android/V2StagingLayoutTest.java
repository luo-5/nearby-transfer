package io.github.nearbytransfer.android;

import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public final class V2StagingLayoutTest {
    private static final String TASK_ID = "ABEiM0RVZneImaq7zN3u_w";

    @Test
    public void buildsDeterministicContainedPaths() throws Exception {
        Path root = Files.createTempDirectory("nearby-staging-layout-").toAbsolutePath();
        try {
            assertEquals(".nearby-transfer-" + TASK_ID + ".staging",
                V2StagingLayout.taskDirectoryName(TASK_ID));
            assertEquals("00000042.part", V2StagingLayout.fileId(42));
            Path task = V2StagingLayout.resolveTaskDirectory(root, TASK_ID);
            Path file = V2StagingLayout.resolveFile(root, TASK_ID, 42);
            assertTrue(task.startsWith(root));
            assertTrue(file.startsWith(task));
            assertEquals(task.resolve("00000042.part"), file);
        } finally {
            Files.delete(root);
        }
    }

    @Test
    public void rejectsInvalidIdentifiersAndRelativeRoots() {
        assertThrows(IllegalArgumentException.class, () -> V2StagingLayout.taskDirectoryName("../escape"));
        assertThrows(IllegalArgumentException.class, () -> V2StagingLayout.fileId(-1));
        assertThrows(IllegalArgumentException.class, () -> V2StagingLayout.fileId(100_000_000));
        assertThrows(IllegalArgumentException.class,
            () -> V2StagingLayout.resolveTaskDirectory(Path.of("relative"), TASK_ID));
        assertThrows(IllegalArgumentException.class, () -> V2StagingLayout.requireFileId("../00000000.part"));
    }
}
