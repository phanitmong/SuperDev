# Releasing Apsara Panel

## Build an installer on your own computer

An installer can only be built on the system it is for.

| You are on | Command | Result in `release/` |
|---|---|---|
| macOS | `npm run dist:mac` | `ApsaraPanel-mac-arm64.dmg`, `ApsaraPanel-mac-x64.dmg` |
| Windows | `npm run dist:win` | `ApsaraPanel-win-x64.exe` |
| Linux | `npm run dist:linux` | `ApsaraPanel-linux-x86_64.AppImage` |

Run `npm install` first. The version number comes from `"version"` in `package.json`.

## Build all of them with GitHub

`.github/workflows/release.yml` builds the three installers and the team service on GitHub's own Mac, Windows and Linux machines and attaches them to a Release.

1. Put the project in a GitHub repository.
2. Set the version in `package.json` and commit.
3. Tag and push: `git tag v1.0.0` then `git push origin v1.0.0`.
4. When the workflow finishes, the files are on the repository's Releases page.

## Point the website at the release

Edit `website/config.js`:

```js
version: '1.0.0',
releases: 'https://github.com/phanitmong/SuperDev/releases/latest/download',
```

`latest/download` always serves the newest release, so the address stays the same for later versions; only `version` changes. The repository has to be public for visitors to download from it. With a private repository, upload the files to your own server and put that folder's address in `releases`.

The website is the `website/` folder: plain files, no build step. Upload the folder to any web host, or turn on GitHub Pages for it.

## Signing (what removes the warnings)

Without certificates the installers work, but:

- **macOS** says it cannot verify the developer. People open it once through System Settings, Privacy & Security, Open Anyway.
- **Windows** shows "Windows protected your PC". People choose More info, Run anyway.

To remove the warnings:

- **macOS**: join the Apple Developer Program, create a "Developer ID Application" certificate, export it as a `.p12`. In `package.json` under `build.mac` remove `"identity": "-"` and set `"hardenedRuntime": true`, and add `"notarize": true`. Add these repository secrets: `CSC_LINK` (the `.p12`, base64), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- **Windows**: buy a code-signing certificate and follow electron-builder's Windows signing guide for the kind you bought (most are now kept on a hardware token or in a cloud service, which changes the setup).

## What goes into the installer

Only the compiled app (`out/`) and the three packages it needs while running: `ssh2`, `mysql2`, `ws`. Everything the window uses is already compiled into `out/`, which is why those packages sit under `devDependencies`. The optional native speed-up modules of `ssh2` are left out on purpose, so the same build works on every system.

## The team service

`npm run server:build` makes one file, `dist-server/server.js`, that runs with Node 20 or later. See `deploy/` and the README for running it on a server.

## Updating the installed apps (from your own service)

Installed apps (1.1.0 and later) ask the service for a newer version after sign-in and every 6 hours. When one
exists they download it in the background, check its SHA-256, and show "Restart to update". Nothing is public:
the files are only handed to signed-in apps.

1. Raise `version` in `package.json` (for example 1.1.0 → 1.2.0). The app compares this number.
2. Build: `npm run dist:mac` (makes the .dmg for new installs and the .zip the updater uses) and the Windows
   .exe (`npm run dist:win` on Windows, or the GitHub Actions run).
3. Put the files on the service machine in one folder, then publish them as the service's user:

   ```
   sudo -u superdevops env SUPERDEVOPS_DATA=/var/lib/superdevops-service \
     node /opt/superdevops/server.js app-release /tmp/apsara-release 1.2.0 "What is new, one line"
   ```

   Files it looks for: `ApsaraPanel-mac-arm64.zip`, `ApsaraPanel-mac-x64.zip`, `ApsaraPanel-win-x64.exe`,
   `ApsaraPanel-linux-x86_64.AppImage` (any you have). They are copied to `app-updates/<version>/` in the
   service's data folder; the version before is kept, older ones are removed.

How each system installs: Windows runs the installer silently and opens the app again; macOS replaces the
.app it was opened from (it must be in a folder the person can write to, such as /Applications for an admin
account) and opens it; Linux replaces the AppImage. Apps before 1.1.0 cannot update themselves: install
1.1.0 by hand once.
