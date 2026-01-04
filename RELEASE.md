# Release Guide (GitHub + Auto-Update)

## 1) Generate Tauri updater keys (one-time)
Run locally:
```
# from repo root
npx tauri signer generate
```
This prints a public key and a private key.

- Put the **public key** in `src-tauri/tauri.conf.json` under `tauri.updater.pubkey`.
- Save the **private key** as a GitHub secret `TAURI_PRIVATE_KEY`.
- If you set a password, store it as `TAURI_KEY_PASSWORD`.

## 2) Update updater endpoint
In `src-tauri/tauri.conf.json` set:
```
https://github.com/<OWNER>/Hybrid-DV-HDR-GUI/releases/latest/download/latest.json
```

## 3) Create GitHub repo
Create a repo named **Hybrid-DV-HDR-GUI**, then:
```
git init
git add .
git commit -m "Initial"
git branch -M main
git remote add origin https://github.com/<OWNER>/Hybrid-DV-HDR-GUI.git
git push -u origin main
```

## 4) Add secrets
In GitHub → Settings → Secrets and variables → Actions:
- `TAURI_PRIVATE_KEY`
- `TAURI_KEY_PASSWORD` (optional)

## 5) Release
Create a tag and push:
```
git tag v1.0.0
git push origin v1.0.0
```
The GitHub Action will build the MSI and publish it to the release.

## 6) Auto-updates
The app will check `latest.json` from your GitHub release and auto-update.
