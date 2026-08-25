import type { RetrievedChunk, RerankedChunk } from '../entities.js';

/**
 * Rerank 接口 — 抽象层
 * 生产环境：CohereReranker（调用 Cohere Rerank API）
 * 教学/测试环境：mockRerank（关键词权重重排，零外部依赖）
 */
export interface Reranker {
  rerank(query: string, chunks: RetrievedChunk[], topN: number): Promise<RerankedChunk[]>;
}

/**
 * Mock Rerank — 基于关键词匹配的重排序
 * 模拟 Cross-Encoder 的行为：对 query 和 chunk content 计算相关性分数
 */
export function mockRerank(query: string, chunks: RetrievedChunk[], topN: number): RerankedChunk[] {
  if (chunks.length === 0) return [];

  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored: RerankedChunk[] = chunks.map(chunk => {
    const content = chunk.content.toLowerCase();
    // 关键词匹配加权：query 中每个词在 content 中出现即加分
    let score = 0;
    for (const term of queryTerms) {
      if (content.includes(term)) {
        score += 1;
        // 完整短语匹配额外加分
        if (content.includes(query.toLowerCase())) {
          score += 0.5;
        }
      }
    }
    return {
      ...chunk,
      rerankScore: score / Math.max(queryTerms.length, 1),
    };
  });

  scored.sort((a, b) => b.rerankScore - a.rerankScore);
  return scored.slice(0, topN);
}

/**
 * Cohere Reranker — 真实 Rerank API
 * 需要 COHERE_API_KEY 环境变量
 *
 * 使用方式：
 *   const reranker = new CohereReranker(process.env.COHERE_API_KEY!);
 *   const results = await reranker.rerank(query, chunks, 5);
 */
export class CohereReranker implements Reranker {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'rerank-v3.5') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async rerank(query: string, chunks: RetrievedChunk[], topN: number): Promise<RerankedChunk[]> {
    if (chunks.length === 0) return [];

    const response = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: chunks.map(c => c.content),
        top_n: topN,
      }),
    });

    if (!response.ok) {
      throw new Error(`Cohere Rerank API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      results: Array<{ index: number; relevance_score: number }>;
    };

    return data.results.map(r => ({
      ...chunks[r.index],
      rerankScore: r.relevance_score,
    }));
  }
}
