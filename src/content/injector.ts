/*
 * IDENTITY INJECTOR — Content Script
 *
 * Responsibilities:
 * - Listen for 'flashfill:emailFieldFound' → request an identity from the
 *   service worker (REQUEST_IDENTITY).
 * - On IDENTITY_READY from the service worker → ghost-fill the email field
 *   and any related name / username fields in the same form.
 * - CACHE the identity locally so multi-step flows (Step 2, 3, etc.) can
 *   be filled INSTANTLY via MutationObserver without a worker round-trip.
 * - Hook the form's submit event after filling → send FORM_SUBMITTED.
 * - On OTP_FOUND from the service worker → locate the OTP field (retry up
 *   to 5s), ghost-fill it, click the verify button, and toast success.
 * - Provide a toast notification helper for user feedback.
 *
 * Exports (for testing / reuse):
 *   - ghostFillForm(field, identity)
 *   - showToast(message, duration?)
 *   - findOTPField()
 */

import type { Identity } from '../shared/types';
import type { ContentToWorkerMessage, WorkerToContentMessage } from '../shared/messages';
import type { EmailFieldFoundDetail } from './detector';
import { detectEmailField } from './detector';

// ---- constants ----

const EMAIL_FIELD_FOUND_EVENT = 'flashfill:emailFieldFound';

const OTP_FIELD_KEYWORDS = ['otp', 'code', 'verify', 'verification'] as const;
const VERIFY_BUTTON_KEYWORDS = ['verify', 'submit', 'confirm', 'continue'] as const;
const FIRST_NAME_KEYWORDS = ['first', 'fname', 'given'] as const;
const LAST_NAME_KEYWORDS = ['last', 'lname', 'surname'] as const;
const NAME_KEYWORDS = ['name', 'full_name', 'fullname', 'your name', 'display'] as const;
const USERNAME_KEYWORDS = ['username', 'user_name', 'user-name', 'user name'] as const;
const PASSWORD_KEYWORDS = ['password', 'passwd', 'pass'] as const;
const EMAIL_KEYWORDS = ['email', 'mail', 'user_email', 'e-mail'] as const;

const NON_TEXT_INPUT_TYPES = [
  'checkbox',
  'radio',
  'hidden',
  'submit',
  'button',
  'file',
  'image',
  'reset',
];

const MIN_CHAR_DELAY_MS = 50;
const MAX_CHAR_DELAY_MS = 100;
const OTP_RETRY_INTERVAL_MS = 250;
const OTP_RETRY_WINDOW_MS = 5000;
const TOAST_DEFAULT_MS = 3000;
const TOAST_ANIMATE_MS = 200;

// ---- module state ----

let currentEmailField: HTMLInputElement | null = null;
let submitListenerAttachedFor: HTMLFormElement | null = null;

// Prevents sending REQUEST_IDENTITY twice for the same field reference.
// Reset when a new field is found (SPA navigation / new modal).
let identityRequestedFor: HTMLInputElement | null = null;

/**
 * LOCAL IDENTITY CACHE — the key to multi-step support.
 * Once we receive an identity from the worker, we store it here.
 * When new fields appear (Step 2, 3, etc.), we use this cached identity
 * to fill them instantly without any worker round-trip.
 */
let cachedIdentity: Identity | null = null;

/**
 * Track which input elements we've already filled to avoid double-filling.
 * Uses a WeakSet so entries are garbage-collected when elements leave the DOM.
 */
const filledInputs = new WeakSet<HTMLInputElement>();

// ---- small helpers ----

function randomCharDelay(): number {
  return MIN_CHAR_DELAY_MS + Math.random() * (MAX_CHAR_DELAY_MS - MIN_CHAR_DELAY_MS);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendToWorker(message: ContentToWorkerMessage): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;
  try {
    chrome.runtime.sendMessage(message);
  } catch {
    // Silent failure — extension reload or context invalidated.
  }
}

function normaliseAttr(value: string | null): string {
  return (value ?? '').toLowerCase();
}

