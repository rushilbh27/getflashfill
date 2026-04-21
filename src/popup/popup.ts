/**
 * POPUP CONTROLLER — FlashFill
 *
 * Renders identity details, live inbox, handles ↻ New identity rotation,
 * password reveal toggle, copy-to-clipboard, and message reading.
 *
 * Data flow:
 *   - Identity comes from chrome.storage.local (set by the service worker)
 *   - Inbox comes from TempMailClient (Privatix RapidAPI, direct HTTP)
 *   - Session is lazily refreshed every time the popup opens
 */

import { getApiKey, setApiKey, clearSession, getSession, getAutoVerify, setAutoVerify } from '../shared/storage';
import { TempMailClient, type TempMailMessage } from '../shared/privatix-temp-mail';
import { extractLink, extractOTP } from '../shared/otp-extractor';
import type { SessionData } from '../shared/types';
import { SESSION_TTL_MS } from '../shared/types';
import DOMPurify from 'dompurify';

// ── state ──

let mailClient: TempMailClient | null = null;
let currentAddress = '';
let isFetching = false;
let passwordVisible = false;
let currentSession: SessionData | null = null;

// ── DOM refs (resolved once) ──

const $ = (id: string) => document.getElementById(id);

// ── entry point ──

document.addEventListener('DOMContentLoaded', () => {
  attachHandlers();
  void render();
});

// ═══════════════════════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════════════════════

