const express = require('express');

const router = express.Router();
const c = require('../controllers/formulary');

// the RX Formulary: this app's medicine list (Bizbox is the hospital's main
// system). Guarded in app.js: pharmacy head and IT.
router.get('/', c.search);
router.get('/similar', c.similar);
router.post('/', c.add);
router.get('/:id', c.get);
router.post('/:id', c.update);
router.post('/:id/merge', c.merge);
router.post('/:id/restore', c.restore);

module.exports = router;
