/**
 * Адаптер «Портал поставщиков города Москвы» (zakupki.mos.ru).
 *
 * У портала нет публичного API поиска коммерческих предложений (СТЕ/оферт):
 * - `/api/Cssp/Offer/PostQuery` и аналогичные ручки каталога (`/api/Sku/QueryIndex`,
 *   `/api/Offer/GetSkuViewOffers`) либо требуют авторизации (old.zakupki.mos.ru
 *   отвечает 401 Unauthorized), либо анонимно возвращают пустой список предложений
 *   даже для позиций, у которых есть зарегистрированные оферты.
 * - Единственная работающая без авторизации ручка с ценой — автодополнение
 *   поисковой строки каталога `/newapi/api/SkuSearch/QueryAutocomplete`. Она
 *   отдаёт не более трёх позиций каталога (СТЕ) с полем `referencePrice` —
 *   справочной ценой, которую портал показывает всем посетителям на карточке
 *   товара. Характеристик, поставщика, региона, НДС и даты цены в ответе нет —
 *   карточка товара (`/classifier/api/Sku/GetPublicVersion`) при анонимном
 *   запросе возвращает 204 без содержимого, поэтому дозапрос карточек не даёт
 *   данных и не реализован: он не дал бы ничего, кроме явной лжи.
 *
 * Поэтому предложение без справочной цены (null или 0) пропускается, а если
 * ни по основному тексту, ни по альтернативным ни разу не нашлось позиции
 * со справочной ценой — источник просто возвращает [] (он ответил, но нечего
 * показать), как и предписывают правила адаптеров.
 */

import { SourceError } from '../core/http.js';

const SOURCE_ID = 'mos';
const AUTOCOMPLETE_URL = 'https://zakupki.mos.ru/newapi/api/SkuSearch/QueryAutocomplete';

/** Строит URL запроса автодополнения каталога по тексту. */
export function buildAutocompleteUrl(text) {
  const queryFilter = JSON.stringify({ isExact: false, keyword: text });
  return `${AUTOCOMPLETE_URL}?queryFilter=${encodeURIComponent(queryFilter)}`;
}

/**
 * Чистая функция разбора ответа `/api/SkuSearch/QueryAutocomplete`.
 * Позиции без справочной цены (null или 0) пропускаются — цена неизвестна,
 * придумывать её нельзя.
 */
export function parseAutocomplete(body, fetchedAt) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    const head = body.slice(0, 120).replace(/\s+/g, ' ');
    throw new SourceError('parse', `Портал поставщиков: ожидался JSON, получено: «${head}»`, { cause });
  }
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new SourceError('parse', 'Портал поставщиков: в ответе каталога нет ожидаемого поля «items»');
  }

  const offers = [];
  for (const item of parsed.items) {
    const id = item.id;
    const title = item.title;
    const price = item.specific?.referencePrice;
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    if (typeof title !== 'string' || title.trim() === '') continue;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;

    const okeiName = item.specific?.okeiName;
    offers.push({
      sourceId: SOURCE_ID,
      externalId: String(id),
      url: `https://zakupki.mos.ru/sku/view/${id}`,
      title,
      priceRub: price,
      unitText: typeof okeiName === 'string' && okeiName.trim() !== '' ? okeiName : null,
      vat: 'unknown',
      characteristics: {},
      fetchedAt,
    });
  }
  return offers;
}

const createSource = () => ({
  id: SOURCE_ID,
  name: 'Портал поставщиков г. Москвы',
  kind: 'aggregator',
  homepage: 'https://zakupki.mos.ru',
  async search(query, ctx) {
    const texts = [query.text, ...query.altTexts.slice(0, 2)].filter((text) => text.trim() !== '');
    for (const text of texts) {
      const response = await ctx.http.get(buildAutocompleteUrl(text), { signal: ctx.signal });
      const offers = parseAutocomplete(response.body, response.fetchedAt);
      if (offers.length > 0) {
        ctx.log(`найдено ${offers.length} позиций со справочной ценой по запросу «${text}»`);
        return offers.slice(0, query.limit);
      }
    }
    return [];
  },
});

export default createSource;
