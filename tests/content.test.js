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

// Страница «Избранное»: у карточек нет ни data-marker="item", ни
// data-item-id — только data-marker="item-<id>", сердечко
// [data-marker="toggle-favorite-icon"] и ссылки с ?context=. Панели должны
// появляться и там (реальная разметка Авито, объявление 8048538485).
// Карточка избранного (реальная разметка объявления 8048538485).
const FAVORITE_CARD_1 = `
      <div data-marker="item-8048538485" class="root-_364d26e25ce2cd85">
        <div class="column-1-_364d26e25ce2cd85">
          <a href="/voronezh/garazhi_i_mashinomesta/garazh_30_m_8048538485?context=H4sIAAAAAAAA_0q0MrKqLrYytlIqLkpWsi62srRSSkssyy_KLEktBvENrZQqQLSRkZVSeFKlhXNSfG6ImVFIVlhRRYBZVXpuoJJ1LSAAAP__GkcxckYAAAA"><img src="https://40.img.avito.st/image/1/example_garage.jpg" class="image-_364d26e25ce2cd85 square-_364d26e25ce2cd85"></a>
        </div>
        <div class="column-2-_364d26e25ce2cd85">
          <div class="titleRoot-_364d26e25ce2cd85">
            <a href="/voronezh/garazhi_i_mashinomesta/garazh_30_m_8048538485?context=H4sIAAAAAAAA" class="root-c2185349bc5ff8be"><p class="root-_14d41a14338204f3 ellipsis-_944974d79655ea36"><strong class="root-_37d97241d856b927">Гараж, 30 м²</strong></p></a>
          </div>
          <div class="price-line-_364d26e25ce2cd85">
            <div class="root-_85f01667f505e7f8">
              <div class="root-deba26d752eae893"><h4 class="root-d44e5228bec8f1d1">730&nbsp;000 ₽</h4></div>
            </div>
          </div>
          <div class="root-f417271cf3c42559"><span class="addressLine-f417271cf3c42559">Воронежская обл., г.о. Воронеж, Советский район</span></div>
          <p class="root-_14d41a14338204f3 size_s-cdae9647da886914">13 октября, 20:14</p>
          <div class="topRight-_364d26e25ce2cd85"><div class="heart-af245fc77bac15c0" data-marker="toggle-favorite-icon"></div></div>
        </div>
        <div class="column-3-_364d26e25ce2cd85"></div>
      </div>`;

const FAVORITE_CARD_2 = `
      <div data-marker="item-9988776655" class="root-_364d26e25ce2cd85">
        <div class="column-1-_364d26e25ce2cd85"><a href="/voronezh/garazhi_i_mashinomesta/garazh_18_m_9988776655?context=zzz"><img src="https://40.img.avito.st/image/1/other.jpg"></a></div>
        <div class="column-2-_364d26e25ce2cd85">
          <div class="titleRoot-_364d26e25ce2cd85"><a href="/voronezh/garazhi_i_mashinomesta/garazh_18_m_9988776655?context=zzz"><strong>Гараж, 18 м²</strong></a></div>
          <div class="price-line-_364d26e25ce2cd85"><h4>590&nbsp;000 ₽</h4></div>
          <div class="topRight-_364d26e25ce2cd85"><div class="heart-af245fc77bac15c0" data-marker="toggle-favorite-icon"></div></div>
        </div>
      </div>`;

