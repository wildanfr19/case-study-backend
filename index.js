const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const dbManager = require('./config/database');
const { uploadFiles, handleUploadError } = require('./middleware/upload');
const documentService = require('./services/documentService');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Ensure environment variables are loaded BEFORE services that depend on them
dotenv.config();
console.log('Env OPENAI key present?', !!process.env.OPENAI_API_KEY);

// Require evaluation service after env is loaded
const evaluationService = require('./services/evaluationService');

// (dotenv already configured above)

async function initializeDatabase(){
    try {
        await dbManager.init();
        console.log("Database initialized successfully")
    } catch (error) {
        console.error("Database initialization failed:", error);
        process.exit(1)
    }
}

const app = express();
// We'll attempt to bind to this desired port, but can auto-fallback if it's in use.
const DESIRED_PORT = Number(process.env.PORT) || 3000;

// Utility: find first available port starting at desired (up to +9)
const net = require('net');
async function findAvailablePort(startPort, maxTries = 10) {
    return new Promise((resolve, reject) => {
        let port = startPort;
        const tryPort = () => {
            const tester = net.createServer()
                .once('error', (err) => {
                    if (err.code === 'EADDRINUSE') {
                        if ((port - startPort + 1) >= maxTries) {
                            return reject(new Error(`No free port found in range ${startPort}-${startPort + maxTries - 1}`));
                        }
                        port++;
                        tryPort();
                    } else {
                        reject(err);
                    }
                })
                .once('listening', () => {
                    tester.close(() => resolve(port));
                })
                .listen(port);
        };
        tryPort();
    });
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(helmet());
app.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));

// Simple request logger (for debugging routing issues)
app.use((req, res, next) => {
    console.log(`[REQ] ${req.method} ${req.url}`);
    next();
});

// Basic route untuk testing
app.get('/', (req, res) => {
    res.json({
        message: 'Case Study Backend API',
        status: 'running',
        version: '1.0.0'
    });
});

// ================= Inline API Routes (Bypass nested router for stability) =================
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'API healthy', ts: Date.now() });
});

// Simple test route
app.get('/api/test', (req, res) => {
    res.json({ message: 'Test route works (inline)' });
});

// New: upload endpoint returns document IDs
app.post('/api/upload', uploadFiles, async (req, res) => {
    try {
        if (!req.files || !req.files.cv || !req.files.project_report) {
            return res.status(400).json({ error: 'Missing required files', message: 'Need cv & project_report' });
        }
        const cvFile = req.files.cv[0];
        const projectFile = req.files.project_report[0];
        const cvDoc = await documentService.storeDocument('cv', cvFile.path, cvFile.originalname);
        const projectDoc = await documentService.storeDocument('project', projectFile.path, projectFile.originalname);
        res.status(201).json({ message: 'Files uploaded', cv_id: cvDoc.id, project_id: projectDoc.id });
    } catch (e) {
        console.error('Upload error', e);
        res.status(500).json({ error: 'upload_failed', message: e.message });
    }
});

// Evaluate: accepts either multipart (legacy) OR JSON body with ids
app.post('/api/evaluate', uploadFiles, async (req, res) => {
    try {
        let cvPath, projectPath, cvDocId = null, projectDocId = null, jobTitle = null;
        if (req.is('multipart/form-data') && req.files && req.files.cv && req.files.project_report) {
            // Legacy direct upload path
            const cvFile = req.files.cv[0];
            const projectFile = req.files.project_report[0];
            cvPath = cvFile.path; projectPath = projectFile.path;
        } else {
            // JSON mode
            const { cv_id, project_id, job_title } = req.body;
            if (!cv_id || !project_id) {
                return res.status(400).json({ error: 'missing_ids', message: 'Provide cv_id & project_id (or upload multipart)' });
            }
            jobTitle = job_title;
            const db = require('./config/database').getConnection();
            const [rows] = await db.execute('SELECT * FROM documents WHERE id IN (?,?)', [cv_id, project_id]);
            const cvDoc = rows.find(r => r.id === cv_id);
            const projectDoc = rows.find(r => r.id === project_id);
            if (!cvDoc || !projectDoc) return res.status(404).json({ error: 'document_not_found' });
            cvPath = cvDoc.path; projectPath = projectDoc.path; cvDocId = cv_id; projectDocId = project_id;
        }
        const jobId = await evaluationService.createEvaluationJob({ cvFilePath: cvPath, projectFilePath: projectPath, cvDocumentId: cvDocId, projectDocumentId: projectDocId, jobTitle });
        res.status(202).json({ message: 'Evaluation job created successfully', job_id: jobId, status: 'queued' });
    } catch (err) {
        console.error('Error /api/evaluate:', err);
        res.status(500).json({ error: 'Internal error', message: err.message });
    }
});

