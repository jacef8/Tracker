package com.groundlink.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.GeomagneticField;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.GnssStatus;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Raw GNSS and device sensors, exposed to the web app as window.GLSensors.
 *
 * This exists because the web platform gives a page a POSITION and nothing behind it: no
 * satellite list, no signal strengths, no barometer, no magnetometer. Those come from
 * GnssStatus and SensorManager, which only native code can reach. ANDROID ONLY, deliberately:
 * iOS does not expose raw satellite data to any app, native or otherwise, so there is no iOS
 * half of this to write. The web side checks for window.GLSensors and shows nothing when it
 * is absent, which is what every iPhone in the family will see.
 *
 * Everything is polled rather than pushed. The page asks when a screen that needs it is open
 * and stops asking when it closes, so nothing here runs while the app is just tracking --
 * these listeners are only registered between start() and stop().
 */
public class SensorBridge implements SensorEventListener {

    private final Context ctx;
    private final SensorManager sensors;
    private final LocationManager locs;
    private final Handler main = new Handler(Looper.getMainLooper());

    private boolean running = false;

    // Last values seen. Float.NaN means "this phone has not reported one", which the web side
    // renders as absent rather than as zero -- a barometer reading of 0 hPa is not a reading.
    private volatile float pressure = Float.NaN;
    private volatile float light = Float.NaN;
    private volatile float magnitude = Float.NaN;
    private volatile float gravity = Float.NaN;

    private volatile String satsJson = "[]";
    private volatile int satsUsed = 0;
    private volatile int satsSeen = 0;
    private volatile long satsAt = 0;

    private Object gnssCb;   // GnssStatus.Callback, held as Object so the class loads pre-N

    public SensorBridge(Context c) {
        this.ctx = c.getApplicationContext();
        this.sensors = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
        this.locs = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
    }

