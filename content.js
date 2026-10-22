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
 *  6. Всплывающий чат (мини-мессенджер), прикреплённый к объявлению: если в
 *     шапке чата рядом с именем продавца есть ссылка на объявление
 *     (a[data-marker="header/itemLink"]), под ней рисуется компактная панель
 *     статусов/заметки; метаданные для заметки берутся из самой шапки чата
 *     (название и цена в ссылке itemLink, картинка из превью), а не со
 *     страницы под модалкой.
 *  7. Заметки-эмодзи множественные: под капотом — массив строк `emojis`
 *     (например ['✅','🛠️']); легаси-строка `emoji` читается и мигрируется
 *     при первой записи. Фото первого изображения объявления сохраняется в
 *     поле `img` (со страницы объявления, с карточки выдачи и из превью
 *     шапки чата) и выводится в popup в списке объявлений.
 */
(function () {
  'use strict';

  if (window.avitoNotesInitialized) return;
  window.avitoNotesInitialized = true;

  const STORAGE_KEY = 'avito_notes_v1';
  // Набор заметок (эмодзи-статусов). Выбор МНОЖЕСТВЕННЫЙ: можно поставить
  // сколько угодно эмодзи из набора; под капотом хранится массив строк в
  // поле note.emojis (легаси-строка note.emoji читается и мигрируется).
  const EMOJIS = ['✅', '❌', '❓', '🛠️', '🕒'];
  const PREVIEW_LEN = 16;

  /* ---------------- Нормализация заметок ---------------- */

  // Приведение списка эмодзи к каноничному виду: массив уникальных непустых
  // строк в порядке набора EMOJIS. Строка (легаси-формат поля `emoji`) тоже
  // принимается — так старые записи читаются без отдельной миграции.
  function normalizeEmojis(value) {
    const arr = Array.isArray(value) ? value : value ? [value] : [];
    const set = new Set(arr.map((e) => String(e)).filter(Boolean));
    const ordered = EMOJIS.filter((e) => set.has(e));
    // Неизвестные (например, из будущей версии набора) — сохраняем в конце.
    [...set].forEach((e) => {
      if (!EMOJIS.includes(e)) ordered.push(e);
    });
    return ordered;
  }

  // Актуальные эмодзи заметки: новый массив `emojis`, либо легаси-строка
  // `emoji` (записи до перехода на множественный выбор).
  function noteEmojis(note) {
    if (!note) return [];
    if (Array.isArray(note.emojis)) return normalizeEmojis(note.emojis);
    return normalizeEmojis(note.emoji);
  }

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

  // Шапка всплывающего чата (мини-мессенджер, прикреплённый к объявлению):
  // рядом с именем продавца есть ссылка на объявление —
  //   <a data-marker="header/itemLink" href="/.../garazh_30_m_8457554115">…</a>
  // По её наличию определяем такой чат и рисуем в шапке компактную панель.
  // Селекторы хеш-классов не используем — они меняются от сборки к сборке.
  const CHAT_HEADER_ITEM_LINK = 'a[data-marker="header/itemLink"][href]';

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
  // эмодзи (emojis), ни текста — запись удаляется из хранилища полностью.
  // Эмодзи нормализуются в массив (`emojis`): легаси-строка `emoji` из
  // старых записей при любой новой записи мигрируется в массив.
  function persistNote(id, patch) {
    if (!id) {
      console.warn('[Avito Notes] Нет ID для сохранения');
      return;
    }
    const merged = { ...notesCache[id], ...patch, timestamp: Date.now() };
    if ('emojis' in patch || 'emoji' in patch) {
      merged.emojis = normalizeEmojis('emojis' in patch ? patch.emojis : patch.emoji);
      delete merged.emoji; // единый источник правды — emojis
    } else {
      merged.emojis = noteEmojis(merged);
      delete merged.emoji;
    }
    if (!merged.emojis.length && !String(merged.text || '').trim()) {
      delete notesCache[id];
    } else {
      notesCache[id] = merged;
    }
    chrome.storage.local.set({ [STORAGE_KEY]: notesCache });
  }

  function deleteNote(id) {
    delete notesCache[id];
    chrome.storage.local.set({ [STORAGE_KEY]: notesCache });
  }

  // Ссылка на само объявление — канонический адрес по id, а не URL страницы,
  // с которой заметка была сделана. Формат — https://www.avito.ru/<id>:
  // вариант /item/<id> Авито не открывает (редиректит/не находит), а по
  // «голым» цифрам в корне работает корректно — сервис сам разворачивает
  // адрес в актуальную страницу (город/категория/slug_<id>).
  function buildItemLink(id) {
    if (!id) return '';
    return `https://www.avito.ru/${encodeURIComponent(id)}`;
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

  // Фото первого изображения объявления. Надёжный источник на странице
  // объявления — галерея (#bx_item-gallery / data-marker main-gallery),
  // т.к. разметка с itemprop="image" в новых сборках отсутствует, а общий
  // «первый img» внутри контейнера мог оказаться аватаром продавца или
  // иконкой. Для карточек выдачи — изображение сниппета (lazy-src/alt).
  // Пропускаем пиксели-заглушки (1x1 data:), чтобы в заметку не попадал мусор.
  function isRealImageSrc(src) {
    if (!src) return false;
    if (src.startsWith('data:')) return !/;\s*base64,.{0,32}={0,2}$/.test(src);
    return true;
  }

  function firstImageUrl(scope) {
    if (!scope || !scope.querySelector) return '';
    const selectors = [
      '#bx_item-gallery img[src]',
      '[data-marker="item-view/main-gallery"] img[src]',
      'img[itemprop="image"]',
      '[data-marker="item-image"] img[src], [data-marker="snippet-image"] img[src], [data-marker="image-from-storage"] img[src]',
      '[data-marker="item-image"] img[data-lazy-load][src], [data-marker="snippet-image"] img[data-lazy-load][src]',
      'img[src]',
    ];
    for (const sel of selectors) {
      let nodes = [];
      try {
        nodes = scope.querySelectorAll(sel);
      } catch (e) { /* невалидный селектор */ }
      for (const el of nodes) {
        // src может быть data:-заглушкой, пока Авито подгружает картинку по
        // data-lazy-load — берём реальный адрес из дата-атрибута.
        const candidates = [el.getAttribute('data-lazy-load'), el.src, el.currentSrc];
        for (const c of candidates) {
          if (c && isRealImageSrc(c)) return c;
        }
      }
    }
    return '';
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
    // Фото первого изображения: сначала из контейнера (галерея страницы /
    // картинка карточки выдачи), затем — с уровня всей страницы.
    const img =
      firstImageUrl(root) ||
      (root !== document ? firstImageUrl(document) : '');
    // Координаты: страница карты Авито хранит их в data-атрибутах обёртки карты.
    let coords = null;
    try {
      const map = document.querySelector('[data-marker="item-map-wrapper"][data-map-lat][data-map-lon]');
      if (map) coords = { lat: map.dataset.mapLat, lon: map.dataset.mapLon };
    } catch (e) { /* ignore */ }
    return { title, price, link, img, coords };
  }

  /* ---------------- Рендер панели ---------------- */

  // Есть ли у объявления заметка (эмодзи и/или текст) — по этому же критерию
  // persistNote решает, хранить запись или удалить её.
  function hasNote(note) {
    return !!(note && (noteEmojis(note).length || String(note.text || '').trim()));
  }

  // Кнопки-заметки: множественный выбор — активны все эмодзи из массива
  // note.emojis (легаси-строка emoji тоже учитывается через noteEmojis).
  function emojiButtonsHtml(note) {
    const active = new Set(noteEmojis(note));
    return EMOJIS.map(
      (e) =>
        `<button class="an-btn${active.has(e) ? ' an-btn--active' : ''}"` +
        ` data-emoji="${e}" type="button" title="Заметка ${e}">${e}</button>`
    ).join('');
  }

  // Кнопки панелей по эмодзи: составные символы с variation selector
  // (например 🛠️ = U+1F6E0 U+FE0F) не матчатся css-селектором
  // [data-emoji="…"] в некоторых реализациях querySelector — ищем перебором
  // по dataset.
  function findEmojiButtons(root, emoji) {
    return [...root.querySelectorAll('.an-btn')].filter((b) => b.dataset.emoji === emoji);
  }

  function panelHtml(id, note) {
    const exists = hasNote(note);
    const preview = note?.text
      ? note.text.slice(0, PREVIEW_LEN) + (note.text.length > PREVIEW_LEN ? '…' : '')
      : '';
    const buttons = emojiButtonsHtml(note);
    // Чип: если заметки нет — лаконичное «+ Заметка»; если есть — превью
    // текста (или набор эмодзи, когда текста нет), чтобы по панели было видно,
    // что заметка существует и что в ней.
    const emojisStr = noteEmojis(note).join(' ');
    const chipLabel = exists ? (preview || emojisStr || '💬') : '+ Заметка';
    const chipCls = exists ? 'an-note-chip an-note-chip--has' : 'an-note-chip';
    const chipTitle = exists
      ? escapeAttr(`Заметка: ${note.text || '(без текста)'}`)
      : 'Добавить заметку';
    let html =
      buttons +
      `<span class="${chipCls}" title="${chipTitle}">${escapeHtml(chipLabel)}</span>`;
    // Удаление доступно прямо в панели — только когда заметка реально есть.
    if (exists) {
      html +=
        '<button class="an-del-btn" type="button" title="Удалить заметку">✕</button>';
    }
    return html;
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
    // Чат-панель компактнее (без ✕) — свой рендер.
    panel.innerHTML = panel.classList.contains('an-panel--chat')
      ? chatPanelHtml(note)
      : panelHtml(id, note);
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
        <h3 class="an-modal__title">${note ? 'Заметка' : 'Добавить заметку'}</h3>
        <textarea class="an-modal__textarea" placeholder="Текст заметки…"></textarea>
        <div class="an-modal__actions">
          <button class="an-modal__btn an-modal__btn--cancel" type="button">Отмена</button>
          ${note ? '<button class="an-modal__btn an-modal__btn--delete" type="button">Удалить</button>' : ''}
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

    // Кнопка «Удалить» есть только когда заметка уже существует.
    modal.querySelector('.an-modal__btn--delete')?.addEventListener('click', () => {
      deleteNote(id);
      patchAllForId(id);
      close();
    });

    document.body.appendChild(modal);
    textarea.focus();
  }

  /* ---------------- Инъекция панелей ---------------- */

  function createPanel(id, variant) {
    const panel = document.createElement('div');
    panel.className = 'an-panel' +
      (variant === 'item' ? ' an-panel--item' : variant === 'chat' ? ' an-panel--chat' : '');
    panel.dataset.itemId = id;
    // Чат-панель компактнее (без ✕) — свой рендер.
    panel.innerHTML = variant === 'chat'
      ? chatPanelHtml(notesCache[id])
      : panelHtml(id, notesCache[id]);
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

  /* ---------------- Всплывающий чат (мини-мессенджер) ---------------- */

  // Все шапки чатов, в которых рядом с именем продавца есть ссылка на
  // объявление (data-marker="header/itemLink"). Так отличаем чат,
  // прикреплённый к объявлению, от обычных переписок.
  function findChatHeaders() {
    const result = [];
    const seen = new Set();
    document.querySelectorAll(CHAT_HEADER_ITEM_LINK).forEach((link) => {
      const id = getItemIdFromUrl(link.href);
      if (!id) return;
      // Контейнер вставки — блок информации о чате: infoWrap (классы
      // хеш-сборки), иначе ближайший ancestor с wrap-, иначе container-,
      // иначе родитель блока ссылки (панель встанет под именем продавца
      // и ссылкой на объявление).
      const header =
        link.closest('[class*="infoWrap"]') ||
        link.closest('[class*="wrap-"]') ||
        link.closest('[class*="container-"]') ||
        link.parentElement;
      // Защита от дублей: если две ссылки оказались внутри одного контейнера.
      if (!header || seen.has(header)) return;
      seen.add(header);
      result.push({ header, link, id });
    });
    return result;
  }

  // Данные объявления берутся прямо из шапки чата (название + цена в ссылке
  // itemLink), а не со страницы под модалкой: под всплывающим чатом может
  // быть любая страница (поиск/каталог), где этих данных нет.
  function extractChatData(link, id) {
    const titleEl = link.querySelector('.subtitle-e80bf4537dbf73f0') ||
      // запасной вариант по стабильному elementtiming (хеш-классы меняются)
      link.querySelector('[elementtiming="msg.channel.item-title"]');
    const priceEl = link.querySelector('[class*="itemPrice"]');
    const clean = (s) => String(s || '').replace(/\u00a0/g, ' ').trim();
    // Фото первого изображения объявления — из превью в шапке чата: Авито
    // задаёт его как background-image на <a data-markers="itemPreview">;
    // если внутри превью <img> — берём src (с учётом lazy-load).
    let img = '';
    const previewScope = link.closest('[class*="container"]') || link.parentElement;
    const preview = previewScope?.querySelector('[data-markers="itemPreview"]');
    if (preview) {
      const bg = /url\("?([^")]+)"?\)/.exec(preview.getAttribute('style') || '')?.[1];
      img = (bg && isRealImageSrc(bg) ? bg : '') || firstImageUrl(preview);
    }
    return {
      title: clean(titleEl?.textContent) || 'Без названия',
      price: clean(priceEl?.textContent) || 'Цена не указана',
      link: buildItemLink(id),
      img,
      coords: null,
    };
  }

  // Компактная панель в шапке чата: только заметки-эмодзи и чип (без ✕ —
  // удаление доступно в модалке и на основной панели объявления).
  function chatPanelHtml(note) {
    const exists = hasNote(note);
    const preview = note?.text
      ? note.text.slice(0, PREVIEW_LEN) + (note.text.length > PREVIEW_LEN ? '…' : '')
      : '';
    const buttons = emojiButtonsHtml(note);
    const chipLabel = exists ? (preview || noteEmojis(note).join(' ') || '💬') : '+';
    const chipCls = exists ? 'an-note-chip an-note-chip--has' : 'an-note-chip';
    const chipTitle = exists
      ? escapeAttr(`Заметка: ${note.text || '(без текста)'}`)
      : 'Добавить заметку';
    return buttons + `<span class="${chipCls}" title="${chipTitle}">${escapeHtml(chipLabel)}</span>`;
  }

  // Единый обработчик кликов панелей через делегирование на document:
  // работает и для новых панелей (чат может появиться в любой момент),
  // и после перемонтажа шапки React без перепривязки слушателей.
  // id берётся из dataset панели, поэтому корректен даже если панель
  // переиспользована под другое объявление.
  function onPanelClick(e) {
    const panel = e.target.closest?.('.an-panel');
    if (!panel) return;
    const id = panel.dataset.itemId;
    if (!id) return;

    const btn = e.target.closest('.an-btn');
    const chip = !btn && e.target.closest('.an-note-chip');
    const del = !btn && !chip && e.target.closest('.an-del-btn');
    if (!btn && !chip && !del) return;

    e.preventDefault();
    e.stopPropagation();

    if (btn) {
      // Множественный выбор: клик по эмодзи добавляет его к набору, повторный
      // клик по активному — убирает. Под капотом — массив строк `emojis`.
      const emoji = btn.dataset.emoji;
      const current = noteEmojis(notesCache[id]);
      const next = current.includes(emoji)
        ? current.filter((x) => x !== emoji)
        : [...current, emoji];
      // Метаданные: для чата — из шапки чата (под модалкой может быть любая
      // страница), иначе — с карточки/страницы объявления.
      const chatLink = panel.classList.contains('an-panel--chat')
        ? panel.parentElement?.querySelector(CHAT_HEADER_ITEM_LINK)
        : null;
      const data = chatLink
        ? extractChatData(chatLink, id)
        : extractData(findHostCard(id) || document.body, id);
      persistNote(id, { ...data, emojis: next });
      patchAllForId(id);
    } else if (chip) {
      openNoteModal(id);
    } else if (del) {
      deleteNote(id);
      patchAllForId(id);
    }
  }

  document.addEventListener('click', onPanelClick, true);

  // Расставить компактные панели по шапкам всплывающих чатов.
  function injectChatPanels() {
    findChatHeaders().forEach(({ header, id }) => {
      // Уже есть панель этого объявления в этой шапке — не трогаем
      // (обработчики делегированы, перепривязка не нужна).
      const existing = header.querySelector(':scope > .an-panel--chat');
      if (existing && existing.dataset.itemId === id) return;
      if (existing) existing.remove(); // id изменился (шапка переиспользована под другой чат)
      header.appendChild(createPanel(id, 'chat'));
    });
  }

  function init() {
    try {
      injectListPanels();
      injectItemPanel();
      injectChatPanels();
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
