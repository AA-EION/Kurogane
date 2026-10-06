import AppKit
import SwiftUI
import CoreImage.CIFilterBuiltins

struct NativeVaultScreen: View {
    @ObservedObject var model: NativeModel
    @State private var password = ""
    @State private var code = ""
    @FocusState private var focused: Bool
    var body: some View {
        VStack(spacing:24) {
            Image(systemName:"cube.fill").font(.system(size:58)).foregroundStyle(.secondary).shadow(color:.black.opacity(0.12),radius:8,y:6)
            VStack(spacing:8) { Text("Kurogane").font(.system(size:32,weight:.semibold,design:.rounded)); Text("Infrastructure, kept close.").foregroundStyle(.secondary) }
            VStack(alignment:.leading,spacing:16) {
                if model.status.text("stage") == "locked" {
                    Label(model.status.text("vaultName","Encrypted vault"),systemImage:"lock.shield").font(.headline)
                    Text(model.status.text("vaultPath")).font(.caption).foregroundStyle(.secondary).lineLimit(2).textSelection(.enabled)
                    if model.status.text("lastLockReason") == "inactivity" { Text("Locked after inactivity.").font(.caption).foregroundStyle(.secondary) }
                    SecureField("Master password",text:$password).textFieldStyle(.roundedBorder).focused($focused).onSubmit { unlock() }
                    if model.status.flag("totpRequired") { TextField("Authenticator code",text:$code).textFieldStyle(.roundedBorder).onSubmit { unlock() } }
                    Button(model.busy ? "Unlocking…" : "Unlock vault") { unlock() }.buttonStyle(.borderedProminent).frame(maxWidth:.infinity).disabled(password.isEmpty || model.busy)
                    Button("Choose another vault") { password = ""; code = ""; model.perform { model.status = try await model.call("close_vault") as? Row ?? [:] } }
                } else {
                    Button { model.sheet = NativeSheet(kind:"create") } label: { Label("Create a vault",systemImage:"plus.circle").frame(maxWidth:.infinity,alignment:.leading) }.buttonStyle(.borderedProminent)
                    Button { model.perform { _ = try await model.call("open_vault",["path":NSNull()]); try await model.refresh() } } label: { Label("Open an existing vault…",systemImage:"folder").frame(maxWidth:.infinity,alignment:.leading) }
                    Button { model.sheet = NativeSheet(kind:"cloud") } label: { Label("Connect a cloud vault…",systemImage:"cloud").frame(maxWidth:.infinity,alignment:.leading) }
                    let recent = model.status["recentVaults"] as? [String] ?? []
                    if !recent.isEmpty { Divider(); Text("Recent vaults").font(.caption).foregroundStyle(.secondary); ForEach(recent,id:\.self) { path in Button(URL(fileURLWithPath:path).lastPathComponent) { model.perform { _ = try await model.call("open_vault",["path":path]); try await model.refresh() } }.help(path) } }
                }
            }.modifier(TactilePanel()).frame(width:360).disabled(model.busy)
            Button("Issen Software Group") { model.perform { _ = try await model.call("launch_web",["url":"https://issen.kurokamicorp.com"]) } }.buttonStyle(.link).font(.caption)
        }.frame(maxWidth:.infinity,maxHeight:.infinity).onAppear { focused = true }.onDisappear { password = ""; code = "" }
    }
    func unlock() {
        guard !password.isEmpty else { return }
        let pw = password; let otp = code
        password = ""; code = ""
        model.perform { _ = try await model.call("unlock",["password":pw,"totp":otp.isEmpty ? NSNull() : otp as Any]); try await model.refresh() }
    }
}
struct NativeCreateVault: View {
    @ObservedObject var model: NativeModel
    @State private var name = "Infrastructure"
    @State private var account = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var path = ""
    @State private var kdf = "standard"
    @State private var enrollment: Row?
    @State private var code = ""
    var body: some View {
        VStack(alignment:.leading,spacing:18) {
            Text(enrollment == nil ? "Create an encrypted vault" : "Pair your authenticator").font(.title2)
            if let enrollment {
                NativeEnrollment(enrollment:enrollment)
                TextField("Six-digit code",text:$code).textFieldStyle(.roundedBorder)
                HStack { Button("Skip for now") { model.perform { model.sheet = nil; try await model.refresh() } }; Spacer(); Button("Verify and finish") { model.perform { _ = try await model.call("confirm_totp",["code":code]); self.enrollment = nil; code = ""; try await model.refresh() } }.buttonStyle(.borderedProminent).disabled(code.count != 6) }
            } else {
                Form {
                    TextField("Vault name",text:$name); TextField("Authenticator account",text:$account)
                    SecureField("Master password",text:$password); SecureField("Repeat password",text:$confirmation)
                    Picker("Key derivation",selection:$kdf) { Text("Standard · 256 MiB").tag("standard"); Text("Hardened · 1 GiB").tag("hardened") }
                    HStack { Text(path.isEmpty ? "Choose where to save the vault" : path).font(.caption).lineLimit(2); Spacer(); Button("Choose…") { model.perform { path = try await model.call("pick_vault_save_path") as? String ?? "" } } }
                }.formStyle(.grouped)
                Text("Keep your master password safe. It cannot be recovered.").font(.caption).foregroundStyle(.secondary)
                HStack { Spacer(); Button("Cancel") { model.sheet = nil }.keyboardShortcut(.cancelAction); Button("Create vault") {
                    let pw = password; password = ""; confirmation = ""
                    model.perform { enrollment = try await model.call("create_vault",["args":["path":path,"displayName":name,"password":pw,"kdf":kdf,"account":account.isEmpty ? name : account]]) as? Row }
                }.buttonStyle(.borderedProminent).disabled(path.isEmpty || password.count < 12 || password != confirmation || name.trimmingCharacters(in:.whitespaces).isEmpty) }
            }
        }.padding(24).frame(width:520).disabled(model.busy).onDisappear { password = ""; confirmation = ""; enrollment = nil; code = "" }
    }
}
struct NativeEnrollment: View {
    let enrollment: Row
    var image: NSImage? {
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(enrollment.text("otpauthUri").utf8)
        guard let output = filter.outputImage?.transformed(by:CGAffineTransform(scaleX:7,y:7)), let cg = CIContext().createCGImage(output,from:output.extent) else { return nil }
        return NSImage(cgImage:cg,size:NSSize(width:180,height:180))
    }
    var body: some View {
        VStack(alignment:.leading,spacing:12) {
            Text("Scan with your authenticator, then enter its code.")
            if let image { Image(nsImage:image).interpolation(.none).resizable().frame(width:180,height:180).padding(12).background(.white).accessibilityLabel("Authenticator pairing QR code") }
            Text("Manual setup key").font(.caption).foregroundStyle(.secondary)
            Text(enrollment.text("secretBase32")).font(.system(.body,design:.monospaced)).textSelection(.enabled)
        }
    }
}
struct NativeCloud: View {
    @ObservedObject var model: NativeModel
    let linking: Bool
    @State private var provider = "drive"
    @State private var email = ""
    @State private var password = ""
    @State private var candidates: [String] = []
    @State private var message = ""
    var body: some View {
        VStack(alignment:.leading,spacing:18) {
            Text(linking ? "Link a sync destination" : "Connect a cloud vault").font(.title2)
            Text("Only the encrypted vault is synced. Approve cloud access in your browser when prompted.").foregroundStyle(.secondary)
            Picker("Provider",selection:$provider) { Text("Google Drive").tag("drive"); Text("OneDrive").tag("onedrive"); Text("MEGA").tag("mega"); Text("Synced folder").tag("folder") }
            if provider == "mega" { TextField("MEGA email",text:$email); SecureField("MEGA password",text:$password) }
            if model.busy { HStack { ProgressView().controlSize(.small); Text(model.cloudStep.isEmpty ? "Connecting…" : model.cloudStep) } }
            if !message.isEmpty { Text(message).foregroundStyle(.secondary) }
            ForEach(candidates,id:\.self) { candidate in Button(candidate) { model.perform { _ = try await model.call("connect_cloud_finish",["remotePath":candidate]); model.sheet = nil; try await model.refresh() } }.disabled(model.busy) }
            HStack { Spacer(); Button("Cancel") { password = ""; model.sheet = nil }.disabled(model.busy); Button("Connect") { connect() }.buttonStyle(.borderedProminent).disabled(model.busy || provider == "mega" && (email.isEmpty || password.isEmpty)) }
        }.padding(24).frame(width:500).textFieldStyle(.roundedBorder).onDisappear { password = "" }
    }
    func connect() {
        let credentials: Any = provider == "mega" ? ["user":email,"password":password] : NSNull()
        password = ""; model.cloudStep = ""; message = ""
        model.perform {
            if linking {
                model.sync = try await model.call(provider == "folder" ? "link_folder" : "link_remote",["provider":provider,"mega":credentials]) as? Row ?? model.sync
                model.sheet = nil
            } else {
                let result = try await model.call("connect_cloud",["provider":provider,"mega":credentials]) as? Row ?? [:]
                candidates = result["candidates"] as? [String] ?? []
                if !result.text("vaultPath").isEmpty { model.sheet = nil; try await model.refresh() }
                else if candidates.isEmpty && !result.isEmpty { message = "No vaults found in that account. Create a vault locally, then link this account in Sync settings." }
            }
        }
    }
}
