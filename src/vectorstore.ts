import type { RetrievedChunk } from './entities.js';

/**
 * 向量存储接口 — 抽象层
 * 生产环境：QdrantVectorStore（连接真实 Qdrant）
 * 教学/测试环境：InMemoryVectorStore（零依赖）
 */
export interface VectorStore {
  search(query: string, tenantId: string, topK: number): Promise<RetrievedChunk[]>;
}

/**
 * 内存向量存储 — 用于教学和测试
 * 用关键词重叠度模拟向量相似度，零外部依赖
 */
export class InMemoryVectorStore implements VectorStore {
  private chunks: RetrievedChunk[];

  constructor(chunks: RetrievedChunk[]) {
    this.chunks = chunks;
  }

  async search(query: string, tenantId: string, topK: number): Promise<RetrievedChunk[]> {
    // Metadata filtering：只返回当前租户的文档
    const tenantChunks = this.chunks.filter(c => c.tenantId === tenantId);

    if (tenantChunks.length === 0) {
      return [];
    }

    // 用关键词重叠度模拟向量相似度排序
    const queryTerms = query.toLowerCase().split(/\s+/);
    const scored = tenantChunks.map(chunk => {
      const content = chunk.content.toLowerCase();
      const matchCount = queryTerms.filter(term => content.includes(term)).length;
      const similarityScore = matchCount / Math.max(queryTerms.length, 1);
      return { ...chunk, score: similarityScore };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}
