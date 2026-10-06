---
name: Kurogane
description: A tactile infrastructure workspace in satin ivory and warm ink.
colors:
  bg: "#eeece7"
  bg-2: "#f6f4f0"
  panel: "#fcfbf8"
  panel-2: "#e5e3dd"
  line: "#d1cec6"
  line-2: "#b9b6ae"
  text: "#20211f"
  text-2: "#52534e"
  text-3: "#696a64"
  ember: "#343d42"
  ember-2: "#475961"
  ok: "#25784b"
  warn: "#925500"
  danger: "#bc3029"
  info: "#315f91"
  surface-top: "#fffefa"
  surface-bottom: "#e8e5de"
  sheen: "rgba(255,255,255,.9)"
  shadow-ink: "rgba(38,35,28,.15)"
  map-outline: "#eeece7"
  map-grid: "rgba(60,59,52,.09)"
  steel: "#b4b2ac"
  route: "#8e5b32"
  ingress: "#767b79"
  primary-top: "#4c5456"
  primary-bottom: "#2b3336"
  primary-ink: "#fffefa"
  dark-bg: "#101011"
  dark-bg-2: "#171718"
  dark-panel: "#232325"
  dark-panel-2: "#2e2e30"
  dark-line: "#39393b"
  dark-line-2: "#525253"
  dark-text: "#eeede9"
  dark-text-2: "#bbb9b4"
  dark-text-3: "#a09e99"
  dark-ember: "#d6d9d8"
  dark-ember-2: "#e5e7e5"
  dark-ok: "#68d69a"
  dark-warn: "#f0b55a"
  dark-danger: "#ff8276"
  dark-info: "#98b9e0"
  dark-surface-top: "#333335"
  dark-surface-bottom: "#222224"
  dark-sheen: "rgba(255,255,255,.09)"
  dark-shadow-ink: "rgba(0,0,0,.5)"
  dark-map-outline: "#101011"
  dark-map-grid: "rgba(255,255,255,.05)"
  dark-steel: "#414143"
  dark-route: "#d5a376"
  dark-ingress: "#a5aaa7"
  dark-primary-top: "#e9e7e1"
  dark-primary-bottom: "#bbb9b2"
  dark-primary-ink: "#20211f"
  native-map-ground: "rgb(93.3% 92.5% 90.6%)"
  native-dark-map-ground: "rgb(6.5% 6.5% 7%)"
typography:
  title:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.45
    letterSpacing: "0.01em"
  body:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.45
  mono:
    fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace"
    fontSize: "0.92em"
rounded:
  keycap: "4px"
  segment: "6px"
  tree-row: "7px"
  field: "8px"
  button: "9px"
  control: "10px"
  card: "12px"
  inspector: "14px"
  dialog: "16px"
  pill: "99px"
  native-company-ground: "24px"
spacing:
  tight: "4px"
  small: "6px"
  control-gap: "8px"
  row-gap: "10px"
  field-gap: "12px"
  card-gap: "14px"
  toolbar-gap: "16px"
  inspector-padding: "18px"
  dialog-padding: "20px"
  compact-gate-padding: "24px"
  gate-padding: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary-top}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.button}"
    padding: "8px 14px"
  button-secondary:
    backgroundColor: "{colors.surface-top}"
    textColor: "{colors.text}"
    rounded: "{rounded.button}"
    padding: "8px 14px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.button}"
    padding: "8px 14px"
  field:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "8px 10px"
  navigation:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.text-3}"
    rounded: "{rounded.button}"
    padding: "3px"
  badge-chip:
    textColor: "{colors.text-2}"
    rounded: "{rounded.pill}"
    padding: "2px 7px"
  card:
    backgroundColor: "{colors.bg-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "14px"
  segmented:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.button}"
    padding: "3px"
  toggle:
    backgroundColor: "{colors.line-2}"
    rounded: "{rounded.pill}"
    width: "34px"
    height: "20px"
  inspector:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.inspector}"
    width: "380px"
---

# Design System: Kurogane

## Overview

**Creative North Star: "Satin ivory and ink"**

