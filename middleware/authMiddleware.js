const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // format: Bearer TOKEN
        
        if (!token) {
            return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // Will contain id, business_id, role_id, role_name
        
        next();
    } catch (error) {
        return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
    }
};

module.exports = authenticateToken;
