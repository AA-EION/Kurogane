# Isometric canvas adapter (FossFLOW / Isoflow-derived)

## What is reused from FossFLOW / Isoflow (MIT)

Studied from the published `fossflow@1.0.5` package (a fork of `isoflow`) and adapted. No FossFLOW source is copied verbatim; attribution is in `THIRD_PARTY_NOTICES.md`.

| Isoflow concept | Isoflow source | Kurogane |
|---|---|---|
| Tile model: items sit on integer tiles of an unprojected grid | `config.ts` `UNPROJECTED_TILE_SIZE = 100` | same constant, `canvas/iso.ts` |
| Projection multipliers `{ width: 1.415, height: 0.819 }` (projected tile 141.5 × 81.9) | `config.ts` `TILE_PROJECTION_MULTIPLIERS` | same |
| `getTilePosition`: `x = hw·tx − hw·ty`, `y = −(hh·tx + hh·ty)` | `utils/renderer.ts` | `tileToScreen` with the y sign flipped for SVG's downward axis, plus a **z (elevation)** term |
| Flat ground content via `matrix(0.707, −0.409, 0.707, 0.409, 0, −0.816)` | `getIsoMatrix` | `groundMatrix()`, the same transform for a y-down axis; used for floor labels |
| Connectors routed with A* over the tile grid | `utils/pathfinder.ts` (pathfinding.js `AStarFinder`, Manhattan) | own A* in `pathfinder.ts`: orthogonal only, with a **turn penalty** and a **crowding penalty** so parallel routes spread out |
| Rectangles as zones, items, connectors with anchors | `schemas/*` | `Scene { zones, nodes, connectors }`, plus an exporter to FossFLOW's JSON model |

## What is new: automatic layout from relational data

FossFLOW is an editor: a human places every icon. Kurogane derives the picture from the database (`layoutTopology` in `canvas/layout.ts`). It is deterministic, so every machine renders the same diagram, and it is fast (well under 5 ms for the demo).

1. **Host blocks.** Each host's workloads (services + proxies, proxies first) go into a `ceil(√n)` grid with 2-tile cells. The host becomes a slab of `(cols·2+1) × (rows·2+1)` tiles, leaving a 1-tile front strip for its floor label. Hosts without workloads (switches, APs, NVRs) become 1×1 appliance boxes.
2. **Tenant zones.** Inside each tenant, slabs are shelf-packed (proxy hosts first, then by category: firewall → router → VPS → servers → VMs right after their hypervisor → NAS → edge). Appliances line up in a tight strip in front. The zone keeps a padded border plus 2 rows for the floor label.
3. **Zone arrangement.** Zones are laid out on a `ceil(√n)`-column grid, which reads as a diamond in isometric view and stays compact on 16:9 screens.
4. **Elevation layers (z).** Floors at 0; slabs from 0 to 0.45; containers stand on slabs at z = 0.45 with height 1.25 (proxies 1.44); route traces run at slab height; the **Public Internet** floats above the scene. Public-IP pins hover above the edge host's right-hand corner.
5. **Route traces.** Every proxy route becomes `ingress:<proxy>` (a dotted beam: Internet → public-IP pin → proxy) plus `route:<id>` (an orthogonal A* path: proxy → target service, avoiding other containers). That gives `Public Internet → Public IP → Reverse Proxy :443 → host private IP:port → container :port`. Cloudflare Tunnels have no public IP; their beam ends directly on the `cloudflared` node and is drawn dashed.
6. **Badges.** Runtime (Docker, Podman, systemd, SMB, Windows, k8s), OS, primary port (`8081→3000`), HTTPS lock, and TLS warnings computed from `tls_expires_at` (amber under 14 days, red when expired), route counts.

## Rendering (`IsoCanvas.tsx`)

Painter's order: ground grid → tenant floors → host slabs (back to front) → route traces → containers and appliances (back to front by `x+y`, then z) → ingress beams and IP pins → labels → the Internet → labels for lit traces, nudged to avoid collisions.

* Pan by dragging; zoom with the wheel or pinch, anchored at the cursor; fit and zoom buttons.
* **Level of detail:** below 55 % zoom only machine names float, counter-scaled to stay legible. Closer in, every container is labelled, and badges and sublabels appear from 80 % or on hover/selection.
* **Selection** lights the full trace with an animated flow. Selecting a host or tenant lights everything inside it.
* **Omnibox focus:** `focus = { id, nonce }` animates pan and zoom (ease-in-out, 480 ms) so the node sits centred left of the drawer.
* Tenant chips in the top bar fade a tenant out without re-running the layout.

## FossFLOW export

`toFossflowModel()` emits FossFLOW's model JSON: items, one view with tile positions (y negated back to Isoflow's convention), tenant rectangles, connectors with item anchors, and Kurogane's glyphs as data-URI icons. An auto-generated diagram can be opened in FossFLOW for manual polishing. The scene never contains secrets, so neither does the export (tested).

## Tests

`ui/src/canvas/layout.test.ts`: projection round-trip and Isoflow tile size; orthogonal routing around obstacles; every record placed with no item overlap; hosts inside their zone and services on their host; a full Internet→proxy→service trace for every route; the TLS-expiry badge; determinism; FossFLOW export integrity; omnibox ranking by IP, port, domain and company.
