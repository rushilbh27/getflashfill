/**
 * POPUP CONTROLLER — FlashFill (RapidAPI Edition)
 *
 * Data flow:
 *   - Identity comes from chrome.storage.local (set by the service worker)
 *   - Inbox comes from TempMailClient (Privatix RapidAPI, direct HTTP)
 *   - Session is lazily refreshed every time the popup opens
 */

import { getApiKey, setApiKey, clearSession, getSession, getHistory, getAutoVerify, setAutoVerify } from '../shared/storage';
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
let isPaused = false;

// Identity navigator state
let identityEntries: Array<{ email: string; password?: string; firstName?: string; lastName?: string; username?: string; phone?: string }> = [];
let identityIndex = 0;

// ── DOM refs ──

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
  const headerActions = $('header-actions');

  if (!setupSection || !activeSection) return;

  if (!apiKey) {
    setupSection.classList.add('active');
    activeSection.classList.remove('active');
    if (headerActions) headerActions.style.display = 'none';
    return;
  }

  setupSection.classList.remove('active');
  activeSection.classList.add('active');
  if (headerActions) headerActions.style.display = 'flex';

  mailClient = new TempMailClient(apiKey);

  const autoVerify = await getAutoVerify();
  const toggleBtn = $('auto-verify-toggle');
  if (toggleBtn) toggleBtn.setAttribute('aria-pressed', String(autoVerify));

  // Load pause state
  const pauseResult = await chrome.storage.local.get('isPaused');
  isPaused = (pauseResult.isPaused as boolean | undefined) ?? false;
  updatePauseUI();

  // Build identity navigator from current session + history
  await buildIdentityEntries();

  const session = await getSession();
  currentSession = session;

  if (session && session.identity) {
    const id = session.identity;
    currentAddress = session.email;
    renderIdentityAge(session.createdAt);
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
// IDENTITY NAVIGATOR
// ═══════════════════════════════════════════════════════════════════════════════

async function buildIdentityEntries(): Promise<void> {
  const session = await getSession();
  const history = await getHistory();

  identityEntries = [];
  identityIndex = 0;

  if (session?.identity) {
    identityEntries.push({
      email: session.email,
      password: session.identity.password,
      firstName: session.identity.firstName,
      lastName: session.identity.lastName,
      username: session.identity.username,
      phone: session.identity.phone,
    });
  }

  for (const h of history) {
    if (!identityEntries.find(e => e.email === h.email)) {
      identityEntries.push({ email: h.email });
    }
  }

  renderCurrentIdentity();
}

function renderCurrentIdentity(): void {
  const entry = identityEntries[identityIndex];
  if (!entry) return;

  currentAddress = entry.email;
  setField('id-email', entry.email);
  setField('id-firstname', entry.firstName ?? '—');
  setField('id-lastname', entry.lastName ?? '—');
  setField('id-username', entry.username ?? '—');
  setField('id-phone', entry.phone ?? '—');

  if (passwordVisible) {
    setField('id-password', entry.password ?? '—');
  } else {
    setField('id-password', '••••••••');
  }

  setupCopyButton('email', entry.email);
  setupCopyButton('password', entry.password ?? '');
  setupCopyButton('firstname', entry.firstName ?? '');
  setupCopyButton('lastname', entry.lastName ?? '');
  setupCopyButton('username', entry.username ?? '');
  setupCopyButton('phone', entry.phone ?? '');

  // Update navigator UI
  const indexEl = $('identity-index');
  if (indexEl) {
    indexEl.textContent = identityEntries.length > 0
      ? `${identityIndex + 1}/${identityEntries.length}`
      : '1/1';
  }

  const prevBtn = $('prev-identity-btn') as HTMLButtonElement | null;
  const nextBtn = $('next-identity-btn') as HTMLButtonElement | null;
  if (prevBtn) prevBtn.disabled = identityIndex === 0;
  if (nextBtn) nextBtn.disabled = identityIndex >= identityEntries.length - 1;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAUSE
// ═══════════════════════════════════════════════════════════════════════════════

function updatePauseUI(): void {
  const pauseBtn = $('pause-btn');
  if (!pauseBtn) return;

  if (isPaused) {
    pauseBtn.title = 'Resume';
    pauseBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
    pauseBtn.classList.add('nb-button-black');
    pauseBtn.classList.remove('nb-button-white');
  } else {
    pauseBtn.title = 'Pause';
    pauseBtn.innerHTML = `<svg class="pause-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
    pauseBtn.classList.remove('nb-button-black');
    pauseBtn.classList.add('nb-button-white');
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
    ageEl.textContent = 'Expired — rotating…';
    ageEl.style.color = 'var(--ff-warn)';
    void autoRotateIdentity();
    return;
  }

  const ageHours = Math.floor(ageMs / 3_600_000);
  const remainDays = Math.floor(remainMs / 86_400_000);
  const remainHours = Math.floor(remainMs / 3_600_000);

  if (remainMs < 86_400_000) {
    ageEl.textContent = remainHours < 1 ? '⚡ Expiring soon' : `⚡ Expires in ${remainHours}h`;
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
  setTimeout(() => void render(), 1800);
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

  const newBtn = btn.cloneNode(true) as HTMLButtonElement;
  btn.parentNode?.replaceChild(newBtn, btn);

  newBtn.addEventListener('click', async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      newBtn.classList.add('copy-success');
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
  if (refreshBtn) refreshBtn.classList.add('spinning');

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

      const otpCode = extractOTP(`${msg.subject} ${msg.bodyText} ${msg.bodyHtml}`);
      const verificationLink = extractVerificationLink(msg);

      const subject = document.createElement('div');
      subject.className = 'inbox-item-subject';
      subject.textContent = msg.subject || '(No Subject)';

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

      if (otpCode) {
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
            copyBtn.textContent = `Code: ${otpCode}`;
          }
        });

        copyRow.appendChild(copyBtn);
        item.appendChild(copyRow);
      } else if (verificationLink) {
        const verifyRow = document.createElement('div');
        verifyRow.className = 'inbox-item-verify-row';

        const verifyBtn = document.createElement('button');
        verifyBtn.className = 'btn-verify';
        verifyBtn.textContent = '⚡ Open Verification Link';
        verifyBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) {
              await chrome.tabs.update(tab.id, { url: verificationLink });
            } else {
              await chrome.tabs.create({ url: verificationLink, active: true });
            }
          } catch {
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
    if (refreshBtn) refreshBtn.classList.remove('spinning');
  }
}

function decodeHtmlEntities(str: string): string {
  const ta = document.createElement('textarea');
  ta.innerHTML = str;
  return ta.value;
}

function extractVerificationLink(msg: TempMailMessage): string | null {
  const raw = extractLink(msg.bodyHtml) ?? extractLink(msg.bodyText) ?? null;
  return raw ? decodeHtmlEntities(raw) : null;
}

function formatTime(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const diffMs = Date.now() - d.getTime();
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
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
      bodyEl.innerHTML = DOMPurify.sanitize(msg.bodyHtml, { ADD_ATTR: ['target'] });

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

  view.style.display = 'flex';
}

function closeMessage(): void {
  const view = $('message-view');
  if (view) {
    view.style.display = 'none';
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

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.runtime.sendMessage({
        type: 'REQUEST_IDENTITY',
        payload: { url: tab.url || 'https://unknown' },
      });
    }
  } catch { /* silent */ }

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
  const pauseBtn = $('pause-btn');
  const settingsBtn = $('settings-btn');
  const changeKeyBtn = $('change-key-btn');
  const clearSessionBtn = $('clear-session-btn');
  const prevBtn = $('prev-identity-btn');
  const nextBtn = $('next-identity-btn');

  saveBtn?.addEventListener('click', async () => {
    if (!input) return;
    const value = input.value.trim();
    if (!value) return;
    await setApiKey(value);
    window.location.reload();
  });

  newBtn?.addEventListener('click', () => void handleNewIdentity());

  refreshBtn?.addEventListener('click', () => void fetchInbox());

  backBtn?.addEventListener('click', closeMessage);

  togglePwBtn?.addEventListener('click', () => {
    passwordVisible = !passwordVisible;
    const entry = identityEntries[identityIndex];
    if (entry) {
      setField('id-password', passwordVisible ? (entry.password ?? '—') : '••••••••');
    }
    if (togglePwBtn) {
      togglePwBtn.textContent = passwordVisible ? 'HIDE PASSWORD' : 'SHOW PASSWORD';
    }
  });

  pauseBtn?.addEventListener('click', async () => {
    isPaused = !isPaused;
    await chrome.storage.local.set({ isPaused });
    updatePauseUI();
    try {
      chrome.runtime.sendMessage({ type: 'SET_PAUSED', payload: { paused: isPaused } });
    } catch { /* silent */ }
  });

  settingsBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dropdown = $('settings-dropdown');
    dropdown?.classList.toggle('active');
  });

  document.addEventListener('click', () => {
    $('settings-dropdown')?.classList.remove('active');
  });

  changeKeyBtn?.addEventListener('click', async () => {
    await chrome.storage.local.remove('apiKey');
    window.location.reload();
  });

  clearSessionBtn?.addEventListener('click', async () => {
    await clearSession();
    $('settings-dropdown')?.classList.remove('active');
    void render();
  });

  prevBtn?.addEventListener('click', () => {
    if (identityIndex > 0) {
      identityIndex--;
      renderCurrentIdentity();
      void fetchInbox();
    }
  });

  nextBtn?.addEventListener('click', () => {
    if (identityIndex < identityEntries.length - 1) {
      identityIndex++;
      renderCurrentIdentity();
      void fetchInbox();
    }
  });

  const autoVerifyToggle = $('auto-verify-toggle');
  autoVerifyToggle?.addEventListener('click', async () => {
    const current = autoVerifyToggle.getAttribute('aria-pressed') === 'true';
    const next = !current;
    autoVerifyToggle.setAttribute('aria-pressed', String(next));
    await setAutoVerify(next);
  });

  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.currentSession) {
        void render();
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'OTP_FOUND' || message.type === 'LINK_FOUND') {
        void fetchInbox();
      }
    });
  }

  setInterval(() => {
    if (currentAddress && !isFetching) {
      void fetchInbox();
    }
  }, 10000);
}
