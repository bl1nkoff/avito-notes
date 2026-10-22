/* Тесты popup.js: чистые функции + интеграционный прогон всего скрипта в jsdom.
 *
 * Прежний харнесс падал из-за eval-загрузки текста файла внутри jsdom
 * ("outside-only"). Теперь popup.js подключается обычным require():
 * в конце файла есть guarded-экспорт (`typeof module !== 'undefined'`),
 * который в реальной среде расширения (module не определён) не выполняется.
 *
 * Интеграционная часть: popup.js выполняется В ПОЛНОМ DOM-окружении,
 * построенном из настоящего popup.html, с mock'ом chrome.* — проверяются
 * стартовый рендер, фильтры, сортировка и клик по заметке.
 *
 * Асинхронные проверки выполняются СЛЕДУЯ ДРУГ ЗА ДРУГОМ (runTest + await),
 * чтобы события в общем DOM не перекрывались (параллельный flush() давал гонку).
 *
 * Запуск:  node tests/popup.test.js   (или `npm test`)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const {
  parsePrice,
  escapeHtml,
  compareByPrice,
  sortNotes,
  filterNotes,
  noteItemHtml,
  resolveNoteUrl,
} = require('../popup.js');

let passed = 0;
async function runTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓', name);
  } catch (err) {
    console.error('  ✗', name);
    console.error(err.message);
    process.exitCode = 1;
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0)); // дать докрутиться async renderNotes

console.log('popup.js unit tests');

/* ---------------- parsePrice ---------------- */
console.log('\nparsePrice:');
runTest('число с пробелами и валютой -> число', () => {
  assert.strictEqual(parsePrice('12 500 ₽'), 12500);
});
runTest('число с неразрывными пробелами и скобами', () => {
  assert.strictEqual(parsePrice('1\u00A0234\u2009567 руб.'), 1234567);
});
runTest('"Договорная" -> null (не 0!)', () => {
  assert.strictEqual(parsePrice('Договорная'), null);
});
runTest('пустая строка / undefined / null -> null', () => {
  assert.strictEqual(parsePrice(''), null);
  assert.strictEqual(parsePrice(undefined), null);
  assert.strictEqual(parsePrice(null), null);
});
runTest('без цены (нет digits) -> null', () => {
  assert.strictEqual(parsePrice('цена не указана'), null);
});
runTest('число приводится к number через String()', () => {
  assert.strictEqual(parsePrice(999), 999);
});

