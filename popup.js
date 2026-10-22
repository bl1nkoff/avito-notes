/* Avito Notes — popup: поиск, фильтрация и сортировка заметок.
 * Источник данных — chrome.storage.local (тот же ключ, что использует content.js).
 */
'use strict';

const STORAGE_KEY = 'avito_notes_v1';

// В popup-окне расширения `chrome` всегда определён; заглушка нужна только
// для авто-запуска скрипта вне браузера (например, require() в тестах).
if (typeof chrome === 'undefined') {
  globalThis.chrome = {
    storage: { local: { get: (_k, cb) => cb({}) }, onChanged: { addListener: () => {} } },
    tabs: { create: () => {}, query: async () => [] },
    scripting: { executeScript: async () => {}, insertCSS: async () => {} },
  };
}

function getNotes() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (data) => {
      // id ключа хранилища добавляется к каждой заметке: он нужен, чтобы
      // восстановить ссылку на объявление у старых записей без link.
      resolve(
        Object.entries(data[STORAGE_KEY] || {}).map(([id, note]) => ({ ...note, id }))
      );
    });
  });
}

// «12 500 ₽» -> 12500; «Договорная» / пустое -> null (такие цены — в конец списка).
function parsePrice(priceStr) {
  if (!priceStr) return null;
  const digits = String(priceStr).replace(/[^\d]/g, '');
  if (!digits) return null;
  return parseInt(digits, 10);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function compareByPrice(a, b, dir) {
  const pa = parsePrice(a.price);
  const pb = parsePrice(b.price);
  if (pa === null && pb === null) return 0;
  if (pa === null) return 1;   // без цены — всегда в конце
  if (pb === null) return -1;
  return dir * (pa - pb);
}

function sortNotes(notes, sortBy) {
  const sorted = [...notes];
  switch (sortBy) {
    case 'timestamp_asc': sorted.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)); break;
    case 'price_asc':     sorted.sort((a, b) => compareByPrice(a, b, 1)); break;
    case 'price_desc':    sorted.sort((a, b) => compareByPrice(a, b, -1)); break;
    default:              sorted.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }
  return sorted;
}

function filterNotes(notes, { search, emojiFilter }) {
  return notes.filter((note) => {
    const matchSearch =
      !search ||
      (note.title || '').toLowerCase().includes(search) ||
      (note.text || '').toLowerCase().includes(search);
    const matchEmoji = !emojiFilter || note.emoji === emojiFilter;
    return matchSearch && matchEmoji;
  });
}

// Ссылка, по которой popup открывает объявление при клике на заметку.
// Заметки, сохранённые до того, как в них начал писаться канонический link
// (или с устаревшим/редиректным адресом), восстанавливаются по id: Авито
// разворачивает /item/<id> в актуальную страницу объявления. Иначе клик
// улетал на страницу поиска — ту, с которой заметка была сделана.
function resolveNoteUrl(note) {
  if (!note) return '';
  const link = String(note.link || '');
  if (/^https?:\/\//i.test(link)) {
    // Старые записи могли сохранить ссылку выдачи вида .../item/<id>
    // с query-«хвостом» — она ведёт через редирект на поиск. Чистим хвост;
    // если остались только «голые» цифры — это и есть нужный переход.
    const clean = link.split('#')[0].split('?')[0];
    if (/\/item\/\d+$/.test(clean) || /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/[\w~.-]*_\d{5,15}(\.html)?$/i.test(clean)) {
      return clean;
    }
    // Неизвестный формат — всё равно надёжнее открыть по id, если он есть.
    if (note.id) return itemUrlFromId(note.id);
    return clean || link;
  }
  if (note.id) return itemUrlFromId(note.id);
  return '';
}

function itemUrlFromId(id) {
  return `https://www.avito.ru/item/${encodeURIComponent(String(id))}`;
}

function noteItemHtml(note) {
  return `
    <div class="note-title">${escapeHtml(note.emoji || '💬')} ${escapeHtml(note.title)}</div>
    <div class="note-meta">
        <span>${escapeHtml(note.price)}</span>
        <span>${new Date(note.timestamp || Date.now()).toLocaleDateString()} ${new Date(
          note.timestamp || Date.now()
        ).toLocaleTimeString()}</span>
    </div>
    ${note.text ? `<div class="note-text">${escapeHtml(note.text)}</div>` : ''}`;
}

async function renderNotes() {
  const searchEl = document.getElementById('search');
  if (!searchEl) return; // скрипт загружен вне popup.html (например, require() в тестах)
  const search = searchEl.value.trim().toLowerCase();
  const emojiFilter = document.getElementById('emojiFilter').value;
  const sortBy = document.getElementById('sortBy').value;

  const notes = await getNotes();
  const visible = sortNotes(filterNotes(notes, { search, emojiFilter }), sortBy);

  const list = document.getElementById('notesList');
  list.textContent = '';

  if (!visible.length) {
    list.innerHTML = '<div class="empty">Заметок не найдено</div>';
    return;
  }

  for (const note of visible) {
    const item = document.createElement('div');
    item.className = 'note-item';
    item.innerHTML = noteItemHtml(note);
    // Клик открывает САМО объявление: ссылка берётся из заметки, а для
    // старых записей (где хранился URL страницы поиска) восстанавливается
    // по id объявления.
    item.addEventListener('click', () => {
      const url = resolveNoteUrl(note);
      if (url) chrome.tabs.create({ url });
    });
    list.appendChild(item);
  }
}

// Слушатели и стартовый рендер — только когда скрипт запущен внутри popup.html.
if (typeof document !== 'undefined' && document.getElementById('search')) {
  document.getElementById('search').addEventListener('input', renderNotes);
  document.getElementById('emojiFilter').addEventListener('change', renderNotes);
  document.getElementById('sortBy').addEventListener('change', renderNotes);

  // Обновляем список, если данные изменились на странице/в другой вкладке.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) renderNotes();
  });

  renderNotes();

  document.getElementById('forceRun').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.includes('avito.ru')) {
      alert('Откройте сайт Авито, чтобы запустить расширение!');
      return;
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles.css'] });
      window.close();
    } catch (err) {
      console.error('Ошибка инжекта:', err);
      alert('Не удалось запустить: ' + err.message);
    }
  });
}

// Экспорт чистых функций для тестов (в расширении `module` не определён).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parsePrice, escapeHtml, compareByPrice, sortNotes, filterNotes,
    noteItemHtml, resolveNoteUrl, itemUrlFromId,
  };
}
