const express = require('express');
const router = express.Router();
const { createUser, getUsers, getTeam, getTeams, getTeamLeads, createTeam, updateTeamLeader, updateTeamMembers, updateTeamName, deleteTeam, getAvailableTeamLeaders, getAvailableTeamMembers, getUser, getUserCalls, getUserFollowups, updateUserPassword, updateUserStatus, deleteUser } = require('../controllers/userController');
const authenticateToken = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/roleMiddleware');

router.use(authenticateToken);

router.get('/teams', authorizeRoles('super_admin', 'business_admin', 'admin', 'team_leader'), getTeams);
router.get('/teams/:id', authorizeRoles('super_admin', 'business_admin', 'admin', 'team_leader'), getTeam);
router.get('/teams/:id/available-leaders', authorizeRoles('super_admin', 'business_admin', 'admin', 'team_leader'), getAvailableTeamLeaders);
router.get('/teams/:id/available-members', authorizeRoles('super_admin', 'business_admin', 'admin', 'team_leader'), getAvailableTeamMembers);
router.get('/teams/:id/leads', authorizeRoles('super_admin', 'business_admin', 'admin', 'team_leader'), getTeamLeads);
router.post('/teams', authorizeRoles('super_admin', 'business_admin', 'admin'), createTeam);
router.put('/teams/:id/leader', authorizeRoles('super_admin', 'business_admin', 'admin'), updateTeamLeader);
router.put('/teams/:id/members', authorizeRoles('super_admin', 'business_admin', 'admin', 'team_leader'), updateTeamMembers);
router.put('/teams/:id', authorizeRoles('super_admin', 'business_admin', 'admin'), updateTeamName);
router.delete('/teams/:id', authorizeRoles('super_admin', 'business_admin', 'admin'), deleteTeam);
router.post('/', authorizeRoles('super_admin', 'business_admin', 'admin'), createUser);
router.get('/', authorizeRoles('super_admin', 'business_admin', 'admin', 'team_leader'), getUsers);
router.get('/:id', authorizeRoles('super_admin', 'business_admin', 'admin', 'team_leader', 'employee'), getUser);
router.get('/:id/calls', authorizeRoles('super_admin', 'business_admin', 'admin', 'team_leader'), getUserCalls);
router.get('/:id/followups', authorizeRoles('super_admin', 'business_admin', 'admin', 'team_leader', 'employee'), getUserFollowups);
router.put('/:id/password', updateUserPassword);
router.put('/:id/status', authorizeRoles('super_admin', 'business_admin', 'admin'), updateUserStatus);
router.delete('/:id', authorizeRoles('super_admin', 'business_admin', 'admin'), deleteUser);

module.exports = router;
