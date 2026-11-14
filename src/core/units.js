/**
 * Единицы измерения: распознавание, размерности и поиск количества в тексте.
 * Используется, чтобы привести цену предложения к единице измерения закупки.
 */

const UNITS = [
  { code: 'шт', dimension: 'count', toBase: 1, base: 'шт', aliases: ['шт', 'штука', 'штуки', 'штук', 'ед', 'единица', 'единиц', 'экз', 'pcs', 'pc', 'piece'] },
  {
    code: 'упак',
    dimension: 'pack',
    toBase: 1,
    base: 'упак',
    aliases: ['упак', 'уп', 'упаковка', 'упаковки', 'упаковок', 'пач', 'пачка', 'пачки', 'пачек', 'pack'],
  },
  { code: 'кор', dimension: 'pack', toBase: 1, base: 'кор', aliases: ['кор', 'коробка', 'коробки', 'коробок', 'короб'] },
  { code: 'рул', dimension: 'pack', toBase: 1, base: 'рул', aliases: ['рул', 'рулон', 'рулона', 'рулонов'] },
  { code: 'бут', dimension: 'pack', toBase: 1, base: 'бут', aliases: ['бут', 'бутылка', 'бутылки', 'бутылок'] },
  { code: 'фл', dimension: 'pack', toBase: 1, base: 'фл', aliases: ['фл', 'флакон', 'флакона', 'флаконов'] },
  {
    code: 'компл',
    dimension: 'pack',
    toBase: 1,
    base: 'компл',
    aliases: ['компл', 'комплект', 'комплекта', 'комплектов', 'набор', 'набора', 'наборов', 'наб', 'set'],
  },
  { code: 'пар', dimension: 'pack', toBase: 1, base: 'пар', aliases: ['пар', 'пара', 'пары'] },
  { code: 'лист', dimension: 'pack', toBase: 1, base: 'лист', aliases: ['лист', 'листа', 'листов'] },
  { code: 'кг', dimension: 'mass', toBase: 1, base: 'кг', aliases: ['кг', 'килограмм', 'килограмма', 'килограммов', 'kg'] },
  { code: 'г', dimension: 'mass', toBase: 0.001, base: 'кг', aliases: ['г', 'гр', 'грамм', 'грамма', 'граммов', 'g'] },
  { code: 'мг', dimension: 'mass', toBase: 0.000001, base: 'кг', aliases: ['мг', 'mg'] },
  { code: 'т', dimension: 'mass', toBase: 1000, base: 'кг', aliases: ['т', 'тонна', 'тонны', 'тонн'] },
  { code: 'л', dimension: 'volume', toBase: 1, base: 'л', aliases: ['л', 'литр', 'литра', 'литров', 'l', 'дм3'] },
  { code: 'мл', dimension: 'volume', toBase: 0.001, base: 'л', aliases: ['мл', 'ml'] },
  { code: 'м3', dimension: 'volume', toBase: 1000, base: 'л', aliases: ['м3', 'куб м', 'кубм', 'кубометр', 'кубический метр'] },
  { code: 'м', dimension: 'length', toBase: 1, base: 'м', aliases: ['м', 'метр', 'метра', 'метров', 'пог м', 'погонный метр', 'п м', 'пм', 'm'] },
  { code: 'мм', dimension: 'length', toBase: 0.001, base: 'м', aliases: ['мм', 'mm'] },
  { code: 'см', dimension: 'length', toBase: 0.01, base: 'м', aliases: ['см', 'cm'] },
  { code: 'км', dimension: 'length', toBase: 1000, base: 'м', aliases: ['км', 'km', 'километр', 'километра', 'километров'] },
  { code: 'м2', dimension: 'area', toBase: 1, base: 'м2', aliases: ['м2', 'кв м', 'квм', 'квадратный метр', 'm2'] },
  {
    code: 'усл. ед',
    dimension: 'service',
    toBase: 1,
    base: 'усл. ед',
    aliases: ['усл ед', 'услед', 'усл', 'услуга', 'услуги', 'условная единица', 'работа', 'объект'],
  },
  { code: 'час', dimension: 'service', toBase: 1, base: 'час', aliases: ['час', 'ч', 'часа', 'часов', 'чел ч', 'чел час', 'человеко час'] },
  { code: 'мес', dimension: 'service', toBase: 1, base: 'мес', aliases: ['мес', 'месяц', 'месяца', 'месяцев'] },
  { code: 'сут', dimension: 'service', toBase: 1, base: 'сут', aliases: ['сут', 'сутки', 'суток', 'день', 'дня', 'дней'] },
  { code: 'год', dimension: 'service', toBase: 1, base: 'год', aliases: ['год', 'года', 'лет'] },
];

const BY_ALIAS = new Map();
for (const unit of UNITS) {
  for (const alias of unit.aliases) BY_ALIAS.set(alias, unit);
}

function strip(def) {
  return { code: def.code, dimension: def.dimension, toBase: def.toBase, base: def.base };
}

