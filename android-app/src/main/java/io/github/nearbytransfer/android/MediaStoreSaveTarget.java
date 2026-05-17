package io.github.nearbytransfer.android;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.OutputStream;

final class MediaStoreSaveTarget implements SaveTarget {
    private static final String SUBDIRECTORY = "Nearby Transfer";

    private final Context context;

    MediaStoreSaveTarget(Context context) {
        this.context = context.getApplicationContext();
    }

    @Override
    public String displayName() {
        return "下载目录/" + SUBDIRECTORY;
    }

    @Override
    public String displayPathFor(String fileName) {
        return displayName() + "/" + HttpTransferServer.safeFilename(fileName);
    }

    @Override
    public PendingSave prepare(String fileName) throws Exception {
        String safeName = HttpTransferServer.safeFilename(fileName);
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + SUBDIRECTORY);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IllegalStateException("无法创建下载文件");
        }
        return new MediaStorePendingSave(context, uri, safeName);
    }

    private static final class MediaStorePendingSave implements PendingSave {
        private final Context context;
        private final Uri uri;
        private final String name;

        MediaStorePendingSave(Context context, Uri uri, String name) {
            this.context = context;
            this.uri = uri;
            this.name = name;
        }

        @Override
        public String displayPath() {
            return "下载目录/" + SUBDIRECTORY + "/" + name;
        }

        @Override
        public OutputStream openOutputStream() throws Exception {
            OutputStream output = context.getContentResolver().openOutputStream(uri, "w");
            if (output == null) {
                throw new IllegalStateException("无法打开下载文件");
            }
            return output;
        }

        @Override
        public void commit() {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            context.getContentResolver().update(uri, values, null, null);
        }

        @Override
        public void abort() {
            try {
                context.getContentResolver().delete(uri, null, null);
            } catch (Exception ignored) {
            }
        }
    }
}
