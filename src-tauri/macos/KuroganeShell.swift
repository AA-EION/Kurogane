import AppKit
import SwiftUI
import WebKit

// Native SwiftUI navigation lives in the existing Tauri NSWindow. The shared
// workspace keeps all editors and the isometric map; Rust still owns secrets.
// No duplicate database, local HTTP server or second vault process is used.
@MainActor
final class ShellModel: NSObject, ObservableObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    weak var window: NSWindow?
    @Published var unlocked = false
    @Published var title = "Kurogane"
    @Published var companies = false
    @Published var hosts = false
    @Published var sync = "Set up sync"
    @Published var syncing = false

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "kuroganeAppearance", let theme = message.body as? String {
            window?.appearance = NSAppearance(named: theme == "dark" ? .darkAqua : .aqua)
        } else if message.name == "kuroganeState", let state = message.body as? [String: Any] {
            unlocked = state["unlocked"] as? Bool ?? false
            title = state["title"] as? String ?? "Kurogane"
            companies = state["companies"] as? Bool ?? false
            hosts = state["hosts"] as? Bool ?? false
            sync = state["sync"] as? String ?? "Set up sync"
            syncing = state["syncing"] as? Bool ?? false
        }
    }

    func action(_ name: String) {
        guard unlocked, ["search", "lock", "settings", "sync", "fit", "tenant", "host", "service", "proxy", "credential", "network", "import"].contains(name) else { return }
        // Names are fixed above; arbitrary JavaScript never enters this bridge.
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('kurogane:native-action', {detail:'\(name)'}))", completionHandler: nil)
    }
}

struct NativeMaterial: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content.glassEffect(.regular, in: RoundedRectangle(cornerRadius: 12))
        } else {
            content.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

struct KuroganeToolbar: View {
    @ObservedObject var model: ShellModel
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "cube.fill").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Text("Issen Software Group").font(.system(size: 10)).foregroundStyle(.secondary)
            }.frame(maxWidth: 240, alignment: .leading)
            Spacer(minLength: 8)
            HStack(spacing: 4) {
                Button { model.action("search") } label: { Label("Search", systemImage: "magnifyingglass") }
                    .help("Search inventory (⌘K)")
                Button { model.action("fit") } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                    .help("Fit the entire map")
                Menu {
                    Button("Company") { model.action("tenant") }
                    Button("Machine") { model.action("host") }.disabled(!model.companies)
                    Button("Service") { model.action("service") }.disabled(!model.hosts)
                    Button("Reverse proxy") { model.action("proxy") }.disabled(!model.hosts)
                    Button("Account") { model.action("credential") }.disabled(!model.companies)
                    Button("Network") { model.action("network") }.disabled(!model.companies)
                    Divider()
                    Button("Import inventory…") { model.action("import") }
                } label: { Label("New", systemImage: "plus") }
                Button { model.action("sync") } label: { Image(systemName: "arrow.triangle.2.circlepath") }
                    .help(model.sync).disabled(model.syncing)
                Button { model.action("settings") } label: { Image(systemName: "gearshape") }
                    .help("Settings")
                Button { model.action("lock") } label: { Image(systemName: "lock") }
                    .help("Lock vault (⌘L)")
            }
            .buttonStyle(.borderless)
            .controlSize(.regular)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .modifier(NativeMaterial())
            .disabled(!model.unlocked)
        }
        .padding(.horizontal, 18).padding(.vertical, 8)
    }
}

@MainActor
private func findWebView(_ root: NSView) -> WKWebView? {
    if let web = root as? WKWebView { return web }
    for view in root.subviews { if let web = findWebView(view) { return web } }
    return nil
}

@_cdecl("kurogane_install_swift_shell")
public func installShell(_ pointer: UnsafeMutableRawPointer) {
    // Called through Tauri's main-thread scheduler after the window is ready.
    MainActor.assumeIsolated {
        let window = Unmanaged<NSWindow>.fromOpaque(pointer).takeUnretainedValue()
        guard let content = window.contentView, let web = findWebView(content) else { return }
        let model = ShellModel()
        model.window = window
        model.webView = web
        let controller = web.configuration.userContentController
        controller.add(model, name: "kuroganeState")
        controller.add(model, name: "kuroganeAppearance")
        let script = "document.documentElement.dataset.nativeShell='swift';window.dispatchEvent(new Event('kurogane:native-ready'));window.webkit.messageHandlers.kuroganeAppearance.postMessage(document.documentElement.dataset.theme || 'light');"
        controller.addUserScript(WKUserScript(source: "document.addEventListener('DOMContentLoaded', function(){\(script)}, {once:true});", injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        web.evaluateJavaScript(script, completionHandler: nil)
        let toolbar = NSHostingView(rootView: KuroganeToolbar(model: model))
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(toolbar)
        NSLayoutConstraint.activate([
            toolbar.topAnchor.constraint(equalTo: content.topAnchor),
            toolbar.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            toolbar.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            toolbar.heightAnchor.constraint(equalToConstant: 62)
        ])
        window.title = "Kurogane"
        window.titlebarAppearsTransparent = true
        window.toolbarStyle = .unified
        window.appearance = NSAppearance(named: .aqua)
    }
}
