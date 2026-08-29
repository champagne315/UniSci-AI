# UniSci AI

一个群聊式科研协作平台：**多个专家 Agent + 人类在同一个群里协作**，用 `@` 分派任务、链式转交、关键决策人类审批，并把文档/笔记沉淀成知识库供 Agent 引用。

> 技术栈：**Node.js + LangGraph.js + DeepSeek（真实 API）**。群聊引擎用 LangGraph 的 StateGraph + Send 实现 @路由/并行扇出/链式转交，审批用暂停-续跑模型，思考过程（reasoning）流式可见。

## 一、启动

```bat
cd app
node server/server.js
```

浏览器打开 **http://localhost:8080**。（默认 8080；若被占会自动找 8081、8082…，也可用 `set PORT=8xxx` 指定）

默认走**真实 DeepSeek API**（`deepseek-v4-flash`，key 已内置在 `config.js`）。界面左上角显示「实跑模式 · deepseek-v4-flash」。

## 二、体验路径（建议按此顺序）

1. **新建群聊会话**：左栏点 `+`，勾选要参与的 Agent（科研协调员、文献/代码/电路/机械研究员），可选关联知识库。
2. **@ 协调员分工**：在输入框打 `@` 会弹出群成员自动补全。发 `@lead 我们要做自供电传感器系统，请协调分工`，协调员会拆任务并 `@` 其他专家。
3. **看链式转交**：被 `@` 的专家会接力发言；一条消息 `@` 多人则**并行扇出**，多轮协作去重防死循环。
4. **看思考过程**：回复区上方有可折叠的「思考过程」区块，推理模型的 reasoning_content 会流式落到这里。
5. **审批人类拍板**：Agent 遇到关键取舍时，回复末尾带 `[NEEDS_APPROVAL:...]` → 群里弹「需要你拍板」卡片 → 批准/驳回后群聊恢复，链路续跑。
6. **知识库 RAG**：右栏「知识库」新建 → 上传 `.md/.txt/.json/.csv/.py` 等纯文本，或粘贴文本 → 新建会话时关联该 KB → `@lit` 提问，文献研究员会引用知识库原文回答。
7. **自定义 Agent**：在「智能体」页创建或编辑 Agent，可改提示词/技能/工具/颜色，并为每个 Agent 单独多选专属知识库；未选择时继承会话知识库。

## 三、核心机制

| 机制 | 实现 | 文件 |
|------|------|------|
| **@ 路由** | 显式 `@` 优先；无 `@` 且开 autoRoute 时按技能/角色关键词自动选 | `engine/router.js` |
| **群聊图** | LangGraph StateGraph：起点条件边 → Send 扇出 → respond → 条件边续跑/结束 | `engine/orchestrator.js` |
| **链式转交** | Agent 回复里的 `@` 入队接力；会话级 `_turnSpoken` 去重 + maxRounds 封顶，防并行死循环 | 同上 |
| **HITL 审批** | 回复含 `[NEEDS_APPROVAL:...]` → 挂起 → 人类 POST 决策 → `nextTargets` 续跑 | 同上 |
| **流式生成** | LLM 逐 token → SSE 广播 → 前端打字光标 | `engine/llm.js` + `server.js` |
| **思考过程** | DeepSeek 推理模型的 `reasoning_content` 单独流式广播，前端可折叠展示 | 同上 |
| **Agent 模板** | JSON 驱动，内置 5 个科研专家 + 可自定义 | `agents/builtin/*.json` |
| **RAG** | 切块 + 本地 TF/bigram 向量 + 余弦检索；强制引用回传 | `kb/` |

## 四、目录结构

```
app/
├── server/
│   ├── server.js          主服务（HTTP + SSE + 静态托管）
│   ├── config.js          配置（端口/DeepSeek key/模型）
│   ├── store.js           会话/消息/审批运行时存储（内存）
│   ├── http.js            body/multipart/SSE 工具
│   ├── engine/
│   │   ├── orchestrator.js  群聊编排（LangGraph StateGraph）
│   │   ├── router.js        @ 路由 + 自动选择
│   │   └── llm.js           ChatOpenAI(DeepSeek) 流式，reasoning/content 分离
│   ├── agents/
│   │   ├── registry.js      模板注册/加载/自定义
│   │   └── builtin/*.json   5 个内置科研专家模板
│   └── kb/
│       ├── embed.js         本地 TF/bigram 向量 + 余弦
│       ├── ingest.js        解析 + 切块
│       └── store.js         知识库 + 检索
├── web/                     前端单页（HTML/CSS/JS，零依赖，零构建）
├── test/                    端到端测试
└── data/                    运行时数据（自定义 Agent、上传文件、KB）
```

