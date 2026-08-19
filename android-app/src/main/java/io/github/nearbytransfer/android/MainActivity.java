package io.github.nearbytransfer.android;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.OpenableColumns;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.text.DateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int REQUEST_PICK_FILE = 1001;
    private static final int REQUEST_NEARBY_WIFI = 1002;
    private static final int REQUEST_SAVE_TREE = 1003;
    private static final int REQUEST_STORAGE_WRITE = 1004;
    private static final String PREFS_NAME = "nearby-transfer";
    private static final String PREF_SAVE_TREE_URI = "saveTreeUri";

    private static final int COLOR_BG = Color.rgb(237, 246, 244);
    private static final int COLOR_SURFACE = Color.WHITE;
    private static final int COLOR_SURFACE_TINT = Color.rgb(247, 252, 251);
    private static final int COLOR_TEXT = Color.rgb(12, 25, 48);
    private static final int COLOR_MUTED = Color.rgb(94, 110, 133);
    private static final int COLOR_BORDER = Color.rgb(209, 232, 228);
    private static final int COLOR_NAVY = Color.rgb(9, 31, 68);
    private static final int COLOR_PRIMARY = Color.rgb(20, 184, 166);
    private static final int COLOR_PRIMARY_DARK = Color.rgb(13, 148, 136);
    private static final int COLOR_PRIMARY_SOFT = Color.rgb(209, 250, 244);
    private static final int COLOR_SUCCESS = Color.rgb(22, 163, 74);
    private static final int COLOR_WARNING = Color.rgb(245, 158, 11);
    private static final int COLOR_DANGER = Color.rgb(220, 38, 38);
    private static final int COLOR_DISABLED = Color.rgb(148, 163, 184);

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ArrayDeque<String> logs = new ArrayDeque<>();
    private volatile boolean activityDestroyed;

    private DeviceConfig device;
    private HttpTransferServer transferServer;
    private SaveTarget saveTarget;
    private DiscoveryService discoveryService;
    private V2PairingController v2PairingController;
    private List<V2DiscoveryService.Peer> v2Peers = new ArrayList<>();
    private List<V2TrustedPeerPersistence.TrustedPeerSummary> trustedPeers = new ArrayList<>();
    private SelectedFile selectedFile;
    private PeerDevice selectedPeer;
    private List<PeerDevice> peers = new ArrayList<>();

    private TextView deviceText;
    private TextView saveText;
    private TextView saveModeText;
    private TextView selectedFileText;
    private TextView statusText;
    private TextView logText;
    private LinearLayout peersLayout;
    private LinearLayout v2PeersLayout;
    private LinearLayout v2SessionsLayout;
    private LinearLayout trustedPeersLayout;
    private TextView v2StatusText;
    private TextView trustedPeersStatusText;
    private Button sendButton;
    private ProgressBar transferProgress;
    private TextView progressTitleText;
    private TextView progressDetailText;
    private TextView progressSpeedText;
    private TextView progressPercentText;

    private String activeTransferId;
    private long transferStartedAt;
    private long transferLastAt;
    private long transferLastBytes;
    private long transferLastSpeed;
    private boolean transferActive;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        restoreSelectedFile(savedInstanceState);
        refreshTrustedPeers();
        requestPermissionsThenStart();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_NEARBY_WIFI) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted) {
                startCore();
            } else {
                statusText.setText("未授予附近设备权限，无法搜索局域网设备。");
                appendLog("附近设备权限未授予，无法启动发现。");
            }
        } else if (requestCode == REQUEST_STORAGE_WRITE) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted) {
                startCore();
            } else {
                statusText.setText("未授予存储权限，无法保存到系统下载目录。");
                appendLog("存储权限未授予，无法保存到公共下载目录。");
            }
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        SelectedFileState.save(outState, selectedFile);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onDestroy() {
        activityDestroyed = true;
        if (discoveryService != null) {
            discoveryService.stop();
        }
        if (v2PairingController != null) {
            v2PairingController.close();
        }
        if (transferServer != null) {
            transferServer.stop();
        }
        executor.shutdownNow();
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if ((requestCode != REQUEST_PICK_FILE && requestCode != REQUEST_SAVE_TREE) || resultCode != RESULT_OK || data == null || data.getData() == null) {
            return;
        }

        if (requestCode == REQUEST_SAVE_TREE) {
            setCustomSaveDirectory(data);
            return;
        }

        Uri uri = data.getData();
        try {
            final int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            getContentResolver().takePersistableUriPermission(uri, flags & Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {
            // Some file providers do not grant persistable permissions; the current grant is enough for this send.
        }

        setSelectedFile(describeUri(uri), true);
    }

    private void buildUi() {
        ScrollView scrollView = new ScrollView(this);
        scrollView.setFillViewport(true);
        scrollView.setBackgroundColor(COLOR_BG);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(18), dp(18), dp(28));
        scrollView.addView(root, new ScrollView.LayoutParams(
            ScrollView.LayoutParams.MATCH_PARENT,
            ScrollView.LayoutParams.WRAP_CONTENT
        ));

        LinearLayout hero = cardGradient(COLOR_NAVY, COLOR_PRIMARY_DARK);
        hero.setPadding(dp(20), dp(20), dp(20), dp(20));
        TextView eyebrow = pill("Nearby Transfer", Color.argb(46, 255, 255, 255), Color.WHITE);
        TextView title = text("附近传输", 34, Color.WHITE, Typeface.BOLD);
        title.setPadding(0, dp(14), 0, 0);
        TextView subtitle = text("点对点加密传文件，不经过云端。", 15, Color.rgb(210, 245, 240), Typeface.NORMAL);
        subtitle.setPadding(0, dp(6), 0, 0);
        statusText = pill("正在启动...", Color.argb(42, 255, 255, 255), Color.WHITE);
        LinearLayout.LayoutParams statusParams = matchWrap();
        statusParams.setMargins(0, dp(16), 0, 0);
        hero.addView(eyebrow, wrapContent());
        hero.addView(title, matchWrap());
        hero.addView(subtitle, matchWrap());
        hero.addView(statusText, statusParams);

        LinearLayout quickStats = new LinearLayout(this);
        quickStats.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams quickStatsParams = matchWrap();
        quickStatsParams.setMargins(0, dp(16), 0, 0);
        quickStats.addView(heroMetric("LAN", "本地连接"), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        LinearLayout.LayoutParams metricMiddle = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1);
        metricMiddle.setMargins(dp(8), 0, dp(8), 0);
        quickStats.addView(heroMetric("AES", "端到端加密"), metricMiddle);
        quickStats.addView(heroMetric("SHA", "完整校验"), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        hero.addView(quickStats, quickStatsParams);
        root.addView(hero, cardParams());

        LinearLayout fileCard = card(COLOR_SURFACE);
        addCardHeader(fileCard, "发送文件", "选择文件，再选中附近设备即可开始。");
        Button chooseButton = new Button(this);
        chooseButton.setText("选择要发送的文件");
        chooseButton.setAllCaps(false);
        styleButton(chooseButton, false);
        chooseButton.setOnClickListener(v -> chooseFile());
        fileCard.addView(chooseButton, matchWrap());

        selectedFileText = text("未选择文件。", 15, COLOR_TEXT, Typeface.NORMAL);
        selectedFileText.setPadding(dp(14), dp(12), dp(14), dp(12));
        selectedFileText.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(18), COLOR_BORDER, 1));
        LinearLayout.LayoutParams selectedFileParams = matchWrap();
        selectedFileParams.setMargins(0, dp(12), 0, dp(12));
        fileCard.addView(selectedFileText, selectedFileParams);

        LinearLayout sendTips = new LinearLayout(this);
        sendTips.setOrientation(LinearLayout.HORIZONTAL);
        sendTips.addView(chip("1 选文件"), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        LinearLayout.LayoutParams chipMiddle = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1);
        chipMiddle.setMargins(dp(8), 0, dp(8), 0);
        sendTips.addView(chip("2 选设备"), chipMiddle);
        sendTips.addView(chip("3 确认发送"), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        LinearLayout.LayoutParams tipsParams = matchWrap();
        tipsParams.setMargins(0, 0, 0, dp(12));
        fileCard.addView(sendTips, tipsParams);

        sendButton = new Button(this);
        sendButton.setText("发送到选中设备");
        sendButton.setAllCaps(false);
        sendButton.setEnabled(false);
        styleButton(sendButton, true);
        sendButton.setOnClickListener(v -> sendSelectedFile());
        fileCard.addView(sendButton, matchWrap());
        root.addView(fileCard, cardParams());

        LinearLayout progressCard = card(COLOR_SURFACE);
        addCardHeader(progressCard, "传输进度", "查看当前文件进度、速率和状态。");

        LinearLayout progressHeader = new LinearLayout(this);
        progressHeader.setOrientation(LinearLayout.HORIZONTAL);
        progressHeader.setGravity(Gravity.CENTER_VERTICAL);
        progressTitleText = text("暂无传输", 17, COLOR_TEXT, Typeface.BOLD);
        progressPercentText = pill("0%", COLOR_PRIMARY_SOFT, COLOR_PRIMARY_DARK);
        progressHeader.addView(progressTitleText, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        progressHeader.addView(progressPercentText, wrapContent());
        progressCard.addView(progressHeader, matchWrap());

        transferProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        transferProgress.setMax(1000);
        transferProgress.setProgress(0);
        setProgressColor(COLOR_PRIMARY);
        LinearLayout.LayoutParams progressParams = matchWrap();
        progressParams.setMargins(0, dp(10), 0, dp(10));
        progressCard.addView(transferProgress, progressParams);

        progressDetailText = text("等待发送或接收文件。", 14, COLOR_MUTED, Typeface.NORMAL);
        progressDetailText.setPadding(dp(14), dp(12), dp(14), dp(12));
        progressDetailText.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(18), COLOR_BORDER, 1));
        progressSpeedText = pill("速率 -", COLOR_PRIMARY_SOFT, COLOR_PRIMARY_DARK);
        progressCard.addView(progressDetailText, matchWrap());
        LinearLayout.LayoutParams speedParams = wrapContent();
        speedParams.setMargins(0, dp(10), 0, 0);
        progressCard.addView(progressSpeedText, speedParams);
        root.addView(progressCard, cardParams());

        LinearLayout peerCard = card(COLOR_SURFACE);
        addCardHeader(peerCard, "附近设备", "同一 Wi-Fi 下的设备会自动出现。");
        Button refreshButton = new Button(this);
        refreshButton.setText("立即刷新附近设备");
        refreshButton.setAllCaps(false);
        styleButton(refreshButton, false);
        refreshButton.setOnClickListener(v -> {
            if (discoveryService != null) {
                appendLog("正在主动搜索附近设备...");
                statusText.setText("正在搜索附近设备...");
                discoveryService.announce();
                peersLayout.postDelayed(() -> {
                    peers = discoveryService.listPeers();
                    renderPeers();
                    if (!transferActive) {
                        statusText.setText(peers.isEmpty() ? "暂未发现设备，请确认同一 Wi-Fi 且未开启 AP 隔离。" : "发现 " + peers.size() + " 台设备。");
                    }
                }, 2500);
            }
        });
        peerCard.addView(refreshButton, matchWrap());
        peersLayout = new LinearLayout(this);
        peersLayout.setOrientation(LinearLayout.VERTICAL);
        peersLayout.setPadding(0, dp(10), 0, 0);
        peerCard.addView(peersLayout, matchWrap());
        root.addView(peerCard, cardParams());

        LinearLayout v2Card = card(COLOR_SURFACE);
        addCardHeader(v2Card, "安全配对（协议 v2）", "先核对六位配对码，再把设备保存为可信设备。当前不传输文件。");
        v2StatusText = text("正在启动协议 v2 安全配对…", 14, COLOR_MUTED, Typeface.NORMAL);
        v2StatusText.setPadding(dp(14), dp(12), dp(14), dp(12));
        v2StatusText.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(18), COLOR_BORDER, 1));
        v2Card.addView(v2StatusText, matchWrap());
        Button v2RefreshButton = new Button(this);
        v2RefreshButton.setText("刷新可安全配对的设备");
        v2RefreshButton.setAllCaps(false);
        styleButton(v2RefreshButton, false);
        v2RefreshButton.setOnClickListener(v -> {
            if (v2PairingController != null) {
                v2StatusText.setText("正在发送协议 v2 发现公告…");
                v2PairingController.announceNow();
                v2PeersLayout.postDelayed(this::renderV2Peers, 2500);
            }
        });
        LinearLayout.LayoutParams v2RefreshParams = matchWrap();
        v2RefreshParams.setMargins(0, dp(10), 0, 0);
        v2Card.addView(v2RefreshButton, v2RefreshParams);
        v2PeersLayout = new LinearLayout(this);
        v2PeersLayout.setOrientation(LinearLayout.VERTICAL);
        v2PeersLayout.setPadding(0, dp(10), 0, 0);
        v2Card.addView(v2PeersLayout, matchWrap());
        TextView v2SessionTitle = text("正在进行的配对", 15, COLOR_TEXT, Typeface.BOLD);
        LinearLayout.LayoutParams v2SessionTitleParams = matchWrap();
        v2SessionTitleParams.setMargins(0, dp(14), 0, 0);
        v2Card.addView(v2SessionTitle, v2SessionTitleParams);
        v2SessionsLayout = new LinearLayout(this);
        v2SessionsLayout.setOrientation(LinearLayout.VERTICAL);
        v2SessionsLayout.setPadding(0, dp(8), 0, 0);
        v2Card.addView(v2SessionsLayout, matchWrap());

        TextView trustedPeersTitle = text("可信设备", 15, COLOR_TEXT, Typeface.BOLD);
        LinearLayout.LayoutParams trustedPeersTitleParams = matchWrap();
        trustedPeersTitleParams.setMargins(0, dp(14), 0, 0);
        v2Card.addView(trustedPeersTitle, trustedPeersTitleParams);
        trustedPeersStatusText = text("正在读取可信设备…", 13, COLOR_MUTED, Typeface.NORMAL);
        trustedPeersStatusText.setPadding(0, dp(6), 0, 0);
        v2Card.addView(trustedPeersStatusText, matchWrap());
        Button trustedPeersRefreshButton = new Button(this);
        trustedPeersRefreshButton.setText("刷新可信设备");
        trustedPeersRefreshButton.setAllCaps(false);
        styleButton(trustedPeersRefreshButton, false);
        trustedPeersRefreshButton.setOnClickListener(v -> refreshTrustedPeers());
        LinearLayout.LayoutParams trustedPeersRefreshParams = matchWrap();
        trustedPeersRefreshParams.setMargins(0, dp(8), 0, 0);
        v2Card.addView(trustedPeersRefreshButton, trustedPeersRefreshParams);
        trustedPeersLayout = new LinearLayout(this);
        trustedPeersLayout.setOrientation(LinearLayout.VERTICAL);
        trustedPeersLayout.setPadding(0, dp(8), 0, 0);
        v2Card.addView(trustedPeersLayout, matchWrap());
        root.addView(v2Card, cardParams());

        LinearLayout localCard = card(COLOR_SURFACE);
        addCardHeader(localCard, "本机与保存", "确认本机身份、指纹和接收目录。");
        deviceText = text("正在生成本机密钥...", 14, COLOR_TEXT, Typeface.NORMAL);
        deviceText.setPadding(dp(14), dp(12), dp(14), dp(12));
        deviceText.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(18), COLOR_BORDER, 1));
        saveText = text("保存目录：-", 14, COLOR_MUTED, Typeface.NORMAL);
        saveText.setPadding(dp(14), dp(12), dp(14), dp(12));
        saveText.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(18), COLOR_BORDER, 1));
        saveModeText = pill("保存模式：-", COLOR_PRIMARY_SOFT, COLOR_PRIMARY_DARK);
        Button changeSaveButton = new Button(this);
        changeSaveButton.setText("更改保存位置");
        changeSaveButton.setAllCaps(false);
        styleButton(changeSaveButton, false);
        changeSaveButton.setOnClickListener(v -> chooseSaveDirectory());
        Button resetSaveButton = new Button(this);
        resetSaveButton.setText("恢复默认下载目录");
        resetSaveButton.setAllCaps(false);
        styleButton(resetSaveButton, false);
        resetSaveButton.setOnClickListener(v -> resetSaveDirectory());
        localCard.addView(deviceText, matchWrap());
        LinearLayout.LayoutParams saveTextParams = matchWrap();
        saveTextParams.setMargins(0, dp(10), 0, dp(10));
        localCard.addView(saveText, saveTextParams);
        localCard.addView(saveModeText, wrapContent());
        LinearLayout.LayoutParams changeSaveParams = matchWrap();
        changeSaveParams.setMargins(0, dp(12), 0, 0);
        localCard.addView(changeSaveButton, changeSaveParams);
        LinearLayout.LayoutParams resetSaveParams = matchWrap();
        resetSaveParams.setMargins(0, dp(10), 0, 0);
        localCard.addView(resetSaveButton, resetSaveParams);
        root.addView(localCard, cardParams());

        LinearLayout logCard = card(COLOR_SURFACE);
        addCardHeader(logCard, "日志", "最近的传输和发现状态。");
        logText = text("暂无日志。", 13, COLOR_MUTED, Typeface.NORMAL);
        logText.setTextIsSelectable(true);
        logText.setLineSpacing(dp(2), 1.0f);
        logText.setPadding(dp(14), dp(12), dp(14), dp(12));
        logText.setBackground(roundedStroke(Color.rgb(15, 23, 42), dp(18), Color.rgb(30, 41, 59), 1));
        logText.setTextColor(Color.rgb(203, 213, 225));
        logCard.addView(logText, matchWrap());
        root.addView(logCard, cardParams());

        setContentView(scrollView);
    }

    private void requestPermissionsThenStart() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.NEARBY_WIFI_DEVICES }, REQUEST_NEARBY_WIFI);
            return;
        }
        if (Build.VERSION.SDK_INT < 29 && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.WRITE_EXTERNAL_STORAGE }, REQUEST_STORAGE_WRITE);
            return;
        }
        startCore();
    }

    private void startCore() {
        executor.execute(() -> {
            try {
                device = DeviceConfig.loadOrCreate(this);
                saveTarget = loadSaveTarget();

                transferServer = new HttpTransferServer(
                    device,
                    saveTarget,
                    this::confirmIncomingTransfer,
                    this::onTransferEvent
                );
                int port = transferServer.start(0);

                discoveryService = new DiscoveryService(this, device, port, updatedPeers -> runOnUiThreadIfAlive(() -> {
                    peers = updatedPeers;
                    keepSelectedPeerOnline();
                    renderPeers();
                    renderSendState();
                }), error -> runOnUiThreadIfAlive(() -> appendLog("发现失败：" + error.getMessage())), message -> runOnUiThreadIfAlive(() -> appendLog(message)));
                discoveryService.start();

                try {
                    v2PairingController = new V2PairingController(this, device, new V2PairingController.Listener() {
                        @Override public void onPeersChanged(List<V2DiscoveryService.Peer> updatedPeers) {
                            v2Peers = updatedPeers;
                            renderV2Peers();
                        }

                        @Override public void onSessionChanged(V2PairingSessionStore.Session session) {
                            renderV2Sessions();
                            appendLog("协议 v2 配对状态：" + pairingStatusLabel(session.status));
                            if (session.status == V2PairingSessionStore.Status.READY_TO_TRUST) {
                                v2StatusText.setText("双方已确认配对码；请点击“保存信任”。");
                            } else if (session.status == V2PairingSessionStore.Status.COMPLETED) {
                                refreshTrustedPeers();
                            }
                        }

                        @Override public void onStatus(String message) {
                            v2StatusText.setText(message);
                            appendLog(message);
                        }

                        @Override public void onError(Exception error) {
                            v2StatusText.setText("协议 v2 配对错误：" + error.getMessage());
                            appendLog("协议 v2 配对错误：" + error);
                        }
                    }, this::runOnUiThreadIfAlive);
                    v2PairingController.start();
                } catch (Exception v2Error) {
                    appendLog("协议 v2 安全配对未启动：" + v2Error);
                }

                runOnUiThreadIfAlive(() -> {
                    deviceText.setText("名称：" + device.deviceName + "\n指纹：" + device.fingerprint + "\n端口：" + port);
                    renderSaveTarget();
                    statusText.setText("已启动，正在搜索附近设备。");
                    appendLog("Android 客户端已启动，端口 " + port);
                });
            } catch (Exception error) {
                runOnUiThreadIfAlive(() -> {
                    statusText.setText("启动失败：" + error.getMessage());
                    appendLog("启动失败：" + error);
                    new AlertDialog.Builder(this)
                        .setTitle("启动失败")
                        .setMessage(error.getMessage())
                        .setPositiveButton("确定", null)
                        .show();
                });
            }
        });
    }

    private boolean confirmIncomingTransfer(IncomingTransfer incoming) {
        final Object lock = new Object();
        final boolean[] decision = new boolean[] { false };
        final boolean[] answered = new boolean[] { false };

        runOnUiThreadIfAlive(() -> new AlertDialog.Builder(this)
            .setTitle("接收这个文件吗？")
            .setMessage("发送方：" + incoming.sender.deviceName
                + "\n指纹：" + incoming.sender.fingerprint
                + "\n文件：" + incoming.fileName
                + "\n大小：" + formatBytes(incoming.size)
                + "\n保存到：" + incoming.savePath)
            .setPositiveButton("接收", (dialog, which) -> {
                synchronized (lock) {
                    decision[0] = true;
                    answered[0] = true;
                    lock.notifyAll();
                }
            })
            .setNegativeButton("拒绝", (dialog, which) -> {
                synchronized (lock) {
                    answered[0] = true;
                    lock.notifyAll();
                }
            })
            .setOnCancelListener(dialog -> {
                synchronized (lock) {
                    answered[0] = true;
                    lock.notifyAll();
                }
            })
            .show());

        synchronized (lock) {
            long deadline = System.currentTimeMillis() + 120000;
            while (!answered[0] && System.currentTimeMillis() < deadline) {
                try {
                    lock.wait(1000);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            return decision[0];
        }
    }

    private SaveTarget loadSaveTarget() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String treeUriText = prefs.getString(PREF_SAVE_TREE_URI, null);
        if (treeUriText != null && !treeUriText.trim().isEmpty()) {
            Uri uri = Uri.parse(treeUriText);
            for (android.content.UriPermission permission : getContentResolver().getPersistedUriPermissions()) {
                if (permission.getUri().equals(uri) && permission.isWritePermission()) {
                    return new TreeUriSaveTarget(this, uri);
                }
            }
            prefs.edit().remove(PREF_SAVE_TREE_URI).apply();
        }
        if (Build.VERSION.SDK_INT >= 29) {
            return new MediaStoreSaveTarget(this);
        }
        File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        return new FileSaveTarget(new File(downloads, "Nearby Transfer"));
    }

    private void chooseSaveDirectory() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(intent, REQUEST_SAVE_TREE);
    }

    private void setCustomSaveDirectory(Intent data) {
        Uri uri = data.getData();
        if (uri == null) {
            return;
        }
        try {
            int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            getContentResolver().takePersistableUriPermission(uri, flags);
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putString(PREF_SAVE_TREE_URI, uri.toString()).apply();
            saveTarget = new TreeUriSaveTarget(this, uri);
            if (transferServer != null) {
                transferServer.setSaveTarget(saveTarget);
            }
            renderSaveTarget();
            appendLog("保存位置已更新。");
        } catch (Exception error) {
            appendLog("更改保存位置失败：" + error.getMessage());
        }
    }

    private void renderSaveTarget() {
        saveText.setText("保存目录：" + (saveTarget == null ? "-" : saveTarget.displayName()));
        saveModeText.setText("保存模式：" + saveModeTextFor(saveTarget));
    }

    private String saveModeTextFor(SaveTarget target) {
        if (target == null) {
            return "-";
        }
        if (target instanceof TreeUriSaveTarget) {
            return "自定义目录";
        }
        if (target instanceof MediaStoreSaveTarget || target instanceof FileSaveTarget) {
            return "默认下载目录";
        }
        return "自定义目录";
    }

    private void resetSaveDirectory() {
        try {
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().remove(PREF_SAVE_TREE_URI).apply();
            saveTarget = loadSaveTarget();
            if (transferServer != null) {
                transferServer.setSaveTarget(saveTarget);
            }
            renderSaveTarget();
            appendLog("已恢复默认下载目录。");
        } catch (Exception error) {
            appendLog("恢复默认保存目录失败：" + error.getMessage());
        }
    }

    private void onTransferEvent(TransferEvent event) {
        runOnUiThreadIfAlive(() -> {
            updateTransferProgress(event);
            appendLog(event.toDisplayText());
        });
    }

    private void restoreSelectedFile(Bundle savedInstanceState) {
        SelectedFile restored = SelectedFileState.restore(savedInstanceState);
        if (restored != null) {
            setSelectedFile(restored, false);
        }
    }

    private void setSelectedFile(SelectedFile file, boolean logSelection) {
        selectedFile = file;
        selectedFileText.setText(file.name + "\n" + formatBytes(file.size));
        if (logSelection) {
            appendLog("已选择文件：" + file.name);
        }
        renderSendState();
    }

    private void chooseFile() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(intent, REQUEST_PICK_FILE);
    }

    private SelectedFile describeUri(Uri uri) {
        String name = "file";
        long size = -1;
        try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameIndex >= 0) {
                    String found = cursor.getString(nameIndex);
                    if (found != null && !found.trim().isEmpty()) {
                        name = found;
                    }
                }
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                    size = cursor.getLong(sizeIndex);
                }
            }
        }
        return new SelectedFile(uri, name, size);
    }

    private void sendSelectedFile() {
        if (selectedFile == null) {
            appendLog("请先选择文件。");
            return;
        }
        if (selectedPeer == null) {
            appendLog("请先选择附近设备。");
            return;
        }
        if (device == null) {
            appendLog("应用还未准备好。");
            return;
        }

        sendButton.setEnabled(false);
        transferActive = true;
        styleButton(sendButton, true);
        statusText.setText("正在准备发送...");
        progressTitleText.setText("正在准备发送");
        progressDetailText.setText(selectedFile.name + "\n正在计算校验值...");
        progressSpeedText.setText("速率 -");
        progressPercentText.setText("0%");
        transferProgress.setProgress(0);
        setProgressColor(COLOR_PRIMARY);

        PeerDevice peer = selectedPeer;
        SelectedFile file = selectedFile;
        executor.execute(() -> {
            String finalStatus = "发送已结束。";
            try {
                TransferClient.send(this, device, peer, file, this::onTransferEvent);
                finalStatus = "发送完成。";
            } catch (Exception error) {
                String errorMessage = error.getMessage();
                String failureStatus = "发送失败：" + errorMessage;
                finalStatus = failureStatus;
                runOnUiThreadIfAlive(() -> {
                    setProgressColor(COLOR_DANGER);
                    progressTitleText.setText("发送失败");
                    progressSpeedText.setText(errorMessage);
                    appendLog(failureStatus);
                });
            } finally {
                String statusAfterTransfer = finalStatus;
                runOnUiThreadIfAlive(() -> {
                    transferActive = false;
                    renderSendState();
                    statusText.setText(statusAfterTransfer);
                });
            }
        });
    }

    private void refreshTrustedPeers() {
        refreshTrustedPeers(null);
    }

    private void refreshTrustedPeers(String successMessage) {
        if (activityDestroyed || trustedPeersStatusText == null) return;
        trustedPeersStatusText.setText("正在刷新可信设备…");
        try {
            executor.execute(() -> {
                try {
                    List<V2TrustedPeerPersistence.TrustedPeerSummary> loaded = new ArrayList<>(
                        V2TrustedPeerPersistence.listTrustedPeers(getApplicationContext())
                    );
                    loaded.sort((left, right) -> {
                        boolean leftTrusted = "TRUSTED".equals(left.getTrustStatus().name());
                        boolean rightTrusted = "TRUSTED".equals(right.getTrustStatus().name());
                        int byTrust = Boolean.compare(rightTrusted, leftTrusted);
                        if (byTrust != 0) return byTrust;
                        int byUpdated = Long.compare(right.getUpdatedAtEpochMillis(), left.getUpdatedAtEpochMillis());
                        if (byUpdated != 0) return byUpdated;
                        return left.getDisplayName().compareToIgnoreCase(right.getDisplayName());
                    });
                    runOnUiThreadIfAlive(() -> {
                        trustedPeers = loaded;
                        renderTrustedPeers();
                        trustedPeersStatusText.setText(successMessage == null
                            ? trustedPeerCountText(loaded) : successMessage + " " + trustedPeerCountText(loaded));
                    });
                } catch (Exception error) {
                    runOnUiThreadIfAlive(() -> {
                        trustedPeersStatusText.setText("读取可信设备失败，请稍后重试。");
                        appendLog("读取可信设备失败（" + error.getClass().getSimpleName() + "）。");
                    });
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException ignored) {
            // Activity destruction can race with a user-triggered refresh. No UI callback is needed then.
        }
    }

    private void renderTrustedPeers() {
        if (trustedPeersLayout == null || activityDestroyed) return;
        trustedPeersLayout.removeAllViews();
        if (trustedPeers.isEmpty()) {
            TextView empty = text("暂无可信设备。完成协议 v2 安全配对后，设备会显示在这里。", 13, COLOR_MUTED, Typeface.NORMAL);
            empty.setPadding(dp(14), dp(14), dp(14), dp(14));
            empty.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(18), COLOR_BORDER, 1));
            trustedPeersLayout.addView(empty, matchWrap());
            return;
        }

        for (V2TrustedPeerPersistence.TrustedPeerSummary peer : trustedPeers) {
            boolean trusted = "TRUSTED".equals(peer.getTrustStatus().name());
            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.VERTICAL);
            item.setPadding(dp(14), dp(14), dp(14), dp(14));
            item.setBackground(roundedStroke(
                trusted ? COLOR_PRIMARY_SOFT : COLOR_SURFACE_TINT,
                dp(18),
                trusted ? Color.rgb(153, 246, 228) : COLOR_BORDER,
                1
            ));

            String name = displayNameOrFallback(peer.getDisplayName());
            String state = trusted ? "已信任" : "信任已移除";
            item.addView(text(name + "  ·  " + state, 15, trusted ? COLOR_TEXT : COLOR_MUTED, Typeface.BOLD), matchWrap());
            TextView details = text(
                "指纹：" + shortFingerprint(peer.getFingerprint())
                    + "\n配对时间：" + formatTrustedPeerTime(peer.getPairedAtEpochMillis())
                    + "\n最近变更：" + formatTrustedPeerTime(peer.getUpdatedAtEpochMillis())
                    + (trusted && peer.getCanTransfer() ? "\n权限：可传输文件" : ""),
                12,
                COLOR_MUTED,
                Typeface.NORMAL
            );
            details.setPadding(0, dp(6), 0, dp(10));
            item.addView(details, matchWrap());

            Button revokeButton = new Button(this);
            revokeButton.setText(trusted ? "移除信任" : "信任已移除");
            revokeButton.setAllCaps(false);
            revokeButton.setEnabled(trusted);
            styleButton(revokeButton, false);
            if (trusted) {
                revokeButton.setTextColor(COLOR_DANGER);
                revokeButton.setOnClickListener(v -> confirmRevokeTrustedPeer(peer, revokeButton));
            }
            item.addView(revokeButton, matchWrap());

            LinearLayout.LayoutParams params = matchWrap();
            params.setMargins(0, 0, 0, dp(10));
            trustedPeersLayout.addView(item, params);
        }
    }

    private void confirmRevokeTrustedPeer(
        V2TrustedPeerPersistence.TrustedPeerSummary peer,
        Button revokeButton
    ) {
        if (activityDestroyed) return;
        String name = displayNameOrFallback(peer.getDisplayName());
        new AlertDialog.Builder(this)
            .setTitle("移除设备信任？")
            .setMessage("移除对“" + name + "”的信任后，必须重新完成安全配对才能恢复。")
            .setNegativeButton("取消", null)
            .setPositiveButton("移除信任", (dialog, which) -> revokeTrustedPeer(peer, revokeButton))
            .show();
    }

    private void revokeTrustedPeer(
        V2TrustedPeerPersistence.TrustedPeerSummary peer,
        Button revokeButton
    ) {
        if (activityDestroyed) return;
        revokeButton.setEnabled(false);
        revokeButton.setText("正在移除…");
        String name = displayNameOrFallback(peer.getDisplayName());
        try {
            executor.execute(() -> {
                try {
                    boolean revoked = V2TrustedPeerPersistence.revokeTrustedPeer(
                        getApplicationContext(),
                        peer.getDeviceId()
                    );
                    runOnUiThreadIfAlive(() -> {
                        String result = revoked
                            ? "已移除对“" + name + "”的信任。"
                            : "该设备的信任状态已更新。";
                        appendLog(result);
                        refreshTrustedPeers(result);
                    });
                } catch (Exception error) {
                    runOnUiThreadIfAlive(() -> {
                        revokeButton.setEnabled(true);
                        revokeButton.setText("移除信任");
                        trustedPeersStatusText.setText("移除信任失败，请稍后重试。");
                        appendLog("移除可信设备失败（" + error.getClass().getSimpleName() + "）。");
                    });
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException ignored) {
            // Activity is already shutting down.
        }
    }

    private static String trustedPeerCountText(
        List<V2TrustedPeerPersistence.TrustedPeerSummary> peers
    ) {
        int trustedCount = 0;
        for (V2TrustedPeerPersistence.TrustedPeerSummary peer : peers) {
            if ("TRUSTED".equals(peer.getTrustStatus().name())) trustedCount += 1;
        }
        int revokedCount = peers.size() - trustedCount;
        return revokedCount == 0
            ? "共 " + trustedCount + " 台可信设备。"
            : "可信 " + trustedCount + " 台，已移除 " + revokedCount + " 台。";
    }

    private static String displayNameOrFallback(String displayName) {
        if (displayName == null || displayName.trim().isEmpty()) return "未命名设备";
        return displayName.trim();
    }

    private static String shortFingerprint(String fingerprint) {
        if (fingerprint == null || fingerprint.trim().isEmpty()) return "未知";
        String value = fingerprint.trim();
        if (value.length() <= 18) return value;
        return value.substring(0, 8) + "…" + value.substring(value.length() - 8);
    }

    private static String formatTrustedPeerTime(long epochMillis) {
        if (epochMillis <= 0L) return "未知";
        return DateFormat.getDateTimeInstance(
            DateFormat.MEDIUM,
            DateFormat.SHORT,
            Locale.getDefault()
        ).format(new Date(epochMillis));
    }

    private void runOnUiThreadIfAlive(Runnable command) {
        if (command == null || activityDestroyed) return;
        runOnUiThread(() -> {
            if (!activityDestroyed) command.run();
        });
    }

    private void renderV2Peers() {
        if (v2PeersLayout == null) return;
        if (v2PairingController != null) {
            v2Peers = v2PairingController.listPeers();
        }
        v2PeersLayout.removeAllViews();
        if (v2Peers.isEmpty()) {
            TextView empty = text("尚未发现支持协议 v2 安全配对的设备。\n请在对端也打开新版应用，然后点击刷新。", 14, COLOR_MUTED, Typeface.NORMAL);
            empty.setPadding(dp(14), dp(14), dp(14), dp(14));
            empty.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(18), COLOR_BORDER, 1));
            v2PeersLayout.addView(empty, matchWrap());
            return;
        }
        for (V2DiscoveryService.Peer peer : v2Peers) {
            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.VERTICAL);
            item.setPadding(dp(14), dp(14), dp(14), dp(14));
            item.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(18), COLOR_BORDER, 1));
            item.addView(text(peer.deviceName + "  ·  " + peer.fingerprint, 15, COLOR_TEXT, Typeface.BOLD), matchWrap());
            TextView endpoint = text(peer.host + ":" + peer.port + "\n仅在双方核对相同的六位配对码后保存信任。", 12, COLOR_MUTED, Typeface.NORMAL);
            endpoint.setPadding(0, dp(5), 0, dp(10));
            item.addView(endpoint, matchWrap());
            Button pairButton = new Button(this);
            pairButton.setText("开始安全配对");
            pairButton.setAllCaps(false);
            styleButton(pairButton, true);
            pairButton.setOnClickListener(v -> {
                v2StatusText.setText("正在连接 " + peer.deviceName + "…");
                v2PairingController.startPairing(peer);
            });
            item.addView(pairButton, matchWrap());
            LinearLayout.LayoutParams params = matchWrap();
            params.setMargins(0, 0, 0, dp(10));
            v2PeersLayout.addView(item, params);
        }
    }

    private void renderV2Sessions() {
        if (v2SessionsLayout == null) return;
        v2SessionsLayout.removeAllViews();
        List<V2PairingSessionStore.Session> sessions = v2PairingController == null
            ? new ArrayList<>() : v2PairingController.listSessions();
        if (sessions.isEmpty()) {
            v2SessionsLayout.addView(text("暂无正在进行的配对。", 13, COLOR_MUTED, Typeface.NORMAL), matchWrap());
            return;
        }
        for (V2PairingSessionStore.Session session : sessions) {
            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.VERTICAL);
            item.setPadding(dp(14), dp(14), dp(14), dp(14));
            item.setBackground(roundedStroke(COLOR_PRIMARY_SOFT, dp(18), Color.rgb(153, 246, 228), 1));
            String peerName = session.peerOffer == null ? "正在建立连接" : session.peerOffer.identity.deviceName;
            item.addView(text(peerName + " · " + pairingStatusLabel(session.status), 15, COLOR_TEXT, Typeface.BOLD), matchWrap());
            TextView code = text(session.pairingCode == null ? "等待身份验证…" : "请与对方核对配对码：" + session.pairingCode, 17, COLOR_PRIMARY_DARK, Typeface.BOLD);
            code.setPadding(0, dp(7), 0, dp(7));
            item.addView(code, matchWrap());
            if (session.status == V2PairingSessionStore.Status.AWAITING_LOCAL_CONFIRMATION) {
                Button confirm = new Button(this);
                confirm.setText("配对码相同，确认配对");
                confirm.setAllCaps(false);
                styleButton(confirm, true);
                confirm.setOnClickListener(v -> v2PairingController.confirmPairing(session.pairingId));
                item.addView(confirm, matchWrap());
            } else if (session.status == V2PairingSessionStore.Status.READY_TO_TRUST) {
                Button trust = new Button(this);
                trust.setText("保存为可信设备");
                trust.setAllCaps(false);
                styleButton(trust, true);
                trust.setOnClickListener(v -> v2PairingController.completePairing(session.pairingId));
                item.addView(trust, matchWrap());
            }
            Button cancel = new Button(this);
            cancel.setText("取消配对");
            cancel.setAllCaps(false);
            styleButton(cancel, false);
            cancel.setOnClickListener(v -> v2PairingController.cancelPairing(session.pairingId, "user-cancelled"));
            LinearLayout.LayoutParams cancelParams = matchWrap();
            cancelParams.setMargins(0, dp(8), 0, 0);
            item.addView(cancel, cancelParams);
            LinearLayout.LayoutParams params = matchWrap();
            params.setMargins(0, 0, 0, dp(10));
            v2SessionsLayout.addView(item, params);
        }
    }

    private static String pairingStatusLabel(V2PairingSessionStore.Status status) {
        if (status == V2PairingSessionStore.Status.AWAITING_REMOTE_OFFER) return "等待对端响应";
        if (status == V2PairingSessionStore.Status.AWAITING_LOCAL_CONFIRMATION) return "等待本机确认";
        if (status == V2PairingSessionStore.Status.AWAITING_REMOTE_CONFIRMATION) return "等待对端确认";
        if (status == V2PairingSessionStore.Status.READY_TO_TRUST) return "可保存信任";
        if (status == V2PairingSessionStore.Status.COMPLETED) return "已保存信任";
        if (status == V2PairingSessionStore.Status.CANCELLED) return "已取消";
        return "已过期";
    }

    private void renderPeers() {
        peersLayout.removeAllViews();
        if (peers.isEmpty()) {
            TextView empty = text("雷达正在扫描局域网...\n请确认对方设备在同一 Wi-Fi 且应用保持前台。", 14, COLOR_MUTED, Typeface.NORMAL);
            empty.setGravity(Gravity.CENTER);
            empty.setLineSpacing(dp(3), 1.0f);
            empty.setPadding(dp(18), dp(22), dp(18), dp(22));
            empty.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(22), COLOR_BORDER, 1));
            peersLayout.addView(empty, matchWrap());
            return;
        }

        for (PeerDevice peer : peers) {
            boolean selected = selectedPeer != null && selectedPeer.deviceId.equals(peer.deviceId);
            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.HORIZONTAL);
            item.setGravity(Gravity.CENTER_VERTICAL);
            item.setPadding(dp(14), dp(14), dp(14), dp(14));
            item.setClickable(true);
            item.setBackground(selected
                ? roundedStroke(COLOR_PRIMARY_SOFT, dp(22), COLOR_PRIMARY, 2)
                : roundedStroke(COLOR_SURFACE_TINT, dp(22), COLOR_BORDER, 1));

            TextView avatar = text(peer.deviceName.isEmpty() ? "?" : peer.deviceName.substring(0, 1).toUpperCase(Locale.ROOT), 18, selected ? Color.WHITE : COLOR_PRIMARY_DARK, Typeface.BOLD);
            avatar.setGravity(Gravity.CENTER);
            avatar.setBackground(rounded(selected ? COLOR_PRIMARY : COLOR_PRIMARY_SOFT, dp(18)));
            LinearLayout.LayoutParams avatarParams = new LinearLayout.LayoutParams(dp(46), dp(46));
            avatarParams.setMargins(0, 0, dp(12), 0);
            item.addView(avatar, avatarParams);

            LinearLayout content = new LinearLayout(this);
            content.setOrientation(LinearLayout.VERTICAL);
            TextView name = text((selected ? "已选择  " : "") + peer.deviceName, 16, COLOR_TEXT, Typeface.BOLD);
            TextView endpoint = text(peer.host + ":" + peer.port + "\n" + peer.fingerprint, 12, COLOR_MUTED, Typeface.NORMAL);
            endpoint.setPadding(0, dp(5), 0, 0);
            content.addView(name, matchWrap());
            content.addView(endpoint, matchWrap());
            item.addView(content, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

            TextView badge = pill(selected ? "已选" : "可用", selected ? COLOR_PRIMARY : COLOR_PRIMARY_SOFT, selected ? Color.WHITE : COLOR_PRIMARY_DARK);
            item.addView(badge, wrapContent());
            item.setOnClickListener(v -> {
                selectedPeer = peer;
                appendLog("已选择设备：" + peer.deviceName);
                renderPeers();
                renderSendState();
            });

            LinearLayout.LayoutParams params = matchWrap();
            params.setMargins(0, 0, 0, dp(10));
            peersLayout.addView(item, params);
        }
    }

    private void keepSelectedPeerOnline() {
        if (selectedPeer == null) {
            return;
        }
        for (PeerDevice peer : peers) {
            if (peer.deviceId.equals(selectedPeer.deviceId)) {
                selectedPeer = peer;
                return;
            }
        }
        selectedPeer = null;
    }

    private void renderSendState() {
        boolean canSend = selectedFile != null && selectedPeer != null && device != null;
        sendButton.setEnabled(canSend && !transferActive);
        styleButton(sendButton, true);
        if (transferActive) {
            return;
        }
        if (selectedFile == null) {
            statusText.setText("请选择文件。");
        } else if (selectedPeer == null) {
            statusText.setText("请选择附近设备。");
        } else {
            statusText.setText("已准备好，可以发送。");
        }
    }

    private void updateTransferProgress(TransferEvent event) {
        if ("system".equals(event.direction)) {
            statusText.setText(event.detail == null ? "系统事件" : event.detail);
            return;
        }

        long now = System.currentTimeMillis();
        boolean newTransfer = activeTransferId == null || !activeTransferId.equals(event.transferId);
        boolean resetState = newTransfer || "preparing".equals(event.status) || "requesting".equals(event.status) || "accepted".equals(event.status);
        transferActive = !"completed".equals(event.status) && !"failed".equals(event.status) && !"rejected".equals(event.status);
        if (resetState) {
            activeTransferId = event.transferId;
            transferStartedAt = now;
            transferLastAt = now;
            transferLastBytes = event.bytes;
            transferLastSpeed = 0;
        }

        long speed = transferLastSpeed;
        long deltaBytes = event.bytes - transferLastBytes;
        long deltaMs = now - transferLastAt;
        if (!resetState && deltaBytes >= 0 && deltaMs > 0) {
            speed = (deltaBytes * 1000L) / deltaMs;
        }
        if ("completed".equals(event.status) && now > transferStartedAt) {
            speed = (event.bytes * 1000L) / Math.max(1L, now - transferStartedAt);
        }

        transferLastAt = now;
        transferLastBytes = event.bytes;
        transferLastSpeed = speed;

        int color = COLOR_PRIMARY;
        if ("completed".equals(event.status)) {
            color = COLOR_SUCCESS;
        } else if ("failed".equals(event.status) || "rejected".equals(event.status)) {
            color = COLOR_DANGER;
        } else if ("requesting".equals(event.status) || "accepted".equals(event.status)) {
            color = COLOR_WARNING;
        }
        setProgressColor(color);

        int progress = 0;
        int percent = 0;
        if (event.total > 0) {
            progress = Math.max(0, Math.min(1000, (int) Math.round((event.bytes * 1000.0) / event.total)));
            percent = Math.max(0, Math.min(100, (int) Math.round((event.bytes * 100.0) / event.total)));
        }
        transferProgress.setProgress(progress);
        progressPercentText.setText(percent + "%");
        progressTitleText.setText(progressTitle(event));
        progressDetailText.setText(event.fileName + "\n" + progressBytes(event.bytes, event.total));

        if ("preparing".equals(event.status)) {
            progressSpeedText.setText(event.detail == null ? "正在准备" : event.detail);
        } else if ("requesting".equals(event.status)) {
            progressSpeedText.setText("等待对方确认");
        } else if ("accepted".equals(event.status)) {
            progressSpeedText.setText("已接受，等待数据");
        } else if ("completed".equals(event.status)) {
            progressSpeedText.setText("平均 " + formatRate(speed));
        } else if ("failed".equals(event.status) || "rejected".equals(event.status)) {
            progressSpeedText.setText(translateStatus(event.status));
        } else {
            progressSpeedText.setText("速率 " + formatRate(speed));
        }

        statusText.setText(progressTitle(event));
    }

    private String progressTitle(TransferEvent event) {
        String direction = "send".equals(event.direction) ? "发送" : "接收";
        return direction + " | " + translateStatus(event.status);
    }

    private String progressBytes(long bytes, long total) {
        if (total > 0) {
            return formatBytes(bytes) + " / " + formatBytes(total);
        }
        return formatBytes(bytes);
    }

    private String translateStatus(String status) {
        switch (status) {
            case "preparing": return "准备中";
            case "requesting": return "等待确认";
            case "accepted": return "已接受";
            case "rejected": return "已拒绝";
            case "sending": return "发送中";
            case "receiving": return "接收中";
            case "completed": return "已完成";
            case "failed": return "失败";
            default: return status;
        }
    }

    private void appendLog(String message) {
        while (logs.size() >= 80) {
            logs.removeFirst();
        }
        logs.addLast(message);
        StringBuilder builder = new StringBuilder();
        for (String line : logs) {
            builder.append(line).append('\n');
        }
        logText.setText(builder.toString().trim());
    }

    private void addCardHeader(LinearLayout parent, String title, String subtitle) {
        TextView label = pill("NEARBY", COLOR_PRIMARY_SOFT, COLOR_PRIMARY_DARK);
        TextView titleText = text(title, 20, COLOR_TEXT, Typeface.BOLD);
        titleText.setPadding(0, dp(10), 0, 0);
        TextView subtitleText = text(subtitle, 14, COLOR_MUTED, Typeface.NORMAL);
        subtitleText.setPadding(0, dp(5), 0, dp(16));
        parent.addView(label, wrapContent());
        parent.addView(titleText, matchWrap());
        parent.addView(subtitleText, matchWrap());
    }

    private LinearLayout card(int color) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(16), dp(16), dp(16));
        card.setBackground(rounded(color, dp(28)));
        card.setElevation(dp(4));
        return card;
    }

    private LinearLayout cardGradient(int startColor, int endColor) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(gradient(startColor, endColor, dp(30)));
        card.setElevation(dp(6));
        return card;
    }

    private LinearLayout heroMetric(String value, String label) {
        LinearLayout metric = new LinearLayout(this);
        metric.setOrientation(LinearLayout.VERTICAL);
        metric.setGravity(Gravity.CENTER);
        metric.setPadding(dp(8), dp(10), dp(8), dp(10));
        metric.setBackground(rounded(Color.rgb(219, 234, 254), dp(18)));
        TextView valueText = text(value, 16, Color.rgb(6, 95, 70), Typeface.BOLD);
        valueText.setGravity(Gravity.CENTER);
        TextView labelText = text(label, 12, Color.rgb(6, 95, 70), Typeface.BOLD);
        labelText.setGravity(Gravity.CENTER);
        labelText.setPadding(0, dp(3), 0, 0);
        metric.addView(valueText, matchWrap());
        metric.addView(labelText, matchWrap());
        return metric;
    }

    private TextView pill(String value, int background, int textColor) {
        TextView view = text(value, 13, textColor, Typeface.BOLD);
        view.setGravity(Gravity.CENTER);
        view.setPadding(dp(12), dp(7), dp(12), dp(7));
        view.setBackground(rounded(background, dp(999)));
        return view;
    }

    private TextView chip(String value) {
        TextView view = text(value, 12, COLOR_PRIMARY_DARK, Typeface.BOLD);
        view.setGravity(Gravity.CENTER);
        view.setPadding(dp(10), dp(8), dp(10), dp(8));
        view.setBackground(roundedStroke(COLOR_PRIMARY_SOFT, dp(16), Color.rgb(153, 246, 228), 1));
        return view;
    }

    private TextView text(String value, int sp, int color, int style) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        view.setTypeface(Typeface.DEFAULT, style);
        return view;
    }

    private void styleButton(Button button, boolean primary) {
        boolean enabled = button.isEnabled();
        int background = !enabled ? COLOR_DISABLED : primary ? COLOR_NAVY : COLOR_PRIMARY_SOFT;
        int textColor = primary || !enabled ? Color.WHITE : COLOR_PRIMARY_DARK;
        button.setTextColor(textColor);
        button.setBackground(rounded(background, dp(18)));
        button.setPadding(dp(14), dp(12), dp(14), dp(12));
    }

    private void setProgressColor(int color) {
        progressPercentText.setTextColor(color);
        if (Build.VERSION.SDK_INT >= 21) {
            transferProgress.setProgressTintList(ColorStateList.valueOf(color));
            transferProgress.setProgressBackgroundTintList(ColorStateList.valueOf(COLOR_BORDER));
            transferProgress.setIndeterminateTintList(ColorStateList.valueOf(color));
        }
    }

    private GradientDrawable rounded(int color, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(radius);
        return drawable;
    }

    private GradientDrawable gradient(int startColor, int endColor, int radius) {
        GradientDrawable drawable = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[] { startColor, endColor });
        drawable.setCornerRadius(radius);
        return drawable;
    }

    private GradientDrawable roundedStroke(int color, int radius, int strokeColor, int strokeDp) {
        GradientDrawable drawable = rounded(color, radius);
        drawable.setStroke(dp(strokeDp), strokeColor);
        return drawable;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
    }

    private LinearLayout.LayoutParams wrapContent() {
        return new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
    }

    private LinearLayout.LayoutParams cardParams() {
        LinearLayout.LayoutParams params = matchWrap();
        params.setMargins(0, 0, 0, dp(14));
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static String formatRate(long bytesPerSecond) {
        return formatBytes(Math.max(0, bytesPerSecond)) + "/s";
    }

    private static String formatBytes(long bytes) {
        if (bytes < 0) {
            return "未知";
        }
        String[] units = { "B", "KB", "MB", "GB", "TB" };
        double value = bytes;
        int unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit += 1;
        }
        return String.format(Locale.ROOT, unit == 0 ? "%.0f %s" : "%.1f %s", value, units[unit]);
    }
}
