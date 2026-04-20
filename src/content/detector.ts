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
const SIGNUP_KEYWORDS = [
  'signup', 'sign-up', 'sign up',
  'register', 'registration',
  'join',
  'create account', 'create an account', 'create your account',
  'get started',
] as const;
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

/**
 * Gather text from nearby headings and prominent text to detect signup context
 * even when the form element itself has no identifying attributes.
 */
function nearbyTextSignals(scope: Element): string {
  // Check headings (h1-h3) and prominent ARIA labels near the form.
  const headings = scope.querySelectorAll('h1, h2, h3, [role="heading"]');
  const parts: string[] = [];
  headings.forEach((h) => parts.push(normalise(h.textContent)));

  // Also check page-level headings if scope is a small form.
  if (scope !== document.documentElement) {
    document.querySelectorAll('h1, h2').forEach((h) =>
      parts.push(normalise(h.textContent)),
    );
  }
  return parts.join(' ');
}

/**
 * Check if a container has sibling name-like inputs alongside the email field,
 * which strongly suggests a signup form (not login).
 */
function hasNameFields(container: Element): boolean {
  const nameKeywords = ['first', 'fname', 'given', 'last', 'lname', 'surname', 'full_name', 'fullname'];
  const inputs = container.querySelectorAll<HTMLInputElement>('input');
  for (const input of Array.from(inputs)) {
    const type = normalise(input.getAttribute('type'));
    if (['password', 'checkbox', 'radio', 'hidden', 'submit', 'button', 'file'].includes(type)) continue;
    const hay = [
      input.getAttribute('name'),
      input.getAttribute('id'),
      input.getAttribute('placeholder'),
      input.getAttribute('aria-label'),
    ].map(normalise).join(' ');
    if (nameKeywords.some((kw) => hay.includes(kw))) return true;
  }
  return false;
}

export function containerQualifies(container: Element): boolean {
  const haystack = container instanceof HTMLFormElement
    ? formHaystack(container)
    : normalise(container.getAttribute('class')) + ' ' + normalise(container.getAttribute('id'));

  // Blocklist short-circuits — a form named "search" is never a signup form.
  if (containsAny(haystack, BLOCKLIST_KEYWORDS)) return false;

  // Signal 1 — the container has a password input.
  if (container.querySelector('input[type="password"]')) return true;

  // Signal 2 — the container's own attributes hint at signup.
  if (containsAny(haystack, SIGNUP_KEYWORDS)) return true;

  // Signal 3 — nearby headings / page text indicate signup context.
  const headingText = nearbyTextSignals(container);
  if (containsAny(headingText, SIGNUP_KEYWORDS)) return true;

  // Signal 4 — container has name fields alongside the email field,
  // strongly suggesting a registration form (login forms don't ask for names).
  if (hasNameFields(container)) return true;

  // Signal 5 — button text in the container hints at signup.
  const buttons = container.querySelectorAll('button, input[type="submit"], [role="button"]');
  const btnText = Array.from(buttons).map((b) => normalise(b.textContent)).join(' ');
  const buttonSignals = ['sign up', 'signup', 'register', 'create', 'join', 'get started', 'next'] as const;
  if (containsAny(btnText, buttonSignals)) return true;

  return false;
}

/**
 * Scan the DOM for the first email input inside a form (or form-like container)
 * that looks like a signup / registration form.
 * Returns `null` when no eligible field exists.
 *
 * Handles:
 *  - Traditional <form> elements
 *  - React / SPA apps that don't use <form> tags (falls back to the closest
 *    section, [role="form"], or parent container)
 */
export function detectEmailField(): HTMLInputElement | null {
  const inputs = document.querySelectorAll<HTMLInputElement>('input');

  for (const input of Array.from(inputs)) {
    if (!looksLikeEmailInput(input)) continue;

    // Try a real <form> first.
    const form = input.closest('form');
    if (form && containerQualifies(form)) return input;

    // Fallback: check logical containers for SPA / formless layouts.
    const container = input.closest<Element>(
      '[role="form"], section, [data-testid], main, .card, .modal, [class*="form"], [class*="signup"], [class*="register"]',
    );
    if (container && containerQualifies(container)) return input;

    // Last resort: check the page-level context (headings on the page).
    if (form && containerQualifies(document.documentElement)) return input;
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
