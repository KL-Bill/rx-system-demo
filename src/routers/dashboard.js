const express = require('express');

const router = express.Router();
const c = require('../controllers/dashboard');

router.get('/', c.get);

module.exports = router;
