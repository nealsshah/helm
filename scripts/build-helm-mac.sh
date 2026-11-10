#!/usr/bin/env bash
# Build and install the personal macOS desktop application with T3's release packager.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
[[ "$(uname -s)" == Darwin ]] || { echo 'Helm.app requires macOS.' >&2; exit 1; }
usage() {
  echo "Usage: $0 [--stage VERSION DIRECTORY | --publish VERSION DIRECTORY]" >&2
  exit 2
}
mode=install
version=0.1.8-helm.2
if (( $# )); then
  [[ $# == 3 ]] || usage
  case "$1" in
    --stage) mode=stage ;;
    --publish) mode=publish ;;
    *) usage ;;
  esac
  version=$2
  [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-helm\.(0|[1-9][0-9]*)$ ]] || usage
  output=$3
  mkdir -p "$output"
  output=$(cd "$output" && pwd)
fi
case "$(uname -m)" in
  arm64) arch=arm64; rust_target=aarch64-apple-darwin ;;
  x86_64) arch=x64; rust_target=x86_64-apple-darwin ;;
  *) echo 'Unsupported Mac architecture.' >&2; exit 1 ;;
esac

archive="Helm-$version-$arch.zip"
manifest() {
  local zip=$1
  local hash
  hash=$(openssl dgst -sha512 -binary "$zip" | openssl base64 -A)
  cat <<EOF
version: $version
files:
  - url: $archive
    sha512: $hash
    size: $(stat -f %z "$zip")
path: $archive
sha512: $hash
releaseDate: '$(date -u -r "$zip" '+%Y-%m-%dT%H:%M:%SZ')'
EOF
}

if [[ "$mode" == publish ]]; then
  [[ -f "$output/$archive" && -f "$output/latest-mac.yml" ]] || { echo "Stage $version before publishing." >&2; exit 1; }
  manifest "$output/$archive" | cmp - "$output/latest-mac.yml"
  release_repo=nealsshah/helm
  tag="v$version"
  if release_is_draft=$(gh release view "$tag" -R "$release_repo" --json isDraft --jq .isDraft 2>/dev/null); then
    [[ "$release_is_draft" == true ]] || { echo "$tag is already published. Stage a new version." >&2; exit 1; }
  else
    gh release create "$tag" -R "$release_repo" --draft --title "Helm $version" --notes "Personal macOS build for $arch."
  fi
  gh release upload "$tag" -R "$release_repo" "$output/$archive" "$output/latest-mac.yml" --clobber
  gh release edit "$tag" -R "$release_repo" --draft=false --prerelease=false --latest
  exit
fi

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
if [[ "$mode" == stage && ( -e "$output/Helm.app" || -e "$output/$archive" || -e "$output/latest-mac.yml" ) ]]; then
  echo "Use an empty release directory." >&2; exit 1
fi
signer=${HELM_MAC_SIGN_IDENTITY:-Helm Local Release Signing}
sign_keychain=${HELM_MAC_SIGN_KEYCHAIN:-"$HOME/Library/Application Support/Helm Signing/release.keychain-db"}
sign_args=(--force --deep --sign "$signer")
if [[ -f "$sign_keychain" ]]; then
  password_file="$HOME/Library/Application Support/Helm Signing/keychain-password"
  if [[ "$sign_keychain" == "$(dirname "$password_file")/release.keychain-db" && -f "$password_file" ]]; then
    security unlock-keychain -p "$(cat "$password_file")" "$sign_keychain"
  fi
  sign_args+=(--keychain "$sign_keychain")
fi
[[ "$signer" != "-" ]] || { echo "Automatic updates require a persistent signing identity." >&2; exit 1; }
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
  --build-version "$version" --output-dir "$stage"
bundle=$(find "$stage" -maxdepth 2 -type d -name Helm.app -print -quit)
[[ -n "$bundle" && "$(plutil -extract CFBundleIdentifier raw "$bundle/Contents/Info.plist")" == com.nealsshah.helm ]]
cmp scripts/lib/helm-update.yml "$bundle/Contents/Resources/app-update.yml"
# A persistent identity lets Keychain recognize Helm after local rebuilds.
codesign "${sign_args[@]}" "$bundle"
codesign --verify --deep --strict "$bundle"
if [[ -f "$target/Contents/Resources/app-update.yml" ]]; then
  requirement=$(codesign -d -r- "$target" 2>/dev/null | sed -n 's/^designated => //p')
  [[ -n "$requirement" ]] || { echo "The installed app has no persistent signing requirement." >&2; exit 1; }
  codesign --verify --test-requirement "=$requirement" "$bundle"
fi
if [[ "$mode" == stage ]]; then
  ditto -c -k --sequesterRsrc --keepParent "$bundle" "$stage/$archive"
  mv "$stage/$archive" "$output/$archive"
  manifest "$output/$archive" > "$output/latest-mac.yml"
  mv "$bundle" "$output/Helm.app"
  echo "Staged $version in $output"
  exit
fi
if [[ -n "$(/usr/bin/lsappinfo find bundleID=com.nealsshah.helm)" ]]; then
  echo 'Quit Helm before replacing the running application.' >&2; exit 1
fi
if [[ -e "$target" ]]; then mv "$target" "$stage/previous.app"; fi
mv "$bundle" "$target"
printf 'Installed %s\n' "$target"
