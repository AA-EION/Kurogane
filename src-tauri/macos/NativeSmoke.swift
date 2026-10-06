#if NATIVE_SMOKE
import AppKit
import SwiftUI

// This file has no shipping code. CI explicitly opts into the Cargo feature.
@MainActor func startNativeSmoke(_ model: NativeModel) {
    guard let folder = ProcessInfo.processInfo.environment["KUROGANE_NATIVE_SMOKE_DIR"] else { return }
    Task { @MainActor in
        let vault = URL(fileURLWithPath:NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString + ".kurogane")
        defer { try? FileManager.default.removeItem(at:vault) }
        do {
            try await Task.sleep(nanoseconds:1_000_000_000)
            _ = try await model.call("create_vault",["args":["path":vault.path,"displayName":"Issen Infrastructure","password":"native-smoke-password-2026","kdf":"standard","account":"CI"]])
            try await model.refresh()
            precondition(model.unlocked)
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
            if let window = model.window {
                window.setContentSize(NSSize(width:1440,height:900))
                for theme in ["light","dark"] {
                    model.appearance = theme; model.applyAppearance()
                    try await Task.sleep(nanoseconds:500_000_000)
                    guard let view = window.contentView, let bitmap = view.bitmapImageRepForCachingDisplay(in:view.bounds) else { throw NativeFailure(message:"Native window did not render") }
                    view.cacheDisplay(in:view.bounds,to:bitmap)
                    guard let data = bitmap.representation(using:.png,properties:[:]) else { throw NativeFailure(message:"Capture failed") }
                    try data.write(to:URL(fileURLWithPath:folder).appendingPathComponent("native-integrated-\(theme).png"))
                }
            }
            model.status = try await model.call("close_vault") as? Row ?? [:]
            try FileManager.default.removeItem(at:vault)
            print("Native bridge integration passed: encrypted vault, all entity types, credential reveal, dependency impact, settings, lock and reopen")
            exit(0)
        } catch {
            _ = try? await model.call("lock")
            try? FileManager.default.removeItem(at:vault)
            fputs("Native bridge integration failed: \(error.localizedDescription)\n",stderr)
            exit(1)
        }
    }
}
#endif
