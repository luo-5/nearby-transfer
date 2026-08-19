package io.github.nearbytransfer.android;

import java.nio.file.Path;
import java.util.Locale;
import java.util.regex.Pattern;

/** Shared, deterministic layout for protocol-v2 app-private staging files. */
public final class V2StagingLayout {
    private static final Pattern TASK_ID = Pattern.compile("^[A-Za-z0-9_-]{22}$");
    private static final Pattern FILE_ID = Pattern.compile("^[0-9]{8}\\.part$");
    private static final int MAX_FILE_INDEX = 99_999_999;

    private V2StagingLayout() {}

    public static String taskDirectoryName(String taskId) {
        requireTaskId(taskId);
        return ".nearby-transfer-" + taskId + ".staging";
    }

    public static String fileId(int index) {
        if (index < 0 || index > MAX_FILE_INDEX) {
            throw new IllegalArgumentException("Staging file index is out of range");
        }
        return String.format(Locale.ROOT, "%08d.part", index);
    }

    public static Path resolveTaskDirectory(Path appPrivateStagingRoot, String taskId) {
        Path root = normalizeRoot(appPrivateStagingRoot);
        Path task = root.resolve(taskDirectoryName(taskId)).normalize();
        assertContained(root, task);
        return task;
    }

    public static Path resolveFile(Path appPrivateStagingRoot, String taskId, int fileIndex) {
        Path task = resolveTaskDirectory(appPrivateStagingRoot, taskId);
        Path file = task.resolve(fileId(fileIndex)).normalize();
        assertContained(task, file);
        return file;
    }

    public static Path normalizeRoot(Path appPrivateStagingRoot) {
        if (appPrivateStagingRoot == null || !appPrivateStagingRoot.isAbsolute()) {
            throw new IllegalArgumentException("App-private staging root must be absolute");
        }
        return appPrivateStagingRoot.normalize();
    }

    public static void requireTaskId(String taskId) {
        if (taskId == null || !TASK_ID.matcher(taskId).matches()) {
            throw new IllegalArgumentException("Task ID must be a 22-character base64url value");
        }
        V2TransferCrypto.buildChunkAad(taskId, "validation", 0, 0, 0);
    }

    public static void requireFileId(String fileId) {
        if (fileId == null || !FILE_ID.matcher(fileId).matches()) {
            throw new IllegalArgumentException("Invalid opaque staging file ID");
        }
    }

    private static void assertContained(Path root, Path candidate) {
        if (!candidate.startsWith(root) || candidate.equals(root)) {
            throw new SecurityException("Staging path escapes its owned root");
        }
    }
}
