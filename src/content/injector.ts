import { deepQuerySelectorAll } from "../shared/dom";
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
const VERIFY_BUTTON_KEYWORDS = ['verify', 'submit', 'confirm', 'continue', 'validate'] as const;
const FIRST_NAME_KEYWORDS = ['first', 'fname', 'given'] as const;
const LAST_NAME_KEYWORDS = ['last', 'lname', 'surname'] as const;
const NAME_KEYWORDS = ['name', 'full_name', 'fullname', 'your name', 'display'] as const;
const USERNAME_KEYWORDS = ['username', 'user_name', 'user-name', 'user name'] as const;
const PASSWORD_KEYWORDS = ['password', 'passwd', 'pass'] as const;
const EMAIL_KEYWORDS = ['email', 'mail', 'user_email', 'e-mail'] as const;
const PHONE_KEYWORDS = ['phone', 'tel', 'mobile', 'cell', 'telephone'] as const;
const TERMS_KEYWORDS = ['terms', 'agree', 'accept', 'conditions', 'privacy', 'policy', 'tos', 'consent', 'i agree', 'i accept'] as const;

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
const TOAST_DEFAULT_MS = 5000;
const TOAST_ANIMATE_MS = 200;

// ---- module state ----

let currentEmailField: HTMLInputElement | null = null;
let submitListenerAttachedFor: HTMLFormElement | null = null;
let hasTriggeredOTPPolling = false;

// Prevents sending REQUEST_IDENTITY twice for the same field reference.
// Reset when a new field is found (SPA navigation / new modal).
let identityRequestedFor: HTMLInputElement | null = null;

/**
 * LOCAL IDENTITY CACHE — the key to multi-step support.
 * We store this in sessionStorage so it survives hard reloads / step navigations!
 */
let cachedIdentity: Identity | null = null;
try {
  const stored = sessionStorage.getItem('flashfill_identity');
  if (stored) cachedIdentity = JSON.parse(stored);
} catch {
  // Ignore
}

function setCachedIdentity(identity: Identity | null): void {
  cachedIdentity = identity;
  if (identity) {
    sessionStorage.setItem('flashfill_identity', JSON.stringify(identity));
  } else {
    sessionStorage.removeItem('flashfill_identity');
  }
}

/**
 * Track which input elements we've already filled to avoid double-filling.
 * Uses a WeakSet so entries are garbage-collected when elements leave the DOM.
 */
// Using `let` so we can swap it out on identity rotation (↻ New).
let filledInputs = new WeakSet<HTMLInputElement>();

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
    const promise = chrome.runtime.sendMessage(message);
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => {}); // Suppress unhandled promise rejections
    }
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
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(el, value);
  } else {
    el.value = value;
  }
}

// ---- ghost fill ----

async function ghostFillSingle(field: HTMLInputElement, value: string): Promise<void> {
  field.focus();
  field.dispatchEvent(new Event('focus', { bubbles: true }));

  // Start from a clean slate.
  setNativeValue(field, '');
  field.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' }));

  let buffer = '';
  for (const char of value) {
    buffer += char;
    field.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));

    // setNativeValue + InputEvent: safe regardless of async scheduling.
    // execCommand is NOT used here — between async delays focus can be stolen
    // and execCommand would type into whatever element currently has focus.
    setNativeValue(field, buffer);
    field.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: char,
    }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
    await wait(randomCharDelay());
  }

  field.dispatchEvent(new Event('blur', { bubbles: true }));
}

/**
 * Gather text from nearby headings and labels to detect context
 * even when the element itself has sparse attributes.
 */
function nearbyTextSignals(scope: Element): string {
  if (!scope || !scope.isConnected) return '';
  const parts: string[] = [];
  
  // Directly associated labels
  if (scope instanceof HTMLInputElement && scope.labels) {
    Array.from(scope.labels).forEach(l => parts.push(normaliseAttr(l.textContent)));
  }

  // Look for text in the parent wrapper
  if (scope.parentElement) {
    const parentText = (scope.parentElement.textContent ?? '').toLowerCase();
    // Only grab it if it's relatively short, to avoid grabbing the whole page
    if (parentText.length < 150) {
      parts.push(parentText);
    }
  }

  return parts.join(' ');
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

  // Phone number
  if (type === 'tel' || includesAny(hay, PHONE_KEYWORDS)) {
    return identity.phone;
  }

  return null;
}

