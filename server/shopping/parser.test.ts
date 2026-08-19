import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShoppingOffers } from './parser.js';
import type { ShoppingSource } from './types.js';

const onlineSource: ShoppingSource = {
  id: 'net-store',
  name: 'ネット店',
  kind: 'online',
  pageUrl: 'https://shop.example.com/',
  searchUrlTemplate: 'https://shop.example.com/search?q={query}',
  shippingMode: 'page',
  flatShippingYen: null,
  enabled: true,
};

test('JSON-LD の商品価格と送料から総額を作る', () => {
  const html = `<!doctype html><script type="application/ld+json">
  {
    "@type": "Product",
    "name": "無洗米 5kg",
    "url": "/rice",
    "offers": {
      "@type": "Offer",
      "price": "2980",
      "shippingDetails": { "shippingRate": { "value": "550" } }
    }
  }
  </script>`;
  const offers = parseShoppingOffers(html, onlineSource, onlineSource.pageUrl, {
    query: '無洗米 5kg',
    observedAt: '2026-07-13T00:00:00.000Z',
  });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].priceYen, 2_980);
  assert.equal(offers[0].shippingYen, 550);
  assert.equal(offers[0].totalYen, 3_530);
  assert.equal(offers[0].url, 'https://shop.example.com/rice');
});

test('店頭チラシは送料0円、通販の送料不明は総額未確定にする', () => {
  const html = `<article class="product">
    <h3>牛乳 1L</h3><a href="/milk">詳細</a><span class="price">198円</span><b>本日特売</b>
  </article>`;
  const flyerSource: ShoppingSource = {
    ...onlineSource,
    id: 'flyer',
    name: '近所のスーパー',
    kind: 'flyer',
    shippingMode: 'in_store',
  };
  const flyer = parseShoppingOffers(html, flyerSource, flyerSource.pageUrl, { query: '牛乳' })[0];
  const online = parseShoppingOffers(html, onlineSource, onlineSource.pageUrl, { query: '牛乳' })[0];
  assert.equal(flyer.shippingYen, 0);
  assert.equal(flyer.totalYen, 198);
  assert.equal(flyer.saleLabel, '特売');
  assert.equal(online.shippingYen, null);
  assert.equal(online.totalYen, null);
});

test('送料無料の否定表現を無料配送と誤認しない', () => {
  const html = `<article class="product">
    <h3>特売商品</h3><a href="/item">詳細</a><span class="price">100円</span>
    <span>送料無料対象外</span>
  </article>`;
  const offer = parseShoppingOffers(html, onlineSource, onlineSource.pageUrl, { query: '特売商品' })[0];
  assert.equal(offer.shippingYen, null);
  assert.equal(offer.totalYen, null);
});

test('同一商品のDOMに送料根拠があればJSON-LDの送料不明を補完する', () => {
  const html = `<script type="application/ld+json">
    {"@type":"Product","name":"無洗米 5kg","url":"/rice","offers":{"price":"3000"}}
  </script>
  <article class="product" itemtype="https://schema.org/Product">
    <h3>無洗米 5kg</h3><a href="/rice">詳細</a><span class="price">3,000円</span><span>送料無料</span>
  </article>`;
  const offers = parseShoppingOffers(html, onlineSource, onlineSource.pageUrl, { query: '無洗米 5kg' });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].shippingYen, 0);
  assert.equal(offers[0].totalYen, 3_000);
});

test('JSON-LDの不正な負数送料を最安判定可能な総額に使わない', () => {
  const html = `<!doctype html><script type="application/ld+json">
  {
    "@type": "Product",
    "name": "無洗米 5kg",
    "url": "/rice",
    "offers": {
      "@type": "Offer",
      "price": "2980",
      "shippingDetails": { "shippingRate": { "value": "-500" } }
    }
  }
  </script>`;
  const offer = parseShoppingOffers(html, onlineSource, onlineSource.pageUrl, { query: '無洗米 5kg' })[0];
  assert.equal(offer.shippingYen, null);
  assert.equal(offer.totalYen, null);
  assert.equal(offer.shippingEvidence, 'unknown');
});

test('商品リンクの危険なスキームは巡回元URLへ戻す', () => {
  const html = `<article class="product">
    <h3>牛乳</h3><a href="javascript:alert(1)">詳細</a><span class="price">198円</span>
  </article>`;
  const offer = parseShoppingOffers(html, onlineSource, onlineSource.pageUrl, { query: '牛乳' })[0];
  assert.equal(offer.url, onlineSource.pageUrl);
});

test('Yahoo!検索結果では配送バッジでなく商品タイトルを採用する', () => {
  const html = `<div data-result-type="items">
    <div class="SearchResult_SearchResultItem__abc">
      <h2>優良配送</h2>
      <a href="https://store.shopping.yahoo.co.jp/example/rice.html">
        <span class="ItemTitle_SearchResultItemTitle__abc">令和7年産 無洗米 5kg</span>
      </a>
      <span class="ItemPrice_ItemPrice__abc">3,480円</span>
      <span>送料無料</span>
    </div>
  </div>`;
  const offer = parseShoppingOffers(html, onlineSource, onlineSource.pageUrl, { query: '無洗米 5kg' })[0];
  assert.equal(offer.title, '令和7年産 無洗米 5kg');
  assert.equal(offer.priceYen, 3_480);
  assert.equal(offer.shippingYen, 0);
});

test('イオンネットスーパーでは商品カードの税込価格を優先する', () => {
  const html = `<li class="item product product-item">
    <a href="/customer/account/login/">お気に入りに追加</a>
    <a class="product-item-link" href="/milk.html">トップバリュ 成分無調整牛乳 1000ml</a>
    <div class="price-box">
      <span class="floor-price">228</span>円
      <p class="price product-tax"><span class="floor-tax">246</span><span class="decimal-tax">.24</span>円</p>
    </div>
  </li>`;
  const offer = parseShoppingOffers(html, onlineSource, onlineSource.pageUrl, { query: '牛乳' })[0];
  assert.equal(offer.title, 'トップバリュ 成分無調整牛乳 1000ml');
  assert.equal(offer.priceYen, 246);
  assert.equal(offer.shippingYen, null);
  assert.equal(offer.url, 'https://shop.example.com/milk.html');
});

test('マルエツネットスーパーでは商品名と税込価格を商品カードから読む', () => {
  const html = `<div class="swiper-slide front_item-info-area">
    <a class="link" href="/item?companyCode=200&amp;storeCode=09264&amp;itemCode=milk">
      <img alt="マルエツ牛乳の写真">
      <div class="cart-product__content-txt1">マルエツ牛乳 1000ml</div>
      <div class="products-slider__price">￥218</div>
      <div class="products-slider__tax">(税込 ￥235)</div>
    </a>
  </div>`;
  const offer = parseShoppingOffers(html, onlineSource, onlineSource.pageUrl, { query: '牛乳' })[0];
  assert.equal(offer.title, 'マルエツ牛乳 1000ml');
  assert.equal(offer.priceYen, 235);
  assert.equal(offer.shippingYen, null);
  assert.equal(offer.url, 'https://shop.example.com/item?companyCode=200&storeCode=09264&itemCode=milk');
});
