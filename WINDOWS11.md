# Bops for Windows 11

This branch ports the Bops desktop application to Windows 11 while keeping the upstream internal `mac` state/API identifiers for compatibility.

## Supported

- Electron desktop app and local Next.js server
- Orgo cloud computers
- OpenAI / Codex integration
- Composio, Honcho, AgentMail and existing provider integrations
- Local Chrome/Edge bot-browser workers
- Windows protected secret storage using DPAPI
- Windows Codex CLI discovery and automatic verified download
- NSIS installer and portable x64 executable
- Electron desktop screen/window previews

## Windows parity notes

Bops uses the current native Windows Codex executable and enables OpenAI's bundled Computer Use plugin for local-PC tasks. Local screen/window previews, UI Automation text reading, Chrome/Edge workers, protected secrets, notifications, installer packaging and cloud-computer workflows have Windows implementations.

Orgo personal-device egress still requires a compatible `orgo-relay.exe`. If your Orgo distribution provides it, set `BOPS_RELAY_BIN` to its full path. This private Orgo binary is not part of the public Bops repository.

## Requirements

- Windows 11 x64
- Node.js 22+
- Git
- PowerShell 5.1+ or PowerShell 7
- Chrome recommended; Edge is accepted as fallback

## Development

```powershell
git clone https://github.com/hasnainkhatri87/bops.git
cd bops
git checkout windows-11
Copy-Item .env.example .env.local
npm install
npm run win:doctor
npm run app
```

Or:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-windows.ps1
```

## Build Windows installer + portable EXE

```powershell
npm run app:build:win
```

or:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release-windows.ps1
```

Output is written to `dist-desktop\`.

## Self-hosted configuration

At minimum follow the upstream Bops self-hosting requirements. A typical `.env.local` includes:

```env
BOPS_SELF_HOSTED=1
OPENAI_API_KEY=...
ORGO_API_KEY=...
```

If browser auto-detection fails:

```env
BOPS_CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
```

Do not expose the local Bops server directly to the public Internet.

For an externally supplied Windows Orgo relay:

```env
BOPS_RELAY_BIN=C:\\path\\to\\orgo-relay.exe
```
