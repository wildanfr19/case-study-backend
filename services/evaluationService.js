const { v4: uuidv4 } = require('uuid');
const dbManager = require('../config/database');
const pdfService = require('./pdfService');
const aiService = require('./aiService');

class EvaluationService {
    // Buat job evaluasi baru
    async createEvaluationJob({ cvFilePath, projectFilePath, cvDocumentId = null, projectDocumentId = null, jobTitle = null }) {
        try {
            const jobId = uuidv4();
            const db = dbManager.getConnection();
            
            // Insert job ke database dengan status 'queued'
            await db.execute(
                'INSERT INTO evaluations (id, status, cv_file_path, project_file_path, cv_document_id, project_document_id, job_title) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [jobId, 'queued', cvFilePath, projectFilePath, cvDocumentId, projectDocumentId, jobTitle]
            );
            
            console.log(`Evaluation job created: ${jobId}`);
            
            // Start processing asynchronously (non-blocking)
            this.processEvaluation(jobId).catch(error => {
                console.error(`Error processing job ${jobId}:`, error);
                this.updateJobStatus(jobId, 'failed', { error: error.message });
            });
            
            return jobId;
        } catch (error) {
            console.error('Error creating evaluation job:', error);
            throw new Error('Failed to create evaluation job');
        }
    }

    // Process evaluasi (background job)
    async processEvaluation(jobId) {
        try {
            console.log(`Starting evaluation for job: ${jobId}`);
            
            // Update status ke 'processing'
            await this.updateJobStatus(jobId, 'processing');
            
            // Get job details dari database
            const job = await this.getJobById(jobId);
            if (!job) {
                throw new Error('Job not found');
            }
            if (job.status === 'canceled') {
                console.log(`Job ${jobId} was canceled before processing started.`);
                return { canceled: true };
            }
            
            // Extract text dari PDF files
            console.log(`Extracting PDF content for job: ${jobId}`);
            const [cvData, projectData] = await Promise.all([
                pdfService.processPDF(job.cv_file_path),
                pdfService.processPDF(job.project_file_path)
            ]);

            // Re-check cancel setelah operasi berat pertama
            const midJob = await this.getJobById(jobId);
            if (midJob && midJob.status === 'canceled') {
                console.log(`Job ${jobId} was canceled mid processing (after PDF extraction). Aborting AI evaluation.`);
                return { canceled: true };
            }
            
            // Evaluasi dengan AI
            console.log(`Starting AI evaluation for job: ${jobId}`);
            let evaluationResult;
            try {
                evaluationResult = await aiService.evaluateCandidate(
                    cvData.text,
                    projectData.text,
                    { jobTitle: job.job_title || 'Backend Engineer', retrieved: {} }
                );
            } catch (aiErr) {
                console.error('AI evaluation encountered error:', aiErr.message);
                if (aiErr.details) {
                    // Complete failure (both missing)
                    await this.updateJobStatus(jobId, 'failed', { error: aiErr.message, details: aiErr.details });
                    throw aiErr;
                } else {
                    await this.updateJobStatus(jobId, 'failed', { error: aiErr.message });
                    throw aiErr;
                }
            }

            // If at least one side succeeded we treat as completed (even with issues)
            const finalStatus = evaluationResult && (evaluationResult.cv_evaluation || evaluationResult.project_evaluation) ? 'completed' : 'failed';
            await this.updateJobStatus(jobId, finalStatus, evaluationResult);
            
            console.log(`Evaluation completed for job: ${jobId}`);
            return evaluationResult;
            
        } catch (error) {
            console.error(`Error processing evaluation ${jobId}:`, error);
            await this.updateJobStatus(jobId, 'failed', { error: error.message });
            throw error;
        }
    }

    // Update status job di database
    async updateJobStatus(jobId, status, result = null) {
        try {
            const db = dbManager.getConnection();
            
            if (result) {
                let payloadToStore;
                try {
                    // If already string, keep; if object -> stringify
                    if (typeof result === 'string') {
                        // Validate it's JSON, if not wrap as JSON string
                        try { JSON.parse(result); payloadToStore = result; }
                        catch { payloadToStore = JSON.stringify({ raw: result }); }
                    } else {
                        payloadToStore = JSON.stringify(result);
                    }
                } catch (e) {
                    payloadToStore = JSON.stringify({ error: 'serialization_failed', detail: e.message });
                }
                await db.execute(
                    'UPDATE evaluations SET status = ?, result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                    [status, payloadToStore, jobId]
                );
            } else {
                await db.execute(
                    'UPDATE evaluations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                    [status, jobId]
                );
            }
        } catch (error) {
            console.error('Error updating job status:', error);
            throw error;
        }
    }

    // Get job by ID
    async getJobById(jobId) {
        try {
            const db = dbManager.getConnection();
            const [rows] = await db.execute(
                'SELECT * FROM evaluations WHERE id = ?',
                [jobId]
            );
            
            return rows[0] || null;
        } catch (error) {
            console.error('Error getting job:', error);
            throw error;
        }
    }

    // Get evaluation result
    async getEvaluationResult(jobId) {
        try {
            const job = await this.getJobById(jobId);
            
            if (!job) {
                return { error: 'Job not found' };
            }
            
            const response = {
                id: job.id,
                status: job.status,
                created_at: job.created_at,
                updated_at: job.updated_at
            };
            
            if (job.result !== null && job.result !== undefined) {
                const raw = job.result;
                // Case 1: Already an object (MySQL JSON column auto-parsed)
                if (typeof raw === 'object') {
                    response.result = raw;
                } else if (typeof raw === 'string') {
                    const str = raw.trim();
                    let parsedAttempt = null;
                    if (str.length === 0) {
                        response.result = { error: 'empty_result' };
                    } else {
                        try {
                            parsedAttempt = JSON.parse(str);
                            response.result = parsedAttempt;
                        } catch (e1) {
                            // Try unquote wrapper
                            if (str.startsWith('"') && str.endsWith('"')) {
                                try {
                                    const unq = str.slice(1, -1).replace(/\\"/g, '"');
                                    response.result = JSON.parse(unq);
                                } catch (e2) {
                                    response.result = { error: 'parse_failed_wrapped', raw: str, detail: e2.message };
                                }
                            } else if (str === '[object Object]') {
                                response.result = { error: 'invalid_serialization_placeholder', raw: str };
                            } else {
                                response.result = { error: 'parse_failed', raw: str, detail: e1.message };
                            }
                        }
                    }
                } else {
                    response.result = { error: 'unsupported_result_type', type: typeof raw };
                }
            }
            
            return response;
        } catch (error) {
            console.error('Error getting evaluation result:', error);
            throw error;
        }
    }

    // Get all evaluations (untuk admin/debug)
    async getAllEvaluations() {
        try {
            const db = dbManager.getConnection();
            const [rows] = await db.execute(
                'SELECT id, status, created_at, updated_at FROM evaluations ORDER BY created_at DESC'
            );
            
            return rows;
        } catch (error) {
            console.error('Error getting all evaluations:', error);
            throw error;
        }
    }

    // Cancel job (only if queued or processing)
    async cancelJob(jobId) {
        const db = dbManager.getConnection();
        const job = await this.getJobById(jobId);
        if (!job) return { error: 'Job not found' };
        if (['completed','failed','canceled'].includes(job.status)) {
            return { error: `Cannot cancel job in status ${job.status}` };
        }
        await db.execute('UPDATE evaluations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['canceled', jobId]);
        return { id: jobId, status: 'canceled' };
    }
}

module.exports = new EvaluationService();