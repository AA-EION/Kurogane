import AppKit
import SwiftUI
import Combine

typealias Row = [String: Any]
extension Dictionary where Key == String, Value == Any {
    var entityID: String { text("id") }
    func text(_ key: String, _ fallback: String = "") -> String { self[key] as? String ?? fallback }
    func flag(_ key: String) -> Bool { self[key] as? Bool ?? false }
    func number(_ key: String, _ fallback: Int = 0) -> Int { (self[key] as? NSNumber)?.intValue ?? fallback }
    func rows(_ key: String) -> [Row] { self[key] as? [Row] ?? [] }
    func row(_ key: String) -> Row { self[key] as? Row ?? [:] }
}
struct NativeItem: Identifiable, Hashable {
    let kind: String
    let id: String
}
struct NativeSheet: Identifiable {
    let id = UUID()
    var kind: String
    var item: Row = [:]
}
struct NativeFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
#if !NATIVE_PREVIEW
@_silgen_name("kurogane_native_request")
func rustRequest(_ message: UnsafePointer<CChar>)
#endif

@MainActor final class NativeBridge {
    static let shared = NativeBridge()
    private var pending: [String: CheckedContinuation<Any, Error>] = [:]
    var event: ((String, Any) -> Void)?
    func call(_ command: String, _ args: Row = [:]) async throws -> Any {
        #if NATIVE_PREVIEW
        return NativeFixture.reply(command, args)
        #else
        let id = UUID().uuidString
        let data = try JSONSerialization.data(withJSONObject: ["id": id, "command": command, "args": args])
        let message = String(decoding: data, as: UTF8.self)
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            message.withCString { rustRequest($0) }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 300_000_000_000)
                if let expired = pending.removeValue(forKey: id) { expired.resume(throwing: NativeFailure(message: "The operation timed out. Try again.")) }
            }
        }
        #endif
    }
    func receive(_ data: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? Row else { return }
        if let name = object["event"] as? String { event?(name, object["payload"] ?? NSNull()); return }
        guard let continuation = pending.removeValue(forKey: object.text("id")) else { return }
        if let error = object["error"] as? String { continuation.resume(throwing: NativeFailure(message: error)) }
        else { continuation.resume(returning: object["result"] ?? NSNull()) }
    }
}
@_cdecl("kurogane_native_receive_json")
public func receiveNativeJSON(_ pointer: UnsafePointer<CChar>) {
    let data = Data(String(cString: pointer).utf8)
    DispatchQueue.main.async { NativeBridge.shared.receive(data) }
}