function attrHaystack(input: HTMLInputElement): string {
  return [
    input.getAttribute('name'),
    input.getAttribute('id'),
    input.getAttribute('placeholder'),
    input.getAttribute('aria-label'),
  ]
    .map(normaliseAttr)
    .join(' ');
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/**
 * React and other SPA frameworks override the native value setter on input
 * elements. Using the prototype descriptor's setter ensures framework state
 * (not just the DOM) picks up the change when we dispatch 'input'.
 */
function setNativeValue(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as object;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  const setter = descriptor?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
}

// ---- ghost fill ----

async function ghostFillSingle(field: HTMLInputElement, value: string): Promise<void> {
  field.focus();

  // Start from a clean slate so repeated fills don't concatenate.
  setNativeValue(field, '');
  field.dispatchEvent(new Event('input', { bubbles: true }));

  let buffer = '';
  for (const char of value) {
    buffer += char;
    setNativeValue(field, buffer);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(randomCharDelay());
  }

  field.dispatchEvent(new Event('blur', { bubbles: true }));
}

/**
 * Classify an input and return the value it should be filled with,
 * or null if it's not a field we recognise.
 */
function classifyInput(el: HTMLInputElement, identity: Identity): string | null {
  const type = normaliseAttr(el.getAttribute('type'));
  if (NON_TEXT_INPUT_TYPES.includes(type)) return null;

  const hay = attrHaystack(el);

  // Email field
  if (type === 'email' || includesAny(hay, EMAIL_KEYWORDS)) {
    return identity.email;
  }

  // Password fields (including "confirm password")
  if (type === 'password' || includesAny(hay, PASSWORD_KEYWORDS)) {
    return identity.password;
  }

  // Username
  if (includesAny(hay, USERNAME_KEYWORDS)) {
    return identity.username;
  }

  // First name
  if (includesAny(hay, FIRST_NAME_KEYWORDS)) {
    return identity.firstName;
  }

  // Last name
  if (includesAny(hay, LAST_NAME_KEYWORDS)) {
    return identity.lastName;
  }

  // Generic name
  if (includesAny(hay, NAME_KEYWORDS)) {
    return identity.fullName;
  }

  return null;
}

export async function ghostFillForm(
  field: HTMLInputElement | null,
  identity: Identity,
): Promise<boolean> {
  let filledSomething = false;

  // Fill the primary email field if provided and present.
  if (field && document.body.contains(field) && !filledInputs.has(field)) {
    await ghostFillSingle(field, identity.email);
    filledInputs.add(field);
    filledSomething = true;
  }

  // Scan ALL visible inputs on the page for fillable fields.
  // This is intentionally aggressive — we fill anything we recognise.
  const allInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));

  for (const el of allInputs) {
    if (el === field) continue;             // Already handled above
    if (filledInputs.has(el)) continue;     // Already filled
    if (el.offsetParent === null) continue;  // Not visible
    if (el.value.trim().length > 0) continue; // Already has a value

    const value = classifyInput(el, identity);
    if (value) {
      await ghostFillSingle(el, value);
      filledInputs.add(el);
      filledSomething = true;
    }
  }

  return filledSomething;
}

// ---- submit wiring ----

function attachSubmitListener(form: HTMLFormElement, email: string): void {
  if (submitListenerAttachedFor === form) return;
  submitListenerAttachedFor = form;

  form.addEventListener(
    'submit',
    () => {
      sendToWorker({
        type: 'FORM_SUBMITTED',
        payload: { url: location.href, email },
      });
    },
    { once: true },
  );
}

/**
 * Also intercept button clicks that might submit multi-step forms
 * without a real form submit event (common in React SPAs).
 */
/**
 * Intercept button clicks to:
 * 1. Schedule fill retries for next-step forms that appear after click
 * 2. Send FORM_SUBMITTED ONLY when the FINAL step button is clicked
 *    (i.e., when no new form fields appear after the click).
 *    This prevents starting OTP polling too early.
 */
