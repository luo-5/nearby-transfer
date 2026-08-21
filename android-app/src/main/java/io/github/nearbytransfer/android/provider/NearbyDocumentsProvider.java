package io.github.nearbytransfer.android.provider;

import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsProvider;
import android.webkit.MimeTypeMap;

import io.github.nearbytransfer.android.R;
import io.github.nearbytransfer.android.library.WebDavClient;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.Collections;
import java.util.List;

public class NearbyDocumentsProvider extends DocumentsProvider {

    public static final String AUTHORITY = "io.github.nearbytransfer.android.documents";
    private static final String ROOT_ID = "nearby_nas_root";
    private static final String DEFAULT_SHARE_ID = "default-share";

    private static final String[] DEFAULT_ROOT_PROJECTION = new String[] {
        DocumentsContract.Root.COLUMN_ROOT_ID,
        DocumentsContract.Root.COLUMN_MIME_TYPES,
        DocumentsContract.Root.COLUMN_FLAGS,
        DocumentsContract.Root.COLUMN_ICON,
        DocumentsContract.Root.COLUMN_TITLE,
        DocumentsContract.Root.COLUMN_SUMMARY,
        DocumentsContract.Root.COLUMN_DOCUMENT_ID,
        DocumentsContract.Root.COLUMN_AVAILABLE_BYTES
    };

    private static final String[] DEFAULT_DOCUMENT_PROJECTION = new String[] {
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_MIME_TYPE,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        DocumentsContract.Document.COLUMN_FLAGS,
        DocumentsContract.Document.COLUMN_SIZE
    };

    @Override
    public boolean onCreate() {
        return true;
    }

    private String getTargetServerIp() {
        return "192.168.9.151";
    }

    private int getTargetServerPort() {
        return 56578;
    }

    private String getDeviceId() {
        return "415847b501f88dbb";
    }

    private String getSessionToken() {
        try {
            WebDavClient.SessionResult res = WebDavClient.authenticate(getTargetServerIp(), getTargetServerPort(), getDeviceId());
            if (res.ok) {
                return res.token;
            }
        } catch (Exception ignored) {}
        return null;
    }

    @Override
    public Cursor queryRoots(String[] projection) {
        MatrixCursor result = new MatrixCursor(projection != null ? projection : DEFAULT_ROOT_PROJECTION);
        MatrixCursor.RowBuilder row = result.newRow();
        row.add(DocumentsContract.Root.COLUMN_ROOT_ID, ROOT_ID);
        row.add(DocumentsContract.Root.COLUMN_DOCUMENT_ID, ROOT_ID);
        row.add(DocumentsContract.Root.COLUMN_TITLE, "Nearby Transfer (电脑共享库)");
        row.add(DocumentsContract.Root.COLUMN_SUMMARY, "电脑端受控 WebDAV / NAS 共享文件夹");
        row.add(DocumentsContract.Root.COLUMN_FLAGS,
            DocumentsContract.Root.FLAG_SUPPORTS_CREATE |
            DocumentsContract.Root.FLAG_SUPPORTS_IS_CHILD
        );
        row.add(DocumentsContract.Root.COLUMN_MIME_TYPES, "*/*");
        row.add(DocumentsContract.Root.COLUMN_ICON, R.drawable.app_icon);
        return result;
    }

    @Override
    public Cursor queryDocument(String documentId, String[] projection) throws FileNotFoundException {
        MatrixCursor result = new MatrixCursor(projection != null ? projection : DEFAULT_DOCUMENT_PROJECTION);
        includeDocument(result, documentId);
        return result;
    }

