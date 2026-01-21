# Hybrid DV/HDR GUI

Desktop GUI for Hybrid Dolby Vision/HDR workflows.

## Requirements

- Node.js 18+ and npm (recommended via [nvm](https://github.com/nvm-sh/nvm#installing-and-updating))
- Tauri prerequisites if building the desktop app: https://tauri.app/v1/guides/getting-started/prerequisites

## Getting started

```sh
# Clone the repository
git clone <YOUR_GIT_URL>

# Enter the project
cd <YOUR_PROJECT_NAME>

# Install dependencies
npm install
```

## Development

```sh
# Start the Vite dev server
npm run dev
```

## Build

```sh
# Build the web app
npm run build

# Build a dev-mode web bundle
npm run build:dev
```

## Desktop (Tauri)

```sh
# Run the desktop app in dev mode
npm run tauri:dev

# Build the desktop app
npm run tauri:build
```

## Lint

```sh
npm run lint
```

## Tech stack

- Vite
- TypeScript
- React
- shadcn-ui
- Tailwind CSS

## Deployment

Deployment is project-specific. For a hosted web build, run `npm run build` and serve the generated assets.
