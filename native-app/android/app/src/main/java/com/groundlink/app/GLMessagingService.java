package com.groundlink.app;

import android.app.ActivityManager;
import android.content.Context;
import android.util.Log;
import androidx.annotation.NonNull;
import com.google.firebase.messaging.RemoteMessage;
import io.capawesome.capacitorjs.plugins.firebase.messaging.MessagingService;
import java.util.List;
import java.util.Map;

/**
 * The server's keep-alive sweep sends a high-priority "bump" data message to any phone whose
 * position has gone stale. The Capacitor messaging plugin only forwards messages to the web
 * layer, so with the app closed (process killed, Activity gone) that bump arrived and did
 * nothing — the phone stayed frozen on everyone's map until someone opened the app.
 *
 * This replaces the plugin's service (see AndroidManifest: the plugin's entry is removed) and
 * keeps its behaviour — every message still goes to the plugin — but ALSO starts
 * HeadlessTrackerService when a bump arrives and the visible app isn't in front. A
 * high-priority FCM message is one of the few things Android lets start a location
 * foreground service from the background.
 */
public class GLMessagingService extends MessagingService {
    private static final String TAG = "GLMessaging";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage msg) {
        try { super.onMessageReceived(msg); } catch (Exception e) { Log.w(TAG, "plugin forward failed", e); }
        try {
            Map<String, String> data = msg.getData();
            String type = data != null ? data.get("type") : null;
            if (!"bump".equals(type)) return;
            if (appInForeground(this)) {
                Log.i(TAG, "bump: app is in front — the in-app path handles it");
                return;
            }
            Log.i(TAG, "bump: app not in front — starting background tracker");
            HeadlessTrackerService.startActive(getApplicationContext());
        } catch (Exception e) {
            Log.e(TAG, "bump handling failed", e);
        }
    }

    static boolean appInForeground(Context ctx) {
        try {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return false;
            List<ActivityManager.RunningAppProcessInfo> procs = am.getRunningAppProcesses();
            if (procs == null) return false;
            for (ActivityManager.RunningAppProcessInfo p : procs) {
                if (p.processName.equals(ctx.getPackageName())) {
                    return p.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
                }
            }
        } catch (Exception e) {}
        return false;
    }
}
