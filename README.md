# Hybrid DV HDR

Windows desktop app that injects the Dolby Vision RPU from one source into an
HDR10 / HDR10+ stream, producing a hybrid `.mkv`. Built with Tauri 2, React and
Tailwind, in the same style as GDExplorer and RsKV.

The app drives external command-line tools; nothing is bundled. Required:
[dovi_tool](https://github.com/quietvoid/dovi_tool),
[mkvmerge / mkvextract](https://mkvtoolnix.download/). Optional:
[hdr10plus_tool](https://github.com/quietvoid/hdr10plus_tool) (HDR10+ jobs),
[ffmpeg](https://ffmpeg.org/) (MP4 / raw streams),
[MediaInfo](https://mediaarea.net/en/MediaInfo), [MP4Box](https://gpac.io/).
Preferences → Tools shows what was found and can download the missing ones.

## How a job runs

1. Both sources are probed (`mkvmerge -J`, MediaInfo as fallback); frame rates
   must match, and a height difference is written into the RPU as letterbox
   offsets.
2. Audio and subtitles are pulled from the base (`mkvmerge --no-video`).
3. The DV video is demuxed and its RPU extracted (`dovi_tool extract-rpu`),
   then edited for offsets and sync delay when needed.
4. The HDR10 video is demuxed; with an HDR10+ source its metadata is extracted,
   optionally delayed, and injected (`hdr10plus_tool`).
5. The RPU is injected (`dovi_tool inject-rpu`) and everything is muxed
   (`mkvmerge`). Temp files sit next to the output and are removed unless
   "Keep temporary files" is on.

Folder pairs are matched by name and run across parallel workers (Preferences →
General).

## Development

Node.js 20+, Rust stable, and the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/). On Windows
the NSIS bundler is fetched by Tauri itself.

```sh
npm install
npm run tauri:dev      # desktop app with hot reload
npm run dev            # UI only, in a browser (no backend)
npm run tauri:build    # NSIS installer under src-tauri/target/release/bundle
```

Checks: `npm run typecheck`, `npm run lint`, `npm run format:check`,
`npm run rust:test`.

## Releases and auto-update

Every push to `main` bumps the patch version, builds the installer and
publishes a GitHub release; installed copies download it in the background and
offer a restart from the title bar. See
[docs/UPDATER_GITHUB_RELEASES.md](docs/UPDATER_GITHUB_RELEASES.md) for the
signing keys and the details.
