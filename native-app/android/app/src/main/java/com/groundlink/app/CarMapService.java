package com.groundlink.app;

import android.content.Intent;
import android.net.http.HttpResponseCache;
import androidx.annotation.NonNull;
import androidx.car.app.CarAppService;
import androidx.car.app.Screen;
import androidx.car.app.Session;
import androidx.car.app.validation.HostValidator;
import java.io.File;

/**
 * The GroundLink map on the Android Auto screen (Android 1.5.0, 2026-11-25).
 *
 * Declared as a NAVIGATION app because that is the only kind Android Auto lets draw its own map.
 * It is a private build for Jace and a few others, installed from the download link with Android
 * Auto's "Unknown sources" on; it is not meant for the Play Store (Google requires turn-by-turn).
 */
public class CarMapService extends CarAppService {
    @Override
    public void onCreate() {
        super.onCreate();
        CarLog.installCrashHook();
        try { android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0); CarLog.app = pi.versionName + " (" + pi.versionCode + ")"; } catch (Exception e) {}
        CarLog.step("service created");
        // Map pictures survive a restart and a dead zone: Esri tiles are cached on disk.
        try {
            if (HttpResponseCache.getInstalled() == null)
                HttpResponseCache.install(new File(getCacheDir(), "car-tiles"), 80L * 1024 * 1024);
        } catch (Exception e) {}
        // 1.5.10: map pictures kept on the phone for no-signal use; trim the oldest past ~400 MB.
        final File td = new File(getFilesDir(), "car-tiles-keep");
        CarMapRenderer.tileDir = td;
        new Thread(() -> { try { trimTiles(td, 400L << 20, 320L << 20); } catch (Throwable e) {} }).start();
    }
    private static void trimTiles(File dir, long max, long target) {
        java.util.List<File> all = new java.util.ArrayList<>();
        java.util.ArrayDeque<File> st = new java.util.ArrayDeque<>(); st.push(dir);
        long total = 0;
        while (!st.isEmpty()) {
            File[] ls = st.pop().listFiles(); if (ls == null) continue;
            for (File f : ls) { if (f.isDirectory()) st.push(f); else { all.add(f); total += f.length(); } }
        }
        if (total <= max) return;
        java.util.Collections.sort(all, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (File f : all) { if (total <= target) break; total -= f.length(); f.delete(); }
    }

    @NonNull
    @Override
    public HostValidator createHostValidator() {
        return HostValidator.ALLOW_ALL_HOSTS_VALIDATOR;
    }

    @NonNull
    @Override
    public Session onCreateSession() {
        return new Session() {
            @NonNull
            @Override
            public Screen onCreateScreen(@NonNull Intent intent) {
                CarLog.step("session: creating screen, host api " + getCarContext().getCarAppApiLevel());
                try {
                    return new CarMapScreen(getCarContext());
                } catch (Throwable t) {
                    CarLog.error("onCreateScreen", t);
                    return CarMapScreen.errorScreen(getCarContext(), t);
                }
            }
        };
    }
}
