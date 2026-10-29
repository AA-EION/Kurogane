# Desktop workspace

Mode: Operate. Existing inventory navigation, isometric map and record inspector remain the task structure. The user's Boundless and EION references pin the material direction. Optional material and implementation questions received no response; this session follows the explicit brief directly and stores no workflow preference.

## Direction contract

THESIS: Infrastructure feels tangible: companies form map grounds, machines are slabs, and services sit physically on their hosts. Navigation remains familiar and compact.

OWN-WORLD: Ivory and satin surfaces, warm black ink, beveled controls, inset fields, offset soft shadows. Dark mode uses Boundless charcoal with equally legible ink. Color belongs to topology and status.

STORY: Find the company, follow its machine and service, inspect its route or account, act through the existing Rust-backed workflows.

FIRST VIEWPORT: Windows/Linux use a 64px toolbar above a 300px inventory rail and a large recessed map, with a 380px inspector. macOS uses SwiftUI navigation, split panes, inspectors, forms, settings and vault screens, with the original IsoCanvas renderer hosted in the existing WKWebView for the graph only. The native root fills the available content; its content minimum is 960px by 600px. Native navigation uses Liquid Glass on macOS 26 and newer. Search and New remain directly available on all platforms.

FORM: User-pinned skeuomorphic adaptation of Boundless's existing material language; no concept randomization replaces the explicit reference. The signature interaction is a pressed control followed by a camera move to the physical service, with reduced-motion support.

LAYOUT: Native sheets bound their requested size to the actual parent content rectangle. Scroll fields while retaining the footer actions outside the scroll area; create-vault and cloud flows use explicit labels. Editor fields keep separate vertical rows and explicit label/control alignment so grouped forms cannot merge adjacent labels. Test real attached sheets at 960px by 640px, including settings navigation, validation text and action rows.

LEGIBILITY: Ivory and charcoal keep explicit ink contrast. NativePalette owns readable dynamic text and status roles; native primary actions preserve text/fill contrast when the window is inactive. The shared graph uses theme-aware steel and slab text, with semantic company labels. Contrast tests require at least 4.5:1 for the established text/surface pairings.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

EVIDENCE: Accept current-revision captures only after the rich topology fixture loads real machine/service records and attached-sheet bounds are checked. Earlier empty-fixture and removed-renderer captures are invalid for this surface. A successful bridge run for an earlier revision does not certify later layout or contrast changes; presentation and command execution need separate evidence.
