# Automatic update check

Pizza detects newer releases of itself automatically. Checks target the
distribution channel matching your install method:

| Install method | Registry queried | Update guidance |
| --- | --- | --- |
| npm / pnpm / yarn / bun (`npm i -g @tomsun28/pizza`) | `registry.npmjs.org` | `npm install -g @tomsun28/pizza` (or the matching package manager) |
| Standalone binary (bun-compiled) or unknown | GitHub Releases API | Direct download link for your platform's installer, or the releases page |

The release installers follow the `Pizza_<version>_<platform>_<arch>.<ext>`
naming scheme (`macos_arm64.dmg`, `windows_x64-setup.exe`, `linux_x64.deb`, …).

## CLI (interactive sessions)

- On interactive startup a background check runs; if a newer version exists a
  notice is printed in the chat stream.
- Results are cached in `~/.pizza/agent/update-check.json` for 24 hours, and
  are invalidated automatically after you update.
- Checks never block startup; all network failures are silent.

### Manual check

```sh
pizza update            # check now (bypasses the cache) and print guidance
pizza update enable     # enable automatic startup checks (default)
pizza update disable    # disable automatic startup checks
```

### Disabling

- Setting: `pizza update disable` (writes `autoUpdateCheck: false` to
  `~/.pizza/agent/settings.json`)
- Environment: `PIZZA_SKIP_VERSION_CHECK=1` (implied by `PIZZA_OFFLINE=1`)

## Desktop app

- The Rust bridge command `check_app_update` queries the GitHub Releases API
  (`releases/latest`) and compares the release tag against the running app
  version.
- On startup (at most once a day) a slim dismissible banner appears above the
  main area when a newer version is published. "Download" opens the matching
  installer for your platform.
- Settings → General → "About & Updates" shows current/latest version and a
  "Check for updates" button.
