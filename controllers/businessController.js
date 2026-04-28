const db = require('../config/db');

exports.createBusiness = async (req, res) => {
    try {
        const { name, email, phone, address } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, message: 'Business name is required' });
        }

        const [result] = await db.execute(
            'INSERT INTO businesses (name, email, phone, address) VALUES (?, ?, ?, ?)',
            [name, email || null, phone || null, address || null]
        );

        res.status(201).json({
            success: true,
            message: 'Business created successfully',
            businessId: result.insertId
        });
    } catch (error) {
        console.error('Create business error:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: 'Business email already exists' });
        }
        res.status(500).json({ success: false, message: 'Server error creating business' });
    }
};

exports.getBusinesses = async (req, res) => {
    try {
        const [businesses] = await db.execute('SELECT * FROM businesses ORDER BY created_at DESC');
        res.json({ success: true, count: businesses.length, data: businesses });
    } catch (error) {
        console.error('Get businesses error:', error);
        res.status(500).json({ success: false, message: 'Server error retrieving businesses' });
    }
};
