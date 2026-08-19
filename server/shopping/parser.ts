import { parse, type HTMLElement } from 'node-html-parser';
import type { ShippingEvidence, ShoppingOffer, ShoppingSource } from './types.js';

interface PriceAndShipping {
  priceYen: number;
  shippingYen: number | null;
  shippingEvidence: ShippingEvidence;
}

interface JsonRecord {
  [key: string]: unknown;
}

const PRODUCT_SELECTORS = [
  '[itemtype*="schema.org/Product"]',
  '[itemtype*="Product"]',
  '[data-asin]',
  '[data-product-id]',
  '[data-item-id]',
  '.front_item-info-area',
  '.product-item',
  '.searchresultitem',
  '.searchresult_item',
  '.product',
  '.item',
  'article',
];

const YAHOO_RESULT_SELECTOR = 'div[data-result-type="items"] > div[class*="SearchResult_SearchResultItem__"]';

const PRICE_PATTERN = /(?:￥|¥)\s*([\d,]+)|([\d,]+)\s*円/;
const SALE_PATTERN = /(\d{1,2}\s*%\s*(?:OFF|オフ)|タイムセール|スーパーDEAL|セール|特売|お買い得|ポイントバック|クーポン)/i;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null ? value as JsonRecord : null;
}

function parseYen(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/,/g, '').trim();
  const direct = Number(normalized);
  if (Number.isFinite(direct)) return Math.round(direct);
  const match = value.match(PRICE_PATTERN);
  if (!match) return null;
  const amount = Number((match[1] ?? match[2]).replace(/,/g, ''));
  return Number.isFinite(amount) ? Math.round(amount) : null;
}

function sourceShipping(source: ShoppingSource): { amount: number | null; evidence: ShippingEvidence } {
  if (source.shippingMode === 'in_store') return { amount: 0, evidence: 'in_store' };
  if (source.shippingMode === 'free') return { amount: 0, evidence: 'source_free' };
  if (source.shippingMode === 'flat' && source.flatShippingYen !== null) {
    return { amount: source.flatShippingYen, evidence: 'flat' };
  }
  return { amount: null, evidence: 'unknown' };
}

function shippingFromText(text: string, source: ShoppingSource): { amount: number | null; evidence: ShippingEvidence } {
  const excludesFreeShipping = /(送料無料|配送料無料|無料配送)\s*(?:の?対象外|ではない|不可|なし)/i.test(text);
  if (!excludesFreeShipping && /(送料無料|配送料無料|無料配送|送料\s*(?:込|込み|0\s*円))/i.test(text)) {
    return { amount: 0, evidence: 'page_free' };
  }
  const match = text.match(/(?:送料|配送料|配送)\s*(?:込み|込|:|：|は|が|\+)?\s*(?:￥|¥)?\s*([\d,]+)\s*円?/i);
  if (match) {
    const amount = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(amount)) return { amount, evidence: 'page_amount' };
  }
  return sourceShipping(source);
}

function absoluteUrl(raw: string | null | undefined, baseUrl: string): string {
  if (!raw) return baseUrl;
  try {
    const url = new URL(raw, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : baseUrl;
  } catch {
    return baseUrl;
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function createOffer(
  source: ShoppingSource,
  observedAt: string,
  title: string,
  url: string,
  price: PriceAndShipping,
  saleLabel: string | null,
): ShoppingOffer | null {
  const cleanTitle = cleanText(title).slice(0, 240);
  if (cleanTitle.length < 2 || price.priceYen <= 0 || price.priceYen > 100_000_000) return null;
  const hasValidShipping = price.shippingYen === null
    || (Number.isInteger(price.shippingYen) && price.shippingYen >= 0 && price.shippingYen <= 100_000_000);
  const shippingYen = hasValidShipping ? price.shippingYen : null;
  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceKind: source.kind,
    title: cleanTitle,
    url,
    priceYen: price.priceYen,
    shippingYen,
    totalYen: shippingYen === null ? null : price.priceYen + shippingYen,
    shippingEvidence: hasValidShipping ? price.shippingEvidence : 'unknown',
    saleLabel,
    observedAt,
  };
}

function collectJsonProducts(value: unknown, output: JsonRecord[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonProducts(item, output));
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  const type = record['@type'];
  if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) output.push(record);
  for (const child of Object.values(record)) collectJsonProducts(child, output);
}

function shippingFromJsonOffer(offer: JsonRecord, source: ShoppingSource): { amount: number | null; evidence: ShippingEvidence } {
  const details = asRecord(Array.isArray(offer.shippingDetails) ? offer.shippingDetails[0] : offer.shippingDetails);
  const rate = details ? asRecord(details.shippingRate) : null;
  const amount = parseYen(rate?.value ?? rate?.price ?? details?.shippingRate);
  if (amount !== null) return { amount, evidence: amount === 0 ? 'page_free' : 'page_amount' };
  return sourceShipping(source);
}

function parseJsonLd(root: HTMLElement, source: ShoppingSource, baseUrl: string, observedAt: string): ShoppingOffer[] {
  const products: JsonRecord[] = [];
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      collectJsonProducts(JSON.parse(script.text), products);
    } catch {
      // Third-party pages frequently contain malformed JSON-LD. DOM candidates remain available.
    }
  }
  const offers: ShoppingOffer[] = [];
  for (const product of products) {
    const rawOffers = Array.isArray(product.offers) ? product.offers : [product.offers];
    for (const rawOffer of rawOffers) {
      const offer = asRecord(rawOffer);
      if (!offer) continue;
      const priceYen = parseYen(offer.price ?? offer.lowPrice ?? offer.highPrice);
      if (priceYen === null) continue;
      const shipping = shippingFromJsonOffer(offer, source);
      const title = typeof product.name === 'string' ? product.name : '';
      const url = absoluteUrl(
        typeof offer.url === 'string' ? offer.url : typeof product.url === 'string' ? product.url : null,
        baseUrl,
      );
      const label = typeof offer.description === 'string'
        ? cleanText(offer.description).match(SALE_PATTERN)?.[0] ?? null
        : null;
      const parsed = createOffer(source, observedAt, title, url, {
        priceYen,
        shippingYen: shipping.amount,
        shippingEvidence: shipping.evidence,
      }, label);
      if (parsed) offers.push(parsed);
    }
  }
  return offers;
}

