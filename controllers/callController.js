const db = require('../config/db');

const normalizePhone = (value) => String(value || '')
    .replace(/\D/g, '')
    .replace(/^91(?=\d{10}$)/, '');

const resolveBusinessIdForCalls = async (req) => {
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

const resolveCallDuration = (payload = {}) => {
    const candidates = [payload.call_duration, payload.duration];
    for (const value of candidates) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) {
            return parsed;
        }
    }
    return 0;
};

const findLeadIdByPhone = async (rawNumber) => {
    const normalizedNumber = normalizePhone(rawNumber);
    const normalizedWithCountryCode = normalizedNumber ? `91${normalizedNumber}` : normalizedNumber;
    const [leadRows] = await db.execute(
        `SELECT id, phone
         FROM leads
         WHERE phone = ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', ''), '(', ''), ')', '') IN (?, ?)
         LIMIT 1`,
        [rawNumber, normalizedNumber, normalizedWithCountryCode]
    );

    return leadRows[0]?.id || null;
};

const ensureLeadForExternalCall = async (req, rawNumber) => {
    const existingLeadId = await findLeadIdByPhone(rawNumber);
    if (existingLeadId) return existingLeadId;

    const businessId = await resolveBusinessIdForCalls(req);
    if (!businessId) {
        throw new Error('User is not linked to a business. Please set a business first.');
    }

    const displayNumber = String(rawNumber || '').trim();
    const [insertLead] = await db.execute(
        'INSERT INTO leads (business_id, name, phone, source, status) VALUES (?, ?, ?, ?, ?)',
        [businessId, `Dialer ${displayNumber}`, displayNumber, 'Phone Dialer', 'contacted']
    );
    const leadId = insertLead.insertId;

    try {
        await db.execute(
            'INSERT INTO lead_assignments (lead_id, assigned_to, assigned_by) VALUES (?, ?, ?)',
            [leadId, req.user.id, req.user.id]
        );
    } catch (_) {
        // If assignment rules differ in this installation, keep the lead/call save path working.
    }

    return leadId;
};

const updateLeadStatusAfterCall = async (leadId, callStatus) => {
    let newLeadStatus = 'contacted';
    if (callStatus === 'Invalid Number') {
        newLeadStatus = 'dead';
    } else if (callStatus === 'Ready to Meet') {
        newLeadStatus = 'converted';
    }

    await db.execute('UPDATE leads SET status = ? WHERE id = ?', [newLeadStatus, leadId]);
};

const insertCallRecord = async ({
    leadId,
    userId,
    timestamp,
    duration,
    callStatus,
    remark,
    recordingUrl = null,
    phone = null,
}) => {
    const [result] = await db.execute(
        `INSERT INTO calls (lead_id, user_id, call_start_time, call_duration, call_status, remarks, recording_url, phone)
         VALUES (?, ?, FROM_UNIXTIME(?/1000), ?, ?, ?, ?, ?)`,
        [leadId, userId, timestamp || Date.now(), duration, callStatus, remark || null, recordingUrl, phone]
    );

    return result.insertId;
};

exports.logCall = async (req, res) => {
    try {
        const { lead_id, call_status, remarks, recording_url, followup_date } = req.body;
        const user_id = req.user.id; 
        const resolvedDuration = resolveCallDuration(req.body);

        if (!lead_id || !call_status) {
            return res.status(400).json({ success: false, message: 'lead_id and call_status are required' });
        }

        await insertCallRecord({
            leadId: lead_id,
            userId: user_id,
            duration: resolvedDuration,
            callStatus: call_status,
            remark: remarks,
            recordingUrl: recording_url || null,
        });

        await updateLeadStatusAfterCall(lead_id, call_status);

        if (followup_date && (call_status === 'Follow-up' || call_status === 'Ready to Meet' || call_status === 'Hot')) {
             await db.execute(
                 'INSERT INTO followups (lead_id, user_id, followup_date, notes) VALUES (?, ?, ?, ?)',
                 [lead_id, user_id, followup_date, remarks || null]
             );
        }

        res.status(201).json({ success: true, message: 'Call logged successfully' });

    } catch (error) {
        console.error('Log call error:', error);
        res.status(500).json({ success: false, message: 'Server error logging call' });
    }
};

// Store remarks for any call (even if not tied to a lead)
exports.saveCallRemark = async (req, res) => {
    try {
        const { number, remark, call_status, duration, timestamp } = req.body;
        const user_id = req.user.id;
        const resolvedDuration = resolveCallDuration(req.body);

        if (!number || !call_status) {
            return res.status(400).json({ success: false, message: 'number and call_status are required' });
        }

        const rawNumber = String(number).trim();
        const lead_id = await findLeadIdByPhone(rawNumber);

        if (!lead_id) {
            return res.status(404).json({
                success: false,
                message: 'No lead found for this phone number. Please save remarks from an assigned lead call.',
            });
        }

        await insertCallRecord({
            leadId: lead_id,
            userId: user_id,
            timestamp,
            duration: resolvedDuration,
            callStatus: call_status,
            remark,
            phone: rawNumber,
        });

        res.status(201).json({ success: true, message: 'Call remark saved' });
    } catch (error) {
        console.error('Save call remark error:', error);
        res.status(500).json({ success: false, message: 'Server error saving call remark' });
    }
};

