package io.github.nearbytransfer.android.library;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

public class WebDavClient {

    public interface EventListener {
        void onLibraryChanged(String shareId, String eventType, String filename);
        void onConnected();
        void onError(Exception e);
    }

    public interface ProgressListener {
        void onProgress(long transferredBytes, long totalBytes);
    }

    public static class ShareInfo {
        public final String id;
        public final String name;
        public final boolean readOnly;

        public ShareInfo(String id, String name, boolean readOnly) {
            this.id = id;
            this.name = name;
            this.readOnly = readOnly;
        }
    }

    public static class WebDavItem {
        public final String name;
        public final boolean isDirectory;
        public final long size;
        public final long lastModified;
        public final String downloadUrl;

        public WebDavItem(String name, boolean isDirectory, long size, long lastModified, String downloadUrl) {
            this.name = name;
            this.isDirectory = isDirectory;
            this.size = size;
            this.lastModified = lastModified;
            this.downloadUrl = downloadUrl;
        }
    }

    public static class SessionResult {
        public final boolean ok;
        public final String token;
        public final List<ShareInfo> shares;
        public final String error;

        public SessionResult(boolean ok, String token, List<ShareInfo> shares, String error) {
            this.ok = ok;
            this.token = token;
            this.shares = shares != null ? shares : Collections.emptyList();
            this.error = error;
        }
    }