Kurogane uses natural, semi-real skeuomorphism: pale warm surfaces, legible ink, fine beveled edges and controls that feel pressed into or raised above their support. Boundless's instrument plates, inset glass and physical button states are the primary reference. EION Studios contributes the warm monochrome character. This is an adaptation of those materials to an infrastructure workspace; the reference applications' font assets and theme transition system are not bundled here.

Light is the initial appearance. Dark uses charcoal plates and pale ink while preserving the same physical hierarchy. Typography remains compact and familiar; monochrome chrome gives topology and status room to carry meaning. The existing application logos remain intact, and the visible material treatment is built with CSS, SVG and native drawing rather than new raster textures.

Every macOS view is SwiftUI, hosted in the application window by `NSHostingView`. Native system surfaces, grouped forms, SF Symbols and platform controls express the same warm, tactile direction, while the map uses drawn company grounds, machine slabs and raised service cards. The navigation control group uses Liquid Glass on macOS 26 and newer and ultra-thin material on macOS 13–25. Windows and Linux use the React workspace.

**Key Characteristics:**

- Warm white surfaces and charcoal alternatives.
- Raised satin actions and recessed fields.
- Dense, legible navigation with restrained hierarchy.
- Physical topology and semantic status color.
- Platform-native macOS materials and shared semantic appearance roles.

Implementation authority: `ui/src/styles.css` and `ui/src/theme.ts` supply the web appearance values and behavior; `src-tauri/macos/*.swift` supplies the complete macOS presentation, and `src-tauri/src/native.rs` connects native actions to the existing Rust handlers. The frontmatter captures the web light defaults and their `dark-` counterparts, plus the explicitly specified native map grounds. Native system colors remain dynamic platform roles rather than frozen web-color aliases. The sidecar extends the tokens with depth, motion, breakpoints and web component specimens; those specimens illustrate the materials and do not replace SwiftUI controls.

## Colors

Warm mineral neutrals dominate the chrome; cool ink actions, green health, amber caution, red danger and blue information remain easy to distinguish.

### Primary

- **Instrument ink** (`ember`, `ember-2`): action emphasis, hover strokes and selected topology details. Despite the historical token name, this is a muted graphite family.
- **Pressed graphite** (`primary-top`, `primary-bottom`, `primary-ink`): the vertical gradient and contrasting text of primary actions. In dark appearance the control becomes pale satin with dark ink.

### Secondary

- **Health green** (`ok`), **caution amber** (`warn`), **danger red** (`danger`) and **information blue** (`info`): status text, badges, feedback and keyboard focus. Their dark counterparts increase luminance rather than changing their meaning.
- **Route copper** (`route`) and **ingress gray** (`ingress`): distinct connection types in the map and legend. Company and service color is data-associated, separate from the application chrome palette.

### Neutral

- **Warm ground** (`bg`, `bg-2`): the application support, recessed workspace and secondary card surfaces.
- **Ivory plate** (`panel`, `panel-2`): inspectors, menus, fields and inset segmented tracks.
- **Mineral edge** (`line`, `line-2`): separators and fine control contours.
- **Warm black ink** (`text`, `text-2`, `text-3`): primary content, secondary content and quiet metadata. Quiet text still needs the correct theme token; avoid low-opacity text over the map.
- **Satin face** (`surface-top`, `surface-bottom`, `sheen`, `shadow-ink`): the illuminated top edge and structural shade of the material.
- **Map support** (`steel`, `map-grid`, `map-outline`): physical slabs, low-contrast ground grid and readable SVG label halos.

Native views use `windowBackgroundColor`, `controlBackgroundColor`, primary and secondary foreground styles, and `accentColor` for platform-resolved surfaces, text and selection. The two native map-ground tokens preserve the manually specified warm light and charcoal dark support. Native route connections use blue for enabled and dashed gray for disabled, with service symbols also blue; this is the current native drawing vocabulary, distinct from the web connection palette.

**The Semantic Color Rule.** Use color to identify topology, status or focus; keep ordinary application surfaces in the warm neutral material family.

**The Paired Appearance Rule.** Web surfaces and text resolve through the existing semantic custom properties in both appearances; native surfaces and text use the corresponding dynamic platform roles.

## Typography

