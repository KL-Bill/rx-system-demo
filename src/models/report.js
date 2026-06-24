const demand = require('./demand');

// date-range report of problem drugs, filtered by reason (not_in_formulary | out_of_stock | both)
const build = ({ reason, from, to, department } = {}) => ({
    generatedAt: Date.now(),
    reason: reason || 'both',
    department: department || 'all',
    period: { from: from ?? null, to: to ?? null },
    rows: demand.aggregate({ reason: reason || 'both', from, to, department }),
});

module.exports = { build };
