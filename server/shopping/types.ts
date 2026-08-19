export type ShoppingSourceKind = 'flyer' | 'online' | 'sale';
export type ShoppingShippingMode = 'page' | 'free' | 'in_store' | 'flat';

export interface ShoppingSource {
  id: string;
  name: string;
  kind: ShoppingSourceKind;
  pageUrl: string;
  searchUrlTemplate: string | null;
  shippingMode: ShoppingShippingMode;
  flatShippingYen: number | null;
  enabled: boolean;
}

export interface ShoppingConfig {
  defaultsVersion: number;
  enabled: boolean;
  refreshHour: number;
  maxItemsPerSource: number;
  sources: ShoppingSource[];
}

export type ShippingEvidence = 'page_free' | 'page_amount' | 'source_free' | 'in_store' | 'flat' | 'unknown';

export interface ShoppingOffer {
  sourceId: string;
  sourceName: string;
  sourceKind: ShoppingSourceKind;
  title: string;
  url: string;
  priceYen: number;
  shippingYen: number | null;
  totalYen: number | null;
  shippingEvidence: ShippingEvidence;
  saleLabel: string | null;
  observedAt: string;
}

export interface ShoppingSourceFailure {
  sourceId: string;
  sourceName: string;
  message: string;
}

export interface ShoppingDigest {
  date: string;
  generatedAt: string;
  items: ShoppingOffer[];
  failures: ShoppingSourceFailure[];
}

export interface ShoppingSearchResult {
  query: string;
  searchedAt: string;
  winner: ShoppingOffer | null;
  offers: ShoppingOffer[];
  failures: ShoppingSourceFailure[];
}
