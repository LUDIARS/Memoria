interface Evidence {
  resolutions: string[];
  connections: Array<{ host: string; address: string; family: number; identity: boolean }>;
  bodyMatches: boolean;
}

export default {
  post: (result: Evidence): true | string => (
    result.bodyMatches && result.resolutions.length === 2 && result.connections.length === 2
    && result.connections.every((connection, index) =>
      connection.host === result.resolutions[index]
      && connection.address === (index === 0 ? '8.8.8.8' : '1.1.1.1')
      && connection.family === 4 && connection.identity)
  ) || 'each redirect hop must connect only to its checked IP and retain the response body',
};
