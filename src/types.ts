import { z } from 'zod';

// 聊天消息结构(从原 @offerai/shared 包内联,保证本项目可独立运行)
export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  name: z.string().optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