/* ---------------- escapeHtml ---------------- */
console.log('\nescapeHtml:');
runTest('экранирует опасные символы', () => {
  assert.strictEqual(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});
runTest('экранирует & и кавычки', () => {
  assert.strictEqual(escapeHtml('a&b"c'), 'a&amp;b&quot;c');
});
runTest('undefined/null -> пустая строка', () => {
  assert.strictEqual(escapeHtml(undefined), '');
  assert.strictEqual(escapeHtml(null), '');
});

/* ---------------- compareByPrice ---------------- */
console.log('\ncompareByPrice:');
runTest('asc: меньшая цена вперёд', () => {
  assert.ok(compareByPrice({ price: '100 ₽' }, { price: '200 ₽' }, 1) < 0);
});
runTest('desc: большая цена вперёд', () => {
  assert.ok(compareByPrice({ price: '100 ₽' }, { price: '200 ₽' }, -1) > 0);
});
runTest('"Договорная" всегда в конце при asc', () => {
  assert.ok(compareByPrice({ price: 'Договорная' }, { price: '100 ₽' }, 1) > 0);
  assert.ok(compareByPrice({ price: '100 ₽' }, { price: 'Договорная' }, 1) < 0);
});
runTest('"Договорная" всегда в конце при desc', () => {
  assert.ok(compareByPrice({ price: 'Договорная' }, { price: '100 ₽' }, -1) > 0);
  assert.ok(compareByPrice({ price: '100 ₽' }, { price: 'Договорная' }, -1) < 0);
});
runTest('обе "Договорная" -> 0', () => {
  assert.strictEqual(compareByPrice({ price: 'Договорная' }, { price: 'нет' }, 1), 0);
});

/* ---------------- sortNotes ---------------- */
console.log('\nsortNotes:');
const notes = [
  { id: 1, title: 'A', price: '300 ₽', timestamp: 30 },
  { id: 2, title: 'B', price: 'Договорная', timestamp: 10 },
  { id: 3, title: 'C', price: '100 ₽', timestamp: 20 },
];
runTest('timestamp_desc (по умолчанию): новые впереди', () => {
  assert.deepStrictEqual(sortNotes(notes, 'timestamp_desc').map((n) => n.id), [1, 3, 2]);
  assert.deepStrictEqual(sortNotes(notes, 'unknown-value').map((n) => n.id), [1, 3, 2]);
});
runTest('timestamp_asc: старые впереди', () => {
  assert.deepStrictEqual(sortNotes(notes, 'timestamp_asc').map((n) => n.id), [2, 3, 1]);
});
runTest('price_asc: дешёвые впереди, договорная — в конце', () => {
  assert.deepStrictEqual(sortNotes(notes, 'price_asc').map((n) => n.id), [3, 1, 2]);
});
runTest('price_desc: дорогие впереди, договорная — в конце', () => {
  assert.deepStrictEqual(sortNotes(notes, 'price_desc').map((n) => n.id), [1, 3, 2]);
});
runTest('sortNotes не мутирует входной массив', () => {
  const copy = [...notes];
  sortNotes(notes, 'price_asc');
  assert.deepStrictEqual(notes, copy);
});
runTest('отсутствующий timestamp не роняет сортировку', () => {
  const r = sortNotes([{ id: 1 }, { id: 2, timestamp: 5 }], 'timestamp_desc');
  assert.deepStrictEqual(r.map((n) => n.id), [2, 1]);
});

/* ---------------- filterNotes ---------------- */
console.log('\nfilterNotes:');
const fnotes = [
  { title: 'Диван кожаный', text: 'торг уместен', emoji: '🛋️' },
  { title: 'Холодильник', text: '', emoji: '❄️' },
  { title: 'Кресло', text: 'Договорная цена, TORGOVAYA', emoji: '🪑' },
];
runTest('поиск по title (регистронезависимый)', () => {
  assert.strictEqual(filterNotes(fnotes, { search: 'диван', emojiFilter: '' }).length, 1);
});
runTest('поиск по тексту', () => {
  // 'торг' матчит только 'торг уместен'; 'TORGOVAYA' — латиница, кириллический подстрок не содержит
  assert.strictEqual(filterNotes(fnotes, { search: 'торг', emojiFilter: '' }).length, 1);
});
runTest('фильтр по emoji', () => {
  const res = filterNotes(fnotes, { search: '', emojiFilter: '❄️' });
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].title, 'Холодильник');
});
runTest('пустой поиск/фильтр -> всё', () => {
  assert.strictEqual(filterNotes(fnotes, { search: '', emojiFilter: '' }).length, 3);
});
runTest('комбинация поиска и emoji', () => {
  assert.strictEqual(filterNotes(fnotes, { search: 'кресло', emojiFilter: '🪑' }).length, 1);
  assert.strictEqual(filterNotes(fnotes, { search: 'кресло', emojiFilter: '❄️' }).length, 0);
});
runTest('заметки без полей не падают', () => {
  assert.strictEqual(filterNotes([{}], { search: 'что-то', emojiFilter: '' }).length, 0);
  assert.strictEqual(filterNotes([{}], { search: '', emojiFilter: '' }).length, 1);
});

/* ---------------- noteItemHtml ---------------- */
console.log('\nnoteItemHtml:');
runTest('содержимое экранируется (XSS-защита)', () => {
  const html = noteItemHtml({
    title: '<script>alert(1)</script>',
    text: '<img onerror=x>',
    price: '100 ₽',
    emoji: '💬',
    timestamp: Date.now(),
  });
  assert.ok(!html.includes('<script>'), 'в HTML не должно быть сырого <script>');
  assert.ok(html.includes('&lt;script&gt;'));
});
runTest('пустой текст -> блок note-text отсутствует', () => {
  const html = noteItemHtml({ title: 'T', text: '', price: '1 ₽', timestamp: Date.now() });
  assert.ok(!html.includes('note-text'));
});
runTest('у каждой заметки есть кнопка удаления', () => {
  const html = noteItemHtml({ title: 'T', text: 'x', price: '1 ₽', timestamp: Date.now() });
  assert.ok(html.includes('class="note-delete"'), 'нет кнопки .note-delete');
});
runTest('emoji по умолчанию 💬', () => {
  const html = noteItemHtml({ title: 'T', price: '1 ₽', timestamp: Date.now() });
  assert.ok(html.includes('💬'));
});
runTest('рендер в реальном DOM: заголовок безопасен', () => {
  const d = new JSDOM('<!doctype html><html><body></body></html>').window.document;
  const el = d.createElement('div');
  el.innerHTML = noteItemHtml({ title: '<b>x</b>', price: '5 ₽', timestamp: 1 });
  const titleEl = el.querySelector('.note-title');
  assert.ok(titleEl);
  assert.strictEqual(titleEl.textContent.includes('<b>x</b>'), true); // текст как есть
  assert.strictEqual(el.querySelector('b'), null);                    // и не разметка
});

