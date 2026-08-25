import { createQdrantVectorStore } from "./qdrant.js";
import { defaultKnowledgeBase } from "./tools.js";

// 灌库脚本：把 defaultKnowledgeBase 写入 Qdrant
// 运行：npm run seed:qdrant
async function main() {
  const store = createQdrantVectorStore();
  // 清空重建，保证重复执行不会产生重复数据
  await store.deleteCollection();
  await store.upsertChunks(defaultKnowledgeBase);
  console.log("灌库完成，共", defaultKnowledgeBase.length, "条知识。");
}

main().catch((err) => {
  console.error("灌库失败:", err?.message ?? err);
  process.exit(1);
});
