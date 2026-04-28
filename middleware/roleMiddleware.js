const authorizeRoles = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user || !req.user.role_name) {
            return res.status(401).json({ success: false, message: 'Unauthorized. Role information not found.' });
        }

        if (!allowedRoles.includes(req.user.role_name)) {
            return res.status(403).json({ success: false, message: `Forbidden. Resource requires one of the following roles: ${allowedRoles.join(', ')}` });
        }

        // Additional tenant check (business_id) could be added globally here, 
        // but it usually goes in specific controllers.
        
        next();
    };
};

module.exports = authorizeRoles;
