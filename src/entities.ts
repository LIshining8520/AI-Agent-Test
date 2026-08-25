export interface KnowledgeDocument {
  id: string;
  tenantId: string;
  title: string;
  content: string;
  metadata: Record<string, any>;
}

export interface RetrievedChunk {
  id: string;
  documentId: string;
  tenantId: string;
  content: string;
  score: number;
  metadata: Record<string, any>;
}

export interface RerankedChunk extends RetrievedChunk {
  rerankScore: number;
}

export interface AnswerCitation {
  chunkId: string;
  documentId: string;
  tenantId: string;
  text: string;
}
