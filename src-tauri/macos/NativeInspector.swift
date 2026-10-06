import SwiftUI

struct NativeInspector: View {
    @ObservedObject var model: NativeModel
    let item: NativeItem
    var value: Row { model.row(item) }
    var credentials: [Row] { model.rows("credential").filter { $0.row("owner").text("kind") == item.kind && $0.row("owner").text("id") == item.id } }
    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:18) {
                HStack { Label(model.title(item.kind).uppercased(),systemImage:model.icon(item.kind)).font(.caption).foregroundStyle(.secondary); Spacer(); Button { model.selected = nil } label: { Image(systemName:"xmark") }.buttonStyle(.plain).help("Close inspector") }
                Text(model.name(item)).font(.title2).textSelection(.enabled)
                HStack { Button("Edit") { model.edit(item.kind,value) }; Spacer(); Button("Delete…",role:.destructive) { model.sheet = NativeSheet(kind:"delete:\(item.kind)",item:value) } }
                Divider()
                ForEach(editorFields(item.kind)) { f in
                    let text = display(f)
                    if !text.isEmpty { VStack(alignment:.leading,spacing:4) { Text(f.label.uppercased()).font(.system(size:9,weight:.semibold)).foregroundStyle(.secondary); Text(text).font(.system(size:12)).textSelection(.enabled) } }
                }
                if item.kind == "host" { hostActions; childList("service","Services", { $0.text("hostId") == item.id }); childList("proxy","Reverse proxies", { $0.text("hostId") == item.id }) }
                if item.kind == "tenant" { childList("host","Machines", { $0.text("tenantId") == item.id }); childList("network","Networks", { $0.text("tenantId") == item.id }) }
                ForEach(["interfaces","ports","routes"],id:\.self) { key in
                    if !value.rows(key).isEmpty {
                        Text(key.capitalized).font(.headline)
                        ForEach(Array(value.rows(key).enumerated()),id:\.offset) { pair in
                            let r = pair.element
                            VStack(alignment:.leading,spacing:5) {
                                if key == "interfaces" { Text(r.text("name")).font(.caption.bold()); Text([r.text("internalIp"),r.text("publicIp"),r.text("mac")].filter { !$0.isEmpty }.joined(separator:" · ")) }
                                else if key == "ports" { Text("\(r.number("hostPort",r.number("containerPort"))) → \(r.number("containerPort"))/\(r.text("protocol"))"); Text(r.text("bindAddress")).foregroundStyle(.secondary) }
                                else {
                                    Text(r.text("domain")+r.text("pathPrefix")).font(.caption.bold())
                                    Text("\(r.text("targetIp")):\(r.number("targetPort"))")
                                    Text(r.flag("enabled") ? "Enabled · \(r.text("tlsMode"))" : "Disabled").foregroundStyle(.secondary)
                                    if ["http","https"].contains(r.text("inboundProtocol")) {
                                        Button("Open domain") {
                                            model.perform { _ = try await model.call("launch_web",["url":"\(r.text("inboundProtocol"))://\(r.text("domain")):\(r.number("inboundPort"))\(r.text("pathPrefix"))"]) }
                                        }
                                    }
                                }
                            }.font(.system(size:11,design:.monospaced)).textSelection(.enabled).padding(12).background(.quaternary,in:RoundedRectangle(cornerRadius:8))
                        }
                    }
                }
                if item.kind == "service" { serviceEndpoints; serviceRoutes }
                if item.kind == "proxy", !value.text("adminUrl").isEmpty { Button("Open proxy administration") { model.perform { _ = try await model.call("launch_web",["url":value.text("adminUrl")]) } } }
                if item.kind == "credential" { NativeAccount(model:model,value:value).id(item.id) }
                else if ["tenant","host","service","proxy"].contains(item.kind) {
                    HStack { Text("Accounts").font(.headline); Spacer(); Button { model.edit("credential",["owner":["kind":item.kind,"id":item.id],"kind":"admin_login","label":"","id":""]) } label: { Image(systemName:"plus") }.help("Add account") }
                    ForEach(credentials,id:\.entityID) { credential in
                        VStack(alignment:.leading,spacing:10) {
                            Button { model.selected = NativeItem(kind:"credential",id:credential.text("id")) } label: { Label(credential.text("label"),systemImage:"key") }.buttonStyle(.plain)
                            NativeAccount(model:model,value:credential).id(credential.text("id"))
                        }.modifier(TactilePanel())
                    }
                    if credentials.isEmpty { Text("No accounts stored.").font(.caption).foregroundStyle(.secondary) }
                }
            }.padding(18)
        }.background(Color(nsColor:.controlBackgroundColor))
    }
    func display(_ f: EditorField) -> String {
        if ["tenant","host","service","network"].contains(f.type) { return model.rows(f.type).first { $0.text("id") == value.text(f.key) }?.text("name") ?? "" }
        if let n = value[f.key] as? NSNumber { return n.stringValue }
        return value.text(f.key)
    }
    func childList(_ kind: String,_ title: String,_ predicate: @escaping (Row)->Bool) -> some View {
        VStack(alignment:.leading,spacing:8) {
            HStack { Text(title).font(.headline); Spacer(); Button { var r = blankEntity(kind); r[kind == "host" || kind == "network" ? "tenantId" : "hostId"] = item.id; model.edit(kind,r) } label: { Image(systemName:"plus") }.help("Add \(model.title(kind).lowercased())") }
            ForEach(model.rows(kind).filter(predicate),id:\.entityID) { r in Button { model.selected = NativeItem(kind:kind,id:r.text("id")) } label: { Label(r.text("name"),systemImage:model.icon(kind)) }.buttonStyle(.plain) }
        }
    }
    var hostActions: some View {
        HStack {
            Button("SSH") { model.perform { _ = try await model.call("launch_ssh",["hostId":item.id,"credentialId":NSNull()]) } }.disabled(value.number("sshPort") == 0)
            Button("RDP") { model.perform { _ = try await model.call("launch_rdp",["hostId":item.id,"credentialId":NSNull()]) } }.disabled(value.number("rdpPort") == 0)
            if !value.text("webAdminUrl").isEmpty { Button("Web") { model.perform { _ = try await model.call("launch_web",["url":value.text("webAdminUrl")]) } } }
        }
    }
    var serviceRoutes: some View {
        VStack(alignment:.leading,spacing:8) {
            Text("Public domains").font(.headline)
            ForEach(model.rows("proxy"),id:\.entityID) { proxy in
                ForEach(proxy.rows("routes").filter { $0.text("serviceId") == item.id },id:\.entityID) { route in
                    Button(route.text("domain")) { model.selected = NativeItem(kind:"proxy",id:proxy.text("id")) }.buttonStyle(.link)
                }
            }
            Menu("Publish a domain…") {
                ForEach(model.rows("proxy"),id:\.entityID) { proxy in Button("Via \(proxy.text("name"))") { publish(proxy) } }
                Divider(); Button("Create a reverse proxy…") { var proxy = blankEntity("proxy"); proxy["hostId"] = value.text("hostId"); proxy["name"] = "Reverse proxy"; publish(proxy) }
            }
            Button("Use this service as a reverse proxy…") { var proxy = blankEntity("proxy"); proxy["hostId"] = value.text("hostId"); proxy["serviceId"] = item.id; proxy["name"] = value.text("name"); model.edit("proxy",proxy) }
        }
    }
    var serviceEndpoints: some View {
        VStack(alignment:.leading,spacing:8) {
            Text("How to reach it").font(.headline)
            ForEach(nativeServiceEndpoints(value,model.topology),id:\.url) { endpoint in
                VStack(alignment:.leading,spacing:4) { Text(endpoint.label).font(.caption).foregroundStyle(.secondary); Button(endpoint.url) { model.perform { _ = try await model.call("launch_web",["url":endpoint.url]) } }.buttonStyle(.link).font(.system(.caption,design:.monospaced)) }
            }
        }
    }
    func publish(_ input: Row) {
        let host = model.rows("host").first { $0.text("id") == value.text("hostId") } ?? [:]
        let nic = host.rows("interfaces").first { $0.flag("isPrimary") } ?? host.rows("interfaces").first ?? [:]
        let port = value.rows("ports").first { $0.flag("isPrimary") } ?? value.rows("ports").first ?? [:]
        guard !nic.text("internalIp").isEmpty, port.number("containerPort") > 0 else { model.error = "Add a private IP to this machine and a port to the service before publishing a domain."; return }
        var route = blankEntity("route")
        route["serviceId"] = item.id; route["targetHostId"] = value.text("hostId"); route["targetIp"] = nic.text("internalIp")
        route["targetPort"] = port.number("hostPort",port.number("containerPort")); route["targetScheme"] = value.text("scheme") == "https" ? "https" : "http"
        route["proxyId"] = input.text("id"); route["tlsMode"] = "letsencrypt"
        var proxy = input; proxy["routes"] = input.rows("routes") + [route]
        model.edit("proxy",proxy)
    }
}
struct NativeEndpoint { let url: String; let label: String }
func nativeServiceEndpoints(_ service: Row,_ topology: Row) -> [NativeEndpoint] {
    var endpoints: [NativeEndpoint] = []
    for proxy in topology.rows("proxies") {
        for route in proxy.rows("routes") where route.text("serviceId") == service.text("id") && route.flag("enabled") && ["http","https"].contains(route.text("inboundProtocol")) {
            let scheme = route.text("inboundProtocol"), port = route.number("inboundPort")
            let suffix = scheme == "https" && port == 443 || scheme == "http" && port == 80 ? "" : ":\(port)"
            endpoints.append(NativeEndpoint(url:"\(scheme)://\(route.text("domain"))\(suffix)\(route.text("pathPrefix","/"))",label:"Public · via \(proxy.text("name"))"))
        }
    }
    let host = topology.rows("hosts").first { $0.text("id") == service.text("hostId") } ?? [:]
    let nic = host.rows("interfaces").first { $0.flag("isPrimary") } ?? host.rows("interfaces").first ?? [:]
    let ip = nic.text("internalIp"), scheme = service.text("scheme")
    let nonHTTP: Set<Int> = [21,22,23,25,53,110,143,389,445,554,636,1433,1521,3306,3389,5432,5672,6379,9042,11211,27017]
    if !ip.isEmpty && ["http","https"].contains(scheme) {
        for port in service.rows("ports") where port.number("hostPort") > 0 && port.text("protocol") == "tcp" && !nonHTTP.contains(port.number("containerPort")) {
            let published = port.number("hostPort"), address = ip.contains(":") ? "[\(ip)]" : ip
            let suffix = scheme == "https" && published == 443 || scheme == "http" && published == 80 ? "" : ":\(published)"
            endpoints.append(NativeEndpoint(url:"\(scheme)://\(address)\(suffix)/",label:"Internal · \(published) → \(port.number("containerPort"))"))
        }
    }
    return endpoints
}
struct NativeAccount: View {
    @ObservedObject var model: NativeModel
    let value: Row
    var body: some View {
        VStack(alignment:.leading,spacing:10) {
            if !value.text("username").isEmpty { HStack { Text(value.text("username")).font(.system(.caption,design:.monospaced)).textSelection(.enabled); Spacer(); Button { model.perform { _ = try await model.call("copy_text",["text":value.text("username")]); model.notice = "Username copied" } } label: { Image(systemName:"doc.on.doc") }.help("Copy username") } }
            ForEach([("secret","hasSecret","Password / token"),("privateKey","hasPrivateKey","Private key"),("notes","hasNotes","Secret notes")],id:\.0) { field in
                if value.flag(field.1) { NativeSecret(model:model,id:value.text("id"),field:field.0,title:field.2) }
            }
            if !value.text("url").isEmpty { Button("Open URL") { model.perform { _ = try await model.call("launch_web",["url":value.text("url")]) } } }
            if value.row("owner").text("kind") == "host" {
                HStack {
                    Button("SSH with account") { model.perform { _ = try await model.call("launch_ssh",["hostId":value.row("owner").text("id"),"credentialId":value.text("id")]) } }
                    Button("RDP") { model.perform { _ = try await model.call("launch_rdp",["hostId":value.row("owner").text("id"),"credentialId":value.text("id")]) } }
                }
            }
        }
    }
}
struct NativeSecret: View {
    @ObservedObject var model: NativeModel
    let id: String
    let field: String
    let title: String
    @State private var revealed = ""
    @State private var expiry: Task<Void,Never>?
    var body: some View {
        VStack(alignment:.leading,spacing:6) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            HStack {
                Text(revealed.isEmpty ? "••••••••" : revealed).font(.system(.caption,design:.monospaced)).textSelection(.enabled)
                Spacer()
                Button(revealed.isEmpty ? "Reveal" : "Hide") {
                    if !revealed.isEmpty { hide() }
                    else { model.perform { let value = try await model.call("reveal_secret",["credentialId":id,"field":field]) as? String ?? ""; guard model.unlocked else { return }; revealed = value; expiry?.cancel(); expiry = Task { try? await Task.sleep(nanoseconds:15_000_000_000); if !Task.isCancelled { revealed = "" } } } }
                }
                Button { model.perform { let result = try await model.call("copy_secret",["credentialId":id,"field":field]) as? Row ?? [:]; model.notice = "Copied; clipboard clears in \(result.number("clearsInSecs"))s" } } label: { Image(systemName:"doc.on.doc") }.help("Copy \(title.lowercased())")
            }
        }.onDisappear { hide() }.onChange(of:model.unlocked) { if !$0 { hide() } }
    }
    func hide() { expiry?.cancel(); revealed = "" }
}
