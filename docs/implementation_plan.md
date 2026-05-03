# FlashFill Reliability Updates

The user has highlighted three key UX limitations with the current flow:
1. **Magic Link intrusion**: Currently, when a verification link is found, a new foreground tab is forcefully created. The user wants the original sign-up tab to just "automatically proceed" to the dashboard if possible.
2. **SPA initial detection failures**: On heavily Javascript-driven sites like Reddit, the email field often doesn't exist when the page first loads, causing FlashFill to completely miss it.
3. **Multi-step unreliability**: SPAs often animate inputs fading in (disappearing and appearing). The `tryFillNewFields` only fires once after a DOM mutation, sometimes missing inputs that are technically in the DOM but still `offsetParent === null` due to a fade-in animation.

## Proposed Changes

### 1. `src/background/worker.ts`
Implement "Silent Verification" — with fallback safety:
- Before attempting background verification, detect whether the original tab is actively polling for auth state (via XHR/fetch activity or a known session-check pattern). If no polling is detected, **abort silent verification** and fall back to the original foreground tab behavior. This prevents the silent failure case where sites bind the session token to the tab that clicked the link.
- Change magic link handling to open the tab asynchronously in the background (`active: false`) **only when polling is confirmed**.
- Replace the fixed 15-second self-destruct with a **success-conditional close**: before closing, verify the background tab has navigated to a known success URL pattern (e.g. `/dashboard`, `/home`, `/welcome`). Only then close it. If the success URL is never reached within a configurable timeout (default: 20 seconds), **do not silently close** — surface a visible notification to the user explaining that verification may have failed.
- Log all background tab lifecycle events (created, verified, timed-out, closed) for debuggability.

> **Why these changes matter:** Many sites bind the session cookie with `SameSite=Strict`, meaning the background tab's session never propagates to the foreground tab. Additionally, most magic links are single-use — if the background tab closes before verification completes (e.g. on a slow connection), the link is consumed and the user is locked out with no recourse. The polling check and success-conditional close together prevent this silent failure class.

#### [MODIFY] worker.ts
- Add `isTabPolling(tabId)` helper that inspects recent XHR/fetch activity from the tab.
- Update `pollOnce()` where `otp == null && link != null`:
  - If `isTabPolling()` returns false → fall back to `chrome.tabs.create({ url: link, active: true })` (original behavior).
  - If `isTabPolling()` returns true → call `chrome.tabs.create({ url: link, active: false })`.
- Replace fixed `setTimeout(remove, 15000)` with a URL polling loop that checks `chrome.tabs.get(tabId).url` every 500ms.
- On success URL match → `chrome.tabs.remove(tabId)`.
- On timeout (configurable, default 20s) without success URL → emit a user-visible warning notification instead of silently closing.

---

### 2. `src/content/detector.ts`
Implement "Persistent SPA Detection" — with debouncing and a maximum observation window:
- `detector.ts` currently runs once via `DOMContentLoaded`. Wrap `runInitialDetection` inside a `MutationObserver` that actively watches the entire DOM subtree.
- **Critical fix**: Use `{ childList: true, subtree: true }` — `childList` alone only catches direct children of `document.body`. Email fields in SPAs are almost always injected multiple levels deep; without `subtree: true` the observer fires but finds nothing on the vast majority of real-world sites.
- **Debounce the callback** (~150ms) to prevent `runInitialDetection` from being called hundreds of times per second during heavy SPA route transitions, which would cause significant CPU overhead.
- **Set a maximum observation window** (e.g. 30 seconds): if no email field is found after 30 seconds of observation, `observer.disconnect()` unconditionally to prevent zombie observers persisting on pages that never load an email field.
- On successful payload detection, invoke `observer.disconnect()` immediately as before.

#### [MODIFY] detector.ts
- Add `MutationObserver` with `{ childList: true, subtree: true }`.
- Wrap the observer callback in a debounce utility (150ms).
- Add a `setTimeout(() => observer.disconnect(), 30000)` safety disconnect.
- On successful `announceEmailField` dispatch → call `observer.disconnect()` and clear the safety timeout.

---

### 3. `src/content/injector.ts`
Fix "Fade-in / Animation Misses" — with cascade de-duplication:
- Update the multi-step `MutationObserver` which triggers `tryFillNewFields()`.
- Replace the single `setTimeout(..., 300)` with a staggered retry cascade: `[100ms, 300ms, 600ms, 1200ms]`.
- **Critical fix**: Add a boolean guard flag (`let isFilling = false`) that is set before the cascade starts and cleared after the final attempt completes. If a new DOM mutation fires while a cascade is already in progress, skip queuing a second cascade entirely. This prevents multiple overlapping cascades from running simultaneously (which occurs frequently in SPAs with rapid DOM mutations), avoiding duplicate field fills and redundant event dispatching.
- Verify that `tryFillNewFields` is idempotent (i.e. safe to call multiple times on already-filled fields). If it isn't, add a per-field filled-state check before writing values.

#### [MODIFY] injector.ts
- Add `let isFilling = false` guard above `startFieldWatcher()`.
- Update `startFieldWatcher()` mutation callback:
  - If `isFilling` is true → return early, skip cascade.
  - Set `isFilling = true`.
  - Schedule `tryFillNewFields()` at 100ms, 300ms, 600ms, 1200ms using `setTimeout`.
  - After the 1200ms call completes → set `isFilling = false`.

---

## Error Surfacing Strategy

All three changes previously failed silently. Each now has an explicit failure path:

| Module | Failure Scenario | Response |
|---|---|---|
| `worker.ts` | Polling not detected | Fall back to foreground tab (original behavior) |
| `worker.ts` | Success URL never reached within timeout | Surface visible user notification; do not silently close tab |
| `detector.ts` | No email field found in 30s | Disconnect observer; log warning to console |
| `injector.ts` | All cascade retries fail | Log warning; no duplicate cascade queued |

---

## User Review Required

> [!IMPORTANT]
> **Silent verification fallback behavior**: If the original tab is not detected as polling, the plan falls back to the original foreground tab behavior rather than attempting silent verification. Is this acceptable, or would you prefer a different fallback (e.g. always attempt silent verification regardless)?

> [!IMPORTANT]
> **Success URL matching**: The background tab close is conditional on matching a success URL pattern. This requires maintaining a configurable list of known dashboard URL patterns. Should this list be hardcoded, user-configurable, or inferred dynamically per site?

> [!IMPORTANT]
> **Background tab timeout**: The default timeout before surfacing a warning is 20 seconds (up from the original 15-second silent close). Does this feel right, or should it be shorter/longer?
