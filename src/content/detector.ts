/*
 * FORM DETECTOR — Content Script
 *
 * Responsibilities:
 * - Run on DOMContentLoaded
 * - Scan DOM for email input fields by checking:
 *     name, id, placeholder, aria-label attributes
 *     for keywords: email, mail, user_email, e-mail
 * - Check parent form for password or signup signals to avoid false positives
 * - Ignore: search bars, contact forms, newsletter footers
 * - On detection: dispatch 'flashfill:emailFieldFound' custom event
 * - Silent fail if no form found — show no errors to user
 */

const EMAIL_KEYWORDS = ['email', 'mail', 'user_email', 'e-mail'] as const;
const SIGNUP_KEYWORDS = ['signup', 'sign-up', 'register', 'join'] as const;
const BLOCKLIST_KEYWORDS = ['search', 'contact', 'newsletter'] as const;

const EMAIL_FIELD_FOUND_EVENT = 'flashfill:emailFieldFound';

export interface EmailFieldFoundDetail {
  field: HTMLInputElement;
}

function normalise(value: string | null): string {
  return (value ?? '').toLowerCase();
}

function attributeHaystack(input: HTMLInputElement): string {
  return [
    input.getAttribute('name'),
    input.getAttribute('id'),
    input.getAttribute('placeholder'),
    input.getAttribute('aria-label'),
  ]
    .map(normalise)
    .join(' ');
}

function formHaystack(form: HTMLFormElement): string {
  return [
    form.getAttribute('action'),
    form.getAttribute('id'),
    form.getAttribute('class'),
    form.getAttribute('name'),
  ]
    .map(normalise)
    .join(' ');
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function looksLikeEmailInput(input: HTMLInputElement): boolean {
  const type = normalise(input.getAttribute('type'));
  // Explicit email inputs always qualify on type alone.
  if (type === 'email') return true;

  // Skip obviously non-text inputs.
  const disqualifyingTypes = ['password', 'checkbox', 'radio', 'hidden', 'submit', 'button', 'file'];
  if (disqualifyingTypes.includes(type)) return false;

  const haystack = attributeHaystack(input);
  return containsAny(haystack, EMAIL_KEYWORDS);
}

function parentFormQualifies(form: HTMLFormElement): boolean {
  const haystack = formHaystack(form);

  // Blocklist short-circuits — a form named "search" is never a signup form.
  if (containsAny(haystack, BLOCKLIST_KEYWORDS)) return false;

  // Signal 1 — the form contains a password input.
  const hasPassword = form.querySelector('input[type="password"]') !== null;
  if (hasPassword) return true;

  // Signal 2 — the form's own identity hints at signup / register / join.
  if (containsAny(haystack, SIGNUP_KEYWORDS)) return true;

  return false;
}

/**
 * Scan the DOM for the first email input inside a form that looks like a
 * signup / registration form. Returns `null` when no eligible field exists.
 */
export function detectEmailField(): HTMLInputElement | null {
  const inputs = document.querySelectorAll<HTMLInputElement>('input');

  for (const input of Array.from(inputs)) {
    if (!looksLikeEmailInput(input)) continue;

    const form = input.closest('form');
    if (!form) continue;

    if (!parentFormQualifies(form)) continue;

    return input;
  }

  return null;
}

/**
 * Dispatch the standard custom event so injector.ts (or any other listener)
 * can act on the detected field.
 */
export function announceEmailField(field: HTMLInputElement): void {
  const event = new CustomEvent<EmailFieldFoundDetail>(EMAIL_FIELD_FOUND_EVENT, {
    detail: { field },
    bubbles: true,
  });
  document.dispatchEvent(event);
}

function runInitialDetection(): void {
  const field = detectEmailField();
  if (field) announceEmailField(field);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runInitialDetection, { once: true });
} else {
  runInitialDetection();
}

export const EMAIL_FIELD_FOUND = EMAIL_FIELD_FOUND_EVENT;