function attachButtonClickListeners(identity: Identity): void {
  const buttons = document.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"]');
  for (const btn of Array.from(buttons)) {
    const text = (btn.textContent ?? '').toLowerCase();
    const submitKeywords = ['next', 'continue', 'create', 'sign up', 'signup', 'register', 'submit', 'join'];
    if (submitKeywords.some(kw => text.includes(kw))) {
      btn.addEventListener('click', () => {
        const isLikelyFinalStep = ['create', 'sign up', 'signup', 'register', 'submit', 'join'].some(kw => text.includes(kw));

        // Always try to fill any new fields that load after click.
        setTimeout(() => void tryFillNewFields(), 500);
        setTimeout(() => void tryFillNewFields(), 1000);
        setTimeout(() => void tryFillNewFields(), 2000);

        if (isLikelyFinalStep) {
          // Wait a bit — if we filled more fields, it wasn't the final step.
          // If we didn't fill anything new, it IS the final step → start polling.
          setTimeout(() => {
            console.log('[FlashFill] Final step detected — starting OTP polling');
            sendToWorker({
              type: 'FORM_SUBMITTED',
              payload: { url: location.href, email: identity.email },
            });
          }, 2500);
        }
      }, { once: true });
    }
  }
}

// ---- email flow entrypoints ----

/**
 * Central place to request an identity for a detected field.
 * Guards against double-requesting for the same element (can happen when both
 * the startup scan and the event listener fire for the same field).
 */
function requestIdentityForField(field: HTMLInputElement): void {
  if (identityRequestedFor === field) return;
  identityRequestedFor = field;
  currentEmailField = field;
  console.log('[FlashFill] Requesting identity for field:', field);
  sendToWorker({ type: 'REQUEST_IDENTITY', payload: { url: location.href } });
}

function handleEmailFieldFound(event: Event): void {
  const detail = (event as CustomEvent<EmailFieldFoundDetail>).detail;
  if (!detail?.field) return;
  requestIdentityForField(detail.field);
}

async function handleIdentityReady(identity: Identity): Promise<void> {
  console.log('[FlashFill] IDENTITY_READY received:', identity);

  // CACHE IT — this is the key for multi-step support.
  cachedIdentity = identity;

  // If we don't have a field reference, try to find it now.
  let field = currentEmailField;
  if (!field || !document.body.contains(field)) {
    field = detectEmailField();
  }

  const filledSomething = await ghostFillForm(field, identity);
  console.log('[FlashFill] Ghost-fill complete. Filled:', filledSomething);

  // Attach both form submit and button click listeners.
  const form = field?.closest('form') ?? document.querySelector('form');
  if (form) attachSubmitListener(form, identity.email);
  attachButtonClickListeners(identity);

  // Start watching for new fields (Step 2, 3, etc.)
  startFieldWatcher();
}

// ---- MULTI-STEP FIELD WATCHER ----

let fieldWatcherRunning = false;

/**
 * Try to fill any new unfilled fields on the page using the cached identity.
 * This is called by the MutationObserver and scheduled retries.
 */
async function tryFillNewFields(): Promise<void> {
  if (!cachedIdentity) return;

  const allInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
  let filledSomething = false;

  for (const el of allInputs) {
    if (filledInputs.has(el)) continue;
    if (el.offsetParent === null) continue;
    if (el.value.trim().length > 0) continue;

    const value = classifyInput(el, cachedIdentity);
    if (value) {
      await ghostFillSingle(el, value);
      filledInputs.add(el);
      filledSomething = true;
    }
  }

  if (filledSomething) {
    console.log('[FlashFill] Multi-step: filled new fields on current page');
    showToast('FlashFill: Filled next step!');

    // Re-attach button listeners for the new step's buttons.
    attachButtonClickListeners(cachedIdentity);

    // Attach submit listener to any new form.
    const form = document.querySelector('form');
    if (form) attachSubmitListener(form, cachedIdentity.email);
  }
}

/**
 * Start a MutationObserver that watches for new input elements appearing
 * in the DOM. When detected, try to fill them with the cached identity.
 * This handles Step 2, 3, etc. of multi-step signup flows INSTANTLY.
 * Also watches for OTP input patterns appearing, triggering email polling.
 */
