const express = require('express');
const router = express.Router();
const multer = require('multer');
const { createLead, importLeads, getLeads, assignLeads } = require('../controllers/leadController');
const authenticateToken = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/roleMiddleware');

const upload = multer({ storage: multer.memoryStorage() });

router.use(authenticateToken);

router.post('/', authorizeRoles('super_admin', 'business_admin', 'admin', 'team_leader'), createLead);
router.post('/import', authorizeRoles('super_admin', 'business_admin', 'admin', 'team_leader'), upload.single('file'), importLeads);
router.get('/', getLeads);
router.post('/assign', authorizeRoles('super_admin', 'business_admin', 'admin', 'team_leader'), assignLeads);

module.exports = router;
