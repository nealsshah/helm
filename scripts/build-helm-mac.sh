#!/usr/bin/env bash
# Build and install the personal macOS desktop application with T3's release packager.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
[[ "$(uname -s)" == Darwin ]] || { echo 'Helm.app requires macOS.' >&2; exit 1; }
case "$(uname -m)" in
  arm64) arch=arm64; rust_target=aarch64-apple-darwin ;;
  x86_64) arch=x64; rust_target=x86_64-apple-darwin ;;
  *) echo 'Unsupported Mac architecture.' >&2; exit 1 ;;
esac

# This location is optional. Other machines can supply the pinned tools on PATH.
if [[ -x "$HOME/.local/share/helm-toolchain/node_modules/.bin/node" ]]; then
  export PATH="$HOME/.local/share/helm-toolchain/node_modules/.bin:$PATH"
fi
export PATH="$repo/node_modules/.bin:$PATH"
required_node=$(node -p 'require("./package.json").engines.node')
required_pnpm=$(node -p 'require("./package.json").packageManager.split("@").at(-1)')
[[ "$(node -p 'process.versions.node')" == "$required_node" && "$(pnpm --version)" == "$required_pnpm" ]] || {
  echo "Use Node $required_node and pnpm $required_pnpm." >&2; exit 1;
}
[[ -x "$repo/node_modules/.bin/vp" ]] || pnpm install --frozen-lockfile

base="/Applications/T3 Code (Nightly).app/Contents"
helper="native/resource-monitor/target/$rust_target/release/t3-resource-monitor"
if [[ -f "$base/Info.plist" && "$(plutil -extract CFBundleShortVersionString raw "$base/Info.plist")" == 0.1.8-nightly.20261105.4234 ]] &&
   [[ -x "$base/Resources/resource-monitor/t3-resource-monitor" ]] &&
   lipo "$base/Resources/resource-monitor/t3-resource-monitor" -verify_arch "$(uname -m)"; then
  mkdir -p "$(dirname "$helper")"
  cp "$base/Resources/resource-monitor/t3-resource-monitor" "$helper"
  export T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=1
fi

apps="$HOME/Applications"
target="$apps/Helm.app"
mkdir -p "$apps"
if [[ -e "$target" && "$(plutil -extract CFBundleIdentifier raw "$target/Contents/Info.plist")" != com.nealsshah.helm ]]; then
  echo "$target is occupied by another application." >&2; exit 1
fi
stage=$(mktemp -d "$apps/.helm-build.XXXXXX")
cleanup() {
  # Restore the previous install if the replacement was interrupted.
  if [[ -d "$stage/previous.app" && ! -e "$target" ]]; then
    if ! mv "$stage/previous.app" "$target"; then
      printf 'Recover the previous Helm install from %s/previous.app\n' "$stage" >&2
      return 1
    fi
  fi
  rm -rf "$stage"
}
trap cleanup EXIT

node scripts/build-desktop-artifact.ts --platform mac --target dir --arch "$arch" \
  --build-version 0.1.8-helm.1 --output-dir "$stage"
bundle=$(find "$stage" -maxdepth 2 -type d -name Helm.app -print -quit)
[[ -n "$bundle" && "$(plutil -extract CFBundleIdentifier raw "$bundle/Contents/Info.plist")" == com.nealsshah.helm ]]
[[ ! -f "$bundle/Contents/Resources/app-update.yml" ]]
codesign --force --deep --sign - "$bundle"
codesign --verify --deep --strict "$bundle"
if [[ -n "$(/usr/bin/lsappinfo find bundleID=com.nealsshah.helm)" ]]; then
  echo 'Quit Helm before replacing the running application.' >&2; exit 1
fi
if [[ -e "$target" ]]; then mv "$target" "$stage/previous.app"; fi
mv "$bundle" "$target"
printf 'Installed %s\n' "$target"
