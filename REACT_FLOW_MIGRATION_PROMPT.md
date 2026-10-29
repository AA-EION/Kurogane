# Task: Replace Kurogane's isometric map with a 2D React Flow topology view

You are working in the Kurogane repo (`AA-EION/Kurogane`): an offline, encrypted infrastructure map and credential vault. It has a Rust core (`crates/`), a Tauri v2 shell (`src-tauri/`), a React 18 + TypeScript + Vite UI (`ui/`), and on macOS a SwiftUI shell (`src-tauri/macos/`) that embeds only the graph in a WKWebView.

**Goal:** replace the isometric SVG renderer with a clean, readable 2D topology view built on **React Flow (`@xyflow/react` v12)**. Remove every trace of the isometric implementation. The result should look like a polished product: easy to read at a glance, fast to navigate, and consistent in the light and dark themes that already exist. Do not change the data model, the vault, the forms, or any Rust behaviour.

**Base branch:** start from `codex/tactile-ui-macos-sync`, or from the default branch once that branch has been merged into it. It holds the light/dark theme, the macOS native graph bridge, and the license audit. Do not start from the older `claude/*` branches.

---

## 1. What exists today (read these first)

The pipeline is **`Topology` → `layoutTopology()` → `Scene` → `IsoCanvas`**.

| File | Role | Fate |
|---|---|---|
| `ui/src/canvas/iso.ts` | Isometric projection (tile↔screen, ground matrix, depth sort). Adapted from Isoflow/FossFLOW. | **Delete** |
| `ui/src/canvas/pathfinder.ts` | A* orthogonal connector routing on the tile grid. Adapted from FossFLOW. | **Delete** |
| `ui/src/canvas/IsoCanvas.tsx` | SVG renderer: slabs, blocks, zone floors, Internet ellipse, IP pins, hand-rolled pan/zoom/fit/focus animation, LOD labels, legend, zoom controls | **Delete** |
| `ui/src/canvas/layout.ts` | Builds `Scene` (nodes with `tile/size/z/height/screen`, zones, connectors with `tiles/points`, `byId`, `refToNode`, `routeTrace`). Also exports `primaryIp`, `publicIp`, `tlsState`, and `ACCENT`, and holds the glyph/badge/label tables. | **Replace.** Keep the domain logic (badges, TLS state, glyph choice, route labels, trace sets) and drop everything that deals with tiles or projection. |
| `ui/src/canvas/fossflowExport.ts` | FossFLOW/Isoflow JSON export | **Delete**, including the feature (see §6) |
| `ui/src/canvas/mapExport.ts` | Clones `svg.iso-canvas` and inlines CSS for PNG/SVG export | **Replace** with a React Flow based export |
| `ui/src/canvas/glyphs.ts` | 24×24 stroke pictograms used by the drawer, sidebar and `Icon` | **Keep.** Move it out of `canvas/`. |
| `ui/src/canvas/layout.test.ts` + `__fixtures__/demo-topology.json` | Projection, pathfinder, layout, FossFLOW and search tests | **Rewrite** the tests and keep the fixture |
| `ui/src/NativeGraph.tsx` | macOS-only entry (selected in `main.tsx`). Receives `{topology, selected, appearance, fit}` from Swift, posts `ready` / `select` / `file` / `error`. Exports `png`/`svg`/`json`. | **Port** to the new view and drop `json` |

