const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Please provide email and password' });
        }

        // Find user and join to get role string definition
        const query = `
            SELECT u.*, r.role_name 
            FROM users u
            JOIN roles_permissions r ON u.role_id = r.id
            WHERE u.email = ?
        `;
        
        const [users] = await db.execute(query, [email]);

        if (users.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        const user = users[0];

        // Validate password
        const isMatch = await bcrypt.compare(password, user.password_hash);

        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        if (user.status !== 'active') {
             return res.status(401).json({ success: false, message: 'Account is deactivated' });
        }

        // JWT payload creation
        const payload = {
            id: user.id,
            business_id: user.business_id,
            role_id: user.role_id,
            role_name: user.role_name
        };

        const token = jwt.sign(payload, process.env.JWT_SECRET, {
            expiresIn: process.env.JWT_EXPIRES_IN || '1d'
        });

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role_name: user.role_name,
                business_id: user.business_id
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'Server error during login' });
    }
};

// Utility route to initially setup the super admin
exports.setupSuperAdmin = async (req, res) => {
    try {
        const { name, email, password } = req.body;
        
        const [existing] = await db.execute(`
            SELECT u.id FROM users u
            JOIN roles_permissions r ON u.role_id = r.id
            WHERE r.role_name = 'super_admin'
        `);
        
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Super admin already exists' });
        }
        
        const [roles] = await db.execute('SELECT id FROM roles_permissions WHERE role_name = "super_admin"');
        if(roles.length === 0) {
             return res.status(500).json({ success: false, message: 'Roles not initialized in DB' });
        }
        
        const role_id = roles[0].id;
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        
        await db.execute(
            'INSERT INTO users (role_id, name, email, password_hash, status) VALUES (?, ?, ?, ?, "active")',
            [role_id, name, email, hashedPassword]
        );
        
        res.status(201).json({ success: true, message: 'Super Admin created successfully' });
    } catch (error) {
        console.error('Setup error:', error);
        res.status(500).json({ success: false, message: 'Server error during setup' });
    }
};
