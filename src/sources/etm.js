import { load } from 'cheerio';
import { SourceError } from '../core/http.js';

const SOURCE_ID = 'etm';
const HOMEPAGE = 'https://www.etm.ru';
const DEFAULT_DETAIL_LIMIT = 6;
const MAX_DETAIL_LIMIT = 6;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value) {
  return isRecord(value) ? value : null;
}

function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asPositivePrice(value) {
  const text = typeof value === 'number' ? String(value) : asString(value);
  if (text === null) return null;
  const price = Number(text.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(price) && price > 0 ? price : null;
}

function hasAntiBotMarker(body) {
  return /\b(?:captcha|cloudflare|attention required|robot check)\b|доступ\s+ограничен|проверка\s+безопасности/i.test(body);
}

function parseNextData(body) {
  const match = /<script\b[^>]*\bid=(["'])__NEXT_DATA__\1[^>]*>([\s\S]*?)<\/script>/i.exec(body);
  const json = match?.[2];
  if (json === undefined || json === '') {
    throw new SourceError('parse', 'В ответе ЭТМ не найден JSON-слепок страницы');
  }

  try {
    const data = JSON.parse(json);
    if (!isRecord(data)) throw new Error('Корневой JSON не является объектом');
    return data;
  } catch (cause) {
    throw new SourceError('parse', 'Не удалось разобрать JSON-слепок страницы ЭТМ', { cause });
  }
}

function nestedRecord(root, keys) {
  let current = root;
  for (const key of keys) {
    const next = current[key];
    if (!isRecord(next)) {
      throw new SourceError('parse', `В ответе ЭТМ отсутствует ожидаемый объект «${keys.join('.')}»`);
    }
    current = next;
  }
  return current;
}

function stringProperty(row, name) {
  return asString(row[name]);
}

function stringOrNumberProperty(row, name) {
  const value = row[name];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return asString(value);
}

function offerFromRow(row, fetchedAt) {
  const title = stringProperty(row, 'name');
  const externalId = stringProperty(row, 'code');
  const productCode = stringOrNumberProperty(row, 'gdscode');
  const priceRub = asPositivePrice(row.price98);
  if (title === null || externalId === null || productCode === null || priceRub === null) return null;

  const unitText = stringProperty(row, 'edizm');
  const supplier = stringProperty(row, 'mnf_name');
  const unitSuffix = unitText === null ? '' : ` ₽/${unitText}`;

  return {
    sourceId: SOURCE_ID,
    externalId,
    url: `${HOMEPAGE}/cat/nn/${encodeURIComponent(productCode)}`,
    title,
    priceRub,
    unitText,
    vat: 'unknown',
    characteristics: {},
    ...(supplier === null ? {} : { supplier }),
    fetchedAt,
    evidence: `Розничная цена: ${priceRub}${unitSuffix}; код товара: ${externalId}`,
  };
}

function parseSearchHtml(body, fetchedAt) {
  const $ = load(body);
  if ($('body').text().includes('К сожалению, товаров не найдено.')) return [];

  const offers = [];
  const cards = $('div[data-testid]').filter((_, element) => {
    const testId = $(element).attr('data-testid') ?? '';
    return /^catalog-list-item-\d+-\d+-\d+$/.test(testId);
  });

  cards.each((_, card) => {
    const titleLink = $(card).find('[data-testid="link-product-name"]').first();
    const title = titleLink.text().trim();
    const href = titleLink.attr('href');
    const codeText = $(card).text();
    const externalId = /Код товара:\s*(ETM\d+)/i.exec(codeText)?.[1] ?? null;
    const retailPrice = $(card).find('[data-testid^="catalog-list-item-price-retail-"]').first().contents().first().text().trim();
    const priceRub = asPositivePrice(retailPrice);
    const retailUnit = $(card)
      .find('[data-testid*="-price-retail-"][data-testid$="-unit"]')
      .first()
      .text()
      .replace(/^\s*₽\//, '')
      .trim();
    const supplier = $(card).find('[data-testid="link-good-brand"]').first().text().trim();

    if (title === '' || href === undefined || externalId === null || priceRub === null) return;
    offers.push({
      sourceId: SOURCE_ID,
      externalId,
      url: new URL(href, HOMEPAGE).toString(),
      title,
      priceRub,
      unitText: retailUnit === '' ? null : retailUnit,
      vat: 'unknown',
      characteristics: {},
      ...(supplier === '' ? {} : { supplier }),
      fetchedAt,
      evidence: `Розничная цена: ${priceRub}${retailUnit === '' ? '' : ` ₽/${retailUnit}`}; код товара: ${externalId}`,
    });
  });

  if (offers.length === 0) {
    throw new SourceError('parse', 'В HTML-ответе ЭТМ не найдены карточки товаров');
  }
  return offers;
}

/** Разбирает выдачу ЭТМ из серверного JSON Next.js; HTML служит резервным вариантом. */
export function parseSearch(body, fetchedAt) {
  if (hasAntiBotMarker(body)) {
    throw new SourceError('blocked', 'ЭТМ вернул страницу защиты от автоматических запросов');
  }

  let data;
  try {
    data = parseNextData(body);
  } catch (error) {
    if (error instanceof SourceError && error.kind === 'parse' && !body.includes('__NEXT_DATA__')) {
      return parseSearchHtml(body, fetchedAt);
    }
    throw error;
  }

  const catalog = nestedRecord(data, ['props', 'pageProps', 'initialState', 'catalog']);
  const allCatalogData = asRecord(catalog.allCatalogData);
  if (allCatalogData === null || !Array.isArray(allCatalogData.rows)) {
    throw new SourceError('parse', 'В JSON-выдаче ЭТМ отсутствует список товаров');
  }

  return allCatalogData.rows.flatMap((row) => {
    const offer = asRecord(row) === null ? null : offerFromRow(row, fetchedAt);
    return offer === null ? [] : [offer];
  });
}

/** Разбирает характеристики из серверного JSON карточки ЭТМ. */
export function parseProductCharacteristics(body) {
  if (hasAntiBotMarker(body)) {
    throw new SourceError('blocked', 'ЭТМ вернул страницу защиты от автоматических запросов');
  }

  const data = parseNextData(body);
  const productCard = nestedRecord(data, ['props', 'pageProps', 'initialState', 'productCard']);
  const basics = asRecord(productCard.basicsProductInformation);
  const productBase = asRecord(productCard.productBase);
  const externalId = asString(basics?.productEtmCode) ?? asString(productBase?.code);
  if (externalId === null || !Array.isArray(productCard.productCharacteristics)) {
    throw new SourceError('parse', 'В JSON-карточке ЭТМ отсутствуют код товара или характеристики');
  }

  const characteristics = {};
  for (const item of productCard.productCharacteristics) {
    const characteristic = asRecord(item);
    const name = asString(characteristic?.gdsCharName)?.replace(/:$/, '').trim();
    const value = asString(characteristic?.gdsCharVal);
    if (name && value !== null) characteristics[name] = value;
  }

  return { externalId, characteristics };
}

function detailLimitFrom(options) {
  const requested = options.detailLimit;
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return DEFAULT_DETAIL_LIMIT;
  return Math.max(0, Math.min(MAX_DETAIL_LIMIT, Math.floor(requested)));
}

function searchTexts(text, altTexts) {
  const values = [text, ...altTexts].map((value) => value.trim()).filter((value, index, all) => value !== '' && all.indexOf(value) === index);
  return values.slice(0, 3);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const createSource = (options = {}) => {
  const detailLimit = detailLimitFrom(options);

  return {
    id: SOURCE_ID,
    name: 'ЭТМ',
    kind: 'distributor',
    homepage: HOMEPAGE,
    async search(query, ctx) {
      const texts = searchTexts(query.text, query.altTexts);
      const limit = Math.max(0, Math.floor(query.limit));
      let offers = [];

      for (const text of texts) {
        const response = await ctx.http.get(`${HOMEPAGE}/catalog?searchValue=${encodeURIComponent(text)}`, { signal: ctx.signal });
        offers = parseSearch(response.body, response.fetchedAt).slice(0, limit);
        if (offers.length > 0) break;
      }

      for (const offer of offers.slice(0, detailLimit)) {
        try {
          const response = await ctx.http.get(offer.url, { signal: ctx.signal });
          const details = parseProductCharacteristics(response.body);
          if (details.externalId !== offer.externalId) {
            throw new SourceError('parse', 'Код товара в карточке ЭТМ не совпадает с кодом в выдаче');
          }
          offer.characteristics = details.characteristics;
        } catch (error) {
          ctx.log(`Не удалось получить характеристики товара ${offer.externalId}: ${errorMessage(error)}`);
        }
      }

      return offers;
    },
  };
};

export default createSource;
