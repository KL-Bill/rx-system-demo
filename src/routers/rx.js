const express = require('express');

const router = express.Router();
const c = require('../controllers/rx');

router.get('/stations', c.stations);
router.get('/doctors', c.doctors);
router.get('/suggest', c.suggest);
router.get('/forms', c.forms);
router.get('/product', c.product);
router.post('/', c.create);
// the station's own history: answers only for receipts the kiosk presents
router.post('/history', c.history);
router.post('/reprint', c.reprint);

module.exports = router;
