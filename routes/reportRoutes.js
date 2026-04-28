const express = require('express');
const router = express.Router();
const { getDashboardStats } = require('../controllers/reportController');
const authenticateToken = require('../middleware/authMiddleware');

router.use(authenticateToken);

router.get('/dashboard', getDashboardStats);

module.exports = router;
