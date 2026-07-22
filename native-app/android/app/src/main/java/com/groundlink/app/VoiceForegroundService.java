package com.groundlink.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.NotificationCompat;

/**
 * Foreground service whose only job is to keep the WebView's LiveKit voice pipeline alive and
 * receiving audio while the app is backgrounded. Without a declared microphone/media-playback
 * foreground service, Android is free to throttle or suspend real-time audio the moment the
 * Activity loses foreground state — confirmed as the cause of "audio doesn't come through unless
 * the app is open." The background-geolocation plugin's own foreground service only declares
 * foregroundServiceType="location", which doesn't cover this. Mirrors the watch's own
 * LocationService, which already solves the identical problem for its side of the pipeline.
 *
 * Started/stopped by voice.js (via GLAudioRouter.startVoiceService/stopVoiceService) for as long
 * as ANY voice room is connected — not just during active speech bursts, since the goal is
 * reliable reception for the whole session, not just audio-routing correctness during a burst.
 */
public class VoiceForegroundService extends Service {
    private static final String TAG = "GLVoiceSvc";
    // Two FIXED channel IDs instead of one channel whose importance we tried to change in place.
    // Channel importance is locked once created (Android deliberately won't let an app silently
    // re-escalate it), so the first version of this deleted+recreated the SAME channel ID on
    // every toggle — confirmed as the actual crash: toggling the icon off while the service's
    // notification was still actively posted under that channel raced deleteNotificationChannel()
    // against the OS's own handling of the live notification. Two static channels sidesteps the
    // delete entirely — toggling just switches which channel ID the notification uses.
    private static final String CHAN_VISIBLE = "groundlink_voice";
    private static final String CHAN_HIDDEN = "groundlink_voice_quiet";
    private static final int NOTIF_ID = 43;
    private static final String PREFS = "groundlink_voice_svc";
    private static final String PREF_ICON_VISIBLE = "icon_visible";

    public static void start(Context ctx) {
        try {
            Intent i = new Intent(ctx, VoiceForegroundService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Exception e) {
            // Android 12+ can refuse a foreground-service start from certain background states.
            // Never let starting/nudging this service crash the app that's just trying to keep
            // voice working — worst case here is degraded background reception, not a crash.
            Log.e(TAG, "start() failed", e);
        }
    }

    public static void stop(Context ctx) {
        try { ctx.stopService(new Intent(ctx, VoiceForegroundService.class)); } catch (Exception e) { Log.e(TAG, "stop() failed", e); }
    }

    // The foreground service itself can't be hidden entirely (that notification is the whole
    // OS-level trade-off for staying alive unthrottled), but its status-bar ICON specifically
    // can be removed by lowering the channel's importance to MIN. Persisted so it applies the
    // NEXT time the service starts even if set in a prior session, and reapplied immediately if
    // the service is already running right now.
    public static void setIconVisible(Context ctx, boolean visible) {
        try {
            prefs(ctx).edit().putBoolean(PREF_ICON_VISIBLE, visible).apply();
            // Nudge the already-running service (if any) to rebuild its notification. A plain
            // start() re-enters onStartCommand, which re-derives everything from prefs.
            start(ctx);
        } catch (Exception e) { Log.e(TAG, "setIconVisible() failed", e); }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Belt-and-suspenders: an uncaught exception ANYWHERE in a Service lifecycle callback
        // crashes the whole app process, same as an uncaught exception in an Activity — there's
        // no per-service sandboxing. This service's entire job is a reliability nicety for voice;
        // it should never be the thing that takes the app down if something in notification
        // building goes wrong on some OEM skin we haven't seen.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    startForeground(
                        NOTIF_ID, buildNotification(),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                    );
                } catch (Exception e) {
                    // Mic type can be refused if RECORD_AUDIO isn't granted yet — fall back so the
                    // service still runs (still helps keep the process/media session alive).
                    Log.w(TAG, "typed startForeground failed, falling back", e);
                    startForeground(NOTIF_ID, buildNotification());
                }
            } else {
                startForeground(NOTIF_ID, buildNotification());
            }
        } catch (Exception e) {
            Log.e(TAG, "onStartCommand failed entirely — stopping self rather than crashing", e);
            try { stopSelf(); } catch (Exception e2) { /* nothing more we can do */ }
        }
        return START_STICKY;
    }

    private Notification buildNotification() {
        boolean iconVisible = prefs(this).getBoolean(PREF_ICON_VISIBLE, false);
        String chanId = iconVisible ? CHAN_VISIBLE : CHAN_HIDDEN;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                int importance = iconVisible ? NotificationManager.IMPORTANCE_LOW : NotificationManager.IMPORTANCE_MIN;
                // Distinct names + called unconditionally (not just when missing) — same fix and
                // same reasoning as HeadlessTrackerService.buildNotification(): both channels
                // showed as identical "Voice" entries in Settings > Notifications > Categories
                // with no way to tell them apart (confirmed confusing on-device 2026-07-21), and
                // createNotificationChannel() is safe/idempotent to re-call on an existing
                // channel — only importance is locked, name/description still update.
                NotificationChannel ch = new NotificationChannel(chanId, iconVisible ? "Voice (status icon)" : "Voice (silent)", importance);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }
        PendingIntent pi = null;
        try {
            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
            pi = PendingIntent.getActivity(this, 0, launch, flags);
        } catch (Exception e) { /* notification still works without a tap target */ }
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, chanId)
            .setContentTitle("GroundLink voice active")
            .setContentText("Listening for transmissions")
            .setSmallIcon(R.drawable.ic_stat_groundlink)
            .setOngoing(true)
            .setPriority(iconVisible ? NotificationCompat.PRIORITY_LOW : NotificationCompat.PRIORITY_MIN);
        if (pi != null) b.setContentIntent(pi);
        return b.build();
    }
}
