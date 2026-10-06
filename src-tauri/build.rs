fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_swift_shell();
    }
    tauri_build::build()
}

fn build_swift_shell() {
    use std::path::PathBuf;
    use std::process::Command;
    println!("cargo:rerun-if-changed=macos/KuroganeShell.swift");
    let output = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        other => panic!("unsupported macOS architecture: {other}"),
    };
    let sdk = Command::new("xcrun").args(["--sdk", "macosx", "--show-sdk-path"]).output().expect("Xcode 26+ is required");
    assert!(sdk.status.success(), "could not locate macOS SDK");
    let sdk = String::from_utf8(sdk.stdout).unwrap();
    let library = output.join("libKuroganeNative.a");
    let status = Command::new("xcrun")
        .args(["swiftc", "-emit-library", "-static", "-parse-as-library", "-O", "-module-name", "KuroganeNative", "-target"])
        .arg(format!("{arch}-apple-macosx13.0"))
        .args(["-sdk", sdk.trim(), "macos/KuroganeShell.swift", "-o"])
        .arg(&library).status().expect("could not compile SwiftUI shell");
    assert!(status.success(), "SwiftUI shell compilation failed");
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-search=native={}/usr/lib/swift", sdk.trim());
    let compiler = Command::new("xcrun").args(["--find", "swiftc"]).output().unwrap();
    let compiler = PathBuf::from(String::from_utf8(compiler.stdout).unwrap().trim());
    let toolchain = compiler.parent().unwrap().parent().unwrap();
    println!("cargo:rustc-link-search=native={}/lib/swift/macosx", toolchain.display());
    println!("cargo:rustc-link-lib=static=KuroganeNative");
    println!("cargo:rustc-link-lib=dylib=swiftCore");
    for framework in ["AppKit", "SwiftUI", "WebKit", "Foundation", "Combine"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
