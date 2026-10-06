import AppKit
import SwiftUI

struct MapNode: Identifiable {
    var id: String { item.kind + item.id }
    let item: NativeItem
    let row: Row
    let rect: CGRect
}
struct MapZone: Identifiable {
    let id: String
    let name: String
    let rect: CGRect
}
struct MapLayout {
    var nodes: [MapNode] = []
    var zones: [MapZone] = []
    var size = CGSize(width: 700, height: 500)
    init(_ topology: Row) {
        var y: CGFloat = 50
        for tenant in topology.rows("tenants") {
            let hosts = topology.rows("hosts").filter { $0.text("tenantId") == tenant.text("id") }
            let start = y
            let maxServices = hosts.map { host in topology.rows("services").filter { $0.text("hostId") == host.text("id") }.count }.max() ?? 0
            let extra = CGFloat(max(0, maxServices - 3)) * 40
            nodes.append(MapNode(item: NativeItem(kind: "tenant", id: tenant.text("id")), row: tenant, rect: CGRect(x: 48, y: y, width: 220, height: 42)))
            y += 70
            for (index, host) in hosts.enumerated() {
                let x: CGFloat = 80 + CGFloat(index % 2) * 310
                let hostY = y + CGFloat(index / 2) * (255 + extra)
                nodes.append(MapNode(item: NativeItem(kind: "host", id: host.text("id")), row: host, rect: CGRect(x: x, y: hostY, width: 245, height: 80)))
                let services = topology.rows("services").filter { $0.text("hostId") == host.text("id") }
                for (n, service) in services.enumerated() {
                    nodes.append(MapNode(item: NativeItem(kind: "service", id: service.text("id")), row: service, rect: CGRect(x: x + 22, y: hostY + 95 + CGFloat(n) * 40, width: 218, height: 34)))
                }
            }
            // Rows expand for machines with many services so cards never overlap.
            y += CGFloat(max(1, (hosts.count + 1) / 2)) * (255 + extra)
            zones.append(MapZone(id: tenant.text("id"), name: tenant.text("name"), rect: CGRect(x: 30, y: start - 18, width: 650, height: y - start)))
            y += 38
        }
        size = CGSize(width: 720, height: max(500, y + 20))
    }
    func point(_ kind: String, _ id: String) -> CGPoint? { nodes.first { $0.item.kind == kind && $0.item.id == id }.map { CGPoint(x: $0.rect.midX, y: $0.rect.midY) } }
    func connectors(_ topology: Row) -> [(CGPoint, CGPoint, Bool)] {
        topology.rows("proxies").flatMap { proxy in
            proxy.rows("routes").compactMap { route -> (CGPoint, CGPoint, Bool)? in
                guard let from = point("host", proxy.text("hostId")), let to = point("service", route.text("serviceId")) ?? point("host", route.text("targetHostId")), from != to else { return nil }
                return (from, to, route.flag("enabled"))
            }
        }
    }
}
struct NativeMap: View {
    @ObservedObject var model: NativeModel
    @State private var zoom: CGFloat = 1
    @GestureState private var magnification: CGFloat = 1
    var body: some View {
        GeometryReader { geometry in
            let layout = MapLayout(model.topology)
            VStack(spacing: 0) {
                ScrollView([.horizontal, .vertical]) {
                    NativeMapDrawing(model: model, layout: layout)
                        .scaleEffect(zoom * magnification, anchor: .topLeading)
                        .frame(width: layout.size.width * zoom * magnification, height: layout.size.height * zoom * magnification, alignment: .topLeading)
                }.background(Color(nsColor: .underPageBackgroundColor))
                .gesture(MagnificationGesture().updating($magnification) { v, s, _ in s = v }.onEnded { zoom = min(2, max(0.35, zoom * $0)) })
                HStack {
                    Image(systemName: "minus.magnifyingglass")
                    Slider(value: $zoom, in: 0.35...2).frame(width: 140).accessibilityLabel("Map zoom")
                    Image(systemName: "plus.magnifyingglass")
                    Text("\(Int(zoom * 100))%").font(.caption).monospacedDigit()
                    Spacer(); Text("Select a machine or service to inspect").font(.caption).foregroundStyle(.secondary)
                }.padding(10)
            }.onChange(of: model.fit) { _ in zoom = max(0.35, min(1, (geometry.size.width - 20) / layout.size.width)) }
            .onAppear { zoom = max(0.35, min(1, (geometry.size.width - 20) / layout.size.width)) }
        }
    }
}
struct NativeMapDrawing: View {
    @ObservedObject var model: NativeModel
    let layout: MapLayout
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        ZStack(alignment: .topLeading) {
            Canvas { context, size in
                for x in stride(from: CGFloat(0), through: size.width, by: 28) {
                    for y in stride(from: CGFloat(0), through: size.height, by: 28) { context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1.5, height: 1.5)), with: .color(.gray.opacity(0.18))) }
                }
                for zone in layout.zones {
                    let path = Path(roundedRect: zone.rect, cornerRadius: 24)
                    context.fill(path, with: .color(Color(nsColor: .controlBackgroundColor).opacity(0.55)))
                    context.stroke(path, with: .color(.gray.opacity(0.18)), lineWidth: 1)
                }
                for (from, to, enabled) in layout.connectors(model.topology) {
                    var path = Path(); path.move(to: from); path.addCurve(to: to, control1: CGPoint(x: from.x + 100, y: from.y), control2: CGPoint(x: to.x + 100, y: to.y - 60))
                    context.stroke(path, with: .color(enabled ? .blue.opacity(0.6) : .gray.opacity(0.4)), style: StrokeStyle(lineWidth: 2, dash: enabled ? [] : [5, 5]))
                }
                for node in layout.nodes where node.item.kind == "host" {
                    let r = node.rect.insetBy(dx: -12, dy: -8).offsetBy(dx: 12, dy: 13)
                    var slab = Path(); slab.move(to: CGPoint(x: r.minX, y: r.maxY - 10)); slab.addLine(to: CGPoint(x: r.maxX - 16, y: r.maxY - 10)); slab.addLine(to: CGPoint(x: r.maxX, y: r.maxY - 28)); slab.addLine(to: CGPoint(x: r.maxX, y: r.maxY - 12)); slab.addLine(to: CGPoint(x: r.maxX - 16, y: r.maxY + 6)); slab.addLine(to: CGPoint(x: r.minX, y: r.maxY + 6)); slab.closeSubpath()
                    context.fill(slab, with: .linearGradient(Gradient(colors: [.gray.opacity(0.35), .gray.opacity(0.16)]), startPoint: r.origin, endPoint: CGPoint(x: r.maxX, y: r.maxY)))
                }
            }
            if layout.nodes.isEmpty {
                VStack(spacing: 16) { Image(systemName: "cube.transparent").font(.system(size: 48)).foregroundStyle(.secondary); Text("Build your infrastructure map").font(.title2); Text("Start with a company, then add machines and services.").foregroundStyle(.secondary); Button("Add a company") { model.edit("tenant") }.buttonStyle(.borderedProminent) }.frame(width: 650, height: 450)
            }
            ForEach(layout.nodes) { node in
                Button { model.selected = node.item } label: { mapCard(node) }
                    .buttonStyle(.plain).frame(width: node.rect.width, height: node.rect.height)
                    .offset(x: node.rect.minX, y: node.rect.minY)
                    .accessibilityLabel("\(model.title(node.item.kind)): \(node.row.text("name"))")
                    .contextMenu { Button("Edit…") { model.edit(node.item.kind, node.row) } }
            }
        }.frame(width: layout.size.width, height: layout.size.height)
    }
    @ViewBuilder private func mapCard(_ node: MapNode) -> some View {
        if node.item.kind == "tenant" {
            HStack { Image(systemName: "building.2.fill"); VStack(alignment: .leading) { Text(node.row.text("name")).font(.headline); Text(node.row.text("environment").uppercased()).font(.system(size: 9, weight: .medium)).foregroundStyle(.secondary) }; Spacer() }.padding(.horizontal, 10)
        } else {
            HStack(spacing: 10) {
                Image(systemName: model.icon(node.item.kind)).foregroundStyle(node.item.kind == "service" ? .blue : .secondary).font(.system(size: node.item.kind == "host" ? 22 : 12))
                VStack(alignment: .leading, spacing: 4) {
                    Text(node.row.text("name")).font(.system(size: node.item.kind == "host" ? 13 : 11, weight: .semibold)).lineLimit(1)
                    if node.item.kind == "host" { Text(node.row.text("fqdn", node.row.rows("interfaces").first?.text("internalIp") ?? node.row.text("category"))).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1) }
                }; Spacer(minLength: 0)
                if node.item.kind == "service" { Circle().fill(.secondary).frame(width: 5, height: 5).accessibilityHidden(true) }
            }.padding(.horizontal, 12).frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(LinearGradient(colors: [Color(nsColor: .controlBackgroundColor), Color(nsColor: .windowBackgroundColor)], startPoint: .top, endPoint: .bottom), in: RoundedRectangle(cornerRadius: node.item.kind == "host" ? 12 : 7))
                .overlay(RoundedRectangle(cornerRadius: node.item.kind == "host" ? 12 : 7).stroke(model.selected == node.item ? Color.accentColor : .gray.opacity(0.28), lineWidth: model.selected == node.item ? 2 : 1))
                .shadow(color: .black.opacity(colorScheme == .dark ? 0.35 : 0.10), radius: 5, y: 4)
        }
    }
}
@MainActor func saveNativeBytes(_ model: NativeModel, _ data: Data, _ name: String, _ ext: String) {
    model.perform {
        let path = try await model.call("save_file", ["suggestedName":name, "dataBase64":data.base64EncodedString(), "filterName":ext.uppercased(), "extensions":[ext]])
        if let path = path as? String { model.notice = "Saved \(path)" }
    }
}
@MainActor func exportNativeMap(_ model: NativeModel) {
    let layout = MapLayout(model.topology)
    let renderer = ImageRenderer(content: NativeMapDrawing(model: model, layout: layout).background(Color(nsColor: .windowBackgroundColor)))
    renderer.scale = 2
    guard let image = renderer.nsImage, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let data = bitmap.representation(using: .png, properties: [:]) else { model.error = "Could not render the map."; return }
    saveNativeBytes(model, data, "kurogane-map.png", "png")
}
func xml(_ value: String) -> String { value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;") }
@MainActor func exportNativeSVG(_ model: NativeModel) {
    let layout = MapLayout(model.topology); let dark = model.appearance == "dark" || model.appearance == "system" && model.window?.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    let bg = dark ? "#171718" : "#eeece7", panel = dark ? "#232325" : "#fcfbf8", ink = dark ? "#eeede9" : "#20211f"
    var svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"\(layout.size.width)\" height=\"\(layout.size.height)\"><rect width=\"100%\" height=\"100%\" fill=\"\(bg)\"/>"
    for (a,b,_) in layout.connectors(model.topology) { svg += "<path d=\"M\(a.x) \(a.y) C\(a.x+100) \(a.y) \(b.x+100) \(b.y-60) \(b.x) \(b.y)\" fill=\"none\" stroke=\"#567fa4\" stroke-width=\"2\"/>" }
    for node in layout.nodes { let r = node.rect; svg += "<rect x=\"\(r.minX)\" y=\"\(r.minY)\" width=\"\(r.width)\" height=\"\(r.height)\" rx=\"10\" fill=\"\(panel)\" stroke=\"#90938f\"/><text x=\"\(r.minX+12)\" y=\"\(r.midY+4)\" fill=\"\(ink)\" font-family=\"system-ui,sans-serif\" font-size=\"12\">\(xml(node.row.text("name")))</text>" }
    svg += "</svg>"; saveNativeBytes(model, Data(svg.utf8), "kurogane-map.svg", "svg")
}
@MainActor func exportNativeFoss(_ model: NativeModel) {
    let layout = MapLayout(model.topology)
    let nodes: [Row] = layout.nodes.map { ["id": $0.id, "name":$0.row.text("name"), "type":$0.item.kind, "position":["x":$0.rect.minX,"y":$0.rect.minY]] }
    let object: Row = ["version":"1.0", "name":model.topology.text("vaultName"), "nodes":nodes, "connections":[]]
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) { saveNativeBytes(model, data, "kurogane-fossflow.json", "json") }
}
