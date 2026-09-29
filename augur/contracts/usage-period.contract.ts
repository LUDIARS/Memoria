// Contract for parseUsagePeriod (spec/tasks/2026-09-29-llm-usage-cost-accuracy.md, C-5).
// A period handed to the dashboard is always a well-formed, ordered JST range.

type Period = { from: string; to: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default {
  post: (result: Period): true | string => {
    if (!DATE.test(result.from) || !DATE.test(result.to)) return 'period bounds must be YYYY-MM-DD';
    return result.from <= result.to || 'from must not be after to';
  },
};
