const db = require('../config/db');
const xlsx = require('xlsx');
const csv = require('csv-parser');
const stream = require('stream');

// Ensure we always have a business_id for the current user.
// For super_admin without one, auto-attach to the first business or create a default.
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

        // attach to current user so future requests have it
        await db.execute('UPDATE users SET business_id = ? WHERE id = ?', [businessId, req.user.id]);
        req.user.business_id = businessId;
        return businessId;
    }

    return null;
};

exports.createLead = async (req, res) => {
    try {
        const { name, phone, email, address, source } = req.body;
        const currentBusinessId = await resolveBusinessId(req);

        if (!currentBusinessId) {
            return res.status(400).json({ success: false, message: 'User is not linked to a business. Please set a business first.' });
        }

        if (!name || !phone) {
            return res.status(400).json({ success: false, message: 'Name and phone are required' });
        }

        const safePhone = String(phone).trim();

        const [result] = await db.execute(
            'INSERT INTO leads (business_id, name, phone, email, address, source) VALUES (?, ?, ?, ?, ?, ?)',
            [currentBusinessId, name, safePhone, email || null, address || null, source || 'Manual']
        );

        res.status(201).json({ success: true, message: 'Lead created successfully', leadId: result.insertId });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: 'Lead with this phone number already exists' });
        }
        if (error.code === 'ER_NO_REFERENCED_ROW_2') {
            return res.status(400).json({ success: false, message: 'Invalid business reference. Please ensure the user belongs to a valid business.' });
        }
        console.error('Create lead error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.importLeads = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Please upload an excel or csv file' });
        }

        const currentBusinessId = await resolveBusinessId(req);
        if (!currentBusinessId) {
            return res.status(400).json({ success: false, message: 'User is not linked to a business. Please set a business first.' });
        }
        let leads = [];

        if (req.file.mimetype === 'text/csv' || req.file.originalname.endsWith('.csv')) {
            // parse CSV from raw buffer to preserve encoding; csv-parser handles buffer streams
            const bufferStream = stream.Readable.from(req.file.buffer);
            await new Promise((resolve, reject) => {
                bufferStream.pipe(csv())
                    .on('data', (data) => leads.push(data))
                    .on('end', resolve)
                    .on('error', reject);
            });
        } else {
            const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            leads = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
        }

        let imported = 0;
        let duplicates = 0;
        const createdLeadIds = [];

        for (const row of leads) {
            // Support multiple common column names
            const name = row.name ?? row.Name ?? row.NAME ?? row.full_name ?? row.FullName ?? row['Lead Name'] ?? row['lead name'];
            const primaryPhone = row.phone ?? row.Phone ?? row.PHONE ?? row.contact ?? row.Contact ?? row.Mobile ?? row.mobile ?? row['Primary Mobile No'] ?? row['Primary Mobile No.'];
            const secondaryPhone = row['Secondary Mobile No'] ?? row['Secondary Mobile No.'] ?? row.secondaryPhone ?? row['Alt Phone'] ?? row['Alternate Phone'];
            const phone = primaryPhone || secondaryPhone;
            const email = row.email ?? row.Email ?? row.EMAIL ?? row['Email Id'] ?? row['Email ID'] ?? null;
            const address = row.address ?? row.Address ?? row.ADDRESS ?? row['Address'] ?? null;
            const source = row.source ?? row.Source ?? row.SOURCE ?? row['Lead Detail'] ?? 'Import';

            if (!name || !phone) continue;

            try {
                // Ensure phone is extracted cleanly depending on excel format
                const safePhone = String(phone).trim();
                const [insertRes] = await db.execute(
                    'INSERT INTO leads (business_id, name, phone, email, address, source) VALUES (?, ?, ?, ?, ?, ?)',
                    [currentBusinessId, name, safePhone, email, address, source]
                );
                imported++;
                createdLeadIds.push(insertRes.insertId);
            } catch (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    duplicates++;
                } else {
                    console.error('Lead DB error:', err);
                }
            }
        }

        res.json({ success: true, message: `Imported ${imported} leads. ${duplicates} duplicates skipped.`, leadIds: createdLeadIds });
    } catch (error) {
        console.error('Import error:', error);
        res.status(500).json({ success: false, message: 'Server error during lead import', error: error.message });
    }
};

exports.getLeads = async (req, res) => {
    try {
        const { role_name, business_id, id: user_id } = req.user;
        let query = '';
        let params = [];

        if (role_name === 'super_admin') {
            query = 'SELECT l.*, a.assigned_to, u.name as assigned_name FROM leads l LEFT JOIN lead_assignments a ON l.id = a.lead_id AND a.status = "active" LEFT JOIN users u ON a.assigned_to = u.id ORDER BY l.created_at DESC';
        } else if (role_name === 'business_admin' || role_name === 'admin') {
            query = 'SELECT l.*, a.assigned_to, u.name as assigned_name FROM leads l LEFT JOIN lead_assignments a ON l.id = a.lead_id AND a.status = "active" LEFT JOIN users u ON a.assigned_to = u.id WHERE l.business_id = ? ORDER BY l.created_at DESC';
            params.push(business_id);
        } else if (role_name === 'team_leader') {
            query = `
                SELECT l.*, a.assigned_to, u.name as assigned_name 
                FROM leads l 
                LEFT JOIN lead_assignments a ON l.id = a.lead_id AND a.status = "active"
                LEFT JOIN users u ON a.assigned_to = u.id
                WHERE l.business_id = ? AND (
                    a.assigned_to IN (SELECT user_id FROM team_members WHERE team_id IN (SELECT id FROM teams WHERE leader_id = ?))
                    OR a.assigned_by = ?
                    OR a.id IS NULL
                )
                ORDER BY l.created_at DESC
            `;
            params.push(business_id, user_id, user_id);
        } else if (role_name === 'employee') {
            query = `
                SELECT l.* 
                FROM leads l
                JOIN lead_assignments a ON l.id = a.lead_id
                WHERE a.assigned_to = ? AND a.status = "active"
                ORDER BY l.created_at DESC
            `;
            params.push(user_id);
        }

        const [leads] = await db.execute(query, params);
        res.json({ success: true, count: leads.length, data: leads });

    } catch (error) {
        console.error('Get leads error:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving leads' });
    }
};

