// Contract for usageDashboard (spec/tasks/2026-09-29-llm-usage-cost-accuracy.md, C-6).
// The period total is reconcilable: it equals the per-model rows, so nothing is
// dropped by a list limit or counted twice.

type Summary = { responses: number; cost_usd: number };
type Dashboard = { period: { summary: Summary; by_model: Summary[] } };

export default {
  post: (result: Dashboard): true | string => {
    const rows = result.period.by_model;
    const responses = rows.reduce((sum, row) => sum + Number(row.responses), 0);
    const cost = rows.reduce((sum, row) => sum + Number(row.cost_usd), 0);
    if (responses !== Number(result.period.summary.responses)) return 'period responses must equal the model rows';
    return Math.abs(cost - Number(result.period.summary.cost_usd)) < 1e-6 || 'period cost must equal the model rows';
  },
};
