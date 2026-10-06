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
                let compactSize = nativeSheetSize(model,width:680,height:680)
                precondition(compactSize.height <= window.contentLayoutRect.height - 64)
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
                if CommandLine.arguments.count > 2 {
                    let data = try Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[2]))
                    let fixture = try JSONSerialization.jsonObject(with:data) as? Row ?? [:]
                    model.topology = fixture.row("topology")
                    precondition(model.rows("host").count >= 10 && model.rows("service").count >= 10,"Rich topology fixture did not load")
                    if let service = model.rows("service").first(where: { $0.text("name") == "gitea" }) { model.selected = NativeItem(kind:"service",id:service.entityID) }
                }
                for _ in 0..<100 { if model.graphReady { break }; try await Task.sleep(nanoseconds:100_000_000) }
                precondition(model.graphReady,"Shared graph did not connect")
                let count = try await model.graph.webView?.evaluateJavaScript("document.querySelectorAll('[data-node]').length") as? Int ?? 0
                precondition(count > 0 && count >= model.rows("host").count,"Topology did not render its machines")
                for theme in ["light","dark"] {
                    model.appearance = theme; model.applyAppearance()
                    try await Task.sleep(nanoseconds:500_000_000)
                    try await capture(window,folder+"/workspace-"+theme+".png")
                }
                model.appearance = "light"; model.applyAppearance()
                window.setContentSize(NSSize(width:960,height:640))
                try await Task.sleep(nanoseconds:500_000_000)
                try await capture(window,folder+"/workspace-compact.png")
                model.topology = NativeFixture.topology; model.selected = NativeItem(kind:"service",id:"service")
                let cases: [(String,String,Row)] = [
                    ("machine-editor","edit:host",NativeFixture.host),
                    ("service-editor","edit:service",NativeFixture.service),
                    ("proxy-editor","edit:proxy",NativeFixture.proxy),
                    ("account-editor","edit:credential",[:]),
                    ("settings","settings",[:]),
                    ("security-settings","settings",["section":"security"]),
                    ("sync-settings","settings",["section":"sync"]),
                    ("data-settings","settings",["section":"data"]),
                    ("about-settings","settings",["section":"about"]),
                    ("company-editor","edit:tenant",NativeFixture.tenant),
                    ("network-editor","edit:network",[:]),
                    ("cloud","cloud",[:]),
                    ("import","import",[:]),
                    ("export","export",[:]),
                    ("create-vault","create",[:])
                ]
                for theme in ["light","dark"] {
                    model.appearance = theme; model.applyAppearance()
                    for (name,kind,item) in cases {
                    model.sheet = NativeSheet(kind:kind,item:item)
                    for _ in 0..<30 { if window.attachedSheet != nil { break }; try await Task.sleep(nanoseconds:100_000_000) }
                    try await Task.sleep(nanoseconds:400_000_000)
                    guard let sheet = window.attachedSheet else { throw NativeFailure(message:"Sheet \(name) was not presented") }
                    precondition(sheet.frame.height <= (window.screen?.visibleFrame.height ?? 900),"Sheet \(name) exceeds the display")
                    let suffix = theme == "light" ? "" : "-dark"
                    try await capture(sheet,folder+"/"+name+suffix+".png")
                    model.sheet = nil
                    for _ in 0..<30 { if window.attachedSheet == nil { break }; try await Task.sleep(nanoseconds:100_000_000) }
                    }
                }
                model.appearance = "light"; model.applyAppearance()
                model.status = ["stage":"locked","vaultName":"Issen Infrastructure","vaultPath":"/Users/issen/Infrastructure.kurogane","totpRequired":true]
                window.contentView = NSHostingView(rootView:NativeVaultScreen(model:model).background(Color(nsColor:.windowBackgroundColor)))
                try await Task.sleep(nanoseconds:350_000_000)
                try await capture(window,folder+"/locked-vault.png")
                print("Native validation passed: original isometric graph, compact window, real attached sheets in both themes and 34 captures")
                exit(0)
            } catch { fputs("Native preview failed: \(error)\n",stderr); exit(1) }
        }
        app.run()
    }
    @MainActor static func capture(_ window: NSWindow,_ path: String) async throws {
        let data = try await nativeCapture(window)
        try data.write(to:URL(fileURLWithPath:path))
        print("Captured \(URL(fileURLWithPath:path).lastPathComponent): \(Int(window.contentLayoutRect.width)) × \(Int(window.contentLayoutRect.height)) points")
    }
}
