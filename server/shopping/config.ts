import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import type { ShoppingConfig, ShoppingDigest } from './types.js';

type Db = BetterSqlite3.Database;

const YAHOO_DEFAULTS_VERSION = 1;
const NETWORK_SUPERMARKET_DEFAULTS_VERSION = 2;
const CURRENT_DEFAULTS_VERSION = NETWORK_SUPERMARKET_DEFAULTS_VERSION;
const MAX_SHOPPING_SOURCES = 30;

const httpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'http(s) URL required');

export const shoppingSourceSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['flyer', 'online', 'sale']),
  pageUrl: httpUrlSchema,
  searchUrlTemplate: z.union([
    httpUrlSchema.refine((value) => value.includes('{query}'), '{query} placeholder required'),
    z.null(),
  ]),
  shippingMode: z.enum(['page', 'free', 'in_store', 'flat']),
  flatShippingYen: z.number().int().min(0).max(1_000_000).nullable(),
  enabled: z.boolean(),
}).superRefine((source, ctx) => {
  if (source.shippingMode === 'flat' && source.flatShippingYen === null) {
    ctx.addIssue({ code: 'custom', path: ['flatShippingYen'], message: 'flat shipping amount required' });
  }
});

export const shoppingConfigSchema = z.object({
  defaultsVersion: z.number().int().min(0).max(CURRENT_DEFAULTS_VERSION).default(0),
  enabled: z.boolean(),
  refreshHour: z.number().int().min(0).max(23),
  maxItemsPerSource: z.number().int().min(1).max(20),
  sources: z.array(shoppingSourceSchema).max(MAX_SHOPPING_SOURCES),
}).superRefine((config, ctx) => {
  const ids = new Set<string>();
  config.sources.forEach((source, index) => {
    if (ids.has(source.id)) {
      ctx.addIssue({ code: 'custom', path: ['sources', index, 'id'], message: 'duplicate source id' });
    }
    ids.add(source.id);
  });
});

const shoppingOfferSchema = z.object({
  sourceId: z.string().min(1).max(80),
  sourceName: z.string().min(1).max(80),
  sourceKind: z.enum(['flyer', 'online', 'sale']),
  title: z.string().min(1).max(240),
  url: httpUrlSchema,
  priceYen: z.number().int().min(1).max(100_000_000),
  shippingYen: z.number().int().min(0).max(100_000_000).nullable(),
  totalYen: z.number().int().min(1).max(200_000_000).nullable(),
  shippingEvidence: z.enum(['page_free', 'page_amount', 'source_free', 'in_store', 'flat', 'unknown']),
  saleLabel: z.string().max(240).nullable(),
  observedAt: z.string().datetime(),
});

export const shoppingDigestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: z.string().datetime(),
  items: z.array(shoppingOfferSchema).max(600),
  failures: z.array(z.object({
    sourceId: z.string().min(1).max(80),
    sourceName: z.string().min(1).max(80),
    message: z.string().max(240),
  })).max(30),
});

const YAHOO_SHOPPING_SOURCE: ShoppingConfig['sources'][number] = {
  id: 'yahoo-shopping',
  name: 'Yahoo!ショッピング セール・クーポン',
  kind: 'sale',
  pageUrl: 'https://shopping.yahoo.co.jp/promotion/coupon/everydayitems/',
  searchUrlTemplate: 'https://shopping.yahoo.co.jp/search/{query}/0/',
  shippingMode: 'page',
  flatShippingYen: null,
  enabled: true,
};

const AEON_NETSUPER_SOURCE: ShoppingConfig['sources'][number] = {
  id: 'aeon-netsuper',
  name: 'イオンネットスーパー（利用店舗URLを設定）',
  kind: 'online',
  pageUrl: 'https://shop.aeon.com/netsuper/store/area',
  searchUrlTemplate: null,
  shippingMode: 'page',
  flatShippingYen: null,
  enabled: false,
};

const MARUETSU_ONLINE_DELIVERY_SOURCE: ShoppingConfig['sources'][number] = {
  id: 'maruetsu-online-delivery',
  name: 'マルエツネットスーパー（公開見学店・要確認）',
  kind: 'online',
  pageUrl: 'https://od.ignica.com/maruetsu',
  searchUrlTemplate: 'https://od.ignica.com/search?keyword={query}',
  shippingMode: 'page',
  flatShippingYen: null,
  enabled: false,
};

