import AppKit
import SwiftUI

// Compiled only into the runner's separate preview executable. Fixtures are
// never included in a shipping app or substituted for real command responses.
@MainActor enum NativeFixture {
    static let tenant: Row = ["id":"company","name":"Issen","environment":"corporate"]
    static let host: Row = ["id":"machine","tenantId":"company","name":"Atlas","category":"vps","osFamily":"linux","fqdn":"atlas.issen.local","interfaces":[["id":"nic","hostId":"machine","name":"eth0","internalIp":"10.0.0.10","isPrimary":true]]]
    static let service: Row = ["id":"service","hostId":"machine","name":"Gitea","runtime":"docker","scheme":"http","image":"gitea/gitea:latest","ports":[["id":"port","serviceId":"service","containerPort":3000,"hostPort":3000,"bindAddress":"0.0.0.0","protocol":"tcp","isPrimary":true]]]
    static let proxy: Row = ["id":"proxy","hostId":"machine","name":"Caddy","kind":"caddy","routes":[["id":"route","proxyId":"proxy","domain":"git.issen.local","pathPrefix":"/","targetIp":"10.0.0.10","targetPort":3000,"targetScheme":"http","serviceId":"service","enabled":true,"tlsMode":"letsencrypt","inboundPort":443,"inboundProtocol":"https"]]]
    static let topology: Row = ["vaultName":"Issen Infrastructure","tenants":[tenant],"hosts":[host],"services":[service],"proxies":[proxy],"networks":[],"credentials":[]]
    static let settings: Row = ["displayName":"Issen Infrastructure","lockTimeoutSecs":300,"clipboardClearSecs":30,"lockOnSuspend":true,"memoryLocked":true,"totpEnabled":false,"kdfProfile":"standard","kdfMeetsFloor":true,"kdf":["mCostKib":262144,"tCost":3,"parallelism":4],"vaultPath":"/Users/issen/Infrastructure.kurogane","appVersion":"0.1.0"]
    static func reply(_ command: String, _ args: Row) -> Any {
        if command == "get_settings" { return settings }
        if command == "topology" { return topology }
        if command == "app_status" { return ["stage":"unlocked","memoryLocked":true,"remainingSecs":300] as Row }
        if command == "sync_status" { return ["linked":[],"busy":false,"autoSync":false] as Row }
        if command == "delete_impact" { return ["hosts":1,"services":1,"proxies":1,"routes":1,"credentials":0,"networks":0] as Row }
        return NSNull()
    }
}
@main enum NativePreview {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let model = NativeModel(); model.topology = NativeFixture.topology; model.loading = false
        model.status = ["stage":"unlocked","remainingSecs":300,"memoryLocked":true]
        model.sync = ["linked":[],"autoSync":false,"busy":false]
        model.selected = NativeItem(kind:"service",id:"service")
        let window = NSWindow(contentRect:NSRect(x:0,y:0,width:1440,height:900),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        model.window = window
        window.contentView = NSHostingView(rootView:NativeRoot(model:model))
        window.makeKeyAndOrderFront(nil)
        window.setContentSize(NSSize(width:1440,height:900))
        Task { @MainActor in
            do {
                // Check missing required relations and numeric limits, not merely
                // implementation snapshots. Verify layout scales with dense hosts.
                var invalid = blankEntity("host"); invalid["name"] = "Machine"
                do { _ = try normalized("host",invalid); fatalError("Missing company was accepted") } catch {}
                var port = blankEntity("port"); port["containerPort"] = "70000"
                do { _ = try normalized("port",port); fatalError("Invalid port was accepted") } catch {}
                let valid = try normalized("port",blankEntity("port")); precondition(valid.number("containerPort") == 80)
                let layout = MapLayout(NativeFixture.topology); precondition(layout.nodes.count == 4 && layout.size.height >= 500)
                let endpoints = nativeServiceEndpoints(NativeFixture.service,NativeFixture.topology)
                precondition(endpoints.map(\.url) == ["https://git.issen.local/","http://10.0.0.10:3000/"])
                var privateOnly = NativeFixture.topology; privateOnly["proxies"] = []
                precondition(nativeServiceEndpoints(NativeFixture.service,privateOnly).map(\.url) == ["http://10.0.0.10:3000/"])
                var unpublished = NativeFixture.service; unpublished["ports"] = [["containerPort":3000,"protocol":"tcp"]]
                precondition(nativeServiceEndpoints(unpublished,privateOnly).isEmpty)
                var v6Host = NativeFixture.host; v6Host["interfaces"] = [["internalIp":"fd00::1","isPrimary":true]]
                privateOnly["hosts"] = [v6Host]
                precondition(nativeServiceEndpoints(NativeFixture.service,privateOnly).first?.url == "http://[fd00::1]:3000/")
                let folder = CommandLine.arguments[1]
                for theme in ["light","dark"] {
                    model.appearance = theme; model.applyAppearance()
                    try await Task.sleep(nanoseconds:500_000_000)
                    try capture(window,folder+"/workspace-"+theme+".png")
                }
                model.appearance = "light"; model.applyAppearance()
                let cases: [(String,AnyView)] = [
                    ("machine-editor",AnyView(NativeEditor(model:model,kind:"host",item:NativeFixture.host))),
                    ("service-editor",AnyView(NativeEditor(model:model,kind:"service",item:NativeFixture.service))),
                    ("proxy-editor",AnyView(NativeEditor(model:model,kind:"proxy",item:NativeFixture.proxy))),
                    ("account-editor",AnyView(NativeEditor(model:model,kind:"credential",item:[:]))),
                    ("settings",AnyView(NativeSettings(model:model))),
                    ("security-settings",AnyView(NativeSettings(model:model,section:"security"))),
                    ("sync-settings",AnyView(NativeSettings(model:model,section:"sync"))),
                    ("data-settings",AnyView(NativeSettings(model:model,section:"data"))),
                    ("about-settings",AnyView(NativeSettings(model:model,section:"about"))),
                    ("company-editor",AnyView(NativeEditor(model:model,kind:"tenant",item:NativeFixture.tenant))),
                    ("network-editor",AnyView(NativeEditor(model:model,kind:"network",item:[:]))),
                    ("cloud",AnyView(NativeCloud(model:model,linking:true))),
                    ("import",AnyView(NativeImport(model:model))),
                    ("export",AnyView(NativeExport(model:model))),
                    ("create-vault",AnyView(NativeCreateVault(model:model)))
                ]
                for (name,view) in cases {
                    window.contentView = NSHostingView(rootView:view.frame(maxWidth:.infinity,maxHeight:.infinity).background(Color(nsColor:.windowBackgroundColor)))
                    window.setContentSize(NSSize(width:720,height:740))
                    try await Task.sleep(nanoseconds:350_000_000)
                    try capture(window,folder+"/"+name+".png")
                }
                model.status = ["stage":"locked","vaultName":"Issen Infrastructure","vaultPath":"/Users/issen/Infrastructure.kurogane","totpRequired":true]
                window.contentView = NSHostingView(rootView:NativeVaultScreen(model:model).background(Color(nsColor:.windowBackgroundColor)))
                try await Task.sleep(nanoseconds:350_000_000)
                try capture(window,folder+"/locked-vault.png")
                print("Native SwiftUI validation and 18 view captures passed")
                exit(0)
            } catch { fputs("Native preview failed: \(error)\n",stderr); exit(1) }
        }
        app.run()
    }
    @MainActor static func capture(_ window: NSWindow,_ path: String) throws {
        guard let view = window.contentView else { throw NativeFailure(message:"No native view") }
        view.layoutSubtreeIfNeeded()
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in:view.bounds) else { throw NativeFailure(message:"No bitmap") }
        view.cacheDisplay(in:view.bounds,to:bitmap)
        guard let data = bitmap.representation(using:.png,properties:[:]), data.count > 1000 else { throw NativeFailure(message:"Empty capture") }
        try data.write(to:URL(fileURLWithPath:path))
        print("Captured \(URL(fileURLWithPath:path).lastPathComponent): \(Int(view.bounds.width)) × \(Int(view.bounds.height)) points")
    }
}
