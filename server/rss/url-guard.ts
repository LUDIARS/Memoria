// RSS の公開 API 名を保ったまま、任意 URL の検証責務を shared 層へ集約する。
// shopping 等の別ドメインも同じ防御を使い、ドメイン間 import を作らない。

export {
  BlockedUrlError,
  isBlockedAddress,
  assertPublicHttpUrl as assertFetchableFeedUrl,
} from '../shared/public-url.js';
