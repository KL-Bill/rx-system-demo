const express = require('express');

const router = express.Router();
const c = require('../controllers/pharmacy');

router.get('/review', c.review);
router.get('/detail', c.detail);
router.get('/audit', c.audit);
router.post('/status', c.status);

module.exports = router;
