const OpenAI = require('openai');
const retrieval = require('./retrievalService');

// Flags & configuration derived from environment
const FORCE_MOCK = (process.env.AI_FORCE_MOCK === '1' || process.env.AI_FORCE_MOCK === 'true');
const MOCK_MODE = FORCE_MOCK || !process.env.OPENAI_API_KEY;
const FALLBACK_TO_MOCK = (process.env.AI_FALLBACK_TO_MOCK === '1' || process.env.AI_FALLBACK_TO_MOCK === 'true');
const AUTO_BOTH_FAIL_FALLBACK = (process.env.AI_AUTO_BOTH_FAIL_FALLBACK === '1' || process.env.AI_AUTO_BOTH_FAIL_FALLBACK === 'true');
const DEBUG_AI = (process.env.DEBUG_AI === '1' || process.env.DEBUG_AI === 'true');
const MAX_ATTEMPTS = Number(process.env.AI_RETRY_ATTEMPTS || 2); // attempts (first + retries)
const BASE_DELAY_MS = Number(process.env.AI_RETRY_BASE_DELAY_MS || 1200);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function classifyError(err) {
    const msg = (err?.message || '').toLowerCase();
    if (msg.includes('quota')) return { type: 'quota_exceeded', retryable: false };
    if (msg.includes('rate limit')) return { type: 'rate_limit', retryable: true };
    if (msg.includes('timeout')) return { type: 'timeout', retryable: true };
    if (msg.includes('parse')) return { type: 'parse_error', retryable: false };
    if (msg.includes('network')) return { type: 'network', retryable: true };
    return { type: 'unknown', retryable: true };
}

async function callWithRetry(kind, execFn) {
    const attempts = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const start = Date.now();
        try {
            const data = await execFn();
            const duration = Date.now() - start;
            if (DEBUG_AI) console.log(`[AIService][${kind}] attempt ${attempt} success in ${duration}ms`);
            return { data, metaAttempts: attempts };
        } catch (e) {
            const classification = classifyError(e);
            const duration = Date.now() - start;
            attempts.push({ attempt, error: e.message, type: classification.type, duration_ms: duration });
            if (DEBUG_AI) console.warn(`[AIService][${kind}] attempt ${attempt} failed: ${e.message}`);
            // Non retryable -> break
            if (!classification.retryable) {
                if (DEBUG_AI) console.warn(`[AIService][${kind}] non-retryable error type=${classification.type}, aborting retries.`);
                throw Object.assign(e, { attempts });
            }
            if (attempt >= MAX_ATTEMPTS) {
                throw Object.assign(e, { attempts });
            }
            // Exponential backoff with jitter
            const delay = Math.round(BASE_DELAY_MS * Math.pow(2, attempt - 1) * (0.85 + Math.random() * 0.3));
            if (DEBUG_AI) console.log(`[AIService][${kind}] waiting ${delay}ms before retry`);
            await sleep(delay);
        }
    }
    // Should not reach
    throw new Error('Unexpected retry loop termination');
}

// Simple utility to truncate long texts (avoid context/token overflows)
function truncateText(text, maxChars = 24000) { // generous upper bound; model can still reject huge prompts
    if (!text) return '';
    if (text.length <= maxChars) return text;
    const head = text.slice(0, Math.floor(maxChars * 0.6));
    const tail = text.slice(-Math.floor(maxChars * 0.2));
    return head + `\n\n[...TRUNCATED ${text.length - (head.length + tail.length)} CHARS...]\n\n` + tail;
}

function safeJsonParse(raw) {
    // Try multiple strategies progressively
    const attempts = [];
    const original = raw || '';

    function record(name, fn) {
        try { return fn(); } catch (e) { attempts.push({ attempt: name, error: e.message }); return null; }
    }

    // 1. Strip markdown code fences if present
    let cleaned = original.trim();
    cleaned = cleaned.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
    // 2. Locate outermost braces window
    const windowParsed = record('slice_braces', () => {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('no braces');
        return JSON.parse(cleaned.slice(start, end + 1));
    });
    if (windowParsed) return windowParsed;

    // 3. Direct parse cleaned
    const direct = record('direct', () => JSON.parse(cleaned));
    if (direct) return direct;

    // 4. Remove potential trailing text after final closing brace pattern
    const braceMatch = record('regex_trim', () => {
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('no regex match');
        return JSON.parse(m[0]);
    });
    if (braceMatch) return braceMatch;

    const err = new Error('Failed to parse AI JSON');
    err.attempts = attempts;
    throw err;
}

