/**
 * Simple retrieval (RAG) abstraction.
 * For full implementation, run ingestion script to build vector_store.json.
 * If embeddings not available, returns placeholder context.
 */
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
let cachedStore = null;

function cosine(a, b) {
  const len = Math.min(a.length, b.length);
  let dot=0, na=0, nb=0;
  for (let i=0;i<len;i++){ dot += a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  return (dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-9));
}

async function embedTextOpenAI(text, openai) {
  const resp = await openai.embeddings.create({ model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small', input: text });
  return resp.data[0].embedding;
}

function cheapHashEmbedding(text, dim=256) {
  const vec = new Array(dim).fill(0);
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);
  for (const t of tokens){
    const h = [...t].reduce((a,c)=>a+c.charCodeAt(0),0) % dim;
    vec[h] += 1;
  }
  // normalize
  const norm = Math.sqrt(vec.reduce((s,v)=>s+v*v,0))||1;
  return vec.map(v=>v/norm);
}

function loadStore() {
  if (cachedStore) return cachedStore;
  const file = path.join(process.cwd(), 'data', 'vector_store.json');
  if (fs.existsSync(file)) {
    try { cachedStore = JSON.parse(fs.readFileSync(file,'utf8')); } catch { cachedStore = { chunks: [] }; }
  } else {
    cachedStore = { chunks: [] };
  }
  return cachedStore;
}

async function retrieve({ type, query, k = 5 }) {
  const store = loadStore();
  if (!store.chunks.length) {
    return [`[NO_STORE] Provide ingestion first for type=${type}`];
  }
  // filter by tag
  const filtered = store.chunks.filter(c => c.tags && c.tags.includes(type));
  if (!filtered.length) return [`[NO_MATCHING_CHUNKS type=${type}]`];
  // embed query cheaply (store embeddings precomputed)
  const qVec = cheapHashEmbedding(query);
  const scored = filtered.map(c => ({ score: cosine(qVec, c.embedding || []), text: c.text }));
  scored.sort((a,b)=>b.score - a.score);
  return scored.slice(0,k).map(s => s.text);
}

async function ingestLocalPdf({ filePath, tags = [] , openai = null }) {
  const buf = fs.readFileSync(filePath);
  const data = await pdf(buf);
  const raw = data.text || '';
  const parts = raw.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 40);
  const chunks = [];
  for (const p of parts){
    let embedding;
    if (openai) {
      try { embedding = await embedTextOpenAI(p.slice(0,2000), openai); } catch { embedding = cheapHashEmbedding(p); }
    } else {
      embedding = cheapHashEmbedding(p);
    }
    chunks.push({ id: `${path.basename(filePath)}-${chunks.length}`, text: p, embedding, tags });
  }
  return chunks;
}

module.exports = {
  retrieve,
  ingestLocalPdf
};