/* ---------------- resolveNoteUrl ---------------- */
console.log('\nresolveNoteUrl:');
runTest('каноническая ссылка объявления используется как есть', () => {
  assert.strictEqual(
    resolveNoteUrl({ id: '555', link: 'https://www.avito.ru/8093949601' }),
    'https://www.avito.ru/8093949601'
  );
});
runTest('slug-ссылка на объявление из хранилища остаётся ссылкой на объявление', () => {
  assert.strictEqual(
    resolveNoteUrl({
      id: '8093949601',
      link: 'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601',
    }),
    'https://www.avito.ru/voronezh/garazhi_i_mashinomesta/garazh_20_m_8093949601'
  );
});
runTest('старая заметка без ссылки открывается по id объявления', () => {
  assert.strictEqual(resolveNoteUrl({ id: '123456789' }), 'https://www.avito.ru/123456789');
});
runTest('ссылка вида /item/<id>?... (не открывается Авито) переводится в /<id>', () => {
  assert.strictEqual(
    resolveNoteUrl({ id: '777', link: 'https://www.avito.ru/item/8093949601?utm_source=search#' }),
    'https://www.avito.ru/8093949601'
  );
  // Старые записи могли сохраниться уже в формате /item/<id> — чиним и их.
  assert.strictEqual(
    resolveNoteUrl({ id: '777', link: 'https://www.avito.ru/item/8093949601' }),
    'https://www.avito.ru/8093949601'
  );
});
runTest('неизвестный URL заметки заменяется адресом по id', () => {
  assert.strictEqual(
    resolveNoteUrl({ id: '4242', link: 'javascript:alert(1)' }),
    'https://www.avito.ru/4242'
  );
  assert.strictEqual(
    resolveNoteUrl({ id: '4242', link: 'https://www.avito.ru/somepage?q=x' }),
    'https://www.avito.ru/4242'
  );
});
runTest('нет ни ссылки, ни id -> пустая строка (клик ничего не открывает)', () => {
  assert.strictEqual(resolveNoteUrl({ title: 'x' }), '');
  assert.strictEqual(resolveNoteUrl(null), '');
});

