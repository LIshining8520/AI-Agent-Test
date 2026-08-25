import { StateGraph, END, START, MemorySaver } from '@langchain/langgraph';
import { getTracingCallbacks } from './llm.js';
import { StateAnnotation, type State } from './state.js';
import { createRetrieveTool, RetrieveContextSchema, defaultKnowledgeBase } from './tools.js';
import { mockRerank, type Reranker } from './rerank.js';
import { InMemoryVectorStore, type VectorStore } from '../vectorstore.js';
import type { AnswerCitation, RerankedChunk } from '../entities.js';
import { createQdrantVectorStore, getEnv } from './qdrant.js';

// ──────────────────────────────────────────────
// Graph Nodes
// ──────────────────────────────────────────────

/**
 * retrieveNode：向量检索
 * - Fail-closed：缺失 tenantId 直接拒绝
 * - Metadata filtering：只检索当前租户的文档
 */
function createRetrieveNode(vectorStore: VectorStore) {

  return async function retrieveNode(state: State) {
    // Fail-closed 约束：缺失 tenantId 直接拒绝
    if (!state.tenantId) {
      throw new Error('TenantId is missing. Request rejected.');
    }

    const retrieveContext = createRetrieveTool(vectorStore);

    // Parse and validate using Zod
    const input = RetrieveContextSchema.parse({
      query: state.query,
      tenantId: state.tenantId,
      topK: 20,
      topN: 10, // 多取一些给 Rerank
    });

    const toolResultStr = await retrieveContext.invoke(input);

    if (toolResultStr === '当前租户下无可用证据') {
      return {
        retrievedDocs: [],
        rerankedDocs: [],
        finalAnswer: '当前租户下无可用证据',
        citations: [],
      };
    }

    const docs = JSON.parse(toolResultStr);

    return {
      retrievedDocs: docs,
      rerankedDocs: docs, // rerankNode 会覆盖这个
    };
  };
}

/**
 * rerankNode：重排序
 * - 对检索结果进行二次排序，提升 Precision
 * - 默认使用 Mock Rerank（关键词匹配），生产替换为 Cohere Rerank
 */
function createRerankNode(reranker: Reranker | null) {
  return async function rerankNode(state: State) {
    if (state.finalAnswer === '当前租户下无可用证据') {
      return {};
    }

    const docs = state.retrievedDocs || [];

    if (reranker) {
      const reranked = await reranker.rerank(state.query, docs, 5);
      return { rerankedDocs: reranked };
    }

    // Fallback: 使用内置 mockRerank
    const reranked = mockRerank(state.query, docs, 5);
    return { rerankedDocs: reranked };
  };
}

/**
 * generateNode：生成回答
 * - 纵深防御：二次过滤跨租户数据
 * - 生成答案 + 引用来源
 */
async function generateNode(state: State) {
  if (state.finalAnswer === '当前租户下无可用证据') {
    return {};
  }

  const docs = state.rerankedDocs || [];

  // 纵深防御：二次过滤，确保 citations 全部属于当前租户
  const safeDocs: RerankedChunk[] = docs.filter(
    (doc) => doc.tenantId === state.tenantId
  );

  const citations: AnswerCitation[] = safeDocs.map((doc) => ({
    chunkId: doc.id,
    documentId: doc.documentId,
    tenantId: doc.tenantId,
    text: doc.content,
  }));

  const answer = safeDocs.length > 0
    ? `Based on the context, here is the answer to your query: ${state.query}. Evidence: ${safeDocs.map((d) => d.content).join(' ')}`
    : '未检索到相关知识，请确认租户权限或扩充知识库。';

  return {
    finalAnswer: answer,
    citations,
  };
}

// ──────────────────────────────────────────────
// Graph Builder
// ──────────────────────────────────────────────

export interface BuildGraphOptions {
  checkpointer?: MemorySaver;
  vectorStore?: VectorStore;
  reranker?: Reranker | null;
}

// 默认向量库：配置了 QDRANT_URL 就用真实 Qdrant，否则退回内存知识库
function createDefaultVectorStore(): VectorStore {
  const qdrantUrl = getEnv('VITE_QDRANT_URL') || getEnv('QDRANT_URL');
  if (qdrantUrl) {
    console.log(`[agent] 使用 QdrantVectorStore (${qdrantUrl})`);
    return createQdrantVectorStore();
  }
  console.log('[agent] 未配置 QDRANT_URL，使用 InMemoryVectorStore(defaultKnowledgeBase)');
  return new InMemoryVectorStore(defaultKnowledgeBase);
}

export function buildGraph(options?: BuildGraphOptions) {
  const vectorStore = options?.vectorStore ?? createDefaultVectorStore();
  const reranker = options?.reranker ?? null;

  const retrieveNode = createRetrieveNode(vectorStore);
  const rerankNode = createRerankNode(reranker);

  const workflow = new StateGraph(StateAnnotation)
    .addNode('retrieve', retrieveNode)
    .addNode('rerank', rerankNode)
    .addNode('generate', generateNode)
    .addEdge(START, 'retrieve')
    .addEdge('retrieve', 'rerank')
    .addEdge('rerank', 'generate')
    .addEdge('generate', END);

  const compiled = workflow.compile({ checkpointer: options?.checkpointer });

  const originalInvoke = compiled.invoke.bind(compiled);
  const originalStream = compiled.stream.bind(compiled);

  const injectCallbacks = (config?: any) => {
    const callbacks = getTracingCallbacks();
    let existing = config?.callbacks || [];
    if (!Array.isArray(existing)) {
      existing = [existing];
    }
    return { ...config, callbacks: [...existing, ...callbacks] };
  };

  return Object.assign(compiled, {
    invoke: async (state: Parameters<typeof originalInvoke>[0], config?: Parameters<typeof originalInvoke>[1]) => {
      return originalInvoke(state, injectCallbacks(config));
    },
    stream: async (state: Parameters<typeof originalStream>[0], config?: Parameters<typeof originalStream>[1]) => {
      return originalStream(state, injectCallbacks(config));
    },
  });
}
