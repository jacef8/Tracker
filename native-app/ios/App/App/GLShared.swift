import Foundation
import Security

/// The write config the app and its LocationPush extension share (iOS 1.0.17).
///
/// The extension is a separate process with its own sandbox, so it cannot read the app's
/// UserDefaults. The config -- who this phone is, which crews it reports to, and the signed-in
/// session it writes as -- is mirrored into a keychain group both targets list in their
/// entitlements. A keychain group needs no App Group registered in the developer portal.
///
/// This file is compiled into BOTH targets (App and LocationPush).
enum GLShared {
    /// Team prefix + group name. Must match keychain-access-groups in both entitlements files.
    static let accessGroup = "XM3MLRA366.com.groundlink.shared"
    private static let service = "com.groundlink.shared"
    private static let cfgAccount = "native_write_cfg"

    /// Store the web layer's __nativeWriteConfig() JSON. Readable after the first unlock since
    /// boot, so a location push that arrives while the phone is locked can still use it.
    static func saveConfig(_ json: String) {
        guard let data = json.data(using: .utf8) else { return }
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: cfgAccount,
            kSecAttrAccessGroup as String: accessGroup
        ]
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
        let st = SecItemUpdate(base as CFDictionary, update as CFDictionary)
        if st == errSecItemNotFound {
            var add = base
            add.merge(update) { _, new in new }
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    static func loadConfigJSON() -> String? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: cfgAccount,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// The config as a dictionary, only when it names at least one room to write to.
    static func loadConfig() -> [String: Any]? {
        guard let s = loadConfigJSON(), let d = s.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let rooms = o["rooms"] as? [String], !rooms.isEmpty else { return nil }
        return o
    }
}
