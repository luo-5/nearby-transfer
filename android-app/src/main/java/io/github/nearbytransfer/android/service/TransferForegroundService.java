package io.github.nearbytransfer.android.service;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import io.github.nearbytransfer.android.MainActivity;
import io.github.nearbytransfer.android.R;

public class TransferForegroundService extends Service {

    private static final String TAG = "TransferFgService";

    public static final String ACTION_START_TRANSFER = "io.github.nearbytransfer.action.START_TRANSFER";
    public static final String ACTION_UPDATE_PROGRESS = "io.github.nearbytransfer.action.UPDATE_PROGRESS";
    public static final String ACTION_STOP_TRANSFER = "io.github.nearbytransfer.action.STOP_TRANSFER";

    public static final String EXTRA_FILENAME = "extra_filename";
    public static final String EXTRA_TITLE = "extra_title";
    public static final String EXTRA_PROGRESS = "extra_progress";
    public static final String EXTRA_SPEED = "extra_speed";
    public static final String EXTRA_TASK_ID = "extra_task_id";
    public static final String EXTRA_IS_PAUSED = "extra_is_paused";

    public static final String ACTION_PAUSE_TRANSFER = "io.github.nearbytransfer.action.PAUSE_TRANSFER";
    public static final String ACTION_RESUME_TRANSFER = "io.github.nearbytransfer.action.RESUME_TRANSFER";
    public static final String ACTION_CANCEL_TRANSFER = "io.github.nearbytransfer.action.CANCEL_TRANSFER";

    private static final String CHANNEL_ID = "nearby_transfer_progress_channel";
    private static final int NOTIFICATION_ID = 7701;

    private NotificationManager notificationManager;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    public static boolean startTransfer(Context context, String filename, String title, int progressPercent, String speed) {
        return startTransfer(context, filename, title, progressPercent, speed, "", false);
    }

    public static boolean startTransfer(Context context, String filename, String title, int progressPercent, String speed, String taskId, boolean isPaused) {
        if (context == null) return false;
        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(ACTION_START_TRANSFER);
        intent.putExtra(EXTRA_FILENAME, filename);
        intent.putExtra(EXTRA_TITLE, title != null ? title : "正在传输文件");
        intent.putExtra(EXTRA_PROGRESS, progressPercent);
        intent.putExtra(EXTRA_SPEED, speed != null ? speed : "-");
        intent.putExtra(EXTRA_TASK_ID, taskId != null ? taskId : "");
        intent.putExtra(EXTRA_IS_PAUSED, isPaused);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Failed to start transfer foreground service", e);
            return false;
        }
    }

    public static boolean updateProgress(Context context, String filename, String title, int progressPercent, String speed) {
        return updateProgress(context, filename, title, progressPercent, speed, "", false);
    }

    public static boolean updateProgress(Context context, String filename, String title, int progressPercent, String speed, String taskId, boolean isPaused) {
        if (context == null) return false;
        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(ACTION_UPDATE_PROGRESS);
        intent.putExtra(EXTRA_FILENAME, filename);
        intent.putExtra(EXTRA_TITLE, title != null ? title : "正在传输文件");
        intent.putExtra(EXTRA_PROGRESS, progressPercent);
        intent.putExtra(EXTRA_SPEED, speed != null ? speed : "-");
        intent.putExtra(EXTRA_TASK_ID, taskId != null ? taskId : "");
        intent.putExtra(EXTRA_IS_PAUSED, isPaused);
        try {
            context.startService(intent);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Failed to update transfer progress notification", e);
            return false;
        }
    }

    public static boolean stopTransfer(Context context) {
        if (context == null) return false;
        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(ACTION_STOP_TRANSFER);
        try {
            context.startService(intent);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Failed to stop transfer foreground service", e);
            return false;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        createNotificationChannel();
        
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (powerManager != null) {
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NearbyTransfer:WakeLock");
        }
        WifiManager wifiManager = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifiManager != null) {
            wifiLock = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "NearbyTransfer:WifiLock");
            wifiLock.acquire();
        }
        if (wakeLock != null) {
            wakeLock.acquire(60 * 60 * 1000L);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP_TRANSFER.equals(intent.getAction())) {
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        String filename = intent.getStringExtra(EXTRA_FILENAME);
        String title = intent.getStringExtra(EXTRA_TITLE);
        int progress = intent.getIntExtra(EXTRA_PROGRESS, -1);
        String speed = intent.getStringExtra(EXTRA_SPEED);
        String taskId = intent.getStringExtra(EXTRA_TASK_ID);
        boolean isPaused = intent.getBooleanExtra(EXTRA_IS_PAUSED, false);

        Notification notification = buildNotification(filename, title, progress, speed, taskId, isPaused);

        if (ACTION_START_TRANSFER.equals(intent.getAction())) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } else if (ACTION_UPDATE_PROGRESS.equals(intent.getAction())) {
            if (notificationManager != null) {
                notificationManager.notify(NOTIFICATION_ID, notification);
            }
        }

        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
            wakeLock = null;
        }
        if (wifiLock != null && wifiLock.isHeld()) {
            wifiLock.release();
            wifiLock = null;
        }
    }

    private Notification buildNotification(String filename, String title, int progressPercent, String speed, String taskId, boolean isPaused) {
        Intent contentIntent = new Intent(this, MainActivity.class);
        contentIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, contentIntent,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT
        );

        String defaultContent = getString(R.string.notification_in_progress);
        String defaultTitle = getString(R.string.notification_transferring);
        String contentText = (filename != null ? filename : defaultContent) + (speed != null && !speed.isEmpty() ? " · " + speed : "");

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.app_icon)
            .setContentTitle(title != null ? title : defaultTitle)
            .setContentText(contentText)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW);

        if (progressPercent >= 0 && progressPercent <= 100) {
            builder.setProgress(100, progressPercent, false);
        } else {
            builder.setProgress(0, 0, true);
        }

        int pendingFlags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_UPDATE_CURRENT;

        if (isPaused) {
            Intent resumeIntent = new Intent(ACTION_RESUME_TRANSFER);
            resumeIntent.setPackage(getPackageName());
            if (taskId != null) resumeIntent.putExtra(EXTRA_TASK_ID, taskId);
            PendingIntent resumePending = PendingIntent.getBroadcast(this, 1, resumeIntent, pendingFlags);
            builder.addAction(new NotificationCompat.Action.Builder(0, "继续", resumePending).build());
        } else {
            Intent pauseIntent = new Intent(ACTION_PAUSE_TRANSFER);
            pauseIntent.setPackage(getPackageName());
            if (taskId != null) pauseIntent.putExtra(EXTRA_TASK_ID, taskId);
            PendingIntent pausePending = PendingIntent.getBroadcast(this, 2, pauseIntent, pendingFlags);
            builder.addAction(new NotificationCompat.Action.Builder(0, "暂停", pausePending).build());
        }

        Intent cancelIntent = new Intent(ACTION_CANCEL_TRANSFER);
        cancelIntent.setPackage(getPackageName());
        if (taskId != null) cancelIntent.putExtra(EXTRA_TASK_ID, taskId);
        PendingIntent cancelPending = PendingIntent.getBroadcast(this, 3, cancelIntent, pendingFlags);
        builder.addAction(new NotificationCompat.Action.Builder(0, "取消", cancelPending).build());

        return builder.build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription(getString(R.string.notification_channel_desc));
            channel.enableVibration(false);
            channel.enableLights(false);
            if (notificationManager != null) {
                notificationManager.createNotificationChannel(channel);
            }
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
