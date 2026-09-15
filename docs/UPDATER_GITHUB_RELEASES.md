# Releases and auto-updates

Pushing to `main` publishes a new release, and installed copies of the app
update themselves from it. Nothing has to be tagged, drafted or published by
hand.

## What happens on a push

`.github/workflows/release.yml` runs on every push to `main` (doc-only pushes
are skipped) and does this, in order:

1. Raises the patch version in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` — see
   `scripts/bump-version.js`.
2. Commits that as `Release vX.Y.Z [skip ci]`, tags it, and pushes both
   back to `main`. A push made with `GITHUB_TOKEN` does not start another
   workflow run, so this cannot loop.
3. Builds the Windows NSIS installer and the signed updater artifacts.
4. Publishes a GitHub release holding the installer, `latest.json` and the
   signature.

Because the workflow pushes a commit, **pull before you push again** or your
next push is rejected as out of date.

To raise the minor or major version instead, run the workflow by hand from the
Actions tab and pick the bump. Only the Windows installer is built; the app is
Windows-only.

## Why the version has to move

The updater compares the version in `latest.json` against the version compiled
into the running app and only offers something newer. A release that repeats the
installed version is invisible to it, which is why every push bumps.

## Why the release is published, not drafted

The endpoint in `src-tauri/tauri.conf.json` is
`https://github.com/AdkHex/Hybrid-DV-HDR-GUI/releases/latest/download/latest.json`, and
`/releases/latest/` never resolves to a draft. A drafted release leaves every
client reporting that it is already up to date.

## Signing keys

Updater artifacts are signed, and the app refuses an update whose signature does
not match the public key it was built with.

- Public key: `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
- Private key: the `TAURI_SIGNING_PRIVATE_KEY` repository secret, unlocked by
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

The pair currently in use was generated on the macOS machine and lives in
`~/.tauri/`: `hybrid-dv-hdr-updater.key`, its `.pub`, and
`hybrid-dv-hdr-updater.password`.

**Keep a backup of the private key and its password**, somewhere that is not
that one laptop. Losing them means no future release can be signed for the apps
already installed: you would have to generate a new pair, ship a build carrying
the new public key, and get everyone to install that one by hand, because their
current app rejects everything signed with a key it does not know.

To generate a fresh pair:

```sh
# Use a real password. A key generated with --password "" is rejected by the
# bundler as having the wrong password, and the build fails after producing the
# installer.
npx tauri signer generate -w ~/.tauri/hybrid-dv-hdr-updater.key --password "$PW"
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/hybrid-dv-hdr-updater.key
printf '%s' "$PW" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Then copy the contents of `~/.tauri/hybrid-dv-hdr-updater.key.pub` into
`plugins.updater.pubkey`. Everyone already running the app has to reinstall
after that, so only do it if the old key is genuinely gone.

## In the app

`src/App.tsx` checks for updates shortly after startup when "Check for updates
on launch" (Preferences → General) is on, and Preferences → About has a manual
check. Downloads
happen in the background; the title bar offers a restart when one is ready.

## Windows SmartScreen

The installer is not code-signed with a paid certificate, so the first run of a
downloaded installer shows "Windows protected your PC" → _More info_ → _Run
anyway_. Updates applied by the app itself install per-user and do not prompt for
an administrator.
