# ⚡ FlashFill

**Zero-click burner identity & OTP automation for signup forms.**

FlashFill is a Chrome extension that eliminates the friction of throwaway sign-ups. It detects signup forms, generates a temporary identity, ghost-fills the form, and automatically handles OTP verification — all without a single click.

---

## Demo

> Open any signup page → FlashFill detects the form → fills it instantly → intercepts the verification email → injects the OTP. Done.

---

## Features

- **Zero-click form filling** — detects email/name/password fields and fills them automatically
- **Temporary email generation** — powered by [Privatix Temp Mail](https://rapidapi.com/Privatix/api/temp-mail) via RapidAPI
- **OTP auto-injection** — polls the temp mailbox and injects verification codes in real time
- **Magic link support** — opens verification links automatically in the background
- **Multi-step form support** — MutationObserver + URL watcher handles SPA navigation
- **Identity history** — browse and reuse past burner identities with full detail recall
- **Auto-verify toggle** — control whether verification links open automatically
- **Pause / resume** — stop FlashFill from running on the current session
- **Neubrutalist UI** — Space Grotesk, neon yellow (#eaff00), hard black shadows

---

## Tech Stack

| Layer | Choice |
|---|---|
| Language | TypeScript |
| Build tool | Vite 4 + CRXJS |
| Identity generation | Faker.js |
| Email API | Privatix Temp Mail (RapidAPI) |
| Extension API | Chrome Manifest V3 |
| UI | Vanilla DOM — no React, no Vue |

---

## Getting Started

### Prerequisites

- Node.js 18+
- A free [RapidAPI](https://rapidapi.com) account
- Subscribe to [Privatix Temp Mail](https://rapidapi.com/Privatix/api/temp-mail) (free tier available)

### Installation

```bash
git clone https://github.com/rushilbh27/getflashfill.git
cd getflashfill
npm install
npm run build
```

Then load the extension in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `dist/` folder

### First Run

Paste your RapidAPI key into the popup when prompted. That's it — FlashFill is now active on every tab.

---

## Project Structure

```
src/
├── background/
│   ├── worker.ts              # Service worker — message routing
│   ├── identity-manager.ts    # Identity creation + temp email setup
│   └── polling-manager.ts     # OTP polling loop
├── content/
│   ├── detector.ts            # Form + email field detection
│   ├── injector.ts            # Ghost-fill + OTP injection + toast UI
│   └── observer.ts            # MutationObserver + URL watcher (SPA)
├── popup/
│   ├── popup.html             # Extension popup
│   ├── popup.ts               # Popup controller
│   └── popup.css              # Neubrutalist styles
└── shared/
    ├── types.ts               # Shared TypeScript types
    ├── messages.ts            # Typed message contract (content ↔ worker)
    ├── storage.ts             # chrome.storage.local wrapper
    ├── identity.ts            # Faker.js identity generator
    ├── privatix-temp-mail.ts  # Privatix API client
    └── otp-extractor.ts       # OTP + magic link extraction
```

---

## How It Works

```
1. observer.ts     watches DOM mutations + URL changes
2. detector.ts     finds signup forms by keyword + parent heuristics
3. injector.ts     ghost-fills email, name, password with fake identity
4. Content script  sends FORM_SUBMITTED → service worker
5. worker.ts       spins up polling via polling-manager.ts
6. polling-manager polls Privatix API for new email in temp mailbox
7. worker.ts       sends OTP_FOUND → content script
8. injector.ts     injects OTP into verification field
```

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

## License

MIT — see [LICENSE](./LICENSE).
