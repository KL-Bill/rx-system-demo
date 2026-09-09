const express = require('express');
const { requireMaster } = require('../middlewares/auth');

const router = express.Router();
const c = require('../controllers/it');

router.get('/logs', c.logs);
router.get('/audit', c.audit);
// accounts: master IT only (see requireMaster)
router.get('/users', requireMaster, c.users);
router.post('/users', requireMaster, c.createUser);
router.post('/users/:id/reset-password', requireMaster, c.resetPassword);
router.post('/users/:id/active', requireMaster, c.setActive);
router.get('/prescriptions', c.prescriptions);
// POST, not DELETE: the body carries the password, the confirmation and either
// a list of ids or a date range — more than belongs in a DELETE's query string
router.post('/prescriptions/delete', c.deletePrescriptions);
router.post('/prescriptions/restore', c.restorePrescriptions);
router.get('/backups', c.backups);
router.post('/backups', c.createBackup);
router.get('/backups/:file/download', c.downloadBackup);
router.post('/backups/:file/restore', c.restoreBackup);
router.get('/health', c.health);

// master data the nurse page offers: doctors and stations
router.get('/doctors', c.doctors);
router.post('/doctors', c.createDoctor);
router.post('/doctors/:id', c.updateDoctor);
router.post('/doctors/:id/delete', c.deleteDoctor);
router.post('/doctors/:id/restore', c.restoreDoctor);
router.get('/stations', c.stations);
router.post('/stations', c.createStation);
router.post('/stations/:id', c.updateStation);

module.exports = router;