@MainActor final class NativeModel: ObservableObject {
    @Published var status: Row = [:]
    @Published var topology: Row = [:]
    @Published var sync: Row = [:]
    @Published var selected: NativeItem?
    @Published var sheet: NativeSheet?
    @Published var query = ""
    @Published var error: String?
    @Published var notice: String?
    @Published var loading = true
    @Published var busy = false
    @Published var cloudStep = ""
    @Published var fit = UUID()
    @Published var mapMode = true
    @Published var appearance = UserDefaults.standard.string(forKey: "kurogane.appearance") ?? "light" {
        didSet { UserDefaults.standard.set(appearance, forKey: "kurogane.appearance"); applyAppearance() }
    }
    weak var window: NSWindow?
    var eventMonitor: Any?
    private var lastTouch = Date.distantPast
    private var vaultGeneration = 0
    var unlocked: Bool { status.text("stage") == "unlocked" }
    var items: [NativeItem] {
        ["tenant", "network", "host", "service", "proxy", "credential"].flatMap { kind in rows(kind).map { NativeItem(kind: kind, id: $0.text("id")) } }
            .filter { query.isEmpty || name($0).localizedCaseInsensitiveContains(query) || String(describing: row($0)).localizedCaseInsensitiveContains(query) }
    }
    func rows(_ kind: String) -> [Row] { topology.rows(collection(kind)) }
    func row(_ item: NativeItem) -> Row { rows(item.kind).first { $0.text("id") == item.id } ?? [:] }
    func name(_ item: NativeItem) -> String { let r = row(item); return r.text("name", r.text("label", "Untitled")) }
    func title(_ kind: String) -> String { ["tenant":"Company", "host":"Machine", "service":"Service", "proxy":"Reverse proxy", "credential":"Account", "network":"Network"][kind] ?? kind.capitalized }
    func collection(_ kind: String) -> String { ["tenant":"tenants", "host":"hosts", "service":"services", "proxy":"proxies", "credential":"credentials", "network":"networks"][kind] ?? kind }
    func icon(_ kind: String) -> String { ["tenant":"building.2", "host":"server.rack", "service":"shippingbox", "proxy":"arrow.triangle.branch", "credential":"key", "network":"network"][kind] ?? "cube" }
    func applyAppearance() { window?.appearance = appearance == "system" ? nil : NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua) }
    func call(_ command: String, _ args: Row = [:]) async throws -> Any { try await NativeBridge.shared.call(command, args) }
    func perform(_ body: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; error = nil
        Task { do { try await body() } catch { self.error = error.localizedDescription }; busy = false }
    }
    func refresh() async throws {
        let generation = vaultGeneration
        let next = try await call("app_status") as? Row ?? [:]
        guard generation == vaultGeneration else { return }
        status = next
        if unlocked {
            let picture = try await call("topology") as? Row ?? [:]
            guard generation == vaultGeneration && unlocked else { return }
            topology = picture
            sync = try await call("sync_status") as? Row ?? [:]
        }
        else { clearVault() }
        loading = false
    }
    func clearVault() { vaultGeneration += 1; topology = [:]; sync = [:]; selected = nil; sheet = nil; query = ""; notice = nil; cloudStep = "" }
    func start() {
        NativeBridge.shared.event = { [weak self] name, payload in
            guard let self else { return }
            if name == "vault://locked" { clearVault(); status["stage"] = "locked"; busy = false }
            if name == "sync://status" { sync = payload as? Row ?? [:] }
            if name == "cloud:step" { let step = payload as? Row ?? [:]; cloudStep = step.text("step").capitalized; if step.text("step") == "error" { error = step.text("message") } }
            if name == "vault://changed" || name == "vault://locked" { Task { try? await self.refresh() } }
        }
        // Only real user input extends the session; rendering and polling do not.
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .scrollWheel]) { [weak self] event in
            MainActor.assumeIsolated {
                if let self, self.unlocked, Date().timeIntervalSince(self.lastTouch) > 1 {
                    self.lastTouch = Date(); Task { _ = try? await self.call("touch") }
                }
            }
            return event
        }
        Task {
            do { try await refresh() } catch { self.error = error.localizedDescription; loading = false }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                let generation = vaultGeneration
                if let next = try? await call("app_status") as? Row, generation == vaultGeneration { let wasUnlocked = unlocked; status = next; if wasUnlocked && !unlocked { clearVault() } }
            }
        }
    }
    func save(_ kind: String, _ row: Row) async throws {
        let generation = vaultGeneration
        let saved = try await call("save_\(kind)", [kind: row]) as? Row ?? [:]
        guard unlocked && generation == vaultGeneration else { return }
        topology = saved.row("topology"); selected = NativeItem(kind: kind, id: saved.text("id")); sheet = nil
    }
    func edit(_ kind: String, _ row: Row = [:]) { sheet = NativeSheet(kind: "edit:\(kind)", item: row) }
    func openSettings() { sheet = NativeSheet(kind: "settings") }
}

