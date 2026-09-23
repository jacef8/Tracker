import UIKit

/// What a gimbal control does in this app.
enum GimbalAction: String, CaseIterable {
    case record, zoomIn, zoomOut, stop, flip

    var label: String {
        switch self {
        case .record: return "Record / pause / resume"
        case .zoomIn: return "Zoom in"
        case .zoomOut: return "Zoom out"
        case .stop: return "Stop and save"
        case .flip: return "Flip camera"
        }
    }
}

/// One physical input the app can receive from a Bluetooth gimbal.
///
/// Paired over plain Bluetooth, an Osmo Mobile acts as a HID remote. iOS delivers its shutter
/// either as a volume-button press (which camera apps receive through AVCaptureEventInteraction)
/// or as a keyboard key (received through UIKit presses). DJI doesn't document which codes each
/// control sends, so the defaults cover the usual ones and the setup panel can learn the rest.
enum GimbalInput: Hashable {
    case volumeUp
    /// Volume down, plus Camera Control on iPhone 16 and later, which iOS reports the same way.
    case volumeDown
    case key(Int)

    var storageKey: String {
        switch self {
        case .volumeUp: return "volumeUp"
        case .volumeDown: return "volumeDown"
        case .key(let code): return "key:\(code)"
        }
    }

    init?(storageKey: String) {
        switch storageKey {
        case "volumeUp": self = .volumeUp
        case "volumeDown": self = .volumeDown
        default:
            guard storageKey.hasPrefix("key:"), let code = Int(storageKey.dropFirst(4)) else { return nil }
            self = .key(code)
        }
    }

    var name: String {
        switch self {
        case .volumeUp: return "Volume Up"
        case .volumeDown: return "Volume Down"
        case .key(let code):
            if let known = GimbalInput.keyNames[code] { return known }
            return "Key \(code)"
        }
    }

    private static let keyNames: [Int: String] = {
        typealias U = UIKeyboardHIDUsage
        let pairs: [(U, String)] = [
            (.keyboardReturnOrEnter, "Enter"), (.keypadEnter, "Keypad Enter"),
            (.keyboardSpacebar, "Space"), (.keyboardEscape, "Escape"),
            (.keyboardUpArrow, "Up"), (.keyboardDownArrow, "Down"),
            (.keyboardLeftArrow, "Left"), (.keyboardRightArrow, "Right"),
            (.keyboardPageUp, "Page Up"), (.keyboardPageDown, "Page Down"),
            (.keyboardVolumeUp, "Volume Up key"), (.keyboardVolumeDown, "Volume Down key"),
            (.keypadPlus, "Keypad +"), (.keypadHyphen, "Keypad −"),
            (.keyboardEqualSign, "="), (.keyboardHyphen, "−"),
        ]
        return Dictionary(uniqueKeysWithValues: pairs.map { ($0.0.rawValue, $0.1) })
    }()
}

/// Maps [GimbalInput]s to [GimbalAction]s and remembers what the user taught it.
final class GimbalKeyMap {
    private let defaultsKey = "gimbalKeyMap"
    private var map: [GimbalInput: GimbalAction] = [:]

    init() {
        if let stored = UserDefaults.standard.dictionary(forKey: defaultsKey) as? [String: String] {
            for (k, v) in stored {
                if let input = GimbalInput(storageKey: k), let action = GimbalAction(rawValue: v) {
                    map[input] = action
                }
            }
        } else {
            map = GimbalKeyMap.defaults
        }
    }

    func action(for input: GimbalInput) -> GimbalAction? { map[input] }

    func inputs(for action: GimbalAction) -> [GimbalInput] {
        map.filter { $0.value == action }.map(\.key).sorted { $0.name < $1.name }
    }

    func assign(_ input: GimbalInput, to action: GimbalAction) {
        map[input] = action
        save()
    }

    func reset() {
        map = GimbalKeyMap.defaults
        save()
    }

    private func save() {
        let dict = Dictionary(uniqueKeysWithValues: map.map { ($0.key.storageKey, $0.value.rawValue) })
        UserDefaults.standard.set(dict, forKey: defaultsKey)
    }

    static let defaults: [GimbalInput: GimbalAction] = {
        typealias U = UIKeyboardHIDUsage
        var m: [GimbalInput: GimbalAction] = [
            .volumeUp: .record,
            .volumeDown: .zoomOut,
        ]
        for u: U in [.keyboardReturnOrEnter, .keypadEnter, .keyboardSpacebar, .keyboardVolumeUp] {
            m[.key(u.rawValue)] = .record
        }
        for u: U in [.keyboardPageUp, .keyboardUpArrow, .keyboardRightArrow, .keypadPlus, .keyboardEqualSign] {
            m[.key(u.rawValue)] = .zoomIn
        }
        for u: U in [.keyboardPageDown, .keyboardDownArrow, .keyboardLeftArrow, .keypadHyphen,
                     .keyboardHyphen, .keyboardVolumeDown] {
            m[.key(u.rawValue)] = .zoomOut
        }
        m[.key(U.keyboardEscape.rawValue)] = .stop
        return m
    }()
}
