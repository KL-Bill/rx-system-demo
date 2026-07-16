const express = require('express');

const router = express.Router();
const c = require('../controllers/pharmacy');

router.get('/review', c.review);
router.get('/detail', c.detail);
router.get('/prescriptions', c.prescriptions);
router.get('/audit', c.audit);
router.post('/status', c.status);
router.post('/status/bulk', c.statusBulk);

module.exports = router;
