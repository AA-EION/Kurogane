#if NATIVE_SMOKE || NATIVE_PREVIEW
import AppKit
import WebKit

// WKWebView's accelerated layer is not included in cacheDisplay. Snapshot that
// layer at its actual position in the window; never substitute a fixture image.
@MainActor func nativeCapture(_ window: NSWindow) async throws -> Data {
    guard let view = window.contentView else { throw NativeFailure(message:"No native view") }
    view.layoutSubtreeIfNeeded()
    guard let bitmap = view.bitmapImageRepForCachingDisplay(in:view.bounds) else { throw NativeFailure(message:"No native bitmap") }
    view.cacheDisplay(in:view.bounds,to:bitmap)
    if let graph = findGraphWebView(view), graph.bounds.width > 0, graph.bounds.height > 0 {
        let image = try await graph.takeSnapshot(configuration:nil)
        var rect = view.convert(graph.bounds,from:graph)
        if view.isFlipped { rect.origin.y = view.bounds.height - rect.maxY }
        if let context = NSGraphicsContext(bitmapImageRep:bitmap) {
            NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
            image.draw(in:rect,from:.zero,operation:.sourceOver,fraction:1)
            NSGraphicsContext.restoreGraphicsState()
        }
    }
    guard let data = bitmap.representation(using:.png,properties:[:]), data.count > 1000 else { throw NativeFailure(message:"Empty native capture") }
    return data
}
#endif
