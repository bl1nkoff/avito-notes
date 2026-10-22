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
    assert.strictEqual(note.link, 'https://www.avito.ru/item/8093949601');
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

    await runTest('метка с карточки выдачи сохраняет канонический /item/<id>', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/moskva/professionnye_instrumenty?q=автомат',
      html: SEARCH_PAGE_HTML,
    });
    await tick(env.window);
    const panel = env.window.document.querySelector('.an-panel[data-item-id="111222333"]');
    panel.querySelector('.an-btn[data-emoji="✅"]').click();
    await tick(env.window);
    const note = env.getStored()['111222333'];
    assert.strictEqual(note.link, 'https://www.avito.ru/item/111222333',
      'должен сохраниться прямой адрес объявления, а не ссылка выдачи/поиска');
  });

  console.log(`\n${passed} проверок пройдено.`);
  if (process.exitCode) console.error('ЕСТЬ ПРОВАЛЫ');
  else console.log('Все тесты зелёные.');
}

main();
