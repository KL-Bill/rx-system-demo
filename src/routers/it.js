const express = require('express');

const router = express.Router();
const c = require('../controllers/it');

router.get('/logs', c.logs);
router.get('/audit', c.audit);
router.get('/users', c.users);
router.post('/users', c.createUser);
router.post('/users/:id/reset-password', c.resetPassword);
router.post('/users/:id/active', c.setActive);
router.get('/backups', c.backups);
router.get('/health', c.health);

module.exports = router;