**Body and title font:** the platform UI sans stack in the frontmatter. This uses system typography first; Inter is a fallback name, not a shipped custom font.

**Label/mono font:** the platform monospace stack for addresses, ports, commands, secrets and numerical readouts.

Native macOS views use SwiftUI system font roles such as headline, title2, body, caption and caption2, with monospaced technical values and monospaced digits for timing and zoom. Machine map titles use a semibold system face (15px), service map titles (13px), and machine technical subtitles (12px). Native settings and editors retain system form typography rather than applying the web body scale verbatim.

The hierarchy relies on weight and spacing within a compact UI scale. Inspector record titles use the title token; dialogs use a slightly smaller heading (17px), cards use (14px), and form labels use the label token. Body uses the frontmatter's size and line-height. Map company labels are deliberately larger SVG world-space labels (58px), with machine labels (18px) and node labels (13–14px); these values scale with the map camera and are not a general display-text scale.

Metadata ranges from (10–12.5px), while most entity names stay in the body scale. Section headings in the inspector are sentence case (12px). Navigation counts use tabular numerals. The brand retains its compact bold, tracked wordmark; do not apply wordmark tracking to content.

**The Technical Text Rule.** Use monospace for literal technical values, and the UI sans for names, explanations and actions.

## Layout

The web desktop shell has a toolbar (64px), inventory rail (300px) and a flexible map stage. The rail independently scrolls. An inspector floats within the map (380px wide), inset from its edges (16px); its header stays separate from the scrolling body. The map fills the remaining workspace and uses its own camera rather than page scrolling. Toolbar and pane layouts must preserve `min-width: 0` so long names truncate or wrap in their intended containers.

Forms use two columns with row and column gaps (12px and 14px); settings use a navigation rail (180px) beside a flexible content column, separated by (18px). Regular dialogs cap at (560px), wide dialogs at (880px), both limited to the viewport. Primary spacing steps live in the frontmatter; mixed padding is preserved per component rather than rounded into a new grid.

At (1180px), the toolbar tightens and hides maker text and the sync label. At (1100px), the inventory rail becomes (250px). At (960px), it becomes (220px), the vault title and kanji hide, and search compresses. At (760px), toolbar text labels hide and setup choices stack. At (700px), the rail hides, the toolbar becomes (56px), settings navigation wraps horizontally, forms and empty-state actions stack, and the inspector fills the stage within (12px) margins. Search and map picking retain access to records on narrow screens. Narrow-screen support is a responsive shared workspace, not a separately designed mobile application.

The native macOS window has a minimum content size (920px by 640px), a top navigation row and an `HSplitView` below. Its inventory rail ranges from (185–240px), with an ideal width (220px); the selected inspector ranges from (240–320px), ideally (285px). The center map/inventory pane has a minimum width (360px), with view and export controls above and operational status below. The native inspector is a split-pane column rather than a floating web drawer.

Native map zoom starts at (100%) and ranges from (35–200%) through a slider and magnification gesture; Fit derives a bounded scale from the available map width. The canvas scrolls in both axes. Company grounds arrange machines in pairs of columns with services and proxies below their host; row spacing expands when a machine has more children. Native sheets use grouped, scrollable forms with their actions outside the scrolling content. Editors are (680px by 680px); settings are (680px by 650px), with an explicit General, Security, Sync, Data and About section picker.

## Elevation & Depth

Depth is structural: top-lit vertical gradients and fine borders define plates; a white inner rim and a small offset shadow lift actions; inset shadows recess fields and selected rows. Floating inspectors, menus, legends, dialogs and toasts use the common ambient shadow. The map's isometric surfaces provide physical scale, while its background uses a restrained radial gradient. The React inspector is opaque and has no backdrop blur. Dialog scrims blur the covered workspace (2px).

Native map cards blend system control and window backgrounds vertically. Machine cards have rounded corners (12px), service cards (7px), a thin rim and an offset shadow; selected cards strengthen their stroke to the system accent (2px). Company grounds use broad corners (24px), a translucent control background and a quiet border. Native gate panels use a control-background plate, white rim and soft offset shadow. Liquid Glass belongs to the native navigation group, while sheets and detailed content remain system surfaces.

