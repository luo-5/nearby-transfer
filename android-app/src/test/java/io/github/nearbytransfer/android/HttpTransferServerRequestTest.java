package io.github.nearbytransfer.android;

import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.UUID;

import static org.junit.Assert.assertTrue;

public class HttpTransferServerRequestTest {
    @Test
    public void malformedRequestLineReturnsBadRequest() throws Exception {
        assertStatus(rawExchange("GET /health\r\nHost: localhost\r\n\r\n"), 400);
    }

    @Test
    public void malformedHeaderReturnsBadRequest() throws Exception {
        assertStatus(rawExchange("GET /health HTTP/1.1\r\nBroken-Header\r\n\r\n"), 400);
    }

    @Test
    public void truncatedHeadersWithoutTerminatingEmptyLineReturnBadRequest() throws Exception {
        assertStatus(rawExchange("GET /health HTTP/1.1\r\nHost: localhost\r\n"), 400);
    }

    @Test
    public void oversizedHeaderLineReturnsBadRequest() throws Exception {
        StringBuilder request = new StringBuilder();
        request.append("GET /health HTTP/1.1\r\nX-Large: ");
        for (int i = 0; i < 8200; i += 1) {
            request.append('a');
        }
        request.append("\r\n\r\n");
        assertStatus(rawExchange(request.toString()), 400);
    }

    @Test
    public void invalidContentLengthReturnsBadRequest() throws Exception {
        assertStatus(rawExchange(
            "POST /transfer/request HTTP/1.1\r\n" +
                "Host: localhost\r\n" +
                "Content-Length: nope\r\n" +
                "\r\n{}"
        ), 400);
    }

    @Test
    public void invalidChunkedBodyReturnsBadRequest() throws Exception {
        assertStatus(rawExchange(
            "POST /transfer/request HTTP/1.1\r\n" +
                "Host: localhost\r\n" +
                "Transfer-Encoding: chunked\r\n" +
                "\r\n" +
                "zz\r\n"
        ), 400);
    }

    @Test
    public void uploadPathRequiresCanonicalUuidTransferId() throws Exception {
        assertStatus(rawExchange(
            "POST /transfer/upload/not-a-uuid HTTP/1.1\r\n" +
                "Host: localhost\r\n" +
                "Content-Length: 0\r\n" +
                "\r\n"
        ), 400);
    }

    @Test
    public void signedRequestWithInvalidSenderEphemeralPublicKeyReturnsBadRequest() throws Exception {
        DeviceConfig receiver = newTestDevice("Receiver");
        DeviceConfig sender = newTestDevice("Sender");
        JSONObject payload = transferRequest(sender, "not-an-x25519-public-key");
        byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);

        String response = rawExchange(
            "POST /transfer/request HTTP/1.1\r\n" +
                "Host: localhost\r\n" +
                "Content-Type: application/json\r\n" +
                "Content-Length: " + body.length + "\r\n" +
                "\r\n" +
                new String(body, StandardCharsets.UTF_8),
            newServer(receiver)
        );

        assertStatus(response, 400);
        assertTrue(response, response.contains("Invalid sender ephemeral public key"));
    }

    private static String rawExchange(String request) throws Exception {
        return rawExchange(request, newServer(null));
    }

    private static String rawExchange(String request, HttpTransferServer server) throws Exception {
        int port = server.start(0);
        try (Socket socket = new Socket("127.0.0.1", port)) {
            socket.setSoTimeout(5000);
            OutputStream output = socket.getOutputStream();
            output.write(request.getBytes(StandardCharsets.UTF_8));
            output.flush();
            socket.shutdownOutput();

            ByteArrayOutputStream response = new ByteArrayOutputStream();
            InputStream input = socket.getInputStream();
            byte[] buffer = new byte[1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                response.write(buffer, 0, read);
            }
            return response.toString("UTF-8");
        } finally {
            server.stop();
        }
    }

    private static void assertStatus(String response, int status) {
        assertTrue(response, response.startsWith("HTTP/1.1 " + status + " "));
    }

    private static HttpTransferServer newServer(DeviceConfig device) {
        SaveTarget saveTarget = new SaveTarget() {
            @Override
            public String displayName() {
                return "test";
            }

            @Override
            public String displayPathFor(String fileName) {
                return fileName;
            }

            @Override
            public PendingSave prepare(String fileName) {
                throw new AssertionError("No transfer request expected");
            }
        };
        return new HttpTransferServer(device, saveTarget, incoming -> false, event -> { });
    }

    private static JSONObject transferRequest(DeviceConfig sender, String ephemeralPublicKey) throws Exception {
        JSONObject senderJson = new JSONObject();
        senderJson.put("deviceId", sender.deviceId);
        senderJson.put("deviceName", sender.deviceName);
        senderJson.put("fingerprint", sender.fingerprint);
        senderJson.put("signingPublicKey", sender.signingPublicKey);

        JSONObject file = new JSONObject();
        file.put("name", "test.txt");
        file.put("size", 0);
        file.put("sha256", "0".repeat(64));

        JSONObject payload = new JSONObject();
        payload.put("protocolVersion", 1);
        payload.put("transferId", UUID.randomUUID().toString());
        payload.put("sender", senderJson);
        payload.put("file", file);
        payload.put("senderEphemeralPublicKey", ephemeralPublicKey);
        payload.put("signature", CryptoUtil.sign(
            JsonUtil.canonicalTransferRequestPayload(payload),
            sender.signingPrivateKey
        ));
        return payload;
    }

    private static DeviceConfig newTestDevice(String name) throws Exception {
        KeyPair signing = CryptoUtil.generateEd25519KeyPair();
        KeyPair encryption = CryptoUtil.generateX25519KeyPair();
        String signingPublicKey = CryptoUtil.toPublicPem(signing.getPublic());

        Constructor<DeviceConfig> constructor = DeviceConfig.class.getDeclaredConstructor(
            String.class,
            String.class,
            String.class,
            String.class,
            String.class,
            String.class,
            String.class
        );
        constructor.setAccessible(true);
        return constructor.newInstance(
            CryptoUtil.deviceIdFor(signingPublicKey),
            name,
            CryptoUtil.fingerprintFor(signingPublicKey),
            signingPublicKey,
            CryptoUtil.toPrivatePem(signing.getPrivate()),
            CryptoUtil.toPublicPem(encryption.getPublic()),
            CryptoUtil.toPrivatePem(encryption.getPrivate())
        );
    }
}