const FAVORITES_PAGE_HTML = `<!DOCTYPE html><html><body>
<div class="root-deba26d752eae893 direction_vertical-deba26d752eae893">
  <div class="root-deba26d752eae893">
    <div>${FAVORITE_CARD_1}
    </div>
  </div>
  <div class="root-deba26d752eae893">
    <div>${FAVORITE_CARD_2}
    </div>
  </div>
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

  /* ---------------- Страница избранного ---------------- */
  console.log('\nстраница избранного (карточки без data-marker="item"):');

    await runTest('панели появляются в карточках избранного (id из data-marker/slug)', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/profile/favorites?tab=executor',
      html: FAVORITES_PAGE_HTML,
    });
    await tick(env.window);
    const { window } = env;
    assert.ok(!window.document.querySelector('.an-panel--item'),
      'на странице избранного не должна появляться панель объявления');
    const panels = window.document.querySelectorAll('.an-panel:not(.an-panel--item)');
    assert.strictEqual(panels.length, 2, 'панели должны появиться у обеих карточек');
    assert.deepStrictEqual(
      [...panels].map((p) => p.dataset.itemId).sort(),
      ['8048538485', '9988776655']
    );
    // Панель кладём во вторую колонку с текстом — она вписывается в сетку
    // карточки (фото | текст | пусто), а не перекрывает фото.
    for (const p of panels) {
      const col2 = p.closest('[class*="column-2"]');
      assert.ok(col2, 'панель должна быть в текстовой колонке карточки');
      assert.strictEqual(p.querySelectorAll('.an-btn').length, 3, 'нет трёх кнопок-статусов');
      assert.strictEqual(p.querySelector('.an-note-chip').textContent, '+ Заметка');
    }
  });

    await runTest('избранное: карточка без сердечка — панель всё равно появляется (по data-marker="item-<id>")', async () => {
      // Авито может менять/убирать разметку toggle-favorite-icon — карточки
      // избранного должны находиться и по стабильному якорю data-marker.
      const noHeartHtml = FAVORITES_PAGE_HTML
        .replace(/<div class="topRight[^]*?toggle-favorite-icon[^]*?<\/div><\/div>/g, '');
      const env = makeEnv({
        url: 'https://www.avito.ru/profile/favorites?tab=executor',
        html: noHeartHtml,
      });
      await tick(env.window);
      const panels = env.window.document.querySelectorAll('.an-panel');
      assert.strictEqual(panels.length, 2, 'панели должны найтись даже без сердечек');
      assert.deepStrictEqual(
        [...panels].map((p) => p.dataset.itemId).sort(),
        ['8048538485', '9988776655']
      );
    });

    await runTest('клик по ✅ в избранном сохраняет метаданные карточки (название/цена/каноник/id)', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/profile/favorites?tab=executor',
      html: FAVORITES_PAGE_HTML,
    });
    await tick(env.window);
    const panel = env.window.document.querySelector('.an-panel[data-item-id="8048538485"]');
    panel.querySelector('.an-btn[data-emoji="✅"]').click();
    await tick(env.window);
    const note = env.getStored()['8048538485'];
    assert.ok(note, 'заметка не сохранена');
    assert.strictEqual(note.emoji, '✅');
    assert.match(note.title, /Гараж, 30/u);
    assert.match(note.price, /730\s*000/u);
    assert.strictEqual(note.link, 'https://www.avito.ru/8048538485',
      'ссылка — канонический адрес объявления, без ?context=');
    assert.strictEqual(note.img, 'https://40.img.avito.st/image/1/example_garage.jpg');
    // UI обновился: чип показывает существование заметки, появилась кнопка ✕.
    const patched = env.window.document.querySelector('.an-panel[data-item-id="8048538485"]');
    assert.ok(patched.querySelector('.an-note-chip--has'), 'чип не подсвечен');
    assert.ok(patched.querySelector('.an-del-btn'), 'нет кнопки удаления');
  });

    await runTest('модалка заметки работает и в избранном', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/profile/favorites?tab=executor',
      html: FAVORITES_PAGE_HTML,
    });
    await tick(env.window);
    const panel = env.window.document.querySelector('.an-panel[data-item-id="9988776655"]');
    panel.querySelector('.an-note-chip').click();
    const modal = env.window.document.querySelector('.an-modal');
    assert.ok(modal, 'модалка не открылась');
    modal.querySelector('.an-modal__textarea').value = 'торг уместен';
    modal.querySelector('.an-modal__btn--save').click();
    await tick(env.window);
    const note = env.getStored()['9988776655'];
    assert.strictEqual(note.text, 'торг уместен');
    assert.match(note.title, /Гараж, 18/u);
    const chip = env.window.document
      .querySelector('.an-panel[data-item-id="9988776655"] .an-note-chip');
    assert.ok(chip.textContent.includes('торг'), 'чип не показывает превью текста');
  });

    await runTest('observer не дублирует панели в избранном при мутациях рядом', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/profile/favorites?tab=executor',
      html: FAVORITES_PAGE_HTML,
    });
    const { window } = env;
    await tick(window);
    // Безобидная мутация: Авито дописывает элемент в первую карточку.
    const extra = window.document.createElement('div');
    extra.textContent = 'banner';
    window.document.querySelector('[data-marker="item-8048538485"]').appendChild(extra);
    await tick(window, 400);
    assert.strictEqual(
      window.document.querySelectorAll('.an-panel').length, 2,
      'появились дубли панелей'
    );
  });

    await runTest('React-перемонтаж карточки избранного — панель восстанавливается', async () => {
    const env = makeEnv({
      url: 'https://www.avito.ru/profile/favorites?tab=executor',
      html: FAVORITES_PAGE_HTML,
    });
    const { window } = env;
    const { document } = window;
    await tick(window);
    assert.ok(document.querySelector('.an-panel[data-item-id="8048538485"]'));

    // Эмуляция перемонтажа: вся карточка заменена новым поддеревом
    // (та же разметка, та же ссылка) — старая панель выпала из DOM.
    const oldCard = document.querySelector('[data-marker="item-8048538485"]');
    const parent = oldCard.parentElement;
    const wrap = document.createElement('div');
    wrap.innerHTML = FAVORITES_PAGE_HTML.match(
      /<div data-marker="item-8048538485"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)[0];
    parent.replaceChild(wrap.firstChild, oldCard);

    await tick(window, 400); // debounce observer = 300мс
    const panel = document.querySelector('.an-panel[data-item-id="8048538485"]');
    assert.ok(panel, 'панель не переинжектирована после перемонтажа карточки');
    assert.ok(document.contains(panel), 'панель вне DOM');
  });

  console.log(`\n${passed} проверок пройдено.`);
  if (process.exitCode) console.error('ЕСТЬ ПРОВАЛЫ');
  else console.log('Все тесты зелёные.');
}

main();
