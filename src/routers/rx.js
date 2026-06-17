const express = require('express');

const router = express.Router();
const c = require('../controllers/rx');

router.get('/stations', c.stations);
router.get('/meds', c.meds);
router.post('/', c.create);

module.exports = router;
