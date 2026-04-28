const express = require('express');
const router = express.Router();
const { createBusiness, getBusinesses } = require('../controllers/businessController');
const authenticateToken = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/roleMiddleware');

router.use(authenticateToken); // Protect all routes

router.post('/', authorizeRoles('super_admin'), createBusiness);
router.get('/', authorizeRoles('super_admin'), getBusinesses);

module.exports = router;
