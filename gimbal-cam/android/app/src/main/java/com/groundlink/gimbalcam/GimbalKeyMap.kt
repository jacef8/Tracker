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
 * Exactly which input arrived: the Android key code plus the hardware scan code and the name of
 * the device that sent it. Two gimbal controls can share a key code (e.g. both "Volume Up") yet
 * differ in scan code or come from different HID interfaces, so learning keys on all three.
 */
data class KeySignature(val keyCode: Int, val scanCode: Int, val device: String) {
    fun encode() = "$keyCode|$scanCode|$device"

    val name: String
        get() = "${GimbalKeyMap.keyName(keyCode)} (scan $scanCode, $device)"

    companion object {
        fun of(event: KeyEvent) = KeySignature(
            event.keyCode,
            event.scanCode,
            (event.device?.name ?: "unknown").replace('|', '/').replace(',', ' ').replace('=', ' '),
        )

        fun decode(s: String): KeySignature? {
            val parts = s.split('|', limit = 3)
            if (parts.size != 3) return null
            val code = parts[0].toIntOrNull() ?: return null
            val scan = parts[1].toIntOrNull() ?: return null
            return KeySignature(code, scan, parts[2])
        }
    }
}

/**
 * Maps the keys a Bluetooth gimbal sends to [GimbalAction]s.
 *
 * Paired over plain Bluetooth, an Osmo Mobile shows up to Android as a HID input device, so its
 * buttons arrive as ordinary [KeyEvent]s. DJI doesn't document which key codes each control
 * sends, so the defaults below cover the codes camera remotes commonly use, and the setup panel
 * learns the real ones. Learned bindings match on the full [KeySignature] and win over the
 * defaults, which match on key code alone.
 */
class GimbalKeyMap(context: Context) {

    private val prefs = context.getSharedPreferences("gimbal_keys", Context.MODE_PRIVATE)
    private val learned = mutableMapOf<KeySignature, GimbalAction>()

    init {
        load()
    }

    fun actionFor(sig: KeySignature): GimbalAction? =
        learned[sig] ?: DEFAULTS[sig.keyCode]

    /** What the setup panel lists next to [action]. */
    fun describe(action: GimbalAction): List<String> {
        val learnedNames = learned.filterValues { it == action }.keys.map { it.name }
        val defaultNames = DEFAULTS.keys
            .filter { code -> DEFAULTS[code] == action }
            .filter { code -> learned.keys.none { it.keyCode == code } }
            .sorted()
            .map { keyName(it) }
        return learnedNames + defaultNames
    }

    /** The action [sig] is already bound to by learning, if it's a different one. */
    fun learnedConflict(sig: KeySignature, action: GimbalAction): GimbalAction? =
        learned[sig]?.takeIf { it != action }

    /**
     * Binds [sig] to [action]. Other learned inputs for [action] are kept, so a zoom wheel that
     * sends two different keys can be taught both.
     */
    fun assign(sig: KeySignature, action: GimbalAction) {
        learned[sig] = action
        save()
    }

    fun clearLearned(action: GimbalAction) {
        learned.entries.removeAll { it.value == action }
        save()
    }

    fun reset() {
        learned.clear()
        save()
    }

    private fun load() {
        prefs.getString(PREF_LEARNED, null)?.split('\n')?.forEach { line ->
            val eq = line.lastIndexOf('=')
            if (eq <= 0) return@forEach
            val sig = KeySignature.decode(line.substring(0, eq)) ?: return@forEach
            val action = GimbalAction.entries.firstOrNull { it.name == line.substring(eq + 1) } ?: return@forEach
            learned[sig] = action
        }
    }

    private fun save() {
        prefs.edit()
            // v1 stored a code-only map under "map"; it's dropped so old bindings can't
            // shadow the new learned ones.
            .remove("map")
            .putString(PREF_LEARNED, learned.entries.joinToString("\n") { "${it.key.encode()}=${it.value.name}" })
            .apply()
    }

    companion object {
        private const val PREF_LEARNED = "learned_v2"

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
