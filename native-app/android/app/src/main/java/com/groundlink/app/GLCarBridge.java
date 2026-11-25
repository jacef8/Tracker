package com.groundlink.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.InstallSourceInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * window.GLCar: how the phone app hands the truck map what it needs (Android 1.5.0, 2026-11-25).
 *
 * The truck screen (CarMapScreen) runs with no WebView and no database sign-in, so the page gives
 * it a small config whenever it changes: this phone's uid, the crew it is in, a car key per crew
 * (from the server's /api/car-keys, which only issues keys for crews the account belongs to), the
 * Follow-my-picks list per crew, people hidden on this phone, and Rename-for-me names.
 *
 * 1.5.4: installState() / installCarReady(). Android Auto refuses a Car App Library app unless
 * its install record says the Play Store installed it -- its "Unknown sources" setting does not
 * cover map apps (seen on Jace's phone, 2026-11-25: "CAR.VALIDATOR: Package DENIED; failed all
 * other checks"). Handing the APK to the phone's own package installer with the Play Store named
 * as installer records initiator = package installer, installer = Play Store, which Android Auto
 * accepts. Only ever offered on phones that have Android Auto; everyone else never sees it.
 */
public class GLCarBridge {
    static final String PREFS = "gl_car";
    static final String AA_PKG = "com.google.android.projection.gearhead";
    static final String PLAY = "com.android.vending";
    private final Context ctx;
    private volatile boolean busy = false;

    GLCarBridge(Context c) { ctx = c.getApplicationContext(); }

    @JavascriptInterface
    public void setConfig(String json) {
        if (json == null || json.length() > 200000) return;
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("cfg", json).apply();
    }

    @JavascriptInterface
    public int version() { return 2; }

    /** {aa, installer, initiator, ready, canInstall} as JSON. */
    @JavascriptInterface
    public String installState() {
        JSONObject o = new JSONObject();
        try {
            PackageManager pm = ctx.getPackageManager();
            boolean aa = false;
            try { pm.getPackageInfo(AA_PKG, 0); aa = true; } catch (Exception e) {}
            String installer = null, initiator = null;
            if (Build.VERSION.SDK_INT >= 30) {
                InstallSourceInfo si = pm.getInstallSourceInfo(ctx.getPackageName());
                installer = si.getInstallingPackageName();
                initiator = si.getInitiatingPackageName();
            } else {
                installer = pm.getInstallerPackageName(ctx.getPackageName());
            }
            // Android Auto reads the initiator; only when that is the system package installer
            // does it look at the recorded installer instead.
            boolean ready = PLAY.equals(installer) && (initiator == null || PLAY.equals(initiator)
                    || initiator.contains("packageinstaller"));
            o.put("aa", aa);
            o.put("installer", installer == null ? "" : installer);
            o.put("initiator", initiator == null ? "" : initiator);
            o.put("ready", ready);
            o.put("canInstall", Build.VERSION.SDK_INT < 26 || pm.canRequestPackageInstalls());
        } catch (Exception e) {
            try { o.put("err", String.valueOf(e)); } catch (Exception x) {}
        }
        return o.toString();
    }

    /** Download the APK at url and hand it to the system installer, naming the Play Store. */
    @JavascriptInterface
    public void installCarReady(final String url) {
        if (url == null || !url.startsWith("https://") || busy) return;
        final Handler ui = new Handler(Looper.getMainLooper());
        if (Build.VERSION.SDK_INT >= 26 && !ctx.getPackageManager().canRequestPackageInstalls()) {
            ui.post(() -> {
                toast("Turn on \"Allow from this source\" for GroundLink, then come back and tap Set up again.");
                try {
                    Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
                    s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(s);
                } catch (Exception e) {}
            });
            return;
        }
        busy = true;
        ui.post(() -> toast("Downloading GroundLink…"));
        new Thread(() -> {
            File f = new File(ctx.getCacheDir(), "gl-car-install.apk");
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(20000); c.setReadTimeout(60000); c.setUseCaches(false);
                if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(f)) {
                    byte[] b = new byte[64 * 1024]; int n;
                    while ((n = in.read(b)) > 0) out.write(b, 0, n);
                }
                if (f.length() < 1_000_000) throw new Exception("download too small");
                final Uri u = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
                ui.post(() -> {
                    try {
                        @SuppressWarnings("deprecation")
                        Intent i = new Intent(Intent.ACTION_INSTALL_PACKAGE);
                        i.setDataAndType(u, "application/vnd.android.package-archive");
                        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                        i.putExtra(Intent.EXTRA_INSTALLER_PACKAGE_NAME, PLAY);
                        i.putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true);
                        ctx.startActivity(i);
                    } catch (Exception e) {
                        toast("Couldn't open the installer: " + e.getMessage());
                    }
                    busy = false;
                });
            } catch (Exception e) {
                busy = false;
                ui.post(() -> toast("Download failed. Check your signal and try again."));
            }
        }).start();
    }

    private void toast(String m) { try { Toast.makeText(ctx, m, Toast.LENGTH_LONG).show(); } catch (Exception e) {} }
}
