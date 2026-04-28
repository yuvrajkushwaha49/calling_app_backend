const express = require('express');
const router = express.Router();
const { logCall, getFollowups, saveCallRemark, getCallRemarks, saveExternalDialerCall, autoLogCall, updateCallRemark, getLoggedCalls } = require('../controllers/callController');
const authenticateToken = require('../middleware/authMiddleware');

router.use(authenticateToken);

router.post('/', logCall);
router.post('/auto-log', autoLogCall);
router.get('/logged', getLoggedCalls);
router.get('/remarks', getCallRemarks);
router.post('/remarks', saveCallRemark);
router.post('/external-remarks', saveExternalDialerCall);
router.patch('/:id/remark', updateCallRemark);
router.get('/followups', getFollowups);

module.exports = router;