## 五、内置 Agent（可改可加）

| @handle | 名称 | 职责 |
|---------|------|------|
| `@lead` | 科研协调员 | 拆解任务、@ 分派、对齐收敛 |
| `@lit` | 文献研究员 | 检索/综述/引用、对比矩阵 |
| `@code` | 代码研究员 | 算法复现、实验脚本、代码评审 |
| `@circuit` | 电路研究员 | 器件选型、原理图评审、SI 分析 |
| `@mech` | 机械结构研究员 | 结构/封装、FEA 仿真、装配 |

## 六、端到端测试（均走真实 DeepSeek）

先启动服务（另开终端）：

```bat
set PORT=8741
set OPENAI_API_KEY=sk-...
node server/server.js
```

再跑测试（每条单消息约 5–30s，推理模型）：

```bat
node test/diag_orch.js     :: 进程内直跑：单 Agent 回复 + 思考过程
node test/diag_chain.js    :: 进程内直跑：@lit @code 并行扇出，验证不死循环
node test/smoke.js http://127.0.0.1:8741   :: HTTP+SSE：@ 路由 + 流式
node test/e2e.js   http://127.0.0.1:8741   :: HTTP+SSE：reasoning 流式 + 消息持久化
node test/rag_chat.js http://127.0.0.1:8741 :: RAG：Agent 引用知识库
node test/kb_test.js                       :: 知识库入库 + 检索
```

## 七、依赖与配置

依赖已装（`@langchain/langgraph@1.x`、`@langchain/openai@1.x`、`@langchain/core@1.x`），`node server/server.js` 直接跑。

配置在 `server/config.js`，也可用环境变量覆盖：

```bat
set OPENAI_API_KEY=sk-...                  :: DeepSeek 对话 key
set OPENAI_BASE_URL=https://api.deepseek.com/v1
set OPENAI_MODEL=deepseek-v4-flash

:: 方舟 Agent Plan 专属向量模型；配置后自动启用语义+词法混合检索
:: 实际密钥写入 app/.env（已被 .gitignore 忽略），不要提交到仓库
set OPENAI_EMBEDDING_API_KEY=你的AgentPlan专属Key
set OPENAI_EMBEDDING_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3
set OPENAI_EMBEDDING_MODEL=doubao-embedding-vision
set EMBEDDING_BATCH_SIZE=1                 :: vision 模型只支持单文本输入
set RAG_SEMANTIC_WEIGHT=0.75               :: 语义分数权重，范围 0~1

set FORCE_MOCK=true                        :: 仅在无网时强制本地 mock 冒烟
set SHOW_REASONING=false                   :: 不广播思考过程
```

兼容任何 OpenAI 协议端点（DeepSeek / OpenAI / 本地 vLLM）。

## 八、已知限制与后续规划

- **数据**：内存存储，重启丢失（store 层已抽象，可平滑切 SQLite/Postgres）。
- **RAG 向量**：已支持 OpenAI 兼容 Embedding 语义向量 + 本地 TF 混合排序；未配置或外部服务异常时自动回退词法检索。向量当前保存在进程内存，后续可切 Qdrant。
- **文档格式**：纯文本（.txt/.md/.json/.csv/.py 等）直接解析；PDF 使用 `pdf-parse` 提取文字层，Word（.docx）使用 `mammoth` 提取正文；图片和扫描版 PDF 需配置 `GLM_OCR_API_KEY` 才能 OCR 入库。未能提取出文本的文件不会生成文档记录或索引，界面会显示具体失败原因。
- **Skill/工具模型**：Skill 遵循 Agent Skills 的 `SKILL.md` 目录规范，按需读取指令与资源；实际工具调用由 Agent 的显式授权与审批策略决定。MCP 注册中心尚未接入。
- **飞书**：按既定决策暂缓，当前用「上传文档/粘贴文本」兜底入库。

---

*UniSci AI · 2026-07*
