process.env.AI_FORCE_MOCK = '1';
const aiService = require('../services/aiService');

describe('AI Service (Mock Mode)', () => {
  test('evaluateCandidate returns required top-level fields', async () => {
    const res = await aiService.evaluateCandidate('Sample CV text about backend APIs cloud', 'Sample project report with RAG chaining');
    expect(res).toHaveProperty('cv_match_rate');
    expect(res).toHaveProperty('project_score');
    expect(res).toHaveProperty('overall_summary');
    expect(res._meta).toHaveProperty('retrieved');
  });
});