function firstText(node: HTMLElement, selectors: string[]): string {
  for (const selector of selectors) {
    const found = node.querySelector(selector);
    if (!found) continue;
    const content = found.getAttribute('content') ?? found.getAttribute('aria-label') ?? found.text;
    const clean = cleanText(content);
    if (clean) return clean;
  }
  const imageAlt = node.querySelector('img[alt]')?.getAttribute('alt');
  return imageAlt ? cleanText(imageAlt) : '';
}

function parseDom(root: HTMLElement, source: ShoppingSource, baseUrl: string, observedAt: string): ShoppingOffer[] {
  const candidates = new Set<HTMLElement>();
  const yahooResults = root.querySelectorAll(YAHOO_RESULT_SELECTOR);
  if (yahooResults.length > 0) {
    yahooResults.slice(0, 300).forEach((node) => candidates.add(node));
  } else {
    for (const selector of PRODUCT_SELECTORS) {
      root.querySelectorAll(selector).slice(0, 300).forEach((node) => candidates.add(node));
    }
  }
  if (candidates.size === 0) {
    root.querySelectorAll('a[href]').slice(0, 500).forEach((anchor) => {
      if (PRICE_PATTERN.test(anchor.parentNode?.text ?? '')) candidates.add(anchor.parentNode as HTMLElement);
    });
  }

  const offers: ShoppingOffer[] = [];
  for (const candidate of candidates) {
    const text = cleanText(candidate.text).slice(0, 2_000);
    const priceNode = firstText(candidate, [
      '.products-slider__tax', '.product-tax.price .floor-tax',
      '[itemprop="price"]', '.a-price .a-offscreen', '[data-price]', '[class*="price"]', '[class*="Price"]',
    ]);
    const priceYen = parseYen(priceNode) ?? parseYen(text);
    if (priceYen === null) continue;
    const title = firstText(candidate, [
      '.cart-product__content-txt1', '.product-item-link',
      '[itemprop="name"]', '[class*="ItemTitle"]', '[class*="itemTitle"]',
      '[class*="productTitle"]', '[class*="title"]', '[class*="name"]', 'h2', 'h3', 'h4',
    ]);
    const link = candidate.querySelector('.product-item-link')
      ?? candidate.querySelector('a.link')
      ?? candidate.querySelector('[itemprop="url"]')
      ?? candidate.querySelector('a[href]');
    const url = absoluteUrl(link?.getAttribute('content') ?? link?.getAttribute('href'), baseUrl);
    const shipping = shippingFromText(text, source);
    const parsed = createOffer(source, observedAt, title, url, {
      priceYen,
      shippingYen: shipping.amount,
      shippingEvidence: shipping.evidence,
    }, text.match(SALE_PATTERN)?.[0] ?? null);
    if (parsed) offers.push(parsed);
  }
  return offers;
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja').replace(/\s+/g, '');
}

function isRelevant(title: string, query: string): boolean {
  const normalizedTitle = normalizeSearchText(title);
  const tokens = query.normalize('NFKC').toLocaleLowerCase('ja').split(/\s+/).filter(Boolean);
  return tokens.length === 0 || tokens.every((token) => normalizedTitle.includes(token));
}

export function parseShoppingOffers(
  html: string,
  source: ShoppingSource,
  baseUrl: string,
  options: { query?: string; observedAt?: string } = {},
): ShoppingOffer[] {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const root = parse(html);
  const combined = [
    ...parseJsonLd(root, source, baseUrl, observedAt),
    ...parseDom(root, source, baseUrl, observedAt),
  ];
  const deduped = new Map<string, ShoppingOffer>();
  for (const offer of combined) {
    if (options.query && !isRelevant(offer.title, options.query)) continue;
    const key = `${normalizeSearchText(offer.title)}|${offer.priceYen}|${offer.url}`;
    const existing = deduped.get(key);
    if (!existing || (existing.shippingYen === null && offer.shippingYen !== null)) {
      deduped.set(key, offer);
    }
  }
  return [...deduped.values()].slice(0, 100);
}
