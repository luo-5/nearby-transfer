package io.github.nearbytransfer.android;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
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
import android.text.TextUtils;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import io.github.nearbytransfer.android.core.data.V2TransferPeerAccess;
import io.github.nearbytransfer.android.library.WebDavClient;

import java.io.File;
import java.io.InputStream;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import android.content.BroadcastReceiver;
import android.content.IntentFilter;

public class MainActivity extends Activity {
    private static final int REQUEST_PICK_FILE = 1001;
    private static final int REQUEST_NEARBY_WIFI = 1002;
    private static final int REQUEST_SAVE_TREE = 1003;
    private static final int REQUEST_STORAGE_WRITE = 1004;
    private static final int REQUEST_UPLOAD_LIBRARY = 1005;
    private static final int TAB_TRANSFER = 0;
    private static final int TAB_DEVICES = 1;
    private static final int TAB_LIBRARIES = 2;
    private static final int TAB_SETTINGS = 3;
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
    private final BoundedLogBuffer logs = new BoundedLogBuffer(80);
    private final Object coreLifecycleLock = new Object();
    private volatile boolean activityDestroyed;
    private boolean coreStarting;
    private boolean hasPendingPairingAction;
    private boolean logFollowLatest = true;
    private int selectedTab = TAB_TRANSFER;

    private DeviceConfig device;
    private HttpTransferServer transferServer;
    private SaveTarget saveTarget;
    private DiscoveryService discoveryService;
    private V2PairingController v2PairingController;
    private V2IncomingTransferCoordinator v2IncomingCoordinator;
    private List<V2DiscoveryService.Peer> v2Peers = new ArrayList<>();
    private List<V2TrustedPeerPersistence.TrustedPeerSummary> trustedPeers = new ArrayList<>();
    private final java.util.Set<String> autoCompletedPairingIds = new java.util.HashSet<>();
    private SelectedFile selectedFile;
    private PeerDevice selectedPeer;
    private List<PeerDevice> peers = new ArrayList<>();

    private TextView deviceText;
    private TextView saveText;
    private TextView saveModeText;
    private TextView selectedFileText;
    private TextView statusText;
    private TextView logText;
    private ScrollView contentScroll;
    private ScrollView logScroll;
    private LinearLayout peersLayout;
    private LinearLayout jobsLayout;
    private LinearLayout v2PeersLayout;
    private LinearLayout v2SessionsLayout;
    private LinearLayout trustedPeersLayout;
    private LinearLayout progressCard;
    private LinearLayout localDetailsLayout;
    private LinearLayout transferSection;
    private LinearLayout devicesSection;
    private LinearLayout librariesSection;
    private LinearLayout settingsSection;
    private TextView v2StatusText;
    private TextView v2SessionTitle;
    private TextView trustedPeersStatusText;
    private TextView transferTab;
    private TextView devicesTab;
    private TextView librariesTab;
    private TextView settingsTab;
    private TextView librariesStatusText;
    private LinearLayout librariesItemsLayout;
    private Button refreshLibrariesButton;
    private Button uploadToLibraryButton;
    private String libraryCurrentSubPath = "";
    private List<WebDavClient.WebDavItem> rawLibraryItems = new ArrayList<>();
    private String librarySearchQuery = "";
    private int librarySortMode = 0; // 0: 文件夹优先+名称, 1: 最新时间, 2: 大小降序
    private LinearLayout librariesBreadcrumbLayout;
    private Button librariesBackButton;
    private Button createFolderButton;
    private android.widget.EditText librariesSearchBox;
    private Button librariesSortButton;
    private String libraryToken = null;
    private String libraryServerIp = null;
    private int libraryServerPort = 56578;
    private String libraryShareId = "default-share";
    private boolean libraryLoading = false;
    private java.util.concurrent.atomic.AtomicBoolean libraryEventsCancel = new java.util.concurrent.atomic.AtomicBoolean(false);
    private Thread libraryEventsThread = null;
    private Button localDetailsButton;
    private Button resetSaveButton;
    private Button sendButton;
    private ProgressBar transferProgress;
    private TextView progressTitleText;
    private TextView progressDetailText;
    private TextView progressSpeedText;
    private TextView progressPercentText;
    private Button cancelTransferButton;
    private Button pauseTransferButton;
    private final java.util.concurrent.atomic.AtomicBoolean currentTransferCanceled = new java.util.concurrent.atomic.AtomicBoolean(false);
    private final java.util.concurrent.atomic.AtomicBoolean currentTransferPaused = new java.util.concurrent.atomic.AtomicBoolean(false);

    private String activeTransferId;
    private long transferStartedAt;
    private long transferLastAt;
    private long transferLastBytes;
    private long transferLastSpeed;
    private boolean transferActive;

    private static final String PREF_TRANSFER_PROTOCOL = "transfer_protocol";
    static final String PREF_DEVICE_ID = "device_id";
    private static final String PROTOCOL_V2 = "v2-stream";
    private static final String PROTOCOL_TURBO = "turbo-parallel";
    private static final String PROTOCOL_QUIC = "quic-udp";
    private static final String PROTOCOL_SMB = "smb-share";
    private static final String PROTOCOL_WEBDAV = "webdav-sync";
    private static final String PROTOCOL_V1 = "v1-classic";
    private static final String PROTOCOL_FTPS = "ftps-secure";

    private String currentProtocol = PROTOCOL_V2;
    private TextView protocolBadgeText;
    private TextView protocolDescText;

