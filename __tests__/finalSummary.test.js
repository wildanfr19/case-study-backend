process.env.AI_FORCE_MOCK = '1';
const aiService = require('../services/aiService');

function countSentences(text){
  return text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0).length;
}

describe('Final Summary Sentence Constraint', () => {
  test('overall_summary has between 3 and 5 sentences', async () => {
    const res = await aiService.evaluateCandidate('Extensive backend experience with Node.js microservices and cloud deployment.', 'Project implements RAG pattern with retries and robust error handling.');
    const sentences = countSentences(res.overall_summary);
    expect(sentences).toBeGreaterThanOrEqual(3);
    expect(sentences).toBeLessThanOrEqual(5);
  });
});
