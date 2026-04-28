module.exports = {
    apps: [
        {
            name: 'f-caller-backend',
            script: './server.js',
            cwd: __dirname,
            instances: 1,
            exec_mode: 'fork',
            watch: false,
            max_memory_restart: '300M',
            env: {
                NODE_ENV: 'production'
            }
        }
    ]
};
