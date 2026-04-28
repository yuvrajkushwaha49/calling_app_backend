const bcrypt = require('bcryptjs');
const db = require('../config/db');

const getRoleId = async (roleName) => {
    const [roles] = await db.execute('SELECT id FROM roles_permissions WHERE role_name = ?', [roleName]);
    if (roles.length === 0) return null;
    return roles[0].id;
};

// Ensure a business_id is available; auto-heal for super_admin by attaching to first/creating default
const resolveBusinessId = async (req) => {
    if (req.user.business_id) return req.user.business_id;

    if (req.user.role_name === 'super_admin') {
        const [existing] = await db.execute('SELECT id FROM businesses ORDER BY id LIMIT 1');
        let businessId;
        if (existing.length > 0) {
            businessId = existing[0].id;
        } else {
            const [created] = await db.execute('INSERT INTO businesses (name) VALUES ("Default Business")');
            businessId = created.insertId;
        }
        await db.execute('UPDATE users SET business_id = ? WHERE id = ?', [businessId, req.user.id]);
        req.user.business_id = businessId;
        return businessId;
    }

    return null;
};

exports.createUser = async (req, res) => {
    try {
        const { name, email, password, phone, role_name, target_business_id, team_leader_id } = req.body;
        const currentRole = req.user.role_name;
        const currentBusinessId = await resolveBusinessId(req);

        if (!name || !email || !password || !role_name) {
            return res.status(400).json({ success: false, message: 'Please provide all required fields' });
        }

        let businessIdToAssign = currentBusinessId;

        // RBAC logic for user creation
        if (currentRole === 'super_admin') {
            if (!currentBusinessId) {
                let [businesses] = await db.execute('SELECT id FROM businesses LIMIT 1');
                if (businesses.length === 0) {
                    const [res] = await db.execute('INSERT INTO businesses (name) VALUES ("Main Headquarters")');
                    businessIdToAssign = res.insertId;
                } else {
                    businessIdToAssign = businesses[0].id;
                }
                // Heal super admin state
                await db.execute('UPDATE users SET business_id = ? WHERE id = ?', [businessIdToAssign, req.user.id]);
            } else {
                businessIdToAssign = currentBusinessId;
            }
        } else if (currentRole === 'business_admin' || currentRole === 'admin') {
            const allowedRoles = currentRole === 'business_admin' ? ['admin', 'team_leader', 'employee'] : ['team_leader', 'employee'];
            if (!allowedRoles.includes(role_name)) {
                return res.status(403).json({ success: false, message: 'You do not have permission to create this role' });
            }
        } else {
            return res.status(403).json({ success: false, message: 'Forbidden access to user creation' });
        }

        const role_id = await getRoleId(role_name);
        if (!role_id) {
            return res.status(400).json({ success: false, message: 'Invalid role' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const [result] = await db.execute(
            'INSERT INTO users (business_id, role_id, name, email, password_hash, phone, status) VALUES (?, ?, ?, ?, ?, ?, "active")',
            [businessIdToAssign, role_id, name, email, hashedPassword, phone || null]
        );

        const newUserId = result.insertId;

        // Auto-assign to Team Leader (creates team natively if it doesn't exist)
        if (role_name === 'employee' && team_leader_id) {
            let [teams] = await db.execute('SELECT id FROM teams WHERE leader_id = ?', [team_leader_id]);
            let teamId;
            if (teams.length > 0) {
                teamId = teams[0].id;
            } else {
                const [tlQuery] = await db.execute('SELECT name, business_id FROM users WHERE id = ?', [team_leader_id]);
                const tlName = tlQuery.length > 0 ? tlQuery[0].name : 'Leader';
                const tlBusinessId = (tlQuery.length > 0 && tlQuery[0].business_id) ? tlQuery[0].business_id : businessIdToAssign;
                const [newTeam] = await db.execute('INSERT INTO teams (business_id, name, leader_id) VALUES (?, ?, ?)', [tlBusinessId, tlName + " Team", team_leader_id]);
                teamId = newTeam.insertId;
            }
            await db.execute('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)', [teamId, newUserId]);
        }

        res.status(201).json({
            success: true,
            message: 'User created successfully',
            userId: newUserId
        });

    } catch (error) {
        console.error('Create user error:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: 'Email already in use' });
        }
        res.status(500).json({ success: false, message: 'Server error creating user' });
    }
};

exports.getUsers = async (req, res) => {
    try {
        const currentRole = req.user.role_name;
        const currentBusinessId = await resolveBusinessId(req);

        if (!currentBusinessId) {
            return res.status(400).json({ success: false, message: 'User is not linked to a business' });
        }

        let query = `
            SELECT u.id, u.business_id, u.name, u.email, u.phone, u.status, u.created_at, r.role_name 
            FROM users u
            JOIN roles_permissions r ON u.role_id = r.id
        `;
        let params = [];

        if (currentRole === 'super_admin') {
            query += ' ORDER BY u.business_id, u.created_at DESC';
        } else {
            query += ' WHERE u.business_id = ? ORDER BY u.created_at DESC';
            params.push(currentBusinessId);
        }

        const [users] = await db.execute(query, params);
        res.json({ success: true, count: users.length, data: users });

    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving users' });
    }
};

// Teams with active employees for assignment UI
exports.getTeams = async (req, res) => {
    try {
        const businessId = await resolveBusinessId(req);
        if (!businessId) return res.status(400).json({ success: false, message: 'User is not linked to a business' });

        const [rows] = await db.execute(
            `SELECT t.id as team_id, t.name as team_name, t.leader_id, lu.name as leader_name,
                    u.id as employee_id, u.name as employee_name
             FROM teams t
             LEFT JOIN users lu ON lu.id = t.leader_id
             LEFT JOIN team_members tm ON tm.team_id = t.id
             LEFT JOIN users u ON u.id = tm.user_id AND u.status = "active"
             WHERE t.business_id = ?
             ORDER BY t.name, u.name`,
            [businessId]
        );

        const grouped = {};
        for (const r of rows) {
            if (!grouped[r.team_id]) {
                grouped[r.team_id] = { team_id: r.team_id, team_name: r.team_name, leader_id: r.leader_id, leader_name: r.leader_name || null, employees: [] };
            }
            if (r.employee_id && !grouped[r.team_id].employees.find(e => e.id === r.employee_id)) {
                grouped[r.team_id].employees.push({ id: r.employee_id, name: r.employee_name });
            }
            // ensure leader appears in employees list for display
            if (r.leader_id && r.leader_name && !grouped[r.team_id].employees.find(e => e.id === r.leader_id)) {
                grouped[r.team_id].employees.push({ id: r.leader_id, name: r.leader_name });
            }
        }

        res.json({ success: true, data: Object.values(grouped) });
    } catch (error) {
        console.error('Get teams error:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving teams' });
    }
};

// Get single team with members
exports.getTeam = async (req, res) => {
    try {
        const businessId = await resolveBusinessId(req);
        if (!businessId) return res.status(400).json({ success: false, message: 'User is not linked to a business' });
        const teamId = req.params.id;

        const [rows] = await db.execute(
            `SELECT t.id as team_id, t.name as team_name, t.leader_id, lu.name as leader_name,
                    u.id as employee_id, u.name as employee_name
             FROM teams t
             LEFT JOIN users lu ON lu.id = t.leader_id
             LEFT JOIN team_members tm ON tm.team_id = t.id
             LEFT JOIN users u ON u.id = tm.user_id AND u.status = "active"
             WHERE t.business_id = ? AND t.id = ?`,
            [businessId, teamId]
        );

        if (rows.length === 0) return res.status(404).json({ success: false, message: 'Team not found' });

        const team = { team_id: rows[0].team_id, team_name: rows[0].team_name, leader_id: rows[0].leader_id, leader_name: rows[0].leader_name || null, employees: [] };
        for (const r of rows) {
            if (r.employee_id && !team.employees.find(e => e.id === r.employee_id)) {
                team.employees.push({ id: r.employee_id, name: r.employee_name });
            }
        }
        if (team.leader_id && team.leader_name && !team.employees.find(e => e.id === team.leader_id)) {
            team.employees.push({ id: team.leader_id, name: team.leader_name });
        }
        res.json({ success: true, data: team });
    } catch (error) {
        console.error('Get team error:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving team' });
    }
};

// Create a team and assign a leader
exports.createTeam = async (req, res) => {
    try {
        const businessId = await resolveBusinessId(req);
        if (!businessId) return res.status(400).json({ success: false, message: 'User is not linked to a business' });

        const { name, leader_id } = req.body;
        if (!name || !leader_id) {
            return res.status(400).json({ success: false, message: 'Team name and leader_id are required' });
        }

        // Verify leader belongs to same business and is active
        const [leaders] = await db.execute(
            'SELECT id FROM users WHERE id = ? AND business_id = ? AND status = "active"',
            [leader_id, businessId]
        );
        if (leaders.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid leader for this business' });
        }

        // Detach leader from any other team to avoid multi-team leadership
        await db.execute('UPDATE teams SET leader_id = NULL WHERE leader_id = ? AND business_id = ?', [leader_id, businessId]);
        await db.execute('DELETE FROM team_members WHERE user_id = ? AND team_id NOT IN (SELECT id FROM teams WHERE leader_id = ?)', [leader_id, leader_id]);

        const [result] = await db.execute(
            'INSERT INTO teams (business_id, name, leader_id) VALUES (?, ?, ?)',
            [businessId, name, leader_id]
        );

        // Ensure leader is a member of the team
        await db.execute('INSERT IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)', [result.insertId, leader_id]);

        res.status(201).json({ success: true, message: 'Team created', teamId: result.insertId });
    } catch (error) {
        console.error('Create team error:', error);
        res.status(500).json({ success: false, message: 'Server error creating team' });
    }
};

// Update team name
exports.updateTeamName = async (req, res) => {
    try {
        const businessId = await resolveBusinessId(req);
        if (!businessId) return res.status(400).json({ success: false, message: 'User is not linked to a business' });
        const teamId = req.params.id;
        const { name } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'Team name is required' });
        const [teams] = await db.execute('SELECT id FROM teams WHERE id = ? AND business_id = ?', [teamId, businessId]);
        if (teams.length === 0) return res.status(404).json({ success: false, message: 'Team not found' });
        await db.execute('UPDATE teams SET name = ? WHERE id = ?', [name, teamId]);
        res.json({ success: true, message: 'Team name updated' });
    } catch (error) {
        console.error('Update team name error:', error);
        res.status(500).json({ success: false, message: 'Server error updating team name' });
    }
};

