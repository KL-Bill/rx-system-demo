const express = require('express');

const router = express.Router();
const c = require('../controllers/formulary');

// the RX Formulary: this app's medicine list (Bizbox is the hospital's main
// system). Guarded in app.js: pharmacy head and IT.
router.get('/', c.search);
router.get('/similar', c.similar);
router.post('/', c.add);
// medical supplies — before /:id, which would swallow "supplies"
router.get('/supplies', c.supplySearch);
router.post('/supplies', c.supplyAdd);
router.get('/supplies/:id', c.supplyGet);
router.post('/supplies/:id', c.supplyUpdate);
router.post('/supplies/:id/merge', c.supplyMerge);
router.post('/supplies/:id/restore', c.supplyRestore);
router.get('/:id', c.get);
router.post('/:id', c.update);
router.post('/:id/merge', c.merge);
router.post('/:id/restore', c.restore);

module.exports = router;
