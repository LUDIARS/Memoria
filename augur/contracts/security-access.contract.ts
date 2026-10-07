export default {
  post: (result: boolean, c: { req: { header: (name: string) => string | undefined } }): true | string => {
    if (c.req.header('origin') === 'null' && result) return 'opaque origins must never receive authority';
    return typeof result === 'boolean' || 'authorization must be explicit';
  },
};
