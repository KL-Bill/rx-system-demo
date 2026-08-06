const express = require('express');

const router = express.Router();
const c = require('../controllers/rx');

router.get('/stations', c.stations);
router.get('/doctors', c.doctors);
router.get('/suggest', c.suggest);
router.get('/product', c.product);
router.post('/', c.create);

module.exports = router;