// Delete team
exports.deleteTeam = async (req, res) => {
    try {
        const businessId = await resolveBusinessId(req);
        if (!businessId) return res.status(400).json({ success: false, message: 'User is not linked to a business' });
        const teamId = req.params.id;
        await db.execute('DELETE FROM teams WHERE id = ? AND business_id = ?', [teamId, businessId]);
        res.json({ success: true, message: 'Team deleted' });
    } catch (error) {
        console.error('Delete team error:', error);
        res.status(500).json({ success: false, message: 'Server error deleting team' });
    }
};

// Available leaders (unassigned) for a team
exports.getAvailableTeamLeaders = async (req, res) => {
    try {
        const businessId = await resolveBusinessId(req);
        if (!businessId) return res.status(400).json({ success: false, message: 'User is not linked to a business' });
        const teamId = req.params.id;

        // role_name team_leader
        const [leaders] = await db.execute(
            `
            SELECT u.id, u.name, u.email
            FROM users u
            JOIN roles_permissions r ON u.role_id = r.id
            WHERE r.role_name = 'team_leader'
              AND u.business_id = ?
              AND u.status = 'active'
              AND u.id NOT IN (
                  SELECT COALESCE(leader_id, 0) FROM teams
                  WHERE business_id = ? AND leader_id IS NOT NULL AND id <> ?
              )
            `,
            [businessId, businessId, teamId]
        );

        res.json({ success: true, data: leaders });
    } catch (error) {
        console.error('Get available leaders error:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving available leaders' });
    }
};

