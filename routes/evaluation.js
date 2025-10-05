const express = require('express');
const router = express.Router();
const { uploadFiles, handleUploadError } = require('../middleware/upload');
const evaluationService = require('../services/evaluationService');

// POST /evaluate - Upload CV dan Project Report untuk evaluasi
router.post('/evaluate', uploadFiles, async (req, res) => {
    try {
        // Validasi file upload
        if (!req.files || !req.files.cv || !req.files.project_report) {
            return res.status(400).json({
                error: 'Missing required files',
                message: 'Both cv and project_report PDF files are required'
            });
        }

        const cvFile = req.files.cv[0];
        const projectFile = req.files.project_report[0];

        console.log('Files uploaded:', {
            cv: cvFile.filename,
            project_report: projectFile.filename
        });

        // Buat evaluation job
        const jobId = await evaluationService.createEvaluationJob(
            cvFile.path,
            projectFile.path
        );

        res.status(202).json({
            message: 'Evaluation job created successfully',
            job_id: jobId,
            status: 'queued',
            files: {
                cv: cvFile.filename,
                project_report: projectFile.filename
            }
        });

    } catch (error) {
        console.error('Error in /evaluate:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// GET /result/:id - Get hasil evaluasi by job ID
router.get('/result/:id', async (req, res) => {
    try {
        const jobId = req.params.id;
        
        if (!jobId) {
            return res.status(400).json({
                error: 'Missing job ID',
                message: 'Job ID is required'
            });
        }

        const result = await evaluationService.getEvaluationResult(jobId);

        if (result.error) {
            return res.status(404).json(result);
        }

        res.json(result);

    } catch (error) {
        console.error('Error in /result:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// GET /evaluations - Get semua evaluations (untuk debug/admin)
router.get('/evaluations', async (req, res) => {
    try {
        const evaluations = await evaluationService.getAllEvaluations();
        res.json({
            message: 'All evaluations',
            count: evaluations.length,
            data: evaluations
        });
    } catch (error) {
        console.error('Error in /evaluations:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Simple test route
router.get('/test', (req, res) => {
    res.json({ message: 'Test route works!' });
});

// TEST endpoint - process PDF without AI
router.post('/test-pdf', uploadFiles, async (req, res) => {
    try {
        if (!req.files || !req.files.cv || !req.files.project_report) {
            return res.status(400).json({
                error: 'Missing required files'
            });
        }

        const cvFile = req.files.cv[0];
        const projectFile = req.files.project_report[0];

        // Test PDF extraction
        const pdfService = require('../services/pdfService');
        
        const cvData = await pdfService.processPDF(cvFile.path);
        const projectData = await pdfService.processPDF(projectFile.path);

        res.json({
            message: 'PDF processing successful',
            cv: {
                wordCount: cvData.wordCount,
                pages: cvData.pages,
                preview: cvData.text.substring(0, 200) + '...'
            },
            project: {
                wordCount: projectData.wordCount,
                pages: projectData.pages,
                preview: projectData.text.substring(0, 200) + '...'
            }
        });

    } catch (error) {
        console.error('Error in test-pdf:', error);
        res.status(500).json({
            error: 'PDF processing failed',
            message: error.message
        });
    }
});

// Middleware untuk handle upload errors
router.use(handleUploadError);

// Debug: list routes inside this router when loaded
setImmediate(() => {
    const list = router.stack
        .filter(r => r.route)
        .map(r => `${Object.keys(r.route.methods).join('|').toUpperCase()} ${r.route.path}`);
    console.log('evaluation.js registered routes:', list);
});

module.exports = router;