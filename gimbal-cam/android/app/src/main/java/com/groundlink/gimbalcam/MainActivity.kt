package com.groundlink.gimbalcam

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.view.Gravity
import android.hardware.input.InputManager
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.OrientationEventListener
import android.view.ScaleGestureDetector
import android.view.Surface
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.MediaStoreOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.core.content.ContextCompat
import com.groundlink.gimbalcam.databinding.ActivityMainBinding
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity() {

    private enum class RecState { IDLE, STARTING, RECORDING, PAUSED, STOPPING }

    private lateinit var binding: ActivityMainBinding
    private lateinit var keyMap: GimbalKeyMap
    private val handler = Handler(Looper.getMainLooper())

    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var videoCapture: VideoCapture<Recorder>? = null
    private var lensFacing = CameraSelector.LENS_FACING_BACK

    private var recording: Recording? = null
    private var recState = RecState.IDLE
    private var recordedNanos = 0L

    /** Linear zoom being shown, 0 = widest the lens allows, 1 = maximum zoom. */
    private var linearZoom = 0f
    /** Where the zoom is gliding to; gimbal input moves this, the animator follows it. */
    private var targetZoom = 0f
    private var zoomDirection = 0
    private var recordHoldFired = false

    /** Action waiting for its gimbal key in the setup panel, or null when not learning. */
    private var learning: GimbalAction? = null

    /** Recent inputs and what the app did with them, shown (and copyable) on the setup panel. */
    private val eventLog = ArrayDeque<String>()
    private var lastEventAt = 0L

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            if (result[Manifest.permission.CAMERA] == true) startCamera()
            else binding.status.text = "CAMERA PERMISSION NEEDED"
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        keyMap = GimbalKeyMap(this)

        binding.recordBtn.setOnClickListener { toggleRecord() }
        binding.stopBtn.setOnClickListener { stopRecording() }
        binding.flipBtn.setOnClickListener { flipCamera() }
        binding.buttonsBtn.setOnClickListener { showSetup(true) }
        binding.doneBtn.setOnClickListener { showSetup(false) }
        binding.resetBtn.setOnClickListener {
            keyMap.reset()
            learning = null
            log("Reset all buttons to defaults")
            renderSetup()
        }
        binding.copyLogBtn.setOnClickListener { copyLog() }
        setUpPinchZoom()
        orientationListener.enable()
        watchGimbalConnection()
        renderRecordUi()

        val needed = mutableListOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
            needed += Manifest.permission.WRITE_EXTERNAL_STORAGE
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) startCamera() else permissionLauncher.launch(missing.toTypedArray())
    }

    override fun onDestroy() {
        orientationListener.disable()
        getSystemService(InputManager::class.java).unregisterInputDeviceListener(inputDeviceListener)
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    // ── Camera ──────────────────────────────────────────────────────────────────────────────

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            cameraProvider = future.get()
            bindCamera()
        }, ContextCompat.getMainExecutor(this))
    }

    private fun bindCamera() {
        val provider = cameraProvider ?: return
        val preview = Preview.Builder().build().also {
            it.surfaceProvider = binding.preview.surfaceProvider
        }
        val recorder = Recorder.Builder()
            .setQualitySelector(
                QualitySelector.fromOrderedList(
                    listOf(Quality.FHD, Quality.UHD, Quality.HD),
                    FallbackStrategy.lowerQualityOrHigherThan(Quality.SD),
                )
            )
            .build()
        val capture = VideoCapture.withOutput(recorder)
        capture.targetRotation = binding.preview.display?.rotation ?: Surface.ROTATION_0
        videoCapture = capture

        val selector = CameraSelector.Builder().requireLensFacing(lensFacing).build()
        try {
            provider.unbindAll()
            camera = provider.bindToLifecycle(this, selector, preview, capture).also { cam ->
                cam.cameraInfo.zoomState.observe(this) { state ->
                    binding.zoomLabel.text = String.format(Locale.US, "%.1f×", state.zoomRatio)
                }
            }
            linearZoom = 0f
            targetZoom = 0f
            camera?.cameraControl?.setLinearZoom(0f)
        } catch (e: Exception) {
            binding.status.text = "CAMERA ERROR"
            Toast.makeText(this, "Couldn't open camera: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun flipCamera() {
        if (recState != RecState.IDLE) return
        lensFacing = if (lensFacing == CameraSelector.LENS_FACING_BACK) {
            CameraSelector.LENS_FACING_FRONT
        } else {
            CameraSelector.LENS_FACING_BACK
        }
        bindCamera()
    }

    /** Keeps the saved video upright whichever way the phone sits in the gimbal. */
    private val orientationListener by lazy {
        object : OrientationEventListener(this) {
            override fun onOrientationChanged(degrees: Int) {
                if (degrees == ORIENTATION_UNKNOWN) return
                // The rotation is fixed when a recording starts; changing it mid-file does nothing.
                if (recState != RecState.IDLE) return
                videoCapture?.targetRotation = when (degrees) {
                    in 45 until 135 -> Surface.ROTATION_270
                    in 135 until 225 -> Surface.ROTATION_180
                    in 225 until 315 -> Surface.ROTATION_90
                    else -> Surface.ROTATION_0
                }
            }
        }
    }

    // ── Recording: one tap starts, next pauses, next resumes; hold or ■ stops and saves ─────

    private fun toggleRecord() {
        when (recState) {
            RecState.IDLE -> startRecording()
            RecState.RECORDING -> recording?.pause()
            RecState.PAUSED -> recording?.resume()
            RecState.STARTING, RecState.STOPPING -> Unit
        }
    }

    @SuppressLint("MissingPermission") // audio is only enabled after checking the permission
    private fun startRecording() {
        val capture = videoCapture ?: return
        val name = "GimbalCam_" + SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, "video/mp4")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/GimbalCam")
            }
        }
        val output = MediaStoreOutputOptions.Builder(
            contentResolver, MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        ).setContentValues(values).build()

        var pending = capture.output.prepareRecording(this, output)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED
        ) {
            pending = pending.withAudioEnabled()
        }
        recState = RecState.STARTING
        recordedNanos = 0L
        renderRecordUi()
        recording = pending.start(ContextCompat.getMainExecutor(this), ::onRecordEvent)
    }

    private fun stopRecording() {
        if (recState == RecState.RECORDING || recState == RecState.PAUSED) {
            recState = RecState.STOPPING
            renderRecordUi()
            recording?.stop()
        }
    }

    private fun onRecordEvent(event: VideoRecordEvent) {
        when (event) {
            is VideoRecordEvent.Start -> { recState = RecState.RECORDING; log("Recording started") }
            is VideoRecordEvent.Pause -> { recState = RecState.PAUSED; log("Recording paused") }
            is VideoRecordEvent.Resume -> { recState = RecState.RECORDING; log("Recording resumed") }
            is VideoRecordEvent.Status -> recordedNanos = event.recordingStats.recordedDurationNanos
            is VideoRecordEvent.Finalize -> {
                recording = null
                recState = RecState.IDLE
                val saved = !event.hasError() ||
                    event.error == VideoRecordEvent.Finalize.ERROR_SOURCE_INACTIVE
                val msg = if (saved) "Saved to Movies/GimbalCam" else "Recording failed (error ${event.error})"
                log(msg + (event.cause?.message?.let { " — $it" } ?: ""))
                Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
            }
        }
        renderRecordUi()
    }

    private fun renderRecordUi() {
        val seconds = TimeUnit.NANOSECONDS.toSeconds(recordedNanos)
        val clock = String.format(Locale.US, "%02d:%02d", seconds / 60, seconds % 60)
        val b = binding
        when (recState) {
            RecState.IDLE -> {
                b.status.text = "READY"
                b.status.setTextColor(getColor(android.R.color.white))
            }
            RecState.STARTING -> b.status.text = "STARTING…"
            RecState.RECORDING -> {
                b.status.text = "● REC  $clock"
                b.status.setTextColor(getColor(R.color.rec_red))
            }
            RecState.PAUSED -> {
                b.status.text = "❚❚ PAUSED  $clock"
                b.status.setTextColor(getColor(R.color.paused_amber))
            }
            RecState.STOPPING -> b.status.text = "SAVING…"
        }

        val open = recState != RecState.IDLE
        b.stopBtn.visibility = if (open) View.VISIBLE else View.GONE
        b.flipBtn.visibility = if (open) View.INVISIBLE else View.VISIBLE
        when (recState) {
            RecState.RECORDING -> {
                // Showing "pause" while recording: the next press pauses.
                b.recordInner.setBackgroundResource(R.drawable.record_square)
                b.recordInner.layoutParams = b.recordInner.layoutParams.apply { width = dp(34); height = dp(34) }
                b.recordGlyph.text = "❚❚"
            }
            RecState.PAUSED -> {
                b.recordInner.setBackgroundResource(R.drawable.record_dot)
                b.recordInner.layoutParams = b.recordInner.layoutParams.apply { width = dp(62); height = dp(62) }
                b.recordGlyph.text = "▶"
            }
            else -> {
                b.recordInner.setBackgroundResource(R.drawable.record_dot)
                b.recordInner.layoutParams = b.recordInner.layoutParams.apply { width = dp(62); height = dp(62) }
                b.recordGlyph.text = ""
            }
        }
        b.recordInner.requestLayout()
    }

    // ── Zoom ────────────────────────────────────────────────────────────────────────────────

    /** Jump straight to [value] (pinch, camera switch). */
    private fun setZoom(value: Float) {
        linearZoom = value.coerceIn(0f, 1f)
        targetZoom = linearZoom
        camera?.cameraControl?.setLinearZoom(linearZoom)
    }

    /** Glide toward [value]: the gimbal wheel sends separate clicks, and jumping a whole step
     *  per click looked jerky, so each click moves the target and the preview eases after it. */
    private fun glideZoomTo(value: Float) {
        targetZoom = value.coerceIn(0f, 1f)
        handler.removeCallbacks(zoomGlide)
        handler.post(zoomGlide)
    }

    private val zoomGlide = object : Runnable {
        override fun run() {
            if (zoomDirection != 0) {
                targetZoom = (targetZoom + zoomDirection * ZOOM_RAMP_PER_FRAME).coerceIn(0f, 1f)
            }
            val diff = targetZoom - linearZoom
            if (kotlin.math.abs(diff) < 0.001f && zoomDirection == 0) {
                linearZoom = targetZoom
                camera?.cameraControl?.setLinearZoom(linearZoom)
                return
            }
            linearZoom += diff * ZOOM_EASE
            camera?.cameraControl?.setLinearZoom(linearZoom)
            handler.postDelayed(this, FRAME_MS)
        }
    }

    /** One click of the gimbal wheel / one press of a zoom key. */
    private fun zoomStep(direction: Int) = glideZoomTo(targetZoom + direction * ZOOM_STEP)

    /** Held-down zoom: after a short pause, keep moving the target until release. */
    private val zoomHoldStart = Runnable {
        zoomDirection = pendingZoomDirection
        handler.removeCallbacks(zoomGlide)
        handler.post(zoomGlide)
    }
    private var pendingZoomDirection = 0

    private fun startZoom(direction: Int) {
        handler.removeCallbacks(zoomHoldStart)
        zoomStep(direction)
        pendingZoomDirection = direction
        handler.postDelayed(zoomHoldStart, HOLD_BEFORE_RAMP_MS)
    }

    private fun stopZoom() {
        handler.removeCallbacks(zoomHoldStart)
        zoomDirection = 0
    }

    private fun setUpPinchZoom() {
        val detector = ScaleGestureDetector(this, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(d: ScaleGestureDetector): Boolean {
                val cam = camera ?: return false
                val state = cam.cameraInfo.zoomState.value ?: return false
                cam.cameraControl.setZoomRatio(state.zoomRatio * d.scaleFactor)
                // Keep linearZoom in step so the next gimbal zoom continues from here.
                linearZoom = cam.cameraInfo.zoomState.value?.linearZoom ?: linearZoom
                targetZoom = linearZoom
                return true
            }
        })
        binding.preview.setOnTouchListener { v, e ->
            detector.onTouchEvent(e)
            if (e.action == MotionEvent.ACTION_UP) v.performClick()
            true
        }
    }

    // ── Gimbal input ────────────────────────────────────────────────────────────────────────

    private val recordHold = Runnable {
        recordHoldFired = true
        stopRecording()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = event.keyCode
        if (code in GimbalKeyMap.RESERVED) return super.dispatchKeyEvent(event)
        val sig = KeySignature.of(event)
        val action = keyMap.actionFor(sig)
        logKey(event, sig, action)
        // Input from a real device proves something is connected, whatever its device class.
        if (event.device?.isVirtual == false) binding.connectHint.visibility = View.GONE

        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            showLastKey(sig, action)
            learning?.let { learnAction ->
                keyMap.learnedConflict(sig, learnAction)?.let { other ->
                    log("⚠ This is the same signal as \"${other.label}\" — the gimbal sends " +
                        "identical input for both, so it can only do one of them.")
                }
                keyMap.assign(sig, learnAction)
                log("Learned ${sig.name} → ${learnAction.label}")
                learning = null
                renderSetup()
                return true
            }
        }
        // While the setup panel is open, gimbal keys only get shown, not acted on.
        if (binding.setupPanel.visibility == View.VISIBLE) {
            return action != null || super.dispatchKeyEvent(event)
        }

        if (action == null) return super.dispatchKeyEvent(event)
        when (event.action) {
            KeyEvent.ACTION_DOWN -> if (event.repeatCount == 0) onGimbalDown(action)
            KeyEvent.ACTION_UP -> onGimbalUp(action)
        }
        return true
    }

    private fun onGimbalDown(action: GimbalAction) {
        when (action) {
            GimbalAction.RECORD -> {
                recordHoldFired = false
                handler.postDelayed(recordHold, LONG_PRESS_MS)
            }
            GimbalAction.ZOOM_IN -> startZoom(+1)
            GimbalAction.ZOOM_OUT -> startZoom(-1)
            GimbalAction.STOP -> stopRecording()
            GimbalAction.FLIP -> flipCamera()
        }
    }

    private fun onGimbalUp(action: GimbalAction) {
        when (action) {
            GimbalAction.RECORD -> {
                handler.removeCallbacks(recordHold)
                if (!recordHoldFired) toggleRecord()
                recordHoldFired = false
            }
            GimbalAction.ZOOM_IN, GimbalAction.ZOOM_OUT -> stopZoom()
            else -> Unit
        }
    }

    /** Some controllers report a wheel as a scroll axis instead of keys. */
    override fun onGenericMotionEvent(event: MotionEvent): Boolean {
        if (event.action == MotionEvent.ACTION_SCROLL &&
            event.isFromSource(InputDevice.SOURCE_CLASS_POINTER)
        ) {
            val v = event.getAxisValue(MotionEvent.AXIS_VSCROLL)
            if (v != 0f) {
                log("Scroll ${"%.2f".format(v)} from ${event.device?.name ?: "unknown"}")
                zoomStep(if (v > 0) +1 else -1)
                return true
            }
        }
        return super.onGenericMotionEvent(event)
    }

    private val hideLastKey = Runnable { binding.lastKey.visibility = View.GONE }

    private fun showLastKey(sig: KeySignature, action: GimbalAction?) {
        val text = "${sig.name} → ${action?.label ?: "not assigned"}"
        binding.setupLastKey.text = text
        binding.lastKey.text = text
        binding.lastKey.visibility = View.VISIBLE
        handler.removeCallbacks(hideLastKey)
        handler.postDelayed(hideLastKey, 2500)
    }

    private fun logKey(event: KeyEvent, sig: KeySignature, action: GimbalAction?) {
        val kind = when (event.action) {
            KeyEvent.ACTION_DOWN -> if (event.repeatCount > 0) "repeat ${event.repeatCount}" else "down"
            KeyEvent.ACTION_UP -> "up"
            else -> "action ${event.action}"
        }
        // Repeats of a held key would flood the log; keep only the first few.
        if (event.repeatCount > 3) return
        log("$kind ${GimbalKeyMap.keyName(sig.keyCode)} (${sig.keyCode}) scan ${sig.scanCode} " +
            "[${sig.device}] → ${action?.label ?: "—"}")
    }

    private fun log(line: String) {
        val now = android.os.SystemClock.uptimeMillis()
        val gap = if (lastEventAt == 0L) 0L else now - lastEventAt
        lastEventAt = now
        eventLog.addLast(String.format(Locale.US, "+%5dms  %s", gap, line))
        while (eventLog.size > 40) eventLog.removeFirst()
        if (binding.setupPanel.visibility == View.VISIBLE) {
            binding.eventLog.text = eventLog.reversed().joinToString("\n")
        }
    }

    private fun copyLog() {
        val text = "Gimbal Cam ${BuildConfig.VERSION_NAME} on ${Build.MANUFACTURER} ${Build.MODEL} " +
            "(Android ${Build.VERSION.RELEASE})\n" + eventLog.joinToString("\n")
        val clipboard = getSystemService(android.content.ClipboardManager::class.java)
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Gimbal Cam log", text))
        Toast.makeText(this, "Log copied — paste it into your message", Toast.LENGTH_SHORT).show()
    }

    // ── Gimbal connection ───────────────────────────────────────────────────────────────────
    // The Osmo only links up after DJI Mimo connects it, so show whether its input device is
    // actually present rather than leaving "nothing happens" as the only clue.

    private var connectedNames = emptyList<String>()

    private val inputDeviceListener = object : InputManager.InputDeviceListener {
        override fun onInputDeviceAdded(id: Int) = refreshGimbalConnection()
        override fun onInputDeviceRemoved(id: Int) = refreshGimbalConnection()
        override fun onInputDeviceChanged(id: Int) = refreshGimbalConnection()
    }

    private fun watchGimbalConnection() {
        getSystemService(InputManager::class.java).registerInputDeviceListener(inputDeviceListener, handler)
        refreshGimbalConnection()
    }

    /** External (Bluetooth/USB) devices that send keys. Only knowable on Android 10+. */
    private fun externalKeyDevices(): List<String>? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        return InputDevice.getDeviceIds().toList()
            .mapNotNull { InputDevice.getDevice(it) }
            .filter { !it.isVirtual && it.isExternal && it.sources and InputDevice.SOURCE_KEYBOARD == InputDevice.SOURCE_KEYBOARD }
            .map { it.name }
            .distinct()
    }

    private fun refreshGimbalConnection() {
        val names = externalKeyDevices()
        if (names == null) {
            binding.gimbalStatus.text = "Press a gimbal button to check it's connected."
            binding.connectHint.visibility = View.GONE
            return
        }
        for (n in names - connectedNames.toSet()) log("Connected: $n")
        for (n in connectedNames - names.toSet()) log("Disconnected: $n")
        connectedNames = names
        if (names.isEmpty()) {
            binding.gimbalStatus.text = "✕ No gimbal connected"
            binding.gimbalStatus.setTextColor(getColor(R.color.paused_amber))
            binding.connectHint.visibility = View.VISIBLE
        } else {
            binding.gimbalStatus.text = "✓ Connected: " + names.joinToString(", ")
            binding.gimbalStatus.setTextColor(0xFF4CD964.toInt())
            binding.connectHint.visibility = View.GONE
        }
    }

    // ── Setup panel ─────────────────────────────────────────────────────────────────────────

    private fun showSetup(show: Boolean) {
        learning = null
        binding.setupPanel.visibility = if (show) View.VISIBLE else View.GONE
        if (show) {
            binding.eventLog.text = eventLog.reversed().joinToString("\n")
            renderSetup()
        }
    }

    private fun renderSetup() {
        val rows = binding.actionRows
        rows.removeAllViews()
        for (action in GimbalAction.entries) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(6), 0, dp(6))
            }
            val keys = keyMap.describe(action)
            val label = TextView(this).apply {
                text = buildString {
                    append(action.label)
                    append('\n')
                    append(if (keys.isEmpty()) "no button" else keys.joinToString("\n"))
                }
                setTextColor(getColor(android.R.color.white))
                textSize = 14f
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
            val learn = Button(this).apply {
                text = if (learning == action) "Press it…" else "Learn"
                setOnClickListener {
                    learning = if (learning == action) null else action
                    renderSetup()
                }
                // Long-press forgets what was learned for this action.
                setOnLongClickListener {
                    keyMap.clearLearned(action)
                    log("Cleared learned buttons for ${action.label}")
                    renderSetup()
                    true
                }
            }
            row.addView(label)
            row.addView(learn)
            rows.addView(row)
        }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val LONG_PRESS_MS = 800L
        private const val HOLD_BEFORE_RAMP_MS = 250L
        private const val FRAME_MS = 33L
        private const val ZOOM_STEP = 0.025f
        private const val ZOOM_RAMP_PER_FRAME = 0.005f
        /** Fraction of the remaining distance covered each frame while gliding. */
        private const val ZOOM_EASE = 0.18f
    }
}