// Available members: employees not assigned to any team (fresh/unallocated)
exports.getAvailableTeamMembers = async (req, res) => {
    try {
        const businessId = await resolveBusinessId(req);
        if (!businessId) return res.status(400).json({ success: false, message: 'User is not linked to a business' });

        const [members] = await db.execute(
            `
            SELECT u.id, u.name, u.email
            FROM users u
            JOIN roles_permissions r ON u.role_id = r.id
            WHERE r.role_name = 'employee'
              AND u.business_id = ?
              AND u.status = 'active'
              AND u.id NOT IN (SELECT user_id FROM team_members)
              AND u.id NOT IN (SELECT leader_id FROM teams WHERE leader_id IS NOT NULL)
            `,
            [businessId]
        );

        res.json({ success: true, data: members });
    } catch (error) {
        console.error('Get available members error:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving available members' });
    }
};

// Leads allocated to a team (via member assignments)
exports.getTeamLeads = async (req, res) => {
    try {
        const businessId = await resolveBusinessId(req);
        if (!businessId) return res.status(400).json({ success: false, message: 'User is not linked to a business' });
        const teamId = req.params.id;

        const [rows] = await db.execute(
            `
            SELECT l.id, l.name, l.phone, l.status, l.created_at,
                   a.assigned_to, u.name AS employee_name
            FROM lead_assignments a
            JOIN team_members tm ON tm.user_id = a.assigned_to
            JOIN leads l ON l.id = a.lead_id
            LEFT JOIN users u ON u.id = a.assigned_to
            WHERE tm.team_id = ?
              AND l.business_id = ?
              AND a.status = 'active'
            ORDER BY l.created_at DESC
            `,
            [teamId, businessId]
        );

        res.json({ success: true, count: rows.length, data: rows });
    } catch (error) {
        console.error('Get team leads error:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving team leads' });
    }
};

