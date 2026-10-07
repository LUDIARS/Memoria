export default {
  post: (result: Record<string, string>): true | string => {
    const policy = result['Content-Security-Policy'] ?? '';
    return (policy.includes('sandbox;') && policy.includes("default-src 'none'")
      && !policy.includes('allow-scripts') && !policy.includes('allow-same-origin')) || 'saved HTML must have no origin or script authority';
  },
};