class AIService {
    constructor() {
        if (!MOCK_MODE) {
            this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            console.log('[AIService] Real AI mode enabled. Model:', process.env.OPENAI_MODEL || 'gpt-4o-mini');
        } else {
            console.log('[AIService] Running in MOCK MODE', FORCE_MOCK ? '(forced by AI_FORCE_MOCK)' : '(no OPENAI_API_KEY)');
        }
    }

    // Prompt untuk evaluasi CV
    createCVEvaluationPrompt(cvText, jobDescription, contexts = {}) {
        return `
                You are an expert HR evaluator. Evaluate this CV against the job requirements and provide structured scoring.

                JOB DESCRIPTION:
                ${jobDescription}

                RETRIEVED CONTEXT (job_description top-k chunks):
                ${ (contexts.job_description||[]).map((c,i)=>`[JD_${i+1}] ${c}`).join('\n') }

                RETRIEVED CONTEXT (cv_rubric top-k chunks):
                ${ (contexts.rubric_cv||[]).map((c,i)=>`[RCV_${i+1}] ${c}`).join('\n') }

                CV CONTENT:
                ${cvText}

                Evaluate based on these criteria and provide scores 1-5:

                1. Technical Skills Match (backend, databases, APIs, cloud, AI/LLM exposure)
                2. Experience Level (years of experience and project complexity) 
                3. Relevant Achievements (impact of past work - scaling, performance, adoption)
                4. Cultural/Collaboration Fit (communication, learning mindset, teamwork/leadership)

                Return ONLY a JSON response in this exact format:
                {
                    "technical_skills": {"score": X, "feedback": "explanation"},
                    "experience_level": {"score": X, "feedback": "explanation"},
                    "relevant_achievements": {"score": X, "feedback": "explanation"},
                    "cultural_fit": {"score": X, "feedback": "explanation"},
                    "overall_summary": "3-5 sentences summary with strengths, gaps, recommendations"
                }`;
            }

    // Prompt untuk evaluasi Project Report
    createProjectEvaluationPrompt(projectText, contexts = {}) {
        return `
                You are an expert technical evaluator. Evaluate this project report and provide structured scoring.

                PROJECT REPORT:
                ${projectText}

                RETRIEVED CONTEXT (case_brief top-k chunks):
                ${ (contexts.case_brief||[]).map((c,i)=>`[CB_${i+1}] ${c}`).join('\n') }

                RETRIEVED CONTEXT (project_rubric top-k chunks):
                ${ (contexts.rubric_project||[]).map((c,i)=>`[RP_${i+1}] ${c}`).join('\n') }

                Evaluate based on these criteria and provide scores 1-5:

                1. Correctness (prompt design, LLM chaining, RAG context injection)
                2. Code Quality (clean, modular, reusable, tested)
                3. Resilience & Error Handling (handles long jobs, retries, randomness, API failures)
                4. Documentation & Explanation (README clarity, setup instructions, trade-off explanations)
                5. Creativity/Bonus (extra features beyond requirements)

                Return ONLY a JSON response in this exact format:
                {
                    "correctness": {"score": X, "feedback": "explanation"},
                    "code_quality": {"score": X, "feedback": "explanation"},
                    "resilience": {"score": X, "feedback": "explanation"},
                    "documentation": {"score": X, "feedback": "explanation"},
                    "creativity": {"score": X, "feedback": "explanation"},
                    "overall_summary": "3-5 sentences summary with strengths, gaps, recommendations"
                }`;
    }

