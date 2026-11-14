/**
 * ЕИС (zakupki.gov.ru) — реестр контрактов по 44-ФЗ.
 *
 * Берутся контракты со статусом «Исполнение завершено», заключённые за последние три года.
 * Цена за единицу есть только в карточке контракта («Объекты закупки»), поэтому адаптер:
 *   1) ищет контракты по тексту;
 *   2) открывает карточки первых contractLimit контрактов и разбирает таблицу объектов закупки;
 *   3) для первых detailLimit позиций дозапрашивает полный перечень характеристик КТРУ.
 *
 * Сайт работает на сертификате Минцифры: корневой сертификат должен лежать в certs/.
 * Наличие штрафов и пеней по контракту адаптер не проверяет — это видно в карточке по ссылке.
 */
import * as cheerio from 'cheerio';
import { SourceError } from '../core/http.js';

const SOURCE_ID = 'eis';
const HOST = 'https://zakupki.gov.ru';
const SEARCH_PATH = '/epz/contract/search/results.html';
const CARD_PATH = '/epz/contract/contractCard/payment-info-and-target-of-order.html';

function clean(text) {
  return text.replace(/[\s  ]+/g, ' ').trim();
}

/** "19 440,00 ₽" -> 19440; null, если это не положительное число. */
function parseMoney(text) {
  const normalized = text.replace(/[\s  ₽]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function toIsoDate(text) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim());
  return match ? `${match[3]}-${match[2]}-${match[1]}` : undefined;
}

function formatRuDate(date) {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

export function contractUrl(reestrNumber) {
  return `${HOST}${CARD_PATH}?reestrNumber=${encodeURIComponent(reestrNumber)}`;
}

/** Выдача поиска контрактов -> список контрактов. */
export function parseSearch(body) {
  const $ = cheerio.load(body);
  const blocks = $('.search-registry-entry-block');
  if (blocks.length === 0) {
    if ($('.noRecords').length > 0 || /Поиск не дал результатов/i.test(body)) return [];
    if (/captcha|Доступ ограничен|Access denied/i.test(body)) {
      throw new SourceError('blocked', 'ЕИС отклонил автоматический запрос (страница проверки или ограничение доступа).');
    }
    throw new SourceError('parse', 'В выдаче ЕИС нет блоков контрактов и нет сообщения «Поиск не дал результатов» — структура страницы изменилась.');
  }
  const contracts = [];
  blocks.each((_, element) => {
    const block = $(element);
    const href = block.find('.registry-entry__header-mid__number a').attr('href') ?? '';
    const reestrNumber = /reestrNumber=(\d{15,25})/.exec(href)?.[1];
    if (!reestrNumber) return;
    let contractDate;
    block.find('.data-block__title').each((__, title) => {
      if (/Заключение контракта/i.test($(title).text())) contractDate = toIsoDate($(title).next('.data-block__value').text());
    });
    contracts.push({
      reestrNumber,
      contractDate,
      stage: clean(block.find('.registry-entry__header-mid__title').text()),
      customer: clean(block.find('.registry-entry__body-href a').first().text()) || undefined,
    });
  });
  if (contracts.length === 0) {
    throw new SourceError('parse', 'В блоках выдачи ЕИС не найдены реестровые номера контрактов — структура страницы изменилась.');
  }
  return contracts;
}

/** «Масса … 80 и 90 Грамм , Цветность Белая , …» разобрать надёжно нельзя — краткая строка хранится как есть. */
function briefCharacteristics(text) {
  const brief = clean(text.replace(/Все характеристики ТРУ/gi, '').replace(/\.\.\.\s*$/, ''));
  return brief ? { 'Характеристики (кратко)': brief.replace(/\s+,/g, ',').replace(/[,\s]+$/, '') } : {};
}

/** Карточка контракта, вкладка «Объекты закупки» -> позиции с ценой за единицу. */
export function parseCard(body) {
  const $ = cheerio.load(body);
  const table = $('#contract_subjects');
  if (table.length === 0) {
    if (/Объекты закупки отсутствуют|Сведения отсутствуют/i.test(body)) return [];
    throw new SourceError('parse', 'В карточке контракта ЕИС нет таблицы объектов закупки (#contract_subjects).');
  }
  const headers = table
    .find('thead th')
    .map((_, th) => clean($(th).text()))
    .get();
  const column = (pattern) => headers.findIndex((header) => pattern.test(header));
  const nameIndex = column(/Наименование объекта закупки/i);
  const codeIndex = column(/КТРУ|ОКПД/i);
  const quantityIndex = column(/Количество/i);
  const priceIndex = column(/Цена за единицу/i);
  const sumIndex = column(/Сумма/i);
  if (nameIndex < 0 || priceIndex < 0) {
    throw new SourceError('parse', 'В таблице объектов закупки ЕИС нет столбцов «Наименование» и «Цена за единицу» — структура изменилась.');
  }

  const positions = [];
  table.find('tbody > tr').each((_, row) => {
    const cells = $(row).children('td');
    if (cells.length < headers.length) return; // скрытая строка с дополнительными сведениями
    const nameCell = cells.eq(nameIndex);
    const title = clean(nameCell.children('div').first().text()).replace(/^\d+\.\s*/, '');
    const priceRub = parseMoney(clean(cells.eq(priceIndex).text()));
    if (!title || priceRub === null) return;

    const subjectId = /contractSubjectId=(\d+)/.exec(nameCell.find('a[href*="ktru-characteristics"]').attr('href') ?? '')?.[1] ?? null;
    const characteristicsBlock = nameCell.find('a[href*="ktru-characteristics"]').parent();
    const characteristics = characteristicsBlock.length > 0 ? briefCharacteristics(characteristicsBlock.text()) : {};

    const codeText = codeIndex >= 0 ? clean(cells.eq(codeIndex).text()) : '';
    const ktru = /\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5,}/.exec(codeText)?.[0];
    const okpd2 = /\((\d{2}\.\d{2}(?:\.\d{1,2})?(?:\.\d{3})?)\)\s*$/.exec(codeText)?.[1] ?? ktru?.split('-')[0];

    let unitText = null;
    let quantity;
    if (quantityIndex >= 0) {
      const quantityCell = cells.eq(quantityIndex);
      const tooltip = quantityCell.find('[data-tooltip]').attr('data-tooltip') ?? '';
      const fullUnit = clean(cheerio.load(tooltip).text());
      const match = /^([\d\s  ]+(?:[.,]\d+)?)\s*(.*)$/.exec(clean(quantityCell.text()));
      if (match) {
        const parsed = Number((match[1] ?? '').replace(/[\s  ]/g, '').replace(',', '.'));
        if (Number.isFinite(parsed) && parsed > 0) quantity = parsed;
        unitText = fullUnit || clean(match[2] ?? '') || null;
      }
    }
    const vatNote = sumIndex >= 0 ? /Ставка НДС:\s*([^<\n]+?)\s*$/.exec(clean(cells.eq(sumIndex).text()))?.[1] : undefined;
    positions.push({ subjectId, title, priceRub, unitText, quantity, okpd2, ktru, characteristics, vatNote });
  });
  return positions;
}

