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
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No emails used yet.';
    list.appendChild(empty);
    return;
  }

  for (const entry of history) {
    list.appendChild(renderEntry(entry));
  }
}

function renderEntry(entry: HistoryEntry): HTMLLIElement {
  const li = document.createElement('li');

  const email = document.createElement('span');
  email.className = 'email';
  email.textContent = entry.email;

  const url = document.createElement('span');
  url.className = 'url';
  url.textContent = entry.url;

  const date = document.createElement('span');
  date.className = 'date';
  date.textContent = new Date(entry.date).toLocaleString();

  li.appendChild(email);
  li.appendChild(url);
  li.appendChild(date);
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