**Code that uses `Scene` and must keep working:**
- `App.tsx`: `layoutTopology(topo)` in a `useMemo`; `scene.refToNode` for focus after save and for `focusRef`; renders `<IsoCanvas … dimmedTenants={new Set()} />`; `Escape` clears the selection.
- `store.tsx`: `Store.scene: Scene`. `selected` and `focus` take **scene node ids** (`tenant:<id>`, `host:<id>`, `svc:<id>`, `proxy:<id>`, `internet`).
- `components/Drawer.tsx`: `scene.byId.get(selected)` / `scene.zones.find(...)` to decide which inspector to show; `scene.byId…glyph` for icons; `focus('host:…')`.
- `components/Sidebar.tsx`: `scene.refToNode` + `.glyph`.
- `search/index.ts`: `buildIndex(topo, scene)`, whose `target` is a scene node id. It also imports `primaryIp` from `canvas/layout`.
- `model.ts`: imports `primaryIp`, `publicIp` from `canvas/layout`.
- `components/SettingsModal.tsx` → Data tab, "Map" card: PNG, SVG and FossFLOW buttons. The About tab says "Map projection adapted from Isoflow / FossFLOW (MIT)".
- `styles.css`: the `canvas` section (`.canvas-wrap`, `.iso-canvas`, `.ground-grid`, `.zone*`, `.slab-*`, `.iso-block`, `.connector`, `.conn-label`, `.node-label`, `.badge`, `.internet*`, `.ip-pin`, `.zoom-controls`, `.legend`) and the tokens `--steel`, `--slab-text`, `--slab-muted`, `--map-outline`, `--map-grid`, `--route`, `--ingress` in both `:root[data-theme='light']` and `[data-theme='dark']`.
- `theme.test.ts`: asserts 4.5:1 contrast, including `slab-text`/`slab-muted` on `steel`.
- macOS: `src-tauri/macos/NativeGraph.swift` (bridge), `KuroganeShell.swift` (menu items "Map as PNG/SVG…" and "FossFLOW JSON…"), `src-tauri/tests/NativePreview.swift`. The harness counts `document.querySelectorAll('[data-node]')` to prove the graph rendered and prints "original isometric graph".

**What the graph must show (this is the product):**
- **Company (tenant)**: a container that groups its machines. It uses the tenant `color` and shows its name, its environment label and how many hosts it has.
- **Machine (host)**: a container inside its company. It shows the name, primary IP or FQDN, the OS badge and the public IP badge. Hosts with no workloads (switches, APs, NVRs and so on) are compact leaf nodes.
- **Service / proxy**: a leaf inside its host. It shows the glyph, accent, runtime badge, port badge (`8080→80`), TLS badges (`HTTPS`, `TLS < 14d` in warn, `TLS expired` in danger), an owner badge with the owner's colour when the service belongs to another company, and the route count on proxies.
- **Public Internet**: one node above everything, with "N published routes".
- **Edges:**
  - `ingress`: Internet → proxy. It goes through the host's public IP, or through "Cloudflare edge" for tunnels, and is dashed.
  - `route`: proxy → target service or host. Label: `domain :443 → ip:port → :containerPort`. Solid in the route colour for HTTPS, warn colour for plain HTTP, dashed for tunnels.
  - `parent`: VM → hypervisor, dashed and muted.
- **Tracing:** selecting or hovering a node lights its full chain, Internet → ingress → proxy → route → service. Keep the rule from the old `connectorsFor()`: a shared ingress edge gets pulled in, but never fans out to sibling routes. Selecting a host lights the edges of all its children. Selecting a company lights the edges of all its members. Selecting the Internet lights every ingress edge.

---

## 2. Target architecture

Rename `ui/src/canvas/` to **`ui/src/graph/`** so no "canvas/iso" naming survives. Suggested layout:

```
ui/src/graph/
  glyphs.ts          (moved unchanged)
  describe.ts        domain → presentation: glyph/accent choice, badges, labels, tlsState, route labels (pure, no positions)
  build.ts           Topology → GraphModel { nodes, edges, index }   (pure, deterministic, unit-tested)
  layout.ts          GraphModel → positioned React Flow nodes        (pure, deterministic, unit-tested)
  trace.ts           litEdges(model, nodeId) (port of connectorsFor)
  TopologyView.tsx   <ReactFlow> wrapper: props in, events out
  nodes/             CompanyNode.tsx, HostNode.tsx, WorkloadNode.tsx, InternetNode.tsx  (memo'd)
  edges/             RouteEdge.tsx (label on lit/hover only)
  GraphControls.tsx  zoom / fit / legend / minimap toggle panel
  exportImage.ts     PNG + SVG export
  graph.css          all React Flow styling, theme tokens only
```

