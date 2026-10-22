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
 *  4. Страница объявления определяется по DOM-разметке, а не по URL: у
 *     актуальных адресов Авито вида
 *     /voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601 нет сегмента
 *     /item/, из-за чего isItemPage() возвращал false и injectItemPanel()
 *     молча выходил — контролы не появлялись совсем.
 *  5. Хост панели ищется среди стабильных якорей разметки (h1 с
 *     data-marker="item-view/title-info", .js-item-view-main, id-контейнеры):
 *     хешированные классы Авито меняются от сборки к сборке, но data-marker /
 *     js-* классы сохраняются. Панель вставляется СОСЕДОМ к якорю (после h1),
 *     а не внутрь него, и перед каждой вставкой проверяется, что она всё ещё
 *     в DOM — React может перестроить дерево в течение жизни страницы.
 */
(function () {
  'use strict';

  if (window.avitoNotesInitialized) return;
  window.avitoNotesInitialized = true;

  const STORAGE_KEY = 'avito_notes_v1';
  const EMOJIS = ['✅', '❌', '❓'];
  const PREVIEW_LEN = 16;

  // Стабильные якоря страницы объявления (не зависят от хеш-классов сборки).
  // Каждый якорь описывает, КУДА вставлять панель относительно него:
  //   after  — сразу после элемента (панель становится соседом, а не ребёнком:
  //            так её не обрежут overflow/height родителя заголовка и её не
  //            перерисует React-компонент заголовка);
  //   append — внутрь элемента.
  // Порядок — от наиболее точного к запасным.
  const ITEM_ANCHORS = [
    { selector: 'h1[data-marker="item-view/title-info"]', mode: 'after' },
    { selector: '.js-item-view-title-info', mode: 'append' },
    { selector: '[data-marker="item-view/title-info"]', mode: 'after' },
    { selector: '#bx_item-price-value', mode: 'after' },
    { selector: '#bx_item-params', mode: 'before' },
    { selector: '.js-item-view-main', mode: 'prepend' },
    { selector: '#item-description', mode: 'append' },
    { selector: '[data-marker="item-view/item-description"]', mode: 'append' },
  ];

  // Признаки страницы объявления в DOM. URL ненадёжен: актуальный адрес
  // объявления — /voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601,
  // без сегмента /item/; при этом old avito-разметка могла давать /item/.
  const ITEM_PAGE_MARKERS = [
    'h1[data-marker="item-view/title-info"]',
    '.js-item-view-title-info',
    '[data-marker="item-view/main-gallery"]',
    '[data-marker="item-view/item-price"]',
    '#bx_item-gallery',
    '#bx_item-description',
    '[data-marker="item-view/abuse-button"]',
    '[data-marker="item-view/item-id"]',
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
  // Пустая заметка не хранится: если после применения патча в ней нет ни
  // статуса (emoji), ни текста — запись удаляется из хранилища полностью.
  function persistNote(id, patch) {
    if (!id) {
      console.warn('[Avito Notes] Нет ID для сохранения');
      return;
    }
    const next = { ...notesCache[id], ...patch, timestamp: Date.now() };
    if (!next.emoji && !String(next.text || '').trim()) {
      delete notesCache[id];
    } else {
      notesCache[id] = next;
    }
    chrome.storage.local.set({ [STORAGE_KEY]: notesCache });
  }

  function deleteNote(id) {
    delete notesCache[id];
    chrome.storage.local.set({ [STORAGE_KEY]: notesCache });
  }

  // Ссылка на само объявление — канонический адрес по id, а не URL страницы,
  // с которой заметка была сделана. На выдаче Авито ссылка вида /item/<id>
  // ведёт через «загрузочный» редирект (в т.ч. на поиск), поэтому храним
  // прямой адрес объявления: Авито сам разворачивает его в актуальный
  // канонический URL (город/категория/slug_<id>).
  function buildItemLink(id) {
    if (!id) return '';
    return `https://www.avito.ru/item/${encodeURIComponent(id)}`;
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

  // Страница объявления: сначала по стабильным DOM-якорям (разметка надёжнее
  // URL), затем — по формату адреса (/item/123 или старый slug_123456789).
  // Раньше использовалось только /\/item\// из pathname, но актуальные адреса
  // объявлений не содержат этого сегмента — панель не появлялась.
  function isItemPage() {
    if (itemPageByLayout()) return true;
    return hasItemIdUrl(window.location.pathname);
  }

  // Только признаки в разметке (без URL) — чтобы список-страница с ссылкой на
  // /item/ внутри карточки не определялся как страница объявления.
  function itemPageByLayout() {
    for (const marker of ITEM_PAGE_MARKERS) {
      try {
        if (document.querySelector(marker)) return true;
      } catch (e) { /* невалидный селектор — пропускаем */ }
    }
    return false;
  }

  // Содержит ли путь id объявления в любом из известных форматов?
  function hasItemIdUrl(pathname) {
    if (/\/item\/\d+/.test(pathname)) return true;
    const lastSegment = pathname.split('/').filter(Boolean).pop() || '';
    return /_\d{5,15}(\.html)?$/.test(lastSegment);
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

  // Метаданные объявления для заметки. id передаётся явно: ссылка всегда
  // строится на само объявление (buildItemLink), а не наследуется от адреса,
  // с которого заметка была сделана (иначе клик в popup открывал поиск).
  function extractData(container, id) {
    const root = container && container !== document.body ? container : document;
    // Панель на странице объявления вставляется соседом к якорю (например,
    // сразу после h1), поэтому контейнер может быть слишком узким — данные
    // ищем сначала в нём, затем на всей странице.
    const pick = (selectors, from) => {
      for (const s of selectors) {
        try {
          const el = from.querySelector(s);
          if (el) return el.textContent.trim();
        } catch (e) { /* ignore */ }
      }
      return '';
    };
    const pickAny = (selectors) =>
      pick(selectors, root) || (root !== document ? pick(selectors, document) : '');

    const title =
      pickAny(['[data-marker="item-view/title-info"]', '[data-marker="item-title"]', 'h1']) ||
      'Без названия';
    const price =
      pickAny([
        '#bx_item-price-value',
        '[data-marker="item-view/item-price"]',
        '[data-marker="item-price-value"]',
        '.c-v-view-on-map-window-label',
      ]) || 'Цена не указана';
    // Ссылка — канонический адрес объявления по id, а не URL страницы/карточки,
    // с которой заметка была сделана (иначе клик в popup открывал поиск).
    const link = buildItemLink(id);
    const img =
      root.querySelector?.('img[itemprop="image"]')?.src ||
      root.querySelector?.('img[src]')?.src ||
      document.querySelector?.('#bx_item-gallery img[src]')?.src ||
      '';
    // Координаты: страница карты Авито хранит их в data-атрибутах обёртки карты.
    let coords = null;
    try {
      const map = document.querySelector('[data-marker="item-map-wrapper"][data-map-lat][data-map-lon]');
      if (map) coords = { lat: map.dataset.mapLat, lon: map.dataset.mapLon };
    } catch (e) { /* ignore */ }
    return { title, price, link, img, coords };
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
        // Снимаем статус: если текст пустой, persistNote удалит заметку целиком
        // (пустые заметки не храним).
        persistNote(id, { ...extractData(container, id), emoji: current === emoji ? null : emoji });
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
      const anchor = findItemAnchor();
      return anchor ? anchor.el : document.body;
    }
    return (
      document.querySelector(`[data-item-id="${cssEscape(id)}"]`) ||
      document.getElementById('i' + id)
    );
  }

  // Первый найденный якорь страницы объявления.
  function findItemAnchor() {
    for (const anchor of ITEM_ANCHORS) {
      try {
        const el = document.querySelector(anchor.selector);
        if (el) return { el, mode: anchor.mode };
      } catch (e) { /* невалидный селектор — пропускаем */ }
    }
    return null;
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
      // Пустой текст + отсутствие статуса => persistNote удалит заметку.
      persistNote(id, { ...extractData(container, id), text: textarea.value.trim() });
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

    const id = getItemIdFromUrl(window.location.href);
    if (!id) return;

    const existing = document.querySelector('.an-panel--item');
    if (existing && existing.dataset.itemId === id) {
      // Авито (React) может перестроить/перемонтировать дерево в течение
      // жизни страницы: панель могла быть удалена или осиротеть (её якорь
      // заменён). Проверяем, что она всё ещё на месте и привязана к живому
      // родителю, иначе удаляем и ставим заново у актуального якоря.
      if (document.contains(existing) && isPanelWellPlaced(existing)) return;
      existing.remove();
    } else if (existing) {
      existing.remove(); // id изменился (переход между объявлениями без перезагрузки)
    }

    const found = findItemAnchor();
    if (!found) return; // SPA ещё не отрисовал страницу — повторит observer.

    const panel = createPanel(id, 'item');
    insertRelativeTo(panel, found.el, found.mode);
  }

  // Вставка панели относительно якоря согласно режиму.
  function insertRelativeTo(panel, anchor, mode) {
    switch (mode) {
      case 'after':
        anchor.after(panel);
        break;
      case 'before':
        anchor.before(panel);
        break;
      case 'prepend':
        anchor.insertBefore(panel, anchor.firstChild);
        break;
      case 'append':
      default:
        anchor.appendChild(panel);
    }
  }

  // Панель «на месте», если её родитель всё ещё в DOM и содержит хотя бы
  // один из якорей объявления (т.е. мы не остались в выброшенном поддереве).
  function isPanelWellPlaced(panel) {
    const parent = panel.parentElement;
    if (!parent || !document.contains(parent)) return false;
    return ITEM_ANCHORS.some((a) => {
      try {
        return (
          parent.contains(document.querySelector(a.selector)) ||
          !!parent.querySelector(a.selector)
        );
      } catch (e) {
        return false;
      }
    });
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

  function start() {
    loadNotes().then(() => {
      init();
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  // document_idle обычно гарантирует body, но при подгрузке скрипта позже
  // (или в тестовой среде) body может ещё не существовать.
  if (document.body) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  // SPA-навигация между объявлениями без перезагрузки страницы: меняем URL —
  // обновляем панель сразу, не дожидаясь debounce-мутаций.
  window.addEventListener('popstate', () => init());
})();
