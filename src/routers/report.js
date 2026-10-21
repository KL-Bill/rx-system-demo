const express = require('express');

const router = express.Router();
const c = require('../controllers/report');

router.get('/', c.get);
router.post('/export.xlsx', c.xlsx);
router.get('/export.xlsx', c.xlsx);

module.exports = router;
