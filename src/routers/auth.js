const express = require('express');

const router = express.Router();
const c = require('../controllers/auth');

router.post('/login', c.login);
router.post('/logout', c.logout);
router.get('/me', c.me);

module.exports = router;
