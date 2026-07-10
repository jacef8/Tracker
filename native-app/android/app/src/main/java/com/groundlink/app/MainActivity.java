package com.groundlink.app;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

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
        // Only re-logged when the external/internal classification actually CHANGES (or on the
        // first applyOnce() of a session) — the poll runs every 1.5s the whole time voice is
        // connected, and logging every tick would burn through the rotating slot log in seconds.
        private Boolean lastLoggedExternal = null;
        private String lastExternalType = null; // set as a side effect of hasExternalAudioOut()
        private final Runnable poll = new Runnable() {
            @Override public void run() {
                if (!active) return;
                applyOnce();
                handler.postDelayed(this, 1500);
            }
        };

        private final WebView webView;

        AudioRouter(Context c, WebView wv) {
            ctx = c.getApplicationContext();
            am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            webView = wv;
        }

        // Confirmed via real-device testing (adb input tap + Firebase-logged DOM state) on an
        // Android 16 device: a JS style mutation (e.g. settings-sheet display:none -> block) can
        // update the DOM/CSSOM correctly -- getComputedStyle shows display:block, opacity:1,
        // visibility:visible, correct on-screen bounds -- while the WebView's compositor never
        // actually repaints the screen, even after a forced scroll. This is a WebView renderer bug,
        // not anything wrong in our JS. Forcing View.invalidate() (and, as a stronger fallback,
        // briefly toggling the WebView's layer type to bounce it out of hardware-accelerated
        // compositing and back) is the standard native-side workaround for a WebView stuck in
        // exactly this state. Called from JS right after any full-screen sheet's display is
        // flipped, so the user never has to manually force-close/reopen the app to see it.
        @JavascriptInterface
        public void forceRepaint() {
            if (webView == null) return;
            webView.post(new Runnable() {
                @Override public void run() {
                    try {
                        webView.invalidate();
                        int prevLayerType = webView.getLayerType();
                        webView.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
                        webView.post(new Runnable() {
                            @Override public void run() {
                                try { webView.setLayerType(prevLayerType, null); webView.invalidate(); } catch (Exception e) {}
                            }
                        });
                    } catch (Exception e) {}
                }
            });
        }

        // Tied to "any voice room connected" (see voice.js _syncVoiceService), not to active
        // speech like startMediaMode/stopMediaMode above — the goal here is reliable background
        // RECEPTION for the whole session, not just audio-routing correctness during a burst.
        @JavascriptInterface
        public void startVoiceService() {
            try { VoiceForegroundService.start(ctx); } catch (Exception e) {}
        }

        @JavascriptInterface
        public void stopVoiceService() {
            try { VoiceForegroundService.stop(ctx); } catch (Exception e) {}
        }

        // User setting (Settings → "Voice notification icon"). The foreground service itself
        // can't be hidden entirely — that's the whole OS-level trade-off for staying alive
        // unthrottled in the background — but its notification's IMPORTANCE can be lowered to
        // MIN, which removes the status-bar icon specifically while the service keeps running.
        // Stored so VoiceForegroundService can read it independently of any particular JS call.
        @JavascriptInterface
        public void setVoiceNotificationVisible(boolean visible) {
            try { VoiceForegroundService.setIconVisible(ctx, visible); } catch (Exception e) {}
        }

        @JavascriptInterface
        public void startMediaMode() {
            if (am == null) return;
            logAudio("start-media-mode sdk=" + Build.VERSION.SDK_INT);
            handler.post(new Runnable() { @Override public void run() {
                active = true;
                lastLoggedExternal = null;   // force a fresh log line for this session
                applyOnce();
                // Re-assert continuously — WebRTC/Chromium keep flipping the audio mode, so a light
                // 1.5s poll (plus the mode-change listener on API 31+) keeps our routing pinned.
                handler.removeCallbacks(poll);
                handler.postDelayed(poll, 1500);
                if (Build.VERSION.SDK_INT >= 31 && modeListener == null) {
                    AudioManager.OnModeChangedListener l = new AudioManager.OnModeChangedListener() {
                        @Override public void onModeChanged(int mode) { if (active) applyOnce(); }
                    };
                    modeListener = l;
                    try { am.addOnModeChangedListener(ctx.getMainExecutor(), l); } catch (Exception e) {}
                }
            }});
        }

        @JavascriptInterface
        public void stopMediaMode() {
            if (am == null) return;
            logAudio("stop-media-mode");
            handler.post(new Runnable() { @Override public void run() {
                active = false;
                handler.removeCallbacks(poll);
                if (modeListener != null && Build.VERSION.SDK_INT >= 31) {
                    try { am.removeOnModeChangedListener((AudioManager.OnModeChangedListener) modeListener); } catch (Exception e) {}
                    modeListener = null;
                }
                // Voice is done → hand the phone back to normal audio.
                try {
                    if (Build.VERSION.SDK_INT >= 31) { try { am.clearCommunicationDevice(); } catch (Exception e) {} }
                    else { if (am.isSpeakerphoneOn()) am.setSpeakerphoneOn(false); }
                    if (am.getMode() != AudioManager.MODE_NORMAL) am.setMode(AudioManager.MODE_NORMAL);
                } catch (Exception e) {}
            }});
        }

        private void applyOnce() {
            try {
                boolean external = hasExternalAudioOut();
                boolean justChanged = (lastLoggedExternal == null || lastLoggedExternal != external);
                lastLoggedExternal = external;
                if (justChanged) {
                    logAudio("applyOnce external=" + external
                        + (external ? " type=" + lastExternalType : "")
                        + " modeBefore=" + am.getMode());
                }
                if (external) {
                    // A car/Bluetooth or wired output is connected: hold MODE_NORMAL and tear down
                    // SCO so a vehicle plays voice as A2DP media and the FM/radio isn't muted.
                    // Every call here is guarded (only touch the system API if something is
                    // actually different from what we want) EXCEPT this one used to be
                    // unconditional -- calling clearCommunicationDevice() every single 1.5s
                    // cycle even when there was nothing to clear, which briefly interrupts the
                    // active audio route each time. That's the likely cause of periodic music
                    // "ducking" reported on Android Auto: this poll runs continuously the whole
                    // time voice/auto-listen is connected in a car, which is most of a drive.
                    if (am.getMode() != AudioManager.MODE_NORMAL) am.setMode(AudioManager.MODE_NORMAL);
                    if (Build.VERSION.SDK_INT >= 31) {
                        try { if (am.getCommunicationDevice() != null) am.clearCommunicationDevice(); } catch (Exception e) {}
                    } else {
                        if (am.isBluetoothScoOn()) {
                            am.setBluetoothScoOn(false);
                            try { am.stopBluetoothSco(); } catch (Exception e) {}
                        }
                    }
                } else {
                    // No external audio device → force COMMUNICATION mode + the built-in LOUDSPEAKER.
                    // WebRTC otherwise flip-flops between a media stream (speaker) and a voice stream
                    // (earpiece); pinning MODE_IN_COMMUNICATION + speakerphone keeps the walkie-talkie
                    // consistently loud on the phone's own speaker.
                    if (am.getMode() != AudioManager.MODE_IN_COMMUNICATION) am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                    String setResult = "n/a(pre-31)";
                    if (Build.VERSION.SDK_INT >= 31) {
                        try {
                            AudioDeviceInfo spk = findOutput(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
                            AudioDeviceInfo cur = am.getCommunicationDevice();
                            if (spk == null) {
                                setResult = "no-speaker-device-found";
                            } else if (cur == null || cur.getType() != AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                                boolean ok = am.setCommunicationDevice(spk);
                                AudioDeviceInfo after = am.getCommunicationDevice();
                                setResult = "setCommunicationDevice(ok=" + ok + ") after=" + (after != null ? after.getType() : "null");
                            } else {
                                setResult = "already-speaker";
                            }
                        } catch (Exception e) { setResult = "threw:" + e.getMessage(); }
                    }
                    try { if (!am.isSpeakerphoneOn()) am.setSpeakerphoneOn(true); } catch (Exception e) {}
                    if (justChanged) {
                        // Fires once per session, right after the attempt, with the ACTUAL result —
                        // this is the line that answers "did forcing the speaker really take
                        // effect" instead of assuming it did.
                        logAudio("applyOnce result=" + setResult + " speakerphoneOnAfter=" + am.isSpeakerphoneOn());
                    }
                }
            } catch (Exception e) {}
        }

        // Is a real MEDIA audio device (car stereo / earbuds / wired / USB / Android Auto)
        // connected? Originally an ALLOWLIST of specific types (Bluetooth A2DP, wired headset,
        // etc) — but a truck's Android Auto can connect via other types too (USB accessory mode,
        // dock, automotive bus, BLE audio), and missing even one meant the app wrongly concluded
        // "no car connected" and forced communication/call mode — reported as "Android Auto still
        // thinks it's a phone call." Flipped to a DENYLIST instead: anything that ISN'T the
        // phone's own built-in speaker/earpiece (or the watch's Bluetooth SCO link, or an internal
        // virtual device) counts as external, so no future car connection type can slip through.
        private boolean hasExternalAudioOut() {
            lastExternalType = null;
            try {
                for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                    switch (d.getType()) {
                        case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                        case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                        case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:   // a paired smartwatch — user wants the phone speaker, not diverted
                        case AudioDeviceInfo.TYPE_TELEPHONY:
                        case AudioDeviceInfo.TYPE_REMOTE_SUBMIX:   // internal (screen recording etc), not a real output
                            continue;
                    }
                    lastExternalType = String.valueOf(d.getType());   // which type actually tripped this — diagnostic only
                    return true;   // anything else — A2DP, wired, USB, dock, automotive bus, BLE audio, Android Auto — is external
                }
            } catch (Exception e) {}
            return false;
        }

        // Rotating 40-slot debug log at gl/_debug/phoneAudioLog/<slot> — mirrors the watch's own
        // voiceLog pattern (gl rules are wide open, no auth needed). Lets audio-routing decisions
        // be pulled and read after the fact instead of needing a live logcat session, which is
        // exactly what made diagnosing the watch's cellular-vs-Bluetooth confusion tractable.
        private void logAudio(String event) {
            new Thread(() -> {
                try {
                    SharedPreferences p = ctx.getSharedPreferences("groundlink_audio_dbg", Context.MODE_PRIVATE);
                    int n = p.getInt("slotCounter", 0);
                    p.edit().putInt("slotCounter", n + 1).apply();
                    int slot = n % 40;
                    String json = "{\"ts\":" + System.currentTimeMillis() + ",\"event\":\""
                        + event.replace("\\", "\\\\").replace("\"", "\\\"") + "\"}";
                    HttpURLConnection c = (HttpURLConnection) new URL(
                        "https://tracker-58b87-default-rtdb.firebaseio.com/gl/_debug/phoneAudioLog/" + slot + ".json"
                    ).openConnection();
                    c.setRequestMethod("PUT");
                    c.setDoOutput(true);
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(8000);
                    c.setRequestProperty("Content-Type", "application/json");
                    try (java.io.OutputStream os = c.getOutputStream()) {
                        os.write(json.getBytes(StandardCharsets.UTF_8));
                    }
                    c.getInputStream().close();
                    c.disconnect();
                } catch (Exception e) { /* best-effort diagnostic only */ }
            }).start();
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
            audioRouter = new AudioRouter(this, this.getBridge().getWebView());
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
