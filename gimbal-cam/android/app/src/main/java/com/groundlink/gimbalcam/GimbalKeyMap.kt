package com.groundlink.gimbalcam

import android.content.Context
import android.view.KeyEvent

/** What a gimbal control does in this app. */
enum class GimbalAction(val label: String) {
    RECORD("Record / pause / resume"),
    ZOOM_IN("Zoom in"),
    ZOOM_OUT("Zoom out"),
    STOP("Stop and save"),
    FLIP("Flip camera"),
}

/**
 * Maps the key codes a Bluetooth gimbal sends to [GimbalAction]s.
 *
 * Paired over plain Bluetooth, an Osmo Mobile shows up to Android as a HID input device, so its
 * buttons arrive as ordinary [KeyEvent]s. DJI doesn't document which key codes each control
 * sends (and they can differ between firmware versions), so the defaults below cover every code
 * a camera remote commonly uses, and the setup panel lets you teach the app the real ones.
 */
class GimbalKeyMap(context: Context) {

    private val prefs = context.getSharedPreferences("gimbal_keys", Context.MODE_PRIVATE)
    private val map = mutableMapOf<Int, GimbalAction>()

    init {
        load()
    }

    fun actionFor(keyCode: Int): GimbalAction? = map[keyCode]

    fun keysFor(action: GimbalAction): List<Int> = map.filterValues { it == action }.keys.sorted()

    /** Binds [keyCode] to [action], replacing whatever that key did before. */
    fun assign(keyCode: Int, action: GimbalAction) {
        map[keyCode] = action
        save()
    }

    fun reset() {
        map.clear()
        map.putAll(DEFAULTS)
        save()
    }

    private fun load() {
        val stored = prefs.getString(PREF_KEY, null)
        if (stored == null) {
            map.putAll(DEFAULTS)
            return
        }
        stored.split(',').filter { it.isNotBlank() }.forEach { entry ->
            val (code, name) = entry.split('=').takeIf { it.size == 2 } ?: return@forEach
            val action = GimbalAction.entries.firstOrNull { it.name == name } ?: return@forEach
            code.toIntOrNull()?.let { map[it] = action }
        }
    }

    private fun save() {
        prefs.edit()
            .putString(PREF_KEY, map.entries.joinToString(",") { "${it.key}=${it.value.name}" })
            .apply()
    }

    companion object {
        private const val PREF_KEY = "map"

        /** Keys the app never takes over, so the phone stays usable. */
        val RESERVED = setOf(
            KeyEvent.KEYCODE_BACK,
            KeyEvent.KEYCODE_HOME,
            KeyEvent.KEYCODE_POWER,
            KeyEvent.KEYCODE_APP_SWITCH,
        )

        val DEFAULTS: Map<Int, GimbalAction> = buildMap {
            // Shutter / record: camera remotes typically send Volume Up, Camera, Enter or a
            // media play/pause key.
            listOf(
                KeyEvent.KEYCODE_VOLUME_UP,
                KeyEvent.KEYCODE_CAMERA,
                KeyEvent.KEYCODE_FOCUS,
                KeyEvent.KEYCODE_MEDIA_RECORD,
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
                KeyEvent.KEYCODE_MEDIA_PLAY,
                KeyEvent.KEYCODE_MEDIA_PAUSE,
                KeyEvent.KEYCODE_HEADSETHOOK,
                KeyEvent.KEYCODE_ENTER,
                KeyEvent.KEYCODE_NUMPAD_ENTER,
                KeyEvent.KEYCODE_DPAD_CENTER,
                KeyEvent.KEYCODE_SPACE,
            ).forEach { put(it, GimbalAction.RECORD) }

            listOf(
                KeyEvent.KEYCODE_ZOOM_IN,
                KeyEvent.KEYCODE_PAGE_UP,
                KeyEvent.KEYCODE_DPAD_UP,
                KeyEvent.KEYCODE_DPAD_RIGHT,
                KeyEvent.KEYCODE_MEDIA_NEXT,
                KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
                KeyEvent.KEYCODE_PLUS,
                KeyEvent.KEYCODE_NUMPAD_ADD,
            ).forEach { put(it, GimbalAction.ZOOM_IN) }

            listOf(
                KeyEvent.KEYCODE_ZOOM_OUT,
                KeyEvent.KEYCODE_VOLUME_DOWN,
                KeyEvent.KEYCODE_PAGE_DOWN,
                KeyEvent.KEYCODE_DPAD_DOWN,
                KeyEvent.KEYCODE_DPAD_LEFT,
                KeyEvent.KEYCODE_MEDIA_PREVIOUS,
                KeyEvent.KEYCODE_MEDIA_REWIND,
                KeyEvent.KEYCODE_MINUS,
                KeyEvent.KEYCODE_NUMPAD_SUBTRACT,
            ).forEach { put(it, GimbalAction.ZOOM_OUT) }

            put(KeyEvent.KEYCODE_MEDIA_STOP, GimbalAction.STOP)
            put(KeyEvent.KEYCODE_ESCAPE, GimbalAction.STOP)
        }

        fun keyName(keyCode: Int): String =
            KeyEvent.keyCodeToString(keyCode).removePrefix("KEYCODE_").replace('_', ' ')
    }
}