exports.saveExternalDialerCall = async (req, res) => {
    try {
        const { number, remark, call_status, timestamp } = req.body;
        const user_id = req.user.id;
        const resolvedDuration = resolveCallDuration(req.body);

        if (!number || !call_status) {
            return res.status(400).json({ success: false, message: 'number and call_status are required' });
        }

        const rawNumber = String(number).trim();
        const lead_id = await ensureLeadForExternalCall(req, rawNumber);

        const callId = await insertCallRecord({
            leadId: lead_id,
            userId: user_id,
            timestamp,
            duration: resolvedDuration,
            callStatus: call_status,
            remark,
            phone: rawNumber,
        });

        await updateLeadStatusAfterCall(lead_id, call_status);

        res.status(201).json({ success: true, message: 'External dialer call saved', lead_id, call_id: callId });
    } catch (error) {
        console.error('Save external dialer call error:', error);
        res.status(500).json({ success: false, message: error.message || 'Server error saving external dialer call' });
    }
};

exports.autoLogCall = async (req, res) => {
    try {
        const { number, call_status, timestamp } = req.body;
        const user_id = req.user.id;
        const resolvedDuration = resolveCallDuration(req.body);

        if (!number || !call_status) {
            return res.status(400).json({ success: false, message: 'number and call_status are required' });
        }

        const rawNumber = String(number).trim();
        const lead_id = await ensureLeadForExternalCall(req, rawNumber);
        const callId = await insertCallRecord({
            leadId: lead_id,
            userId: user_id,
            timestamp,
            duration: resolvedDuration,
            callStatus: call_status,
            phone: rawNumber,
        });

        await updateLeadStatusAfterCall(lead_id, call_status);

        res.status(201).json({ success: true, message: 'Call auto logged', lead_id, call_id: callId });
    } catch (error) {
        console.error('Auto log call error:', error);
        res.status(500).json({ success: false, message: error.message || 'Server error auto logging call' });
    }
};

exports.updateCallRemark = async (req, res) => {
    try {
        const callId = Number(req.params.id);
        const { remark, call_status } = req.body;
        const user_id = req.user.id;

        if (!callId || !call_status) {
            return res.status(400).json({ success: false, message: 'Valid call id and call_status are required' });
        }

        const [result] = await db.execute(
            `UPDATE calls
             SET remarks = ?, call_status = ?
             WHERE id = ? AND user_id = ?`,
            [remark || null, call_status, callId, user_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Call record not found' });
        }

        const [[callRow]] = await db.execute(
            'SELECT lead_id FROM calls WHERE id = ? AND user_id = ? LIMIT 1',
            [callId, user_id]
        );

        if (callRow?.lead_id) {
            await updateLeadStatusAfterCall(callRow.lead_id, call_status);
        }

        res.json({ success: true, message: 'Call remark updated', call_id: callId });
    } catch (error) {
        console.error('Update call remark error:', error);
        res.status(500).json({ success: false, message: 'Server error updating call remark' });
    }
};

exports.getCallRemarks = async (req, res) => {
    try {
        const user_id = req.user.id;
        const [rows] = await db.execute(
            `SELECT
                id,
                phone,
                remarks,
                call_status,
                UNIX_TIMESTAMP(call_start_time) * 1000 AS timestamp
             FROM calls
             WHERE user_id = ?
               AND remarks IS NOT NULL
               AND TRIM(remarks) <> ''
             ORDER BY call_start_time DESC
             LIMIT 500`,
            [user_id]
        );

        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Get call remarks error:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving call remarks' });
    }
};

exports.getLoggedCalls = async (req, res) => {
    try {
        const user_id = req.user.id;
        const [rows] = await db.execute(
            `SELECT
                id,
                phone,
                call_status,
                UNIX_TIMESTAMP(call_start_time) * 1000 AS timestamp
             FROM calls
             WHERE user_id = ?
             ORDER BY call_start_time DESC
             LIMIT 1000`,
            [user_id]
        );

        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Get logged calls error:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving logged calls' });
    }
};

exports.getFollowups = async (req, res) => {
    try {
        const user_id = req.user.id;
        const [followups] = await db.execute(`
            SELECT f.*, l.name as lead_name, l.phone as lead_phone 
            FROM followups f 
            JOIN leads l ON f.lead_id = l.id 
            WHERE f.user_id = ? AND f.status = 'pending' 
            ORDER BY f.followup_date ASC
        `, [user_id]);

        res.json({ success: true, count: followups.length, data: followups });
    } catch (error) {
        console.error('Get followups error:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving followups' });
    }
};