async function render(): Promise<void> {
  const apiKey = await getApiKey();
  const setupSection = $('setup-section');
  const activeSection = $('active-section');

  if (!setupSection || !activeSection) return;

  if (!apiKey) {
    setupSection.classList.add('active');
    activeSection.classList.remove('active');
    return;
  }

  setupSection.classList.remove('active');
  activeSection.classList.add('active');

  mailClient = new TempMailClient(apiKey);

  // Load and apply the auto-verify toggle state.
  const autoVerify = await getAutoVerify();
  const toggleBtn = $('auto-verify-toggle');
  if (toggleBtn) toggleBtn.setAttribute('aria-pressed', String(autoVerify));

  const session = await getSession();
  currentSession = session;

  if (session && session.identity) {
    const id = session.identity;
    currentAddress = session.email;

    setField('id-email', session.email);
    setPasswordField(id.password);
    setField('id-firstname', id.firstName);
    setField('id-lastname', id.lastName);
    setField('id-username', id.username);
    setField('id-phone', id.phone || '—');

    // Copy buttons
    setupCopyButton('email', session.email);
    setupCopyButton('password', id.password);
    setupCopyButton('firstname', id.firstName);
    setupCopyButton('lastname', id.lastName);
    setupCopyButton('username', id.username);
    setupCopyButton('phone', id.phone || '');

    // Age badge
    renderIdentityAge(session.createdAt);

    // Inbox
    await fetchInbox();
  } else {
    currentAddress = '';
    setField('id-email', 'No active session');
    const inboxList = $('inbox-list');
    if (inboxList) {
      inboxList.innerHTML = '<div class="inbox-empty">Open a signup page to begin</div>';
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// IDENTITY AGE
// ═══════════════════════════════════════════════════════════════════════════════

function renderIdentityAge(createdAt: number): void {
  const ageEl = $('identity-age');
  const banner = document.querySelector('.status-banner') as HTMLElement | null;
  if (!ageEl) return;

  const ageMs = Date.now() - createdAt;
  const remainMs = SESSION_TTL_MS - ageMs;

  if (remainMs <= 0) {
    // Already expired — auto-rotate: request a fresh identity for the active tab.
    ageEl.textContent = 'Expired — rotating…';
    ageEl.style.color = 'var(--ff-warn)';
    void autoRotateIdentity();
    return;
  }

  const ageHours = Math.floor(ageMs / 3_600_000);
  const remainDays = Math.floor(remainMs / 86_400_000);
  const remainHours = Math.floor(remainMs / 3_600_000);

  if (remainMs < 86_400_000) {
    // Less than 1 day left — amber warning
    ageEl.textContent = remainHours < 1 ? '⚡ Expiring soon — tap ↻ New' : `⚡ Expires in ${remainHours}h — tap ↻ New`;
    ageEl.style.color = 'var(--ff-warn)';
    if (banner) {
      banner.style.background = 'var(--ff-warn-dim)';
      banner.style.color = 'var(--ff-warn)';
      banner.style.borderColor = 'rgba(245, 158, 11, 0.2)';
    }
  } else if (ageHours < 24) {
    ageEl.textContent = ageHours < 1 ? 'Just now' : `${ageHours}h ago`;
  } else {
    ageEl.textContent = `Expires in ${remainDays}d`;
  }
}

async function autoRotateIdentity(): Promise<void> {
  await clearSession();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.runtime.sendMessage({
        type: 'REQUEST_IDENTITY',
        payload: { url: tab.url || 'https://unknown' },
      });
    }
  } catch { /* silent */ }
  // Re-render after the worker has had time to save the new session.
  setTimeout(() => void render(), 1800);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PASSWORD TOGGLE
// ═══════════════════════════════════════════════════════════════════════════════

function setPasswordField(password: string): void {
  const el = $('id-password');
  if (!el) return;

  if (passwordVisible) {
    el.textContent = password;
    el.classList.remove('kv-masked');
  } else {
    el.textContent = '••••••••••';
    el.classList.add('kv-masked');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIELD HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function setField(id: string, value: string): void {
  const el = $(id);
  if (el) el.textContent = value;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COPY TO CLIPBOARD
// ═══════════════════════════════════════════════════════════════════════════════

function setupCopyButton(type: string, value: string): void {
  const btn = document.querySelector(`button.copy-btn[data-copy="${type}"]`);
  if (!btn) return;

  // Clone to remove leftover listeners.
  const newBtn = btn.cloneNode(true) as HTMLButtonElement;
  btn.parentNode?.replaceChild(newBtn, btn);

  newBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      newBtn.classList.add('copy-success');
      // Swap icon to checkmark briefly.
      const origHTML = newBtn.innerHTML;
      newBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ff-success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(() => {
        newBtn.innerHTML = origHTML;
        newBtn.classList.remove('copy-success');
      }, 1200);
    } catch (e) {
      console.error('Copy failed:', e);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INBOX
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchInbox(): Promise<void> {
  if (!mailClient || !currentAddress || isFetching) return;

  const inboxList = $('inbox-list');
  if (!inboxList) return;

  isFetching = true;
  const refreshBtn = $('refresh-inbox-btn');
  if (refreshBtn) refreshBtn.closest('button')?.classList.add('spinning');

  try {
    const messages = await mailClient.getMessages(currentAddress);
    inboxList.innerHTML = '';

    if (messages.length === 0) {
      inboxList.innerHTML = '<div class="inbox-empty">No messages yet<br><span style="font-size:0.7rem;opacity:0.6">FlashFill is watching in the background</span></div>';
      return;
    }

    for (const msg of messages) {
      const item = document.createElement('div');
      item.className = 'inbox-item';

      // Extract OTP code and verification link from this email.
      const otpCode = extractOTP(`${msg.subject} ${msg.bodyText} ${msg.bodyHtml}`);
      const verificationLink = extractVerificationLink(msg);

      const subject = document.createElement('div');
      subject.className = 'inbox-item-subject';
      subject.textContent = msg.subject || '(No Subject)';

      // OTP badge when we found a code
      if (otpCode) {
        const badge = document.createElement('span');
        badge.className = 'inbox-item-badge';
        badge.textContent = '⚡ OTP';
        subject.appendChild(badge);
      }

      const meta = document.createElement('div');
      meta.className = 'inbox-item-meta';

      const from = document.createElement('div');
      from.className = 'inbox-item-from';
      from.textContent = msg.from || '(Unknown)';

      const time = document.createElement('div');
      time.className = 'inbox-item-time';
      time.textContent = formatTime(msg.receivedAt);

      meta.appendChild(from);
      meta.appendChild(time);

      item.appendChild(subject);
      item.appendChild(meta);

      // Action row — OTP Copy button takes priority over Verify Link button.
      if (otpCode) {
        // Show "Copy Code" button so user can manually paste if injection failed.
        const copyRow = document.createElement('div');
        copyRow.className = 'inbox-item-verify-row';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn-verify btn-copy-code';
        copyBtn.textContent = `📋 Copy Code: ${otpCode}`;
        copyBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(otpCode);
            copyBtn.textContent = '✅ Copied!';
            setTimeout(() => { copyBtn.textContent = `📋 Copy Code: ${otpCode}`; }, 1500);
          } catch {
            // Fallback: show the raw code as button text for manual copy
            copyBtn.textContent = `Code: ${otpCode}`;
          }
        });

        copyRow.appendChild(copyBtn);
        item.appendChild(copyRow);
      } else if (verificationLink) {
        // No OTP — show Verify Link button.
        const verifyRow = document.createElement('div');
        verifyRow.className = 'inbox-item-verify-row';

        const verifyBtn = document.createElement('button');
        verifyBtn.className = 'btn-verify';
        verifyBtn.textContent = '⚡ Open Verification Link';
        verifyBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            // Navigate the SAME signup tab — cookies travel with it.
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) {
              await chrome.tabs.update(tab.id, { url: verificationLink });
            } else {
              await chrome.tabs.create({ url: verificationLink, active: true });
            }
          } catch {
            // Fallback to new tab if update fails.
            chrome.tabs.create({ url: verificationLink, active: true });
          }
          window.close();
        });

        verifyRow.appendChild(verifyBtn);
        item.appendChild(verifyRow);
      }

      item.addEventListener('click', () => openMessage(msg));
      inboxList.appendChild(item);
    }
  } catch (err) {
    console.error('Inbox fetch failed:', err);
    inboxList.innerHTML = '<div class="inbox-empty" style="color: #ef4444;">Failed to load inbox</div>';
  } finally {
    isFetching = false;
    if (refreshBtn) refreshBtn.closest('button')?.classList.remove('spinning');
  }
}

