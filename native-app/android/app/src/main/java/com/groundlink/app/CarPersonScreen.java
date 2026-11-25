package com.groundlink.app;

import android.content.Intent;
import android.net.Uri;
import androidx.annotation.NonNull;
import androidx.car.app.CarContext;
import androidx.car.app.CarToast;
import androidx.car.app.Screen;
import androidx.car.app.model.Action;
import androidx.car.app.model.MessageTemplate;
import androidx.car.app.model.Template;
import java.util.Locale;

/**
 * Tapped a crew member on the truck map (Android 1.5.1): who, how they're doing, how far, and a
 * Directions button that hands their spot to the car's navigation app (Google Maps by default).
 */
public class CarPersonScreen extends Screen {
    private final String name, line;
    private final double lat, lng;

    CarPersonScreen(@NonNull CarContext ctx, String name, String line, double lat, double lng) {
        super(ctx);
        this.name = name == null || name.isEmpty() ? "Crew member" : name;
        this.line = line == null || line.isEmpty() ? "On the map" : line;
        this.lat = lat; this.lng = lng;
    }

    @NonNull
    @Override
    public Template onGetTemplate() {
        Action go = new Action.Builder().setTitle("Directions").setOnClickListener(this::directions).build();
        return new MessageTemplate.Builder(line)
            .setTitle(name)
            .setHeaderAction(Action.BACK)
            .addAction(go)
            .build();
    }

    private void directions() {
        String q = String.format(Locale.US, "%.6f,%.6f", lat, lng);
        try {
            getCarContext().startCarApp(new Intent(CarContext.ACTION_NAVIGATE, Uri.parse("geo:" + q + "?q=" + q)));
        } catch (Exception e) {
            CarToast.makeText(getCarContext(), "Couldn't open directions", CarToast.LENGTH_LONG).show();
        }
    }
}
