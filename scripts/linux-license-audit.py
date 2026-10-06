"""Collect distro notices before bundling; inventory actual ELF files after.
Uses dpkg metadata and never executes a discovered bundle file.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import shutil

parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["prepare", "inspect"])
parser.add_argument("--appdir", type=Path)
args = parser.parse_args()
output = Path("src-tauri/legal-platform/Linux")
output.mkdir(parents=True, exist_ok=True)
packages = {}
data = subprocess.check_output(["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n"], text=True)
for line in data.splitlines():
    name, version, source, source_version = line.split("\t")
    packages[name] = {"package": name, "version": version, "sourcePackage": source or name.split(":")[0], "sourceVersion": source_version or version}

if args.mode == "prepare":
    # Plugins/assets added by the bundler may not appear in app ldd output.
    for name in packages:
        source = Path("/usr/share/doc") / name.split(":")[0] / "copyright"
        if source.is_file():
            destination = output / "copyright" / name.replace(":", "_")
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
    shutil.copytree("/usr/share/common-licenses", output / "common-licenses", dirs_exist_ok=True)
    (output / "README.txt").write_text("Superset of installed distro copyright notices. Not every listed package is bundled. The artifact manifest identifies actual files and source versions.\n")
else:
    if not args.appdir:
        parser.error("inspect requires --appdir")
    bundle_names = {filename.name for filename in args.appdir.rglob("*") if filename.is_file()}
    index = {}
    for listing in Path("/var/lib/dpkg/info").glob("*.list"):
        name = listing.name[:-5]
        if name not in packages:
            continue
        for value in listing.read_text(errors="replace").splitlines():
            installed = Path(value)
            # Only inspect paths that could correspond to a bundled file. Other
            # dpkg entries include private system directories and need no access.
            if installed.name in bundle_names and installed.is_file():
                index.setdefault(installed.name, []).append((name, value))
    files, source_packages, unmapped = [], {}, []
    for filename in sorted(args.appdir.rglob("*")):
        if not filename.is_file() or filename.is_symlink():
            continue
        with filename.open("rb") as stream:
            is_elf = stream.read(4) == b"\x7fELF"
        if not is_elf:
            continue
        relative = str(filename.relative_to(args.appdir))
        candidates = sorted(index.get(filename.name, []), key=lambda item: "/lib/" not in item[1])
        record = {"file": relative, "sha256": hashlib.sha256(filename.read_bytes()).hexdigest()}
        if candidates:
            package, installed = candidates[0]
            record.update(packages[package])
            record["installedPath"] = installed
            source_packages[package] = packages[package]
        elif filename.name == "kurogane-desktop":
            record["component"] = "Kurogane: AGPL-3.0-or-later"
        elif filename.name in {"AppRun", "AppRun.wrapped"}:
            record["component"] = "AppImage launcher: AppImageKit/linuxdeploy"
        else:
            unmapped.append(relative)
            record["component"] = "UNMAPPED: requires explicit review before public distribution"
        files.append(record)
    report = {"schemaVersion": 1, "files": files, "sourcePackages": list(source_packages.values()), "unmapped": unmapped}
    Path("platform-license-manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Platform inventory: {len(files)} ELF files, {len(source_packages)} distro packages, {len(unmapped)} requiring review")
    Path("platform-source-packages.txt").write_text("\n".join(sorted({f'{p["sourcePackage"]}={p["sourceVersion"]}' for p in source_packages.values()})) + "\n")