    @Override
    public Cursor queryChildDocuments(String parentDocumentId, String[] projection, String sortOrder) throws FileNotFoundException {
        MatrixCursor result = new MatrixCursor(projection != null ? projection : DEFAULT_DOCUMENT_PROJECTION);
        String token = getSessionToken();
        if (token == null) {
            return result;
        }

        try {
            String subPath = ROOT_ID.equals(parentDocumentId) ? "" : parentDocumentId;
            List<WebDavClient.WebDavItem> items = WebDavClient.listFiles(getTargetServerIp(), getTargetServerPort(), token, DEFAULT_SHARE_ID, subPath);
            for (WebDavClient.WebDavItem item : items) {
                String docId = subPath.isEmpty() ? item.name : (subPath + "/" + item.name);
                MatrixCursor.RowBuilder row = result.newRow();
                row.add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, docId);
                row.add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, item.name);
                row.add(DocumentsContract.Document.COLUMN_SIZE, item.size);
                row.add(DocumentsContract.Document.COLUMN_MIME_TYPE, item.isDirectory ? DocumentsContract.Document.MIME_TYPE_DIR : getMimeType(item.name));
                row.add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, item.lastModified > 0 ? item.lastModified : System.currentTimeMillis());
                row.add(DocumentsContract.Document.COLUMN_FLAGS, DocumentsContract.Document.FLAG_SUPPORTS_DELETE | DocumentsContract.Document.FLAG_SUPPORTS_WRITE);
            }
        } catch (Exception ignored) {}
        return result;
    }

    @Override
    public ParcelFileDescriptor openDocument(String documentId, String mode, CancellationSignal signal) throws FileNotFoundException {
        Context context = getContext();
        if (context == null) throw new FileNotFoundException("Context is null");

        File cacheDir = new File(context.getCacheDir(), "webdav_cache");
        if (!cacheDir.exists()) cacheDir.mkdirs();

        String safeFileName = documentId.replace('/', '_');
        File localCachedFile = new File(cacheDir, safeFileName);
        if (localCachedFile.exists()) {
            localCachedFile.delete();
        }

        String token = getSessionToken();
        if (token != null) {
            try {
                String downloadUrl = "/webdav/" + DEFAULT_SHARE_ID + "/" + Uri.encode(documentId);
                WebDavClient.downloadFile(getTargetServerIp(), getTargetServerPort(), token, downloadUrl, localCachedFile, null);
            } catch (Exception e) {
                throw new FileNotFoundException("Failed to fetch fresh remote file: " + e.getMessage());
            }
        } else {
            throw new FileNotFoundException("Not authenticated to fetch remote file");
        }

        if (!localCachedFile.exists() || localCachedFile.length() == 0) {
            throw new FileNotFoundException("Remote file does not exist on active share");
        }

        int accessMode = ParcelFileDescriptor.parseMode(mode);
        return ParcelFileDescriptor.open(localCachedFile, accessMode);
    }

    private void includeDocument(MatrixCursor result, String documentId) {
        MatrixCursor.RowBuilder row = result.newRow();
        row.add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, documentId);
        if (ROOT_ID.equals(documentId)) {
            row.add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, "电脑共享库");
            row.add(DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.MIME_TYPE_DIR);
            row.add(DocumentsContract.Document.COLUMN_FLAGS, DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE);
            row.add(DocumentsContract.Document.COLUMN_SIZE, 0);
            row.add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, System.currentTimeMillis());
        } else {
            String displayName = documentId.contains("/") ? documentId.substring(documentId.lastIndexOf('/') + 1) : documentId;
            row.add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, displayName);
            row.add(DocumentsContract.Document.COLUMN_MIME_TYPE, getMimeType(displayName));
            row.add(DocumentsContract.Document.COLUMN_FLAGS, DocumentsContract.Document.FLAG_SUPPORTS_DELETE | DocumentsContract.Document.FLAG_SUPPORTS_WRITE);
            row.add(DocumentsContract.Document.COLUMN_SIZE, 0);
            row.add(DocumentsContract.Document.COLUMN_LAST_MODIFIED, System.currentTimeMillis());
        }
    }

    private static String getMimeType(String name) {
        int dot = name.lastIndexOf('.');
        if (dot >= 0) {
            String ext = name.substring(dot + 1).toLowerCase();
            String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            if (mime != null) return mime;
        }
        return "application/octet-stream";
    }
}