exports.assignLeads = async (req, res) => {
    try {
        const { lead_ids, employee_ids = [], team_ids = [], auto_distribute } = req.body;
        const assigned_by = req.user.id; // Admin or TL doing the assignment

        if (!lead_ids || !lead_ids.length) {
            return res.status(400).json({ success: false, message: 'Provide lead_ids array' });
        }

        let targetEmployees = employee_ids;

        // If teams are provided, gather unique employees from those teams
        if ((!targetEmployees || targetEmployees.length === 0) && team_ids && team_ids.length > 0) {
            const placeholders = team_ids.map(() => '?').join(',');
            const [rows] = await db.execute(
                `SELECT tm.team_id, tm.user_id AS id
                 FROM team_members tm
                 JOIN users u ON tm.user_id = u.id
                 WHERE tm.team_id IN (${placeholders}) AND u.status = "active"`,
                team_ids
            );

            // Build per-team employee lists
            const teamMap = {};
            rows.forEach(r => {
                const key = String(r.team_id);
                if (!teamMap[key]) teamMap[key] = [];
                if (!teamMap[key].includes(r.id)) teamMap[key].push(r.id);
            });
            const teamIdList = team_ids
                .map(id => String(id))
                .filter(id => teamMap[id] && teamMap[id].length);
            if (teamIdList.length === 0) {
                return res.status(400).json({ success: false, message: 'No active employees found in selected teams' });
            }

            // Round robin across teams, then within team employees
            let teamIndex = 0;
            const teamEmployeeIndex = Object.fromEntries(teamIdList.map(tid => [tid, 0]));

            const chosen = [];
            for (const leadId of lead_ids) {
                let attempts = 0;
                let assignedEmp = null;
                while (attempts < teamIdList.length && !assignedEmp) {
                    const currentTeamId = teamIdList[teamIndex];
                    const emps = teamMap[currentTeamId];
                    if (emps && emps.length) {
                        const idx = teamEmployeeIndex[currentTeamId] % emps.length;
                        assignedEmp = emps[idx];
                        teamEmployeeIndex[currentTeamId] = (idx + 1) % emps.length;
                    }
                    teamIndex = (teamIndex + 1) % teamIdList.length;
                    attempts++;
                }
                if (assignedEmp) chosen.push({ leadId, assignedEmp });
            }

            // assign using chosen list
            for (const item of chosen) {
                const lead_id = item.leadId;
                const assigned_to = item.assignedEmp;
                await db.execute('UPDATE lead_assignments SET status = "transferred" WHERE lead_id = ? AND status = "active"', [lead_id]);
                await db.execute(
                    'INSERT INTO lead_assignments (lead_id, assigned_to, assigned_by) VALUES (?, ?, ?)',
                    [lead_id, assigned_to, assigned_by]
                );
                await db.execute('UPDATE leads SET status = "assigned" WHERE id = ?', [lead_id]);
            }

            return res.json({ success: true, message: 'Leads assigned across selected teams' });
        }

        if (!targetEmployees || targetEmployees.length === 0) {
            return res.status(400).json({ success: false, message: 'Provide employee_ids or team_ids with active employees' });
        }

        if (auto_distribute) {
            // Round-robin distribution
            let empIndex = 0;
            for (const lead_id of lead_ids) {
                const assigned_to = targetEmployees[empIndex];
                
                // First close old active assignment
                await db.execute('UPDATE lead_assignments SET status = "transferred" WHERE lead_id = ? AND status = "active"', [lead_id]);

                await db.execute(
                    'INSERT INTO lead_assignments (lead_id, assigned_to, assigned_by) VALUES (?, ?, ?)',
                    [lead_id, assigned_to, assigned_by]
                );
                await db.execute('UPDATE leads SET status = "assigned" WHERE id = ?', [lead_id]);
                empIndex = (empIndex + 1) % targetEmployees.length;
            }
        } else {
            // Manual single assignee for multiple leads
            for (const lead_id of lead_ids) {
                 await db.execute('UPDATE lead_assignments SET status = "transferred" WHERE lead_id = ? AND status = "active"', [lead_id]);

                await db.execute(
                    'INSERT INTO lead_assignments (lead_id, assigned_to, assigned_by) VALUES (?, ?, ?)',
                    [lead_id, targetEmployees[0], assigned_by]
                );
                await db.execute('UPDATE leads SET status = "assigned" WHERE id = ?', [lead_id]);
            }
        }

        res.json({ success: true, message: 'Leads assigned successfully' });
    } catch (error) {
        console.error('Assign leads error:', error);
        res.status(500).json({ success: false, message: 'Server error assigning leads' });
    }
};