export async function ghostFillForm(
  field: HTMLInputElement | null,
  identity: Identity,
  force = false,
): Promise<boolean> {
  let filledSomething = false;

  // Fill the primary email field if provided and present.
  if (field && field.isConnected && !filledInputs.has(field)) {
    await ghostFillSingle(field, identity.email);
    filledInputs.add(field);
    filledSomething = true;
  }

  // Scan ALL visible inputs on the page for fillable fields.
  // This is intentionally aggressive — we fill anything we recognise.
  const allInputs = Array.from(deepQuerySelectorAll<HTMLInputElement>('input'));

  for (const el of allInputs) {
    if (el === field) continue;             // Already handled above
    if (filledInputs.has(el)) continue;     // Already filled

    // Visibility check that is robust against Shadow DOM.
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    // Skip fields that already have a value UNLESS this is a forced re-fill (rotation).
    if (!force && el.value.trim().length > 0) continue;

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
  const buttons = deepQuerySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"]');
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
 * Returns true if the form looks like a login form (not signup).
 * We skip auto-fill on login forms to avoid confusing users who are trying to log in.
 */
function isLoginForm(field: HTMLInputElement): boolean {
  const form = field.closest('form') ?? document.querySelector('form');
  const scope: ParentNode = form ?? document.body;

  // Check submit button text
  const buttons = Array.from(scope.querySelectorAll<HTMLElement>('button, input[type="submit"], [type="button"]'));
  const submitText = buttons.map(b => (b.textContent ?? '').toLowerCase()).join(' ');
  const LOGIN_BUTTON_KEYWORDS = ['log in', 'login', 'sign in', 'signin'];
  const SIGNUP_BUTTON_KEYWORDS = ['sign up', 'signup', 'register', 'create', 'get started', 'continue', 'next', 'join'];

  const looksLikeLogin = LOGIN_BUTTON_KEYWORDS.some(kw => submitText.includes(kw));
  const looksLikeSignup = SIGNUP_BUTTON_KEYWORDS.some(kw => submitText.includes(kw));

  // If it clearly looks like signup, trust it.
  if (looksLikeSignup) return false;

  // If it clearly looks like login only, skip.
  if (looksLikeLogin && !looksLikeSignup) return true;

  // Check page heading / title for login keywords
  const headings = Array.from(document.querySelectorAll('h1, h2, title'))
    .map(h => (h.textContent ?? '').toLowerCase()).join(' ');
  // Has login heading but no signup heading
  if (LOGIN_BUTTON_KEYWORDS.some(kw => headings.includes(kw)) &&
      !SIGNUP_BUTTON_KEYWORDS.some(kw => headings.includes(kw))) {
    return true;
  }

  return false;
}

function requestIdentityForField(field: HTMLInputElement): void {
  if (identityRequestedFor === field) return;

  // Skip login forms — only auto-fill signup forms.
  if (isLoginForm(field)) {
    console.log('[FlashFill] Skipping login form — not auto-filling.');
    return;
  }

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

  // Detect forced rotation: if a different email arrives, reset all fill guards
  // so the form gets completely re-filled with the new identity.
  const isRotation = cachedIdentity !== null && cachedIdentity.email !== identity.email;
  if (isRotation) {
    console.log('[FlashFill] Identity rotated — resetting fill guards for re-fill.');
    // Replace the WeakSet entirely (WeakSet has no .clear() method).
    filledInputs = new WeakSet<HTMLInputElement>();
    // Also reset field references so the email field is re-detected.
    currentEmailField = null;
    identityRequestedFor = null;
  }

  // CACHE IT — this is the key for multi-step support.
  setCachedIdentity(identity);

  // If we don't have a field reference, try to find it now.
  let field = currentEmailField;
  if (!field || !document.body.contains(field)) {
    field = detectEmailField();
  }

  const filledSomething = await ghostFillForm(field, identity, isRotation);
  console.log('[FlashFill] Ghost-fill complete. Filled:', filledSomething);

  // Auto-tick any "agree to terms" checkboxes.
  autoTickCheckboxes();

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

  const allInputs = Array.from(deepQuerySelectorAll<HTMLInputElement>('input'));
  let filledSomething = false;

  for (const el of allInputs) {
    if (filledInputs.has(el)) continue;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    if (el.value.trim().length > 0) continue;

    const value = classifyInput(el, cachedIdentity);
    if (value) {
      await ghostFillSingle(el, value);
      filledInputs.add(el);
      filledSomething = true;
    }
  }

  const otpFields = findOTPFields();
  if (otpFields.length > 0 && !hasTriggeredOTPPolling) {
    hasTriggeredOTPPolling = true;
    console.log('[FlashFill] OTP field detected during cascade — triggering polling');
    // The worker will reply with POLLING_STARTED anyway, no need for redundant toast here.
    sendToWorker({
      type: 'FORM_SUBMITTED',
      payload: { url: location.href, email: cachedIdentity.email },
    });
  }

  if (filledSomething) {
    console.log('[FlashFill] Multi-step: filled new fields on current page');
    
    // Auto-fill is visibly obvious because the user sees typing. Removed redundant toast.

    // Re-attach button listeners for the new step's buttons.
    attachButtonClickListeners(cachedIdentity);

    // Attach submit listener to any new form.
    const form = document.querySelector('form');
    if (form) attachSubmitListener(form, cachedIdentity.email);

    // Re-check checkboxes on new steps too.
    autoTickCheckboxes();
  }
}

// ---- terms / agreement checkbox auto-tick ----

/**
 * Scan for unchecked checkboxes near "terms", "agree", "accept" text and tick
 * them automatically. Uses .click() to ensure React/Vue event handlers fire.
 */
function autoTickCheckboxes(): void {
  const checkboxes = Array.from(
    deepQuerySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  );

  for (const cb of checkboxes) {
    if (cb.checked) continue; // Already checked.

    // Gather text from nearby DOM elements.
    const labelEl = cb.labels?.[0];
    const labelText = normaliseAttr(labelEl?.textContent ?? '');

    // Also check sibling text, parent text (for frameworks that don't use <label>).
    const parentText = normaliseAttr(cb.parentElement?.textContent ?? '');
    const nearbyText = `${labelText} ${parentText}`;

    // Only tick if nearby text contains terms-like keywords.
    if (includesAny(nearbyText, TERMS_KEYWORDS)) {
      // Use .click() rather than setting .checked directly — this fires
      // synthetic change/input events that React/Vue/Angular listen for.
      cb.click();
      console.log('[FlashFill] Auto-ticked terms checkbox:', cb);
    }
  }
}

let isFilling = false;

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

  const observer = new MutationObserver((mutations) => {
    if (isFilling) return;

    // Check if any new input elements were added.
    let hasNewInputs = false;
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof HTMLInputElement) {
          hasNewInputs = true;
          break;
        }
        if (node instanceof HTMLElement && deepQuerySelectorAll('input', node).length > 0) {
          hasNewInputs = true;
          break;
        }
      }
      if (hasNewInputs) break;
    }

    if (hasNewInputs) {
      isFilling = true;

      // Staggered cascade fill to catch slow-fading SPA inputs
      setTimeout(() => void tryFillNewFields(), 100);
      setTimeout(() => void tryFillNewFields(), 300);
      setTimeout(() => void tryFillNewFields(), 600);
      setTimeout(() => {
        tryFillNewFields().finally(() => {
          isFilling = false;
        });
      }, 1200);

      // Also check if OTP fields just appeared — if so, start polling.
      setTimeout(() => {
        if (!cachedIdentity || hasTriggeredOTPPolling) return;
        const otpFields = findOTPFields();
        if (otpFields.length > 0) {
          hasTriggeredOTPPolling = true;
          console.log('[FlashFill] OTP field detected in DOM — triggering polling');
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
  const allInputs = Array.from(deepQuerySelectorAll<HTMLInputElement>('input'));

  // Strategy A: Look for a sequence of single-character inputs.
  const inputGroups: HTMLInputElement[][] = [];
  let currentGroup: HTMLInputElement[] = [];

  for (const input of allInputs) {
    const type = normaliseAttr(input.getAttribute('type'));
    const isTextLike = ['', 'text', 'number', 'tel'].includes(type);
    const isSingleChar =
      input.getAttribute('maxlength') === '1' ||
      (input.offsetWidth > 0 && input.offsetWidth < 60 && input.offsetHeight > 0);

    if (isTextLike && isSingleChar && input.isConnected) {
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
    const isTextLike = ['', 'text', 'number', 'tel'].includes(type);

    const maxlength = input.getAttribute('maxlength');
    const maxlengthMatch = maxlength === '4' || maxlength === '6' || maxlength === '8';
    
    // Check both standard attributes and nearby DOM text (for React SPAs using floating labels)
    const haystack = attrHaystack(input) + ' ' + nearbyTextSignals(input);
    const keywordMatch = includesAny(haystack, OTP_FIELD_KEYWORDS);

    // If keywords match explicitly (e.g., 'verification_code'), trust it regardless of type
    // Otherwise, if it's text-like and has an OTP-like max length, assume it's the code.
    if (keywordMatch || (isTextLike && maxlengthMatch)) {
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

/**
 * Fills an OTP field reliably across React, Vue, Angular and vanilla inputs.
 *
 * document.execCommand('insertText') fires a TRUSTED InputEvent through the
 * browser's native text-insertion pipeline (isTrusted=true). This is the same
 * mechanism Playwright/Selenium use — all SPA frameworks' event systems pick it
 * up and update their internal state. Non-trusted synthetic events get processed
 * but then state re-renders wipe the value in controlled inputs.
 */
async function fillOTPAtOnce(field: HTMLInputElement, code: string): Promise<void> {
  field.focus();
  field.dispatchEvent(new FocusEvent('focus', { bubbles: true }));

  // Select all so execCommand replaces any existing content.
  field.select();

  // Primary: trusted native insertion — React/Vue/Angular always react to this.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const inserted = document.execCommand('insertText', false, code);

  if (!inserted) {
    // execCommand blocked (some sandboxed iframes / strict CSP) — use setter approach.
    setNativeValue(field, code);
    field.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: code,
    }));
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  await wait(80);
  field.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
}

async function handleOTPFound(code: string, link?: string | null): Promise<void> {
  // If it's a magic link ONLY, the worker already opened it. Just notify.
  if (code === 'Verifying...') {
    showToast('Magic link detected! Silently tracking verification in background...');
    return;
  }

  const fields = await waitForOTPFields();
  if (fields.length === 0) {
    if (link) {
      showToast('No OTP field found, opening verification link...');
      chrome.runtime.sendMessage({ type: 'OPEN_TAB', payload: { url: link } }).catch(() => {});
      return;
    }
    showToast('OTP received but no input field found');
    return;
  }

  if (fields.length === 1) {
    // Standard single field — use atomic fill so React state sticks.
    await fillOTPAtOnce(fields[0]!, code);
  } else {
    // Segmented fields (one box per digit) — still type char by char.
    for (let i = 0; i < fields.length && i < code.length; i++) {
      await fillOTPAtOnce(fields[i]!, code[i]!);
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
  
  Object.assign(toast.style, {
    background: '#000000',
    color: '#eaff00',
    padding: '10px 14px',
    borderRadius: '0px',
    fontFamily: '"Space Grotesk", "Inter", -apple-system, sans-serif',
    fontSize: '13px',
    fontWeight: '700',
    lineHeight: '1.4',
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    border: '2.5px solid #000000',
    boxShadow: '4px 4px 0px #000000',
    opacity: '0',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    transform: 'translateY(-8px)',
    transition: `all ${TOAST_ANIMATE_MS}ms ease`,
    pointerEvents: 'auto',
    maxWidth: '300px',
    wordBreak: 'break-word',
  } satisfies Partial<CSSStyleDeclaration>);

  toast.innerHTML = `
    <div style="flex-shrink:0; width:8px; height:8px; background:#eaff00; border:1.5px solid #eaff00"></div>
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

// ---- frame guard ----
// With all_frames:true, this script runs in every iframe on the page.
// Sub-frames should ONLY handle IDENTITY_READY (to fill forms inside iframes).
// Navigation, OTP handling, RESUME_SESSION, and toasts must be
// exclusive to the main (top-level) frame to prevent duplicate tab openings.
const isMainFrame = window === window.top;

if (isMainFrame) {
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
}

document.addEventListener(EMAIL_FIELD_FOUND_EVENT, handleEmailFieldFound);

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: WorkerToContentMessage) => {
    switch (message.type) {
      case 'IDENTITY_READY':
        // Allowed in ALL frames — iframes may contain signup forms.
        void handleIdentityReady(message.payload.identity);
        break;
      case 'OTP_FOUND':
        // Main frame only — prevents N iframes opening N tabs.
        if (!isMainFrame) break;
        void handleOTPFound(message.payload.code, message.payload.link);
        break;
      case 'SHOW_TOAST':
        if (!isMainFrame) break;
        showToast(message.payload.message, 4000);
        break;
      case 'OTP_TIMEOUT':
        if (!isMainFrame) break;
        showToast('OTP timeout — email never arrived');
        break;
      case 'POLLING_STARTED':
        if (!isMainFrame) break;
        showToast('FlashFill: Waiting for verification email... (up to 90s)');
        break;
      case 'DOMAIN_REJECTED':
        if (!isMainFrame) break;
        showToast(`Domain rejected (${message.payload.triedDomain}) — rotating`);
        break;
    }
  });
}

// Automatically resume the field watcher if we woke up with a cached identity.
if (cachedIdentity) {
  console.log('[FlashFill] Resuming from session storage:', cachedIdentity.email);
  startFieldWatcher();

  // Immediately do a scan for post-navigation fields.
  setTimeout(() => void tryFillNewFields(), 1500);
}
