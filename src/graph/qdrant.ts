import { QdrantClient } from "@qdrant/js-client-rest";
import { OpenAIEmbeddings } from "@langchain/openai";
import type { RetrievedChunk } from "../entities.js";
import type { VectorStore } from "../vectorstore.js";

// 同时兼容浏览器（import.meta.env）与 Node（process.env）
export function getEnv(key: string): string | undefined {
  const metaEnv = (import.meta as any).env;
  const fromMeta = metaEnv?.[key];
  if (fromMeta != null) return fromMeta;
  if (typeof process !== "undefined") return process.env[key];
  return undefined;
}

export type EmbeddingFn = (texts: string[]) => Promise<number[][]>;

// 相对路径（如 /qdrant）在浏览器端补全为同源绝对地址（走 Vite 代理）
function resolveQdrantUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("/") && typeof window !== "undefined") {
    return `${window.location.origin}${raw}`;
  }
  return raw;
}

/**
 * 本地哈希向量：零依赖兜底，把文本分词后映射到固定维度的稀疏向量，
 * 仅用于没有 OpenAI Key 时演示（效果远不如真实 embedding）。
 */
function createLocalEmbedding(dim = 256): EmbeddingFn {
  return async (texts: string[]) =>
    texts.map((text) => {
      const vec = new Array(dim).fill(0);
      const tokens = text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
      for (const token of tokens) {
        let hash = 0;
        for (let i = 0; i < token.length; i++) {
          hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
        }
        vec[hash % dim] += 1;
      }
      const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    });
}

/**
 * 创建 embedding 函数：
 * - VITE_EMBEDDING_PROVIDER=openai → OpenAI text-embedding-3-small
 * - VITE_EMBEDDING_PROVIDER=hash → 本地哈希向量（零依赖，关键词级）
 * - 默认 auto：有 VITE_OPENAI_API_KEY 用 OpenAI，否则本地哈希向量
 */
export function createEmbeddingFunction(): EmbeddingFn {
  const provider = getEnv("VITE_EMBEDDING_PROVIDER") || "auto";
  const apiKey = getEnv("VITE_OPENAI_API_KEY");
  if (provider === "openai" || (provider === "auto" && apiKey)) {
    if (!apiKey) {
      throw new Error(
        "[qdrant] VITE_EMBEDDING_PROVIDER=openai 但未配置 VITE_OPENAI_API_KEY",
      );
    }
    const embeddings = new OpenAIEmbeddings({
      model: getEnv("VITE_OPENAI_EMBEDDING_MODEL") || "text-embedding-3-small",
      apiKey,
      configuration: {
        baseURL:
          getEnv("VITE_OPENAI_EMBEDDING_BASE_URL") ||
          "https://api.openai.com/v1",
      },
    });
    return async (texts: string[]) => embeddings.embedDocuments(texts);
  }
  console.warn(
    "[qdrant] 使用本地哈希向量（关键词级，零依赖）。",
  );
  return createLocalEmbedding();
}

export interface QdrantVectorStoreOptions {
  url: string;
  apiKey?: string;
  collectionName: string;
  embed?: EmbeddingFn;
}

/**
 * QdrantVectorStore — 连接真实 Qdrant 的向量存储实现。
 * 检索时按 tenant_id 做 payload 过滤，只返回当前租户的向量。
 */
export class QdrantVectorStore implements VectorStore {
  private client: QdrantClient;
  private collectionName: string;
  private embed: EmbeddingFn;
  private tenantIndexReady: Promise<void> | null = null;

  constructor(options: QdrantVectorStoreOptions) {
    // QdrantClient 只取 url 的 host/port，路径需通过 prefix 显式传递（反代场景如 /qdrant）
    const parsed = new URL(options.url);
    const pathPrefix =
      parsed.pathname && parsed.pathname !== "/"
        ? parsed.pathname.replace(/\/$/, "")
        : undefined;
    this.client = new QdrantClient({
      url: pathPrefix ? parsed.origin : options.url,
      prefix: pathPrefix,
      apiKey: options.apiKey || undefined,
    });
    this.collectionName = options.collectionName;
    this.embed = options.embed ?? createEmbeddingFunction();
  }

