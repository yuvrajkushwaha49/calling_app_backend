const express = require('express');
const router = express.Router();
const { login, setupSuperAdmin } = require('../controllers/authController');

router.post('/login', login);

if (process.env.NODE_ENV === 'production' && process.env.ENABLE_SETUP_ROUTE !== 'true') {
    router.post('/setup', (req, res) => {
        res.status(404).json({ success: false, message: 'Not found' });
    });
} else {
    router.post('/setup', setupSuperAdmin);
}

module.exports = router;
