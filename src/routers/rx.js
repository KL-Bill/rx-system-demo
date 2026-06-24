const express = require('express');

const router = express.Router();
const c = require('../controllers/rx');

router.get('/stations', c.stations);
router.get('/doctors', c.doctors);
router.get('/catalog', c.catalog);
router.post('/', c.create);

module.exports = router;