- Move `primaryIp` and `publicIp` into `model.ts`, where they belong as domain helpers. `search/index.ts` and `model.ts` should import them from there.
- **Rename `Scene` to a graph index** with the same responsibilities consumers depend on: `byId` (node id → node data with `kind`, `refId`, `tenantId`, `hostId`, `glyph`, `accent`, `label`, `badges`), `refToNode` (record id → node id; this includes route id → target node and credential owner fallbacks), and `routeTrace`. Keep the node-id scheme `tenant:` / `host:` / `svc:` / `proxy:` / `internet` so Drawer, Sidebar, search and focus-after-save need only mechanical renames. Drop the separate `zones` array: companies are ordinary nodes with `kind: 'tenant'`. Update `Drawer.tsx` to branch on `node.kind === 'tenant'` and remove `scene.zones.find`.
- Drop the always-empty `dimmedTenants` prop. If you add company filtering (see §4), implement it for real; otherwise leave it out.
- `TopologyView` takes `{ model, selected, onSelect, focus, inspectorInset }`. Keep `inspectorInset` (380 on web because the drawer overlays the map, 0 on macOS where the inspector is a separate pane) and apply it as right padding when fitting or focusing.

### Layout (deterministic, no manual diagramming)

The product rule is unchanged: **the database is the diagram.** The same vault must render identically on every machine, so layout must be pure and deterministic: sorted inputs, no randomness, no persisted drag positions.

- Use **React Flow sub-flows**: company nodes are parents (`type: 'company'`), hosts are children with `parentId: 'tenant:…'` and `extent: 'parent'`, workloads are children of hosts. Parents must come before children in the `nodes` array.
- **Write the layout yourself and reuse the proven packing logic** from the old `layout.ts` steps 1–3. Run it in pixel space instead of tiles:
  - Size each host from a √n grid of its workloads.
  - Shelf-pack hosts inside the company: proxy hosts first, then by `CATEGORY_ORDER`, VMs right after their hypervisor, bare appliances in a compact strip at the bottom.
  - Arrange companies in a ⌈√n⌉-column grid with generous gaps.
  - Place the Internet centred above the whole grid.
  - Use fixed node dimensions per kind, so the layout does not depend on DOM measurement and is testable in Vitest.
- **Do not add `elkjs`.** It is EPL-2.0, and this repo is AGPL-3.0-or-later with an enforced license audit, so it would need a reviewed license decision. React Flow plus a custom packer is enough. `@dagrejs/dagre` (MIT) is acceptable only if you show it beats the packer for nested groups, and it usually doesn't.
- Edges: use the built-in `smoothstep` path through a custom edge component. Give each node handles on all four sides and choose source/target handles by relative position, so edges never cut back through a node. Keep edges between siblings short. The Internet → proxy edges enter proxies from the top.

---

## 3. Interaction and UX requirements

Make this pleasant for someone managing dozens of machines across several companies.

