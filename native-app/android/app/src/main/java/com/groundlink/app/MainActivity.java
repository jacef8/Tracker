package com.groundlink.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private AudioRouter audioRouter;

    // ── Car-radio fix ──────────────────────────────────────────────────────
    // WebView voice (LiveKit/WebRTC) makes Chromium flip Android into
    // MODE_IN_COMMUNICATION, which opens a Bluetooth HFP/SCO link — a car reads
    // that as an incoming PHONE CALL and mutes the FM/media. While voice is active
    // we hold MODE_NORMAL and tear down SCO, so receive audio plays over A2DP media
    // and the radio keeps playing. The web app drives this via window.GLAudioRouter
    // (voice.js calls startMediaMode() on connect, stopMediaMode() on leave). We
    // re-assert whenever something flips the mode back.
    static class AudioRouter {
        private final Context ctx;
        private final AudioManager am;
        private final Handler handler = new Handler(Looper.getMainLooper());
        private boolean active = false;
        private Object modeListener; // AudioManager.OnModeChangedListener (API 31+)
        private final Runnable poll = new Runnable() {
            @Override public void run() {
                if (!active) return;
                applyOnce();
                handler.postDelayed(this, 1500);
            }
        };

        AudioRouter(Context c) {
            ctx = c.getApplicationContext();
            am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        }

        @JavascriptInterface
        public void startMediaMode() {
            if (am == null) return;
            handler.post(new Runnable() { @Override public void run() {
                active = true;
                applyOnce();
                if (Build.VERSION.SDK_INT >= 31) {
                    if (modeListener == null) {
                        AudioManager.OnModeChangedListener l = new AudioManager.OnModeChangedListener() {
                            @Override public void onModeChanged(int mode) {
                                if (active && mode != AudioManager.MODE_NORMAL) applyOnce();
                            }
                        };
                        modeListener = l;
                        try { am.addOnModeChangedListener(ctx.getMainExecutor(), l); } catch (Exception e) {}
                    }
                } else {
                    handler.removeCallbacks(poll);
                    handler.postDelayed(poll, 1500);
                }
            }});
        }

        @JavascriptInterface
        public void stopMediaMode() {
            if (am == null) return;
            handler.post(new Runnable() { @Override public void run() {
                active = false;
                handler.removeCallbacks(poll);
                if (modeListener != null && Build.VERSION.SDK_INT >= 31) {
                    try { am.removeOnModeChangedListener((AudioManager.OnModeChangedListener) modeListener); } catch (Exception e) {}
                    modeListener = null;
                }
            }});
        }

        private void applyOnce() {
            try {
                if (hasExternalAudioOut()) {
                    // A car/Bluetooth or wired output is connected: hold MODE_NORMAL and tear down
                    // SCO so a vehicle plays voice as A2DP media and the FM/radio isn't muted.
                    if (am.getMode() != AudioManager.MODE_NORMAL) am.setMode(AudioManager.MODE_NORMAL);
                    if (Build.VERSION.SDK_INT >= 31) {
                        try { am.clearCommunicationDevice(); } catch (Exception e) {}
                    } else {
                        if (am.isBluetoothScoOn()) am.setBluetoothScoOn(false);
                        try { am.stopBluetoothSco(); } catch (Exception e) {}
                    }
                } else {
                    // No external audio device → force the phone's built-in LOUDSPEAKER. Android
                    // treats WebRTC as a call and defaults voice to the EARPIECE; this pushes it
                    // to the speaker so the walkie-talkie is hands-free.
                    if (Build.VERSION.SDK_INT >= 31) {
                        try {
                            AudioDeviceInfo spk = findOutput(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
                            AudioDeviceInfo cur = am.getCommunicationDevice();
                            if (spk != null && (cur == null || cur.getType() != AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)) {
                                am.setCommunicationDevice(spk);
                            }
                        } catch (Exception e) {}
                    } else {
                        if (!am.isSpeakerphoneOn()) am.setSpeakerphoneOn(true);
                    }
                }
            } catch (Exception e) {}
        }

        // Is any Bluetooth (car/headset) or wired output currently connected?
        private boolean hasExternalAudioOut() {
            try {
                for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                    switch (d.getType()) {
                        case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
                        case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                        case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                        case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                        case AudioDeviceInfo.TYPE_USB_HEADSET:
                            return true;
                    }
                }
            } catch (Exception e) {}
            return false;
        }

        private AudioDeviceInfo findOutput(int type) {
            try {
                for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                    if (d.getType() == type) return d;
                }
            } catch (Exception e) {}
            return null;
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Never let the Android WebView serve a stale copy of the app page from its own
        // HTTP cache. Freshness/offline are handled by the service worker (network-first
        // with a timeout fallback), so the WebView itself should always go to the network.
        try {
            WebSettings settings = this.getBridge().getWebView().getSettings();
            settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        } catch (Exception e) {
            // If anything is unavailable, fall back to default behavior.
        }
        // Push-to-talk voice uses the WebView's getUserMedia, which needs the RECORD_AUDIO
        // *runtime* permission — declaring it in the manifest is not enough on Android 6+.
        // Nothing was requesting it, so the mic was silently blocked with no system prompt.
        // Ask for it up front; Android only shows the dialog if it isn't already granted.
        try {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{ Manifest.permission.RECORD_AUDIO }, 4731);
            }
        } catch (Exception e) {
            // Non-fatal — voice just won't have mic access until granted in app settings.
        }
        // Expose the car-radio audio router to the web app (voice.js).
        try {
            audioRouter = new AudioRouter(this);
            this.getBridge().getWebView().addJavascriptInterface(audioRouter, "GLAudioRouter");
        } catch (Exception e) {
            // If the bridge/WebView isn't ready, voice still works — it just won't keep the radio on.
        }
        hideNavBar();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Re-hide after the bar transiently returns (dialogs, swipe-to-reveal, app resume).
        if (hasFocus) hideNavBar();
    }

    // Immersive: hide the bottom Android navigation bar so the map uses the full screen.
    // The status bar (clock/battery) stays. Swipe up from the bottom edge reveals the nav
    // bar briefly, then it auto-hides again (BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE).
    private void hideNavBar() {
        try {
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
            if (c != null) {
                c.hide(WindowInsetsCompat.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } catch (Exception e) {
            // Older devices / unexpected state — just leave the bars as they are.
        }
    }
}
