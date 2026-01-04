# Hybrid DV HDR GUI

Desktop GUI for merging Dolby Vision metadata with HDR10 sources.

## Requirements

- Node.js 20+
- Rust (stable)
- WiX Toolset (for MSI builds on Windows)

## Development

```
npm install
npm run tauri:dev
```

## Build MSI

```
npm run tauri:build
```

The installer will be in `src-tauri/target/release/bundle/msi/`.