struct NativeMaterial: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        if #available(macOS 26.0, *) { content.glassEffect(.regular, in: RoundedRectangle(cornerRadius: 14)) }
        else { content.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14)) }
    }
}
struct TactilePanel: ViewModifier {
    func body(content: Content) -> some View {
        content.padding(18).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.28), lineWidth: 1)).shadow(color: .black.opacity(0.08), radius: 12, y: 5)
    }
}
struct NativeRoot: View {
    @ObservedObject var model: NativeModel
    var body: some View {
        VStack(spacing: 0) {
            if model.loading { ProgressView("Opening Kurogane…").frame(maxWidth: .infinity, maxHeight: .infinity) }
            else if model.unlocked { NativeWorkspace(model: model) }
            else { NativeVaultScreen(model: model) }
        }.background(Color(nsColor: .windowBackgroundColor)).frame(minWidth: 920, minHeight: 640)
        .sheet(item: $model.sheet) { sheet in NativeSheetView(model: model, sheet: sheet).background(Color(nsColor: .windowBackgroundColor)).id(sheet.id).interactiveDismissDisabled(model.busy) }
        .alert("Operation failed", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK") { model.error = nil }
            if model.status.isEmpty { Button("Retry") { model.perform { try await model.refresh() } } }
        } message: { Text(model.error ?? "") }
    }
}
struct NativeWorkspace: View {
    @ObservedObject var model: NativeModel
    @FocusState private var searching: Bool
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Label(model.topology.text("vaultName", "Kurogane"), systemImage: "cube.fill").font(.headline)
                Text("ISSEN").font(.system(size: 10, weight: .semibold, design: .rounded)).foregroundStyle(.secondary)
                Spacer()
                if !model.status.flag("memoryLocked") { Label("Memory not locked", systemImage: "exclamationmark.shield").font(.caption).foregroundStyle(.orange).help("The OS refused to lock key memory. See Security settings.") }
                Text("\(model.status.number("remainingSecs"))s").monospacedDigit().foregroundStyle(.secondary).font(.caption)
                HStack(spacing: 10) {
                    Button { searching = true } label: { Image(systemName: "magnifyingglass") }.help("Search inventory").keyboardShortcut("k")
                    Button { model.fit = UUID() } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }.help("Fit map")
                    Menu {
                        ForEach(["tenant", "host", "service", "proxy", "network", "credential"], id: \.self) { kind in
                            Button(model.title(kind)) { model.edit(kind) }.disabled(kind != "tenant" && model.rows("tenant").isEmpty || ["service", "proxy"].contains(kind) && model.rows("host").isEmpty)
                        }
                        Divider(); Button("Import inventory…") { model.sheet = NativeSheet(kind: "import") }
                    } label: { Label("New", systemImage: "plus") }
                    Button { if model.sync.rows("linked").isEmpty { model.openSettings() } else { model.perform { model.sync = try await model.call("sync_now") as? Row ?? [:] } } } label: { Image(systemName: "arrow.triangle.2.circlepath") }.help("Sync vault").disabled(model.busy || model.sync.flag("busy"))
                    Button { model.openSettings() } label: { Image(systemName: "gearshape") }.help("Settings").keyboardShortcut(",")
                    Button { model.perform { _ = try await model.call("lock") } } label: { Image(systemName: "lock") }.help("Lock vault").keyboardShortcut("l")
                }.buttonStyle(.borderless).padding(12).modifier(NativeMaterial())
            }.padding(.horizontal, 20).padding(.vertical, 10)
            Divider()
            HSplitView {
                VStack(alignment: .leading, spacing: 10) {
                    TextField("Search inventory", text: $model.query).textFieldStyle(.roundedBorder).focused($searching).padding(.horizontal, 12).padding(.top, 12)
                    List(selection: $model.selected) {
                        ForEach(["tenant", "host", "service", "proxy", "network", "credential"], id: \.self) { kind in
                            Section(model.title(kind)) {
                                ForEach(model.items.filter { $0.kind == kind }) { item in
                                    Label(model.name(item), systemImage: model.icon(kind)).tag(item)
                                        .contextMenu { Button("Edit…") { model.edit(kind, model.row(item)) }; Button("Delete…", role: .destructive) { model.sheet = NativeSheet(kind: "delete:\(kind)", item: model.row(item)) } }
                                }
                            }
                        }
                    }.listStyle(.sidebar)
                    Text("Encrypted infrastructure inventory").font(.caption2).foregroundStyle(.secondary).padding(12)
                }.frame(minWidth: 185, idealWidth: 220, maxWidth: 240)
                VStack(spacing: 0) {
                    HStack {
                        Picker("View", selection: $model.mapMode) { Text("Map").tag(true); Text("Inventory").tag(false) }.pickerStyle(.segmented).frame(width: 180)
                        Spacer()
                        Menu("Export") {
                            Button("Map as PNG…") { exportNativeMap(model) }; Button("Map as SVG…") { exportNativeSVG(model) }; Button("FossFLOW JSON…") { exportNativeFoss(model) }
                            Divider(); Button("Inventory…") { model.sheet = NativeSheet(kind: "export") }
                        }
                    }.padding(12)
                    if model.mapMode { NativeMap(model: model) } else { NativeInventory(model: model) }
                    HStack {
                        Text("\(model.rows("host").count) machines · \(model.rows("service").count) services").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        if model.sync.flag("busy") { ProgressView().controlSize(.small); Text("Syncing…").font(.caption) }
                        else if !model.sync.text("lastError").isEmpty { Button("Sync needs attention") { model.openSettings() }.font(.caption).foregroundStyle(.orange) }
                        else { Text(model.notice ?? model.sync.text("lastOutcome", "Saved locally")).font(.caption).foregroundStyle(.secondary) }
                    }.padding(12)
                }.frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
                if let selected = model.selected { NativeInspector(model: model, item: selected).frame(minWidth: 240, idealWidth: 285, maxWidth: 320) }
            }
        }
    }
}
struct NativeInventory: View {
    @ObservedObject var model: NativeModel
    var body: some View {
        List {
            ForEach(model.items) { item in
                Button { model.selected = item } label: { HStack { Image(systemName: model.icon(item.kind)).frame(width: 24); Text(model.name(item)); Spacer(); Text(model.title(item.kind)).font(.caption).foregroundStyle(.secondary) }.padding(.vertical, 6) }.buttonStyle(.plain)
            }
            if model.items.isEmpty { Text(model.query.isEmpty ? "Your inventory is empty. Add a company to begin." : "No matching inventory.").foregroundStyle(.secondary).padding() }
        }
    }
}
@MainActor private var nativeModel: NativeModel?
@_cdecl("kurogane_install_swift_shell")
public func installShell(_ pointer: UnsafeMutableRawPointer) {
    MainActor.assumeIsolated {
        let window = Unmanaged<NSWindow>.fromOpaque(pointer).takeUnretainedValue()
        let model = NativeModel(); model.window = window; nativeModel = model
        // The entire visible content is SwiftUI. No WKWebView is embedded.
        window.contentView = NSHostingView(rootView: NativeRoot(model: model))
        window.title = "Kurogane"; window.titlebarAppearsTransparent = true; window.toolbarStyle = .unified
        window.minSize = NSSize(width: 920, height: 640); model.applyAppearance(); model.start()
        #if NATIVE_SMOKE
        startNativeSmoke(model)
        #endif
    }
}