// Get evaluation result
app.get('/api/result/:id', async (req, res) => {
    try {
        const result = await evaluationService.getEvaluationResult(req.params.id);
        if (result.error) return res.status(404).json(result);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Internal error', message: err.message });
    }
});

// List evaluations (debug)
app.get('/api/evaluations', async (req, res) => {
    try {
        const data = await evaluationService.getAllEvaluations();
        res.json({ count: data.length, data });
    } catch (err) {
        res.status(500).json({ error: 'Internal error', message: err.message });
    }
});

// Cancel job
app.post('/api/job/:id/cancel', async (req, res) => {
    try {
        const out = await evaluationService.cancelJob(req.params.id);
        if (out.error) return res.status(out.error === 'Job not found' ? 404 : 400).json(out);
        res.json(out);
    } catch (e) {
        res.status(500).json({ error: 'Internal error', message: e.message });
    }
});

// Debug raw job record
app.get('/api/_debug/job/:id', async (req, res) => {
    try {
        const db = require('./config/database').getConnection();
        const [rows] = await db.execute('SELECT id, status, result FROM evaluations WHERE id = ?', [req.params.id]);
        res.json({ rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Test PDF processing only
app.post('/api/test-pdf', uploadFiles, async (req, res) => {
    try {
        if (!req.files || !req.files.cv || !req.files.project_report) {
            return res.status(400).json({ error: 'Missing required files' });
        }
        const pdfService = require('./services/pdfService');
        const cvData = await pdfService.processPDF(req.files.cv[0].path);
        const projectData = await pdfService.processPDF(req.files.project_report[0].path);
        res.json({
            message: 'PDF ok',
            cv: { wordCount: cvData.wordCount, pages: cvData.pages },
            project: { wordCount: projectData.wordCount, pages: projectData.pages }
        });
    } catch (err) {
        res.status(500).json({ error: 'PDF processing failed', message: err.message });
    }
});

// Upload error handler
app.use(handleUploadError);
// =======================================================================

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        error: 'Something went wrong!',
        message: err.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Route not found'
    });
});

async function startServer() {
    await initializeDatabase();
    // Resolve an available port (fallback if desired is busy)
    let PORT = DESIRED_PORT;
    try {
        PORT = await findAvailablePort(DESIRED_PORT);
        if (PORT !== DESIRED_PORT) {
            console.warn(`⚠️  Port ${DESIRED_PORT} is in use. Falling back to available port ${PORT}.`);
        }
    } catch (e) {
        console.error('Failed to find available port:', e.message);
        process.exit(1);
    }

    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT} (desired ${DESIRED_PORT})`);
        console.log(`Database: MySQL connected`);
        // Enumerate all registered routes after server starts (simpler version)
        try {
            const list = [];
            (app._router?.stack || []).forEach(layer => {
                if (layer.route) {
                    list.push({ path: layer.route.path, methods: Object.keys(layer.route.methods).join('|').toUpperCase() });
                } else if (layer.name === 'router' && layer.handle?.stack) {
                    layer.handle.stack.forEach(r => {
                        if (r.route) {
                            list.push({ path: '/api' + r.route.path, methods: Object.keys(r.route.methods).join('|').toUpperCase() });
                        }
                    });
                }
            });
            console.log('Registered Routes (flattened):', list);
        } catch (e) {
            console.log('Route enumeration failed:', e);
        }

        // Self-diagnostic requests to verify accessibility
        setTimeout(() => {
            const http = require('http');
            const paths = ['/api/health', '/api/test', '/api/_direct_test', '/_direct_root_test'];
            paths.forEach(p => {
                http.get({ host: '127.0.0.1', port: PORT, path: p }, resp => {
                    const status = resp.statusCode;
                    let body = '';
                    resp.on('data', chunk => body += chunk.toString());
                    resp.on('end', () => {
                        console.log(`[SELF-CHECK] ${p} -> ${status}`);
                    });
                }).on('error', err => {
                    console.log(`[SELF-CHECK] ${p} ERROR`, err.message);
                });
            });
        }, 500);
    });
}

startServer();

module.exports = app;