const express = require('express');

const router = express.Router();
const c = require('../controllers/pharmacy');

router.get('/review', c.review);
router.get('/audit', c.audit);
router.post('/meds/:id/confirm', c.confirm);
router.put('/meds/:id', c.edit);

module.exports = router;
