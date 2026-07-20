package com.groundlink.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Starts HeadlessTrackerService (in ACTIVE mode) the instant the device finishes booting, with
 * no user action required — mirrors how Life360 and similar always-on apps auto-resume tracking
 * after a reboot. Without this, GroundLink stayed completely inert after every restart until a
 * human physically opened it (there was previously no boot entry point at all).
 *
 * Note: per Android's own design, a user-initiated "Force stop" of the app disables BOOT_COMPLETED
 * delivery until the app is manually opened at least once — there is no workaround for that,
 * and Life360 has the exact same limitation.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "GLBootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) return;
        try {
            HeadlessTrackerService.startActive(context);
        } catch (Exception e) {
            // Best-effort — a boot receiver crashing would be far worse than tracking simply not
            // auto-resuming after this particular reboot.
            Log.e(TAG, "onReceive failed", e);
        }
    }
}
