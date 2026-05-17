package io.github.nearbytransfer.android;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

final class FileSaveTarget implements SaveTarget {
    private final File directory;

    FileSaveTarget(File directory) {
        this.directory = directory;
    }

    @Override
    public String displayName() {
        return directory.getAbsolutePath();
    }

    @Override
    public String displayPathFor(String fileName) {
        return HttpTransferServer.uniqueDestination(directory, fileName).getAbsolutePath();
    }

    @Override
    public PendingSave prepare(String fileName) throws Exception {
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IllegalStateException("无法创建接收目录：" + directory);
        }
        File finalPath = HttpTransferServer.uniqueDestination(directory, fileName);
        File tempPath = new File(finalPath.getAbsolutePath() + ".part-" + android.os.Process.myPid() + "-" + System.currentTimeMillis());
        return new FilePendingSave(tempPath, finalPath);
    }

    private static final class FilePendingSave implements PendingSave {
        private final File tempPath;
        private File finalPath;

        FilePendingSave(File tempPath, File finalPath) {
            this.tempPath = tempPath;
            this.finalPath = finalPath;
        }

        @Override
        public String displayPath() {
            return finalPath.getAbsolutePath();
        }

        @Override
        public OutputStream openOutputStream() throws Exception {
            return new FileOutputStream(tempPath);
        }

        @Override
        public void commit() throws Exception {
            File latestFinalPath = HttpTransferServer.uniqueDestination(finalPath.getParentFile(), finalPath.getName());
            if (!tempPath.renameTo(latestFinalPath)) {
                tempPath.delete();
                throw new IllegalStateException("Unable to save received file");
            }
            finalPath = latestFinalPath;
        }

        @Override
        public void abort() {
            tempPath.delete();
        }
    }
}
