import SwiftUI

struct EditorField: Identifiable {
    let key: String
    let label: String
    var type = "text"
    var choices: [String] = []
    var required = false
    var id: String { key }
}
func field(_ key: String, _ label: String, _ type: String = "text", _ choices: [String] = [], required: Bool = false) -> EditorField { EditorField(key: key, label: label, type: type, choices: choices, required: required) }
func editorFields(_ kind: String) -> [EditorField] {
    switch kind {
    case "tenant": return [field("name","Name",required:true),field("environment","Environment","choice",["corporate","client","personal","lab","staging","production"]),field("environmentLabel","Environment label"),field("color","Map color (hex)"),field("slaNotes","SLA notes","multiline"),field("adminNotes","Administration notes","multiline")]
    case "network": return [field("tenantId","Company","tenant",required:true),field("name","Name",required:true),field("kind","Kind","choice",["lan","dmz","wan","vpn","overlay","mgmt","iot"]),field("cidr","CIDR",required:true),field("vlanId","VLAN","number"),field("gateway","Gateway")]
    case "host": return [field("tenantId","Company","tenant",required:true),field("parentHostId","Parent machine","host"),field("name","Name",required:true),field("category","Category","choice",["vps","local_server","vm","switch","access_point","router","firewall","nvr","nas","edge_device","workstation"]),field("osFamily","Operating system","choice",["linux","windows","macos","bsd","routeros","embedded","other"]),field("fqdn","FQDN"),field("sshPort","SSH port","number"),field("rdpPort","RDP port","number"),field("winrmPort","WinRM port","number"),field("webAdminUrl","Web administration URL"),field("provider","Provider"),field("location","Location"),field("icon","Icon"),field("notes","Notes","multiline")]
    case "service": return [field("hostId","Machine","host",required:true),field("ownerTenantId","Owning company","tenant"),field("name","Name",required:true),field("runtime","Runtime","choice",["docker","podman","systemd","smb","kubernetes","windows_service","lxc","other"]),field("image","Image / package"),field("scheme","Protocol","choice",["http","https","tcp","udp","smb","rtsp","none"]),field("healthPath","Health path"),field("icon","Icon"),field("description","Description","multiline")]
    case "proxy": return [field("hostId","Machine","host",required:true),field("serviceId","Proxy service","service"),field("name","Name",required:true),field("kind","Kind","choice",["nginx","npm","traefik","caddy","haproxy","cloudflare_tunnel","other"]),field("adminUrl","Administration URL")]
    case "interface": return [field("name","Interface name",required:true),field("networkId","Network","network"),field("mac","MAC address"),field("internalIp","Private IP"),field("gateway","Gateway"),field("publicIp","Public IP"),field("isPrimary","Primary interface","bool")]
    case "port": return [field("containerPort","Internal port","number",required:true),field("hostPort","Published port","number"),field("bindAddress","Bind address",required:true),field("protocol","Protocol","choice",["tcp","udp"]),field("isPrimary","Primary port","bool")]
    case "route": return [field("domain","Domain",required:true),field("pathPrefix","Path prefix",required:true),field("inboundPort","Inbound port","number",required:true),field("inboundProtocol","Inbound protocol","choice",["http","https","tcp","udp"]),field("tlsMode","TLS","choice",["letsencrypt","custom","cloudflare","passthrough","none"]),field("tlsExpiresAt","TLS expiry (YYYY-MM-DD)"),field("targetHostId","Target machine","host"),field("targetIp","Target IP",required:true),field("targetPort","Target port","number",required:true),field("targetScheme","Target protocol","choice",["http","https","tcp","udp"]),field("serviceId","Target service","service"),field("enabled","Enabled","bool")]
    case "credential": return [field("kind","Kind","choice",["ssh_password","ssh_key","rdp","web_gui","admin_login","db_user","api_token","smb","winrm","snmp","other"]),field("label","Label",required:true),field("username","Username"),field("url","URL"),field("publicKey","Public key","multiline"),field("expiresAt","Expiry (YYYY-MM-DD)")]
    default: return []
    }
}
func blankEntity(_ kind: String) -> Row {
    var r: Row = ["id":""]
    for f in editorFields(kind) { r[f.key] = f.type == "bool" ? false : f.choices.first as Any? ?? NSNull() }
    switch kind {
    case "tenant": r["name"] = ""
    case "host": r["interfaces"] = []; r["category"] = "vps"
    case "service": r["ports"] = []; r["runtime"] = "docker"; r["scheme"] = "http"
    case "proxy": r["routes"] = []; r["kind"] = "nginx"
    case "interface": r["hostId"] = ""; r["name"] = "eth0"
    case "port": r["serviceId"] = ""; r["bindAddress"] = "0.0.0.0"; r["containerPort"] = 80
    case "route": r["proxyId"] = ""; r["pathPrefix"] = "/"; r["inboundPort"] = 443; r["inboundProtocol"] = "https"; r["targetPort"] = 80; r["enabled"] = true; r["targetScheme"] = "http"
    default: break
    }
    return r
}
struct NativeFields: View {
    @ObservedObject var model: NativeModel
    let kind: String
    @Binding var value: Row
    func textBinding(_ f: EditorField) -> Binding<String> {
        Binding(get: { if let n = value[f.key] as? NSNumber, f.type == "number" { return n.stringValue }; return value.text(f.key) }, set: { value[f.key] = $0 })
    }
    var body: some View {
        ForEach(editorFields(kind)) { f in
            if f.type == "bool" { Toggle(f.label, isOn: Binding(get: { value.flag(f.key) }, set: { value[f.key] = $0 })).toggleStyle(.switch) }
            else if f.type == "choice" {
                Picker(f.label, selection: textBinding(f)) {
                    if !f.choices.contains(value.text(f.key)), !value.text(f.key).isEmpty { Text(value.text(f.key)).tag(value.text(f.key)) }
                    ForEach(f.choices, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0) }
                }
            } else if ["tenant","host","network","service"].contains(f.type) {
                Picker(f.label + (f.required ? " *" : ""), selection: textBinding(f)) {
                    Text(f.required ? "Choose…" : "None").tag("")
                    ForEach(model.rows(f.type).filter { !(kind == "host" && f.key == "parentHostId" && $0.text("id") == value.text("id")) }, id: \.entityID) { row in Text(row.text("name")).tag(row.text("id")) }
                }
            } else if f.type == "multiline" {
                VStack(alignment: .leading) { Text(f.label); TextEditor(text: textBinding(f)).font(.body).frame(height: 72).border(.gray.opacity(0.25)) }
            } else {
                LabeledContent {
                    TextField("",text:textBinding(f)).textFieldStyle(.roundedBorder).accessibilityLabel(f.label)
                } label: { Text(f.label + (f.required ? " *" : "")).foregroundStyle(NativePalette.secondary) }
            }
        }
    }
}
func normalized(_ kind: String, _ input: Row) throws -> Row {
    var r = input
    for f in editorFields(kind) {
        if f.type == "bool" { continue }
        if f.type == "number" {
            let text = (r[f.key] as? NSNumber)?.stringValue ?? r.text(f.key)
            if text.isEmpty { if f.required { throw NativeFailure(message:"Enter \(f.label.lowercased()).") }; r[f.key] = NSNull() }
            else { guard let n = Int(text), (f.key == "vlanId" ? 0...4094 : 1...65535).contains(n) else { throw NativeFailure(message:"\(f.label) is outside the valid range.") }; r[f.key] = n }
        } else {
            let text = r.text(f.key).trimmingCharacters(in: .whitespacesAndNewlines)
            if f.required && text.isEmpty { throw NativeFailure(message:"Enter \(f.label.lowercased()).") }
            r[f.key] = text.isEmpty && !f.required && f.type != "choice" ? NSNull() : text as Any
        }
    }
    for (key, child) in [("interfaces","interface"),("ports","port"),("routes","route")] where r[key] != nil {
        r[key] = try r.rows(key).map { try normalized(child, $0) }
        let primaries = r.rows(key).filter { $0.flag("isPrimary") }.count
        if primaries > 1 { throw NativeFailure(message:"Choose only one primary \(child).") }
    }
    return r
}
struct NativeEditor: View {
    @ObservedObject var model: NativeModel
    let kind: String
    @State private var value: Row
    @State private var owner = ""
    @State private var secrets: [String:String] = [:]
    @State private var modes: [String:String] = [:]
    @State private var error: String?
    init(model: NativeModel, kind: String, item: Row) {
        self.model = model; self.kind = kind
        _value = State(initialValue: item.isEmpty ? blankEntity(kind) : item)
        let owner = item.row("owner")
        _owner = State(initialValue: owner.isEmpty ? "tenant:\(model.rows("tenant").first?.text("id") ?? "")" : "\(owner.text("kind")):\(owner.text("id"))")
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack { Image(systemName: model.icon(kind)); Text("\(value.text("id").isEmpty ? "Add" : "Edit") \(model.title(kind).lowercased())").font(.title2); Spacer() }.padding(20)
            Form {
                Section("Details") {
                    if kind == "credential" { Picker("Belongs to", selection: $owner) { ForEach(["tenant","host","service","proxy"], id: \.self) { k in ForEach(model.rows(k), id: \.entityID) { row in Text("\(model.title(k)): \(row.text("name"))").tag("\(k):\(row.text("id"))") } } } }
                    NativeFields(model:model, kind:kind, value:$value)
                }
                if kind == "host" { nested("interfaces","interface","Network interfaces") }
                if kind == "service" { nested("ports","port","Ports") }
                if kind == "proxy" { nested("routes","route","Routes") }
                if kind == "credential" {
                    Section("Encrypted secrets") {
                        ForEach(["secret","privateKey","notes"], id: \.self) { key in
                            Picker(key == "secret" ? "Password / token" : key == "privateKey" ? "Private key" : "Secret notes", selection: Binding(get: { modes[key] ?? "keep" }, set: { modes[key] = $0; secrets[key] = "" })) { Text("Keep stored value").tag("keep"); Text("Replace").tag("set"); Text("Remove").tag("clear") }
                            if modes[key] == "set" {
                                if key == "secret" { SecureField("New password or token", text: Binding(get: { secrets[key] ?? "" }, set: { secrets[key] = $0 })) }
                                else { TextEditor(text: Binding(get: { secrets[key] ?? "" }, set: { secrets[key] = $0 })).font(.system(.body, design: .monospaced)).frame(height: 100).border(.gray.opacity(0.25)) }
                            }
                        }
                    }
                }
                if let error { Text(error).foregroundStyle(NativePalette.danger).textSelection(.enabled) }
            }.formStyle(.grouped)
            Divider()
            HStack { Spacer(); Button("Cancel") { model.sheet = nil }.keyboardShortcut(.cancelAction); Button(model.busy ? "Saving…" : "Save") { save() }.buttonStyle(NativePrimaryButtonStyle()).keyboardShortcut(.defaultAction) }.padding(16).disabled(model.busy)
        }.nativeSheetSize(model,width:680,height:680).onDisappear { secrets.removeAll(); modes.removeAll() }
    }
    private func nested(_ key: String, _ child: String, _ title: String) -> some View {
        Section(title) {
            ForEach(Array(value.rows(key).indices), id: \.self) { index in
                DisclosureGroup("\(child.capitalized) \(index + 1)") {
                    NativeFields(model:model, kind:child, value:Binding(get: { let rows = value.rows(key); return rows.indices.contains(index) ? rows[index] : [:] }, set: { next in var rows = value.rows(key); if rows.indices.contains(index) { rows[index] = next; value[key] = rows } }))
                    Button("Remove \(child)", role:.destructive) { var rows = value.rows(key); if rows.indices.contains(index) { rows.remove(at:index); value[key] = rows } }
                }
            }
            Button("Add \(child)") { value[key] = value.rows(key) + [blankEntity(child)] }
        }
    }
    private func save() {
        error = nil
        do {
            var output = try normalized(kind, value)
            if kind == "credential" {
                let parts = owner.split(separator:":",maxSplits:1).map(String.init)
                guard parts.count == 2, !parts[1].isEmpty else { throw NativeFailure(message:"Choose an owner.") }
                output["owner"] = ["kind":parts[0],"id":parts[1]]
                if output.text("id").isEmpty { output["id"] = NSNull() }
                for key in ["secret","privateKey","notes"] { output[key] = modes[key] == "set" ? ["set":secrets[key] ?? ""] as Any : modes[key] ?? "keep" }
            }
            model.perform { do { try await model.save(kind, output) } catch { self.error = error.localizedDescription } }
        } catch { self.error = error.localizedDescription }
    }
}