function decodeHtmlEntities(str: string): string {
  // Browsers decode HTML entities when you set .innerHTML on a textarea.
  // This turns &amp; → &, &#x2F; → /, %20 → %20 etc. so the URL is valid.
  const ta = document.createElement('textarea');
  ta.innerHTML = str;
  return ta.value;
}

function extractVerificationLink(msg: TempMailMessage): string | null {
  // Prefer HTML body (richer source) then fall back to plain text.
  const raw = extractLink(msg.bodyHtml) ?? extractLink(msg.bodyText) ?? null;
  // Decode HTML entities — raw HTML URLs often contain &amp; instead of &.
  return raw ? decodeHtmlEntities(raw) : null;
}

function formatTime(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  } catch {
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE VIEW
// ═══════════════════════════════════════════════════════════════════════════════

function openMessage(msg: TempMailMessage): void {
  const view = $('message-view');
  if (!view) return;

  const subjectEl = $('msg-subject');
  const fromEl = $('msg-from');
  const bodyEl = $('msg-body');

  if (subjectEl) subjectEl.textContent = msg.subject || '(No Subject)';
  if (fromEl) fromEl.textContent = `From: ${msg.from}`;

  if (bodyEl) {
    if (msg.bodyHtml) {
      bodyEl.innerHTML = DOMPurify.sanitize(msg.bodyHtml, {
        ADD_ATTR: ['target'], // allow target attr so we can read it
      });

      // Extension CSP blocks <a href> navigation inside the popup.
      // Intercept every link and route it through chrome.tabs so it actually works.
      bodyEl.querySelectorAll('a[href]').forEach((a) => {
        a.addEventListener('click', async (e) => {
          e.preventDefault();
          const href = decodeHtmlEntities((a as HTMLAnchorElement).href);
          if (!href || href === '#') return;
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) {
              await chrome.tabs.update(tab.id, { url: href });
            } else {
              await chrome.tabs.create({ url: href, active: true });
            }
          } catch {
            chrome.tabs.create({ url: href, active: true });
          }
          window.close();
        });
      });
    } else {
      bodyEl.textContent = msg.bodyText || '';
      bodyEl.style.whiteSpace = 'pre-wrap';
    }
  }

  view.classList.add('active');
}

function closeMessage(): void {
  const view = $('message-view');
  if (view) {
    view.classList.remove('active');
    const body = $('msg-body');
    if (body) body.innerHTML = '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEW IDENTITY
// ═══════════════════════════════════════════════════════════════════════════════

async function handleNewIdentity(): Promise<void> {
  const newBtn = $('new-identity-btn');
  if (newBtn) newBtn.classList.add('spinning');

  await clearSession();

  // Ask the worker to generate a fresh identity for the currently active tab.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.runtime.sendMessage({
        type: 'REQUEST_IDENTITY',
        payload: { url: tab.url || 'https://unknown' },
      });
    }
  } catch {
    // Extension context may be invalidated — ignore.
  }

  // Give the worker a moment to persist the new session, then re-render.
  setTimeout(() => {
    if (newBtn) newBtn.classList.remove('spinning');
    void render();
  }, 1500);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

function attachHandlers(): void {
  const saveBtn = $('save-key-btn');
  const newBtn = $('new-identity-btn');
  const refreshBtn = $('refresh-inbox-btn');
  const backBtn = $('back-to-inbox-btn');
  const togglePwBtn = $('toggle-password-btn');
  const input = $('api-key-input') as HTMLInputElement | null;

  saveBtn?.addEventListener('click', async () => {
    if (!input) return;
    const value = input.value.trim();
    if (!value) return;
    await setApiKey(value);
    window.location.reload();
  });

  newBtn?.addEventListener('click', () => {
    void handleNewIdentity();
  });

  refreshBtn?.addEventListener('click', () => {
    void fetchInbox();
  });

  backBtn?.addEventListener('click', closeMessage);

  togglePwBtn?.addEventListener('click', () => {
    passwordVisible = !passwordVisible;
    if (currentSession?.identity) {
      setPasswordField(currentSession.identity.password);
    }
    // Swap icon between eye and eye-off.
    if (togglePwBtn) {
      togglePwBtn.innerHTML = passwordVisible
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
    }
  });

  const autoVerifyToggle = $('auto-verify-toggle');
  autoVerifyToggle?.addEventListener('click', async () => {
    const current = autoVerifyToggle.getAttribute('aria-pressed') === 'true';
    const next = !current;
    autoVerifyToggle.setAttribute('aria-pressed', String(next));
    await setAutoVerify(next);
  });

  // Live updates — if worker creates/updates a session while popup is open.
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.currentSession) {
        void render();
      }
    });
  }

  // Inbox push from worker (OTP/link found).
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'OTP_FOUND' || message.type === 'LINK_FOUND') {
        void fetchInbox();
      }
    });
  }

  // Auto-refresh inbox every 10 seconds while the popup is kept open
  setInterval(() => {
    if (currentAddress && !isFetching) {
      void fetchInbox();
    }
  }, 10000);
}
