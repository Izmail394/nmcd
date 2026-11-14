import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SourceError } from '../core/http.js';
import createSource, { contractUrl, parseCard, parseCharacteristics, parseSearch } from './eis.js';

const fetchedAt = '2026-11-14T08:00:00.000Z';
const fixture = (name) => readFileSync(new URL(`../../test/fixtures/eis/${name}`, import.meta.url), 'utf8');
const hasKind = (kind) => (error) => error instanceof SourceError && error.kind === kind;
const response = (url, body) => ({ status: 200, url, contentType: 'text/html', body, fetchedAt });

function context(get, log = []) {
  return {
    http: {
      get: async (url) => get(url),
      post: async () => {
        throw new Error('POST не используется');
      },
    },
    signal: AbortSignal.timeout(5_000),
    log: (message) => log.push(message),
    now: () => new Date('2026-11-14T08:00:00Z'),
  };
}

test('ЕИС: выдача поиска разбирается в контракты с датой заключения', () => {
  const contracts = parseSearch(fixture('search-paper.html'));
  assert.equal(contracts.length, 4);
  assert.deepEqual(contracts[0], {
    reestrNumber: '1773600054926000009',
    contractDate: '2026-11-06',
    stage: 'Исполнение завершено',
    customer: 'ФЕДЕРАЛЬНОЕ ГОСУДАРСТВЕННОЕ БЮДЖЕТНОЕ УЧРЕЖДЕНИЕ НАУКИ ИНСТИТУТ ВСЕОБЩЕЙ ИСТОРИИ РОССИЙСКОЙ АКАДЕМИИ НАУК',
  });
  assert.equal(
    contracts.every((contract) => /^\d{19}$/.test(contract.reestrNumber) && contract.stage === 'Исполнение завершено'),
    true,
  );
});

test('ЕИС: пустая выдача, изменённая структура и блокировка различаются', () => {
  assert.deepEqual(parseSearch(fixture('search-empty.html')), []);
  assert.throws(() => parseSearch('<html><body><div class="new-layout">контракты</div></body></html>'), hasKind('parse'));
  assert.throws(() => parseSearch('<html><body>Доступ ограничен</body></html>'), hasKind('blocked'));
  assert.throws(() => parseSearch('<div class="search-registry-entry-block"><a href="/x">без номера</a></div>'), hasKind('parse'));
});

test('ЕИС: карточка контракта даёт цену за единицу, единицу, количество, коды и ставку НДС', () => {
  const positions = parseCard(fixture('card-1773600054926000009.html'));
  assert.equal(positions.length, 1);
  assert.deepEqual(positions[0], {
    subjectId: '849174189',
    title: 'Бумага для офисной техники. Товарный знак: Марафон Бизнес (Technoevolab)',
    priceRub: 388.8,
    unitText: 'Пачка',
    quantity: 50,
    okpd2: '17.12.14.110',
    ktru: '17.12.14.110-00000005',
    characteristics: { 'Характеристики (кратко)': 'Масса бумаги площадью 1м2 80 и 90 Грамм, Цветность Белая, Количество листов в пачке 500Штука' },
    vatNote: '5%',
  });
  assert.equal(positions[0].priceRub * positions[0].quantity, 19440, 'цена за единицу × количество = сумма контракта');
});

test('ЕИС: позиция без цены пропускается, карточка без таблицы — ошибка разбора', () => {
  const noPrice = fixture('card-1773600054926000009.html').replace('388,80', '—');
  assert.deepEqual(parseCard(noPrice), []);
  assert.throws(() => parseCard('<html><body>Карточка контракта</body></html>'), hasKind('parse'));
  assert.throws(() => parseCard('<table id="contract_subjects"><thead><tr><th>Позиция</th></tr></thead><tbody></tbody></table>'), hasKind('parse'));
});

test('ЕИС: полные характеристики позиции КТРУ', () => {
  assert.deepEqual(parseCharacteristics(fixture('ktru-849174189.html')), {
    'Масса бумаги площадью 1м2': '≥ 80 и < 90 Грамм',
    Цветность: 'Белая',
    'Количество листов в пачке': '500Штука',
    Формат: 'А4',
  });
  assert.deepEqual(parseCharacteristics('<html></html>'), {});
});

test('ЕИС: адаптер собирает предложения из карточек; сбой одной карточки не роняет поиск', async () => {
  const requests = [];
  const log = [];
  const source = createSource({ contractLimit: 2, detailLimit: 1 });
  const offers = await source.search(
    { text: 'бумага офисная А4', altTexts: [], limit: 10 },
    context(async (url) => {
      requests.push(url);
      if (url.includes('/search/results.html')) return response(url, fixture('search-paper.html'));
      if (url.includes('reestrNumber=1773600054926000009')) return response(url, fixture('card-1773600054926000009.html'));
      if (url.includes('ktru-characteristics')) return response(url, fixture('ktru-849174189.html'));
      throw new SourceError('timeout', 'Источник не ответил');
    }, log),
  );

  assert.equal(offers.length, 1);
  const offer = offers[0];
  assert.equal(offer.sourceId, 'eis');
  assert.equal(offer.externalId, '1773600054926000009-849174189');
  assert.equal(offer.url, contractUrl('1773600054926000009'));
  assert.equal(offer.priceRub, 388.8);
  assert.equal(offer.unitText, 'Пачка');
  assert.equal(offer.vat, 'included');
  assert.equal(offer.priceDate, '2026-11-06');
  assert.equal(offer.okpd2, '17.12.14.110');
  assert.equal(offer.quantity, 50);
  assert.equal(offer.fetchedAt, fetchedAt);
  assert.equal(offer.characteristics['Масса бумаги площадью 1м2'], '≥ 80 и < 90 Грамм');
  assert.equal(offer.characteristics['Код КТРУ'], '17.12.14.110-00000005');
  assert.match(offer.evidence ?? '', /Контракт № 1773600054926000009 \(Исполнение завершено\); заключён 2026-11-06/);

  const search = new URL(requests[0]);
  assert.equal(search.searchParams.get('contractStageList_1'), 'on', 'только контракты с завершённым исполнением');
  assert.equal(search.searchParams.get('contractDateFrom'), '14.11.2023', 'за последние три года');
  assert.equal(requests.length, 4, 'поиск, две карточки, одна страница характеристик');
  assert.match(log.join('\n'), /карточка контракта 2143509037926000037 не получена/);
});

test('ЕИС: без сертификата Минцифры — понятная ошибка настройки, а не «сеть недоступна»', async () => {
  const source = createSource();
  const failing = context(async (url) => {
    throw new SourceError('network', 'Сетевая ошибка: SELF_SIGNED_CERT_IN_CHAIN: self-signed certificate in certificate chain', { url });
  });
  await assert.rejects(
    source.search({ text: 'бумага', altTexts: [], limit: 5 }, failing),
    (error) => error instanceof SourceError && error.kind === 'config' && /certs\//.test(error.message),
  );
});

test('ЕИС: контракты найдены, но ни одна карточка не разобрана — ошибка, а не пустой результат', async () => {
  const source = createSource({ contractLimit: 2 });
  const broken = context(async (url) =>
    url.includes('/search/results.html') ? response(url, fixture('search-paper.html')) : response(url, '<html>новая вёрстка</html>'),
  );
  await assert.rejects(source.search({ text: 'бумага', altTexts: [], limit: 5 }, broken), hasKind('parse'));
});
