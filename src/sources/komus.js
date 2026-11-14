/**
 * Источник: Комус (www.komus.ru) — интернет-магазин канцелярии и товаров для офиса.
 *
 * ВАЖНО — ограничение, подтверждённое вживую curl'ом (Chrome UA, с паузами между
 * запросами, без решения капч и без подмены отпечатков):
 *
 *  - Страница выдачи `GET /search?text=...` отдаёт HTTP 200 и полный HTML (~280 КБ),
 *    но карточки товаров в нём НЕ отрисованы на сервере: список загружает Vue-компонент
 *    `storefront-product-list`, который сам делает `POST /api/listing` из браузера.
 *    В статическом HTML нет ни одной цены, артикула или ссылки на товар — только
 *    переводы интерфейса и шаблоны Handlebars (проверено: ни JSON-слепка состояния,
 *    ни JSON-LD, ни `data-`атрибутов с товарами на странице выдачи нет).
 *  - Прямой вызов `POST /api/listing` (тот самый эндпоинт, который использует браузер)
 *    отдал HTTP 503 со страницей защиты ngenix: «Запросы с вашего IP-адреса похожи
 *    на автоматические» (см. test/fixtures/komus/blocked-listing.html — реальный ответ).
 *    Повторные попытки с другими телами запроса не делались: это открытая защита от
 *    автоматизации, а не ошибка конкретного набора параметров, и её обход
 *    (подбор отпечатка, решение испытания и т.п.) запрещён правилами адаптеров.
 *
 * Поэтому `search()` честно бросает `SourceError('blocked')`, когда `/api/listing`
 * отвечает защитной страницей — это ожидаемый результат живой проверки на дату
 * разработки, а не недоработка. Разбор самого ответа листинга (`parseListing`)
 * написан на случай, если доступ к источнику появится: он понимает типичную для
 * Hybris-магазинов обёртку `products`/`items`/... — эта часть НЕ подтверждена
 * реальным трафиком (реального успешного JSON-ответа получить не удалось).
 *
 * В отличие от выдачи, КАРТОЧКА ТОВАРА (`/.../p/<id>/`) отдаёт HTTP 200 с полностью
 * отрисованным на сервере описанием: микроданные schema.org (`itemprop="price"`,
 * `itemprop="sku"`), заголовок в `data-h1` и список характеристик
 * `.product-classification__row`. Единицу продажи (шт/упак/пачка) сайт показывает
 * только через тот же защищённый Vue-компонент (`product-price-section.js`,
 * Handlebars-плейсхолдер `{{this.unitName}}`) — в статическом HTML её нет, поэтому
 * `unitText` для предложений Комуса не заполняется (не выдумываем).
 *
 * НДС: страница товара сама содержит скрипт, который вычисляет и показывает
 * надпись «Включая НДС N ₽» ИЗ отображаемой цены (не добавляет сверху) и умеет
 * переключать её по `.product-price-switch` (цены с/без НДС для юрлиц) — то есть
 * опубликованная цена уже включает НДС. На этом основании `vat: 'included'`.
 */
import { load } from 'cheerio';
import { SourceError, parseJson } from '../core/http.js';

const SOURCE_ID = 'komus';
const HOMEPAGE = 'https://www.komus.ru';
const LISTING_ENDPOINT = 'https://www.komus.ru/api/listing';
const MAX_ALT_ATTEMPTS = 2;
const DEFAULT_DETAIL_LIMIT = 6;
const MAX_DETAIL_LIMIT = 6;

/** Опубликованная цена на карточке товара уже включает НДС (см. комментарий выше). */
const RETAIL_VAT = 'included';

