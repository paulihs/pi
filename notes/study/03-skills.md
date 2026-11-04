# 03 Skill：怎么被发现，怎么进提示词

校对基准：`main@2c8d1feb1`。

Skill 是"按需加载的说明书"，不是代码。模型平时只看到一行索引，真正需要时才用 `read` 把整份 `SKILL.md` 读进来。理解这一点，剩下的都是细节。

## 1. 一条 skill 长什么样

```
~/.pi/agent/skills/pdf/
└── SKILL.md          ← 必须叫这个名字
    scripts/          ← 可选，skill 自己的辅助文件
    templates/
```

`SKILL.md` 开头是 YAML frontmatter：

```markdown
---
name: pdf
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files.
disable-model-invocation: false
---

# PDF processing

详细步骤写在这里……
```

校验规则（`skills.ts:92` / `:117`）：

- `name` ≤ 64 字符，只允许小写字母、数字、连字符（`^[a-z0-9-]+$`）。
- `description` 必填，≤ 1024 字符。
- frontmatter 里的其它键原样保留，留给 skill 自己用。

不带 frontmatter 的 `SKILL.md` 也能加载，但 name/description 会从目录名和正文推断，且可能报 diagnostic。

## 2. 从哪儿发现

`loadSkills()`（`skills.ts:414`）扫这些位置：

| 来源 | 路径 | 优先级 |
|---|---|---|
| user | `~/.pi/agent/skills/` | 先加载 |
| project | `<cwd>/.pi/skills/` | 后加载 |
| explicit | `skillPaths`（settings 或扩展贡献） | 最后 |

三条规则：

- 递归找 `SKILL.md`。一个目录里只要有 `SKILL.md`，它就是 skill 根，不再往下钻（所以 skill 内部的子目录不会被误认成另一个 skill）。
- 符号链接会解析成真实路径去重，同一个文件从两条路径进来只算一次。
- 同名冲突保留**先加载**的那个，后一个报 `collision` 诊断，不加载。

除了磁盘，扩展也能在运行时贡献 skill 路径：`resources_discover` 事件返回 `skillPaths`，`AgentSession.extendResourcesFromExtensions()` 收下后调 `resourceLoader.extendResources()`，再重建提示词。所以 skill 可以来自 npm 包。

## 3. 怎么进提示词

这是关键设计：**提示词里只放索引，不放正文。**

```
系统提示词
  └─ <skills>
       The following skills provide specialized instructions for specific tasks.
       Use the read tool to load a skill's file when the task matches its description.
       Resolve relative paths against the skill's directory (parent of SKILL.md).

       <available_skills>
         <skill>
           <name>pdf</name>
           <description>Extract text and tables from PDF files...</description>
           <location>/Users/xxx/.pi/agent/skills/pdf/SKILL.md</location>
         </skill>
       </available_skills>
     </skills>
```

生成函数是 `formatSkillsForPrompt()`（`skills.ts:358`），调用点在 `buildSystemPromptSections()`（`system-prompt.ts:178`）。

为什么只放索引：

- 一份 skill 正文可能几千 token，几十个 skill 就把上下文吃光了。
- 索引是稳定的，正文按需读。模型的上下文前缀不变，provider 的 prompt cache 一直命中。

代价是模型必须"先读后做"。如果 `read`/`bash` 都没启用，提示词里的指引会退化成不点名工具的版本（`skillFileReadTool === "indirect"`），skill 索引仍然保留，因为别的工具（比如 codemode 里的读取）也可能够得到。

## 4. 完整链路

```
session 启动
  │
  ├─ DefaultResourceLoader.reload()
  │    └─ loadSkills({ cwd, agentDir, skillPaths, includeDefaults: true })
  │         └─ 每个 SKILL.md → Skill { name, description, filePath, baseDir, disableModelInvocation }
  │
  ├─ AgentSession._rebuildSystemPrompt()
  │    └─ resourceLoader.getSkills().skills
  │         └─ normalizeBuildSystemPromptOptions({ skills })
  │
  └─ 第一次请求前
       └─ buildSystemPromptSections()
            └─ formatSkillsForPrompt(skills, "read")
                 └─ <skills> section
                      └─ diffSystemPromptSections() → SystemMessage.sections 补丁
```

用户输入触发 skill 时（`/pdf` 或者模型自己决定读），走的是普通 `read` 调用，读的是 `location` 里那个绝对路径。skill 的 `baseDir` 用来解析 skill 内部的相对引用。

## 5. 几个开关

**`disable-model-invocation: true`** — 这条 skill 不出现在 `<available_skills>` 里，模型看不到，只能用户显式调用。适合带副作用或很专用的 skill。

**`/reload`** — 重扫磁盘资源，重建 runner 和提示词，不用重启会话。开发 skill 时用这个。

**`hiddenTools`** — 如果 `read` 因为 `prepareLoadout` 被隐藏声明，skill 段仍然生成，只是引导语里不提 `read`（`system-prompt.ts:173`）。

## 6. Skill 和工具的区别

| | Skill | Tool |
|---|---|---|
| 形态 | Markdown 文件 | TypeScript 函数 |
| 进入上下文 | 索引常驻，正文按需读 | 声明常驻（取决于 exposure） |
| 执行 | 靠模型按说明操作现有工具 | 自己执行代码并返回结果 |
| 适合 | 流程、规范、领域知识 | 原子能力 |

常见误区是把 skill 当成"能执行的东西"。它不能。skill 的价值是让模型在正确的时候使用正确的流程，真正的动作还是通过工具完成。

## 7. 自己验证

```bash
# 索引生成
sed -n '358,390p' packages/coding-agent/src/core/skills.ts

# 提示词里的 skills 段
sed -n '170,185p' packages/coding-agent/src/core/system-prompt.ts

# 发现逻辑
sed -n '414,470p' packages/coding-agent/src/core/skills.ts

# 看看本机加载了哪些
ls ~/.pi/agent/skills .pi/skills 2>/dev/null
```
