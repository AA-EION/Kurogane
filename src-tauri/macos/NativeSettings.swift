import SwiftUI
import AppKit

struct NativeSettings: View {
    @ObservedObject var model: NativeModel
    @State private var settings: Row = [:]
    @State private var error: String?
    @State private var section: String
    init(model: NativeModel, section: String = "general") { self.model = model; _section = State(initialValue:section) }
    var body: some View {
        VStack(spacing:0) {
            HStack { Text("Settings").font(.title2); Spacer(); Button("Done") { model.sheet = nil }.keyboardShortcut(.cancelAction) }.padding(20)
            if settings.isEmpty {
                if let error { VStack(spacing:12) { Text(error).foregroundStyle(NativePalette.danger); Button("Retry") { load() } }.frame(maxHeight:.infinity) }
                else { ProgressView("Loading settings…").frame(maxHeight:.infinity) }
            } else {
                Picker("Settings section",selection:$section) {
                    Text("General").tag("general"); Text("Security").tag("security"); Text("Sync").tag("sync"); Text("Data").tag("data"); Text("About").tag("about")
                }.pickerStyle(.segmented).padding(.horizontal,24).padding(.bottom,12)
                Group {
                    switch section {
                    case "security": NativeSecurity(model:model,settings:$settings)
                    case "sync": NativeSyncSettings(model:model)
                    case "data": data
                    case "about": about
                    default: general
                    }
                }.padding(.horizontal,12).padding(.bottom,12).frame(maxHeight:.infinity)
            }
        }.nativeSheetSize(model,width:680,height:650).task { load() }
    }
    var general: some View {
        Form {
            Section("Appearance") {
                Picker("Theme",selection:$model.appearance) { Text("Light").tag("light"); Text("Dark").tag("dark"); Text("System").tag("system") }.pickerStyle(.segmented)
                Text("Light by default. Choose the appearance that feels comfortable.").font(.caption).foregroundStyle(NativePalette.secondary)
            }
            Section("Vault") {
                TextField("Name",text:Binding(get:{ settings.text("displayName") },set:{ settings["displayName"] = $0 }))
                Stepper("Lock after \(settings.number("lockTimeoutSecs")) seconds",value:intBinding("lockTimeoutSecs"),in:min(30,settings.number("lockTimeoutSecs"))...max(14400,settings.number("lockTimeoutSecs")),step:30)
                Stepper("Clear clipboard after \(settings.number("clipboardClearSecs")) seconds",value:intBinding("clipboardClearSecs"),in:min(5,settings.number("clipboardClearSecs"))...max(600,settings.number("clipboardClearSecs")),step:5)
                Toggle("Lock on system suspend",isOn:Binding(get:{ settings.flag("lockOnSuspend") },set:{ settings["lockOnSuspend"] = $0 }))
                Text(settings.text("vaultPath")).font(.caption).foregroundStyle(NativePalette.secondary).textSelection(.enabled)
                Button("Save preferences") { model.perform { _ = try await model.call("update_settings",["settings":["displayName":settings.text("displayName"),"lockTimeoutSecs":settings.number("lockTimeoutSecs"),"clipboardClearSecs":settings.number("clipboardClearSecs"),"lockOnSuspend":settings.flag("lockOnSuspend")]]); try await model.refresh(); model.notice = "Preferences saved" } }.disabled(model.busy || settings.text("displayName").trimmingCharacters(in:.whitespaces).isEmpty)
            }
        }.formStyle(.grouped)
    }
    var data: some View {
        Form {
            Section("Inventory") {
                Button("Import Excel or JSON…") { model.sheet = NativeSheet(kind:"import") }
                Button("Export inventory…") { model.sheet = NativeSheet(kind:"export") }
                Button("Download the Excel template…") { model.perform { if let path = try await model.call("download_template") as? String { model.notice = "Saved \(path)" } } }
            }
            Section("Encrypted vault") {
                Button("Save encrypted backup…") { model.perform { if let path = try await model.call("export_backup") as? String { model.notice = "Saved \(path)" } } }
                Text("The backup keeps passwords and account keys encrypted.").font(.caption).foregroundStyle(NativePalette.secondary)
                Button("Close vault") { model.perform { _ = try await model.call("lock"); _ = try await model.call("close_vault"); try await model.refresh() } }
            }
        }.formStyle(.grouped)
    }
    var about: some View {
        VStack(spacing:18) {
            Image(systemName:"cube.fill").font(.system(size:48)).foregroundStyle(NativePalette.secondary)
            Text("Kurogane").font(.largeTitle)
            Text("Version \(settings.text("appVersion"))").foregroundStyle(NativePalette.secondary)
            Text("A product of Issen Software Group")
            Text("Copyright © 2026 Issen Software Group and Kurogane contributors.\nAGPLv3-or-later; redistribution is permitted under its terms.\nProvided without warranty.").font(.caption).multilineTextAlignment(.center).foregroundStyle(NativePalette.secondary)
            Button("Read the AGPL license") {
                guard let url = Bundle.main.url(forResource:"LICENSE",withExtension:nil,subdirectory:"legal") else { model.error = "The installed license file is missing."; return }
                NSWorkspace.shared.open(url)
            }
            Button("Source code and third-party notices") { model.perform { _ = try await model.call("launch_web",["url":"https://github.com/AA-EION/Kurogane"]) } }.buttonStyle(.link).tint(NativePalette.link)
            Button("issen.kurokamicorp.com") { model.perform { _ = try await model.call("launch_web",["url":"https://issen.kurokamicorp.com"]) } }.buttonStyle(.link).tint(NativePalette.link)
            Text("SwiftUI on macOS · Rust encryption and sync core").font(.caption).foregroundStyle(NativePalette.secondary)
        }.frame(maxWidth:.infinity,maxHeight:.infinity)
    }
    func intBinding(_ key: String) -> Binding<Int> { Binding(get:{settings.number(key)},set:{settings[key] = $0}) }
    func load() { error = nil; Task { do { settings = try await model.call("get_settings") as? Row ?? [:] } catch { self.error = error.localizedDescription } } }
}
struct NativeSecurity: View {
    @ObservedObject var model: NativeModel
    @Binding var settings: Row
    @State private var current = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var kdf = "standard"
    @State private var code = ""
    @State private var account = ""
    @State private var enrollment: Row?
    var body: some View {
        Form {
            Section("Memory protection") {
                Label(settings.flag("memoryLocked") ? "Key memory is locked" : "The OS refused to lock key memory",systemImage:settings.flag("memoryLocked") ? "checkmark.shield" : "exclamationmark.shield").foregroundStyle(settings.flag("memoryLocked") ? NativePalette.secondary : NativePalette.warning)
                Text("Key derivation: \(settings.text("kdfProfile")) · \(settings.row("kdf").number("mCostKib") / 1024) MiB · \(settings.row("kdf").number("tCost")) passes").font(.caption)
                if !settings.flag("kdfMeetsFloor") { Text("Upgrade key derivation when changing your password.").foregroundStyle(NativePalette.warning) }
            }
            Section("Change master password") {
                SecureField("Current password",text:$current); SecureField("New password",text:$password); SecureField("Repeat new password",text:$confirmation)
                Picker("Key derivation",selection:$kdf) { Text("Standard").tag("standard"); Text("Hardened").tag("hardened") }
                Button("Change password") {
                    let old = current; let new = password; current = ""; password = ""; confirmation = ""
                    model.perform { _ = try await model.call("change_password",["current":old,"newPassword":new,"kdf":kdf]); settings = try await model.call("get_settings") as? Row ?? settings; model.notice = "Master password changed" }
                }.disabled(model.busy || current.isEmpty || password.count < 12 || password != confirmation)
            }
            Section("Authenticator") {
                if let enrollment { NativeEnrollment(enrollment:enrollment); TextField("Six-digit code",text:$code); Button("Verify authenticator") { model.perform { _ = try await model.call("confirm_totp",["code":code]); self.enrollment = nil; code = ""; settings = try await model.call("get_settings") as? Row ?? settings } }.disabled(code.count != 6 || model.busy); Button("Cancel pairing") { self.enrollment = nil; code = "" } }
                else if settings.flag("totpEnabled") { Text("Authenticator enabled"); TextField("Current code to disable",text:$code); Button("Disable authenticator",role:.destructive) { model.perform { _ = try await model.call("totp_disable",["code":code]); code = ""; settings = try await model.call("get_settings") as? Row ?? settings } }.disabled(code.count != 6 || model.busy) }
                else { TextField("Authenticator account",text:$account); Button("Set up authenticator") { model.perform { enrollment = try await model.call("totp_begin",["account":account.isEmpty ? settings.text("displayName") : account]) as? Row } }.disabled(model.busy) }
            }
        }.formStyle(.grouped).onDisappear { current = ""; password = ""; confirmation = ""; code = ""; enrollment = nil }
    }
}
struct NativeSyncSettings: View {
    @ObservedObject var model: NativeModel
    @State private var resolution: String?
    var body: some View {
        Form {
            Section("Destinations") {
                ForEach(model.sync.rows("linked"),id:\.entityID) { remote in
                    HStack { VStack(alignment:.leading) { Text(remote.text("label")).font(.headline); Text(remote.text("remotePath")).font(.caption).foregroundStyle(NativePalette.secondary).textSelection(.enabled) }; Spacer(); Button("Unlink",role:.destructive) { model.perform { model.sync = try await model.call("unlink_remote",["id":remote.text("id")]) as? Row ?? [:] } }.disabled(model.sync.flag("busy") || model.busy) }
                }
                Button("Add destination…") { model.sheet = NativeSheet(kind:"cloud") }.disabled(model.sync.flag("busy") || model.busy)
                Toggle("Sync automatically",isOn:Binding(get:{model.sync.flag("autoSync")},set:{ enabled in model.perform { model.sync = try await model.call("set_auto_sync",["enabled":enabled]) as? Row ?? [:] } }))
                Button(model.sync.flag("busy") ? "Syncing…" : "Sync now") { model.perform { model.sync = try await model.call("sync_now") as? Row ?? [:] } }.disabled(model.sync.rows("linked").isEmpty || model.sync.flag("busy") || model.busy)
            }
            Section("Status") {
                if !model.sync.text("lastError").isEmpty { Text(model.sync.text("lastError")).foregroundStyle(NativePalette.danger).textSelection(.enabled) }
                else { Text(model.sync.text("lastOutcome","No sync yet")).foregroundStyle(NativePalette.secondary) }
                if model.sync.number("lastSyncedAtMs") > 0 { Text(Date(timeIntervalSince1970:Double(model.sync.number("lastSyncedAtMs"))/1000),style:.date).font(.caption) }
            }
            if !model.sync.row("conflict").isEmpty {
                Section("Conflicting vault versions") {
                    Text("Both copies changed. Choose which version to keep for \(model.sync.row("conflict").text("label")).")
                    Text("Local: \(Date(timeIntervalSince1970:Double(model.sync.row("conflict").number("localSavedAtMs"))/1000).formatted())").font(.caption)
                    Text("Remote: \(Date(timeIntervalSince1970:Double(model.sync.row("conflict").number("remoteSavedAtMs"))/1000).formatted())").font(.caption)
                    HStack { Button("Keep this device") { resolution = "mine" }; Button("Use remote version") { resolution = "theirs" } }.disabled(model.busy || model.sync.flag("busy"))
                }
            }
        }.formStyle(.grouped)
        .confirmationDialog("Replace the \(resolution == "mine" ? "remote" : "local") version?",isPresented:Binding(get:{resolution != nil},set:{if !$0 {resolution = nil}}),titleVisibility:.visible) {
            Button("Replace version",role:.destructive) { let choice = resolution ?? ""; resolution = nil; model.perform { model.sync = try await model.call("resolve_conflict",["choice":choice]) as? Row ?? [:]; try await model.refresh() } }
        } message: { Text("Changes unique to the version being replaced will be lost. Save an encrypted backup first if you need to retain it.") }
    }
}
struct NativeImport: View {
    @ObservedObject var model: NativeModel
    @State private var preview: Row?
    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            Text("Import inventory").font(.title2)
            Text("Review the file before applying it. Imports are validated and saved together.").foregroundStyle(NativePalette.secondary)
            Button("Choose Excel or JSON…") { model.perform { preview = try await model.call("import_preview") as? Row } }.disabled(model.busy)
            if let preview {
                Text(preview.text("fileName")).font(.headline)
                ScrollView {
                    let report = preview.row("report")
                    VStack(alignment:.leading,spacing:10) {
                        ForEach(["created","updated"],id:\.self) { key in Text(key.capitalized).font(.headline); ForEach(report.row(key).keys.sorted(),id:\.self) { entity in if report.row(key).number(entity) > 0 { Text("\(report.row(key).number(entity)) \(entity)") } } }
                        ForEach(["errors","warnings"],id:\.self) { key in ForEach(Array(report.rows(key).enumerated()),id:\.offset) { pair in Text("\(pair.element.text("sheet")) row \(pair.element.number("row")): \(pair.element.text("message"))").foregroundStyle(key == "errors" ? NativePalette.danger : NativePalette.warning) } }
                    }.frame(maxWidth:.infinity,alignment:.leading)
                }
            }
            HStack { Spacer(); Button("Cancel") { model.sheet = nil }.keyboardShortcut(.cancelAction); Button("Apply import") { model.perform { let result = try await model.call("import_apply") as? Row ?? [:]; model.topology = result.row("topology"); model.sheet = nil; model.notice = "Inventory imported" } }.buttonStyle(NativePrimaryButtonStyle()).disabled(preview == nil || !(preview?.row("report").rows("errors").isEmpty ?? false) || model.busy) }
        }.padding(24).nativeSheetSize(model,width:600,height:550)
    }
}
struct NativeExport: View {
    @ObservedObject var model: NativeModel
    @State private var format = "xlsx"
    @State private var include = false
    @State private var password = ""
    var body: some View {
        VStack(alignment:.leading,spacing:18) {
            Text("Export inventory").font(.title2)
            Picker("Format",selection:$format) { Text("Excel").tag("xlsx"); Text("JSON").tag("json") }.pickerStyle(.segmented)
            Toggle("Include passwords and private keys",isOn:$include)
            if include { Text("The exported file will contain readable secrets. Enter your master password to confirm.").foregroundStyle(NativePalette.warning); SecureField("Master password",text:$password) }
            HStack { Spacer(); Button("Cancel") { model.sheet = nil }; Button("Export…") { let pw = password; password = ""; model.perform { if let path = try await model.call("export_data",["format":format,"includeSecrets":include,"password":include ? pw as Any : NSNull()]) as? String { model.notice = "Saved \(path)"; model.sheet = nil } } }.buttonStyle(NativePrimaryButtonStyle()).disabled(model.busy || include && password.isEmpty) }
        }.padding(24).frame(width:500).onDisappear { password = "" }
    }
}