/** Окно «Характеристики позиции КТРУ» -> название: значение. */
export function parseCharacteristics(body) {
  const $ = cheerio.load(body);
  const characteristics = {};
  $('.blockInfo__section').each((_, section) => {
    const name = clean($(section).find('.section__title').first().text());
    const value = clean($(section).find('.section__info').first().text());
    if (name && value) characteristics[name] = value;
  });
  return characteristics;
}

function toOffer(contract, position, index, fetchedAt) {
  const parts = [`Контракт № ${contract.reestrNumber} (${contract.stage || 'статус не указан'})`];
  if (contract.contractDate) parts.push(`заключён ${contract.contractDate}`);
  parts.push(`цена за единицу ${position.priceRub} руб.`);
  if (position.quantity !== undefined) parts.push(`количество ${position.quantity} ${position.unitText ?? ''}`.trim());
  if (position.vatNote) parts.push(`ставка НДС ${position.vatNote}`);
  if (contract.customer) parts.push(`заказчик: ${contract.customer}`);
  return {
    sourceId: SOURCE_ID,
    externalId: `${contract.reestrNumber}-${position.subjectId ?? index + 1}`,
    url: contractUrl(contract.reestrNumber),
    title: position.title,
    priceRub: position.priceRub,
    unitText: position.unitText,
    // Цена контракта — итоговая цена для заказчика, налоги в неё уже включены.
    vat: 'included',
    characteristics: { ...position.characteristics, ...(position.ktru ? { 'Код КТРУ': position.ktru } : {}) },
    okpd2: position.okpd2,
    priceDate: contract.contractDate,
    quantity: position.quantity,
    fetchedAt,
    evidence: `${parts.join('; ')}.`.slice(0, 300),
  };
}

/** Начала значимых слов запроса (первые 5 букв), по которым отбираются позиции многопозиционного контракта. */
function significantWords(text) {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/ё/g, 'е')
        .split(/[^a-zа-я0-9]+/)
        .filter((word) => word.length >= 4 && !/^\d+$/.test(word))
        .map((word) => word.slice(0, 5)),
    ),
  ];
}

/** Позиция относится к запросу, если в названии или характеристиках есть хотя бы одно его значимое слово. */
function mentionsQuery(position, words) {
  if (words.length === 0) return true;
  const haystack = `${position.title} ${Object.values(position.characteristics).join(' ')}`.toLowerCase().replace(/ё/g, 'е');
  return words.some((word) => haystack.includes(word));
}

