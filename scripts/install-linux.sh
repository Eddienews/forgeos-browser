#!/usr/bin/env bash
# Install or remove ForgeOS Browser for the current user on Linux.
#
#   scripts/install-linux.sh              install the packaged build from dist/
#   scripts/install-linux.sh --default    install and make it the default browser
#   scripts/install-linux.sh --uninstall  remove the application (keeps your data)
#
# Nothing here needs root. The application goes to ~/.local/share, the launcher
# and icon to the standard per-user locations. Your profile (history,
# bookmarks, settings) lives in ~/.config/ForgeOS Browser and is never touched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$DATA_HOME/forgeos-browser"
DESKTOP_FILE="$DATA_HOME/applications/forgeos-browser.desktop"
ICON_DIR="$DATA_HOME/icons/hicolor"
MODE="install"
MAKE_DEFAULT=0

for arg in "$@"; do
  case "$arg" in
    --uninstall) MODE="uninstall" ;;
    --default) MAKE_DEFAULT=1 ;;
    -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

refresh_caches() {
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DATA_HOME/applications" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$ICON_DIR" >/dev/null 2>&1 || true
}

if [ "$MODE" = "uninstall" ]; then
  rm -rf "$APP_DIR"
  rm -f "$DESKTOP_FILE" "$ICON_DIR/512x512/apps/forgeos-browser.png" "$ICON_DIR/scalable/apps/forgeos-browser.svg"
  refresh_caches
  echo "ForgeOS Browser removed. Your data in ~/.config/ForgeOS Browser was kept."
  exit 0
fi

case "$(uname -m)" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
SOURCE="$ROOT/dist/ForgeBrowserLab-linux-$ARCH"
if [ ! -x "$SOURCE/ForgeBrowserLab" ]; then
  echo "No packaged build at $SOURCE. Run: npm run package" >&2
  exit 1
fi
if pgrep -f "^$APP_DIR/ForgeBrowserLab" >/dev/null 2>&1; then
  echo "ForgeOS Browser is running. Close it first, then run this again." >&2
  exit 1
fi

# Replace the application directory as a whole so no file of an older version survives.
STAGING="$APP_DIR.new.$$"
rm -rf "$STAGING"
mkdir -p "$DATA_HOME/applications" "$ICON_DIR/512x512/apps" "$ICON_DIR/scalable/apps"
cp -a "$SOURCE" "$STAGING"
rm -rf "$APP_DIR"
mv "$STAGING" "$APP_DIR"

install -m 0644 "$ROOT/assets/icon.png" "$ICON_DIR/512x512/apps/forgeos-browser.png"
install -m 0644 "$ROOT/assets/icon.svg" "$ICON_DIR/scalable/apps/forgeos-browser.svg"

cat > "$DESKTOP_FILE" <<DESKTOP
[Desktop Entry]
Version=1.0
Type=Application
Name=ForgeOS Browser
GenericName=Web Browser
Comment=Private, local-first browser with an agent-safe trust boundary
Exec="$APP_DIR/ForgeBrowserLab" %U
Icon=forgeos-browser
Terminal=false
Categories=Network;WebBrowser;
MimeType=x-scheme-handler/http;x-scheme-handler/https;
StartupNotify=true
StartupWMClass=forgeos-browser
DESKTOP
chmod 0644 "$DESKTOP_FILE"
refresh_caches

if [ "$MAKE_DEFAULT" = "1" ]; then
  xdg-settings set default-web-browser forgeos-browser.desktop
  echo "ForgeOS Browser is now the default browser."
fi
VERSION="$(sed -n 's/^ *"version": *"\(.*\)",$/\1/p' "$ROOT/package.json" | head -1)"
echo "ForgeOS Browser $VERSION installed in $APP_DIR"
echo "Start it from your application launcher, or run: $APP_DIR/ForgeBrowserLab"