// Update team leader
exports.updateTeamLeader = async (req, res) => {
    try {
        const businessId = await resolveBusinessId(req);
        if (!businessId) return res.status(400).json({ success: false, message: 'User is not linked to a business' });

        const teamId = req.params.id;
        const { leader_id } = req.body;

        if (!leader_id) return res.status(400).json({ success: false, message: 'leader_id is required' });

        // Validate team belongs to business
        const [teams] = await db.execute('SELECT id FROM teams WHERE id = ? AND business_id = ?', [teamId, businessId]);
        if (teams.length === 0) return res.status(404).json({ success: false, message: 'Team not found' });

        // Validate leader in business and active
        const [leaders] = await db.execute('SELECT id FROM users WHERE id = ? AND business_id = ? AND status = "active"', [leader_id, businessId]);
        if (leaders.length === 0) return res.status(400).json({ success: false, message: 'Invalid leader for this business' });

        // Remove leader role from other teams within same business
        await db.execute('UPDATE teams SET leader_id = NULL WHERE leader_id = ? AND id <> ? AND business_id = ?', [leader_id, teamId, businessId]);
        await db.execute('UPDATE team_members tm JOIN teams t ON tm.team_id = t.id SET tm.team_id = ? WHERE tm.user_id = ? AND t.business_id = ? AND t.id <> ?', [teamId, leader_id, businessId, teamId]);

        await db.execute('UPDATE teams SET leader_id = ? WHERE id = ?', [leader_id, teamId]);
        await db.execute('INSERT IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)', [teamId, leader_id]);

        res.json({ success: true, message: 'Team leader updated' });
    } catch (error) {
        console.error('Update team leader error:', error);
        res.status(500).json({ success: false, message: 'Server error updating team leader' });
    }
};

// Replace team members
exports.updateTeamMembers = async (req, res) => {
    try {
        const businessId = await resolveBusinessId(req);
        if (!businessId) return res.status(400).json({ success: false, message: 'User is not linked to a business' });

        const teamId = req.params.id;
        const { member_ids = [] } = req.body;

        // Validate team
        const [teams] = await db.execute('SELECT leader_id FROM teams WHERE id = ? AND business_id = ?', [teamId, businessId]);
        if (teams.length === 0) return res.status(404).json({ success: false, message: 'Team not found' });
        const leaderId = teams[0].leader_id;

        if (!Array.isArray(member_ids)) {
            return res.status(400).json({ success: false, message: 'member_ids must be an array' });
        }

        // Ensure all members belong to business and are active; de-duplicate
        let ids = Array.from(new Set(member_ids.filter(Boolean)));
        if (leaderId) ids = Array.from(new Set([...ids, leaderId])); // always keep leader as member

        if (ids.length > 0) {
            const placeholders = ids.map(() => '?').join(',');
            const [valids] = await db.execute(
                `SELECT id FROM users WHERE id IN (${placeholders}) AND business_id = ? AND status = "active"`,
                [...ids, businessId]
            );
            if (valids.length !== ids.length) {
                return res.status(400).json({ success: false, message: 'One or more members are invalid for this business' });
            }

            // Remove these members from other teams to avoid cross-team duplication
            await db.execute(
                `DELETE tm FROM team_members tm
                 WHERE tm.user_id IN (${placeholders}) AND tm.team_id <> ?`,
                [...ids, teamId]
            );
        }

        // Reset members then insert
        await db.execute('DELETE FROM team_members WHERE team_id = ?', [teamId]);
        if (ids.length > 0) {
            const values = ids.map(id => [teamId, id]);
            await db.query('INSERT INTO team_members (team_id, user_id) VALUES ?', [values]);
        }

        res.json({ success: true, message: 'Team members updated' });
    } catch (error) {
        console.error('Update team members error:', error);
        res.status(500).json({ success: false, message: 'Server error updating team members' });
    }
};

