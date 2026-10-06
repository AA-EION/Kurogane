import SwiftUI
import WebKit

// The graph owns no vault, credentials, forms or settings. It receives only
// secret-free topology and returns selections or generated map files.
@MainActor final class NativeGraphController: NSObject, WKScriptMessageHandler {
    weak var model: NativeModel?
    var webView: WKWebView?
    private var lastState = ""
    init(model: NativeModel) { self.model = model }
    func attach(_ view: WKWebView) {
        webView = view
        view.configuration.userContentController.add(self, name: "kuroganeGraph")
        view.configuration.userContentController.addUserScript(WKUserScript(source:"window.__KUROGANE_NATIVE_GRAPH__ = true;",injectionTime:.atDocumentStart,forMainFrameOnly:true))
        view.setValue(false,forKey:"drawsBackground")
        view.removeFromSuperview()
        if view.url != nil { view.reload() }
    }
    func update() {
        guard let model, let webView else { return }
        let selected: Any = model.selected.map { ["kind":$0.kind,"id":$0.id] as Any } ?? NSNull()
        var picture = model.topology; picture["credentials"] = []
        let state: Row = ["topology":model.unlocked && picture["tenants"] != nil ? picture as Any : NSNull(),"selected":selected,"appearance":model.appearance,"fit":model.fit.uuidString]
        guard let data = try? JSONSerialization.data(withJSONObject:state,options:[.sortedKeys]), let json = String(data:data,encoding:.utf8), json != lastState else { return }
        webView.evaluateJavaScript("if (window.kuroganeGraph) { window.kuroganeGraph.update(\(json)); true } else { false }") { [weak self] result,error in
            guard let self else { return }
            if result as? Bool == true && error == nil { self.lastState = json; self.model?.graphReady = true }
        }
    }
    func clear() { lastState = ""; update() }
    func export(_ format: String) {
        guard let model, !model.busy, !model.graphExporting, model.graphReady else { return }
        model.graphExporting = true
        webView?.evaluateJavaScript("window.kuroganeGraph.export('\(format)'); undefined") { [weak self] _,error in
            if let error { self?.model?.error = error.localizedDescription; self?.model?.graphExporting = false }
        }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? Row, let model else { return }
        switch body.text("type") {
        case "ready": lastState = ""; update()
        case "select":
            guard model.unlocked else { return }
            let item = body.row("item"), kind = item.text("kind"), id = item.text("id")
            if item.isEmpty { model.selected = nil }
            else if model.rows(kind).contains(where: { $0.entityID == id }) { model.selected = NativeItem(kind:kind,id:id) }
        case "file":
            guard model.unlocked, model.graphExporting, ["png","svg","json"].contains(body.text("format")) else { return }
            let format = body.text("format")
            model.perform {
                defer { model.graphExporting = false }
                let path = try await model.call("save_file",["suggestedName":"Kurogane-map.\(format)","dataBase64":body.text("dataBase64"),"filterName":"Map","extensions":[format]])
                if let path = path as? String { model.notice = "Saved \(path)" }
            }
        case "error": model.graphExporting = false; model.error = body.text("message")
        default: break
        }
    }
}
func findGraphWebView(_ view: NSView?) -> WKWebView? {
    guard let view else { return nil }
    if let web = view as? WKWebView { return web }
    return view.subviews.lazy.compactMap { findGraphWebView($0) }.first
}
final class GraphContainer: NSView {
    override func layout() { super.layout(); subviews.forEach { $0.frame = bounds } }
}
struct NativeGraphView: NSViewRepresentable {
    @ObservedObject var model: NativeModel
    func makeNSView(context: Context) -> GraphContainer {
        let container = GraphContainer(); container.wantsLayer = true; container.layer?.masksToBounds = true
        #if NATIVE_PREVIEW
        if model.graph.webView == nil, let address = ProcessInfo.processInfo.environment["KUROGANE_NATIVE_GRAPH_URL"], let url = URL(string:address) {
            let view = WKWebView(); model.graph.attach(view); view.load(URLRequest(url:url))
        }
        #endif
        if let view = model.graph.webView { view.removeFromSuperview(); view.autoresizingMask = [.width,.height]; view.frame = container.bounds; container.addSubview(view) }
        return container
    }
    func updateNSView(_ view: GraphContainer, context: Context) { model.graph.update(); view.needsLayout = true }
}

// Keep sheets inside their actual host window rather than enforcing a height
// larger than the available content area (common on MacBooks and small windows).
@MainActor func nativeSheetSize(_ model: NativeModel, width: CGFloat, height: CGFloat) -> CGSize {
    let available = model.window?.contentLayoutRect.size ?? NSSize(width:960,height:640)
    return CGSize(width:min(width,max(420,available.width-48)),height:min(height,max(360,available.height-64)))
}
struct NativeSheetSizing: ViewModifier {
    @ObservedObject var model: NativeModel
    let width: CGFloat
    let height: CGFloat
    func body(content: Content) -> some View {
        let size = nativeSheetSize(model,width:width,height:height)
        content.frame(width:size.width,height:size.height)
    }
}
extension View {
    func nativeSheetSize(_ model: NativeModel, width: CGFloat, height: CGFloat) -> some View { modifier(NativeSheetSizing(model:model,width:width,height:height)) }
}