/** Распознаёт защитную страницу ngenix (HTTP 503 вместо данных). Не зависит от кода ответа. */
export function isBotChallenge(body) {
  return /ngenix|bot-challenge|похож[а-я]*\s+на\s+автоматическ/i.test(body);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const CONTAINER_KEYS = ['products', 'items', 'data', 'result', 'results', 'rows', 'list'];
const TITLE_KEYS = ['title', 'name', 'productName'];
const URL_KEYS = ['url', 'link', 'productUrl'];
const ID_KEYS = ['code', 'id', 'sku', 'externalId'];
const UNIT_KEYS = ['unitName', 'unitText', 'salesUnit'];

function firstString(item, keys) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Цена в ответе листинга Hybris обычно лежит в `price.value`; поддерживаем и плоское поле. */
function firstPrice(item) {
  const price = item['price'];
  if (isRecord(price) && typeof price['value'] === 'number' && price['value'] > 0) return price['value'];
  const flat = item['priceRub'] ?? item['price'];
  if (typeof flat === 'number' && Number.isFinite(flat) && flat > 0) return flat;
  return null;
}

function extractList(data) {
  if (Array.isArray(data)) return data;
  if (isRecord(data)) {
    for (const key of CONTAINER_KEYS) {
      const value = data[key];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

function mapListingItem(raw, fetchedAt) {
  if (!isRecord(raw)) return null;
  const title = firstString(raw, TITLE_KEYS);
  const priceRub = firstPrice(raw);
  const relativeUrl = firstString(raw, URL_KEYS);
  if (title === null || priceRub === null || relativeUrl === null) return null;

  const externalId = firstString(raw, ID_KEYS) ?? relativeUrl;
  const unitText = firstString(raw, UNIT_KEYS);

  return {
    sourceId: SOURCE_ID,
    externalId,
    url: new URL(relativeUrl, HOMEPAGE).toString(),
    title,
    priceRub,
    unitText,
    vat: RETAIL_VAT,
    characteristics: {},
    fetchedAt,
  };
}

/**
 * Чистый разбор ответа `/api/listing`.
 * - Защитная страница ngenix (HTTP 503 вместо данных) -> SourceError('blocked').
 * - Не JSON -> SourceError('parse') (бросает parseJson).
 * - JSON без распознанного списка товаров (ни массив, ни products/items/...) -> SourceError('parse').
 * - Пустой список -> [].
 * - Позиции без названия/цены/ссылки пропускаются.
 *
 * НЕ подтверждено реальным трафиком: ни одного успешного ответа этого эндпоинта
 * получить не удалось (см. комментарий к модулю) — обёртка `products` и имена полей
 * выбраны по типичной структуре API магазинов на SAP Hybris.
 */
export function parseListing(response) {
  if (isBotChallenge(response.body)) {
    throw new SourceError(
      'blocked',
      'Комус отклоняет автоматические запросы к поиску: вместо результатов отдаётся страница проверки браузера. Источник пропущен; цены Комуса можно добавить вручную.',
      { url: response.url },
    );
  }

  const data = parseJson(response);
  const list = extractList(data);
  if (list === null) {
    throw new SourceError(
      'parse',
      'В ответе Комуса не найден ожидаемый список товаров (массив верхнего уровня или поле products/items/data/result/results/rows/list)',
      { url: response.url },
    );
  }

  const offers = [];
  for (const rawItem of list) {
    const offer = mapListingItem(rawItem, response.fetchedAt);
    if (offer) offers.push(offer);
  }
  return offers;
}

/** Текст характеристики/значения на карточке Комуса: убирает лишние пробелы и переносы. */
function cleanText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Чистый разбор карточки товара Комуса.
 * - Защитная страница ngenix -> SourceError('blocked').
 * - Страница не похожа на карточку товара (нет ни заголовка, ни артикула) -> SourceError('parse').
 * - Карточка без цены (не нашли `itemprop="price"` с положительным числом) -> null (пропуск).
 * - Иначе — предложение с характеристиками из `.product-classification__row`.
 *
 * Единицу продажи (`unitText`) источник на статической карточке не публикует
 * (загружается отдельным защищённым запросом) — поэтому она всегда null.
 */
export function parseProductPage(response) {
  if (isBotChallenge(response.body)) {
    throw new SourceError('blocked', 'Комус отклоняет автоматические запросы: карточка товара отдана защитной страницей ngenix вместо данных.', {
      url: response.url,
    });
  }

  const $ = load(response.body);
  const titleBlock = $('#product-detail-title-mount-target').first();
  const skuSpan = $('span.qa-vendor-code[itemprop="sku"]').first();
  const title = cleanText(titleBlock.attr('data-h1') ?? '');
  const externalId = cleanText(skuSpan.text());

  if (!title && !externalId) {
    throw new SourceError(
      'parse',
      'Страница не распознана как карточка товара Комуса: нет ни заголовка (#product-detail-title-mount-target), ни артикула (itemprop="sku")',
      { url: response.url },
    );
  }
  if (!title || !externalId) return null;

  const priceContent = $('[itemprop="offers"] meta[itemprop="price"]').first().attr('content');
  const priceRub = priceContent ? Number(priceContent.replace(',', '.')) : NaN;
  if (!Number.isFinite(priceRub) || priceRub <= 0) return null;

  const characteristics = {};
  $('.product-classification__row').each((_, row) => {
    const name = cleanText($(row).find('.product-classification__name').first().text()).replace(/:$/, '');
    const value = cleanText($(row).find('.product-classification__values').first().text());
    if (name && value) characteristics[name] = value;
  });

  return {
    sourceId: SOURCE_ID,
    externalId,
    url: response.url,
    title,
    priceRub,
    unitText: null,
    vat: RETAIL_VAT,
    characteristics,
    fetchedAt: response.fetchedAt,
    evidence: `Цена на карточке товара: ${priceRub} руб.; арт. ${externalId}`,
  };
}

function uniqueTexts(text, altTexts) {
  const values = [text, ...altTexts.slice(0, MAX_ALT_ATTEMPTS)]
    .map((value) => value.trim())
    .filter((value, index, all) => value !== '' && all.indexOf(value) === index);
  return values;
}

function detailLimitFrom(options) {
  const requested = options.detailLimit;
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return DEFAULT_DETAIL_LIMIT;
  return Math.max(0, Math.min(MAX_DETAIL_LIMIT, Math.floor(requested)));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Переводит сетевую ошибку HTTP-клиента (например, 503 от /api/listing) в понятный SourceError('blocked'). */
function asBlockedIfProtection(error, url) {
  if (error instanceof SourceError && error.kind === 'http' && error.status === 503) {
    throw new SourceError(
      'blocked',
      'Комус отклоняет автоматические запросы к поиску (HTTP 503, страница проверки браузера). Источник пропущен; цены Комуса можно добавить вручную.',
      { url, status: 503, cause: error },
    );
  }
  throw error;
}

async function runListing(ctx, text, limit) {
  const body = {
    label: 'text',
    code: text,
    searchQuery: ':relevance',
    isAllFacets: false,
    currentPage: 0,
    pageSize: Math.max(1, limit),
  };
  let response;
  try {
    response = await ctx.http.post(
      LISTING_ENDPOINT,
      { json: body },
      { signal: ctx.signal, headers: { referer: `${HOMEPAGE}/search?text=${encodeURIComponent(text)}` } },
    );
  } catch (error) {
    asBlockedIfProtection(error, LISTING_ENDPOINT);
  }
  return parseListing(response);
}

/** Дозапрашивает карточки первых detailLimit предложений: характеристики и, если источник их не отдал, вспомогательные поля. */
async function enrichWithDetails(offers, ctx, detailLimit) {
  let enriched = 0;
  for (const offer of offers) {
    if (enriched >= detailLimit) break;
    if (Object.keys(offer.characteristics).length > 0) continue;
    enriched += 1;
    try {
      const response = await ctx.http.get(offer.url, { signal: ctx.signal });
      const details = parseProductPage(response);
      if (details) {
        offer.characteristics = details.characteristics;
        if (offer.unitText === null) offer.unitText = details.unitText;
      }
    } catch (error) {
      ctx.log(`Комус: не удалось дозапросить характеристики для ${offer.externalId}: ${errorMessage(error)}`);
    }
  }
}

const createSource = (options = {}) => {
  const detailLimit = detailLimitFrom(options);

  return {
    id: SOURCE_ID,
    name: 'Комус',
    kind: 'marketplace',
    homepage: HOMEPAGE,

    async search(query, ctx) {
      const texts = uniqueTexts(query.text, query.altTexts);
      const limit = Math.max(0, Math.floor(query.limit));
      if (limit === 0 || texts.length === 0) return [];

      let lastOffers = [];
      for (const text of texts) {
        const offers = await runListing(ctx, text, limit);
        if (offers.length > 0) {
          const limited = offers.slice(0, limit);
          if (detailLimit > 0) await enrichWithDetails(limited, ctx, detailLimit);
          return limited;
        }
        lastOffers = offers;
      }
      return lastOffers;
    },
  };
};

export default createSource;
