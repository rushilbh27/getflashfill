# Contributing to FlashFill

Thanks for your interest in contributing. Here's everything you need to get started.

---

## Setup

```bash
git clone https://github.com/rushilbh27/getflashfill.git
cd getflashfill
npm install
```

For development with hot reload:
```bash
npm run dev
```

For production build:
```bash
npm run build
```

Load `dist/` as an unpacked extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked).

---

## Project Rules

- **TypeScript only** — no `.js` files
- **No UI frameworks** — vanilla DOM, no React/Vue
- **Vite 4 pinned** — do not upgrade to Vite 5 (CRXJS compatibility)
- **Use `src/shared/storage.ts`** — never call `chrome.storage.*` directly elsewhere
- **Use message types from `src/shared/messages.ts`** — no raw string `type` fields

---

## Workflow

1. Fork the repo
2. Create a branch: `git checkout -b feat/your-feature`
3. Make changes — keep PRs focused and small
4. Commit with a clear message (see commit style below)
5. Open a Pull Request against `main`

---

## Commit Style

```
type(scope): short description

feat(popup): add dark mode toggle
fix(injector): handle null email field on SPA navigation
refactor(worker): extract polling into separate manager
docs: update README setup instructions
```

Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`

---

## Code Style

- No comments unless the *why* is non-obvious
- No unused variables or imports
- Keep functions small and single-purpose
- Match the existing naming conventions

---

## Where Things Live

| What | Where |
|---|---|
| External API calls | `src/background/` only |
| DOM manipulation | `src/content/` only |
| Shared types | `src/shared/types.ts` |
| Message contract | `src/shared/messages.ts` |
| Storage reads/writes | `src/shared/storage.ts` |

---

## Reporting Issues

Open a [GitHub Issue](https://github.com/rushilbh27/getflashfill/issues) with:
- Steps to reproduce
- Expected vs actual behaviour
- Browser version + OS