    private final BroadcastReceiver transferActionReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            String taskId = intent.getStringExtra(io.github.nearbytransfer.android.service.TransferForegroundService.EXTRA_TASK_ID);
            if (io.github.nearbytransfer.android.service.TransferForegroundService.ACTION_PAUSE_TRANSFER.equals(action)) {
                if (taskId == null || taskId.isEmpty()) {
                    if (transferActive && !currentTransferPaused.get()) toggleTransferPause();
                } else {
                    executeJobTransition(taskId, "PAUSED", null, true);
                }
            } else if (io.github.nearbytransfer.android.service.TransferForegroundService.ACTION_RESUME_TRANSFER.equals(action)) {
                if (taskId == null || taskId.isEmpty()) {
                    if (transferActive && currentTransferPaused.get()) toggleTransferPause();
                } else {
                    executeJobTransition(taskId, "QUEUED", null, true);
                }
            } else if (io.github.nearbytransfer.android.service.TransferForegroundService.ACTION_CANCEL_TRANSFER.equals(action)) {
                if (taskId == null || taskId.isEmpty()) {
                    cancelActiveTransfer();
                } else {
                    executeJobTransition(taskId, "CANCELLED", null, false);
                }
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebDavClient.initPins(new File(getFilesDir(), "webdav-pins.properties"));
        currentProtocol = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(PREF_TRANSFER_PROTOCOL, PROTOCOL_V2);
        buildUi();
        restoreSelectedFile(savedInstanceState);
        refreshTrustedPeers();
        requestPermissionsThenStart();

        IntentFilter filter = new IntentFilter();
        filter.addAction(io.github.nearbytransfer.android.service.TransferForegroundService.ACTION_PAUSE_TRANSFER);
        filter.addAction(io.github.nearbytransfer.android.service.TransferForegroundService.ACTION_RESUME_TRANSFER);
        filter.addAction(io.github.nearbytransfer.android.service.TransferForegroundService.ACTION_CANCEL_TRANSFER);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(transferActionReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(transferActionReceiver, filter);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (hasRequiredCorePermissions()) {
            startCore();
        }
        if (selectedTab == TAB_LIBRARIES) {
            startLibraryEventsSubscription();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_NEARBY_WIFI) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted) {
                startCore();
            } else {
                statusText.setText(getString(R.string.permission_nearby_missing));
                appendLog(getString(R.string.permission_nearby_missing));
            }
        } else if (requestCode == REQUEST_STORAGE_WRITE) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted) {
                startCore();
            } else {
                statusText.setText(getString(R.string.permission_storage_missing));
                appendLog(getString(R.string.permission_storage_missing));
            }
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        SelectedFileState.save(outState, selectedFile);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onStop() {
        stopLibraryEventsSubscription();
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        stopLibraryEventsSubscription();
        HttpTransferServer serverToStop;
        DiscoveryService discoveryToStop;
        V2PairingController pairingToStop;
        V2IncomingTransferCoordinator coordinatorToStop;
        synchronized (coreLifecycleLock) {
            activityDestroyed = true;
            serverToStop = transferServer;
            discoveryToStop = discoveryService;
            pairingToStop = v2PairingController;
            coordinatorToStop = v2IncomingCoordinator;
            transferServer = null;
            discoveryService = null;
            v2PairingController = null;
        v2IncomingCoordinator = null;
        }
        stopCoreServices(serverToStop, discoveryToStop, pairingToStop, coordinatorToStop);
        executor.shutdownNow();
        try {
            unregisterReceiver(transferActionReceiver);
        } catch (Exception ignored) {}
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if ((requestCode != REQUEST_PICK_FILE && requestCode != REQUEST_SAVE_TREE && requestCode != REQUEST_UPLOAD_LIBRARY)
            || resultCode != RESULT_OK || data == null || data.getData() == null) {
            return;
        }

        if (requestCode == REQUEST_SAVE_TREE) {
            setCustomSaveDirectory(data);
            return;
        }

        Uri uri = data.getData();
        if (requestCode == REQUEST_UPLOAD_LIBRARY) {
            SelectedFile fileToUpload = describeUri(uri);
            uploadFileToLibrary(fileToUpload);
            return;
        }

        try {
            final int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            getContentResolver().takePersistableUriPermission(uri, flags & Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {
            // Some file providers do not grant persistable permissions; the current grant is enough for this send.
        }

        setSelectedFile(describeUri(uri), true);
    }

    private void buildUi() {
        LinearLayout screen = new LinearLayout(this);
        screen.setOrientation(LinearLayout.VERTICAL);
        screen.setBackgroundColor(COLOR_BG);

        contentScroll = new ScrollView(this);
        contentScroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(12), 0, dp(12), dp(20));
        contentScroll.addView(root, new ScrollView.LayoutParams(
            ScrollView.LayoutParams.MATCH_PARENT,
            ScrollView.LayoutParams.WRAP_CONTENT
        ));

        LinearLayout appHeader = new LinearLayout(this);
        appHeader.setOrientation(LinearLayout.VERTICAL);
        appHeader.setPadding(dp(16), dp(12), dp(16), dp(10));
        TextView title = text("Nearby Transfer", 26, COLOR_TEXT, Typeface.BOLD);
        statusText = text(getString(R.string.status_starting), 13, COLOR_MUTED, Typeface.NORMAL);
        statusText.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        statusText.setPadding(dp(12), dp(9), dp(12), dp(9));
        statusText.setBackground(roundedStroke(COLOR_SURFACE, dp(8), COLOR_BORDER, 1));
        statusText.setMinHeight(dp(48));
        statusText.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams statusParams = matchWrap();
        statusParams.setMargins(0, dp(8), 0, 0);
        appHeader.addView(title, matchWrap());
        appHeader.addView(statusText, statusParams);
        screen.addView(appHeader, matchWrap());

        LinearLayout navigation = new LinearLayout(this);
        navigation.setOrientation(LinearLayout.HORIZONTAL);
        navigation.setPadding(dp(4), dp(4), dp(4), dp(4));
        navigation.setBackground(roundedStroke(COLOR_SURFACE, dp(8), COLOR_BORDER, 1));
        transferTab = navigationTab(getString(R.string.tab_transfer), TAB_TRANSFER);
        devicesTab = navigationTab(getString(R.string.tab_devices), TAB_DEVICES);
        librariesTab = navigationTab(getString(R.string.nav_libraries), TAB_LIBRARIES);
        settingsTab = navigationTab(getString(R.string.tab_settings), TAB_SETTINGS);
        navigation.addView(transferTab, new LinearLayout.LayoutParams(0, dp(48), 1));
        LinearLayout.LayoutParams devicesTabParams = new LinearLayout.LayoutParams(0, dp(48), 1);
        devicesTabParams.setMargins(dp(4), 0, dp(4), 0);
        navigation.addView(devicesTab, devicesTabParams);
        LinearLayout.LayoutParams librariesTabParams = new LinearLayout.LayoutParams(0, dp(48), 1);
        librariesTabParams.setMargins(0, 0, dp(4), 0);
        navigation.addView(librariesTab, librariesTabParams);
        navigation.addView(settingsTab, new LinearLayout.LayoutParams(0, dp(48), 1));
        LinearLayout.LayoutParams navigationParams = matchWrap();
        navigationParams.setMargins(dp(12), 0, dp(12), dp(10));
        screen.addView(navigation, navigationParams);
        screen.addView(contentScroll, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1
        ));

        transferSection = new LinearLayout(this);
        transferSection.setOrientation(LinearLayout.VERTICAL);
        devicesSection = new LinearLayout(this);
        devicesSection.setOrientation(LinearLayout.VERTICAL);
        librariesSection = new LinearLayout(this);
        librariesSection.setOrientation(LinearLayout.VERTICAL);
        settingsSection = new LinearLayout(this);
        settingsSection.setOrientation(LinearLayout.VERTICAL);
        root.addView(transferSection, matchWrap());
        root.addView(devicesSection, matchWrap());
        root.addView(librariesSection, matchWrap());
        root.addView(settingsSection, matchWrap());

        // --- 传输板块 ---
        LinearLayout fileCard = card(COLOR_SURFACE);
        addSectionTitle(fileCard, getString(R.string.section_send_file));
        Button chooseButton = new Button(this);
        chooseButton.setText(getString(R.string.btn_choose_file));
        chooseButton.setContentDescription(getString(R.string.btn_choose_file));
        chooseButton.setAllCaps(false);
        chooseButton.setMinHeight(dp(48));
        styleButton(chooseButton, false);
        chooseButton.setOnClickListener(v -> chooseFile());
        fileCard.addView(chooseButton, matchWrap());

        selectedFileText = text(getString(R.string.no_file_selected), 15, COLOR_TEXT, Typeface.NORMAL);
        selectedFileText.setMaxLines(2);
        selectedFileText.setEllipsize(TextUtils.TruncateAt.END);
        selectedFileText.setPadding(dp(12), dp(10), dp(12), dp(10));
        selectedFileText.setMinHeight(dp(48));
        selectedFileText.setGravity(Gravity.CENTER_VERTICAL);
        selectedFileText.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(8), COLOR_BORDER, 1));
        LinearLayout.LayoutParams selectedFileParams = matchWrap();
        selectedFileParams.setMargins(0, dp(12), 0, dp(12));
        fileCard.addView(selectedFileText, selectedFileParams);

        sendButton = new Button(this);
        sendButton.setText(getString(R.string.btn_send_to_peer));
        sendButton.setContentDescription(getString(R.string.btn_send_to_peer));
        sendButton.setAllCaps(false);
        sendButton.setEnabled(false);
        sendButton.setMinHeight(dp(48));
        styleButton(sendButton, true);
        sendButton.setOnClickListener(v -> sendSelectedFile());
        // fileCard is added after peerCard below so the device list renders first.

        progressCard = card(COLOR_SURFACE);
        addSectionTitle(progressCard, getString(R.string.section_transfer_progress));

        LinearLayout progressHeader = new LinearLayout(this);
        progressHeader.setOrientation(LinearLayout.HORIZONTAL);
        progressHeader.setGravity(Gravity.CENTER_VERTICAL);
        progressTitleText = text(getString(R.string.no_active_transfer), 17, COLOR_TEXT, Typeface.BOLD);
        progressTitleText.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
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

        progressDetailText = text(getString(R.string.transfer_waiting), 14, COLOR_MUTED, Typeface.NORMAL);
        progressDetailText.setPadding(dp(12), dp(10), dp(12), dp(10));
        progressDetailText.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(8), COLOR_BORDER, 1));
        progressSpeedText = pill(getString(R.string.transfer_speed_format, "-"), COLOR_PRIMARY_SOFT, COLOR_PRIMARY_DARK);
        progressCard.addView(progressDetailText, matchWrap());
        LinearLayout.LayoutParams speedParams = wrapContent();
        speedParams.setMargins(0, dp(10), 0, 0);
        progressCard.addView(progressSpeedText, speedParams);

        LinearLayout progressControlsLayout = new LinearLayout(this);
        progressControlsLayout.setOrientation(LinearLayout.HORIZONTAL);
        progressControlsLayout.setGravity(Gravity.END);
        LinearLayout.LayoutParams progressControlsParams = matchWrap();
        progressControlsParams.setMargins(0, dp(10), 0, 0);

        pauseTransferButton = new Button(this);
        pauseTransferButton.setText(getString(R.string.btn_pause_transfer));
        pauseTransferButton.setAllCaps(false);
        pauseTransferButton.setMinHeight(dp(40));
        styleButton(pauseTransferButton, false);
        pauseTransferButton.setOnClickListener(v -> toggleTransferPause());

        cancelTransferButton = new Button(this);
        cancelTransferButton.setText(getString(R.string.btn_cancel_transfer));
        cancelTransferButton.setAllCaps(false);
        cancelTransferButton.setMinHeight(dp(40));
        styleButton(cancelTransferButton, false);
        cancelTransferButton.setOnClickListener(v -> cancelActiveTransfer());

        LinearLayout.LayoutParams cancelBtnParams = wrapContent();
        cancelBtnParams.setMargins(dp(8), 0, 0, 0);
        progressControlsLayout.addView(pauseTransferButton, wrapContent());
        progressControlsLayout.addView(cancelTransferButton, cancelBtnParams);
        progressCard.addView(progressControlsLayout, progressControlsParams);
        progressCard.setVisibility(View.GONE);

        LinearLayout peerCard = card(COLOR_SURFACE);
        addSectionTitle(peerCard, getString(R.string.section_nearby_peers));
        Button refreshButton = new Button(this);
        refreshButton.setText(getString(R.string.btn_refresh_peers));
        refreshButton.setContentDescription(getString(R.string.btn_refresh_peers));
        refreshButton.setAllCaps(false);
        refreshButton.setMinHeight(dp(48));
        styleButton(refreshButton, false);
        refreshButton.setOnClickListener(v -> {
            if (discoveryService != null) {
                appendLog(getString(R.string.searching_peers));
                statusText.setText(getString(R.string.searching_peers));
                discoveryService.announce();
                peersLayout.postDelayed(() -> {
                    peers = discoveryService.listPeers();
                    renderPeers();
                    if (!transferActive) {
                        statusText.setText(peers.isEmpty()
                            ? getString(R.string.no_peers_found)
                            : getString(R.string.peers_found_format, peers.size()));
                    }
                }, 2500);
            } else {
                statusText.setText(getString(R.string.status_starting));
                requestPermissionsThenStart();
            }
        });
        peerCard.addView(refreshButton, matchWrap());
        peersLayout = new LinearLayout(this);
        peersLayout.setOrientation(LinearLayout.VERTICAL);
        peersLayout.setPadding(0, dp(10), 0, 0);
        peerCard.addView(peersLayout, matchWrap());
        LinearLayout.LayoutParams sendButtonParams = matchWrap();
        sendButtonParams.setMargins(0, dp(8), 0, 0);
        peerCard.addView(sendButton, sendButtonParams);
        transferSection.addView(peerCard, cardParams());
        transferSection.addView(fileCard, cardParams());
        transferSection.addView(progressCard, cardParams());

        LinearLayout jobsCard = card(COLOR_SURFACE);
        addSectionTitle(jobsCard, "持久化传输任务 (Transfer Jobs)");
        Button refreshJobsButton = new Button(this);
        refreshJobsButton.setText("刷新任务列表");
        refreshJobsButton.setAllCaps(false);
        refreshJobsButton.setMinHeight(dp(48));
        styleButton(refreshJobsButton, false);
        refreshJobsButton.setOnClickListener(v -> refreshTransferJobsList());
        jobsCard.addView(refreshJobsButton, matchWrap());
        
        jobsLayout = new LinearLayout(this);
        jobsLayout.setOrientation(LinearLayout.VERTICAL);
        jobsLayout.setPadding(0, dp(10), 0, 0);
        jobsCard.addView(jobsLayout, matchWrap());
        transferSection.addView(jobsCard, cardParams());

        // --- 设备与配对板块 ---
        LinearLayout v2Card = card(COLOR_SURFACE);
        addSectionTitle(v2Card, getString(R.string.section_security_pairing));
        v2StatusText = text(getString(R.string.v2_starting), 14, COLOR_MUTED, Typeface.NORMAL);
        v2StatusText.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        v2StatusText.setPadding(dp(12), dp(10), dp(12), dp(10));
        v2StatusText.setMinHeight(dp(48));
        v2StatusText.setGravity(Gravity.CENTER_VERTICAL);
        v2StatusText.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(8), COLOR_BORDER, 1));
        v2Card.addView(v2StatusText, matchWrap());
        Button v2RefreshButton = new Button(this);
        v2RefreshButton.setText(getString(R.string.btn_refresh_v2));
        v2RefreshButton.setContentDescription(getString(R.string.btn_refresh_v2));
        v2RefreshButton.setAllCaps(false);
        v2RefreshButton.setMinHeight(dp(48));
        styleButton(v2RefreshButton, false);
        v2RefreshButton.setOnClickListener(v -> {
            if (v2PairingController != null) {
                v2StatusText.setText(getString(R.string.v2_announcing));
                v2PairingController.announceNow();
                v2PeersLayout.postDelayed(this::renderV2Peers, 2500);
                refreshTrustedPeers();
            } else {
                v2StatusText.setText(getString(R.string.status_starting));
                requestPermissionsThenStart();
            }
        });
        LinearLayout.LayoutParams v2RefreshParams = matchWrap();
        v2RefreshParams.setMargins(0, dp(10), 0, 0);
        v2Card.addView(v2RefreshButton, v2RefreshParams);
        v2PeersLayout = new LinearLayout(this);
        v2PeersLayout.setOrientation(LinearLayout.VERTICAL);
        v2PeersLayout.setPadding(0, dp(10), 0, 0);
        v2PeersLayout.setVisibility(View.GONE);
        v2Card.addView(v2PeersLayout, matchWrap());
        v2SessionTitle = text(getString(R.string.title_active_pairing), 15, COLOR_TEXT, Typeface.BOLD);
        LinearLayout.LayoutParams v2SessionTitleParams = matchWrap();
        v2SessionTitleParams.setMargins(0, dp(14), 0, 0);
        v2Card.addView(v2SessionTitle, v2SessionTitleParams);
        v2SessionsLayout = new LinearLayout(this);
        v2SessionsLayout.setOrientation(LinearLayout.VERTICAL);
        v2SessionsLayout.setPadding(0, dp(8), 0, 0);
        v2SessionsLayout.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        v2Card.addView(v2SessionsLayout, matchWrap());
        v2SessionTitle.setVisibility(View.GONE);
        v2SessionsLayout.setVisibility(View.GONE);

        TextView trustedPeersTitle = text(getString(R.string.title_trusted_devices), 15, COLOR_TEXT, Typeface.BOLD);
        LinearLayout.LayoutParams trustedPeersTitleParams = matchWrap();
        trustedPeersTitleParams.setMargins(0, dp(14), 0, 0);
        v2Card.addView(trustedPeersTitle, trustedPeersTitleParams);
        trustedPeersStatusText = text(getString(R.string.trusted_devices_reading), 13, COLOR_MUTED, Typeface.NORMAL);
        trustedPeersStatusText.setPadding(0, dp(6), 0, 0);
        v2Card.addView(trustedPeersStatusText, matchWrap());
        trustedPeersLayout = new LinearLayout(this);
        trustedPeersLayout.setOrientation(LinearLayout.VERTICAL);
        trustedPeersLayout.setPadding(0, dp(8), 0, 0);
        v2Card.addView(trustedPeersLayout, matchWrap());
        devicesSection.addView(v2Card, cardParams());

        // --- 文件库板块 (NAS / WebDAV) ---
        LinearLayout librariesCard = card(COLOR_SURFACE);
        addSectionTitle(librariesCard, getString(R.string.section_shared_libraries));

        librariesStatusText = text(getString(R.string.library_connecting), 13, COLOR_MUTED, Typeface.NORMAL);
        librariesStatusText.setPadding(0, 0, 0, dp(8));
        librariesCard.addView(librariesStatusText, matchWrap());

        // 面包屑导航与返回上一级栏
        LinearLayout breadcrumbRow = new LinearLayout(this);
        breadcrumbRow.setOrientation(LinearLayout.HORIZONTAL);
        breadcrumbRow.setGravity(Gravity.CENTER_VERTICAL);
        breadcrumbRow.setPadding(0, 0, 0, dp(8));

        librariesBackButton = new Button(this);
        librariesBackButton.setText(getString(R.string.btn_back_parent));
        librariesBackButton.setContentDescription(getString(R.string.btn_back_parent_desc));
        librariesBackButton.setAllCaps(false);
        librariesBackButton.setTextSize(12);
        styleButton(librariesBackButton, false);
        librariesBackButton.setVisibility(View.GONE);
        librariesBackButton.setOnClickListener(v -> navigateToParentDirectory());
        breadcrumbRow.addView(librariesBackButton, wrapContent());

        android.widget.HorizontalScrollView breadcrumbScroll = new android.widget.HorizontalScrollView(this);
        breadcrumbScroll.setHorizontalScrollBarEnabled(false);
        librariesBreadcrumbLayout = new LinearLayout(this);
        librariesBreadcrumbLayout.setOrientation(LinearLayout.HORIZONTAL);
        librariesBreadcrumbLayout.setGravity(Gravity.CENTER_VERTICAL);
        librariesBreadcrumbLayout.setPadding(dp(6), 0, dp(6), 0);
        breadcrumbScroll.addView(librariesBreadcrumbLayout, wrapContent());
        breadcrumbRow.addView(breadcrumbScroll, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        librariesCard.addView(breadcrumbRow, matchWrap());

        // 搜索与排序工具栏
        LinearLayout searchSortRow = new LinearLayout(this);
        searchSortRow.setOrientation(LinearLayout.HORIZONTAL);
        searchSortRow.setGravity(Gravity.CENTER_VERTICAL);
        searchSortRow.setPadding(0, 0, 0, dp(8));

        librariesSearchBox = new android.widget.EditText(this);
        librariesSearchBox.setHint(getString(R.string.search_library_hint));
        librariesSearchBox.setTextSize(13);
        librariesSearchBox.setTextColor(COLOR_TEXT);
        librariesSearchBox.setHintTextColor(COLOR_MUTED);
        librariesSearchBox.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(6), COLOR_BORDER, 1));
        librariesSearchBox.setPadding(dp(10), dp(8), dp(10), dp(8));
        librariesSearchBox.setSingleLine(true);
        librariesSearchBox.addTextChangedListener(new android.text.TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                librarySearchQuery = s != null ? s.toString().trim() : "";
                applyFilterAndRender();
            }
            @Override
            public void afterTextChanged(android.text.Editable s) {}
        });
        searchSortRow.addView(librariesSearchBox, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

        librariesSortButton = new Button(this);
        librariesSortButton.setText(getString(R.string.sort_default));
        librariesSortButton.setContentDescription(getString(R.string.sort_default));
        librariesSortButton.setAllCaps(false);
        librariesSortButton.setTextSize(12);
        styleButton(librariesSortButton, false);
        librariesSortButton.setOnClickListener(v -> cycleSortMode());
        LinearLayout.LayoutParams sortParams = wrapContent();
        sortParams.setMargins(dp(6), 0, 0, 0);
        searchSortRow.addView(librariesSortButton, sortParams);
        librariesCard.addView(searchSortRow, matchWrap());

        // 操作按钮行 (刷新、新建文件夹、上传)
        LinearLayout libButtonsHeader = new LinearLayout(this);
        libButtonsHeader.setOrientation(LinearLayout.HORIZONTAL);
        libButtonsHeader.setPadding(0, 0, 0, dp(10));

        refreshLibrariesButton = new Button(this);
        refreshLibrariesButton.setText(getString(R.string.btn_refresh));
        refreshLibrariesButton.setContentDescription(getString(R.string.btn_refresh_desc));
        refreshLibrariesButton.setAllCaps(false);
        refreshLibrariesButton.setMinHeight(dp(44));
        styleButton(refreshLibrariesButton, false);
        refreshLibrariesButton.setOnClickListener(v -> refreshLibrariesList(true));
        libButtonsHeader.addView(refreshLibrariesButton, new LinearLayout.LayoutParams(0, dp(44), 1));

        createFolderButton = new Button(this);
        createFolderButton.setText(getString(R.string.btn_create_folder));
        createFolderButton.setContentDescription(getString(R.string.btn_create_folder_desc));
        createFolderButton.setAllCaps(false);
        createFolderButton.setMinHeight(dp(44));
        styleButton(createFolderButton, false);
        createFolderButton.setOnClickListener(v -> promptCreateFolder());
        LinearLayout.LayoutParams createFolderParams = new LinearLayout.LayoutParams(0, dp(44), 1.2f);
        createFolderParams.setMargins(dp(6), 0, dp(6), 0);
        libButtonsHeader.addView(createFolderButton, createFolderParams);

        uploadToLibraryButton = new Button(this);
        uploadToLibraryButton.setText(getString(R.string.btn_upload_file));
        uploadToLibraryButton.setContentDescription(getString(R.string.btn_upload_file_desc));
        uploadToLibraryButton.setAllCaps(false);
        uploadToLibraryButton.setMinHeight(dp(44));
        styleButton(uploadToLibraryButton, true);
        uploadToLibraryButton.setOnClickListener(v -> chooseFileForUpload());
        libButtonsHeader.addView(uploadToLibraryButton, new LinearLayout.LayoutParams(0, dp(44), 1.1f));
        librariesCard.addView(libButtonsHeader, matchWrap());

        librariesItemsLayout = new LinearLayout(this);
        librariesItemsLayout.setOrientation(LinearLayout.VERTICAL);
        TextView emptyLibrariesText = text(getString(R.string.empty_library_hint), 13, COLOR_MUTED, Typeface.NORMAL);
        emptyLibrariesText.setGravity(Gravity.CENTER);
        emptyLibrariesText.setPadding(dp(16), dp(20), dp(16), dp(20));
        emptyLibrariesText.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(8), COLOR_BORDER, 1));
        librariesItemsLayout.addView(emptyLibrariesText, matchWrap());
        librariesCard.addView(librariesItemsLayout, matchWrap());

        librariesSection.addView(librariesCard, cardParams());

        // --- 设置板块 ---
        LinearLayout localCard = card(COLOR_SURFACE);
        addSectionTitle(localCard, getString(R.string.section_local_identity));
        localDetailsButton = new Button(this);
        localDetailsButton.setText(getString(R.string.btn_expand_settings));
        localDetailsButton.setContentDescription(getString(R.string.btn_expand_settings));
        localDetailsButton.setAllCaps(false);
        localDetailsButton.setMinHeight(dp(48));
        styleButton(localDetailsButton, false);
        localDetailsButton.setOnClickListener(v -> toggleLocalDetails());
        localCard.addView(localDetailsButton, matchWrap());
        localDetailsLayout = new LinearLayout(this);
        localDetailsLayout.setOrientation(LinearLayout.VERTICAL);
        localDetailsLayout.setVisibility(View.GONE);
        deviceText = text(getString(R.string.device_generating_keys), 14, COLOR_TEXT, Typeface.NORMAL);
        deviceText.setPadding(dp(12), dp(10), dp(12), dp(10));
        deviceText.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(8), COLOR_BORDER, 1));
        saveText = text(getString(R.string.save_location_format, "-"), 14, COLOR_MUTED, Typeface.NORMAL);
        saveText.setPadding(dp(12), dp(10), dp(12), dp(10));
        saveText.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(8), COLOR_BORDER, 1));
        saveModeText = pill(getString(R.string.save_mode_format, "-"), COLOR_PRIMARY_SOFT, COLOR_PRIMARY_DARK);
        Button changeSaveButton = new Button(this);
        changeSaveButton.setText(getString(R.string.btn_change_save_dir));
        changeSaveButton.setContentDescription(getString(R.string.btn_change_save_dir));
        changeSaveButton.setAllCaps(false);
        changeSaveButton.setMinHeight(dp(48));
        styleButton(changeSaveButton, false);
        changeSaveButton.setOnClickListener(v -> chooseSaveDirectory());
        resetSaveButton = new Button(this);
        resetSaveButton.setText(getString(R.string.btn_reset_save_dir));
        resetSaveButton.setContentDescription(getString(R.string.btn_reset_save_dir));
        resetSaveButton.setAllCaps(false);
        resetSaveButton.setMinHeight(dp(48));
        resetSaveButton.setVisibility(View.GONE);
        styleButton(resetSaveButton, false);
        resetSaveButton.setOnClickListener(v -> resetSaveDirectory());
        LinearLayout.LayoutParams deviceParams = matchWrap();
        deviceParams.setMargins(0, dp(10), 0, 0);
        localDetailsLayout.addView(deviceText, deviceParams);
        LinearLayout.LayoutParams saveTextParams = matchWrap();
        saveTextParams.setMargins(0, dp(10), 0, dp(10));
        localDetailsLayout.addView(saveText, saveTextParams);
        localDetailsLayout.addView(saveModeText, wrapContent());
        LinearLayout.LayoutParams changeSaveParams = matchWrap();
        changeSaveParams.setMargins(0, dp(12), 0, 0);
        localDetailsLayout.addView(changeSaveButton, changeSaveParams);
        LinearLayout.LayoutParams resetSaveParams = matchWrap();
        resetSaveParams.setMargins(0, dp(10), 0, 0);
        localDetailsLayout.addView(resetSaveButton, resetSaveParams);
        localCard.addView(localDetailsLayout, matchWrap());
        settingsSection.addView(localCard, cardParams());

        // --- 传输协议设置板块 ---
        LinearLayout protocolCard = card(COLOR_SURFACE);
        addSectionTitle(protocolCard, getString(R.string.action_select_protocol));
        protocolBadgeText = pill(getProtocolDisplayName(currentProtocol), COLOR_PRIMARY_SOFT, COLOR_PRIMARY_DARK);
        protocolDescText = text(getProtocolSummary(currentProtocol), 13, COLOR_MUTED, Typeface.NORMAL);
        protocolDescText.setPadding(dp(12), dp(10), dp(12), dp(10));
        protocolDescText.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(8), COLOR_BORDER, 1));
        
        Button selectProtocolButton = new Button(this);
        selectProtocolButton.setText(getString(R.string.dialog_select_protocol_title));
        selectProtocolButton.setContentDescription(getString(R.string.dialog_select_protocol_title));
        selectProtocolButton.setAllCaps(false);
        selectProtocolButton.setMinHeight(dp(48));
        styleButton(selectProtocolButton, false);
        selectProtocolButton.setOnClickListener(v -> showProtocolSelectionDialog());
        
        protocolCard.addView(protocolBadgeText, wrapContent());
        LinearLayout.LayoutParams protoDescParams = matchWrap();
        protoDescParams.setMargins(0, dp(10), 0, dp(12));
        protocolCard.addView(protocolDescText, protoDescParams);
        protocolCard.addView(selectProtocolButton, matchWrap());
        settingsSection.addView(protocolCard, cardParams());

        // --- 诊断日志板块 ---
        LinearLayout logCard = card(COLOR_SURFACE);
        LinearLayout logHeader = new LinearLayout(this);
        logHeader.setOrientation(LinearLayout.HORIZONTAL);
        logHeader.setGravity(Gravity.CENTER_VERTICAL);
        TextView logTitle = text(getString(R.string.section_diagnostics_log), 18, COLOR_TEXT, Typeface.BOLD);
        logHeader.addView(logTitle, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

        Button copyLogButton = new Button(this);
        copyLogButton.setText(getString(R.string.btn_copy_log));
        copyLogButton.setContentDescription(getString(R.string.btn_copy_log));
        copyLogButton.setAllCaps(false);
        copyLogButton.setMinHeight(dp(48));
        styleButton(copyLogButton, false);
        copyLogButton.setOnClickListener(v -> copyLogToClipboard());

        Button clearLogButton = new Button(this);
        clearLogButton.setText(getString(R.string.btn_clear_log));
        clearLogButton.setContentDescription(getString(R.string.btn_clear_log));
        clearLogButton.setAllCaps(false);
        clearLogButton.setMinHeight(dp(48));
        styleButton(clearLogButton, false);
        clearLogButton.setOnClickListener(v -> clearLogs());

        logHeader.addView(copyLogButton, wrapContent());
        LinearLayout.LayoutParams clearParams = wrapContent();
        clearParams.setMargins(dp(6), 0, 0, 0);
        logHeader.addView(clearLogButton, clearParams);
        logCard.addView(logHeader, matchWrap());

        logScroll = new ScrollView(this);
        logScroll.setFillViewport(true);
        logScroll.setNestedScrollingEnabled(true);
        logScroll.setOnScrollChangeListener((view, scrollX, scrollY, oldScrollX, oldScrollY) ->
            logFollowLatest = isLogScrolledToBottom()
        );
        logScroll.setBackground(roundedStroke(Color.rgb(15, 23, 42), dp(8), Color.rgb(30, 41, 59), 1));
        logText = text(getString(R.string.no_logs), 13, COLOR_MUTED, Typeface.NORMAL);
        logText.setTextIsSelectable(true);
        logText.setLineSpacing(dp(2), 1.0f);
        logText.setPadding(dp(12), dp(10), dp(12), dp(10));
        logText.setTextColor(Color.rgb(203, 213, 225));
        logScroll.addView(logText, new ScrollView.LayoutParams(
            ScrollView.LayoutParams.MATCH_PARENT,
            ScrollView.LayoutParams.WRAP_CONTENT
        ));
        LinearLayout.LayoutParams logScrollParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(168)
        );
        logScrollParams.setMargins(0, dp(10), 0, 0);
        logCard.addView(logScroll, logScrollParams);
        settingsSection.addView(logCard, cardParams());

        setContentView(screen);
        selectTab(TAB_TRANSFER);
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

    private boolean hasRequiredCorePermissions() {
        return true;
    }

    private void startCore() {
        Log.i("MainActivity", "startCore() requested");
        synchronized (coreLifecycleLock) {
            if (activityDestroyed || coreStarting || transferServer != null) {
                Log.i("MainActivity", "startCore() skipped: destroyed=" + activityDestroyed + ", starting=" + coreStarting + ", server=" + (transferServer != null));
                return;
            }
            coreStarting = true;
        }
        try {
            executor.execute(this::startCoreInBackground);
        } catch (RejectedExecutionException rejected) {
            Log.e("MainActivity", "startCore() executor rejected", rejected);
            synchronized (coreLifecycleLock) {
                coreStarting = false;
            }
        }
    }

    private void startCoreInBackground() {
        Log.i("MainActivity", "startCoreInBackground() running on thread " + Thread.currentThread().getName());
        DeviceConfig localDevice = null;
        SaveTarget localSaveTarget = null;
        HttpTransferServer localServer = null;
        DiscoveryService localDiscovery = null;
        V2PairingController localPairing = null;
        V2IncomingTransferCoordinator localCoordinator = null;
        boolean installed = false;
        try {
            if (!canContinueCoreStart()) {
                Log.w("MainActivity", "startCoreInBackground: cannot continue core start");
                return;
            }
            localDevice = DeviceConfig.loadOrCreate(this);
            localSaveTarget = loadSaveTarget();
            Log.i("MainActivity", "Device loaded: " + localDevice.deviceId + " (" + localDevice.deviceName + ")");

            HttpTransferServer candidateServer = new HttpTransferServer(
                localDevice,
                localSaveTarget,
                this::confirmIncomingTransfer,
                this::onTransferEvent
            );
            localServer = candidateServer;
            int port = candidateServer.start(0);
            Log.i("MainActivity", "HttpTransferServer started on port " + port);
            if (!canContinueCoreStart()) {
                return;
            }

            DiscoveryService candidateDiscovery = new DiscoveryService(this, localDevice, port, updatedPeers -> runOnUiThreadIfAlive(() -> {
                peers = updatedPeers;
                keepSelectedPeerOnline();
                renderPeers();
                renderSendState();
            }), error -> runOnUiThreadIfAlive(() -> appendLog("发现失败：" + error.getMessage())), message -> runOnUiThreadIfAlive(() -> appendLog(message)));
            localDiscovery = candidateDiscovery;
            candidateDiscovery.start();
            Log.i("MainActivity", "DiscoveryService started");
            if (!canContinueCoreStart()) {
                return;
            }

            DeviceConfig pairingDevice = localDevice;
            try {
                V2IncomingTransferCoordinator candidateCoordinator = V2IncomingTransferCoordinator.create(
                    this,
                    localDevice,
                    request -> CompletableFuture.completedFuture(V2IncomingTransferCoordinator.Approval.ACCEPT),
                    new V2IncomingTransferCoordinator.RuntimeHandler() {
                        @Override
                        public V2IncomingTransferCoordinator.PreparedRuntime prepare(
                            V2TransferBootstrap.VerifiedManifest manifest,
                            V2TransferPeerAccess.AuthorizedPeer peer
                        ) throws Exception {
                            String customTree = getCustomSaveTreeUriString();
                            V2IncomingTransferRuntime runtime = V2IncomingTransferRuntime.prepare(
                                MainActivity.this,
                                pairingDevice,
                                manifest,
                                peer,
                                customTree,
                                new V2IncomingTransferRuntime.TransferEventListener() {
                                    @Override
                                    public void onTransferProgress(String taskId, long bytesTransferred, long totalBytes) {
                                        runOnUiThreadIfAlive(() -> updateV2ProgressUi(taskId, bytesTransferred, totalBytes));
                                    }

                                    @Override
                                    public void onTransferCompleted(String taskId) {
                                        runOnUiThreadIfAlive(() -> showV2TransferCompletedUi(taskId));
                                    }

                                    @Override
                                    public void onTransferFailed(String taskId, String reason) {
                                        runOnUiThreadIfAlive(() -> showV2TransferFailedUi(taskId, reason));
                                    }
                                }
                            );
                            return new V2IncomingTransferCoordinator.PreparedRuntime() {
                                @Override
                                public V2WireFrame.Frame createResumeFrame() throws Exception {
                                    return runtime.createResumeFrame();
                                }

                                @Override
                                public void start(java.net.Socket socket) throws Exception {
                                    runtime.start(socket);
                                }

                                @Override
                                public void close() {
                                    runtime.close();
                                }
                            };
                        }
                    }
                );
                localCoordinator = candidateCoordinator;

                V2PairingController candidatePairing = new V2PairingController(
                    this, localDevice, candidateCoordinator,
                    new V2PairingController.Listener() {
                        @Override public void onPeersChanged(List<V2DiscoveryService.Peer> updatedPeers) {
                            v2Peers = updatedPeers;
                            renderV2Peers();
                        }

                        @Override public void onSessionChanged(V2PairingSessionStore.Session session) {
                            renderV2Sessions();
                            if (session.status == V2PairingSessionStore.Status.AWAITING_LOCAL_CONFIRMATION
                                || session.status == V2PairingSessionStore.Status.READY_TO_TRUST) {
                                setPendingPairingAction(true);
                            }
                            appendLog("协议 v2 配对状态：" + pairingStatusLabel(session.status));
                            if (session.status == V2PairingSessionStore.Status.READY_TO_TRUST) {
                                v2StatusText.setText("双方已确认配对码，正在自动保存信任...");
                                if (selectedTab != TAB_DEVICES) {
                                    statusText.setText("安全配对待确认，请打开“设备”页。");
                                }
                                if (v2PairingController != null
                                    && autoCompletedPairingIds.add(session.pairingId)) {
                                    v2PairingController.completePairing(session.pairingId);
                                }
                            } else if (session.status == V2PairingSessionStore.Status.AWAITING_LOCAL_CONFIRMATION
                                && selectedTab != TAB_DEVICES) {
                                statusText.setText("收到安全配对请求，请打开“设备”页确认。");
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
                localPairing = candidatePairing;
                candidatePairing.start();
            } catch (Exception v2Error) {
                if (localPairing != null) {
                    localPairing.close();
                    localPairing = null;
                }
                if (localCoordinator != null) {
                    localCoordinator.close();
                    localCoordinator = null;
                }
                Exception reportedV2Error = v2Error;
                runOnUiThreadIfAlive(() -> appendLog("协议 v2 安全配对未启动：" + reportedV2Error));
            }

            if (!canContinueCoreStart()) {
                return;
            }
            synchronized (coreLifecycleLock) {
                if (!activityDestroyed && !Thread.currentThread().isInterrupted()) {
                    device = localDevice;
                    if (localDevice != null && localDevice.deviceId != null) {
                        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                            .edit()
                            .putString(PREF_DEVICE_ID, localDevice.deviceId)
                            .apply();
                    }
                    saveTarget = localSaveTarget;
                    transferServer = localServer;
                    discoveryService = localDiscovery;
                    v2PairingController = localPairing;
                    v2IncomingCoordinator = localCoordinator;
                    installed = true;
                }
            }
            if (!installed) {
                return;
            }

            DeviceConfig startedDevice = localDevice;
            runOnUiThreadIfAlive(() -> {
                deviceText.setText("名称：" + startedDevice.deviceName + "\n指纹：" + startedDevice.fingerprint + "\n端口：" + port);
                renderSaveTarget();
                statusText.setText("已启动，正在搜索附近设备。");
                appendLog("Android 客户端已启动，端口 " + port);
            });
        } catch (Exception error) {
            if (canContinueCoreStart()) {
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
        } finally {
            if (!installed) {
                stopCoreServices(localServer, localDiscovery, localPairing, localCoordinator);
            }
            synchronized (coreLifecycleLock) {
                coreStarting = false;
            }
        }
    }

    private boolean canContinueCoreStart() {
        return !activityDestroyed && !Thread.currentThread().isInterrupted();
    }

    private void stopCoreServices(HttpTransferServer server, DiscoveryService discovery,
                                  V2PairingController pairing, V2IncomingTransferCoordinator coordinator) {
        if (coordinator != null) {
            coordinator.close();
        }
        if (pairing != null) {
            pairing.close();
        }
        if (discovery != null) {
            discovery.stop();
        }
        if (server != null) {
            server.stop();
        }
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
            .setPositiveButton(getString(R.string.btn_accept), (dialog, which) -> {
                synchronized (lock) {
                    decision[0] = true;
                    answered[0] = true;
                    lock.notifyAll();
                }
            })
            .setNegativeButton(getString(R.string.btn_reject), (dialog, which) -> {
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

    private String getCustomSaveTreeUriString() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        return prefs.getString(PREF_SAVE_TREE_URI, null);
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
        resetSaveButton.setVisibility(saveTarget instanceof TreeUriSaveTarget ? View.VISIBLE : View.GONE);
    }

    private void toggleLocalDetails() {
        boolean expanding = localDetailsLayout.getVisibility() != View.VISIBLE;
        localDetailsLayout.setVisibility(expanding ? View.VISIBLE : View.GONE);
        localDetailsButton.setText(expanding ? getString(R.string.btn_collapse_settings) : getString(R.string.btn_expand_settings));
        localDetailsButton.setContentDescription(expanding ? getString(R.string.btn_collapse_settings) : getString(R.string.btn_expand_settings));
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

    private void updateV2ProgressUi(String taskId, long bytesTransferred, long totalBytes) {
        progressCard.setVisibility(View.VISIBLE);
        int progress = 0;
        int percent = 0;
        if (totalBytes > 0) {
            progress = Math.max(0, Math.min(1000, (int) Math.round((bytesTransferred * 1000.0) / totalBytes)));
            percent = Math.max(0, Math.min(100, (int) Math.round((bytesTransferred * 100.0) / totalBytes)));
        }
        transferProgress.setProgress(progress);
        progressPercentText.setText(percent + "%");
        progressTitleText.setText(getString(R.string.transfer_in_progress));
        progressDetailText.setText(formatBytes(bytesTransferred) + " / " + formatBytes(totalBytes));
        setProgressColor(COLOR_PRIMARY);
        statusText.setText(getString(R.string.transfer_in_progress) + " " + percent + "%");
    }

    private void showV2TransferCompletedUi(String taskId) {
        progressCard.setVisibility(View.VISIBLE);
        transferProgress.setProgress(1000);
        progressPercentText.setText("100%");
        progressTitleText.setText(getString(R.string.transfer_completed));
        setProgressColor(COLOR_SUCCESS);
        statusText.setText(getString(R.string.transfer_completed));
        appendLog(getString(R.string.transfer_completed) + " (" + taskId + ")");
    }

    private void showV2TransferFailedUi(String taskId, String reason) {
        progressCard.setVisibility(View.VISIBLE);
        progressTitleText.setText(getString(R.string.transfer_failed, reason));
        setProgressColor(COLOR_DANGER);
        statusText.setText(getString(R.string.transfer_failed, reason));
        appendLog(getString(R.string.transfer_failed, reason) + " (" + taskId + ")");
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

    private void chooseFileForUpload() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(intent, REQUEST_UPLOAD_LIBRARY);
    }

    private String getTargetServerIp() {
        if (selectedPeer != null && selectedPeer.host != null && !selectedPeer.host.isEmpty()) {
            return selectedPeer.host;
        }
        if (!peers.isEmpty() && peers.get(0).host != null && !peers.get(0).host.isEmpty()) {
            return peers.get(0).host;
        }
        if (!v2Peers.isEmpty() && v2Peers.get(0).host != null && !v2Peers.get(0).host.isEmpty()) {
            return v2Peers.get(0).host;
        }
        SharedPreferences sp = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        return sp != null ? sp.getString("target_server_ip", null) : null;
    }

    /**
     * Returns this device's id, or null when the device identity is not ready yet.
     * Callers must handle null instead of falling back to a hardcoded id: the desktop
     * library only accepts paired device ids, so a fabricated id always 403s.
     */
    private String getDeviceIdOrNull() {
        return device != null ? device.deviceId : null;
    }

    private static class FileTypeBadge {
        final String icon;
        final String label;
        final int color;
        final int bgColor;
        FileTypeBadge(String icon, String label, int color, int bgColor) {
            this.icon = icon;
            this.label = label;
            this.color = color;
            this.bgColor = bgColor;
        }
    }

    private FileTypeBadge getFileTypeInfo(String filename, boolean isDirectory) {
        if (isDirectory) {
            return new FileTypeBadge("📁", "文件夹", Color.rgb(217, 119, 6), Color.rgb(254, 243, 199));
        }
        String ext = "";
        int dot = filename.lastIndexOf('.');
        if (dot >= 0) ext = filename.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (ext) {
            case "png": case "jpg": case "jpeg": case "gif": case "webp": case "svg": case "bmp": case "heic":
                return new FileTypeBadge("🖼️", "图片", Color.rgb(124, 58, 237), Color.rgb(237, 233, 254));
            case "mp4": case "mkv": case "avi": case "mov": case "flv": case "wmv": case "webm":
                return new FileTypeBadge("🎬", "视频", Color.rgb(225, 29, 72), Color.rgb(255, 228, 230));
            case "mp3": case "wav": case "flac": case "aac": case "m4a": case "ogg":
                return new FileTypeBadge("🎵", "音频", Color.rgb(8, 145, 178), Color.rgb(207, 250, 254));
            case "pdf": case "doc": case "docx": case "txt": case "md": case "xls": case "xlsx": case "ppt": case "pptx": case "csv":
                return new FileTypeBadge("📄", "文档", Color.rgb(37, 99, 235), Color.rgb(219, 234, 254));
            case "zip": case "rar": case "7z": case "tar": case "gz": case "bz2": case "iso":
                return new FileTypeBadge("📦", "压缩包", Color.rgb(234, 88, 12), Color.rgb(255, 237, 213));
            case "js": case "ts": case "java": case "kt": case "py": case "c": case "cpp": case "html": case "css": case "json": case "xml": case "sh":
                return new FileTypeBadge("💻", "代码", Color.rgb(5, 150, 105), Color.rgb(209, 250, 229));
            default:
                return new FileTypeBadge("📄", "文件", Color.rgb(100, 116, 139), Color.rgb(241, 245, 249));
        }
    }

    private void navigateToParentDirectory() {
        if (libraryCurrentSubPath == null || libraryCurrentSubPath.isEmpty()) return;
        int lastSlash = libraryCurrentSubPath.lastIndexOf('/');
        libraryCurrentSubPath = lastSlash >= 0 ? libraryCurrentSubPath.substring(0, lastSlash) : "";
        refreshLibrariesList(false);
    }

    private void cycleSortMode() {
        librarySortMode = (librarySortMode + 1) % 3;
        if (librariesSortButton != null) {
            switch (librarySortMode) {
                case 0: librariesSortButton.setText(getString(R.string.sort_default)); break;
                case 1: librariesSortButton.setText(getString(R.string.sort_time)); break;
                case 2: librariesSortButton.setText(getString(R.string.sort_size)); break;
            }
        }
        applyFilterAndRender();
    }

    private void renderLibraryBreadcrumbs() {
        if (librariesBreadcrumbLayout == null) return;
        librariesBreadcrumbLayout.removeAllViews();

        if (librariesBackButton != null) {
            librariesBackButton.setVisibility(libraryCurrentSubPath.isEmpty() ? View.GONE : View.VISIBLE);
        }

        // 根目录标签
        TextView rootChip = text("🏠 " + getString(R.string.root_directory_name), 12, libraryCurrentSubPath.isEmpty() ? COLOR_PRIMARY_DARK : COLOR_MUTED, Typeface.BOLD);
        rootChip.setPadding(dp(8), dp(4), dp(8), dp(4));
        rootChip.setBackground(rounded(libraryCurrentSubPath.isEmpty() ? COLOR_PRIMARY_SOFT : Color.TRANSPARENT, dp(6)));
        rootChip.setOnClickListener(v -> {
            if (!libraryCurrentSubPath.isEmpty()) {
                libraryCurrentSubPath = "";
                refreshLibrariesList(false);
            }
        });
        librariesBreadcrumbLayout.addView(rootChip, wrapContent());

        if (!libraryCurrentSubPath.isEmpty()) {
            String[] parts = libraryCurrentSubPath.split("/");
            StringBuilder pathAccumulator = new StringBuilder();
            for (int i = 0; i < parts.length; i++) {
                final String part = parts[i];
                if (part.isEmpty()) continue;
                if (pathAccumulator.length() > 0) pathAccumulator.append("/");
                pathAccumulator.append(part);
                final String targetSubPath = pathAccumulator.toString();
                final boolean isCurrent = i == parts.length - 1;

                TextView separator = text(" > ", 12, COLOR_MUTED, Typeface.BOLD);
                librariesBreadcrumbLayout.addView(separator, wrapContent());

                TextView chip = text("📁 " + part, 12, isCurrent ? COLOR_PRIMARY_DARK : COLOR_MUTED, Typeface.BOLD);
                chip.setPadding(dp(8), dp(4), dp(8), dp(4));
                chip.setBackground(rounded(isCurrent ? COLOR_PRIMARY_SOFT : Color.TRANSPARENT, dp(6)));
                chip.setOnClickListener(v -> {
                    if (!targetSubPath.equals(libraryCurrentSubPath)) {
                        libraryCurrentSubPath = targetSubPath;
                        refreshLibrariesList(false);
                    }
                });
                librariesBreadcrumbLayout.addView(chip, wrapContent());
            }
        }
    }

    private void applyFilterAndRender() {
        List<WebDavClient.WebDavItem> filtered = new ArrayList<>();
        String query = librarySearchQuery != null ? librarySearchQuery.toLowerCase(Locale.ROOT) : "";

        for (WebDavClient.WebDavItem item : rawLibraryItems) {
            if (query.isEmpty() || (item.name != null && item.name.toLowerCase(Locale.ROOT).contains(query))) {
                filtered.add(item);
            }
        }

        // 排序规则
        Collections.sort(filtered, (a, b) -> {
            if (librarySortMode == 0) {
                // 文件夹优先，随后按文件名升序
                if (a.isDirectory != b.isDirectory) {
                    return a.isDirectory ? -1 : 1;
                }
                return a.name.compareToIgnoreCase(b.name);
            } else if (librarySortMode == 1) {
                // 按修改时间最新优先
                return Long.compare(b.lastModified, a.lastModified);
            } else if (librarySortMode == 2) {
                // 按文件大小降序（文件夹优先放前）
                if (a.isDirectory != b.isDirectory) {
                    return a.isDirectory ? -1 : 1;
                }
                return Long.compare(b.size, a.size);
            }
            return 0;
        });

        renderLibraryItems(filtered, null);
    }

    private void promptCreateFolder() {
        if (libraryServerIp == null || libraryToken == null) {
            Toast.makeText(this, getString(R.string.library_no_connection), Toast.LENGTH_SHORT).show();
            return;
        }

        android.widget.EditText input = new android.widget.EditText(this);
        input.setHint(getString(R.string.create_folder_input_hint));
        input.setSingleLine(true);
        input.setPadding(dp(16), dp(12), dp(16), dp(12));

        String currentDirName = libraryCurrentSubPath.isEmpty() ? getString(R.string.root_directory_name) : libraryCurrentSubPath;
        new AlertDialog.Builder(this)
            .setTitle(getString(R.string.dialog_create_folder_title))
            .setMessage(getString(R.string.dialog_create_folder_msg, currentDirName))
            .setView(input)
            .setPositiveButton(getString(R.string.action_confirm), (dialog, which) -> {
                String folderName = input.getText().toString().trim();
                if (folderName.isEmpty()) {
                    Toast.makeText(this, getString(R.string.create_folder_empty_error), Toast.LENGTH_SHORT).show();
                    return;
                }
                appendLog(getString(R.string.create_folder_creating_log, folderName));
                executor.execute(() -> {
                    try {
                        WebDavClient.createDirectory(libraryServerIp, libraryServerPort, libraryToken, libraryShareId, libraryCurrentSubPath, folderName);
                        runOnUiThreadIfAlive(() -> {
                            Toast.makeText(this, getString(R.string.create_folder_success, folderName), Toast.LENGTH_SHORT).show();
                            appendLog(getString(R.string.create_folder_success, folderName));
                            refreshLibrariesList(false);
                        });
                    } catch (Exception e) {
                        runOnUiThreadIfAlive(() -> {
                            Toast.makeText(this, getString(R.string.create_folder_failed, e.getMessage()), Toast.LENGTH_LONG).show();
                            appendLog(getString(R.string.create_folder_failed, e.getMessage()));
                        });
                    }
                });
            })
            .setNegativeButton(getString(R.string.action_cancel), null)
            .show();
    }

    private void refreshLibrariesList(boolean userInitiated) {
        if (activityDestroyed || libraryLoading) return;
        libraryLoading = true;
        if (librariesStatusText != null) {
            librariesStatusText.setText("正在连接电脑共享文件库…");
        }
        String serverIp = getTargetServerIp();
        libraryServerIp = serverIp;
        String myDeviceId = getDeviceIdOrNull();
        if (myDeviceId == null) {
            libraryLoading = false;
            if (librariesStatusText != null) {
                librariesStatusText.setText("设备未初始化，请稍后重试。");
            }
            return;
        }

        executor.execute(() -> {
            try {
                DeviceConfig localDevice = device;
                if (localDevice == null || localDevice.signingPrivateKey == null) {
                    runOnUiThreadIfAlive(() -> {
                        libraryLoading = false;
                        if (librariesStatusText != null) {
                            librariesStatusText.setText("设备身份未就绪，无法连接文件库。");
                        }
                    });
                    return;
                }
                WebDavClient.SessionResult authResult = WebDavClient.authenticate(serverIp, libraryServerPort, myDeviceId, localDevice.signingPrivateKey);
                if (!authResult.ok) {
                    runOnUiThreadIfAlive(() -> {
                        libraryLoading = false;
                        if (librariesStatusText != null) {
                            librariesStatusText.setText("连接文件库失败：" + authResult.error + "\n请确认两端已完成配对。");
                        }
                        rawLibraryItems.clear();
                        renderLibraryBreadcrumbs();
                        renderLibraryItems(Collections.emptyList(), authResult.error);
                    });
                    return;
                }
                libraryToken = authResult.token;
                if (!authResult.shares.isEmpty()) {
                    libraryShareId = authResult.shares.get(0).id;
                }
                List<WebDavClient.WebDavItem> items;
                try {
                    items = WebDavClient.listFiles(serverIp, libraryServerPort, libraryToken, libraryShareId, libraryCurrentSubPath);
                } catch (Exception listErr) {
                    if (!libraryCurrentSubPath.isEmpty()) {
                        libraryCurrentSubPath = "";
                        items = WebDavClient.listFiles(serverIp, libraryServerPort, libraryToken, libraryShareId, "");
                    } else {
                        throw listErr;
                    }
                }
                final List<WebDavClient.WebDavItem> finalItems = items;
                runOnUiThreadIfAlive(() -> {
                    libraryLoading = false;
                    rawLibraryItems = new ArrayList<>(finalItems);
                    if (librariesStatusText != null) {
                        String pathDisplay = libraryCurrentSubPath.isEmpty() ? "根目录" : libraryCurrentSubPath;
                        librariesStatusText.setText("已连接电脑文件库 (" + serverIp + ":" + libraryServerPort + ") 当前: " + pathDisplay + " (" + finalItems.size() + " 项)");
                    }
                    renderLibraryBreadcrumbs();
                    applyFilterAndRender();
                    if (userInitiated) {
                        Toast.makeText(this, "文件库已刷新 (" + finalItems.size() + " 项)", Toast.LENGTH_SHORT).show();
                    }
                });
            } catch (Exception e) {
                runOnUiThreadIfAlive(() -> {
                    libraryLoading = false;
                    rawLibraryItems.clear();
                    renderLibraryBreadcrumbs();
                    if (librariesStatusText != null) {
                        librariesStatusText.setText("读取文件库出错：" + e.getMessage());
                    }
                    renderLibraryItems(Collections.emptyList(), e.getMessage());
                });
            }
        });
    }

    private void renderLibraryItems(List<WebDavClient.WebDavItem> items, String error) {
        if (librariesItemsLayout == null) return;
        librariesItemsLayout.removeAllViews();
        if (items.isEmpty()) {
            String msg = error != null ? (getString(R.string.connect_failed_prefix) + error) :
                (!libraryCurrentSubPath.isEmpty() ? getString(R.string.empty_subfolder_hint) : getString(R.string.empty_root_hint));
            TextView empty = text(msg, 13, COLOR_MUTED, Typeface.NORMAL);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(dp(16), dp(20), dp(16), dp(20));
            empty.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(8), COLOR_BORDER, 1));
            librariesItemsLayout.addView(empty, matchWrap());
            return;
        }

        DateFormat df = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT, Locale.getDefault());

        for (WebDavClient.WebDavItem item : items) {
            LinearLayout itemRow = new LinearLayout(this);
            itemRow.setOrientation(LinearLayout.HORIZONTAL);
            itemRow.setGravity(Gravity.CENTER_VERTICAL);
            itemRow.setPadding(dp(12), dp(10), dp(12), dp(10));
            itemRow.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(8), COLOR_BORDER, 1));

            FileTypeBadge badge = getFileTypeInfo(item.name, item.isDirectory);

            TextView iconView = text(badge.icon, 18, Color.WHITE, Typeface.NORMAL);
            iconView.setGravity(Gravity.CENTER);
            iconView.setBackground(rounded(badge.bgColor, dp(10)));
            LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(44), dp(44));
            iconParams.setMargins(0, 0, dp(12), 0);
            itemRow.addView(iconView, iconParams);

            LinearLayout fileInfo = new LinearLayout(this);
            fileInfo.setOrientation(LinearLayout.VERTICAL);
            TextView nameText = text(item.name, 15, COLOR_TEXT, Typeface.BOLD);
            nameText.setEllipsize(TextUtils.TruncateAt.END);
            nameText.setMaxLines(1);

            String subInfo;
            if (item.isDirectory) {
                subInfo = getString(R.string.folder_subinfo);
            } else {
                String timeStr = item.lastModified > 0 ? (" · " + df.format(new Date(item.lastModified))) : "";
                subInfo = formatBytes(item.size) + timeStr;
            }
            TextView sizeText = text(subInfo, 12, COLOR_MUTED, Typeface.NORMAL);
            sizeText.setPadding(0, dp(2), 0, 0);
            fileInfo.addView(nameText, matchWrap());
            fileInfo.addView(sizeText, matchWrap());
            itemRow.addView(fileInfo, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

            if (item.isDirectory) {
                Button enterBtn = new Button(this);
                enterBtn.setText(getString(R.string.action_enter));
                enterBtn.setAllCaps(false);
                enterBtn.setMinHeight(dp(36));
                enterBtn.setTextSize(13);
                styleButton(enterBtn, false);
                enterBtn.setOnClickListener(v -> {
                    libraryCurrentSubPath = libraryCurrentSubPath.isEmpty() ? item.name : (libraryCurrentSubPath + "/" + item.name);
                    refreshLibrariesList(false);
                });
                itemRow.addView(enterBtn, wrapContent());

                itemRow.setOnClickListener(v -> {
                    libraryCurrentSubPath = libraryCurrentSubPath.isEmpty() ? item.name : (libraryCurrentSubPath + "/" + item.name);
                    refreshLibrariesList(false);
                });
            } else {
                Button downloadBtn = new Button(this);
                downloadBtn.setText(getString(R.string.action_download));
                downloadBtn.setAllCaps(false);
                downloadBtn.setMinHeight(dp(36));
                downloadBtn.setTextSize(13);
                styleButton(downloadBtn, true);
                downloadBtn.setOnClickListener(v -> downloadLibraryFile(item));
                itemRow.addView(downloadBtn, wrapContent());
            }

            itemRow.setOnLongClickListener(v -> {
                new AlertDialog.Builder(this)
                    .setTitle(getString(R.string.dialog_delete_title))
                    .setMessage(getString(R.string.dialog_delete_confirm, item.name))
                    .setPositiveButton(getString(R.string.dialog_delete_title), (dialog, which) -> {
                        executor.execute(() -> {
                            try {
                                WebDavClient.deleteItem(libraryServerIp, libraryServerPort, libraryToken, libraryShareId, libraryCurrentSubPath, item.name);
                                runOnUiThreadIfAlive(() -> {
                                    Toast.makeText(this, getString(R.string.delete_success_format, item.name), Toast.LENGTH_SHORT).show();
                                    refreshLibrariesList(false);
                                });
                            } catch (Exception e) {
                                runOnUiThreadIfAlive(() -> {
                                    Toast.makeText(this, getString(R.string.delete_failed_format, e.getMessage()), Toast.LENGTH_LONG).show();
                                });
                            }
                        });
                    })
                    .setNegativeButton(getString(R.string.action_cancel), null)
                    .show();
                return true;
            });

            LinearLayout.LayoutParams rowParams = matchWrap();
            rowParams.setMargins(0, 0, 0, dp(8));
            librariesItemsLayout.addView(itemRow, rowParams);
        }
    }

    private void downloadLibraryFile(WebDavClient.WebDavItem item) {
        if (libraryServerIp == null || libraryToken == null) {
            Toast.makeText(this, "正在连接电脑文件库...", Toast.LENGTH_SHORT).show();
            refreshLibrariesList(false);
            return;
        }
        File downloadDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        File nearbyDir = new File(downloadDir, "Nearby Transfer");
        if (!nearbyDir.exists()) nearbyDir.mkdirs();
        File destFile = new File(nearbyDir, item.name);

        try {
            android.os.StatFs stat = new android.os.StatFs(nearbyDir.getPath());
            long availableBytes = stat.getAvailableBytes();
            long neededBytes = item.size + (50 * 1024 * 1024); // 50MB buffer
            if (item.size > 0 && availableBytes < neededBytes) {
                String error = "手机存储空间不足 (需要 " + formatBytes(item.size) + "，剩余 " + formatBytes(availableBytes) + ")";
                Toast.makeText(this, error, Toast.LENGTH_LONG).show();
                appendLog(error);
                return;
            }
        } catch (Exception ignored) {}

        transferActive = true;
        currentTransferCanceled.set(false);
        currentTransferPaused.set(false);
        if (pauseTransferButton != null) {
            pauseTransferButton.setText("⏸ 暂停");
            pauseTransferButton.setVisibility(View.VISIBLE);
        }
        if (cancelTransferButton != null) {
            cancelTransferButton.setVisibility(View.VISIBLE);
        }

        Toast.makeText(this, "开始下载：" + item.name, Toast.LENGTH_SHORT).show();
        appendLog("开始从 NAS 下载：" + item.name);
        progressCard.setVisibility(View.VISIBLE);
        progressTitleText.setText("正在从电脑下载文件");
        progressDetailText.setText(item.name);
        setProgressColor(COLOR_PRIMARY);
        io.github.nearbytransfer.android.service.TransferForegroundService.startTransfer(this, item.name, "正在从电脑下载文件", 0, "-");

        executor.execute(() -> {
            try {
                WebDavClient.downloadFile(
                    libraryServerIp,
                    libraryServerPort,
                    libraryToken,
                    item.downloadUrl,
                    destFile,
                    (transferred, total) -> runOnUiThreadIfAlive(() -> {
                        int percent = total > 0 ? (int) Math.round((transferred * 100.0) / total) : 0;
                        transferProgress.setProgress(percent * 10);
                        progressPercentText.setText(percent + "%");
                        progressDetailText.setText(item.name + "\n" + formatBytes(transferred) + " / " + formatBytes(total));
                        io.github.nearbytransfer.android.service.TransferForegroundService.updateProgress(this, item.name, "正在从电脑下载文件", percent, "-");
                    }),
                    currentTransferCanceled,
                    currentTransferPaused
                );
                runOnUiThreadIfAlive(() -> {
                    transferProgress.setProgress(1000);
                    progressPercentText.setText("100%");
                    progressTitleText.setText("下载完成");
                    setProgressColor(COLOR_SUCCESS);
                    statusText.setText("已下载到：" + destFile.getAbsolutePath());
                    appendLog("文件已保存至：" + destFile.getAbsolutePath());
                    Toast.makeText(this, "文件已成功保存到 Download/Nearby Transfer 目录！", Toast.LENGTH_LONG).show();
                });
            } catch (Exception e) {
                runOnUiThreadIfAlive(() -> {
                    boolean wasCancelled = currentTransferCanceled.get();
                    progressTitleText.setText(wasCancelled ? "下载已终止" : "下载失败");
                    setProgressColor(COLOR_DANGER);
                    statusText.setText(wasCancelled ? "已主动终止下载" : "下载失败：" + e.getMessage());
                    appendLog(wasCancelled ? "用户已主动终止下载" : "下载失败：" + e.getMessage());
                    Toast.makeText(this, wasCancelled ? "已终止下载" : "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
                });
            } finally {
                runOnUiThreadIfAlive(() -> {
                    transferActive = false;
                    if (pauseTransferButton != null) pauseTransferButton.setVisibility(View.GONE);
                    if (cancelTransferButton != null) cancelTransferButton.setVisibility(View.GONE);
                    io.github.nearbytransfer.android.service.TransferForegroundService.stopTransfer(this);
                });
            }
        });
    }

    private void uploadFileToLibrary(SelectedFile file) {
        String myDeviceId = getDeviceIdOrNull();
        if (myDeviceId == null) {
            Toast.makeText(this, "设备未初始化，请稍后重试。", Toast.LENGTH_LONG).show();
            appendLog("上传失败：设备未初始化，请稍后重试。");
            return;
        }
        if (libraryServerIp == null || libraryToken == null) {
            Toast.makeText(this, "正在连接电脑文件库...", Toast.LENGTH_SHORT).show();
            refreshLibrariesList(false);
        }
        String serverIp = getTargetServerIp();

        String pathInfo = libraryCurrentSubPath.isEmpty() ? "根目录" : libraryCurrentSubPath;
        Toast.makeText(this, "开始上传至电脑 (" + pathInfo + ")：" + file.name, Toast.LENGTH_SHORT).show();
        appendLog("开始上传文件至电脑文件库 (" + pathInfo + ")：" + file.name);

        transferActive = true;
        currentTransferCanceled.set(false);
        currentTransferPaused.set(false);
        if (pauseTransferButton != null) {
            pauseTransferButton.setText("⏸ 暂停");
            pauseTransferButton.setVisibility(View.VISIBLE);
        }
        if (cancelTransferButton != null) {
            cancelTransferButton.setVisibility(View.VISIBLE);
        }

        progressCard.setVisibility(View.VISIBLE);
        progressTitleText.setText("正在上传文件至电脑");
        progressDetailText.setText(file.name);
        setProgressColor(COLOR_PRIMARY);
        io.github.nearbytransfer.android.service.TransferForegroundService.startTransfer(this, file.name, "正在上传文件至电脑", 0, "-");

        executor.execute(() -> {
            try {
                if (libraryToken == null) {
                    WebDavClient.SessionResult auth = WebDavClient.authenticate(serverIp, libraryServerPort, myDeviceId);
                    if (!auth.ok) throw new IllegalStateException(auth.error);
                    libraryToken = auth.token;
                    if (!auth.shares.isEmpty()) libraryShareId = auth.shares.get(0).id;
                }

                try (InputStream in = getContentResolver().openInputStream(file.uri)) {
                    if (in == null) throw new IllegalStateException("无法读取文件内容");
                    WebDavClient.uploadFile(
                        serverIp,
                        libraryServerPort,
                        libraryToken,
                        libraryShareId,
                        libraryCurrentSubPath,
                        file.name,
                        in,
                        file.size,
                        (transferred, total) -> runOnUiThreadIfAlive(() -> {
                            int percent = total > 0 ? (int) Math.round((transferred * 100.0) / total) : 0;
                            transferProgress.setProgress(percent * 10);
                            progressPercentText.setText(percent + "%");
                            progressDetailText.setText(file.name + "\n" + formatBytes(transferred) + " / " + formatBytes(total));
                            io.github.nearbytransfer.android.service.TransferForegroundService.updateProgress(this, file.name, "正在上传文件至电脑", percent, "-");
                        }),
                        currentTransferCanceled,
                        currentTransferPaused
                    );
                }

                runOnUiThreadIfAlive(() -> {
                    transferProgress.setProgress(1000);
                    progressPercentText.setText("100%");
                    progressTitleText.setText("上传完成");
                    setProgressColor(COLOR_SUCCESS);
                    statusText.setText("已上传至电脑共享库: " + file.name);
                    appendLog("文件上传完成：" + file.name);
                    Toast.makeText(this, "已成功上传 " + file.name + " 到电脑共享库！", Toast.LENGTH_LONG).show();
                    refreshLibrariesList(false);
                });
            } catch (Exception e) {
                runOnUiThreadIfAlive(() -> {
                    boolean wasCancelled = currentTransferCanceled.get();
                    progressTitleText.setText(wasCancelled ? "上传已终止" : "上传失败");
                    setProgressColor(COLOR_DANGER);
                    statusText.setText(wasCancelled ? "已主动终止上传" : "上传失败：" + e.getMessage());
                    appendLog(wasCancelled ? "用户已主动终止上传" : "上传失败：" + e.getMessage());
                    Toast.makeText(this, wasCancelled ? "已终止上传" : "上传失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
                });
            } finally {
                runOnUiThreadIfAlive(() -> {
                    transferActive = false;
                    if (pauseTransferButton != null) pauseTransferButton.setVisibility(View.GONE);
                    if (cancelTransferButton != null) cancelTransferButton.setVisibility(View.GONE);
                    io.github.nearbytransfer.android.service.TransferForegroundService.stopTransfer(this);
                });
            }
        });
    }

    private void startLibraryEventsSubscription() {
        if (libraryEventsThread != null && libraryEventsThread.isAlive()) return;
        libraryEventsCancel.set(false);
        libraryEventsThread = new Thread(() -> {
            while (!activityDestroyed && !libraryEventsCancel.get() && selectedTab == TAB_LIBRARIES) {
                String serverIp = libraryServerIp != null ? libraryServerIp : getTargetServerIp();
                String token = libraryToken;
                if (token == null) {
                    try {
                        String myDeviceId = getDeviceIdOrNull();
                        if (myDeviceId == null) {
                            Thread.sleep(2000);
                            continue;
                        }
                        WebDavClient.SessionResult auth = WebDavClient.authenticate(serverIp, libraryServerPort, myDeviceId);
                        if (auth.ok) {
                            token = auth.token;
                            libraryToken = token;
                        }
                    } catch (Exception ignored) {}
                }
                if (token != null && !libraryEventsCancel.get()) {
                    WebDavClient.subscribeEvents(serverIp, libraryServerPort, token, new WebDavClient.EventListener() {
                        @Override
                        public void onLibraryChanged(String shareId, String eventType, String filename) {
                            runOnUiThreadIfAlive(() -> {
                                if (selectedTab == TAB_LIBRARIES) {
                                    appendLog("电脑端文件发生变动 (" + (filename.isEmpty() ? "文件库已更新" : filename) + ")，自动同步中…");
                                    refreshLibrariesList(false);
                                }
                            });
                        }

                        @Override
                        public void onConnected() {}

                        @Override
                        public void onError(Exception e) {}
                    }, libraryEventsCancel);
                }
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException e) {
                    break;
                }
            }
        }, "WebDavEventsClient");
        libraryEventsThread.setDaemon(true);
        libraryEventsThread.start();
    }

    private void stopLibraryEventsSubscription() {
        libraryEventsCancel.set(true);
        if (libraryEventsThread != null) {
            libraryEventsThread.interrupt();
            libraryEventsThread = null;
        }
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

    private void toggleTransferPause() {
        if (!transferActive) return;
        boolean currentlyPaused = currentTransferPaused.get();
        if (currentlyPaused) {
            currentTransferPaused.set(false);
            if (pauseTransferButton != null) pauseTransferButton.setText(getString(R.string.btn_pause_transfer));
            statusText.setText(getString(R.string.transfer_in_progress));
            appendLog(getString(R.string.transfer_in_progress));
        } else {
            currentTransferPaused.set(true);
            if (pauseTransferButton != null) pauseTransferButton.setText(getString(R.string.btn_resume_transfer));
            statusText.setText(getString(R.string.status_paused));
            appendLog(getString(R.string.status_paused));
        }
    }

    private void cancelActiveTransfer() {
        if (!transferActive) return;
        currentTransferCanceled.set(true);
        currentTransferPaused.set(false);
        transferActive = false;
        if (pauseTransferButton != null) pauseTransferButton.setVisibility(View.GONE);
        if (cancelTransferButton != null) cancelTransferButton.setVisibility(View.GONE);
        setProgressColor(COLOR_DANGER);
        progressTitleText.setText("传输已终止");
        statusText.setText("已主动终止传输");
        appendLog("用户已主动终止传输");
        renderSendState();
    }

    private void sendSelectedFile() {
        if (selectedPeer == null) {
            appendLog("请先选择附近设备。");
            return;
        }
        if (selectedFile == null) {
            appendLog("请先选择文件。");
            return;
        }
        if (device == null) {
            appendLog("应用还未准备好。");
            return;
        }

        sendButton.setEnabled(false);
        transferActive = true;
        currentTransferCanceled.set(false);
        currentTransferPaused.set(false);
        if (pauseTransferButton != null) {
            pauseTransferButton.setText("⏸ 暂停");
            pauseTransferButton.setVisibility(View.VISIBLE);
        }
        if (cancelTransferButton != null) {
            cancelTransferButton.setVisibility(View.VISIBLE);
        }
        styleButton(sendButton, true);
        progressCard.setVisibility(View.VISIBLE);
        statusText.setText("正在准备发送...");
        progressTitleText.setText("正在准备发送");
        progressDetailText.setText(selectedFile.name + "\n正在计算校验值...");
        progressSpeedText.setText("速率 -");
        progressPercentText.setText("0%");
        transferProgress.setProgress(0);
        setProgressColor(COLOR_PRIMARY);

        PeerDevice peer = selectedPeer;
        SelectedFile file = selectedFile;
        io.github.nearbytransfer.android.service.TransferForegroundService.startTransfer(this, file.name, "正在发送文件至 " + peer.deviceName, 0, "-");

        executor.execute(() -> {
            String finalStatus = "发送已结束。";
            try {
                TransferClient.send(this, device, peer, file, this::onTransferEvent, currentTransferCanceled, currentTransferPaused);
                finalStatus = "发送完成。";
            } catch (Exception error) {
                String errorMessage = error.getMessage();
                String failureStatus = currentTransferCanceled.get() ? "传输已终止" : "发送失败：" + errorMessage;
                finalStatus = failureStatus;
                runOnUiThreadIfAlive(() -> {
                    setProgressColor(COLOR_DANGER);
                    progressTitleText.setText(currentTransferCanceled.get() ? "传输已终止" : "发送失败");
                    progressSpeedText.setText(errorMessage);
                    appendLog(failureStatus);
                });
            } finally {
                String statusAfterTransfer = finalStatus;
                runOnUiThreadIfAlive(() -> {
                    transferActive = false;
                    if (pauseTransferButton != null) pauseTransferButton.setVisibility(View.GONE);
                    if (cancelTransferButton != null) cancelTransferButton.setVisibility(View.GONE);
                    io.github.nearbytransfer.android.service.TransferForegroundService.stopTransfer(this);
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

    private void refreshTransferJobsList() {
        if (activityDestroyed || jobsLayout == null) return;
        try {
            executor.execute(() -> {
                try {
                    List<io.github.nearbytransfer.android.core.data.TransferJob> loaded = new ArrayList<>(
                        io.github.nearbytransfer.android.core.data.V2TransferJobPersistence.listUnfinished(getApplicationContext())
                    );
                    runOnUiThreadIfAlive(() -> renderTransferJobs(loaded));
                } catch (Exception error) {
                    runOnUiThreadIfAlive(() -> appendLog("刷新持久化任务失败: " + error.getMessage()));
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException ignored) {}
    }

    private void renderTransferJobs(List<io.github.nearbytransfer.android.core.data.TransferJob> loadedJobs) {
        if (jobsLayout == null || activityDestroyed) return;
        jobsLayout.removeAllViews();
        if (loadedJobs.isEmpty()) {
            TextView empty = text("暂无持久化任务", 14, COLOR_MUTED, Typeface.NORMAL);
            empty.setPadding(0, dp(8), 0, dp(8));
            jobsLayout.addView(empty, matchWrap());
            return;
        }

        for (io.github.nearbytransfer.android.core.data.TransferJob job : loadedJobs) {
            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.VERTICAL);
            item.setPadding(dp(12), dp(10), dp(12), dp(10));
            item.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(8), COLOR_BORDER, 1));
            LinearLayout.LayoutParams itemParams = matchWrap();
            itemParams.setMargins(0, 0, 0, dp(8));

            String dir = job.getDirection().name();
            String state = job.getState().name();
            TextView name = text(dir + " - " + job.getTaskId().substring(0, Math.min(8, job.getTaskId().length())), 15, COLOR_TEXT, Typeface.BOLD);
            TextView status = text("状态: " + state, 13, COLOR_MUTED, Typeface.NORMAL);
            item.addView(name, matchWrap());
            item.addView(status, matchWrap());

            LinearLayout controls = new LinearLayout(this);
            controls.setOrientation(LinearLayout.HORIZONTAL);
            controls.setPadding(0, dp(8), 0, 0);

            if ("TRANSFERRING".equals(state) || "QUEUED".equals(state)) {
                Button pauseBtn = new Button(this);
                pauseBtn.setText("暂停");
                pauseBtn.setMinHeight(dp(36));
                styleButton(pauseBtn, false);
                pauseBtn.setOnClickListener(v -> executeJobTransition(job.getTaskId(), "PAUSED", null, true));
                controls.addView(pauseBtn, wrapContent());
            } else if ("PAUSED".equals(state) || "FAILED".equals(state)) {
                Button resumeBtn = new Button(this);
                resumeBtn.setText("继续");
                resumeBtn.setMinHeight(dp(36));
                styleButton(resumeBtn, false);
                resumeBtn.setOnClickListener(v -> executeJobTransition(job.getTaskId(), "QUEUED", null, true));
                controls.addView(resumeBtn, wrapContent());
            }

            Button cancelBtn = new Button(this);
            cancelBtn.setText("取消");
            cancelBtn.setMinHeight(dp(36));
            styleButton(cancelBtn, false);
            cancelBtn.setOnClickListener(v -> executeJobTransition(job.getTaskId(), "CANCELLED", null, false));
            LinearLayout.LayoutParams cancelParams = wrapContent();
            cancelParams.setMargins(dp(8), 0, 0, 0);
            controls.addView(cancelBtn, cancelParams);
            item.addView(controls, matchWrap());
            jobsLayout.addView(item, itemParams);
        }
    }

    private void executeJobTransition(String taskId, String newState, String failureReason, Boolean recoverable) {
        if (activityDestroyed) return;
        try {
            executor.execute(() -> {
                try {
                    io.github.nearbytransfer.android.core.data.V2TransferJobPersistence.transition(
                        getApplicationContext(), taskId, newState, System.currentTimeMillis(), failureReason, recoverable
                    );
                    refreshTransferJobsList();
                } catch (Exception error) {
                    runOnUiThreadIfAlive(() -> appendLog("更新任务状态失败: " + error.getMessage()));
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException ignored) {}
    }

    private void renderTrustedPeers() {
        if (trustedPeersLayout == null || activityDestroyed) return;
        trustedPeersLayout.removeAllViews();
        List<V2TrustedPeerPersistence.TrustedPeerSummary> currentTrustedPeers = new ArrayList<>();
        for (V2TrustedPeerPersistence.TrustedPeerSummary peer : trustedPeers) {
            if ("TRUSTED".equals(peer.getTrustStatus().name())) currentTrustedPeers.add(peer);
        }
        trustedPeersLayout.setVisibility(currentTrustedPeers.isEmpty() ? View.GONE : View.VISIBLE);
        if (currentTrustedPeers.isEmpty()) {
            return;
        }

        for (V2TrustedPeerPersistence.TrustedPeerSummary peer : currentTrustedPeers) {
            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.VERTICAL);
            item.setPadding(dp(12), dp(12), dp(12), dp(12));
            item.setBackground(roundedStroke(COLOR_PRIMARY_SOFT, dp(8), Color.rgb(153, 246, 228), 1));

            String name = displayNameOrFallback(peer.getDisplayName());
            item.addView(text(name + "  ·  已信任", 15, COLOR_TEXT, Typeface.BOLD), matchWrap());
            TextView details = text(
                "指纹：" + shortFingerprint(peer.getFingerprint())
                    + "\n配对时间：" + formatTrustedPeerTime(peer.getPairedAtEpochMillis())
                    + (peer.getCanTransfer() ? "\n权限：可传输文件" : ""),
                12,
                COLOR_MUTED,
                Typeface.NORMAL
            );
            details.setPadding(0, dp(6), 0, dp(10));
            item.addView(details, matchWrap());

            Button revokeButton = new Button(this);
            revokeButton.setText(getString(R.string.btn_revoke_trust));
            revokeButton.setContentDescription(getString(R.string.btn_revoke_trust) + " " + name);
            revokeButton.setAllCaps(false);
            revokeButton.setMinHeight(dp(48));
            styleButton(revokeButton, false);
            revokeButton.setTextColor(COLOR_DANGER);
            revokeButton.setOnClickListener(v -> confirmRevokeTrustedPeer(peer, revokeButton));
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
            .setTitle(getString(R.string.dialog_revoke_trust_title))
            .setMessage(getString(R.string.dialog_revoke_trust_message, name))
            .setNegativeButton(getString(R.string.dialog_cancel), null)
            .setPositiveButton(getString(R.string.btn_revoke_trust), (dialog, which) -> revokeTrustedPeer(peer, revokeButton))
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
                        revokeButton.setText(getString(R.string.btn_revoke_trust));
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
        return "共 " + trustedCount + " 台可信设备。";
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
        java.util.Set<String> trustedDeviceIds = new java.util.HashSet<>();
        for (V2TrustedPeerPersistence.TrustedPeerSummary trusted : trustedPeers) {
            if ("TRUSTED".equals(trusted.getTrustStatus().name())) {
                trustedDeviceIds.add(trusted.getDeviceId());
            }
        }
        v2PeersLayout.removeAllViews();
        boolean anyPairable = false;
        for (V2DiscoveryService.Peer peer : v2Peers) {
            if (trustedDeviceIds.contains(peer.deviceId)) continue;
            anyPairable = true;
            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.VERTICAL);
            item.setPadding(dp(14), dp(14), dp(14), dp(14));
            item.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(8), COLOR_BORDER, 1));
            item.addView(text(peer.deviceName + "  ·  " + peer.fingerprint, 15, COLOR_TEXT, Typeface.BOLD), matchWrap());
            TextView endpoint = text(peer.host + ":" + peer.port + "\n仅在双方核对相同的六位配对码后保存信任。", 12, COLOR_MUTED, Typeface.NORMAL);
            endpoint.setPadding(0, dp(5), 0, dp(10));
            item.addView(endpoint, matchWrap());
            Button pairButton = new Button(this);
            pairButton.setText(getString(R.string.btn_start_pairing));
            pairButton.setContentDescription(getString(R.string.btn_start_pairing) + " " + peer.deviceName);
            pairButton.setAllCaps(false);
            pairButton.setMinHeight(dp(48));
            styleButton(pairButton, true);
            pairButton.setOnClickListener(v -> {
                if (isPeerTrusted(peer.deviceId)) {
                    v2StatusText.setText("该设备已配对，无需重复配对。");
                    return;
                }
                v2StatusText.setText("正在连接 " + peer.deviceName + "…");
                v2PairingController.startPairing(peer);
            });
            item.addView(pairButton, matchWrap());
            LinearLayout.LayoutParams params = matchWrap();
            params.setMargins(0, 0, 0, dp(10));
            v2PeersLayout.addView(item, params);
        }
        v2PeersLayout.setVisibility(anyPairable ? View.VISIBLE : View.GONE);
    }

    private boolean isPeerTrusted(String deviceId) {
        if (deviceId == null) return false;
        for (V2TrustedPeerPersistence.TrustedPeerSummary trusted : trustedPeers) {
            if ("TRUSTED".equals(trusted.getTrustStatus().name()) && deviceId.equals(trusted.getDeviceId())) {
                return true;
            }
        }
        return false;
    }

    private void renderV2Sessions() {
        if (v2SessionsLayout == null) return;
        v2SessionsLayout.removeAllViews();
        List<V2PairingSessionStore.Session> sessions = new ArrayList<>();
        if (v2PairingController != null) {
            for (V2PairingSessionStore.Session session : v2PairingController.listSessions()) {
                if (!isTerminalPairingStatus(session.status)) sessions.add(session);
            }
        }
        boolean requiresLocalAction = false;
        for (V2PairingSessionStore.Session session : sessions) {
            if (session.status == V2PairingSessionStore.Status.AWAITING_LOCAL_CONFIRMATION
                || session.status == V2PairingSessionStore.Status.READY_TO_TRUST) {
                requiresLocalAction = true;
                break;
            }
        }
        setPendingPairingAction(requiresLocalAction);
        boolean hasActiveSessions = !sessions.isEmpty();
        v2SessionTitle.setVisibility(hasActiveSessions ? View.VISIBLE : View.GONE);
        v2SessionsLayout.setVisibility(hasActiveSessions ? View.VISIBLE : View.GONE);
        if (sessions.isEmpty()) {
            return;
        }
        for (V2PairingSessionStore.Session session : sessions) {
            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.VERTICAL);
            item.setPadding(dp(14), dp(14), dp(14), dp(14));
            item.setBackground(roundedStroke(COLOR_PRIMARY_SOFT, dp(8), Color.rgb(153, 246, 228), 1));
            String peerName = session.peerOffer == null ? "正在建立连接" : session.peerOffer.identity.deviceName;
            item.addView(text(peerName + " · " + pairingStatusLabel(session.status), 15, COLOR_TEXT, Typeface.BOLD), matchWrap());
            TextView code = text(session.pairingCode == null ? "等待身份验证…" : "请与对方核对配对码：" + session.pairingCode, 17, COLOR_PRIMARY_DARK, Typeface.BOLD);
            code.setPadding(0, dp(7), 0, dp(7));
            item.addView(code, matchWrap());
            if (session.status == V2PairingSessionStore.Status.AWAITING_LOCAL_CONFIRMATION) {
                Button confirm = new Button(this);
                confirm.setText(getString(R.string.btn_confirm_pairing));
                confirm.setContentDescription(getString(R.string.btn_confirm_pairing));
                confirm.setAllCaps(false);
                confirm.setMinHeight(dp(48));
                styleButton(confirm, true);
                confirm.setOnClickListener(v -> v2PairingController.confirmPairing(session.pairingId));
                item.addView(confirm, matchWrap());
            } else if (session.status == V2PairingSessionStore.Status.READY_TO_TRUST) {
                TextView autoNote = text("双方已确认配对码，正在自动保存信任...", 13, COLOR_MUTED, Typeface.ITALIC);
                autoNote.setPadding(0, dp(4), 0, dp(4));
                item.addView(autoNote, matchWrap());
            }
            Button cancel = new Button(this);
            cancel.setText(getString(R.string.btn_cancel_pairing));
            cancel.setContentDescription(getString(R.string.btn_cancel_pairing));
            cancel.setAllCaps(false);
            cancel.setMinHeight(dp(48));
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
            TextView empty = text(getString(R.string.searching_peers), 13, COLOR_MUTED, Typeface.NORMAL);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(dp(12), dp(12), dp(12), dp(12));
            empty.setBackground(roundedStroke(COLOR_SURFACE_TINT, dp(8), COLOR_BORDER, 1));
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
            item.setFocusable(true);
            item.setSelected(selected);
            item.setMinimumHeight(dp(48));
            item.setContentDescription(peer.deviceName + (selected ? "，已选择" : "，可用"));
            item.setBackground(selected
                ? roundedStroke(COLOR_PRIMARY_SOFT, dp(8), COLOR_PRIMARY, 2)
                : roundedStroke(COLOR_SURFACE_TINT, dp(8), COLOR_BORDER, 1));

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
        if (hasPendingPairingAction && selectedTab != TAB_DEVICES) {
            statusText.setText("安全配对待确认，请打开“设备”页。");
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
        progressCard.setVisibility(View.VISIBLE);

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

        if (transferActive) {
            io.github.nearbytransfer.android.service.TransferForegroundService.updateProgress(
                this,
                event.fileName,
                progressTitle(event),
                percent,
                formatRate(speed)
            );
        } else {
            io.github.nearbytransfer.android.service.TransferForegroundService.stopTransfer(this);
        }
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
        boolean keepAtBottom = logFollowLatest;
        if (!logs.add(message)) return;
        logText.setText(logs.render());
        if (keepAtBottom) {
            logScroll.post(() -> logScroll.fullScroll(View.FOCUS_DOWN));
        }
    }

    private void copyLogToClipboard() {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) {
            ClipData clip = ClipData.newPlainText("Nearby Transfer Logs", logs.render());
            clipboard.setPrimaryClip(clip);
            Toast.makeText(this, getString(R.string.log_copied), Toast.LENGTH_SHORT).show();
            appendLog("日志已复制到剪贴板。");
        }
    }

    private void clearLogs() {
        logText.setText(getString(R.string.no_logs));
        Toast.makeText(this, "日志已清空", Toast.LENGTH_SHORT).show();
    }

    private static boolean isTerminalPairingStatus(V2PairingSessionStore.Status status) {
        return status == V2PairingSessionStore.Status.COMPLETED
            || status == V2PairingSessionStore.Status.CANCELLED
            || status == V2PairingSessionStore.Status.EXPIRED;
    }

    private void setPendingPairingAction(boolean pending) {
        boolean changed = hasPendingPairingAction != pending;
        hasPendingPairingAction = pending;
        if (devicesTab != null) {
            devicesTab.setText(pending ? "设备 · 待确认" : "设备");
            devicesTab.setContentDescription(pending ? "设备，有待确认的安全配对" : "设备");
        }
        if (changed && !pending && !transferActive) {
            renderSendState();
        }
    }

    private boolean isLogScrolledToBottom() {
        if (logScroll == null || logScroll.getChildCount() == 0 || logScroll.getHeight() == 0) return true;
        View content = logScroll.getChildAt(0);
        int remaining = content.getBottom() - (logScroll.getScrollY() + logScroll.getHeight());
        return remaining <= dp(24);
    }

    private TextView navigationTab(String label, int tab) {
        TextView view = text(label, 15, COLOR_MUTED, Typeface.BOLD);
        view.setGravity(Gravity.CENTER);
        view.setClickable(true);
        view.setFocusable(true);
        view.setMinHeight(dp(48));
        view.setOnClickListener(ignored -> selectTab(tab));
        return view;
    }

    private void selectTab(int tab) {
        selectedTab = tab;
        boolean showTransfer = tab == TAB_TRANSFER;
        boolean showDevices = tab == TAB_DEVICES;
        boolean showLibraries = tab == TAB_LIBRARIES;
        boolean showSettings = tab == TAB_SETTINGS;
        transferSection.setVisibility(showTransfer ? View.VISIBLE : View.GONE);
        devicesSection.setVisibility(showDevices ? View.VISIBLE : View.GONE);
        librariesSection.setVisibility(showLibraries ? View.VISIBLE : View.GONE);
        settingsSection.setVisibility(showSettings ? View.VISIBLE : View.GONE);
        styleNavigationTab(transferTab, showTransfer);
        styleNavigationTab(devicesTab, showDevices);
        styleNavigationTab(librariesTab, showLibraries);
        styleNavigationTab(settingsTab, showSettings);
        contentScroll.post(() -> contentScroll.scrollTo(0, 0));
        if (tab == TAB_LIBRARIES) {
            refreshLibrariesList(false);
            startLibraryEventsSubscription();
        } else {
            stopLibraryEventsSubscription();
        }
        if (tab == TAB_SETTINGS && logScroll != null && logFollowLatest) {
            logScroll.post(() -> logScroll.fullScroll(View.FOCUS_DOWN));
        }
        if (tab != TAB_DEVICES && hasPendingPairingAction && !transferActive) {
            statusText.setText("安全配对待确认，请打开“设备”页。");
        }
    }

    private void styleNavigationTab(TextView tab, boolean selected) {
        tab.setSelected(selected);
        tab.setTextColor(selected ? Color.WHITE : COLOR_MUTED);
        tab.setBackground(rounded(selected ? COLOR_NAVY : Color.TRANSPARENT, dp(6)));
    }

    private long lastBackPressTime = 0;

    @Override
    public void onBackPressed() {
        if (selectedTab == TAB_LIBRARIES && libraryCurrentSubPath != null && !libraryCurrentSubPath.isEmpty()) {
            navigateToParentDirectory();
            return;
        }
        if (selectedTab != TAB_TRANSFER) {
            selectTab(TAB_TRANSFER);
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackPressTime < 2000) {
            super.onBackPressed();
        } else {
            lastBackPressTime = now;
            Toast.makeText(this, "再按一次退出附近传输", Toast.LENGTH_SHORT).show();
        }
    }

    private void addSectionTitle(LinearLayout parent, String title) {
        TextView titleText = text(title, 18, COLOR_TEXT, Typeface.BOLD);
        titleText.setPadding(0, 0, 0, dp(12));
        parent.addView(titleText, matchWrap());
    }

    private LinearLayout card(int color) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(14), dp(14), dp(14), dp(14));
        card.setBackground(roundedStroke(color, dp(8), COLOR_BORDER, 1));
        card.setElevation(dp(1));
        return card;
    }

    private TextView pill(String value, int background, int textColor) {
        TextView view = text(value, 13, textColor, Typeface.BOLD);
        view.setGravity(Gravity.CENTER);
        view.setPadding(dp(12), dp(7), dp(12), dp(7));
        view.setBackground(rounded(background, dp(999)));
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
        button.setBackground(rounded(background, dp(8)));
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
        params.setMargins(0, 0, 0, dp(10));
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

    private String getProtocolDisplayName(String proto) {
        if (PROTOCOL_TURBO.equals(proto)) return getString(R.string.protocol_turbo_title);
        if (PROTOCOL_QUIC.equals(proto)) return getString(R.string.protocol_quic_title);
        if (PROTOCOL_SMB.equals(proto)) return getString(R.string.protocol_smb_title);
        if (PROTOCOL_WEBDAV.equals(proto)) return getString(R.string.protocol_webdav_title);
        if (PROTOCOL_V1.equals(proto)) return getString(R.string.protocol_v1_title);
        if (PROTOCOL_FTPS.equals(proto)) return getString(R.string.protocol_ftps_title);
        return getString(R.string.protocol_v2_title);
    }

    private String getProtocolSummary(String proto) {
        if (PROTOCOL_TURBO.equals(proto)) return getString(R.string.protocol_turbo_desc);
        if (PROTOCOL_QUIC.equals(proto)) return getString(R.string.protocol_quic_desc);
        if (PROTOCOL_SMB.equals(proto)) return getString(R.string.protocol_smb_desc);
        if (PROTOCOL_WEBDAV.equals(proto)) return getString(R.string.protocol_webdav_desc);
        if (PROTOCOL_V1.equals(proto)) return getString(R.string.protocol_v1_desc);
        if (PROTOCOL_FTPS.equals(proto)) return getString(R.string.protocol_ftps_desc);
        return getString(R.string.protocol_v2_desc);
    }

    private void showProtocolSelectionDialog() {
        String[] protocolKeys = new String[] {
            PROTOCOL_V2,
            PROTOCOL_TURBO,
            PROTOCOL_QUIC,
            PROTOCOL_SMB,
            PROTOCOL_WEBDAV,
            PROTOCOL_V1,
            PROTOCOL_FTPS
        };
        String[] items = new String[] {
            getString(R.string.protocol_v2_title) + "\n" + getString(R.string.protocol_v2_desc),
            getString(R.string.protocol_turbo_title) + "\n" + getString(R.string.protocol_turbo_desc),
            getString(R.string.protocol_quic_title) + "\n" + getString(R.string.protocol_quic_desc),
            getString(R.string.protocol_smb_title) + "\n" + getString(R.string.protocol_smb_desc),
            getString(R.string.protocol_webdav_title) + "\n" + getString(R.string.protocol_webdav_desc),
            getString(R.string.protocol_v1_title) + "\n" + getString(R.string.protocol_v1_desc),
            getString(R.string.protocol_ftps_title) + "\n" + getString(R.string.protocol_ftps_desc)
        };
        int currentIndex = 0;
        for (int i = 0; i < protocolKeys.length; i++) {
            if (protocolKeys[i].equals(currentProtocol)) {
                currentIndex = i;
                break;
            }
        }
        new AlertDialog.Builder(this)
            .setTitle(getString(R.string.dialog_select_protocol_title))
            .setSingleChoiceItems(items, currentIndex, (dialog, which) -> {
                currentProtocol = protocolKeys[which];
                getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .putString(PREF_TRANSFER_PROTOCOL, currentProtocol)
                    .apply();
                if (protocolBadgeText != null) {
                    protocolBadgeText.setText(getProtocolDisplayName(currentProtocol));
                }
                if (protocolDescText != null) {
                    protocolDescText.setText(getProtocolSummary(currentProtocol));
                }
                Toast.makeText(this, getString(R.string.protocol_switched_format, getProtocolDisplayName(currentProtocol)), Toast.LENGTH_SHORT).show();
                appendLog(getString(R.string.protocol_switched_format, getProtocolDisplayName(currentProtocol)));
                dialog.dismiss();
            })
            .setNegativeButton(getString(R.string.dialog_cancel), null)
            .show();
    }
}

