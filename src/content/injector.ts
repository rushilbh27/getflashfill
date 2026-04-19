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
const USERNAME_KEYWORDS = ['username', 'user_name'] as const;

const NON_TEXT_INPUT_TYPES = [
  'password',
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

  const form = field.closest('form');
  if (!form) return;

  const siblings = Array.from(form.querySelectorAll<HTMLInputElement>('input')).filter(
    (el) => el !== field,
  );

  for (const el of siblings) {
    const type = normaliseAttr(el.getAttribute('type'));
    if (NON_TEXT_INPUT_TYPES.includes(type)) continue;
    if (el.value.trim().length > 0) continue;

    const hay = attrHaystack(el);

    if (includesAny(hay, FIRST_NAME_KEYWORDS)) {
      await ghostFillSingle(el, identity.firstName);
    } else if (includesAny(hay, LAST_NAME_KEYWORDS)) {
      await ghostFillSingle(el, identity.lastName);
    } else if (includesAny(hay, USERNAME_KEYWORDS)) {
      await ghostFillSingle(el, identity.username);
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
  sendToWorker({ type: 'REQUEST_IDENTITY', payload: { url: location.href } });
}

function handleEmailFieldFound(event: Event): void {
  const detail = (event as CustomEvent<EmailFieldFoundDetail>).detail;
  if (!detail?.field) return;
  requestIdentityForField(detail.field);
}

async function handleIdentityReady(identity: Identity): Promise<void> {
  const field = currentEmailField;
  if (!field || !document.body.contains(field)) return;

  await ghostFillForm(field, identity);

  const form = field.closest('form');
  if (form) attachSubmitListener(form, identity.email);
}

// ---- OTP ----

export function findOTPField(): HTMLInputElement | null {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));

  for (const input of inputs) {
    const type = normaliseAttr(input.getAttribute('type'));
    // Accept empty (defaults to text), text, number, tel.
    if (!['', 'text', 'number', 'tel'].includes(type)) continue;

    const maxlength = input.getAttribute('maxlength');
    const maxlengthMatch = maxlength === '4' || maxlength === '6' || maxlength === '8';

    const keywordMatch = includesAny(attrHaystack(input), OTP_FIELD_KEYWORDS);

    if (maxlengthMatch || keywordMatch) {
      return input;
    }
  }

  return null;
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

async function waitForOTPField(): Promise<HTMLInputElement | null> {
  const deadline = Date.now() + OTP_RETRY_WINDOW_MS;
  while (Date.now() < deadline) {
    const field = findOTPField();
    if (field) return field;
    await wait(OTP_RETRY_INTERVAL_MS);
  }
  return null;
}

async function handleOTPFound(code: string): Promise<void> {
  const field = await waitForOTPField();
  if (!field) {
    showToast('OTP received but no input field found');
    return;
  }

  await ghostFillSingle(field, code);

  const form = field.closest('form');
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
  toast.textContent = message;
  Object.assign(toast.style, {
    background: '#1a1a1a',
    color: '#ffffff',
    borderLeft: '4px solid #00c853',
    padding: '10px 14px',
    borderRadius: '4px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '13px',
    lineHeight: '1.4',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.35)',
    opacity: '0',
    transform: 'translateX(16px)',
    transition: `opacity ${TOAST_ANIMATE_MS}ms ease, transform ${TOAST_ANIMATE_MS}ms ease`,
    pointerEvents: 'auto',
    maxWidth: '280px',
    wordBreak: 'break-word',
  } satisfies Partial<CSSStyleDeclaration>);

  container.appendChild(toast);

  // Next frame: trigger the enter transition.
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(0)';
  });

  window.setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(16px)';
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