### Shadow Vocabulary

- **Ambient lift** (`--shadow`): `0 2px 4px rgba(38,35,28,.08), 0 16px 36px -16px rgba(38,35,28,.25)` in light; `0 2px 4px rgba(0,0,0,.3), 0 16px 36px -16px rgba(0,0,0,.7)` in dark. Floating containment.
- **Raised edge** (`--raised`): `inset 0 1px 0 var(--sheen), 0 1px 2px var(--shadow-ink)`. Controls, selected tabs and settings navigation.
- **Recessed edge** (`--inset`): `inset 0 1px 3px var(--shadow-ink), 0 1px 0 var(--sheen)`. Text fields, segmented tracks and pressed buttons.
- **Stage recess**: `inset 0 2px 8px var(--shadow-ink)`. The support beneath the map.

**The Physical State Rule.** Controls are raised at rest and inset when pressed; fields remain recessed. Use the shared shadow vocabulary to keep the light source consistent.

Native controls retain system pressed and focused states; do not reproduce the web button state selectors by obscuring SwiftUI's built-in feedback.

## Shapes

Corners are gently curved rather than pill-shaped by default. Fields, tree rows, buttons, cards, inspectors and dialogs use the respective radii in the frontmatter. Full pills are reserved for compact badges, chips and the lock control. One-pixel contours establish material boundaries; pressed states do not depend on a heavier border. Company markers are small rotated squares, and machine and service bodies retain isometric slab or block geometry.

## Components

### Buttons

Actions feel like satin hardware. Ordinary buttons use the button radius and secondary gradient; primary buttons use the graphite gradient and contrasting primary ink. Primary hover brightens the existing material (`brightness(1.07)`), while secondary hover strengthens the border. Ghost actions remain transparent until hover. Form actions use (8px 14px) padding; gate actions use the larger control radius and (11px 16px) padding. Pressing applies the inset shadow; ordinary buttons and launcher tiles also move down (1px). Disabled buttons use reduced opacity (0.45), and launcher tiles (0.35), with a blocked cursor.

Keyboard focus uses the information color outline (2px) with (3px) offset. Keep visible text or an accessible label for icon actions, including the compressed toolbar. The New menu preserves prerequisite-disabled actions instead of presenting unavailable actions as enabled.

### Chips

Compact badges use the pill radius, a fine mineral border and subdued text. Semantic variants change text and border to the appropriate status family; the status word remains present. Action chips use transparent backgrounds and strengthen ink and border on hover. These are compact annotations and secondary actions, not the primary action treatment.

### Cards / Containers

Settings cards use the card radius, secondary warm ground, fine line border and card padding. Record inspectors use the larger inspector radius, ivory plate and ambient lift. The inspector's top is a satin header; fields and credentials inside use recessed sub-surfaces. Modal and gate containers use the dialog radius and common ambient shadow. Keep internal content scrollable within viewport limits.

### Inputs / Fields

Text fields use the field radius, ivory plate, stronger mineral outline and recessed shadow. Standard field padding is (8px 10px); gate fields use (10px 12px). Focus changes the border to information blue and preserves the inset shadow. Placeholders use quiet text at full opacity. Text, technical values and secrets remain selectable. Validation uses explicit error text and danger treatment; do not invent an undocumented field-level error variant.

### Navigation

Inventory and Accounts sit in an inset segmented support. The active tab becomes a raised satin plate with primary ink. Tree rows remain compact (minimum 32px); hover uses the secondary panel, and selection uses an ink-tinted panel with an inset shadow. Counts stay quieter than names. Add actions become visible on hover and keyboard focus. Long names truncate in the rail but wrap in record detail. Settings navigation uses the same raised selected treatment and becomes horizontal and wrapping on narrow screens.

### Segmented controls and toggles

Web appearance and timing selectors use an inset secondary-panel track and a raised selected segment. The appearance options are Light, Dark and System. Light is the default, the web choice persists in local storage and System responds to OS appearance changes. Native macOS appearance is independent: SwiftUI persists the same three choices in `UserDefaults` and applies Aqua, Dark Aqua or the system appearance to the entire window.

