package io.github.nearbytransfer.android;

import android.content.Context;
import android.net.Uri;
import android.provider.DocumentsContract;

import java.io.OutputStream;

final class TreeUriSaveTarget implements SaveTarget {
    private final Context context;
    private final Uri treeUri;

    TreeUriSaveTarget(Context context, Uri treeUri) {
        this.context = context.getApplicationContext();
        this.treeUri = treeUri;
    }

    @Override
    public String displayName() {
        return "自定义文件夹";
    }

    @Override
    public String displayPathFor(String fileName) {
        return displayName() + "/" + HttpTransferServer.safeFilename(fileName);
    }

    @Override
    public PendingSave prepare(String fileName) throws Exception {
        String safeName = HttpTransferServer.safeFilename(fileName);
        Uri parent = DocumentsContract.buildDocumentUriUsingTree(treeUri, DocumentsContract.getTreeDocumentId(treeUri));
        String mimeType = "application/octet-stream";
        Uri documentUri = createUniqueDocument(parent, mimeType, safeName);
        return new TreeUriPendingSave(context, documentUri, displayName() + "/" + safeName);
    }

    private Uri createUniqueDocument(Uri parent, String mimeType, String safeName) throws Exception {
        String base = safeName;
        String ext = "";
        int dot = safeName.lastIndexOf('.');
        if (dot > 0) {
            base = safeName.substring(0, dot);
            ext = safeName.substring(dot);
        }
        for (int index = 0; index < 1000; index++) {
            String candidate = index == 0 ? safeName : base + " (" + index + ")" + ext;
            try {
                return DocumentsContract.createDocument(context.getContentResolver(), parent, mimeType, candidate);
            } catch (IllegalStateException ignored) {
            }
        }
        throw new IllegalStateException("Unable to create output file");
    }

    private static final class TreeUriPendingSave implements PendingSave {
        private final Context context;
        private final Uri documentUri;
        private final String displayPath;

        TreeUriPendingSave(Context context, Uri documentUri, String displayPath) {
            this.context = context;
            this.documentUri = documentUri;
            this.displayPath = displayPath;
        }

        @Override
        public String displayPath() {
            return displayPath;
        }

        @Override
        public OutputStream openOutputStream() throws Exception {
            OutputStream output = context.getContentResolver().openOutputStream(documentUri, "w");
            if (output == null) {
                throw new IllegalStateException("无法打开保存位置");
            }
            return output;
        }

        @Override
        public void commit() {
        }

        @Override
        public void abort() {
            try {
                DocumentsContract.deleteDocument(context.getContentResolver(), documentUri);
            } catch (Exception ignored) {
            }
        }
    }
}