    private boolean hasFineLocation() {
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    /** Begin listening. Safe to call repeatedly. */
    @JavascriptInterface
    public void start() {
        if (running) return;
        running = true;
        main.post(new Runnable() {
            @Override public void run() {
                try { reg(Sensor.TYPE_PRESSURE); } catch (Exception e) { /* no barometer */ }
                try { reg(Sensor.TYPE_LIGHT); } catch (Exception e) { /* no light sensor */ }
                try { reg(Sensor.TYPE_MAGNETIC_FIELD); } catch (Exception e) { /* no magnetometer */ }
                try { reg(Sensor.TYPE_GRAVITY); } catch (Exception e) { /* no gravity sensor */ }
                try { startGnss(); } catch (Exception e) { /* no permission, or no GNSS */ }
            }
        });
    }

    private void reg(int type) {
        Sensor s = sensors.getDefaultSensor(type);
        if (s == null) return;
        // UI rate, not FASTEST. These feed a readout a person looks at, and the difference
        // between 60 Hz and 4 Hz here is battery spent on digits nobody can read that fast.
        sensors.registerListener(this, s, SensorManager.SENSOR_DELAY_UI);
    }

    /** Stop listening. Called when the screen using it closes, and from onPause. */
    @JavascriptInterface
    public void stop() {
        if (!running) return;
        running = false;
        main.post(new Runnable() {
            @Override public void run() {
                try { sensors.unregisterListener(SensorBridge.this); } catch (Exception e) {}
                try { stopGnss(); } catch (Exception e) {}
            }
        });
    }

    private void startGnss() {
        if (!hasFineLocation()) return;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;   // GnssStatus.Callback is N+
        if (gnssCb != null) return;
        GnssStatus.Callback cb = new GnssStatus.Callback() {
            @Override public void onSatelliteStatusChanged(GnssStatus st) {
                try { readSats(st); } catch (Exception e) { /* keep the last good snapshot */ }
            }
        };
        gnssCb = cb;
        locs.registerGnssStatusCallback(cb, main);
    }

    private void stopGnss() {
        if (gnssCb == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try { locs.unregisterGnssStatusCallback((GnssStatus.Callback) gnssCb); } catch (Exception e) {}
        }
        gnssCb = null;
    }

    private void readSats(GnssStatus st) throws Exception {
        int n = st.getSatelliteCount(), used = 0;
        JSONArray arr = new JSONArray();
        for (int i = 0; i < n; i++) {
            JSONObject o = new JSONObject();
            o.put("id", st.getSvid(i));
            o.put("con", constellation(st.getConstellationType(i)));
            o.put("cn0", Math.round(st.getCn0DbHz(i) * 10.0) / 10.0);   // signal, dB-Hz
            o.put("az", Math.round(st.getAzimuthDegrees(i)));
            o.put("el", Math.round(st.getElevationDegrees(i)));
            boolean u = st.usedInFix(i);
            o.put("used", u);
            if (u) used++;
            arr.put(o);
        }
        satsJson = arr.toString();
        satsUsed = used;
        satsSeen = n;
        satsAt = System.currentTimeMillis();
    }

    private static String constellation(int t) {
        switch (t) {
            case GnssStatus.CONSTELLATION_GPS:     return "GPS";
            case GnssStatus.CONSTELLATION_GLONASS: return "GLONASS";
            case GnssStatus.CONSTELLATION_GALILEO: return "Galileo";
            case GnssStatus.CONSTELLATION_BEIDOU:  return "BeiDou";
            case GnssStatus.CONSTELLATION_QZSS:    return "QZSS";
            case GnssStatus.CONSTELLATION_SBAS:    return "SBAS";
            case GnssStatus.CONSTELLATION_IRNSS:   return "NavIC";
            default:                               return "Other";
        }
    }

    @Override public void onSensorChanged(SensorEvent e) {
        switch (e.sensor.getType()) {
            case Sensor.TYPE_PRESSURE:       pressure = e.values[0]; break;
            case Sensor.TYPE_LIGHT:          light = e.values[0]; break;
            case Sensor.TYPE_GRAVITY:
                gravity = (float) Math.sqrt(e.values[0] * e.values[0]
                        + e.values[1] * e.values[1] + e.values[2] * e.values[2]);
                break;
            case Sensor.TYPE_MAGNETIC_FIELD:
                magnitude = (float) Math.sqrt(e.values[0] * e.values[0]
                        + e.values[1] * e.values[1] + e.values[2] * e.values[2]);
                break;
            default: break;
        }
    }

    @Override public void onAccuracyChanged(Sensor s, int acc) { /* not used */ }

    /** Everything the page needs, in one call, as JSON. */
    @JavascriptInterface
    public String read() {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("running", running);
            o.put("sats", new JSONArray(satsJson));
            o.put("used", satsUsed);
            o.put("seen", satsSeen);
            // How stale the satellite picture is. GnssStatus only fires while the GPS is
            // actually being used, so without this the page cannot tell a sky with no
            // satellites from a receiver that stopped reporting ten minutes ago.
            o.put("satsAgeMs", satsAt == 0 ? -1 : (System.currentTimeMillis() - satsAt));
            putNum(o, "pressure", pressure);        // hPa
            putNum(o, "light", light);              // lux
            putNum(o, "magnetic", magnitude);       // microtesla
            putNum(o, "gravity", gravity);          // m/s^2
            // Pressure altitude, from the standard atmosphere. Not GPS height and not ground
            // truth -- it moves with the weather, which is exactly why it is labelled as
            // pressure altitude on the screen rather than as "elevation".
            if (!Float.isNaN(pressure)) {
                o.put("pressureAltFt", Math.round(
                        SensorManager.getAltitude(SensorManager.PRESSURE_STANDARD_ATMOSPHERE, pressure)
                                * 3.28084));
            }
            // Magnetic declination at the last known position: the gap between the compass
            // needle and true north, which is several degrees in most of the US.
            try {
                if (hasFineLocation()) {
                    Location last = locs.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                    if (last == null) last = locs.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
                    if (last != null) {
                        GeomagneticField f = new GeomagneticField(
                                (float) last.getLatitude(), (float) last.getLongitude(),
                                (float) last.getAltitude(), System.currentTimeMillis());
                        o.put("declination", Math.round(f.getDeclination() * 10.0) / 10.0);
                    }
                }
            } catch (Exception ignored) { }
        } catch (Exception e) {
            return "{\"ok\":false}";
        }
        return o.toString();
    }

    private static void putNum(JSONObject o, String k, float v) throws Exception {
        if (!Float.isNaN(v)) o.put(k, Math.round(v * 100.0) / 100.0);
    }

    /** True when this device can report satellites at all. */
    @JavascriptInterface
    public boolean available() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && locs != null;
    }
}