    public static SessionResult authenticate(String serverIp, int port, String deviceId, String signingPrivateKeyPem) {
        if (signingPrivateKeyPem == null || signingPrivateKeyPem.isEmpty()) {
            return new SessionResult(false, null, null, "缺少本机签名私钥，无法完成库认证");
        }
        HttpURLConnection conn = null;
        try {
            URL url = new URL("https://" + serverIp + ":" + port + "/api/session");
            conn = (HttpURLConnection) url.openConnection();
            configureSsl(conn);
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(5000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");

            long timestamp = System.currentTimeMillis();
            String nonce = newAuthNonce();
            // Must stay byte-for-byte identical to the desktop handshake payload.
            String signature = CryptoUtil.sign(
                "nearby-transfer:library-auth:" + deviceId + ":" + timestamp + ":" + nonce,
                signingPrivateKeyPem);

            JSONObject requestJson = new JSONObject();
            requestJson.put("deviceId", deviceId);
            requestJson.put("timestamp", timestamp);
            requestJson.put("nonce", nonce);
            requestJson.put("signature", signature);
            byte[] bodyBytes = requestJson.toString().getBytes(StandardCharsets.UTF_8);

            try (OutputStream out = conn.getOutputStream()) {
                out.write(bodyBytes);
                out.flush();
            }

            int code = conn.getResponseCode();
            InputStream in = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
            String responseStr = readString(in);

            if (code < 200 || code >= 300) {
                String errMsg = "HTTP " + code;
                try {
                    JSONObject errObj = new JSONObject(responseStr);
                    if (errObj.has("error")) errMsg = errObj.getString("error");
                } catch (Exception ignored) {}
                return new SessionResult(false, null, null, errMsg);
            }

            JSONObject json = new JSONObject(responseStr);
            String token = json.optString("token", "");
            List<ShareInfo> shares = new ArrayList<>();
            JSONArray sharesArr = json.optJSONArray("shares");
            if (sharesArr != null) {
                for (int i = 0; i < sharesArr.length(); i++) {
                    JSONObject s = sharesArr.getJSONObject(i);
                    shares.add(new ShareInfo(
                        s.optString("id", "default-share"),
                        s.optString("name", "共享库"),
                        s.optBoolean("readOnly", false)
                    ));
                }
            }
            return new SessionResult(true, token, shares, null);
        } catch (Exception e) {
            return new SessionResult(false, null, null, e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    public static List<WebDavItem> listFiles(String serverIp, int port, String token, String shareId, String subPath) throws Exception {
        HttpURLConnection conn = null;
        try {
            String pathParam = subPath == null ? "" : URLEncoder.encode(subPath, "UTF-8");
            String shareParam = shareId == null ? "default-share" : URLEncoder.encode(shareId, "UTF-8");
            URL url = new URL("https://" + serverIp + ":" + port + "/api/list?shareId=" + shareParam + "&path=" + pathParam);
            conn = (HttpURLConnection) url.openConnection();
            configureSsl(conn);
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(5000);
            conn.setRequestProperty("Authorization", "Bearer " + token);

            int code = conn.getResponseCode();
            if (code != 200) {
                throw new IllegalStateException("读取目录失败 (HTTP " + code + ")");
            }

            String responseStr = readString(conn.getInputStream());
            JSONObject json = new JSONObject(responseStr);
            JSONArray itemsArr = json.optJSONArray("items");
            List<WebDavItem> result = new ArrayList<>();
            if (itemsArr != null) {
                for (int i = 0; i < itemsArr.length(); i++) {
                    JSONObject item = itemsArr.getJSONObject(i);
                    result.add(new WebDavItem(
                        item.optString("name"),
                        item.optBoolean("isDirectory", false),
                        item.optLong("size", 0),
                        item.optLong("mtime", 0),
                        item.optString("downloadUrl")
                    ));
                }
            }
            return result;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    public static void downloadFile(String serverIp, int port, String token, String downloadUrl, File destFile, ProgressListener listener) throws Exception {
        downloadFile(serverIp, port, token, downloadUrl, destFile, listener, null, null);
    }

    public static void downloadFile(String serverIp, int port, String token, String downloadUrl, File destFile, ProgressListener listener, java.util.concurrent.atomic.AtomicBoolean cancelSignal, java.util.concurrent.atomic.AtomicBoolean pauseSignal) throws Exception {
        HttpURLConnection conn = null;
        File tempFile = new File(destFile.getAbsolutePath() + ".tmp");
        try {
            String fullUrl = "https://" + serverIp + ":" + port + downloadUrl;
            URL url = new URL(fullUrl);
            conn = (HttpURLConnection) url.openConnection();
            configureSsl(conn);
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("Authorization", "Bearer " + token);

            int code = conn.getResponseCode();
            if (code != 200) {
                throw new IllegalStateException("下载失败 (HTTP " + code + ")");
            }

            long totalBytes = conn.getContentLengthLong();
            File parent = destFile.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }

            try (InputStream in = conn.getInputStream();
                 FileOutputStream out = new FileOutputStream(tempFile)) {
                byte[] buffer = new byte[64 * 1024];
                long transferred = 0;
                int read;
                while ((read = in.read(buffer)) != -1) {
                    if (cancelSignal != null && cancelSignal.get()) {
                        throw new InterruptedException("用户已取消下载");
                    }
                    while (pauseSignal != null && pauseSignal.get()) {
                        if (cancelSignal != null && cancelSignal.get()) {
                            throw new InterruptedException("用户已取消下载");
                        }
                        Thread.sleep(100);
                    }
                    out.write(buffer, 0, read);
                    transferred += read;
                    if (listener != null) {
                        listener.onProgress(transferred, totalBytes);
                    }
                }
                out.flush();
            }

            if (destFile.exists()) {
                destFile.delete();
            }
            if (!tempFile.renameTo(destFile)) {
                throw new IllegalStateException("无法写入目标文件：" + destFile.getName());
            }
        } catch (Exception e) {
            if (tempFile.exists()) tempFile.delete();
            throw e;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    public static void uploadFile(String serverIp, int port, String token, String shareId, String subPath, String fileName, InputStream inStream, long length, ProgressListener listener) throws Exception {
        uploadFile(serverIp, port, token, shareId, subPath, fileName, inStream, length, listener, null, null);
    }

    public static void uploadFile(String serverIp, int port, String token, String shareId, String subPath, String fileName, InputStream inStream, long length, ProgressListener listener, java.util.concurrent.atomic.AtomicBoolean cancelSignal, java.util.concurrent.atomic.AtomicBoolean pauseSignal) throws Exception {
        HttpURLConnection conn = null;
        try {
            StringBuilder pathBuilder = new StringBuilder();
            if (subPath != null && !subPath.trim().isEmpty()) {
                String[] parts = subPath.replace('\\', '/').split("/");
                for (String part : parts) {
                    if (!part.isEmpty()) {
                        pathBuilder.append("/").append(URLEncoder.encode(part, "UTF-8").replace("+", "%20"));
                    }
                }
            }
            pathBuilder.append("/").append(URLEncoder.encode(fileName, "UTF-8").replace("+", "%20"));
            String fullUrl = "https://" + serverIp + ":" + port + "/webdav/" + shareId + pathBuilder.toString();
            URL url = new URL(fullUrl);
            conn = (HttpURLConnection) url.openConnection();
            configureSsl(conn);
            conn.setRequestMethod("PUT");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(60000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Content-Type", "application/octet-stream");
            if (length > 0) {
                conn.setFixedLengthStreamingMode(length);
            } else {
                conn.setChunkedStreamingMode(64 * 1024);
            }

            try (OutputStream out = conn.getOutputStream()) {
                byte[] buffer = new byte[64 * 1024];
                long transferred = 0;
                int read;
                while ((read = inStream.read(buffer)) != -1) {
                    if (cancelSignal != null && cancelSignal.get()) {
                        throw new InterruptedException("用户已取消上传");
                    }
                    while (pauseSignal != null && pauseSignal.get()) {
                        if (cancelSignal != null && cancelSignal.get()) {
                            throw new InterruptedException("用户已取消上传");
                        }
                        Thread.sleep(100);
                    }
                    out.write(buffer, 0, read);
                    transferred += read;
                    if (listener != null) {
                        listener.onProgress(transferred, length);
                    }
                }
                out.flush();
            }

            int code = conn.getResponseCode();
            if (code != 200 && code != 201) {
                String err = readString(conn.getErrorStream());
                throw new IllegalStateException("上传失败 (HTTP " + code + "): " + err);
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    public static void createDirectory(String serverIp, int port, String token, String shareId, String subPath, String dirName) throws Exception {
        HttpURLConnection conn = null;
        try {
            StringBuilder pathBuilder = new StringBuilder();
            if (subPath != null && !subPath.trim().isEmpty()) {
                String[] parts = subPath.replace('\\', '/').split("/");
                for (String part : parts) {
                    if (!part.isEmpty()) {
                        pathBuilder.append("/").append(URLEncoder.encode(part, "UTF-8").replace("+", "%20"));
                    }
                }
            }
            pathBuilder.append("/").append(URLEncoder.encode(dirName, "UTF-8").replace("+", "%20"));
            String fullUrl = "https://" + serverIp + ":" + port + "/webdav/" + shareId + pathBuilder.toString();
            URL url = new URL(fullUrl);
            conn = (HttpURLConnection) url.openConnection();
            configureSsl(conn);
            conn.setRequestMethod("MKCOL");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            int code = conn.getResponseCode();
            if (code != 200 && code != 201 && code != 204) {
                String err = readString(conn.getErrorStream());
                throw new IllegalStateException("创建文件夹失败 (HTTP " + code + "): " + err);
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    public static void deleteItem(String serverIp, int port, String token, String shareId, String subPath, String itemName) throws Exception {
        HttpURLConnection conn = null;
        try {
            StringBuilder pathBuilder = new StringBuilder();
            if (subPath != null && !subPath.trim().isEmpty()) {
                String[] parts = subPath.replace('\\', '/').split("/");
                for (String part : parts) {
                    if (!part.isEmpty()) {
                        pathBuilder.append("/").append(URLEncoder.encode(part, "UTF-8").replace("+", "%20"));
                    }
                }
            }
            pathBuilder.append("/").append(URLEncoder.encode(itemName, "UTF-8").replace("+", "%20"));
            String fullUrl = "https://" + serverIp + ":" + port + "/webdav/" + shareId + pathBuilder.toString();
            URL url = new URL(fullUrl);
            conn = (HttpURLConnection) url.openConnection();
            configureSsl(conn);
            conn.setRequestMethod("DELETE");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            int code = conn.getResponseCode();
            if (code != 200 && code != 204) {
                String err = readString(conn.getErrorStream());
                throw new IllegalStateException("删除失败 (HTTP " + code + "): " + err);
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    public static void subscribeEvents(String serverIp, int port, String token, EventListener listener, java.util.concurrent.atomic.AtomicBoolean cancelSignal) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL("https://" + serverIp + ":" + port + "/api/events");
            conn = (HttpURLConnection) url.openConnection();
            configureSsl(conn);
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(6000);
            conn.setReadTimeout(0);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "text/event-stream");

            int code = conn.getResponseCode();
            if (code != 200) {
                if (listener != null) listener.onError(new IllegalStateException("SSE 订阅连接失败 (HTTP " + code + ")"));
                return;
            }

            try (java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                if (listener != null) listener.onConnected();
                String line;
                String currentEvent = "message";
                while (!cancelSignal.get() && (line = reader.readLine()) != null) {
                    line = line.trim();
                    if (line.isEmpty()) {
                        currentEvent = "message";
                        continue;
                    }
                    if (line.startsWith(":")) {
                        continue;
                    }
                    if (line.startsWith("event:")) {
                        currentEvent = line.substring(6).trim();
                        continue;
                    }
                    if (line.startsWith("data:")) {
                        String dataStr = line.substring(5).trim();
                        if ("change".equals(currentEvent) || dataStr.contains("\"change\"")) {
                            String shareId = "default-share";
                            String eventType = "change";
                            String filename = "";
                            try {
                                JSONObject obj = new JSONObject(dataStr);
                                shareId = obj.optString("shareId", "default-share");
                                eventType = obj.optString("eventType", "change");
                                filename = obj.optString("filename", "");
                            } catch (Exception ignored) {}
                            if (listener != null) {
                                listener.onLibraryChanged(shareId, eventType, filename);
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            if (!cancelSignal.get() && listener != null) {
                listener.onError(e);
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String newAuthNonce() {
        byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        StringBuilder builder = new StringBuilder(32);
        for (byte b : bytes) {
            builder.append(String.format(Locale.ROOT, "%02x", b));
        }
        return builder.toString();
    }

    private static String readString(InputStream in) {
        if (in == null) return "";
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int r;
            while ((r = in.read(buf)) != -1) {
                out.write(buf, 0, r);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return "";
        }
    }

    private static javax.net.ssl.SSLSocketFactory sslSocketFactory = null;
    private static final HostnameVerifier HOSTNAME_VERIFIER = (hostname, session) -> true;

    private static synchronized void initSsl() {
        if (sslSocketFactory != null) return;
        try {
            TrustManager[] trustAllCerts = new TrustManager[]{
                new X509TrustManager() {
                    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[]{}; }
                    public void checkClientTrusted(X509Certificate[] certs, String authType) { }
                    public void checkServerTrusted(X509Certificate[] certs, String authType) { }
                }
            };
            SSLContext sc = SSLContext.getInstance("TLS");
            sc.init(null, trustAllCerts, new java.security.SecureRandom());
            sslSocketFactory = sc.getSocketFactory();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private static void configureSsl(HttpURLConnection conn) {
        if (conn instanceof HttpsURLConnection) {
            initSsl();
            if (sslSocketFactory != null) {
                ((HttpsURLConnection) conn).setSSLSocketFactory(sslSocketFactory);
            }
            ((HttpsURLConnection) conn).setHostnameVerifier(HOSTNAME_VERIFIER);
        }
    }
}
