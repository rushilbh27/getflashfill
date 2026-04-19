# FlashFill — Project Guide for Claude

## What FlashFill Is

FlashFill is a Chrome Extension (Manifest V3) that eliminates the friction of
"burner" sign-ups and logins. It automatically:

1. Detects signup / registration forms on any webpage.
2. Generates a temporary identity (email via the Tempmail RapidAPI, name via
   Faker.js) and ghost-fills the form.
3. Polls the temp mailbox for an OTP and auto-injects the code into the
   verification field.

The guiding philosophy: **zero clicks**. If the user has to press "Fill", we
have failed.

Full specification lives in `docs/PRD.md` (points to `FlashFill_PRD_v1_1.md`).
Always re-read the PRD before designing new behaviour.

---

## Tech Stack — Locked

| Layer | Choice |
|---|---|
| Language | TypeScript only |
| Build tool | **Vite 4** (pinned `^4.5.0`) |
| Chrome bundling | **CRXJS** (`@crxjs/vite-plugin`) |
| Identity generator | **Faker.js** (`@faker-js/faker`) |
| Extension API | **Manifest V3** |
| Frameworks | **None** — vanilla TS, no React, no Vue |

---

## Folder Structure

```
flashfill/
├── src/
│   ├── background/      Service worker — OTP polling, RapidAPI calls
│   │   └── worker.ts
│   ├── content/         Content scripts injected into every page
│   │   ├── detector.ts  Form / email-field detection
│   │   ├── injector.ts  Ghost-fill + OTP injection into inputs
│   │   └── observer.ts  MutationObserver + URL watcher (SPA nav)
│   ├── popup/           Extension popup UI (API key setup, history)
│   │   ├── popup.html
│   │   └── popup.ts
│   └── shared/          Code used by any surface — single source of truth
│       ├── messages.ts  Typed message contract (content ↔ worker)
│       ├── storage.ts   Async wrapper around chrome.storage.local
│       └── types.ts     Identity / SessionData / HistoryEntry / StorageSchema
├── docs/PRD.md
├── manifest.json        MV3 manifest (permissions, scripts, popup)
├── vite.config.ts       CRXJS plugin wired to manifest.json
├── tsconfig.json        Strict, ES2020, bundler resolution, chrome types
└── package.json
```

Ownership rules:
- **background/** is the only place that talks to external APIs.
- **content/** only touches the page DOM and sends messages to the worker.
- **popup/** only touches its own UI and `shared/storage.ts`.
- **shared/** has zero side effects and zero `chrome.*` calls outside
  `storage.ts`.

---

## Message Contract Summary

Defined in `src/shared/messages.ts`. Every message between a content script
and the service worker must use one of these exact shapes.

**Content script → Service worker (`ContentToWorkerMessage`)**
- `FORM_SUBMITTED` — payload: `{ url, email }` — primary OTP-poll trigger.
- `OTP_URL_DETECTED` — payload: `{ url }` — secondary trigger (URL contains
  `verify`, `otp`, or `code`).

**Service worker → Content script (`WorkerToContentMessage`)**
- `OTP_FOUND` — payload: `{ code }` — injector should fill the verify field.
- `OTP_TIMEOUT` — no payload — polling window elapsed with no code.
- `DOMAIN_REJECTED` — payload: `{ triedDomain }` — rotate to a fresh domain.
- `IDENTITY_READY` — payload: `{ identity }` — new identity available.

Raw-string message types are forbidden. Always import the discriminated union.

---

## Project Rules — Non-Negotiable

1. **No plain `.js` files.** Ever. TypeScript or nothing.
2. **No React, no Vue, no other UI frameworks.** Vanilla DOM only.
3. **Do not upgrade Vite to 5.x.** Vite stays on `^4.5.0` until CRXJS has a
   stable v5 release.
4. **Always use `src/shared/storage.ts`.** Never call `chrome.storage.*`
   directly from anywhere else.
5. **Always use message types from `src/shared/messages.ts`.** No raw-string
   message `type` fields in `sendMessage`/`onMessage` handlers.
6. **Never commit directly to `main`.** All work lands through a branch + PR.
7. **Never implement an API call without re-reading `docs/PRD.md` first.**
   Polling windows, timeouts, retry behaviour, quota-protection rules all
   live in the PRD and must match.

---

## Current Implementation State

| File | Status |
|---|---|
| `manifest.json`, `vite.config.ts`, `tsconfig.json`, `package.json` | Done |
| `src/shared/types.ts`, `messages.ts`, `storage.ts` | Done |
| `src/popup/popup.html`, `popup.ts` | Done |
| `src/content/detector.ts` | Done (basic keyword + parent-form detection) |
| `src/content/observer.ts` | Done (MutationObserver + URL-pattern watch) |
| `src/content/injector.ts` | Stub only |
| `src/background/worker.ts` | Stub only |

When picking up next session, start by reading this file and `docs/PRD.md`.