- **Read-only diagram:** `nodesDraggable={false}`, `nodesConnectable={false}`, `elementsSelectable`, `selectNodesOnDrag={false}`, `deleteKeyCode={null}`. Pan by dragging the background, zoom with the wheel or a pinch, `zoomOnDoubleClick={false}`. Set `minZoom` around 0.1 and `maxZoom` around 2.5. Keep the attribution (`proOptions` hideAttribution is for paid plans only, so leave it visible or style it subtly).
- **Selection:** a click selects the node and opens the existing Drawer. Clicking the background or pressing `Escape` clears the selection. The selected node gets a clear focus ring in the tenant or accent colour. Use a single source of truth: the app's `selected` state drives React Flow's `selected` flags, and React Flow does not keep its own selection.
- **Tracing:** on select or hover, compute the lit edges with `trace.ts`. Lit edges are full opacity and animated (`animated` or a CSS dash flow), and show their route label. Everything off the trace is dimmed to about 15–25% opacity. Nodes on the trace stay at full opacity. Hover previews and does not change the selection.
- **Focus:** when `focus` changes (omnibox pick, sidebar click, focus after save), call `fitView({ nodes: [{id}], padding, duration, maxZoom })`, or `setCenter` for leaves. Account for `inspectorInset`. Companies fit their whole group. Leaves zoom to at least about 1.0. Respect `prefers-reduced-motion` by using `duration: 0`.
- **Initial view and resize:** `fitView` on first layout and whenever the topology changes. Keep the current viewport on resize instead of refitting. On macOS, keep listening for the `kurogane:fit` window event that `NativeGraph` dispatches.
- **Level of detail:** read the zoom with `useStore((s) => s.transform[2])` through a selector, so node components re-render only when the band changes. Use three bands:
  - Overview: company and host names only, at a larger readable size.
  - Normal: names plus sublabels and warn/danger badges.
  - Detail: all badges.
  Warn and danger badges such as TLS must be visible at every zoom level.
- **Edge labels:** show them only when an edge is lit, as a pill using `EdgeLabelRenderer`. Keep the old pill style (panel background, mono 11px). Labels must not overlap nodes: offset them along the path when needed.
- **Controls:** a custom panel (`<Panel position="bottom-left">`) styled like the existing `.zoom-controls`, with zoom in, zoom out, fit and a zoom % readout, reusing `GLYPHS.plus/minus/fit`. Add an optional `<MiniMap>` coloured by tenant, pannable and zoomable, hidden by default, toggled from the panel, with the preference kept in `localStorage` (wrap access in try/catch). Add a legend for HTTPS route, plain-HTTP route, tunnel/ingress and VM → hypervisor.
- **Background:** a subtle `<Background variant="dots">` using a theme token. No heavy gradients.
- **Keyboard and accessibility:** turn on React Flow's built-in keyboard handling (`nodesFocusable`, `edgesFocusable={false}`). Each node gets `aria-label` text like "Machine web-01, 10.0.0.5, Acme Corp". `Enter` on a focused node selects it. Visible `:focus-visible` rings. Respect `prefers-reduced-motion` and turn off the edge flow animation. Text contrast must be at least 4.5:1 in both themes.
- **Theme:** style everything with the existing CSS tokens (`--bg`, `--panel`, `--line`, `--text*`, `--ok/warn/danger/info`, `--route`, `--ingress`, tenant colours). Pass `colorMode` from `useAppearance()` / `data-theme` so React Flow's built-in parts (controls, minimap, attribution) match, and override the `--xy-*` variables in `graph.css`. Remove the isometric-only tokens (`--steel`, `--slab-text`, `--slab-muted`, `--map-outline`, `--map-grid`) and add graph tokens only where you need them, defined in both themes.
- **Visual language:** follow `DESIGN.md` (satin ivory / warm ink, tactile surfaces, rounded radii from its scale). Companies are soft tinted panels with a tenant-colour header strip. Hosts are raised cards. Workloads are compact chips with glyph and accent. Use the system fonts already defined. Use no text smaller than 11px at 100% zoom.
- **Empty and edge cases:** a company with no machines still renders a sensible empty group. A host with no services renders as a compact appliance node. A service on another company's host shows the owner badge and colour. Routes whose target is missing are skipped, as they are today.
- **Performance:** register `nodeTypes`/`edgeTypes` at module scope, `memo` every custom node and edge, derive the model with `useMemo` keyed on `topo`, and only recompute lit sets on selected/hover. Use `onlyRenderVisibleElements` when there are more than about 300 nodes. Target: 200 hosts / 1,000 services pans at 60fps on a laptop.
- Import `@xyflow/react/dist/style.css` once (or `base.css` if you restyle fully).
- **Keep the `data-node="<node id>"` attribute** on every custom node root. The macOS harness (`NativePreview.swift`) and any end-to-end checks rely on it.

