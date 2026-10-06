import SwiftUI

enum NativePalette {
    private static func color(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(nsColor:NSColor(name:nil,dynamicProvider:{ appearance in
            let value = appearance.bestMatch(from:[.aqua,.darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed:CGFloat((value >> 16) & 255)/255,green:CGFloat((value >> 8) & 255)/255,blue:CGFloat(value & 255)/255,alpha:1)
        }))
    }
    static let text = color(0x20211f,0xeeede9)
    static let secondary = color(0x52534e,0xbbb9b4)
    static let muted = color(0x62635d,0xa09e99)
    static let success = color(0x206c42,0x68d69a)
    static let warning = color(0x925500,0xf0b55a)
    static let danger = color(0xbc3029,0xff8276)
    static let link = color(0x315f91,0x98b9e0)
    static let primaryFill = color(0x343d42,0xd6d9d8)
    static let primaryInk = color(0xfffefa,0x20211f)
}
