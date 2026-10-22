/* Avito Notes — content script.
 *
 * Инжектирует панели заметок на карточки в списках и на страницу объявления.
 * Данные хранятся в chrome.storage.local (единый источник для popup.js).
 *
 * Ключевые исправления относительно прошлой версии:
 *  1. Панель на странице объявления больше не теряется: контейнер ищется по
 *     нескольким современным селекторам, а если он ещё не отрисован (SPA),
 *     поиск повторяется через MutationObserver; панель вставляется как можно
 *     глубже (рядом с заголовком), чтобы не попадать под CSS-обрезки родителя.
 *  2. updateUI() больше не пересоздаёт все панели после каждого изменения —
 *     это ломало фокус в модалке и вызывало бесконечные цикл observers.
 *     Вместо этого работает точечное обновление (patch) конкретной панели.
 *  3. Стили вынесены в styles.css (ранее инлайновые стили конфликтовали с
 *     фреймворком страницы и терялись при re-render компонентов Авито).
 */
(function () {
  'use strict';

  if (window.avitoNotesInitialized) return;
  window.avitoNotesInitialized = true;

  const STORAGE_KEY = 'avito_notes_v1';
  const EMOJIS = ['✅', '❌', '❓'];
  const PREVIEW_LEN = 16;

  // Контейнеры панели на странице объявления — в порядке надёжности.
  // Вставляем панель внутрь самого внутреннего найденного блока, чтобы
  // родительские overflow/grid не «съедали» контролы.
  const ITEM_PANEL_SELECTORS = [
    '.item-view-title',                       // текущая разметка Авито
    '[data-marker="item-view/title-info"]',
    '.js-item-view-title-info',
    '#item-description',
    '[data-marker="item-view/description"]',
  ];

  let notesCache = {};

  /* ---------------- Хранилище ---------------- */

  function loadNotes() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (data) => {
        notesCache = data[STORAGE_KEY] || {};
        resolve(notesCache);
      });
    });
  }

  // Единая точка записи: синхронизируем кэш и пишем только весь объект целиком,
  // чтобы параллельные set() не затёрли чужие записи.
  function persistNote(id, patch) {
    if (!id) {
      console.warn('[Avito Notes] Нет ID для сохранения');
      return;
    }
    notesCache[id] = { ...notesCache[id], ...patch, timestamp: Date.now() };
    chrome.storage.local.set({ [STORAGE_KEY]: notesCache });
  }

  function deleteNote(id) {
    delete notesCache[id];
    chrome.storage.local.set({ [STORAGE_KEY]: notesCache });
  }

  // Синхронизация между вкладками/popup: перечитываем кэш и обновляем панели.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    notesCache = changes[STORAGE_KEY].newValue || {};
    refreshAllPanels();
  });

  /* ---------------- Извлечение данных объявления ---------------- */

  function getItemId(container) {
    const itemId = container.getAttribute('data-item-id');
    if (itemId) return itemId;

    if (container.id && container.id.startsWith('i')) {
      return container.id.substring(1);
    }

    const link = container.querySelector('a[href*="/item/"], a[href*="_"]')?.href;
    if (link) {
      const fromLink = getItemIdFromUrl(link);
      if (fromLink) return fromLink;
    }

    if (isItemPage()) {
      return getItemIdFromUrl(window.location.href);
    }

    return null;
  }

  // Страница объявления определяется по сегменту /item/ в URL
  // (https://www.avito.ru/item/123456789 или старый формат
  // /profile/offers/item/slug_123456789). Раньше использовалось
  // pathname.match(/_(\d+)/) без привязки к сегменту — из-за этого на
  // актуальных страницах Авито id не находился и панель не появлялась.
  function isItemPage() {
    return /\/item\//.test(window.location.pathname);
  }

  // Извлечение id объявления из URL: цифры после последнего подчёркивания
  // пути (slug_123456789), либо просто последний числовой сегмент (/item/123456789).
  function getItemIdFromUrl(urlLike) {
    try {
      const path = new URL(urlLike, window.location.origin).pathname;
      const lastSegment = path.split('/').filter(Boolean).pop() || '';
      let m = lastSegment.match(/_(\d{5,15})(?:\.html)?$/);
      if (m) return m[1];
      m = lastSegment.match(/^(\d{5,15})$/);
      if (m) return m[1];
    } catch (e) { /* невалидный URL */ }
    return null;
  }

  function extractData(container) {
    const root = container && container !== document.body ? container : document;
    const title =
      root.querySelector(
        '[data-marker="item-title"], [data-marker="item-view/title-info"] h1, #item-description h1, h1'
      )?.textContent.trim() || 'Без названия';
    const price =
      root.querySelector(
        '[data-marker="item-price-value"], [data-marker="item-view/item-price"], .c-v-view-on-map-window-label'
      )?.textContent.trim() || 'Цена не указана';
    let link = root.querySelector?.('a[href*="/item/"]')?.href;
    if (!link || isItemPage()) link = window.location.href.split('#')[0];
    const img =
      root.querySelector?.('img[itemprop="image"]')?.src ||
      root.querySelector?.('img')?.src || '';
    return { title, price, link, img, coords: null };
  }

  /* ---------------- Рендер панели ---------------- */

  function panelHtml(id, note) {
    const preview = note?.text
      ? note.text.slice(0, PREVIEW_LEN) + (note.text.length > PREVIEW_LEN ? '…' : '')
      : '💬 Заметка';
    const buttons = EMOJIS.map(
      (e) =>
        `<button class="an-btn${note?.emoji === e ? ' an-btn--active' : ''}"` +
        ` data-emoji="${e}" type="button" title="Статус ${e}">${e}</button>`
    ).join('');
    return (
      buttons +
      `<span class="an-note-chip" title="${escapeAttr(note?.text || '')}">${escapeHtml(preview)}</span>`
    );
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/\n/g, ' ');
  }

  // Экранирование для использования в селекторе (CSS.escape есть не везде).
  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_\-]/g, '\\$&');
  }

  // Точечное обновление существующей панели вместо удаления/пересоздания.
  function patchPanel(panel, id) {
    const note = notesCache[id];
    panel.dataset.itemId = id;
    panel.innerHTML = panelHtml(id, note);
    bindPanelEvents(panel, id);
  }

  function bindPanelEvents(panel, id) {
    panel.querySelectorAll('.an-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const emoji = btn.dataset.emoji;
        const current = notesCache[id]?.emoji;
        const container = findHostCard(id) || document.body;
        persistNote(id, { ...extractData(container), emoji: current === emoji ? null : emoji });
        patchAllForId(id);
      });
    });

    panel.querySelector('.an-note-chip')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openNoteModal(id);
    });
  }

  function patchAllForId(id) {
    document
      .querySelectorAll(`.an-panel[data-item-id="${cssEscape(id)}"]`)
      .forEach((p) => patchPanel(p, id));
  }

  function refreshAllPanels() {
    document.querySelectorAll('.an-panel[data-item-id]').forEach((p) => {
      patchPanel(p, p.dataset.itemId);
    });
  }

  // Найти исходный контейнер объявления по id (для повторного извлечения данных).
  function findHostCard(id) {
    if (isItemPage()) {
      for (const selector of ITEM_PANEL_SELECTORS) {
        const host = document.querySelector(selector);
        if (host) return /^H[1-6]$/.test(host.tagName) ? host.parentElement || host : host;
      }
      return document.body;
    }
    return (
      document.querySelector(`[data-item-id="${cssEscape(id)}"]`) ||
      document.getElementById('i' + id)
    );
  }

  /* ---------------- Модалка заметки ---------------- */

  function openNoteModal(id) {
    document.querySelector('.an-modal')?.remove();

    const note = notesCache[id];
    const modal = document.createElement('div');
    modal.className = 'an-modal';
    modal.innerHTML = `
      <div class="an-modal__box">
        <h3 class="an-modal__title">Заметка</h3>
        <textarea class="an-modal__textarea" placeholder="Текст заметки…"></textarea>
        <div class="an-modal__actions">
          <button class="an-modal__btn an-modal__btn--cancel" type="button">Отмена</button>
          <button class="an-modal__btn an-modal__btn--delete" type="button">Удалить</button>
          <button class="an-modal__btn an-modal__btn--save" type="button">Сохранить</button>
        </div>
      </div>`;

    const textarea = modal.querySelector('.an-modal__textarea');
    textarea.value = note?.text || '';

    const close = () => {
      modal.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };

    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });
    document.addEventListener('keydown', onKey);

    modal.querySelector('.an-modal__btn--cancel').onclick = close;

    modal.querySelector('.an-modal__btn--save').onclick = () => {
      const container = findHostCard(id) || document.body;
      persistNote(id, { ...extractData(container), text: textarea.value.trim() });
      patchAllForId(id);
      close();
    };

    modal.querySelector('.an-modal__btn--delete').onclick = () => {
      deleteNote(id);
      patchAllForId(id);
      close();
    };

    document.body.appendChild(modal);
    textarea.focus();
  }

  /* ---------------- Инъекция панелей ---------------- */

  function createPanel(id, variant) {
    const panel = document.createElement('div');
    panel.className = 'an-panel' + (variant === 'item' ? ' an-panel--item' : '');
    panel.dataset.itemId = id;
    panel.innerHTML = panelHtml(id, notesCache[id]);
    bindPanelEvents(panel, id);
    return panel;
  }

  // Список объявлений (поиск, каталог, карта).
  function injectListPanels() {
    const cards = document.querySelectorAll(
      '[data-marker="item"][data-item-id], [data-marker="snippet-item"]'
    );
    cards.forEach((card) => {
      const id = getItemId(card);
      if (!id) return;
      // Уже есть наша панель с актуальным id — не трогаем (важно для SPA-ререндера).
      const existing = card.querySelector(':scope > .an-panel, .an-panel');
      if (existing && existing.dataset.itemId === id) return;

      // Вставляем в конец карточки, но не внутрь <a>, иначе клик по ссылке
      // перехватывал бы все нажатия на кнопки.
      const anchor = card.matches('a') ? card : null;
      const target = anchor ? anchor.parentElement : card;
      target.appendChild(createPanel(id, 'list'));
    });
  }

  // Страница конкретного объявления.
  function injectItemPanel() {
    if (!isItemPage()) return;

    const id = getItemId(document.body);
    if (!id) return;

    const existing = document.querySelector('.an-panel--item');
    if (existing) {
      if (existing.dataset.itemId !== id) {
        existing.remove(); // id изменился (переход между объявлениями без перезагрузки)
      } else {
        return;
      }
    }

    for (const selector of ITEM_PANEL_SELECTORS) {
      const host = document.querySelector(selector);
      if (!host) continue;

      // Если хост — сам заголовок h1, вставляем панель после него,
      // а не внутрь (внутри h1 контролы обрезались стилями заголовка).
      if (/^H[1-6]$/.test(host.tagName)) {
        const wrapper = document.createElement('div');
        wrapper.appendChild(createPanel(id, 'item'));
        host.after(wrapper);
      } else {
        host.appendChild(createPanel(id, 'item'));
      }
      return;
    }
    // Ни один контейнер ещё не найден — попробуем позже, когда SPA отрисует страницу.
  }

  function init() {
    try {
      injectListPanels();
      injectItemPanel();
    } catch (e) {
      console.error('[Avito Notes] Ошибка в init:', e);
    }
  }

  /* ---------------- Наблюдатель за DOM ---------------- */

  // Debounce: Авито — SPA с постоянными мутациями DOM, гонять init()
  // на каждую мутацию нельзя.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      init();
    }, 300);
  });

  loadNotes().then(() => {
    init();
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