  async ensureCollection(vectorSize: number): Promise<void> {
    const { exists } = await this.client.collectionExists(this.collectionName);
    if (!exists) {
      await this.client.createCollection(this.collectionName, {
        vectors: { size: vectorSize, distance: "Cosine" },
      });
      console.log(
        `[qdrant] 已创建 collection: ${this.collectionName} (${vectorSize} 维)`,
      );
    }
  }

  /** 删除整个 collection（灌库前清空，保证可重复执行） */
  async deleteCollection(): Promise<void> {
    const { exists } = await this.client.collectionExists(this.collectionName);
    if (exists) {
      await this.client.deleteCollection(this.collectionName);
      this.tenantIndexReady = null;
      console.log(`[qdrant] 已删除 collection: ${this.collectionName}`);
    }
  }

  /** 把知识分片写入 Qdrant（灌库） */
  async upsertChunks(chunks: RetrievedChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const vectors = await this.embed(chunks.map((c) => c.content));
    const vectorSize = vectors[0]?.length ?? 0;
    if (vectorSize === 0) {
      throw new Error("embedding 返回了空向量，无法写入 Qdrant");
    }
    await this.ensureCollection(vectorSize);
    await this.client.upsert(this.collectionName, {
      points: chunks.map((chunk, i) => ({
        // Qdrant 只接受整数或 UUID 作为 point ID，原始 chunk id 存进 payload
        id: crypto.randomUUID(),
        vector: vectors[i],
        payload: {
          chunk_id: chunk.id,
          tenant_id: chunk.tenantId,
          document_id: chunk.documentId,
          content: chunk.content,
          source_score: chunk.score,
          metadata: chunk.metadata,
        },
      })),
    });
    console.log(
      `[qdrant] 已写入 ${chunks.length} 条知识到 ${this.collectionName}`,
    );
  }

  // tenant_id 过滤需要 keyword 索引；索引已存在时静默跳过
  private ensureTenantIndex(): Promise<void> {
    if (!this.tenantIndexReady) {
      this.tenantIndexReady = this.client
        .createPayloadIndex(this.collectionName, {
          field_name: "tenant_id",
          field_schema: "keyword",
        })
        .then(() => {
          console.log("[qdrant] 已为 tenant_id 创建 keyword 索引");
        })
        .catch((error: any) => {
          console.warn(`[qdrant] tenant_id 索引跳过: ${error?.message}`);
        });
    }
    return this.tenantIndexReady;
  }

  async search(
    query: string,
    tenantId: string,
    topK: number,
  ): Promise<RetrievedChunk[]> {
    await this.ensureTenantIndex();
    const [vector] = await this.embed([query]);
    const res = await this.client.query(this.collectionName, {
      query: vector,
      limit: topK,
      // Metadata filtering：只检索当前租户
      filter: {
        must: [{ key: "tenant_id", match: { value: tenantId } }],
      },
      with_payload: true,
    });

    return res.points.map((hit) => ({
      id: (hit.payload?.chunk_id as string) ?? String(hit.id),
      documentId: (hit.payload?.document_id as string) ?? "",
      tenantId: (hit.payload?.tenant_id as string) ?? tenantId,
      content: (hit.payload?.content as string) ?? "",
      score: (hit.score as number) ?? 0,
      metadata: (hit.payload?.metadata as Record<string, any>) ?? {},
    }));
  }
}

/** 从环境变量构建默认 Qdrant 配置 */
export function createQdrantVectorStore(): QdrantVectorStore {
  // Node（灌库/检索脚本）优先 QDRANT_URL；浏览器端走 VITE_QDRANT_URL（同源代理）
  const url =
    getEnv("QDRANT_URL") ||
    resolveQdrantUrl(getEnv("VITE_QDRANT_URL")) ||
    "http://localhost:6333";
  const apiKey = getEnv("QDRANT_API_KEY") || getEnv("VITE_QDRANT_API_KEY");
  console.log(`[qdrant] 连接 ${url}，collection=${getEnv("VITE_QDRANT_COLLECTION") || getEnv("QDRANT_COLLECTION") || "ai_agent_kb"}`);
  return new QdrantVectorStore({
    url,
    apiKey,
    collectionName:
      getEnv("VITE_QDRANT_COLLECTION") ||
      getEnv("QDRANT_COLLECTION") ||
      "ai_agent_kb",
  });
}