/* ================= Интеграция: popup.js целиком в jsdom + mock chrome ================= */
(async () => {
  console.log('\npopup.js integration (jsdom + chrome mock):');

  const STORAGE_KEY = 'avito_notes_v1';
  let sampleNotes = {
    // id в ключах хранилища; link — канонический адрес объявления (как пишет content.js).
    '111': { title: 'Диван', text: 'торговаться', price: '300 ₽', emoji: '✅', timestamp: 30, link: 'https://www.avito.ru/111' },
    // Старая заметка: ссылка не сохранялась — клик должен восстановить адрес по id.
    '222': { title: 'Холодильник', text: '', price: 'Договорная', emoji: '❌', timestamp: 10 },
    // Старая заметка с битой ссылкой на страницу поиска (редирект) — тоже починится по id.
    '333': { title: 'Кресло <b>крутое</b>', text: 'привоз в пятницу', price: '100 ₽', emoji: '❓', timestamp: 20, link: 'https://www.avito.ru/moskva/search?q=кресло' },
  };
  const createdTabs = [];
  let storageChangeHandler = null;

  const chromeMock = {
    storage: {
      local: {
        get(keys, cb) {
          cb({ [STORAGE_KEY]: JSON.parse(JSON.stringify(sampleNotes)) });
        },
        set(obj, cb) {
          sampleNotes = obj[STORAGE_KEY];
          if (cb) cb();
        },
      },
      onChanged: {
        addListener(fn) { storageChangeHandler = fn; },
      },
    },
    tabs: {
      create(opts) { createdTabs.push(opts.url); },
      query: async () => [{ id: 1, url: 'https://www.avito.ru/some_item_123' }],
    },
    scripting: {
      executeScript: async () => {},
      insertCSS: async () => {},
    },
  };

  // Настоящий popup.html без <script>, чтобы самому выполнить popup.js в window контексте.
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8').replace(/<script[^>]*><\/script>/, '');
  const dom = new JSDOM(html, { url: 'chrome-extension://test/popup.html', runScripts: 'outside-only' });
  dom.window.chrome = chromeMock;
  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8'));

  const d = dom.window.document;
  const items = () => [...d.querySelectorAll('#notesList .note-item')];
  const titles = () => items().map((el) => el.querySelector('.note-title').textContent.trim());

  await flush(); // стартовый асинхронный renderNotes

  await runTest('стартовый рендер показывает все заметки', () => {
    assert.strictEqual(items().length, 3);
  });
  await runTest('по умолчанию сортировка "сначала новые"', () => {
    assert.deepStrictEqual(titles(), ['✅ Диван', '❓ Кресло <b>крутое</b>', '❌ Холодильник']);
  });
  await runTest('XSS: "<b>крутое</b>" рендерится текстом, а не разметкой', () => {
    assert.strictEqual(d.querySelector('#notesList b'), null);
  });
  await runTest('фильтр по emoji из select', async () => {
    const sel = d.getElementById('emojiFilter');
    sel.value = '❌';
    sel.dispatchEvent(new dom.window.Event('change'));
    await flush();
    assert.deepStrictEqual(titles(), ['❌ Холодильник']);
    sel.value = ''; // возврат фильтра, чтобы не влиять на следующий тест
    sel.dispatchEvent(new dom.window.Event('change'));
    await flush();
  });
  await runTest('поиск по тексту', async () => {
    const inp = d.getElementById('search');
    inp.value = 'пятниц';
    inp.dispatchEvent(new dom.window.Event('input'));
    await flush();
    assert.deepStrictEqual(titles(), ['❓ Кресло <b>крутое</b>']);
    inp.value = '';
    inp.dispatchEvent(new dom.window.Event('input'));
    await flush();
  });
  await runTest('сортировка price_asc: договорная — в конце', async () => {
    const sort = d.getElementById('sortBy');
    sort.value = 'price_asc';
    sort.dispatchEvent(new dom.window.Event('change'));
    await flush();
    assert.deepStrictEqual(titles(), ['❓ Кресло <b>крутое</b>', '✅ Диван', '❌ Холодильник']);
  });
  await runTest('клик по заметке открывает само объявление, а не страницу поиска', async () => {
    createdTabs.length = 0;
    // Сортировка осталась price_asc: Кресло(333, 100₽), Диван(111, 300₽), Холодильник(222, договорная).
    items()[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepStrictEqual(createdTabs, ['https://www.avito.ru/333'],
      'заметка со старой ссылкой на поиск должна открыться по id объявления');
    // Старая заметка без link -> адрес восстанавливается по id.
    items()[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(createdTabs[1], 'https://www.avito.ru/111');
    // Заметка с канонической ссылкой открывается ею же.
    items()[2].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(createdTabs[2], 'https://www.avito.ru/222');
    assert.ok(!createdTabs.some((u) => u.includes('search')), 'ни одна вкладка не открыла поиск');
  });
  await runTest('клик по кнопке ✕ удаляет заметку и не открывает вкладку', async () => {
    createdTabs.length = 0;
    // Сортировка price_asc: [Кресло(333), Диван(111), Холодильник(222)].
    const delBtn = items()[0].querySelector('.note-delete');
    assert.ok(delBtn, 'нет кнопки удаления у карточки');
    delBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush(); // deleteStoredNote -> set -> renderNotes
    assert.deepStrictEqual(createdTabs, [], 'клик по удалению не должен открывать объявление');
    assert.deepStrictEqual(titles(), ['✅ Диван', '❌ Холодильник'], 'заметка «Кресло» должна исчезнуть из списка');
    assert.strictEqual(sampleNotes['333'], undefined, 'запись должна удалиться из хранилища');
    assert.ok(sampleNotes['111'] && sampleNotes['222'], 'остальные заметки не задеты');
  });
  await runTest('storage.onChanged перерисовывает список', async () => {
    assert.ok(storageChangeHandler, 'слушатель изменений зарегистрирован');
    // После теста с удалением в хранилище остались только 111 и 222 —
    // убираем ещё одну запись: должно стать на одну заметку меньше.
    const before = items().length;
    delete sampleNotes['222'];
    storageChangeHandler({ [STORAGE_KEY]: { newValue: sampleNotes } }, 'local');
    await flush();
    assert.strictEqual(items().length, before - 1);
  });

  if (process.exitCode) {
    console.log(`\nFAILED (${passed} прошло до ошибки)`);
  } else {
    console.log(`\nPOPUP TEST PASSED (${passed} тестов)`);
  }
})();
