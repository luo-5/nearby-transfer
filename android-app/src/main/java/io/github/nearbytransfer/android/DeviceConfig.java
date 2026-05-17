package io.github.nearbytransfer.android;

import android.content.Context;
import android.os.Build;

import org.json.JSONObject;

import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;

final class DeviceConfig {
    final String deviceId;
    final String deviceName;
    final String fingerprint;
    final String signingPublicKey;
    final String signingPrivateKey;
    final String encryptionPublicKey;
    final String encryptionPrivateKey;

    private DeviceConfig(
        String deviceId,
        String deviceName,
        String fingerprint,
        String signingPublicKey,
        String signingPrivateKey,
        String encryptionPublicKey,
        String encryptionPrivateKey
    ) {
        this.deviceId = deviceId;
        this.deviceName = deviceName;
        this.fingerprint = fingerprint;
        this.signingPublicKey = signingPublicKey;
        this.signingPrivateKey = signingPrivateKey;
        this.encryptionPublicKey = encryptionPublicKey;
        this.encryptionPrivateKey = encryptionPrivateKey;
    }

    static DeviceConfig loadOrCreate(Context context) throws Exception {
        File configFile = new File(context.getFilesDir(), "device.json");
        if (configFile.exists()) {
            JSONObject json = new JSONObject(readText(configFile));
            return new DeviceConfig(
                json.getString("deviceId"),
                json.getString("deviceName"),
                json.getString("fingerprint"),
                json.getString("signingPublicKey"),
                json.getString("signingPrivateKey"),
                json.getString("encryptionPublicKey"),
                json.getString("encryptionPrivateKey")
            );
        }

        KeyPair signing = CryptoUtil.generateEd25519KeyPair();
        KeyPair encryption = CryptoUtil.generateX25519KeyPair();
        String signingPublicKey = CryptoUtil.toPublicPem(signing.getPublic());
        String signingPrivateKey = CryptoUtil.toPrivatePem(signing.getPrivate());
        String encryptionPublicKey = CryptoUtil.toPublicPem(encryption.getPublic());
        String encryptionPrivateKey = CryptoUtil.toPrivatePem(encryption.getPrivate());
        String deviceId = CryptoUtil.deviceIdFor(signingPublicKey);
        String fingerprint = CryptoUtil.fingerprintFor(signingPublicKey);
        String deviceName = Build.MODEL == null || Build.MODEL.trim().isEmpty() ? "Android" : Build.MODEL;

        JSONObject json = new JSONObject();
        json.put("version", 1);
        json.put("deviceId", deviceId);
        json.put("deviceName", deviceName);
        json.put("fingerprint", fingerprint);
        json.put("signingPublicKey", signingPublicKey);
        json.put("signingPrivateKey", signingPrivateKey);
        json.put("encryptionPublicKey", encryptionPublicKey);
        json.put("encryptionPrivateKey", encryptionPrivateKey);
        writeText(configFile, json.toString(2));

        return new DeviceConfig(deviceId, deviceName, fingerprint, signingPublicKey, signingPrivateKey, encryptionPublicKey, encryptionPrivateKey);
    }

    JSONObject toAnnouncement(int port) throws Exception {
        JSONObject json = new JSONObject();
        json.put("app", "nearby-transfer");
        json.put("protocolVersion", 1);
        json.put("type", "announce");
        json.put("deviceId", deviceId);
        json.put("deviceName", deviceName);
        json.put("port", port);
        json.put("signingPublicKey", signingPublicKey);
        json.put("encryptionPublicKey", encryptionPublicKey);
        json.put("fingerprint", fingerprint);
        json.put("timestamp", System.currentTimeMillis());
        return json;
    }

    private static String readText(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] data = new byte[(int) file.length()];
            int offset = 0;
            while (offset < data.length) {
                int read = input.read(data, offset, data.length - offset);
                if (read == -1) {
                    break;
                }
                offset += read;
            }
            return new String(data, 0, offset, StandardCharsets.UTF_8);
        }
    }

    private static void writeText(File file, String text) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }
}