function normalizeUnitText(text) {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .replace(/м\^?\s?2/g, 'м2')
    .replace(/м\^?\s?3/g, 'м3')
    .replace(/^(руб\.?|₽|р\.?)\s*(\/|за)\s*/, '')
    .replace(/^(за|\/)\s*/, '')
    .replace(/^1\s+/, '')
    .replace(/[.\-()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Распознаёт единицу измерения; null — если текст пуст, 'unknown' — если единица не из справочника. */
export function parseUnit(text) {
  if (text === null || text === undefined) return null;
  // «Километр; тысяча метров» — берётся первое обозначение.
  const normalized = normalizeUnitText(text.split(/[;(]/)[0] ?? '');
  if (!normalized) return null;
  const exact = BY_ALIAS.get(normalized);
  if (exact) return strip(exact);
  const words = normalized.split(' ');
  // "пачка 500 л" -> "пачка"; "кв м" уже обработано точным совпадением
  for (let length = Math.min(3, words.length); length >= 1; length -= 1) {
    const candidate = BY_ALIAS.get(words.slice(0, length).join(' '));
    if (candidate) return strip(candidate);
  }
  return { code: normalized.slice(0, 24), dimension: 'unknown', toBase: 1, base: normalized.slice(0, 24) };
}

export const DEFAULT_UNIT = { code: 'шт', dimension: 'count', toBase: 1, base: 'шт' };

function aliasesOf(dimension) {
  return UNITS.filter((unit) => unit.dimension === dimension)
    .flatMap((def) => def.aliases.map((alias) => ({ alias, def })))
    .sort((a, b) => b.alias.length - a.alias.length);
}

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s?\\.?\\s?');

/**
 * Ищет в тексте количество заданной размерности: "10 кг", "0,5 л", "100 м".
 * Составные единицы ("80 г/м2") и размеры ("3х2,5 мм") не считаются количеством.
 */
export function findQuantity(text, dimension) {
  if (dimension !== 'mass' && dimension !== 'volume' && dimension !== 'length' && dimension !== 'area') return null;
  const source = text.toLowerCase().replace(/ё/g, 'е').replace(/²/g, '2').replace(/³/g, '3');
  for (const { alias, def } of aliasesOf(dimension)) {
    const pattern = new RegExp(`(?<![0-9a-zа-я.,xх×*])(\\d+(?:[.,]\\d+)?)\\s?(${escapeRe(alias)})\\.?(?![a-zа-я0-9/²³])`, 'g');
    for (const match of source.matchAll(pattern)) {
      const value = Number((match[1] ?? '').replace(',', '.'));
      if (Number.isFinite(value) && value > 0) {
        return { valueInBase: value * def.toBase, matched: match[0].trim() };
      }
    }
  }
  return null;
}

const COUNT_WORD = '(?:шт|штук|штуки|штука)';
const PACK_WORD = '(?:уп|упак|упаковк[аеиу]|упаковок|пач|пачк[аеиу]|пачек|кор|короб|коробк[аеиу]|наб|набор[еа]?|компл|комплект[еа]?|блок[еа]?)';

/**
 * Ищет число штук в одной единице продажи: "50 шт/уп", "упаковка 12 шт", "набор из 4 шт", "x10 шт".
 */
export function findPieceCount(text) {
  const source = text.toLowerCase().replace(/ё/g, 'е');
  const patterns = [
    new RegExp(`(\\d{1,5})\\s?${COUNT_WORD}\\.?\\s?(?:/|в|во)\\s?${PACK_WORD}`),
    new RegExp(`${PACK_WORD}\\.?\\s?(?:из|по|-|:)?\\s?(\\d{1,5})\\s?${COUNT_WORD}`),
    new RegExp(`[xх×*]\\s?(\\d{1,5})\\s?${COUNT_WORD}`),
    new RegExp(`(?<![0-9.,xх×*])(\\d{1,5})\\s?${COUNT_WORD}(?![a-zа-я])`),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    const count = Number(match?.[1]);
    if (match && Number.isInteger(count) && count >= 2) return { count, matched: match[0].trim() };
  }
  return null;
}

/**
 * Ищет число упаковок (пачек) в одной единице продажи: "5 пачек", "5 пач/кор", "коробка 5 уп".
 */
export function findPackCount(text) {
  const source = text.toLowerCase().replace(/ё/g, 'е');
  const pattern = /(?<![0-9.,xх×*])(\d{1,4})\s?(?:пач|пачк[аеи]|пачек|упак|упаковк[аеи]|упаковок|уп)\.?(?![a-zа-я])/;
  // «500 листов х 5 шт», «x5 пач»
  const multiplied = /[xх×*]\s?(\d{1,4})\s?(?:шт|штук|штуки|пач|пачк[аеи]|пачек|уп|упак|упаковк[аеи]|упаковок)\.?(?![a-zа-я])/;
  const match = pattern.exec(source) ?? multiplied.exec(source);
  const count = Number(match?.[1]);
  if (match && Number.isInteger(count) && count >= 2) return { count, matched: match[0].trim() };
  return null;
}

/**
 * Ищет содержимое фасовки, выраженное произвольным счётным словом: "500 листов", "100 шт", "50 м".
 * unitWord — основа слова из описания закупки ("лист", "шт").
 */
export function findContentCount(text, unitWord) {
  const source = text.toLowerCase().replace(/ё/g, 'е');
  const word = unitWord.toLowerCase().replace(/ё/g, 'е');
  const forms = word === 'лист' ? '(?:листов|листа|лист|л)' : word === 'шт' ? COUNT_WORD : `${escapeRe(word)}[а-я]{0,3}`;
  const pattern = new RegExp(`(?<![0-9.,xх×*])(\\d{1,6})\\s?${forms}\\.?(?![a-zа-я0-9/])`);
  // «Количество листов в пачке 500» — число после названия (так пишет КТРУ).
  const named = word === 'лист' ? /(?:листов|листа)\s+в\s+(?:пачке|упаковке)\D{0,6}(\d{1,6})/ : null;
  const match = pattern.exec(source) ?? named?.exec(source) ?? null;
  const count = Number(match?.[1]);
  if (match && Number.isFinite(count) && count > 0) return { count, matched: match[0].trim() };
  return null;
}
