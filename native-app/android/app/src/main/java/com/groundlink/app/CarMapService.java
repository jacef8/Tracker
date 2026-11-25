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
        // Map pictures survive a restart and a dead zone: Esri tiles are cached on disk.
        try {
            if (HttpResponseCache.getInstalled() == null)
                HttpResponseCache.install(new File(getCacheDir(), "car-tiles"), 80L * 1024 * 1024);
        } catch (Exception e) {}
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
                return new CarMapScreen(getCarContext());
            }
        };
    }
}
