/*
 * IDENTITY INJECTOR — Content Script
 *
 * Responsibilities:
 * - Listen for 'flashfill:emailFieldFound' → request an identity from the
 *   service worker (REQUEST_IDENTITY).
 * - On IDENTITY_READY from the service worker → ghost-fill the email field
 *   and any related name / username fields in the same form.
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
const USERNAME_KEYWORDS = ['username', 'user_name', 'user-name'] as const;
const PASSWORD_KEYWORDS = ['password', 'passwd', 'pass'] as const;

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

export async function ghostFillForm(
  field: HTMLInputElement,
  identity: Identity,
): Promise<void> {
  if (!document.body.contains(field)) return;

  await ghostFillSingle(field, identity.email);

  // Look in the parent form, or fall back to a logical container for SPAs.
  const container: Element | null =
    field.closest('form') ??
    field.closest<Element>('[role="form"], section, [data-testid], main, .card, .modal, [class*="form"]');
  if (!container) return;

  const siblings = Array.from(container.querySelectorAll<HTMLInputElement>('input')).filter(
    (el) => el !== field,
  );

  for (const el of siblings) {
    const type = normaliseAttr(el.getAttribute('type'));
    if (NON_TEXT_INPUT_TYPES.includes(type)) continue;
    if (el.value.trim().length > 0) continue;

    const hay = attrHaystack(el);

    if (type === 'password' || includesAny(hay, PASSWORD_KEYWORDS)) {
      // Always fill password fields with the generated password.
      await ghostFillSingle(el, identity.password);
    } else if (includesAny(hay, FIRST_NAME_KEYWORDS)) {
      await ghostFillSingle(el, identity.firstName);
    } else if (includesAny(hay, LAST_NAME_KEYWORDS)) {
      await ghostFillSingle(el, identity.lastName);
    } else if (includesAny(hay, USERNAME_KEYWORDS)) {
      await ghostFillSingle(el, identity.username);
    } else if (includesAny(hay, NAME_KEYWORDS)) {
      // Generic "name" field — use full name.
      await ghostFillSingle(el, identity.fullName);
    }
  }
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
  const field = currentEmailField;
  if (!field || !document.body.contains(field)) {
    console.warn('[FlashFill] Email field gone from DOM, cannot fill.');
    return;
  }

  await ghostFillForm(field, identity);
  console.log('[FlashFill] Ghost-fill complete.');

  const form = field.closest('form');
  if (form) attachSubmitListener(form, identity.email);
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

async function handleOTPFound(code: string): Promise<void> {
  const fields = await waitForOTPFields();
  if (fields.length === 0) {
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
  if (field && !field.value.trim()) {
    requestIdentityForField(field);
  }
}, 0);

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: WorkerToContentMessage) => {
    switch (message.type) {
      case 'IDENTITY_READY':
        void handleIdentityReady(message.payload.identity);
        break;
      case 'OTP_FOUND':
        void handleOTPFound(message.payload.code);
        break;
      case 'OTP_TIMEOUT':
        showToast('OTP timeout — check your inbox manually');
        break;
      case 'DOMAIN_REJECTED':
        showToast(`Domain rejected (${message.payload.triedDomain}) — rotating`);
        break;
    }
  });
}
