// Trends router (mounted at `/api/trends`).
//
// All read-only aggregation endpoints. The GitHub trend keeps its in-memory
// 5-min cache colocated here.
import { Hono } from 'hono';

export function createTrendsRouter({
  db,
  trendsCategories,
  trendsCategoryDiff,
  trendsTimeline,
  trendsDomains,
  trendsVisitDomains,
  trendsWorkHours,
  trendsKeywords,
  trendsGpsWalking,
  fetchGithubRange,
  settingsAsObject,
}) {
  const router = new Hono();

  router.get('/categories', (c) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: trendsCategories(db, { sinceDays: days }) });
  });

  router.get('/category-diff', (c) => {
    const days = Number(c.req.query('days')) || 7;
    return c.json({ items: trendsCategoryDiff(db, { sinceDays: days }) });
  });

  router.get('/timeline', (c) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: trendsTimeline(db, { sinceDays: days }) });
  });

  router.get('/domains', (c) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: trendsDomains(db, { sinceDays: days }) });
  });

  router.get('/visit-domains', (c) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: trendsVisitDomains(db, { sinceDays: days }) });
  });

  router.get('/work-hours', (c) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: trendsWorkHours(db, { sinceDays: days }) });
  });

  router.get('/keywords', (c) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: trendsKeywords(db, { sinceDays: days, limit: 30 }) });
  });

  // GPS-derived walking trend (distance + walking-time + travel-time per day).
  // Sourced from the OwnTracks ingestion pipeline. Days without points → 0s.
  router.get('/gps-walking', (c) => {
    const days = Number(c.req.query('days')) || 30;
    return c.json({ items: trendsGpsWalking(db, { sinceDays: days }) });
  });

  // GitHub commit trend (only meaningful when a token + user + repos are
  // configured under diary settings). Cached in memory for 5 min so the user
  // can flip the trends-range select without hammering the API.
  const githubTrendCache = new Map(); // key = `${days}` → { at, payload }
  router.get('/github', async (c) => {
    const days = Number(c.req.query('days')) || 30;
    const key = `${days}`;
    const cached = githubTrendCache.get(key);
    if (cached && Date.now() - cached.at < 5 * 60_000) {
      return c.json(cached.payload);
    }
    const settings = settingsAsObject();
    if (!settings.github_user || !settings.github_repos?.length) {
      return c.json({ enabled: false, reason: 'github_not_configured' });
    }
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const until = new Date().toISOString();
    try {
      const r = await fetchGithubRange({
        token: settings.github_token,
        user: settings.github_user,
        repos: settings.github_repos,
        since, until,
      });
      // Per-day commit count for the line chart.
      const perDay = new Map();
      for (const c of (r.commits || [])) {
        const d = String(c.created_at || '').slice(0, 10);
        if (!d) continue;
        perDay.set(d, (perDay.get(d) || 0) + 1);
      }
      const today = new Date();
      const series = [];
      for (let i = days - 1; i >= 0; i--) {
        const dt = new Date(today);
        dt.setDate(today.getDate() - i);
        const k = dt.toISOString().slice(0, 10);
        series.push({ date: k, count: perDay.get(k) || 0 });
      }
      const payload = {
        enabled: true,
        total: (r.commits || []).length,
        repos: r.repos || [],
        series,
      };
      githubTrendCache.set(key, { at: Date.now(), payload });
      return c.json(payload);
    } catch (e) {
      return c.json({ enabled: true, error: e.message, total: 0, repos: [], series: [] });
    }
  });

  return router;
}