function isCertificateProblem(error) {
  return error instanceof SourceError && error.kind === 'network' && /SELF_SIGNED|UNABLE_TO_(VERIFY|GET_ISSUER)|CERT_|certificate/i.test(error.message);
}

async function get(http, url, signal) {
  try {
    return await http.get(url, { signal, timeoutMs: 30_000 });
  } catch (error) {
    if (isCertificateProblem(error)) {
      throw new SourceError(
        'config',
        'ЕИС работает на сертификате Минцифры. Положите корневой сертификат «Russian Trusted Root CA» (https://www.gosuslugi.ru/crt) в каталог certs/ и перезапустите сервис.',
        { url, cause: error },
      );
    }
    throw error;
  }
}

function searchUrl(text, now, years) {
  const from = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  const params = new URLSearchParams({
    searchString: text,
    morphology: 'on',
    fz44: 'on',
    contractStageList_1: 'on', // исполнение завершено
    contractStageList: '1',
    contractDateFrom: formatRuDate(from),
    sortBy: 'UPDATE_DATE',
    sortDirection: 'false',
    pageNumber: '1',
    recordsPerPage: '_10',
  });
  return `${HOST}${SEARCH_PATH}?${params.toString()}`;
}

const createSource = (options = {}) => {
  const numberOption = (value, fallback) => (typeof value === 'number' && value >= 0 ? Math.floor(value) : fallback);
  const contractLimit = numberOption(options.contractLimit, 10);
  const detailLimit = numberOption(options.detailLimit, 6);
  const years = numberOption(options.years, 3) || 3;
  return {
    id: SOURCE_ID,
    name: 'ЕИС — реестр контрактов',
    kind: 'contract_registry',
    homepage: HOST,
    async search(query, ctx) {
      let contracts = [];
      for (const phrase of [query.text, ...query.altTexts.slice(0, 2)]) {
        const response = await get(ctx.http, searchUrl(phrase, ctx.now(), years), ctx.signal);
        contracts = parseSearch(response.body);
        if (contracts.length > 0) break;
      }

      const queryWords = significantWords(query.text);
      const offers = [];
      const pending = [];
      let failed = 0;
      for (const contract of contracts.slice(0, contractLimit)) {
        if (offers.length >= query.limit) break;
        try {
          const card = await get(ctx.http, contractUrl(contract.reestrNumber), ctx.signal);
          const positions = parseCard(card.body);
          // В контракте на канцелярию десятки позиций; дальше идут только те, что относятся к запросу.
          const relevant = positions.filter((position) => mentionsQuery(position, queryWords));
          if (relevant.length < positions.length) {
            ctx.log(`контракт ${contract.reestrNumber}: позиций ${positions.length}, относящихся к запросу — ${relevant.length}`);
          }
          relevant.forEach((position, index) => {
            const offer = toOffer(contract, position, index, card.fetchedAt);
            offers.push(offer);
            if (position.subjectId) pending.push({ offer, subjectId: position.subjectId });
          });
        } catch (error) {
          failed += 1;
          ctx.log(`карточка контракта ${contract.reestrNumber} не получена: ${error instanceof Error ? error.message : String(error)}`);
          if (ctx.signal.aborted || (error instanceof SourceError && (error.kind === 'blocked' || error.kind === 'config'))) break;
        }
      }
      // Контракты найдены, но ни одну карточку разобрать не удалось — это сбой источника, а не «ничего нет».
      if (offers.length === 0 && failed > 0) {
        throw new SourceError('parse', `ЕИС: найдено контрактов ${contracts.length}, но ни одну карточку не удалось получить или разобрать.`);
      }

      const limited = offers.slice(0, query.limit);
      let requested = 0;
      for (const { offer, subjectId } of pending) {
        if (requested >= detailLimit || ctx.signal.aborted) break;
        if (!limited.includes(offer)) continue;
        requested += 1;
        try {
          const page = await get(ctx.http, `${HOST}/epz/contract/contractCard/ktru-characteristics.html?contractSubjectId=${subjectId}`, ctx.signal);
          const full = parseCharacteristics(page.body);
          if (Object.keys(full).length > 0) {
            const ktru = offer.characteristics['Код КТРУ'];
            offer.characteristics = { ...full, ...(ktru ? { 'Код КТРУ': ktru } : {}) };
          }
        } catch (error) {
          ctx.log(`характеристики позиции ${subjectId} не получены: ${error instanceof Error ? error.message : String(error)}`);
          if (error instanceof SourceError && error.kind === 'blocked') break;
        }
      }
      return limited;
    },
  };
};

export default createSource;
