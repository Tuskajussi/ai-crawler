export type KnowledgeModality = 'text' | 'pdf' | 'image' | 'audio' | 'video';

export interface EmbeddingConfig {
  provider: 'gemini' | 'vertex' | 'compatible';
  kind: 'local' | 'cloud';
  modelId: string;
  baseUrl: string;
  apiKeyEnv: string;
  dimensions: number;
  timeoutSeconds: number;
  projectId: string;
  location: 'global' | 'us' | 'eu';
}

export const defaultEmbeddingConfig: EmbeddingConfig = {
  provider: 'gemini', kind: 'cloud', modelId: 'gemini-embedding-2', baseUrl: '',
  apiKeyEnv: 'GEMINI_API_KEY', dimensions: 768, timeoutSeconds: 120,
  projectId: '', location: 'eu',
};

export interface ChunkOptions {
  textCharacters: number;
  textOverlap: number;
  audioSeconds: number;
  videoSeconds: number;
}

export const defaultChunkOptions: ChunkOptions = {
  textCharacters: 1800, textOverlap: 200, audioSeconds: 150, videoSeconds: 60,
};

export interface ChunkLocator {
  startChar?: number; endChar?: number;
  startLine?: number; endLine?: number;
  pageStart?: number; pageEnd?: number;
  startSeconds?: number; endSeconds?: number;
  track?: 'audio' | 'video';
}

export interface KnowledgeChunk {
  id: string;
  index: number;
  modality: KnowledgeModality;
  mimeType: string;
  text?: string;
  preview: string;
  locator: ChunkLocator;
}

export interface KnowledgePreview {
  id: string;
  name: string;
  modality: KnowledgeModality;
  bytes: number;
  chunks: KnowledgeChunk[];
  expiresAt: string;
}

export interface KnowledgeSource {
  id: string;
  name: string;
  modality: KnowledgeModality;
  bytes: number;
  chunkCount: number;
  dimensions: number;
  modelId: string;
  spaceKey: string;
  createdAt: string;
  compatible: boolean;
}

export interface KnowledgeJob {
  id: string;
  sourceName: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  completedChunks: number;
  totalChunks: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  sourceId?: string;
}

export interface KnowledgeStatus {
  config: EmbeddingConfig;
  readiness: { ready: boolean; message: string };
  sources: KnowledgeSource[];
  job?: KnowledgeJob;
  limits: { uploadBytes: number; chunksPerSource: number; totalChunks: number; sources: number };
}

export interface KnowledgeSearchResult {
  sourceId: string;
  sourceName: string;
  chunk: KnowledgeChunk;
  score: number;
}
