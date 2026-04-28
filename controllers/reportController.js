const db = require('../config/db');

const getDateRange = (period = 'Today') => {
    const now = new Date();
    let start;
    let end;

    switch (period) {
        case 'Yesterday':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0);
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
            break;
        case 'Last 7 Days':
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0);
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
            break;
        case 'This Month':
            start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
            end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
            break;
        default:
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
            end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    }

    const toSql = (date) => {
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };

    return { start: toSql(start), end: toSql(end) };
};

exports.getDashboardStats = async (req, res) => {
    try {
        const { role_name, business_id, id: user_id } = req.user;
        const period = req.query.period || 'Today';
        const executiveFilter = req.query.executive || 'Ex. No.: Yes';
        const { start, end } = getDateRange(period);
        const assignedOnly = executiveFilter === 'Ex. No.: Yes';
        
        let stats = {
            totalLeads: 0,
            callsToday: 0,
            conversions: 0,
            followupsPending: 0,
            totalCalls: 0,
            totalDuration: '0s',
            incoming: 0,
            incomingDuration: '0s',
            outgoing: 0,
            outgoingDuration: '0s',
            missed: 0,
            missedDuration: '0s'
        };

        const formatDuration = (seconds) => {
            const total = Number(seconds) || 0;
            const h = Math.floor(total / 3600);
            const m = Math.floor((total % 3600) / 60);
            const s = total % 60;
            if (h > 0) return `${h}h ${m}m ${s}s`;
            if (m > 0) return `${m}m ${s}s`;
            return `${s}s`;
        };

        const leadAssignmentCondition = assignedOnly
            ? 'EXISTS (SELECT 1 FROM lead_assignments la WHERE la.lead_id = l.id AND la.status = "active")'
            : 'NOT EXISTS (SELECT 1 FROM lead_assignments la WHERE la.lead_id = l.id AND la.status = "active")';

        const callLeadAssignmentCondition = assignedOnly
            ? 'EXISTS (SELECT 1 FROM lead_assignments la WHERE la.lead_id = c.lead_id AND la.status = "active")'
            : 'NOT EXISTS (SELECT 1 FROM lead_assignments la WHERE la.lead_id = c.lead_id AND la.status = "active")';

        if (role_name === 'employee') {
            const [[leadsStat]] = await db.execute(
                'SELECT COUNT(*) as cnt FROM lead_assignments WHERE assigned_to = ? AND status = "active"',
                [user_id]
            );
            const [[callsStat]] = await db.execute(
                `SELECT COUNT(*) as cnt
                 FROM calls c
                 WHERE c.user_id = ?
                   AND c.call_start_time BETWEEN ? AND ?
                   AND ${callLeadAssignmentCondition}`,
                [user_id, start, end]
            );
            const [[convStat]] = await db.execute(
                `SELECT COUNT(*) as cnt
                 FROM calls c
                 WHERE c.user_id = ?
                   AND c.call_status IN ("Ready to Meet", "Hot")
                   AND c.call_start_time BETWEEN ? AND ?
                   AND ${callLeadAssignmentCondition}`,
                [user_id, start, end]
            );
            const [[followupStat]] = await db.execute(
                `SELECT COUNT(*) as cnt
                 FROM followups f
                 JOIN leads l ON l.id = f.lead_id
                 WHERE f.user_id = ?
                   AND f.status = "pending"
                   AND ${leadAssignmentCondition}`,
                [user_id]
            );
            const [[callSummary]] = await db.execute(
                `SELECT
                    COUNT(*) as totalCalls,
                    COALESCE(SUM(call_duration), 0) as totalDuration,
                    SUM(CASE WHEN call_status = 'Incoming' THEN 1 ELSE 0 END) as incoming,
                    COALESCE(SUM(CASE WHEN call_status = 'Incoming' THEN call_duration ELSE 0 END), 0) as incomingDuration,
                    SUM(CASE WHEN call_status = 'Outgoing' THEN 1 ELSE 0 END) as outgoing,
                    COALESCE(SUM(CASE WHEN call_status = 'Outgoing' THEN call_duration ELSE 0 END), 0) as outgoingDuration,
                    SUM(CASE WHEN call_status IN ('Missed', 'Not Answered') THEN 1 ELSE 0 END) as missed,
                    COALESCE(SUM(CASE WHEN call_status IN ('Missed', 'Not Answered') THEN call_duration ELSE 0 END), 0) as missedDuration
                 FROM calls c
                 WHERE c.user_id = ?
                   AND c.call_start_time BETWEEN ? AND ?
                   AND ${callLeadAssignmentCondition}`,
                [user_id, start, end]
            );
            
            stats.totalLeads = leadsStat.cnt;
            stats.callsToday = callsStat.cnt;
            stats.conversions = convStat.cnt;
            stats.followupsPending = followupStat.cnt;
            stats.totalCalls = callSummary.totalCalls || 0;
            stats.totalDuration = formatDuration(callSummary.totalDuration);
            stats.incoming = callSummary.incoming || 0;
            stats.incomingDuration = formatDuration(callSummary.incomingDuration);
            stats.outgoing = callSummary.outgoing || 0;
            stats.outgoingDuration = formatDuration(callSummary.outgoingDuration);
            stats.missed = callSummary.missed || 0;
            stats.missedDuration = formatDuration(callSummary.missedDuration);
        } else {
            // Admin / Business Admin / TL stats
            let bIdParam = business_id;
            let paramArr = [bIdParam];
            
            if (role_name === 'super_admin') {
                const [[leadsStat]] = await db.execute(
                    `SELECT COUNT(*) as cnt
                     FROM leads l
                     WHERE ${leadAssignmentCondition}`
                );
                stats.totalLeads = leadsStat.cnt;
            } else {
                const [[leadsStat]] = await db.execute(
                    `SELECT COUNT(*) as cnt
                     FROM leads l
                     WHERE l.business_id = ?
                       AND ${leadAssignmentCondition}`,
                    paramArr
                );
                stats.totalLeads = leadsStat.cnt;
            }
            
            // Simplified summary for admin panels
            const [[followupStat]] = await db.execute(
                `SELECT COUNT(*) as cnt
                 FROM followups f
                 JOIN leads l ON f.lead_id = l.id
                 WHERE l.business_id = ?
                   AND f.status = "pending"
                   AND ${leadAssignmentCondition}`,
                paramArr
            );
            stats.followupsPending = followupStat ? followupStat.cnt : 0;

            const [[callSummary]] = await db.execute(
                `SELECT
                    COUNT(*) as totalCalls,
                    COALESCE(SUM(c.call_duration), 0) as totalDuration,
                    SUM(CASE WHEN c.call_status = 'Incoming' THEN 1 ELSE 0 END) as incoming,
                    COALESCE(SUM(CASE WHEN c.call_status = 'Incoming' THEN c.call_duration ELSE 0 END), 0) as incomingDuration,
                    SUM(CASE WHEN c.call_status = 'Outgoing' THEN 1 ELSE 0 END) as outgoing,
                    COALESCE(SUM(CASE WHEN c.call_status = 'Outgoing' THEN c.call_duration ELSE 0 END), 0) as outgoingDuration,
                    SUM(CASE WHEN c.call_status IN ('Missed', 'Not Answered') THEN 1 ELSE 0 END) as missed,
                    COALESCE(SUM(CASE WHEN c.call_status IN ('Missed', 'Not Answered') THEN c.call_duration ELSE 0 END), 0) as missedDuration
                 FROM calls c
                 JOIN leads l ON l.id = c.lead_id
                 WHERE l.business_id = ?
                   AND c.call_start_time BETWEEN ? AND ?
                   AND ${callLeadAssignmentCondition}`,
                [bIdParam, start, end]
            );

            stats.callsToday = callSummary.totalCalls || 0;
            stats.totalCalls = callSummary.totalCalls || 0;
            stats.totalDuration = formatDuration(callSummary.totalDuration);
            stats.incoming = callSummary.incoming || 0;
            stats.incomingDuration = formatDuration(callSummary.incomingDuration);
            stats.outgoing = callSummary.outgoing || 0;
            stats.outgoingDuration = formatDuration(callSummary.outgoingDuration);
            stats.missed = callSummary.missed || 0;
            stats.missedDuration = formatDuration(callSummary.missedDuration);
        }

        res.json({ success: true, data: stats });
    } catch (error) {
        console.error('Get stats error:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving stats' });
    }
};
