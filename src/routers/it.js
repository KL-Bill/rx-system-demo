const express = require('express');

const router = express.Router();
const c = require('../controllers/it');

router.get('/logs', c.logs);
router.get('/audit', c.audit);
router.get('/users', c.users);
router.post('/users', c.createUser);
router.post('/users/:id/reset-password', c.resetPassword);
router.post('/users/:id/active', c.setActive);
router.get('/prescriptions', c.prescriptions);
// POST, not DELETE: the body carries the password, the confirmation and either
// a list of ids or a date range — more than belongs in a DELETE's query string
router.post('/prescriptions/delete', c.deletePrescriptions);
router.get('/backups', c.backups);
router.post('/backups', c.createBackup);
router.get('/backups/:file/download', c.downloadBackup);
router.post('/backups/:file/restore', c.restoreBackup);
router.get('/health', c.health);

module.exports = router;