Toggles use a compact pill track (34px by 20px) and white thumb (16px). Checked state moves the thumb (14px) and applies the action ink to the track. The underlying input remains keyboard accessible; focus surrounds its visible track. Preserve the accompanying text label.

### Physical map and inspector

In the web map, companies form colored grounds; machines are slabs and services occupy their hosts as physical blocks. SVG label halos follow the current map ground color to keep technical text readable. Hover brightens blocks, dimmed results reduce opacity, and route, ingress and parent connections carry distinct semantic treatments. Selection updates the familiar record inspector and camera; launch and credential actions continue through existing Rust-backed workflows.

The native map uses SwiftUI `Canvas` for its dotted support, company grounds, machine slab depth and route connections. Accessible SwiftUI buttons sit over the drawing for each company, machine, service and proxy, with context-menu editing and selected accent strokes. Selection updates the native inspector without a forced camera move. Inventory is also available as a native list; the rail includes networks and accounts alongside the mapped entity types.

Drawers enter with a short slide (220ms, `cubic-bezier(.2,.9,.3,1)`); flow lines, spinners and small state transitions provide operational feedback. `prefers-reduced-motion` shortens CSS animation and transition duration and the map camera respects reduced motion. Do not carry EION's animated theme-token crossing into this system without implementing and verifying it.

### Native macOS workspace and workflows

SwiftUI supplies all visible macOS views: startup and locked-vault screens, vault creation and authenticator enrollment, the inventory and map workspace, record inspectors, entity editors, dependency-aware deletion, settings, security, cloud linking, sync, import and export. The top navigation row provides title/maker, Search, Fit, New, Sync, Settings, Lock, remaining session time and a memory-lock warning when needed. Its control group uses native Liquid Glass on macOS 26 and newer, with ultra-thin material on macOS 13–25. System fonts, SF Symbols, native help text and disabled states follow the platform.

Native editors cover companies, machines, services, reverse proxies, networks and accounts, including their nested technical fields. Secret editors expose Keep, Replace and Remove choices; account inspectors provide explicit reveal/hide and timed clipboard actions. Security includes password changes, key derivation and authenticator setup or removal. Sync exposes destination management, automatic sync, progress and conflict-resolution confirmation. Import previews validation results before Apply; export selects Excel or JSON, with master-password confirmation when readable secrets are included. Native map export offers PNG, SVG and FossFLOW JSON.

The application window content is an `NSHostingView` containing `NativeRoot`; React does not mount on macOS and no webview hosts these native screens. Swift sends asynchronous requests through a C ABI bridge to the same Rust command handlers used by the web application. Native busy states prevent repeated operations and interactive sheet dismissal during active work; errors use explicit alerts, and vault-lock events clear the workspace and sheet state. This visual system does not create a separate vault implementation.

Presentation evidence is in `.impeccable/review/native-final`: the light and dark workspace captures show the native split panes at (1440px by 642px), and editor, vault, cloud, import/export and settings captures show native controls and sheet actions on macOS 26.6.2. The current settings source adds an explicit section picker; further section captures are tracked by the finish review. These images establish the native presentation. The true native-to-Rust bridge integration test is tracked separately and is not reported as passed by this documentation extraction.

## Do's and Don'ts

### Do:

- **Do** use the paired semantic palette for every new surface and text treatment.
- **Do** retain raised resting actions, inset fields and a consistent top-lit material.
- **Do** use status words and distinguishable connection treatments alongside color.
- **Do** keep technical values selectable and keyboard focus clearly visible.
- **Do** preserve the existing logos and carry the semantic material roles into native macOS views.
- **Do** inspect web light, dark, compact, narrow and settings states, plus native light, dark and sheet states; web evidence is in `.impeccable/review` and macOS evidence in `.impeccable/review/native-final`.

### Don't:

- **Don't** replace the warm neutral chrome with decorative saturated surfaces.
- **Don't** use low-opacity text to quiet important details over the map.
- **Don't** erase pressed, focused, selected or disabled states when adding a control.
- **Don't** replace native SwiftUI forms and platform control feedback with webview replicas, or treat presentation captures as proof of bridge workflow execution.
- **Don't** add raster textures to reproduce materials already expressed by CSS and SVG.