function startFieldWatcher(): void {
  if (fieldWatcherRunning) return;
  fieldWatcherRunning = true;

  console.log('[FlashFill] Field watcher started — watching for multi-step forms');

let otpPollingTriggered = false;

  const observer = new MutationObserver((mutations) => {
    // Check if any new input elements were added.
    let hasNewInputs = false;
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof HTMLInputElement) {
          hasNewInputs = true;
          break;
        }
        if (node instanceof HTMLElement && node.querySelector('input')) {
          hasNewInputs = true;
          break;
        }
      }
      if (hasNewInputs) break;
    }

    if (hasNewInputs) {
      // Small delay to let the SPA framework finish rendering.
      setTimeout(() => void tryFillNewFields(), 300);

      // Also check if OTP fields just appeared — if so, start polling.
      setTimeout(() => {
        if (!cachedIdentity || otpPollingTriggered) return;
        const otpFields = findOTPFields();
        if (otpFields.length > 0) {
          otpPollingTriggered = true;
          console.log('[FlashFill] OTP field detected in DOM — triggering polling');
          showToast('FlashFill: Verification code requested — checking inbox...');
          sendToWorker({
            type: 'FORM_SUBMITTED',
            payload: { url: location.href, email: cachedIdentity.email },
          });
        }
      }, 600);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ---- OTP ----

/**
 * Locates the OTP input field. Supports:
 * 1. Single input (maxlength=6, placeholder="Code", etc.)
 * 2. Segmented inputs (a sequence of 4-8 single-digit inputs)
 */
export function findOTPFields(): HTMLInputElement[] {
  const allInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));

  // Strategy A: Look for a sequence of single-character inputs.
  const inputGroups: HTMLInputElement[][] = [];
  let currentGroup: HTMLInputElement[] = [];

  for (const input of allInputs) {
    const type = normaliseAttr(input.getAttribute('type'));
    const isTextLike = ['', 'text', 'number', 'tel'].includes(type);
    const isSingleChar =
      input.getAttribute('maxlength') === '1' ||
      (input.offsetWidth > 0 && input.offsetWidth < 60 && input.offsetHeight > 0);

    if (isTextLike && isSingleChar && input.offsetParent !== null) {
      currentGroup.push(input);
    } else {
      if (currentGroup.length >= 4 && currentGroup.length <= 8) {
        inputGroups.push(currentGroup);
      }
      currentGroup = [];
    }
  }
  if (currentGroup.length >= 4 && currentGroup.length <= 8) {
    inputGroups.push(currentGroup);
  }

  // If we found a group of 4-8 small inputs, it's likely a segmented OTP.
  if (inputGroups.length > 0) {
    // Pick the group that is most "centered" or just the first one found.
    return inputGroups[0]!;
  }

  // Strategy B: Look for a single obvious OTP input.
  for (const input of allInputs) {
    const type = normaliseAttr(input.getAttribute('type'));
    if (!['', 'text', 'number', 'tel'].includes(type)) continue;

    const maxlength = input.getAttribute('maxlength');
    const maxlengthMatch = maxlength === '4' || maxlength === '6' || maxlength === '8';
    const keywordMatch = includesAny(attrHaystack(input), OTP_FIELD_KEYWORDS);

    if (maxlengthMatch || keywordMatch) {
      return [input];
    }
  }

  return [];
}

function findVerifyButton(scope: ParentNode): HTMLElement | null {
  const candidates = Array.from(
    scope.querySelectorAll<HTMLElement>('button, input[type="submit"], [role="button"]'),
  );

  for (const el of candidates) {
    const text = (el.textContent ?? '').toLowerCase();
    const value = normaliseAttr(el.getAttribute('value'));
    const aria = normaliseAttr(el.getAttribute('aria-label'));
    const haystack = `${text} ${value} ${aria}`;

    if (VERIFY_BUTTON_KEYWORDS.some((kw) => haystack.includes(kw))) {
      return el;
    }
  }

  return null;
}

async function waitForOTPFields(): Promise<HTMLInputElement[]> {
  const deadline = Date.now() + OTP_RETRY_WINDOW_MS;
  while (Date.now() < deadline) {
    const fields = findOTPFields();
    if (fields.length > 0) return fields;
    await wait(OTP_RETRY_INTERVAL_MS);
  }
  return [];
}

async function handleOTPFound(code: string, link?: string | null): Promise<void> {
  // If it's a magic link ONLY, the worker already opened it. Just notify.
  if (code === 'Magic Link') {
    showToast('Magic link detected & opened!');
    return;
  }

  const fields = await waitForOTPFields();
  if (fields.length === 0) {
    if (link) {
      showToast('No OTP field found, opening verification link...');
      chrome.runtime.sendMessage({ type: 'OPEN_TAB', payload: { url: link } });
      return;
    }
    showToast('OTP received but no input field found');
    return;
  }

  if (fields.length === 1) {
    // Standard single field.
    await ghostFillSingle(fields[0]!, code);
  } else {
    // Segmented fields.
    for (let i = 0; i < fields.length && i < code.length; i++) {
      await ghostFillSingle(fields[i]!, code[i]!);
    }
  }

  const primaryField = fields[0]!;
  const form = primaryField.closest('form');
  const button = findVerifyButton(form ?? document);
  button?.click();

  showToast(`OTP ${code} injected successfully`);
}

