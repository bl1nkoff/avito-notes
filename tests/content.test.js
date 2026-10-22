/* Тесты content.js: инъекция панели заметок на страницу объявления Авито.

 * Регрессия, которую проверяют эти тесты: страница объявления имеет адрес
 * вида /voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601 (без сегмента
 * /item/), а хеш-классы вроде _879c1d560da82247 меняются от сборки к сборке.
 * Старая isItemPage() смотрела только URL и возвращала false — контролы
 * вообще не появлялись. Теперь страница определяется по стабильным якорям
 * разметки (data-marker / js-* классы), панель вставляется соседом к h1, а
 * MutationObserver переинжектирует её, если Авито перестроил дерево.
 *
 * Запуск: node tests/content.test.js  (или npm test)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const CONTENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

// Фрагмент реальной страницы объявления (сокращён, стабильные атрибуты сохранены).
const ITEM_PAGE_HTML = `<!DOCTYPE html><html><body>
<div class="d9134745e0e171a2"><div><div class="js-item-view-title-info"><div class="_879c1d560da82247">
  <h1 class="_1b0cf6547f9bbbe8" data-marker="item-view/title-info">Гараж, 20&nbsp;м²</h1>
  <div><span id="bx_item-price-value"><span data-marker="item-view/item-price">620&nbsp;000&nbsp;₽</span></span></div>
</div></div></div></div>
<div class="_0d738543d14bfefa js-item-view-main">
  <div id="bx_item-gallery" data-marker="item-view/main-gallery">
    <img src="https://b00.img.avito.st/image/1/example.jpg" alt="Гараж">
  </div>
  <div id="bx_item-params" data-marker="item-view/item-params"></div>
  <div data-marker="item-map-wrapper" data-map-lat="51.627068" data-map-lon="39.18012"></div>
  <div id="bx_item-description"><div data-marker="item-view/item-description"><p>Продам гараж.</p></div></div>
  <button data-marker="item-view/abuse-button">Пожаловаться</button>
</div>
</body></html>`;

// Страница поиска: карточки + одна ссылка на /item/ внутри — не должна
// определяться как страница объявления.
const SEARCH_PAGE_HTML = `<!DOCTYPE html><html><body>
<div class="catalog">
  <div data-marker="item" data-item-id="111222333"><a href="/moskva/professionnye_instrumenty/torgovyi_avtomat_111222333">Автомат</a></div>
  <div data-marker="item" data-item-id="444555666"><a href="/item/444555666">Что-то ещё</a></div>
</div>
</body></html>`;

// Реальная шапка всплывающего чата, прикреплённого к объявлению
// (мини-мессенджер): рядом с именем продавца есть ссылка на объявление —
// <a data-marker="header/itemLink" href="/.../garazh_30_m_8457554115">.
// Сокращено, стабильные атрибуты (data-marker / elementtiming) сохранены.
const CHAT_INFO_WRAP_INNER = `<div class="infoWrap-_08b2408e96376dfc"><div class="infoContainer-_08b2408e96376dfc"><div class="nameWrapper-_08b2408e96376dfc"><div class="nameContainer-_08b2408e96376dfc"><a class="name-_08b2408e96376dfc name_link-_08b2408e96376dfc" data-marker="header/authorName" href="/user/5613d5e58db907fb786a94013d8f5f78/profile?id=8457554115&amp;iid=8457554115" title="Перейти в профиль"><h5>Анна</h5></a><span class="onlineStatus-_08b2408e96376dfc" data-marker="header/onlineStatus"></span></div></div><span class="size_s-_3fa85e8f9068ee6a"><a data-marker="header/itemLink" href="/voronezh/garazhi_i_mashinomesta/garazh_30_m_8457554115" class="root-e80bf4537dbf73f0 root_link-e80bf4537dbf73f0"><span elementtiming="msg.channel.item-title" class="subtitle-e80bf4537dbf73f0">Гараж, &gt;&nbsp;30&nbsp;м²</span><span class="itemPrice-e80bf4537dbf73f0">630&nbsp;000 ₽</span></a></span></div></div>`;

const CHAT_BODY_ONLY = `<div class="container-_08b2408e96376dfc container_mini-_08b2408e96376dfc"><div class="wrap-_08b2408e96376dfc"><div class="previewWrap-_08b2408e96376dfc"><div class="root-f4c005339e7b8e05"><a href="/voronezh/garazhi_i_mashinomesta/garazh_30_m_8457554115" target="_blank" data-markers="itemPreview" class="root-cc7042c4dd5ae53f" style="width: 48px; height: 48px; background-image: url(&quot;https://c70.img.avito.st/image/1/1.K4kaqLaxh2A0CVdjQKgUqBwIhWCoHYNi.DCINM1PPFRs&quot;); background-size: cover;"></a></div></div>${CHAT_INFO_WRAP_INNER}<div class="chatButtons-_08b2408e96376dfc"></div></div></div>`;

const CHAT_HEADER_HTML = `<!DOCTYPE html><html><body>${CHAT_BODY_ONLY}</body></html>`;

// Страница объявления №8457554115 + поверх неё открытый всплывающий чат
// по этому же объявлению — обе панели должны жить одновременно.
const ITEM_PAGE_30_HTML = `<!DOCTYPE html><html><body>
<div class="js-item-view-title-info"><h1 data-marker="item-view/title-info">Гараж, 30&nbsp;м²</h1>
  <div><span id="bx_item-price-value"><span data-marker="item-view/item-price">630&nbsp;000&nbsp;₽</span></span></div>
</div>
<div class="js-item-view-main">
  <div id="bx_item-gallery" data-marker="item-view/main-gallery"><img src="https://b00.img.avito.st/image/1/item30.jpg"></div>
  <div id="bx_item-description"><div data-marker="item-view/item-description"><p>Продам гараж.</p></div></div>
</div>`;

let passed = 0;
async function runTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓', name);
  } catch (err) {
    console.error('  ✗', name);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

// Прогон content.js в jsdom с моком chrome.storage.
function makeEnv({ url, html }) {
  const storage = {};
  let storedKey = null;
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.chrome = {
    storage: {
      local: {
        get: (keys, cb) => cb({ [storedKey || 'avito_notes_v1']: JSON.parse(JSON.stringify(storage[storedKey] || {})) }),
        set: (obj) => {
          const [k, v] = Object.entries(obj)[0];
          storedKey = k;
          storage[k] = JSON.parse(JSON.stringify(v));
        },
      },
      onChanged: { addListener: () => {} },
    },
  };
  // eslint-disable-next-line no-new-func
  window.eval(CONTENT_SRC);
  return { dom, window, getStored: () => JSON.parse(JSON.stringify(storage.avito_notes_v1 || {})) };
}

const tick = (window, ms = 50) =>
  new Promise((r) => window.setTimeout(r, ms)); // дать loadNotes().then(...) доработать

async function main() {
  console.log('content.js интеграционные тесты (jsdom)');

  /* ---------------- Страница объявления ---------------- */
  console.log('\nстраница объявления (garazh_20_m_8093949601):');

    await runTest('панель появляется без сегмента /item/ в URL', async () => {
    const { window } = makeEnv({
      url: 'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601',
      html: ITEM_PAGE_HTML,
    });
    await tick(window);
    const panel = window.document.querySelector('.an-panel--item');
    assert.ok(panel, 'панель не найдена');
    assert.strictEqual(panel.dataset.itemId, '8093949601');
    assert.strictEqual(panel.querySelectorAll('.an-btn').length, 3, 'нет трёх кнопок-статусов');
    assert.ok(panel.querySelector('.an-note-chip'), 'нет чипа заметки');
    // Заметки ещё нет — чип показывает лаконичное «добавить заметку»,
    // кнопки удаления быть не должно.
    assert.strictEqual(panel.querySelector('.an-note-chip').textContent, '+ Заметка');
    assert.ok(!panel.querySelector('.an-del-btn'), 'кнопка удаления без заметки');
  });

    await runTest('панель вставлена сразу после h1 (не внутрь него)', async () => {
    const { window } = makeEnv({
      url: 'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601',
      html: ITEM_PAGE_HTML,
    });
    await tick(window);
    const h1 = window.document.querySelector('h1[data-marker="item-view/title-info"]');
    assert.strictEqual(h1.nextElementSibling, window.document.querySelector('.an-panel--item'));
    assert.strictEqual(h1.querySelector('.an-panel'), null, 'панель не должна быть внутри h1');
  });

    await runTest('клик по ✅ сохраняет статус и метаданные (цена/ссылка/координаты)', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601',
      html: ITEM_PAGE_HTML,
    });
    await tick(env.window);
    const btn = env.window.document.querySelector('.an-panel--item .an-btn[data-emoji="✅"]');
    btn.click();
    await tick(env.window);
    const note = env.getStored()['8093949601'];
    assert.ok(note, 'заметка не сохранена');
    assert.strictEqual(note.emoji, '✅');
    assert.match(note.title, /Гараж, 20/);
    assert.match(note.price, /620\s*000/u);
    assert.strictEqual(note.link, 'https://www.avito.ru/8093949601');
    assert.deepStrictEqual(note.coords, { lat: '51.627068', lon: '39.18012' });
    // UI обновился: кнопка стала активной
    const active = env.window.document.querySelectorAll('.an-panel--item .an-btn--active');
    assert.strictEqual(active.length, 1);
  });

    await runTest('повторный клик по активному статусу снимает его', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601',
      html: ITEM_PAGE_HTML,
    });
    await tick(env.window);
    const sel = '.an-panel--item .an-btn[data-emoji="❌"]';
    env.window.document.querySelector(sel).click();
    await tick(env.window);
    assert.strictEqual(env.getStored()['8093949601'].emoji, '❌');
    // Второй клик без текста удалил бы пустую заметку целиком (см. отдельный
    // тест) — добавим текст, чтобы проверить именно «переключение» статуса.
    env.window.document.querySelector('.an-panel--item .an-note-chip').click();
    const modal = env.window.document.querySelector('.an-modal');
    modal.querySelector('.an-modal__textarea').value = 'заметка есть';
    modal.querySelector('.an-modal__btn--save').click();
    await tick(env.window);
    env.window.document.querySelector(sel).click();
    await tick(env.window);
    const note = env.getStored()['8093949601'];
    assert.strictEqual(note.emoji, null, 'статус должен сняться');
    assert.strictEqual(note.text, 'заметка есть', 'заметка с текстом остаётся в хранилище');
  });

    await runTest('чип заметки открывает модалку, сохранение текста пишется в storage', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601',
      html: ITEM_PAGE_HTML,
    });
    await tick(env.window);
    env.window.document.querySelector('.an-panel--item .an-note-chip').click();
    const modal = env.window.document.querySelector('.an-modal');
    assert.ok(modal, 'модалка не открылась');
    modal.querySelector('.an-modal__textarea').value = 'Смотреть в субботу';
    modal.querySelector('.an-modal__btn--save').click();
    await tick(env.window);
    assert.strictEqual(env.getStored()['8093949601'].text, 'Смотреть в субботу');
    assert.ok(env.window.document.querySelector('.an-panel--item .an-note-chip').textContent.includes('Смотреть'));
  });

  /* ---------------- Перестройка дерева Авито (SPA) ---------------- */
  console.log('\nперестройка DOM-Aвито после инъекции:');

    await runTest('панель удалена React-перемонтажом — observer ставит её заново', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601',
      html: ITEM_PAGE_HTML,
    });
    const { window } = env;
    const { document } = window;
    await tick(window);
    assert.ok(document.querySelector('.an-panel--item'));

    // Эмуляция перемонтажа заголовка: родитель h1 заменён новым поддеревом.
    const oldWrap = document.querySelector('.js-item-view-title-info');
    const parent = oldWrap.parentElement;
    const newWrap = document.createElement('div');
    newWrap.className = 'js-item-view-title-info';
    const newH1 = document.createElement('h1');
    newH1.setAttribute('data-marker', 'item-view/title-info');
    newH1.textContent = 'Гараж, 20 м²';
    newWrap.appendChild(newH1);
    parent.replaceChild(newWrap, oldWrap); // старая панель вместе со старым поддеревом выпала из DOM

    await tick(window, 400); // debounce observer = 300мс
    const panel = document.querySelector('.an-panel--item');
    assert.ok(panel, 'панель не переинжектирована после перестройки дерева');
    assert.ok(document.contains(panel), 'панель вне DOM');
    assert.strictEqual(panel.dataset.itemId, '8093949601');
  });

    await runTest('панель цела — observer не дублирует её при мутациях рядом', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601',
      html: ITEM_PAGE_HTML,
    });
    const { window } = env;
    await tick(window);
    // Безобидная мутация: Авито дописывает баннер в main.
    const banner = window.document.createElement('div');
    banner.textContent = 'banner';
    window.document.querySelector('.js-item-view-main').appendChild(banner);
    await tick(window, 400);
    assert.strictEqual(window.document.querySelectorAll('.an-panel--item').length, 1, 'появился дубль панели');
  });

  /* ---------------- Страница поиска ---------------- */
  console.log('\nстраница поиска (не должна считаться объявлением):');

    await runTest('карточкам списка поставлены панели, панель объявления не создана', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/moskva/professionnye_instrumenty?q=автомат',
      html: SEARCH_PAGE_HTML,
    });
    await tick(env.window);
    const { window } = env;
    assert.ok(!window.document.querySelector('.an-panel--item'), 'на поиске появилась панель объявления');
    const listPanels = window.document.querySelectorAll('.an-panel:not(.an-panel--item)');
    assert.strictEqual(listPanels.length, 2);
    assert.deepStrictEqual(
      [...listPanels].map((p) => p.dataset.itemId).sort(),
      ['111222333', '444555666']
    );
  });

  /* ---------------- Старый формат URL ---------------- */
  console.log('\nстарый формат адреса /item/:');

    await runTest('панель появляется на /item/123456789 даже до отрисовки якорей', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/item/8093949601',
      html: '<!DOCTYPE html><html><body><div id="app">loading…</div></body></html>',
    });
    await tick(env.window);
    // Якорей ещё нет — панели нет, но ошибок нет.
    assert.ok(!env.window.document.querySelector('.an-panel--item'));
    // SPA дорисовал страницу.
    env.window.document.getElementById('app').innerHTML = `
      <div class="js-item-view-title-info"><h1 data-marker="item-view/title-info">Тест</h1></div>`;
    await tick(env.window, 400);
    assert.ok(env.window.document.querySelector('.an-panel--item'), 'панель не появилась после отрисовки SPA');
  });

  /* ---------------- Удаление заметки из панели ---------------- */
  console.log('\nудаление заметки:');

    await runTest('заметка с текстом: чип показывает превью, есть кнопка ✕; ✕ удаляет запись', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601',
      html: ITEM_PAGE_HTML,
    });
    await tick(env.window);
    // Создаём заметку через модалку.
    env.window.document.querySelector('.an-panel--item .an-note-chip').click();
    const modal = env.window.document.querySelector('.an-modal');
    assert.match(modal.querySelector('.an-modal__title').textContent, /Добавить заметку/);
    assert.ok(!modal.querySelector('.an-modal__btn--delete'),
      'в модалке новой заметки кнопки «Удалить» быть не должно');
    modal.querySelector('.an-modal__textarea').value = 'поторговаться';
    modal.querySelector('.an-modal__btn--save').click();
    await tick(env.window);
    assert.ok(env.getStored()['8093949601'], 'заметка не создана');
    const panel = env.window.document.querySelector('.an-panel--item');
    assert.ok(panel.querySelector('.an-note-chip--has'), 'чип не показывает, что заметка существует');
    assert.ok(panel.querySelector('.an-note-chip').textContent.includes('поторговаться'),
      'чип должен показывать содержание заметки');
    const delBtn = panel.querySelector('.an-del-btn');
    assert.ok(delBtn, 'нет кнопки удаления в панели');
    delBtn.click();
    await tick(env.window);
    assert.strictEqual(env.getStored()['8093949601'], undefined, 'заметка должна удалиться из хранилища');
    const panelAfter = env.window.document.querySelector('.an-panel--item');
    assert.ok(!panelAfter.querySelector('.an-del-btn'), 'кнопка удаления должна исчезнуть');
    assert.strictEqual(panelAfter.querySelector('.an-note-chip').textContent, '+ Заметка',
      'чип должен вернуться в состояние «добавить заметку»');
  });

    await runTest('заметка только со статусом: ✕ появляется и удаляет целиком', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601',
      html: ITEM_PAGE_HTML,
    });
    await tick(env.window);
    env.window.document.querySelector('.an-panel--item .an-btn[data-emoji="✅"]').click();
    await tick(env.window);
    const panel = env.window.document.querySelector('.an-panel--item');
    assert.ok(panel.querySelector('.an-del-btn'), 'у заметки со статусом должна быть кнопка удаления');
    assert.ok(panel.querySelector('.an-note-chip--has'), 'чип должен показывать существование заметки');
    panel.querySelector('.an-del-btn').click();
    await tick(env.window);
    assert.strictEqual(env.getStored()['8093949601'], undefined);
  });

  /* ---------------- Пустые заметки не хранятся ---------------- */
  console.log('\nпустая заметка удаляется автоматически:');

    await runTest('снятие статуса при пустом тексте удаляет заметку из хранилища', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601',
      html: ITEM_PAGE_HTML,
    });
    await tick(env.window);
    const okBtn = '.an-panel--item .an-btn[data-emoji="✅"]';
    env.window.document.querySelector(okBtn).click(); // создали заметку статусом
    await tick(env.window);
    assert.ok(env.getStored()['8093949601'], 'заметка со статусом должна быть сохранена');
    env.window.document.querySelector(okBtn).click(); // сняли статус, текста нет
    await tick(env.window);
    assert.strictEqual(env.getStored()['8093949601'], undefined,
      'пустая заметка (без статуса и текста) не должна храниться');
  });

    await runTest('сохранение пустого текста в модалке при статусе — заметка остаётся', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601',
      html: ITEM_PAGE_HTML,
    });
    await tick(env.window);
    env.window.document.querySelector('.an-panel--item .an-btn[data-emoji="❓"]').click();
    await tick(env.window);
    env.window.document.querySelector('.an-panel--item .an-note-chip').click();
    const modal = env.window.document.querySelector('.an-modal');
    modal.querySelector('.an-modal__textarea').value = '   '; // только пробелы
    modal.querySelector('.an-modal__btn--save').click();
    await tick(env.window);
    const note = env.getStored()['8093949601'];
    assert.ok(note && note.emoji === '❓', 'заметка со статусом сохраняется даже без текста');
    assert.strictEqual(note.text, '');
  });

    await runTest('очистка текста в модалке без статуса удаляет заметку', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601',
      html: ITEM_PAGE_HTML,
    });
    await tick(env.window);
    env.window.document.querySelector('.an-panel--item .an-note-chip').click();
    let modal = env.window.document.querySelector('.an-modal');
    modal.querySelector('.an-modal__textarea').value = 'надо посмотреть';
    modal.querySelector('.an-modal__btn--save').click();
    await tick(env.window);
    assert.ok(env.getStored()['8093949601'].text === 'надо посмотреть');
    // Открыли снова и очистили текст — statuses нет => заметка удаляется.
    env.window.document.querySelector('.an-panel--item .an-note-chip').click();
    modal = env.window.document.querySelector('.an-modal');
    modal.querySelector('.an-modal__textarea').value = '';
    modal.querySelector('.an-modal__btn--save').click();
    await tick(env.window);
    assert.strictEqual(env.getStored()['8093949601'], undefined);
  });

  /* ---------------- Ссылка на объявление с карточки выдачи ---------------- */
  console.log('\nссылка заметки с страницы поиска:');

    await runTest('метка с карточки выдачи сохраняет канонический /<id>', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/moskva/professionnye_instrumenty?q=автомат',
      html: SEARCH_PAGE_HTML,
    });
    await tick(env.window);
    const panel = env.window.document.querySelector('.an-panel[data-item-id="111222333"]');
    panel.querySelector('.an-btn[data-emoji="✅"]').click();
    await tick(env.window);
    const note = env.getStored()['111222333'];
    assert.strictEqual(note.link, 'https://www.avito.ru/111222333',
      'должен сохраниться прямой адрес объявления, а не ссылка выдачи/поиска');
  });

  /* ---------------- Всплывающий чат, прикреплённый к объявлению ---------------- */
  console.log('\nшапка всплывающего чата (мини-мессенджер):');

  await runTest('при наличии ссылки на объявление в шапке чата появляется панель', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_30_m_8457554115',
      html: CHAT_HEADER_HTML,
    });
    await tick(env.window);
    const panel = env.window.document.querySelector('.an-panel--chat');
    assert.ok(panel, 'панель в шапке чата не найдена');
    assert.strictEqual(panel.dataset.itemId, '8457554115');
    assert.strictEqual(panel.querySelectorAll('.an-btn').length, 3, 'нет трёх кнопок-статусов');
    assert.ok(panel.querySelector('.an-note-chip'), 'нет чипа заметки');
    assert.strictEqual(panel.querySelector('.an-note-chip').textContent, '+');
    assert.ok(!panel.querySelector('.an-del-btn'), 'в компактной панели чата ✕ быть не должно');
    // Панель — внутри infoWrap шапки чата.
    assert.ok(env.window.document
      .querySelector('[class*="infoWrap-_"]').contains(panel), 'панель не в шапке чата');
  });

  await runTest('клик по статусу в чате сохраняет метаданные из шапки чата', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/moskva?q=что-угодно', // под модалкой — поиск, данных объявления нет
      html: CHAT_HEADER_HTML,
    });
    await tick(env.window);
    env.window.document
      .querySelector('.an-panel--chat .an-btn[data-emoji="✅"]').click();
    await tick(env.window);
    const note = env.getStored()['8457554115'];
    assert.ok(note, 'заметка не сохранена');
    assert.strictEqual(note.emoji, '✅');
    assert.match(note.title, /Гараж/);
    assert.match(note.price, /630\s*000/u);
    assert.strictEqual(note.link, 'https://www.avito.ru/8457554115');
    // Картинка взята из превью объявления в шапке чата.
    assert.match(note.img, /avito\.st\/image/u);
  });

  await runTest('заметка из чата видна на панели страницы объявления и наоборот (патч обоих панелей)', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_30_m_8457554115',
      html: ITEM_PAGE_30_HTML + '\n' + CHAT_BODY_ONLY,
    });
    await tick(env.window);
    const itemPanel = env.window.document.querySelector('.an-panel--item');
    const chatPanel = env.window.document.querySelector('.an-panel--chat');
    assert.ok(itemPanel && chatPanel, 'обе панели должны присутствовать');
    chatPanel.querySelector('.an-btn[data-emoji="❌"]').click();
    await tick(env.window);
    assert.ok(itemPanel.querySelector('.an-btn--active'), 'панель объявления не отразила статус из чата');
    assert.strictEqual(itemPanel.querySelector('.an-btn--active').dataset.emoji, '❌');
  });

  await runTest('чат без ссылки на объявление — панель не появляется', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/profile/messenger',
      html: '<!DOCTYPE html><html><body><div class="infoWrap-_08b2"><span class="name-_08b2">Иван</span></div></body></html>',
    });
    await tick(env.window);
    assert.ok(!env.window.document.querySelector('.an-panel--chat'),
      'у обычного чата без объявления панели быть не должно');
  });

  await runTest('перемонтирование шапки React — панель чата восстанавливается без дублей', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/profile/messenger',
      html: CHAT_HEADER_HTML,
    });
    const { window } = env;
    const { document } = window;
    await tick(window);
    assert.ok(document.querySelector('.an-panel--chat'));

    // Эмуляция ре-рендера: infoWrap заменён новым поддеревом (панель выпала).
    const oldWrap = document.querySelector('[class*="infoWrap-_"]');
    const parent = oldWrap.parentElement;
    const fresh = document.createElement('div');
    fresh.innerHTML = CHAT_INFO_WRAP_INNER;
    parent.replaceChild(fresh.firstElementChild, oldWrap);

    await tick(window, 400); // debounce observer
    const panels = document.querySelectorAll('.an-panel--chat');
    assert.strictEqual(panels.length, 1, 'дубль или потеря панели после перемонтажа шапки');
    assert.strictEqual(panels[0].dataset.itemId, '8457554115');
  });

  await runTest('модалка заметки открывается из чата и текст сохраняется', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/profile/messenger',
      html: CHAT_HEADER_HTML,
    });
    await tick(env.window);
    env.window.document.querySelector('.an-panel--chat .an-note-chip').click();
    const modal = env.window.document.querySelector('.an-modal');
    assert.ok(modal, 'модалка не открылась из чата');
    modal.querySelector('.an-modal__textarea').value = 'торг уместен';
    modal.querySelector('.an-modal__btn--save').click();
    await tick(env.window);
    assert.strictEqual(env.getStored()['8457554115'].text, 'торг уместен');
    const chip = env.window.document.querySelector('.an-panel--chat .an-note-chip');
    assert.ok(chip.textContent.includes('торг'), 'чип чата не показывает превью заметки');
    assert.ok(chip.classList.contains('an-note-chip--has'), 'чип не подсвечен как существующая заметка');
  });

  console.log(`\n${passed} проверок пройдено.`);
  if (process.exitCode) console.error('ЕСТЬ ПРОВАЛЫ');
  else console.log('Все тесты зелёные.');
}

main();
