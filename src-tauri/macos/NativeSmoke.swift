#if NATIVE_SMOKE
import AppKit
import SwiftUI
import CryptoKit

// This file has no shipping code. CI explicitly opts into the Cargo feature.
@MainActor func startNativeSmoke(_ model: NativeModel) {
    guard let folder = ProcessInfo.processInfo.environment["KUROGANE_NATIVE_SMOKE_DIR"] else { return }
    Task { @MainActor in
        let vault = URL(fileURLWithPath:NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString + ".kurogane")
        defer { try? FileManager.default.removeItem(at:vault) }
        do {
            try await Task.sleep(nanoseconds:1_000_000_000)
            let enrollment = try await model.call("create_vault",["args":["path":vault.path,"displayName":"Issen Infrastructure","password":"native-smoke-password-2026","kdf":"standard","account":"CI"]]) as? Row ?? [:]
            try await model.refresh()
            precondition(model.unlocked)
            model.sheet = NativeSheet(kind:"create")
            let pairingCode = try nativeSmokeCode(enrollment.text("secretBase32"))
            try await model.finishPairing(pairingCode)
            precondition(model.sheet == nil && model.status.flag("totpRequired"))
            _ = try await model.call("totp_disable",["code":pairingCode])
            try await model.refresh()
            var company = blankEntity("tenant"); company["name"] = "Issen Software Group"
            try await model.save("tenant",try normalized("tenant",company))
            let companyID = model.selected!.id
            var machine = blankEntity("host"); machine["name"] = "Atlas"; machine["tenantId"] = companyID; machine["fqdn"] = "atlas.issen.local"
            var nic = blankEntity("interface"); nic["internalIp"] = "10.0.0.10"; nic["isPrimary"] = true; machine["interfaces"] = [nic]
            try await model.save("host",try normalized("host",machine))
            let machineID = model.selected!.id
            var service = blankEntity("service"); service["hostId"] = machineID; service["name"] = "Gitea"; service["image"] = "gitea/gitea:latest"
            var port = blankEntity("port"); port["containerPort"] = 3000; port["hostPort"] = 3000; port["isPrimary"] = true; service["ports"] = [port]
            try await model.save("service",try normalized("service",service))
            let serviceID = model.selected!.id
            var proxy = blankEntity("proxy"); proxy["hostId"] = machineID; proxy["name"] = "Caddy"; proxy["kind"] = "caddy"
            var route = blankEntity("route"); route["domain"] = "git.issen.local"; route["targetIp"] = "10.0.0.10"; route["targetPort"] = 3000; route["serviceId"] = serviceID; route["targetHostId"] = machineID; proxy["routes"] = [route]
            try await model.save("proxy",try normalized("proxy",proxy))
            var network = blankEntity("network"); network["tenantId"] = companyID; network["name"] = "Private LAN"; network["cidr"] = "10.0.0.0/24"
            try await model.save("network",try normalized("network",network))
            var credential = try normalized("credential",blankEntity("credential").merging(["label":"root","username":"root"]) { _,new in new })
            credential["id"] = NSNull(); credential["owner"] = ["kind":"host","id":machineID]; credential["secret"] = ["set":"fixture-only-secret"]; credential["privateKey"] = "keep"; credential["notes"] = "keep"
            try await model.save("credential",credential)
            let accountID = model.selected!.id
            let secret = try await model.call("reveal_secret",["credentialId":accountID,"field":"secret"]) as? String
            precondition(secret == "fixture-only-secret")
            let impact = try await model.call("delete_impact",["kind":"tenant","id":companyID]) as? Row ?? [:]
            precondition(impact.number("hosts") == 1 && impact.number("credentials") == 1 && impact.number("routes") == 1)
            _ = try await model.call("update_settings",["settings":["displayName":"Issen Infrastructure","lockTimeoutSecs":300,"clipboardClearSecs":30,"lockOnSuspend":true]])
            _ = try await model.call("lock")
            do { _ = try await model.call("topology"); throw NativeFailure(message:"Locked inventory remained accessible") } catch let failure as NativeFailure { if failure.message == "Locked inventory remained accessible" { throw failure } }
            _ = try await model.call("unlock",["password":"native-smoke-password-2026","totp":NSNull()])
            try await model.refresh()
            precondition(model.rows("host").count == 1 && model.rows("service").count == 1 && model.rows("credential").first?.flag("hasSecret") == true)
            model.selected = NativeItem(kind:"service",id:serviceID)
            for _ in 0..<100 { if model.graphReady { break }; try await Task.sleep(nanoseconds:100_000_000) }
            precondition(model.graphReady,"The shared topology renderer did not connect")
            try await Task.sleep(nanoseconds:500_000_000)
            let nodes = try await model.graph.webView?.evaluateJavaScript("document.querySelectorAll('[data-node]').length") as? Int ?? 0
            precondition(nodes >= 3,"The original topology graph did not render the inventory")
            if let window = model.window {
                window.setContentSize(NSSize(width:960,height:640))
                try await Task.sleep(nanoseconds:500_000_000)
                if let graph = model.graph.webView, let container = graph.superview {
                    precondition(abs(graph.frame.width-container.bounds.width) < 1 && abs(graph.frame.height-container.bounds.height) < 1,"Graph escaped its native pane")
                }
                let visible = try await model.graph.webView?.evaluateJavaScript("(() => { const node = document.querySelector('[data-node=\"svc:\(serviceID)\"]'); if (!node) return false; const rect = node.getBoundingClientRect(); return rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight; })()") as? Bool ?? false
                precondition(visible,"Selected service is outside the graph viewport")
                window.setContentSize(NSSize(width:1440,height:900))
                for theme in ["light","dark"] {
                    model.appearance = theme; model.applyAppearance()
                    try await Task.sleep(nanoseconds:500_000_000)
                    let data = try await nativeCapture(window)
                    try data.write(to:URL(fileURLWithPath:folder).appendingPathComponent("native-integrated-\(theme).png"))
                }
            }
            model.status = try await model.call("close_vault") as? Row ?? [:]
            try FileManager.default.removeItem(at:vault)
            print("Native bridge integration passed: encrypted vault, authenticator pairing dismissal, all entity types, credential reveal, dependency impact, settings, lock and reopen")
            exit(0)
        } catch {
            _ = try? await model.call("lock")
            try? FileManager.default.removeItem(at:vault)
            fputs("Native bridge integration failed: \(error.localizedDescription)\n",stderr)
            exit(1)
        }
    }
}
func nativeSmokeCode(_ base32: String) throws -> String {
    let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".utf8)
    var bits: UInt32 = 0, count = 0
    var secret = Data()
    for character in base32.uppercased().utf8 where character != 61 {
        guard let digit = alphabet.firstIndex(of:character) else { throw NativeFailure(message:"Invalid fixture TOTP seed") }
        bits = (bits << 5) | UInt32(digit); count += 5
        if count >= 8 { count -= 8; secret.append(UInt8((bits >> count) & 255)) }
    }
    var counter = UInt64(Date().timeIntervalSince1970 / 30).bigEndian
    let data = withUnsafeBytes(of:&counter) { Data($0) }
    let digest = Array(HMAC<Insecure.SHA1>.authenticationCode(for:data,using:SymmetricKey(data:secret)))
    let offset = Int(digest.last! & 15)
    let number = (UInt32(digest[offset] & 127) << 24) | (UInt32(digest[offset+1]) << 16) | (UInt32(digest[offset+2]) << 8) | UInt32(digest[offset+3])
    return String(format:"%06d",Int(number % 1_000_000))
}
#endif