export const DEFAULT_SHOPPING_CONFIG: ShoppingConfig = {
  defaultsVersion: CURRENT_DEFAULTS_VERSION,
  enabled: true,
  refreshHour: 7,
  maxItemsPerSource: 6,
  sources: [
    {
      id: 'amazon-jp',
      name: 'Amazon.co.jp タイムセール',
      kind: 'sale',
      pageUrl: 'https://www.amazon.co.jp/deals',
      searchUrlTemplate: 'https://www.amazon.co.jp/s?k={query}',
      shippingMode: 'page',
      flatShippingYen: null,
      enabled: true,
    },
    {
      id: 'rakuten-super-deal',
      name: '楽天市場 スーパーDEAL',
      kind: 'sale',
      pageUrl: 'https://event.rakuten.co.jp/superdeal/campaign/superdealdays/',
      searchUrlTemplate: 'https://search.rakuten.co.jp/search/mall/{query}/',
      shippingMode: 'page',
      flatShippingYen: null,
      enabled: true,
    },
    YAHOO_SHOPPING_SOURCE,
    AEON_NETSUPER_SOURCE,
    MARUETSU_ONLINE_DELIVERY_SOURCE,
  ],
};

const CONFIG_KEY = 'shopping.config';
const DIGEST_KEY = 'shopping.latest_digest';

function readSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

function writeSetting(db: Db, key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function getShoppingConfig(db: Db): ShoppingConfig {
  const raw = readSetting(db, CONFIG_KEY);
  if (raw === null) return structuredClone(DEFAULT_SHOPPING_CONFIG);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('shopping.config is not valid JSON');
  }
  const parsed = shoppingConfigSchema.safeParse(decoded);
  if (!parsed.success) throw new Error(`shopping.config is invalid: ${parsed.error.message}`);
  return upgradeShoppingConfigDefaults(parsed.data);
}

export function upgradeShoppingConfigDefaults(config: ShoppingConfig): ShoppingConfig {
  if (config.defaultsVersion >= CURRENT_DEFAULTS_VERSION) return config;
  let sources = config.sources;
  if (config.defaultsVersion < YAHOO_DEFAULTS_VERSION) {
    sources = appendMissingSources(sources, [YAHOO_SHOPPING_SOURCE]);
  }
  if (config.defaultsVersion < NETWORK_SUPERMARKET_DEFAULTS_VERSION) {
    sources = appendMissingSources(sources, [AEON_NETSUPER_SOURCE, MARUETSU_ONLINE_DELIVERY_SOURCE]);
  }
  return { ...config, defaultsVersion: CURRENT_DEFAULTS_VERSION, sources };
}

function appendMissingSources(
  sources: ShoppingConfig['sources'],
  defaults: ShoppingConfig['sources'],
): ShoppingConfig['sources'] {
  const ids = new Set(sources.map((source) => source.id));
  const remainingSlots = Math.max(0, MAX_SHOPPING_SOURCES - sources.length);
  return [
    ...sources,
    ...defaults
      .filter((source) => !ids.has(source.id))
      .slice(0, remainingSlots)
      .map((source) => structuredClone(source)),
  ];
}

export function setShoppingConfig(db: Db, config: ShoppingConfig): ShoppingConfig {
  const parsed = shoppingConfigSchema.parse(config);
  const upgraded = upgradeShoppingConfigDefaults(parsed);
  writeSetting(db, CONFIG_KEY, JSON.stringify(upgraded));
  return upgraded;
}

export function getShoppingDigest(db: Db): ShoppingDigest | null {
  const raw = readSetting(db, DIGEST_KEY);
  if (raw === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('shopping.latest_digest is not valid JSON');
  }
  const parsed = shoppingDigestSchema.safeParse(decoded);
  if (!parsed.success) throw new Error(`shopping.latest_digest is invalid: ${parsed.error.message}`);
  return parsed.data;
}

export function setShoppingDigest(db: Db, digest: ShoppingDigest): void {
  writeSetting(db, DIGEST_KEY, JSON.stringify(shoppingDigestSchema.parse(digest)));
}
