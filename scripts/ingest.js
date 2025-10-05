#!/usr/bin/env node
/**
 * Ingest ground-truth PDFs (job descriptions, case study brief, rubrics) into local vector store.
 * Usage: node scripts/ingest.js ./docs/job_description.pdf:job_description ./docs/case_brief.pdf:case_brief ./docs/rubric_cv.pdf:rubric_cv ./docs/rubric_project.pdf:rubric_project
 */
const fs = require('fs');
const path = require('path');
const { ingestLocalPdf } = require('../services/retrievalService');
require('dotenv').config();
let OpenAI = null;
let openai = null;
if (process.env.OPENAI_API_KEY) {
  try { OpenAI = require('openai'); openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); } catch {}
}

async function main(){
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log('Provide at least one filePath:tag argument');
    process.exit(1);
  }
  const outDir = path.join(process.cwd(),'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const storePath = path.join(outDir,'vector_store.json');
  const aggregate = { created_at: new Date().toISOString(), chunks: [] };
  for (const spec of args){
    const [fp, tag] = spec.split(':');
    if (!fp || !tag){ console.warn('Skip invalid spec', spec); continue; }
    if (!fs.existsSync(fp)) { console.warn('File not found', fp); continue; }
    console.log('Ingesting', fp, 'as', tag);
    try {
      const chunks = await ingestLocalPdf({ filePath: fp, tags: [tag], openai });
      aggregate.chunks.push(...chunks);
    } catch(e) {
      console.warn('Failed ingest', fp, e.message);
    }
  }
  fs.writeFileSync(storePath, JSON.stringify(aggregate,null,2));
  console.log('Vector store saved to', storePath, 'Total chunks:', aggregate.chunks.length);
}

main();
