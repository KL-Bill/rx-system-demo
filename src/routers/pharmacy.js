const express = require('express');
const { requireRole } = require('../middlewares/auth');

const router = express.Router();
const c = require('../controllers/pharmacy');

router.get('/review', c.review);
router.get('/detail', c.detail);
router.get('/prescriptions', c.prescriptions);
router.get('/audit', c.audit);
router.post('/status', c.status);
router.post('/status/bulk', c.statusBulk);

// remarks: admin, or staff with an admin password in the body (checked in the model)
router.get('/remarks', c.remarks);
router.post('/remarks', c.addRemark);

// catalog: "what else exists under this generic" is read-only and open to
// both roles; adding to Bizbox by hand is the pharmacy head's alone
router.get('/catalog/similar', c.similar);
router.post('/catalog', requireRole('admin'), c.addCatalog);

module.exports = router;
