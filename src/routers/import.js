const express = require('express');

const router = express.Router();
const c = require('../controllers/import');

// the file itself, as the raw body — not JSON, not multipart. 25 MB is a
// hundred times the real export; the limit is a guard, not a budget.
router.post('/upload', express.raw({ type: () => true, limit: '25mb' }), c.upload);

router.get('/', c.list);
router.get('/exclusions', c.exclusions);
router.delete('/exclusions/:key', c.forgetExclusion);
router.get('/:id', c.get);
router.get('/:id/report.csv', c.report);
router.post('/:id/analyze', c.analyze);
router.post('/:id/decisions', c.decisions);
router.post('/:id/apply', c.apply);
router.post('/:id/cancel', c.cancel);

module.exports = router;