---

## 4. Optional, if it fits cleanly

- Collapse and expand a company or a host (chevron in the header; collapsed hosts show a "+N services" count, and edges re-target to the collapsed parent). Keep the collapsed state per viewer in `localStorage`, never in the vault.
- Company filter chips in the TopBar. There is an unused `.tenant-chips` / `.tchip` style that could be wired for this, or else deleted.

Skip both if they would compromise clarity or determinism.

---

## 5. Dependencies, versions and licensing

- Add `@xyflow/react` (latest 12.x) and, for export, `html-to-image` pinned to an exact version (React Flow's own export example pins `1.11.11` because later versions have regressions; verify before choosing). Both are MIT.
- The repo enforces a dependency license audit in CI. After changing `ui/package-lock.json`, run `node scripts/license-audit.mjs` to regenerate `docs/legal/dependency-inventory.json` and `THIRD_PARTY_LICENSES.txt`, review any new expression and add it to `docs/legal/license-decisions.json` if needed, then run `node scripts/license-audit.mjs --check`. CI fails if this step is skipped.
- Do not change the versions of Vite, Vitest, React or TypeScript.

---

## 6. Export

- **Remove the FossFLOW export entirely:** `fossflowExport.ts`, the Settings → Data → Map "FossFLOW diagram" button, the `json` format in `NativeGraph.tsx`, the "FossFLOW JSON…" menu item in `KuroganeShell.swift`, and every doc reference to it.
- **PNG and SVG:** export the **whole graph, not just the viewport**. Compute bounds with `getNodesBounds(getNodes())` and `getViewportForBounds(...)`, then render `.react-flow__viewport` with `html-to-image` (`toPng`, `toSvg`) at that transform with padding. Use a solid `--bg` background in the current theme, hide controls, minimap and attribution, clear selection and dimming during the capture, and keep a 2× pixel ratio capped at 16k px per side (as today). Map exports must never contain secrets; credentials are not part of the graph model.
- Keep the existing save path: `backend.saveFile(name, blob, filterName, extensions)` on web, and the base64 `file` message on macOS.

---

## 7. Native macOS bridge (`ui/src/NativeGraph.tsx`)

Keep the protocol byte-compatible except for removing `json`:
- `window.kuroganeGraph.update({ topology, selected: {kind,id}|null, appearance, fit })`
- `window.kuroganeGraph.export('png'|'svg', id)`
- Posts: `{type:'ready'}`, `{type:'select', item:{kind,id}|null}`, `{type:'file', id, format, dataBase64}`, `{type:'error', id, message}`

Render `<TopologyView inspectorInset={0} …/>` inside `<ReactFlowProvider>`. Map node ids back to `{kind, id}` using `node.kind`/`node.refId`; the current code checks `scene.zones` and the topology arrays. In `NativeGraph.swift` and `KuroganeShell.swift`, accept only `png`/`svg` and remove the FossFLOW menu item. Update `NativePreview.swift`'s success message so it no longer says "isometric". You can't build Swift on Linux, so keep Swift edits minimal and obviously correct.

---

## 8. Remove everything isometric

When you finish, this must return **nothing** outside `node_modules`, `docs/legal/`, `THIRD_PARTY_LICENSES.txt` and lockfiles:

```bash
grep -rniE "isometric|isoflow|fossflow|IsoCanvas|iso-canvas|tileToScreen|screenToTile|groundMatrix|depthKey|pathfinder|slab|ground-grid|ip-pin|--steel|map-outline|map-grid|sceneScreenBounds|layoutTopology|connectorsFor|canvas/" --exclude-dir=node_modules --exclude-dir=legal --exclude=THIRD_PARTY_LICENSES.txt --exclude=package-lock.json --exclude=Cargo.lock .
```

Places that currently need edits:
- `ui/src/**`: everything in §1, plus `styles.css`, `theme.test.ts` (replace the slab contrast check with contrast checks for graph node text on node surfaces in both themes), and the `SettingsModal.tsx` About line ("Graph view built with React Flow (MIT). Sync engine: rclone (MIT).").
- Delete `ui/tsconfig.tsbuildinfo` if it is tracked, and make sure it is gitignored.
- `README.md` ("draws them as an isometric diagram…", the Map export sentence, the `canvas/` line in the tree, the Isoflow credit), `docs/CANVAS.md` (rewrite as `docs/GRAPH.md`: model, layout algorithm, interactions, export, tests), `docs/ARCHITECTURE.md` (the "SVG with an isometric projection" row and the FossFLOW rationale), `docs/MACOS.md`, `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json` / `.impeccable/surface.md` (graph and slab tokens), `docs/LICENSING.md`, `docs/img/PROVENANCE.md`.
- `THIRD_PARTY_NOTICES.md` and `NOTICE`: remove the Isoflow/FossFLOW section and the "original Isoflow/FossFLOW portions of ui/src/canvas/" line, because that code no longer ships. Add React Flow / html-to-image only if the audit's notice generation does not already cover them.
- `src-tauri/tauri.conf.json` `longDescription` ("automatic isometric diagram" → "automatic topology diagram"), and the comments in `src-tauri/src/io.rs` that mention FossFLOW JSON.
- Screenshots in `docs/img/` (`map.png`, `map-light.jpg`, `macos-map.png`): regenerate the web ones (§9). Leave `macos-map.png` alone if you cannot produce it, and say so.
- Leave the brand mark in `Brand.tsx` / `.bm-*` unchanged. It is the logo, not the map.

---

## 9. Tests and verification (all must pass before you commit)

1. Replace `layout.test.ts` with `ui/src/graph/graph.test.ts`, using the existing `demo-topology.json` fixture and a fixed `NOW`:
   - Every tenant, host, service and proxy has a node.
   - `refToNode` resolves every record id and route id.
   - Every child sits fully inside its parent's bounds.
   - No two sibling nodes overlap.
   - Every route produces an Internet → ingress → proxy → service trace.
   - Tracing gitea lights only its own chain, and does not fan out through a shared ingress edge.
   - The TLS-expiry badge appears.
   - The odoo owner badge and colour appear.
   - Layout is deterministic (two runs produce identical JSON).
   - Parents are ordered before children.
   - Keep the existing omnibox ranking tests (by IP, port, domain and company) working.
2. Update `theme.test.ts` as described in §8.
3. From `ui/`, run `npm ci && npm run typecheck && npm test && npm run build`. Then from the repo root, run `node scripts/license-audit.mjs --check`, and `cargo fmt --all --check && cargo clippy -p kurogane-core -p kurogane-sync -p kurogane-cli --all-targets -- -D warnings` (you shouldn't need any Rust changes beyond comments).
4. **Look at it.** Run `npm run dev`. In a plain browser the app uses `ui/src/mock/mockBackend.ts`. Using Playwright (Chromium is preinstalled; do not run `playwright install`):
   - Unlock the mock vault.
   - Capture the map in light and dark at 1440×900 and at 1024×640.
   - Check that selecting a service lights its trace and opens the drawer without the node being hidden behind it.
   - Check that the omnibox (Ctrl/Cmd+K) focuses a node, `Escape` clears, and PNG/SVG export downloads a full-graph image.
   Fix anything that looks cramped, clipped, low-contrast or confusing. Save the final captures over `docs/img/map.png` and `docs/img/map-light.jpg`.
5. Run the grep from §8 and confirm it is empty.

## 10. Delivery

- Work on a feature branch off the base named at the top. Make small, reviewable commits: (1) graph model, layout and tests; (2) React Flow view, wired in, with the isometric code deleted; (3) export and macOS bridge; (4) docs, notices and screenshots.
- Do not open a PR unless asked. In your final report, list what you removed, what you added, the test and build output, the screenshots, and anything you could not verify (for example, the Swift build or the macOS capture).
