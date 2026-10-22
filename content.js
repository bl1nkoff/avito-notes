(function() {
  if (window.avitoNotesInitialized) return;
  window.avitoNotesInitialized = true;

  console.log('[Avito Notes] Скрипт запущен на:', window.location.href);

  const STORAGE_KEY = 'avito_notes_v1';
  let notesCache = {};

  async function loadNotes() {
    return new Promise(resolve => {
      chrome.storage.local.get([STORAGE_KEY], data => {
        notesCache = data[STORAGE_KEY] || {};
        resolve(notesCache);
      });
    });
  }

  function saveNote(id, data) {
    if (!id) return console.error('Нет ID для сохранения');
    notesCache[id] = { ...notesCache[id], ...data, timestamp: Date.now() };
    chrome.storage.local.set({ [STORAGE_KEY]: notesCache });
  }

  function deleteNote(id) {
    delete notesCache[id];
    chrome.storage.local.set({ [STORAGE_KEY]: notesCache });
  }

  function getItemId(container) {
    const itemId = container.getAttribute('data-item-id');
    if (itemId) return itemId;

    if (container.id && container.id.startsWith('i')) {
      return container.id.substring(1);
    }

    const link = container.querySelector('a[href*="/item/"]')?.href;
    if (link) {
      const match = link.match(/_(\d{5,15})(\?|$|\/)/);
      if (match) return match[1];
    }

    if (window.location.pathname.includes('/item/')) {
      const match = window.location.pathname.match(/_(\d{5,15})(\?|$|\/)/);
      if (match) return match[1];
    }

    return null;
  }

  function extractData(container) {
    const title = container.querySelector('[data-marker="item-title"], [data-marker="item-view/title-info"], h1')?.textContent.trim() || 'Без названия';
    const price = container.querySelector('[data-marker="item-price-value"], [data-marker="item-view/item-price"]')?.textContent.trim() || 'Цена не указана';
    let link = container.querySelector('a[href*="/item/"]')?.href;
    if (!link || window.location.pathname.includes('/item/')) link = window.location.href;
    const img = container.querySelector('img[itemprop="image"]')?.src || container.querySelector('img')?.src || '';
    return { title, price, link, img, coords: null };
  }

  function openNoteModal(id, note, container) {
    document.querySelector('.avito-notes-modal')?.remove();

    const modal = document.createElement('div');
    modal.className = 'avito-notes-modal';
    modal.style.cssText = `position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 999999; display: flex; align-items: center; justify-content: center; font-family: sans-serif;`;

    const box = document.createElement('div');
    box.style.cssText = `background: white; padding: 20px; border-radius: 12px; width: 400px; max-width: 90%; box-shadow: 0 10px 30px rgba(0,0,0,0.3); display: flex; flex-direction: column; gap: 12px;`;
    box.innerHTML = `
            <h3 style="margin:0; font-size:18px;">Заметка</h3>
            <textarea id="avito-note-text" style="width:100%; height:150px; padding:10px; border:1px solid #ddd; border-radius:6px; font-size:14px; resize:vertical;">${note?.text || ''}</textarea>
            <div style="display:flex; gap:10px; justify-content:flex-end;">
                <button class="btn-cancel" style="padding:8px 16px; border:1px solid #ddd; background:#f5f5f5; border-radius:6px; cursor:pointer;">Отмена</button>
                <button class="btn-delete" style="padding:8px 16px; border:none; background:#ff3b30; color:white; border-radius:6px; cursor:pointer;">Удалить</button>
                <button class="btn-save" style="padding:8px 16px; border:none; background:#007aff; color:white; border-radius:6px; cursor:pointer;">Сохранить</button>
            </div>
        `;

    modal.appendChild(box);
    document.body.appendChild(modal);

    modal.querySelector('.btn-cancel').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    modal.querySelector('.btn-save').onclick = () => {
      const text = modal.querySelector('#avito-note-text').value;
      const data = container ? extractData(container) : extractData(document.body);
      saveNote(id, { ...data, text });
      modal.remove();
      updateUI();
    };

    modal.querySelector('.btn-delete').onclick = () => {
      deleteNote(id);
      modal.remove();
      updateUI();
    };

    modal.querySelector('#avito-note-text').focus();
  }

  function updateUI() {
    document.querySelectorAll('.avito-notes-ui').forEach(ui => ui.remove());
    init();
  }

  function injectUI(container, isItemPage = false) {
    if (container.querySelector('.avito-notes-ui')) return;

    const id = getItemId(container);
    if (!id) {
      console.warn('[Avito Notes] Не удалось получить ID для контейнера', container);
      return;
    }

    const note = notesCache[id];
    const ui = document.createElement('div');
    ui.className = 'avito-notes-ui';

    if (isItemPage) {
      ui.style.cssText = `display: flex; gap: 10px; align-items: center; font-family: sans-serif; margin: 15px 0; padding: 10px; background: #f8f9fa; border-radius: 8px; border: 1px solid #eee; width: 100%; box-sizing: border-box;`;
    } else {
      ui.style.cssText = `display: flex; gap: 8px; align-items: center; font-family: sans-serif; margin-top: 8px;`;
    }

    ['✅', '❌', '❓'].forEach(emoji => {
      const btn = document.createElement('button');
      btn.textContent = emoji;
      btn.style.cssText = 'cursor:pointer; background:none; border:none; font-size:20px; opacity:0.4; transition:0.2s; padding: 4px;';
      if (note?.emoji === emoji) { btn.style.opacity = '1'; btn.style.transform = 'scale(1.2)'; }
      btn.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        const newEmoji = (note?.emoji === emoji) ? null : emoji;
        saveNote(id, { ...extractData(container), emoji: newEmoji });
        updateUI();
      };
      ui.appendChild(btn);
    });

    const textBtn = document.createElement('div');
    textBtn.style.cssText = 'cursor:pointer; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#333; padding: 4px 8px; background:#f0f0f0; border-radius:4px; font-size:13px;';
    textBtn.textContent = note?.text ? note.text.substring(0, 16) + (note.text.length > 16 ? '...' : '') : '💬 Заметка';
    textBtn.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      openNoteModal(id, note, container);
    };
    ui.appendChild(textBtn);

    if (!isItemPage) {
      const targetBlock = container.querySelector('[class*="titleStep"], [class*="listTopBlock"], [class*="priceStep"]') || container;
      targetBlock.appendChild(ui);
    } else {
      container.appendChild(ui);
    }
    console.log(`[Avito Notes] UI инжектирован для ID: ${id}, страница: ${isItemPage ? 'объявления' : 'списка'}`);
  }

  function init() {
    try {
      // 1. Список объявлений
      const listCards = document.querySelectorAll('[data-marker="item"][data-item-id], [data-marker="snippet-item"]');
      listCards.forEach(card => injectUI(card, false));

      // 2. Страница самого объявления
      if (window.location.pathname.includes('/item/')) {
        // Ищем надежный контейнер заголовка на странице объявления
        let titleInfo = document.querySelector('.js-item-view-title-info, [data-marker="item-view/title-info"]');

        if (titleInfo) {
          // Если нашли h1, берем его родителя
          if (titleInfo.tagName === 'H1') {
            titleInfo = titleInfo.closest('.js-item-view-title-info') || titleInfo.parentElement;
          }
          injectUI(titleInfo, true);
        } else {
          console.warn('[Avito Notes] Контейнер заголовка на странице объявления не найден');
        }
      }
    } catch (e) {
      console.error('[Avito Notes] Ошибка в init:', e);
    }
  }

  loadNotes().then(() => {
    init();
    const observer = new MutationObserver(() => init());
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