    // Evaluasi CV dengan OpenAI
    async evaluateCV(cvText, contexts = {}, jobDescriptionOverride = null) {
        const jobDescription = `
            Backend Developer - AI Integration Specialist
            - Experience with backend frameworks (Rails, Django, Node.js)
            - Database design and optimization
            - API development and integration
            - Cloud platforms experience
            - AI/LLM integration experience preferred
            - Strong problem-solving and communication skills
        `;
        const truncated = truncateText(cvText, Number(process.env.AI_CV_MAX_CHARS) || 20000);
        const prompt = this.createCVEvaluationPrompt(truncated, jobDescriptionOverride || jobDescription, contexts);
        const startTs = Date.now();
        if (MOCK_MODE) {
            return {
                technical_skills: { score: 4, feedback: 'Mock: solid backend & APIs' },
                experience_level: { score: 3, feedback: 'Mock: mid-level experience' },
                relevant_achievements: { score: 3, feedback: 'Mock: some project impact' },
                cultural_fit: { score: 4, feedback: 'Mock: good collaboration signals' },
                overall_summary: 'Mock summary: Candidate shows balanced strengths with growth areas in scaling & advanced architecture.',
                _meta: { mode: 'mock', truncated: truncated.length !== cvText.length, duration_ms: Date.now() - startTs }
            };
        }
        try {
            if (DEBUG_AI) console.log('[AIService][CV] Calling OpenAI... chars:', truncated.length);
            const { data: response, metaAttempts } = await callWithRetry('CV', () => this.openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 1000
            }));
            const raw = response.choices?.[0]?.message?.content || '';
            if (DEBUG_AI) {
                console.log('[AIService][CV] Raw response snippet:', raw.substring(0, 200));
            }
            const parsed = safeJsonParse(raw);
            parsed._meta = { mode: 'real', truncated: truncated.length !== cvText.length, duration_ms: Date.now() - startTs, attempts: response?._metaAttempts || metaAttempts };
            return parsed;
        } catch (error) {
            console.error('[AIService][CV] Error:', error?.message || error);
            if (error?.attempts && DEBUG_AI) console.log('[AIService][CV] JSON parse attempts:', error.attempts);
            if (FALLBACK_TO_MOCK) {
                console.warn('[AIService][CV] Falling back to mock due to error.');
                return {
                    technical_skills: { score: 3, feedback: 'Fallback mock: partial evaluation' },
                    experience_level: { score: 3, feedback: 'Fallback mock: estimation' },
                    relevant_achievements: { score: 3, feedback: 'Fallback mock: generic achievements' },
                    cultural_fit: { score: 3, feedback: 'Fallback mock: neutral indicators' },
                    overall_summary: 'Fallback mock summary due to AI error.',
                    _meta: { mode: 'mock_fallback', error: error?.message, duration_ms: Date.now() - startTs }
                };
            }
            const enriched = new Error('Failed to evaluate CV with AI: ' + (error?.message || 'unknown'));
            enriched.original = error;
            throw enriched;
        }
    }

    // Evaluasi Project Report dengan OpenAI
    async evaluateProject(projectText, contexts = {}) {
        const truncated = truncateText(projectText, Number(process.env.AI_PROJECT_MAX_CHARS) || 22000);
        const prompt = this.createProjectEvaluationPrompt(truncated, contexts);
        const startTs = Date.now();
        if (MOCK_MODE) {
            return {
                correctness: { score: 4, feedback: 'Mock: core logic implemented' },
                code_quality: { score: 3, feedback: 'Mock: structure ok, tests missing' },
                resilience: { score: 3, feedback: 'Mock: basic error handling present' },
                documentation: { score: 3, feedback: 'Mock: README adequate' },
                creativity: { score: 2, feedback: 'Mock: few extras' },
                overall_summary: 'Mock project summary: Solid foundation; could enhance resilience & creativity.',
                _meta: { mode: 'mock', truncated: truncated.length !== projectText.length, duration_ms: Date.now() - startTs }
            };
        }
        try {
            if (DEBUG_AI) console.log('[AIService][PROJECT] Calling OpenAI... chars:', truncated.length);
            const { data: response, metaAttempts } = await callWithRetry('PROJECT', () => this.openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 1000
            }));
            const raw = response.choices?.[0]?.message?.content || '';
            if (DEBUG_AI) {
                console.log('[AIService][PROJECT] Raw response snippet:', raw.substring(0, 200));
            }
            const parsed = safeJsonParse(raw);
            parsed._meta = { mode: 'real', truncated: truncated.length !== projectText.length, duration_ms: Date.now() - startTs, attempts: response?._metaAttempts || metaAttempts };
            return parsed;
        } catch (error) {
            console.error('[AIService][PROJECT] Error:', error?.message || error);
            if (error?.attempts && DEBUG_AI) console.log('[AIService][PROJECT] JSON parse attempts:', error.attempts);
            if (FALLBACK_TO_MOCK) {
                console.warn('[AIService][PROJECT] Falling back to mock due to error.');
                return {
                    correctness: { score: 3, feedback: 'Fallback mock: partial evaluation' },
                    code_quality: { score: 3, feedback: 'Fallback mock: generic code quality' },
                    resilience: { score: 3, feedback: 'Fallback mock: generic resilience' },
                    documentation: { score: 3, feedback: 'Fallback mock: generic docs' },
                    creativity: { score: 2, feedback: 'Fallback mock: limited extras' },
                    overall_summary: 'Fallback mock project summary due to AI error.',
                    _meta: { mode: 'mock_fallback', error: error?.message, duration_ms: Date.now() - startTs }
                };
            }
            const enriched = new Error('Failed to evaluate project with AI: ' + (error?.message || 'unknown'));
            enriched.original = error;
            throw enriched;
        }
    }

    // Spec-compliant scoring computations (weights) + legacy fields
    computeWeightedCV(scores){
        // weights: technical 40, experience 25, achievements 20, cultural 15 (% of 100)
        return (
            scores.technical_skills * 0.40 +
            scores.experience_level * 0.25 +
            scores.relevant_achievements * 0.20 +
            scores.cultural_fit * 0.15
        );
    }
    computeWeightedProject(scores){
        // weights: correctness 30, code_quality 25, resilience 20, documentation 15, creativity 10
        return (
            scores.correctness * 0.30 +
            scores.code_quality * 0.25 +
            scores.resilience * 0.20 +
            scores.documentation * 0.15 +
            scores.creativity * 0.10
        );
    }

    // New spec evaluation pipeline (still uses existing underlying evals)
    async evaluateCandidate(cvText, projectText, { jobTitle = 'Backend Engineer', retrieved = {} } = {}) {
        const issues = [];
        let cvEvaluation = null;
        let projectEvaluation = null;
        // --- Retrieval (RAG) ---
        let retrievedContexts = { job_description: [], rubric_cv: [], case_brief: [], rubric_project: [] };
        try {
            const k = Number(process.env.RAG_TOP_K || 3);
            retrievedContexts.job_description = await retrieval.retrieve({ type: 'job_description', query: cvText, k });
            retrievedContexts.rubric_cv = await retrieval.retrieve({ type: 'rubric_cv', query: cvText, k });
            retrievedContexts.case_brief = await retrieval.retrieve({ type: 'case_brief', query: projectText, k });
            retrievedContexts.rubric_project = await retrieval.retrieve({ type: 'rubric_project', query: projectText, k });
        } catch (e) {
            issues.push({ component: 'retrieval', error: e.message });
        }
        if (DEBUG_AI) console.log('[AIService][COMBINED] Starting candidate evaluation');
        try {
            cvEvaluation = await this.evaluateCV(cvText, { job_description: retrievedContexts.job_description, rubric_cv: retrievedContexts.rubric_cv });
            if (DEBUG_AI) console.log('[AIService][COMBINED] CV evaluation success mode:', cvEvaluation?._meta?.mode);
        } catch (e) {
            if (DEBUG_AI) console.log('[AIService][COMBINED] CV evaluation failed:', e.message);
            issues.push({ component: 'cv', error: e.message });
        }
        try {
            projectEvaluation = await this.evaluateProject(projectText, { case_brief: retrievedContexts.case_brief, rubric_project: retrievedContexts.rubric_project });
            if (DEBUG_AI) console.log('[AIService][COMBINED] Project evaluation success mode:', projectEvaluation?._meta?.mode);
        } catch (e) {
            if (DEBUG_AI) console.log('[AIService][COMBINED] Project evaluation failed:', e.message);
            issues.push({ component: 'project', error: e.message });
        }
        if (!cvEvaluation && !projectEvaluation) {
            if (AUTO_BOTH_FAIL_FALLBACK || FALLBACK_TO_MOCK || FORCE_MOCK) {
                console.warn('[AIService][COMBINED] Both evaluations failed -> generating synthetic fallback result');
                const fallbackSummary = {
                    cv_evaluation: null,
                    project_evaluation: null,
                    final_score: 0,
                    cv_score: null,
                    project_score: null,
                    issues,
                    overall_summary: 'Both evaluations failed. Synthetic fallback result generated.',
                    _meta: { synthetic: true }
                };
                return fallbackSummary;
            }
            const err = new Error('Both CV and Project evaluation failed');
            err.details = issues;
            throw err;
        }
        let weightedCV = null; let weightedProject = null;
        if (cvEvaluation) {
            weightedCV = this.computeWeightedCV({
                technical_skills: cvEvaluation.technical_skills.score,
                experience_level: cvEvaluation.experience_level.score,
                relevant_achievements: cvEvaluation.relevant_achievements.score,
                cultural_fit: cvEvaluation.cultural_fit.score
            });
        }
        if (projectEvaluation) {
            weightedProject = this.computeWeightedProject({
                correctness: projectEvaluation.correctness.score,
                code_quality: projectEvaluation.code_quality.score,
                resilience: projectEvaluation.resilience.score,
                documentation: projectEvaluation.documentation.score,
                creativity: projectEvaluation.creativity.score
            });
        }
        const cvMatchRate = weightedCV !== null ? Math.round((weightedCV * 0.2) * 100) / 100 : null; // *0.2 = /5
        const projectScore = weightedProject !== null ? Math.round(weightedProject * 100) / 100 : null;
        // Compose summary (could be third LLM call; here reuse existing structure)
        const preliminarySummary = `Job Title: ${jobTitle}. CV match rate: ${cvMatchRate !== null ? cvMatchRate : 'N/A'} (0-1). Project Score: ${projectScore !== null ? projectScore : 'N/A'} (1-5).`;

        // Final synthesis (third LLM call) if real mode and at least one eval exists
    let finalSummary = preliminarySummary;
        if (!MOCK_MODE) {
            try {
                const synthPrompt = `You are a senior technical recruiter.
Given the following structured intermediate evaluation results, produce a concise 3-5 sentence overall summary highlighting strengths, gaps, and recommendation:

INTERMEDIATE:
CV_MATCH_RATE: ${cvMatchRate}
PROJECT_SCORE: ${projectScore}
CV_FEEDBACK: ${cvEvaluation ? cvEvaluation.overall_summary : 'N/A'}
PROJECT_FEEDBACK: ${projectEvaluation ? projectEvaluation.overall_summary : 'N/A'}

Return only the summary text.`;
                const startSynth = Date.now();
                const resp = await this.openai.chat.completions.create({
                    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
                    messages: [{ role: 'user', content: synthPrompt }],
                    temperature: 0.4,
                    max_tokens: 250
                });
                finalSummary = (resp.choices?.[0]?.message?.content || '').trim() || preliminarySummary;
                retrievedContexts.final_summary_mode = 'real';
                retrievedContexts.final_summary_duration_ms = Date.now() - startSynth;
            } catch (e) {
                issues.push({ component: 'final_summary', error: e.message });
                retrievedContexts.final_summary_mode = 'fallback';
                finalSummary = preliminarySummary + ' (final summary fallback)';
            }
        } else {
            retrievedContexts.final_summary_mode = 'mock';
            finalSummary = preliminarySummary + ' Candidate shows potential; further interview recommended.';
        }
        // Enforce 3-5 sentence constraint helper
        function enforceSentenceConstraint(text, min = 3, max = 5) {
            const rawSentences = text
                .replace(/\n+/g,' ') 
                .split(/(?<=[.!?])\s+/)
                .map(s => s.trim())
                .filter(s => s.length > 0);
            let sentences = rawSentences;
            if (sentences.length < min) {
                const fillers = [
                    'Candidate demonstrates baseline alignment with role expectations.',
                    'There are clear opportunities for growth in advanced architectural and AI integration aspects.',
                    'Recommended for further interview to validate depth of experience.'
                ];
                let i = 0;
                while (sentences.length < min && i < fillers.length) {
                    sentences.push(fillers[i++]);
                }
                // If still short, duplicate last
                while (sentences.length < min) sentences.push(sentences[sentences.length -1]);
            }
            if (sentences.length > max) {
                sentences = sentences.slice(0, max);
            }
            // Ensure punctuation
            sentences = sentences.map(s => /[.!?]$/.test(s) ? s : s + '.');
            return sentences.join(' ');
        }
        finalSummary = enforceSentenceConstraint(finalSummary, 3, 5);
        return {
            cv_evaluation: cvEvaluation,
            project_evaluation: projectEvaluation,
            cv_match_rate: cvMatchRate,
            project_score: projectScore,
            cv_feedback: cvEvaluation ? cvEvaluation.overall_summary : undefined,
            project_feedback: projectEvaluation ? projectEvaluation.overall_summary : undefined,
            overall_summary: finalSummary,
            issues: issues.length ? issues : undefined,
            _meta: { cv_present: !!cvEvaluation, project_present: !!projectEvaluation, job_title: jobTitle, retrieved: retrievedContexts }
        };
    }
}

module.exports = new AIService();