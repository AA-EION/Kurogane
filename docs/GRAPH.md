# Topology graph

The map is a read-only 2D diagram built with [React Flow](https://reactflow.dev) (`@xyflow/react` 12, MIT). Nobody draws it by hand: **the database is the diagram**. The same vault renders identically on every machine, because every step from records to pixels is pure and deterministic.

```
Topology ──buildGraph()──► GraphModel ──layoutGraph()──► positioned nodes + edges ──► <TopologyView>
```

All of it lives in `ui/src/graph/`.

| File | Role |
|---|---|
| `describe.ts` | Domain → presentation: glyph and accent per record, badges (OS, public IP, runtime, port, TLS health, owner, route count), labels, `tlsState`. No positions. |
| `build.ts` | `buildGraph(topo, now)` → `GraphModel { nodes, edges, children, byId, refToNode, routeTrace }`. |
| `layout.ts` | `layoutGraph(model)` → React Flow nodes with fixed sizes and positions, edge handles, edge-label placement. |
| `trace.ts` | `litEdges` / `litNodes`: what lights up for a selection or hover. |
| `filter.ts` | `focusCompany(model, tenantId)`: one company's slice of the graph. |
| `TopologyView.tsx` | The `<ReactFlow>` wrapper. Props in (`model`, `selected`, `focus`, `inspectorInset`), `onSelect` out. |
| `nodes/` | `CompanyNode`, `HostNode`, `WorkloadNode`, `InternetNode` (all memoised). |
| `edges/TopologyEdge.tsx` | Smoothstep path with a semantic stroke, a flow animation and a label pill while lit. |
| `GraphControls.tsx` | Zoom, fit, zoom readout, minimap toggle and legend. |
| `exportImage.ts` | Whole-graph PNG/SVG export. |
| `graph.css` | All graph styling, using theme tokens only. |

## Model

Node ids are stable and are what the rest of the app selects and focuses: `internet`, `tenant:<id>`, `host:<id>`, `svc:<id>` (a service, including a service that runs a proxy) and `proxy:<id>` (a standalone proxy).

- **Company** (`tenant`): a group. It shows the company colour, name, environment label and machine count.
- **Machine** (`host`): a card inside its company, showing its name, primary IP or FQDN, public IP and OS. A machine with no workloads (switch, AP, NVR…) is a compact leaf (`appliance`).
- **Service / proxy**: a chip inside its machine. It shows the glyph and accent, runtime, port (`8080→80`), TLS health (`HTTPS`, `TLS < 14d` in warn, `TLS expired` in danger), route count on proxies, and an owner badge and colour stripe when the service belongs to another company.
- **Public Internet**: one node above everything, with the number of published routes.

Edges:

- `ingress`: Internet → proxy, through the machine's public IP or the Cloudflare edge for tunnels. Dashed.
- `route`: proxy → target service (or machine). Label `domain :443 → ip:port → :containerPort`. Route colour for HTTPS, warn colour for plain HTTP, dashed for tunnels. Routes whose target no longer exists are skipped.
- `parent`: VM → hypervisor. Dashed and muted.

`refToNode` maps every record id (company, machine, service, proxy) to its node; a route id maps to its target. `routeTrace` maps a route id to its edges, ingress first. `byId`, `refToNode` and `routeTrace` together form the `GraphIndex` that the drawer, sidebar, omnibox and focus-after-save use.

## Layout

React Flow sub-flows: companies are parents, machines are children with `parentId: 'tenant:…'` and `extent: 'parent'`, workloads are children of machines. Parents always precede their children. Every node kind has a fixed size, so the layout does not depend on DOM measurement and runs in Vitest.

1. **Machines.** Each machine's workloads (proxies first, then services by name) go into a `⌈√n⌉`-column grid of 244 × 72 px chips below a 58 px title band.
2. **Companies.** Machines are shelf-packed inside their company: proxy machines first, then by category (firewall → router → VPS → servers → VMs right after their hypervisor → NAS → edge…), with the shelf width derived from the total area. Bare appliances line up in a compact strip at the bottom. A company with no machines keeps an empty-state placeholder.
3. **Grid.** Companies start in a `⌈√n⌉`-column grid, which is widened while that brings the whole picture closer to a 16:10 screen. The gap between companies is 112 px.
4. **Internet.** It is centred above the grid.

Edges use React Flow's smoothstep path. Each node has a source and a target handle on all four sides. For every edge, the layout tries the facing sides first and then the alternatives, and keeps the pair whose path crosses the fewest other nodes and title bands, preferring the shorter path. In practice routes run around nodes instead of through them. Ingress edges always enter proxies from the top.

No layout engine dependency is used. `elkjs` is EPL-2.0 and would need a reviewed license decision; the packer above handles nested groups directly.

## Interaction

- **Read-only.** Nodes cannot be dragged, connected or deleted. Drag the background to pan, use the wheel or a pinch to zoom (10–250 %). Double-click does not zoom.
- **Selection.** The app's `selected` state is the only selection. A click, or `Enter`/`Space` on a keyboard-focused node, selects it and opens the inspector. Clicking the background or pressing `Escape` clears it. A node selected on the map that would sit under the web inspector or off screen is panned into view.
- **Tracing.** Selecting or hovering a node (hovering a company does nothing, so moving across its panel stays calm) lights every edge touching it or its members, plus the full Internet → ingress → proxy → route chain of each route involved. A proxy's ingress edge is shared by its routes, so it is pulled in but never fans out to sibling routes. Selecting the Internet lights every ingress edge. Lit edges animate (static under `prefers-reduced-motion`) and show their label. Everything off the trace dims.
- **Focus.** Omnibox picks, sidebar clicks and focus-after-save call `fitView` on the node: companies fit their group, machines fit their card, and leaves zoom to 100 %. Padding includes `inspectorInset` (380 px on the web while the inspector is open, 0 on macOS, where the inspector is a separate pane).
- **Fit.** The graph fits on first layout and whenever the topology changes, but not on resize. macOS triggers a fit through the `kurogane:fit` window event.
- **Level of detail.** Node components read the zoom band through a React Flow store selector, so they re-render only when the band changes. Below 60 % only company and machine names show, scaled up so they stay readable, and workloads show only their glyph and a warn/danger dot. From 60 % names and alert badges show. From 95 % everything shows. TLS warnings are visible at every zoom level.
- **Edge labels** appear when the trace comes from a single workload or appliance; selecting a whole company, machine or the Internet lights the edges without burying the map in pills. Each pill is placed along the path at the first spot that covers no node, title band or other label, and slides along the screen edge so it never ends up off screen or under the inspector.
- **Controls.** Zoom in/out, fit, a zoom readout, a minimap toggle and a legend toggle. The minimap (coloured by company) and the legend (edge styles and the owner stripe) are hidden by default so they never cover nodes; both choices are remembered per viewer in `localStorage`.
- **Company filter.** The picker at the top left of the map (or *Show only this company on the map* in a company's inspector) narrows the map and the inventory rail to one company: its machines with everything on them, including other companies' services hosted there. Another company appears only where the chosen company depends on it — the machine its service runs on and the proxy that publishes it — drawn with dashed outlines and a "Context · N of M machines" subtitle, and with none of that company's other workloads. The focused company is placed first. Search, the inspector and focus-after-save still see everything; jumping to a record outside the slice shows all companies again. The filter is per session and is not stored in the vault; an image export captures what the map shows.
- **Accessibility.** Nodes are keyboard-focusable and carry `aria-label`s such as "Machine web-01, 10.0.0.5, Acme Corp". Focus rings are visible, and node text meets 4.5:1 contrast in both themes (`theme.test.ts`).
- **Performance.** Node and edge types are registered at module scope, every node and edge component is memoised, unchanged node and edge objects keep their identity between renders, and `onlyRenderVisibleElements` is enabled above 300 nodes. Building and laying out 200 machines and 1,000 services is part of the test suite.

Every custom node root carries `data-node="<node id>"`, which the macOS layout harness counts.

## Export

*Settings → Import & export → Map* (and the macOS Export menu) saves the **whole graph**, not just the viewport, as PNG (2× pixel ratio, capped at 16,000 px per side) or SVG. The mounted view registers itself as the capture target. During capture it renders every node at full detail with no selection, hover dimming or animation, and `html-to-image` (1.11.11, pinned) renders `.react-flow__viewport` at the graph's bounds with padding on the current theme's background. Controls, minimap and attribution are outside the captured element. The graph model never contains credentials, so map exports never contain secrets.

## Tests

`ui/src/graph/graph.test.ts`, using `__fixtures__/demo-topology.json` and a fixed clock:

- Every company, machine, service and proxy has a node, and `refToNode` resolves every record and route id.
- Parents precede children, every child sits inside its parent, and siblings never overlap.
- The Internet sits above every company, and ingress enters from the top.
- Every route produces an Internet → ingress → proxy → route trace. Tracing gitea lights exactly its own chain without fanning out through the shared ingress edge. Machines and companies light their members' edges.
- TLS expiry badges appear, and a service owned by another company carries the owner badge and colour.
- Layout and edge handles are deterministic.
- 200 machines and 1,000 services lay out quickly and correctly.
- Omnibox ranking by IP, port, domain and company.

`ui/src/graph/filter.test.ts`, using `__fixtures__/multi-company.json` (five companies, each running one service on the next company's machine): the focused company keeps everything on its machines; other companies appear only as context for the machines and proxies its services use; traces stay intact; the slice lays out inside its parents.

In a development build, `?demo=1` opens the single-company demo vault and `?demo=multi` the multi-company one.
