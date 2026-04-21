/*
 * MUTATION OBSERVER — Content Script
 *
 * Responsibilities:
 * - Watch for dynamically injected DOM elements using MutationObserver
 * - Specifically watch for signup modals and popups added after page load
 * - On new node detection: call detectEmailField(); if found and not already
 *   filled, dispatch 'flashfill:emailFieldFound'
 * - Watch for URL changes via setInterval (1500ms) to catch SPA navigation
 * - Watch for OTP-pattern URLs: if URL contains 'verify', 'otp', or 'code'
 *   send OTP_URL_DETECTED message to service worker as secondary trigger
 */

import { announceEmailField, detectEmailField } from './detector';
import type { ContentToWorkerMessage } from '../shared/messages';

const URL_POLL_INTERVAL_MS = 1500;
const OTP_URL_KEYWORDS = ['verify', 'otp', 'code'] as const;

let lastAnnouncedField: HTMLInputElement | null = null;
let lastKnownUrl = location.href;
let lastOtpUrlSent: string | null = null;

function fieldIsAlreadyFilled(field: HTMLInputElement): boolean {
  return field.value.trim().length > 0;
}

function handleDomMutation(): void {
  const field = detectEmailField();
  if (!field) return;
  if (field === lastAnnouncedField) return;
  if (fieldIsAlreadyFilled(field)) return;

  lastAnnouncedField = field;
  announceEmailField(field);
}

function sendToWorker(message: ContentToWorkerMessage): void {
  // chrome.runtime may be undefined in rare contexts (e.g. extension reload).
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;
  try {
    const promise = chrome.runtime.sendMessage(message);
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => {});
    }
  } catch (error) {
    // Swallow — silent failure per PRD "no user-facing errors".
  }
}

function looksLikeOtpUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return OTP_URL_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function checkUrlChange(): void {
  const current = location.href;
  if (current === lastKnownUrl) return;

  lastKnownUrl = current;

  // Re-run detection after SPA navigation — the field reference may now be
  // a different node in the new view.
  lastAnnouncedField = null;
  handleDomMutation();

  if (looksLikeOtpUrl(current) && current !== lastOtpUrlSent) {
    lastOtpUrlSent = current;
    const message: ContentToWorkerMessage = {
      type: 'OTP_URL_DETECTED',
      payload: { url: current },
    };
    sendToWorker(message);
  }
}

function startMutationObserver(): void {
  const observer = new MutationObserver(() => {
    handleDomMutation();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function startUrlWatcher(): void {
  // Seed: if the page loaded directly on an OTP URL, fire once.
  if (looksLikeOtpUrl(lastKnownUrl)) {
    lastOtpUrlSent = lastKnownUrl;
    sendToWorker({ type: 'OTP_URL_DETECTED', payload: { url: lastKnownUrl } });
  }

  setInterval(checkUrlChange, URL_POLL_INTERVAL_MS);
}

function boot(): void {
  if (!document.body) {
    // document_idle should guarantee body exists, but guard defensively.
    document.addEventListener('DOMContentLoaded', boot, { once: true });
    return;
  }
  startMutationObserver();
  startUrlWatcher();
}

boot();