// Get single user detail
exports.getUser = async (req, res) => {
    try {
        const businessId = await resolveBusinessId(req);
        const userId = req.params.id;
        const currentRole = req.user.role_name;

        if (currentRole === 'employee' && Number(userId) !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        let query = `
            SELECT u.id, u.business_id, u.name, u.email, u.phone, u.status, u.created_at, r.role_name
            FROM users u
            JOIN roles_permissions r ON u.role_id = r.id
            WHERE u.id = ?
        `;
        const params = [userId];
        if (currentRole !== 'super_admin') {
            query += ' AND u.business_id = ?';
            params.push(businessId);
        }

        const [rows] = await db.execute(query, params);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

        res.json({ success: true, data: rows[0] });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving user' });
    }
};

// Call history for an employee
exports.getUserCalls = async (req, res) => {
    try {
        const businessId = await resolveBusinessId(req);
        const targetUserId = req.params.id;
        const currentRole = req.user.role_name;

        // ensure same business unless super_admin
        if (currentRole !== 'super_admin') {
            const [check] = await db.execute('SELECT id FROM users WHERE id = ? AND business_id = ?', [targetUserId, businessId]);
            if (check.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
        }

        const [calls] = await db.execute(
            `SELECT c.*, l.name as lead_name, l.phone as lead_phone
             FROM calls c
             LEFT JOIN leads l ON l.id = c.lead_id
             WHERE c.user_id = ?
             ORDER BY c.call_start_time DESC
             LIMIT 200`,
            [targetUserId]
        );

        res.json({ success: true, data: calls });
    } catch (error) {
        console.error('Get user calls error:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving call history' });
    }
};

// Followups for a given user (for admins/team leaders)
exports.getUserFollowups = async (req, res) => {
    try {
        const businessId = await resolveBusinessId(req);
        const targetUserId = req.params.id;
        const currentRole = req.user.role_name;
        const currentUserId = req.user.id;

        // Employees can only see their own followups
        if (currentRole === 'employee' && Number(targetUserId) !== currentUserId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        // Team leader can view members of their teams
        if (currentRole === 'team_leader') {
            const [memberCheck] = await db.execute(
                `SELECT tm.user_id FROM team_members tm
                 JOIN teams t ON tm.team_id = t.id
                 WHERE t.leader_id = ? AND tm.user_id = ?`,
                [currentUserId, targetUserId]
            );
            if (memberCheck.length === 0 && Number(targetUserId) !== currentUserId) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
        }

        const [rows] = await db.execute(
            `SELECT f.*, l.name as lead_name, l.phone as lead_phone
             FROM followups f
             JOIN leads l ON l.id = f.lead_id
             WHERE f.user_id = ?
             ORDER BY f.followup_date DESC`,
            [targetUserId]
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Get user followups error:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving followups' });
    }
};

// Update password
exports.updateUserPassword = async (req, res) => {
    try {
        const { new_password } = req.body;
        const targetUserId = req.params.id;
        if (!new_password) return res.status(400).json({ success: false, message: 'new_password is required' });

        // Only self or admin/super/business_admin can change
        const allowedRoles = ['super_admin', 'business_admin', 'admin'];
        if (req.user.id !== Number(targetUserId) && !allowedRoles.includes(req.user.role_name)) {
            return res.status(403).json({ success: false, message: 'Not allowed to change password for this user' });
        }

        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(new_password, salt);
        await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, targetUserId]);
        res.json({ success: true, message: 'Password updated' });
    } catch (error) {
        console.error('Update password error:', error);
        res.status(500).json({ success: false, message: 'Server error updating password' });
    }
};

// Activate / deactivate
exports.updateUserStatus = async (req, res) => {
    try {
        const { status } = req.body; // active | inactive
        const targetUserId = req.params.id;
        if (!['active', 'inactive'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });

        const allowedRoles = ['super_admin', 'business_admin', 'admin'];
        if (!allowedRoles.includes(req.user.role_name)) {
            return res.status(403).json({ success: false, message: 'Not allowed to change status' });
        }

        await db.execute('UPDATE users SET status = ? WHERE id = ?', [status, targetUserId]);
        res.json({ success: true, message: 'Status updated' });
    } catch (error) {
        console.error('Update status error:', error);
        res.status(500).json({ success: false, message: 'Server error updating status' });
    }
};

// Delete user
exports.deleteUser = async (req, res) => {
    try {
        const targetUserId = req.params.id;
        const allowedRoles = ['super_admin', 'business_admin', 'admin'];
        if (!allowedRoles.includes(req.user.role_name)) {
            return res.status(403).json({ success: false, message: 'Not allowed to delete user' });
        }
        await db.execute('DELETE FROM users WHERE id = ?', [targetUserId]);
        res.json({ success: true, message: 'User deleted' });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ success: false, message: 'Server error deleting user' });
    }
};
