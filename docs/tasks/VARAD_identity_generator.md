# Task for Varad — Identity Generator

Welcome! This is your first task on FlashFill. Everything you need is in this
file. Before writing any code, please read:

1. `CLAUDE.md` at the project root — 2 minutes. Tells you what this project is
   and the rules you must follow.
2. `src/shared/types.ts` — 1 minute. The `Identity` type you'll return.

You don't need to read the PRD for this task.

---

## What You're Building

A single file: **`src/shared/identity.ts`**

It exports one function:

```ts
export function generateIdentity(email: string): Identity
```

- **Input**: an email string (this will come from Tempmail later — just accept
  whatever string is passed in).
- **Output**: an `Identity` object (the type is already defined in
  `src/shared/types.ts` — import it, don't redefine it).

The returned `Identity` must contain:

| Field | How to fill it |
|---|---|
| `email` | The exact string that was passed in |
| `firstName` | A realistic first name from Faker |
| `lastName` | A realistic last name from Faker |
| `username` | A realistic username from Faker |

That's it. No side effects, no `console.log`, no network, no `chrome.*` calls.

---

## How to Use Faker

Faker is already installed. Import it like this:

```ts
import { faker } from '@faker-js/faker';
```

The three Faker calls you need:

- `faker.person.firstName()`
- `faker.person.lastName()`
- `faker.internet.username()`

> Older tutorials say `faker.internet.userName()` (capital N). That function
> was renamed in Faker v8. Use `username()` (all lowercase). If TypeScript
> complains, that's the fix.

---

## Rules — Non-Negotiable

These come from `CLAUDE.md`. Please re-read them there too:

1. **TypeScript only.** No `.js` files.
2. **No `any` type.** If you're stuck, ask — don't reach for `any`.
3. **Do not install new packages.** Faker is the only dependency you need.
4. **Do not modify any file outside `src/shared/identity.ts`.** If you think
   you need to, stop and ask Rushil first.
5. **Do not call `chrome.storage.*` directly.** This task doesn't need storage
   at all, but the rule applies everywhere in the codebase.
6. **Commit to this branch only.** Branch name: `feat/identity-generator`.
   Never push to `main`. Never push to `dev`.

---

## Setup Steps

Run these once after cloning the repo:

```bash
cd flashfill
git fetch origin
git checkout feat/identity-generator
npm install
```

Sanity-check the build works before you touch anything:

```bash
npm run build
```

If that finishes without errors, you're ready.

---

## Done-Definition Checklist

Before you open a PR, every one of these must be true:

- [ ] File exists at `src/shared/identity.ts`.
- [ ] It imports `Identity` from `./types` (relative path, not absolute).
- [ ] It imports `faker` from `@faker-js/faker`.
- [ ] It exports exactly one function: `generateIdentity`.
- [ ] Return type is explicitly annotated as `Identity` (not inferred).
- [ ] `npm run build` completes with zero errors.
- [ ] You did not change any file other than creating this one.

---

## How to Open the PR

```bash
git add src/shared/identity.ts
git commit -m "feat: implement generateIdentity with Faker"
git push origin feat/identity-generator
```

Then on GitHub:

1. Go to the repo.
2. Click "Compare & pull request".
3. **Base branch: `dev`** — NOT `main`. This is critical.
4. Title: `feat: identity generator`
5. Body: a one-line description is fine.
6. Submit. Rushil will review.

---

## If You Get Stuck

- TypeScript error you can't explain → paste the full error message to Rushil.
- Not sure about a rule → default to the stricter interpretation, then ask.
- Tempted to change a file outside `src/shared/identity.ts` → stop, ask first.

You've got this.
