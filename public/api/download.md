# World Monitor desktop downloads

`GET /api/download` redirects to the latest GitHub Release asset for the World Monitor desktop app. This markdown twin documents the redirect so agents can read it without following a binary `302`.

One published binary serves every in-app variant. `variant` is an identity hint, not an asset selector. An unknown `platform` or unsupported `variant` redirects to the GitHub releases page instead of guessing an installer.

## Query parameters

- **`platform`** (required for a binary): one of the platform ids below.
- **`variant`** (optional): `full`, `world`, `tech`, `finance`, `commodity`, `energy`, or `happy`. Every supported value resolves to the same World Monitor artifact.

## Platforms

| `platform` | Asset |
|---|---|
| `windows-exe` | Windows `.exe` installer (`_x64-setup.exe`) |
| `windows-msi` | Windows `.msi` installer (`_x64_en-US.msi`) |
| `macos-arm64` | macOS Apple Silicon `.dmg` (`_aarch64.dmg`) |
| `macos-x64` | macOS Intel `.dmg` (`_x64.dmg`) |
| `linux-appimage` | Linux x64 AppImage (`_amd64.AppImage`) |
| `linux-appimage-arm64` | Linux ARM64 AppImage (`_aarch64.AppImage`) |

## Examples

- [Windows .exe](https://worldmonitor.app/api/download?platform=windows-exe)
- [macOS Apple Silicon](https://worldmonitor.app/api/download?platform=macos-arm64)
- [macOS Intel](https://worldmonitor.app/api/download?platform=macos-x64)
- [Linux AppImage](https://worldmonitor.app/api/download?platform=linux-appimage)

## Related

- Latest GitHub release: https://github.com/koala73/worldmonitor/releases/latest
- Version API: https://worldmonitor.app/api/version
- Homepage markdown twin: https://worldmonitor.app/index.md
