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
