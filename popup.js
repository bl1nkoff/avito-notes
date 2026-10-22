const STORAGE_KEY = 'avito_notes_v1';

function getNotes() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
}

function parsePrice(priceStr) {
  if (!priceStr) return 0;
  const num = parseInt(priceStr.replace(/[^\d]/g, ''), 10);
  return isNaN(num) ? 0 : num;
}

function renderNotes() {
  const notes = Object.values(getNotes());
  const search = document.getElementById('search').value.toLowerCase();
  const emojiFilter = document.getElementById('emojiFilter').value;
  const sortBy = document.getElementById('sortBy').value;

  let filtered = notes.filter(note => {
    const matchSearch = (note.title || '').toLowerCase().includes(search) ||
      (note.text || '').toLowerCase().includes(search);
    const matchEmoji = !emojiFilter || note.emoji === emojiFilter;
    return matchSearch && matchEmoji;
  });

  filtered.sort((a, b) => {
    switch (sortBy) {
      case 'timestamp_desc': return b.timestamp - a.timestamp;
      case 'timestamp_asc': return a.timestamp - b.timestamp;
      case 'price_asc': return parsePrice(a.price) - parsePrice(b.price);
      case 'price_desc': return parsePrice(b.price) - parsePrice(a.price);
      default: return 0;
    }
  });

  const list = document.getElementById('notesList');
  list.innerHTML = filtered.length ? '' : '<div class="empty">Заметок не найдено</div>';

  filtered.forEach(note => {
    const item = document.createElement('div');
    item.className = 'note-item';
    item.innerHTML = `
            <div class="note-title">${note.emoji || '💬'} ${note.title}</div>
            <div class="note-meta">
                <span>${note.price}</span>
                <span>${new Date(note.timestamp).toLocaleDateString()} ${new Date(note.timestamp).toLocaleTimeString()}</span>
            </div>
            ${note.text ? `<div class="note-text">${note.text}</div>` : ''}
        `;
    item.onclick = () => {
      if (note.link) chrome.tabs.create({ url: note.link });
    };
    list.appendChild(item);
  });
}

document.getElementById('search').addEventListener('input', renderNotes);
document.getElementById('emojiFilter').addEventListener('change', renderNotes);
document.getElementById('sortBy').addEventListener('change', renderNotes);

renderNotes();

document.getElementById('forceRun').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.includes('avito.ru')) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      console.log('Скрипт успешно инжектирован');
      window.close();
    } catch (err) {
      console.error('Ошибка инжекта:', err);
      alert('Не удалось запустить: ' + err.message);
    }
  } else {
    alert('Откройте сайт Авито, чтобы запустить расширение!');
  }
});
