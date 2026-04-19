import { getApiKey, setApiKey, clearSession, getHistory } from '../shared/storage';
import type { HistoryEntry } from '../shared/types';

async function render(): Promise<void> {
  const apiKey = await getApiKey();
  const setupSection = document.getElementById('setup-section');
  const activeSection = document.getElementById('active-section');
  if (!setupSection || !activeSection) return;

  if (!apiKey) {
    setupSection.classList.add('active');
    activeSection.classList.remove('active');
  } else {
    setupSection.classList.remove('active');
    activeSection.classList.add('active');
    await renderHistory();
  }
}

async function renderHistory(): Promise<void> {
  const list = document.getElementById('history-list');
  if (!list) return;

  const history = await getHistory();
  list.innerHTML = '';

  if (history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No emails generated yet.';
    list.appendChild(empty);
    return;
  }

  // Show only last 5 entries for brevity in popup
  for (const entry of history.slice(-5).reverse()) {
    list.appendChild(renderEntry(entry));
  }
}

function renderEntry(entry: HistoryEntry): HTMLElement {
  const li = document.createElement('li');
  li.className = 'history-item';

  const email = document.createElement('span');
  email.className = 'email';
  email.textContent = entry.email;

  const url = document.createElement('span');
  url.className = 'url';
  url.textContent = entry.url.replace(/^https?:\/\//, '');

  const footer = document.createElement('div');
  footer.className = 'footer';

  const date = document.createElement('span');
  date.className = 'date';
  date.textContent = new Date(entry.date).toLocaleDateString(undefined, { 
    month: 'short', 
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  footer.appendChild(date);
  
  li.appendChild(email);
  li.appendChild(url);
  li.appendChild(footer);

  // Click to copy email
  li.title = 'Click to copy email';
  li.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(entry.email);
      const originalText = email.textContent;
      email.textContent = 'Copied!';
      email.style.color = '#30d158';
      setTimeout(() => {
        email.textContent = originalText;
        email.style.color = '';
      }, 1000);
    } catch (e) {
      console.error('Failed to copy', e);
    }
  });

  return li;
}

function attachHandlers(): void {
  const saveBtn = document.getElementById('save-key-btn');
  const clearBtn = document.getElementById('clear-session-btn');
  const input = document.getElementById('api-key-input') as HTMLInputElement | null;

  saveBtn?.addEventListener('click', async () => {
    if (!input) return;
    const value = input.value.trim();
    if (!value) return;
    await setApiKey(value);
    window.location.reload();
  });

  clearBtn?.addEventListener('click', async () => {
    await clearSession();
    window.location.reload();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  attachHandlers();
  void render();
});
