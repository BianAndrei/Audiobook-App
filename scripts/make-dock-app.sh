#!/bin/bash
# Build ~/Applications/Bookshelf.app — a real Mac app (its own window, Dock icon and menu bar)
# that starts the reader + narrator, and stops them again when you quit — and pin it to the Dock.
#   ./scripts/make-dock-app.sh            build + add to Dock
#   ./scripts/make-dock-app.sh --no-dock  build only
# Needs Apple's command line tools (xcode-select --install) for the Swift compiler.
# Re-run it if you move this project folder (the app points at the folder's path).
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/Bookshelf.app"
ICON_SRC="$PROJECT/assets/icons/icon-1024.png"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PY="$(command -v python3 || true)"
[ -x /opt/homebrew/bin/python3 ] && PY=/opt/homebrew/bin/python3
[ -n "$PY" ] || { echo "python3 not found"; exit 1; }
command -v swiftc >/dev/null || { echo "Swift compiler not found: run  xcode-select --install  first"; exit 1; }

echo "Building $APP"
# Quit a running copy first (it saves your place and stops the servers).
osascript -e 'tell application id "local.bookshelf.app" to quit' >/dev/null 2>&1 || true
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -sdk "$(xcrun --show-sdk-path)" -o "$APP/Contents/MacOS/Bookshelf" "$PROJECT/mac/Bookshelf.swift"

# Icon (.icns) from the 1024 px PNG
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

"$PY" - "$APP/Contents/Info.plist" "$PROJECT" "$PY" <<'PLIST'
import plistlib, sys
path, project, python = sys.argv[1:4]
with open(path, "wb") as f:
    plistlib.dump({
        "CFBundleExecutable": "Bookshelf",
        "CFBundleIdentifier": "local.bookshelf.app",
        "CFBundleName": "Bookshelf",
        "CFBundleDisplayName": "Bookshelf",
        "CFBundlePackageType": "APPL",
        "CFBundleIconFile": "AppIcon",
        "CFBundleShortVersionString": "1.0",
        "CFBundleVersion": "1",
        "LSMinimumSystemVersion": "13.0",
        "LSApplicationCategoryType": "public.app-category.books",
        "NSHighResolutionCapable": True,
        "NSSupportsAutomaticGraphicsSwitching": True,
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        "NSHumanReadableCopyright": "Runs entirely on this Mac.",
        "BookshelfProject": project,   # where manage.py and the Books folder live
        "BookshelfPython": python,
    }, f)
PLIST

# Ad-hoc signature so macOS remembers permissions (e.g. access to the Downloads folder).
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true

if [ "${1:-}" != "--no-dock" ]; then
  if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "Applications/Bookshelf.app"; then
    echo "Already in the Dock."
  else
    defaults write com.apple.dock persistent-apps -array-add \
      "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://$APP/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>"
    echo "Added Bookshelf to the Dock."
  fi
  killall Dock  # also refreshes the icon
fi
echo "Done."