struct NativeDelete: View {
    @ObservedObject var model: NativeModel
    let kind: String
    let item: Row
    @State private var impact: Row?
    @State private var error: String?
    var body: some View {
        VStack(alignment:.leading,spacing:18) {
            Text("Delete \(item.text("name",item.text("label")))?").font(.title2)
            Text("This also removes its dependent inventory and encrypted accounts.")
            if let impact { ForEach(impact.keys.sorted(), id:\.self) { key in if impact.number(key) > 0 { Text("\(impact.number(key)) \(key)").foregroundStyle(NativePalette.secondary) } } }
            else if let error { Text(error).foregroundStyle(NativePalette.danger); Button("Retry") { load() } }
            else { ProgressView("Checking dependencies…") }
            HStack { Spacer(); Button("Cancel") { model.sheet = nil }.keyboardShortcut(.cancelAction); Button("Delete",role:.destructive) { model.perform { model.topology = try await model.call("delete_entity",["kind":kind,"id":item.text("id")]) as? Row ?? [:]; model.selected = nil; model.sheet = nil } }.disabled(impact == nil || model.busy) }
        }.padding(24).frame(width:460).task { load() }
    }
    func load() { error = nil; Task { do { impact = try await model.call("delete_impact",["kind":kind,"id":item.text("id")]) as? Row } catch { self.error = error.localizedDescription } } }
}

struct NativeSheetView: View {
    @ObservedObject var model: NativeModel
    let sheet: NativeSheet
    @ViewBuilder var body: some View {
        if sheet.kind.hasPrefix("edit:") { NativeEditor(model:model,kind:String(sheet.kind.dropFirst(5)),item:sheet.item) }
        else if sheet.kind.hasPrefix("delete:") { NativeDelete(model:model,kind:String(sheet.kind.dropFirst(7)),item:sheet.item) }
        else if sheet.kind == "settings" { NativeSettings(model:model,section:sheet.item.text("section","general")) }
        else if sheet.kind == "import" { NativeImport(model:model) }
        else if sheet.kind == "export" { NativeExport(model:model) }
        else if sheet.kind == "cloud" { NativeCloud(model:model,linking:model.unlocked) }
        else if sheet.kind == "create" { NativeCreateVault(model:model) }
    }
}
