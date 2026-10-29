# Kurogane

<!-- impeccable:product-schema 1 -->

## Platform

web

Desktop React workspace on Windows and Linux. macOS uses SwiftUI for navigation, inventory, inspectors, forms, settings and vault workflows, with the original React/SVG graph renderer embedded in its existing WKWebView. All platforms use the same Rust core.

## Product Purpose

Map companies, machines, services, networks, proxies and accounts in an offline encrypted vault. Preserve the existing inventory, map, launchers, import/export, security and sync workflows.

## Users

Repository-derived assumption: people who manage infrastructure and credentials across multiple organizations and computers. No audience change was requested.

## Capabilities and Constraints

Rust owns encryption, plaintext secrets, clipboard clearing, persistence and sync. No telemetry or hosted account is introduced. Cloud sync transfers the encrypted vault. Keep cross-platform feature parity and avoid any release publication during this work.

The map must preserve meaningful company, host, service, VM and proxy-route relationships using the original topology renderer. Its macOS boundary carries secret-free topology with credentials excluded, selections and generated map exports; native forms and vault commands stay outside the graph webview. Native sheets must fit the actual parent content rectangle, scroll their fields and retain visible action rows at compact window sizes. Text and actions must remain readable in Light, Dark and inactive native windows.

## Brand Commitments

Kurogane is a product of Issen Software Group, issen.kurokamicorp.com. The user requested a natural, semi-real skeuomorphic interface, mainly white with a dark option, referencing Boundless primarily and EION Studios secondarily. macOS uses native Liquid Glass when supported.

## Evidence on Hand

The implementation, README.md and neighboring Boundless/src/ui/Theme.{h,cpp} and EION-STUDIOS-WEB/src/theme.css establish the material direction. UI tests cover contrast and topology behavior. The native layout harness uses populated topology and actual attached sheets at compact sizes; bridge integration is verified separately. Historical native captures from empty fixtures or the removed SwiftUI map are not evidence for the current renderer or layout.
