const express = require('express');
const router = express.Router();

console.log('Loading evaluation routes...');
// Import semua route modules
const evaluationRoutes = require('./evaluation');
console.log('Evaluation routes loaded');

// Health check endpoint
router.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        message: 'Case Study Backend API is running',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Mount route modules
router.use('/', evaluationRoutes);

module.exports = router;