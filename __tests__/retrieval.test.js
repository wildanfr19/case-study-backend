const fs = require('fs');
const path = require('path');

describe('Retrieval Service', () => {
  const dataDir = path.join(process.cwd(), 'data');
  const storePath = path.join(dataDir, 'vector_store.json');

  beforeAll(() => {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const embedding = Array(256).fill(0); embedding[0] = 1;
    const store = {
      created_at: new Date().toISOString(),
      chunks: [
        { id: 'jd-1', text: 'Backend development with Node.js and databases focus', embedding, tags: ['job_description'] },
        { id: 'rcv-1', text: 'CV rubric scoring criteria include technical skills and experience', embedding, tags: ['rubric_cv'] }
      ]
    };
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  });

  test('retrieve returns contextual chunks', async () => {
    jest.resetModules();
    const retrieval = require('../services/retrievalService');
    const results = await retrieval.retrieve({ type: 'job_description', query: 'Node.js backend databases', k: 2 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatch(/Backend development/);
  });
});
