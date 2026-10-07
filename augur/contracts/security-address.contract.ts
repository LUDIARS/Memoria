import { isBlockedAddress } from '../../server/shared/public-url.js';

export default {
  post: (result: { address: string; family: number }): true | string =>
    (!isBlockedAddress(result.address) && [4, 6].includes(result.family)) || 'connection must use a public address',
};
