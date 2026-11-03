import { isDeepStrictEqual } from 'node:util';

interface PackageEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
}

export interface QsLockSnapshot {
  registry: { version: string; dist: { tarball: string; integrity: string }; dependencies: Record<string, string> };
  locks: { before: { packages: Record<string, PackageEntry> }; after: { packages: Record<string, PackageEntry> } }[];
}

export default {
  post: (result: QsLockSnapshot): true | string => {
    if (result.registry.version !== '6.16.2') return 'registry version differs';
    for (const { before, after } of result.locks) {
      const previous = before.packages['node_modules/qs'];
      const current = after.packages['node_modules/qs'];
      if (previous.version !== '6.16.0' || current.version !== '6.16.2') return 'unexpected qs version';
      if (current.resolved !== result.registry.dist.tarball || current.integrity !== result.registry.dist.integrity) return 'registry metadata differs';
      if (!isDeepStrictEqual(current.dependencies, result.registry.dependencies)) return 'qs dependency metadata differs';
      const parents = Object.values(before.packages).filter(entry => entry.dependencies?.qs);
      if (!parents.length || parents.some(entry => !['~6.16.0', '^6.15.2', '^6.14.0'].includes(entry.dependencies?.qs ?? ''))) return 'unreviewed parent range';
      const expected = structuredClone(before);
      Object.assign(expected.packages['node_modules/qs'], {
        version: '6.16.2', resolved: result.registry.dist.tarball, integrity: result.registry.dist.integrity,
      });
      if (!isDeepStrictEqual(expected, after)) return 'changes outside qs version, resolved and integrity';
    }
    return result.locks.length === 2 || 'both lockfiles required';
  },
};
