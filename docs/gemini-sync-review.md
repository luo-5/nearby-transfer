# P3 同步实现代码审查报告 (F2)

> **历史分析 / 非权威资料：** 本文件保留早期审查思路，可能包含未复现的
> 假设、旧版本基线或过时结论。当前能力以 docs/capabilities.md、现行规范
> 和可重复运行的测试为准；其中的数值或完成度不得作为发布承诺。

**审查目标：** 文件夹增量同步与断点续传模块审查  
**涉及文件：**
* `packages/core/src/transfer/sync-state.ts`
* `packages/core/src/transfer/resume-store.ts`
* `packages/core/src/transfer/conflict-resolver.ts`
* `packages/cli/src/commands/sync.ts`

---

## 1. 核心审查发现与问题清单

| 模块 | 问题类别 | 严重级别 | 缺陷描述 |
| :--- | :--- | :--- | :--- |
| **`cli/commands/sync.ts`** | **内存溢出 (OOM)** | **Critical** | `computeFileHash` 使用 `readFile(filePath)` 一次性将全文件读入 Buffer。遇到大文件（$>2\text{GB}$）会直接触发 Node.js `ERR_FS_FILE_TOO_LARGE` 异常崩溃 |
| **`transfer/sync-state.ts`** | **增量漏判风险** | **High** | `planIncrementalSync` 仅检查文件大小与前 1 MiB `quickHash`。若大文件（如 SQLite 数据库、大镜像）在 1 MiB 之后发生同大小原地修改，增量检测将误判为 `unchanged` |
| **`transfer/sync-state.ts`** | **元数据缺失** | **Medium** | `buildSyncState` 中 `mtimeMs` 被硬编码填充为 `0`，未从 `fs.stat` 提取真实修改时间戳 |
| **`transfer/resume-store.ts`** | **文件写入原子性** | **Medium** | `saveResumeState` 直接同步覆盖写入 JSON。进程异常退出或断电可能留下半写入的损坏 JSON 文件 |
| **`transfer/conflict-resolver.ts`**| **TOCTOU 竞态条件** | **Low** | `existsSync` 检查与后续文件创建存在时序竞争，且命名格式（`.new1.ext`）与接收规划器（` (1).ext`）不一致 |

---

## 2. 逐模块深度审查

### 2.1 `packages/cli/src/commands/sync.ts`

#### 缺陷 1：全量大文件读取导致的内存暴涨
```typescript
// sync.ts Line 51-54
async function computeFileHash(filePath: string): Promise<string> {
  const data = await readFile(filePath); // ❌ 危险：一次性分配全部内存
  return createHash('sha256').update(data).digest('hex');
}
```
* **分析**：Node.js V8 堆内存默认上限为 2~4 GB。使用 `readFile` 读取 1 GB 以上文件会造成瞬间 GC 压力，读取 4 GB 以上文件则直接抛出 `RangeError: File size is greater than possible Buffer: 0x7fffffff bytes`。
* **修复建议**：采用流式哈希计算（复用 `sync-state.ts` 中的 `computeFullHash`）：
  ```typescript
  async function computeFileHash(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }
  ```

#### 缺陷 2：大目录递归扫描
`scanDirectory` 采用同步递归遍历 `readdirSync`。对于 10,000 级小文件，内存占用约 15~30 MB，尚在安全可控范围内；但在万级以上深层目录中，同步 IO 会短时间阻塞主事件循环。建议后续演进为异步生成器（Async Generator）。

---

### 2.2 `packages/core/src/transfer/sync-state.ts`

#### 缺陷 1：1 MiB Quick Hash 的漏判边界
```typescript
// sync-state.ts Line 57-69
for (const file of files) {
  const prev = lastState.files.get(file.relativePath);
  if (!prev || prev.size !== file.size) {
    toSend.push(file);
    continue;
  }
  const quick = await computeQuickHash(file.absolutePath);
  if (quick !== prev.quickHash) {
    toSend.push(file);
  } else {
    unchanged.push(file.relativePath); // ⚠️ 潜在漏判！
  }
}
```
* **漏判场景分析**：
  * 假设用户同步了一个 100 MB 的虚拟磁盘镜像或 SQLite 数据库。
  * 用户在数据库后半部分更新了一条记录，但文件总体大小未变，头部 1 MiB 也未变。
  * 此时 `quick === prev.quickHash` 且 `size` 相等，算法会错误地认为该文件无变更，导致关键更新丢失！
* **改进方案**：
  引入 **三层校验阶梯**：
  1. **层级 1**：文件大小 `size` 与修改时间戳 `mtimeMs`（极速判定，无需读取文件内容）；
  2. **层级 2**：头部 1 MiB `quickHash`（快速二次过滤）；
  3. **层级 3**：对于 `mtimeMs` 改变但 `quickHash` 相同的异常情况，回退到 `fullHash` 全量哈希比对。

#### 缺陷 2：`mtimeMs` 遗漏
在 `buildSyncState` 中：
```typescript
fileStates.set(file.relativePath, {
  path: file.relativePath,
  size: file.size,
  mtimeMs: 0, // ❌ 未从文件系统状态读取
  quickHash,
  fullHash,
});
```
* **修复**：传入 `ScanResult` 时应包含 `mtimeMs: stat.mtimeMs`，并在 `buildSyncState` 中持久化记录。

---

### 2.3 `packages/core/src/transfer/resume-store.ts`

#### 缺陷：非原子性持久化写入
```typescript
// resume-store.ts Line 24-28
export function saveResumeState(stateDir: string, state: ResumeState): void {
  mkdirSync(stateDir, { recursive: true });
  const filePath = join(stateDir, `resume-${state.taskId}.json`);
  writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n'); // ⚠️ 非原子写入
}
```
* **风险**：传输过程中每接收/发送一批 chunk 就会调用一次保存。若系统突然掉电或进程被杀，文件可能停留在半写入状态。
* **修复**：通过写入带临时后缀文件后原子替换（`atomic rename`）：
  ```typescript
  export function saveResumeState(stateDir: string, state: ResumeState): void {
    mkdirSync(stateDir, { recursive: true });
    const filePath = join(stateDir, `resume-${state.taskId}.json`);
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    writeFileSync(tempPath, JSON.stringify(state, null, 2) + '\n');
    renameSync(tempPath, filePath);
  }
  ```

---

### 2.4 `packages/core/src/transfer/conflict-resolver.ts`

#### 命名策略一致性
* `conflict-resolver.ts` 采用 `name.new1.ext` 命名；
* 核心接收规划器 `receive-planner.ts` 采用 `name (1).ext` 命名。
* **建议**：将冲突解决策略统一与规范对齐为 `${stem} (${counter})${ext}`，保持跨平台（Windows/macOS/Linux/Android）用户体验的一致性。

---

## 3. 改进行动项总结

1. **立即修复**：将 `sync.ts` 中的 `readFile` 替换为 `createReadStream`，杜绝大文件 OOM。
2. **算法加固**：在 `ScanResult` 中引入 `mtimeMs`，并在 `planIncrementalSync` 中加入时间戳及全哈希回退校验。
3. **安全持久化**：`resume-store.ts` 采用 `atomic write + rename` 模式。