// ---- toast ----

let toastContainer: HTMLDivElement | null = null;

function ensureToastContainer(): HTMLDivElement {
  if (toastContainer && document.body.contains(toastContainer)) {
    return toastContainer;
  }

  const container = document.createElement('div');
  container.setAttribute('data-flashfill-toasts', 'true');
  Object.assign(container.style, {
    position: 'fixed',
    top: '16px',
    right: '16px',
    zIndex: '2147483647',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(container);
  toastContainer = container;
  return container;
}

export function showToast(message: string, duration: number = TOAST_DEFAULT_MS): void {
  if (!document.body) return;

  const container = ensureToastContainer();
  const toast = document.createElement('div');
  
  // Premium, state-of-the-art glassmorphism design
  Object.assign(toast.style, {
    background: 'rgba(18, 18, 18, 0.8)',
    backdropFilter: 'blur(12px) saturate(180%)',
    // @ts-expect-error vendor prefix not in CSSStyleDeclaration type
    WebkitBackdropFilter: 'blur(12px) saturate(180%)',
    color: '#ffffff',
    padding: '12px 18px',
    borderRadius: '12px',
    fontFamily: '"Outfit", "Inter", -apple-system, sans-serif',
    fontSize: '14px',
    fontWeight: '500',
    lineHeight: '1.5',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), inset 0 0 0 1px rgba(255, 255, 255, 0.1)',
    opacity: '0',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    transform: 'translateY(-10px) scale(0.95)',
    transition: `all ${TOAST_ANIMATE_MS}ms cubic-bezier(0.23, 1, 0.32, 1)`,
    pointerEvents: 'auto',
    maxWidth: '320px',
    wordBreak: 'break-word',
    borderLeft: '4px solid #3d5afe', // Vibrant Indigo accent
  } satisfies Partial<CSSStyleDeclaration>);

  // Content with icon-like hint
  toast.innerHTML = `
    <div style="flex-shrink:0; width:8px; height:8px; background:#3d5afe; border-radius:50%; box-shadow:0 0 8px #3d5afe"></div>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  // Next frame: trigger the enter transition.
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0) scale(1)';
  });

  window.setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px) scale(0.95)';
    window.setTimeout(() => {
      toast.remove();
    }, TOAST_ANIMATE_MS + 50);
  }, duration);
}

// ---- wiring ----

document.addEventListener(EMAIL_FIELD_FOUND_EVENT, handleEmailFieldFound);

// Startup self-check — fixes the CRXJS async-module race condition where
// detector.ts fires 'flashfill:emailFieldFound' before injector.ts has
// registered its listener. On load we scan the DOM directly so we never
// depend on catching an event that may have already fired.
setTimeout(() => {
  const field = detectEmailField();
  console.log('[FlashFill] Startup self-check — detected field:', field);
  
  // Primary flow: we found an email field, request identity.
  if (field && !field.value.trim()) {
    requestIdentityForField(field);
  } else {
    // Secondary flow: maybe we are on Step 2 of a signup? Ask worker to resume.
    sendToWorker({ type: 'RESUME_SESSION', payload: { url: location.href } });
  }
}, 0);

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: WorkerToContentMessage) => {
    switch (message.type) {
      case 'IDENTITY_READY':
        void handleIdentityReady(message.payload.identity);
        break;
      case 'OTP_FOUND':
        void handleOTPFound(message.payload.code, message.payload.link);
        break;
      case 'OTP_TIMEOUT':
        showToast('OTP timeout — email never arrived');
        break;
      case 'POLLING_STARTED':
        showToast('FlashFill: Waiting for verification email... (up to 90s)');
        break;
      case 'DOMAIN_REJECTED':
        showToast(`Domain rejected (${message.payload.triedDomain}) — rotating`);
        break;
    }
  });
}
