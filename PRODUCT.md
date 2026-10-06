# Kurogane

<!-- impeccable:product-schema 1 -->

## Platform

web

Desktop React workspace on Windows and Linux; every visible macOS view is SwiftUI, backed by the same Rust core.

## Product Purpose

Map companies, machines, services, networks, proxies and accounts in an offline encrypted vault. Preserve the existing inventory, map, launchers, import/export, security and sync workflows.

## Users

Repository-derived assumption: people who manage infrastructure and credentials across multiple organizations and computers. No audience change was requested.

## Capabilities and Constraints

Rust owns encryption, plaintext secrets, clipboard clearing, persistence and sync. No telemetry or hosted account is introduced. Cloud sync transfers the encrypted vault. Keep cross-platform feature parity and avoid any release publication during this work.

## Brand Commitments

Kurogane is a product of Issen Software Group, issen.kurokamicorp.com. The user requested a natural, semi-real skeuomorphic interface, mainly white with a dark option, referencing Boundless primarily and EION Studios secondarily. macOS uses native Liquid Glass when supported.

## Evidence on Hand

README.md, docs/img, the existing implementation, and neighboring Boundless/src/ui/Theme.{h,cpp} and EION-STUDIOS-WEB/src/theme.css. Existing screenshots document the previous dark interface.
