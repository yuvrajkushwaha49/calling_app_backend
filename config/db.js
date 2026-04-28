require('dotenv').config();
const mysql = require('mysql2/promise');

const dbConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'telecaller_crm',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 10000
};

const pool = mysql.createPool({
    ...dbConfig
});

// Test connection
pool.getConnection()
    .then(connection => {
        console.log(`Connected to MySQL database "${dbConfig.database}" at ${dbConfig.host}:${dbConfig.port}`);
        connection.release();
    })
    .catch(err => {
        if (err.code === 'ECONNREFUSED') {
            console.error(`MySQL connection refused at ${dbConfig.host}:${dbConfig.port}. Start MySQL with "docker compose up -d mysql" from the project root, then restart the backend.`);
            return;
        }

        console.error('MySQL connection error:', err.message);
    });

module.exports = pool;
