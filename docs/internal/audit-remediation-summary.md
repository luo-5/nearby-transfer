# Audit Remediation Summary — 2026-08-29

Branch: `fix/audit-remediation`（基于 main，2026-08-29）
Goal 文件：`GOAL-nearby-transfer-安全与发布修复.md`（T0–T11 全部执行）

## 任务卡 → 提交对照

| 任务卡 | 提交 | 主要文件 |
|---|---|---|
| T0 lockfile | `fix: regenerate package-lock.json to include all workspaces` | `package-lock.json`、`package.json`（npm 11 自动写入 allowScripts 批准块） |
| T1 vendor | `fix: vendor @luo-5/core into app bundle to fix packaged-app MODULE_NOT_FOUND` | `scripts/build-vendor.js`（新增）、`src/v2/*` 20 个适配层、根 `package.json` scripts、`.gitignore` |
| T2 CI 矩阵 | `ci: align node matrix with engines>=22 and node:sqlite requirement` | `ci.yml`、`release.yml` |
| T3 签名握手 | `fix(security): require signed handshake for library session tokens` | `src/v2/desktop-library-service.js`、`android .../library/WebDavClient.java`、`MainActivity.java`、`test/desktop-library-service-smoke.js`、`test/multi-round-https-webdav-stress.js` |
| T4 证书固定 | `fix(security): pin desktop webdav certificate on android clients` | `src/v2/cert-manager.js`、`src/v2/trusted-peer-store.js`（迁移 v3）、`src/v2/pairing-session-store.js`、`src/v2/desktop-pairing-api.js`、`android .../library/WebDavPinStore.java`（新增）、`WebDavClient.java`、`MainActivity.java`、`NearbyDocumentsProvider.java`、`test/trusted-peer-store-smoke.js`、`android .../library/WebDavPinStoreTest.java`（新增） |
| T5 权限收紧 | `fix(security): default new paired peers to no permissions` | `trusted-peer-store.js`（默认值 + ON CONFLICT 不再覆盖权限）、`renderer.js`（MINIMUM_PAIRING_PERMISSIONS 置空）、`i18n.js`、`test/trusted-peer-store-smoke.js` |
| T6 共享只读 | `fix(security): make default shared library read-only` | `src/main.js`、`src/v2/desktop-library-api.js`（`writable` 持久化） |
| T7 撤销保护 | `fix(security): require explicit un-revoke before re-pairing a revoked device` | `trusted-peer-store.js`（`TRUSTED_PEER_REVOKED` 守卫）、`renderer.js`（错误文案）、`test/trusted-peer-store-smoke.js` |
| T8 批量小修 | `chore: harden logging, upload accounting, webdav overwrite policy, and repo hygiene` | `main.js`（日志路径、totalSize、欢迎文件）、`desktop-library-service.js`（SSE CORS、COPY/MOVE 覆盖策略）、`CryptoUtil.java`（BC 置顶移除）、`.pyc` 出库 |
| T9 门面整理 | `docs: reorganize working notes, unify package naming, parameterize dev scripts` | 78 个一次性脚本 → `scripts/dev/`（5 个被引用的保留）、11 个根目录过程文档 → `docs/internal/`、`@nearby-transfer/core` → `@luo-5/core`、`packages/core/README.md` 补安装/示例 |
| T10 发布加固 | `ci: publish npm packages with provenance and checksums` | `release.yml`（`--provenance`、`SHA256SUMS.txt`） |
| T11 收尾 | `docs: changelog for audit remediation` | `CHANGELOG.md`（Unreleased 段） |

## 验证证据（本机 Windows，Node v24.19.0 / npm 11.17.0）

- `npm ci`：exit 0（修复前：lockfile 缺 `@luo-5/protocol-spec` / `@luo-5/core@0.1.0`，直接失败）
- `npm test`：exit 0（41 个冒烟脚本全绿，含新增握手安全用例与签名版压力测试）
- `npm run typecheck:core`：exit 0
- 打包冒烟：`npm run dist:windows`（结果见下）
- Android：`gradlew :android-app:testDebugUnitTest` **未能运行** —— 本机无 Android SDK / JDK 环境（AGENTS.md 要求在此记录）。新增的 `WebDavPinStoreTest` 与 Java 改动需要整合方在 CI 或本机执行验证。

## 与 Goal 的偏差（整合方须知）

1. **T4 Android 采用 TOFU 而非配对通道下发指纹**。原方案要求在配对握手中交换 WebDAV 证书指纹，但这会改动 v2 配对 wire format（破坏 AGENTS.md 的跨版本兼容要求，且本机无法做双端联调验证）。实际实现：Android 端首次连接记录桌面证书指纹并持久化（`WebDavPinStore`，按 `host:port` 存储），之后所有连接严格比对、不匹配即拒绝（fail-closed）；桌面端仍按原方案在配对完成时把 `webdavCertFp` 写入 trusted_peers（迁移 v3）并向 UI 公开。**残余风险**：首连即存在的中间人可在 TOFU 阶段固定自己的证书（与 SSH TOFU 同级）；彻底修复需后续在配对 transcript 中携带 `webdavCertFp`（协议扩展，需更新 fixtures）。
2. **T6 的“显式开启上传”落地为**：用户主动选择自定义共享目录 = 可写（持久化 `library_config.json` 的 `writable` 字段）；重置共享目录恢复只读；默认安装只读。
3. **T0 附带**：npm 11 在 `package.json` 写入了 `allowScripts` 批准块（esbuild/electron），属工具自动生成的可复现配置，予以保留。
4. **T9**：`install_and_run_apk.ps1` 在 `docs/migration_audit_log.json`（历史日志）中被提及但仍被移动（仅日志引用，非活引用）；`RELEASE_NOTES_v1.2.0/1.2.1/1.3.0.md` 保留在根目录（版本化发布记录）。

## 遗留问题（需人工决策 / 后续任务）

1. `NearbyDocumentsProvider.getTargetServerIp()` 曾包含硬编码测试地址（**本次审核后新发现**，生产代码中的开发残留）——需要改为发现机制或用户配置。
2. npm trusted publishing（OIDC）需在 npmjs 后台配置；当前仍使用 `NPM_TOKEN` secret。
3. Windows 安装包代码签名（`signAndEditExecutable: false` 维持不变）。
4. 三平台二进制自动归集到 GitHub Release（当前 release 只附 npm tarball 校验和；平台产物仍由 build-* workflow 以 artifact 形式产出）。
5. `docs/threat-model.md`（含 nonce 策略边界、TOFU 残余风险说明）。
6. P3 项：`open-transfer-folder` 路径收窄、Java 端全零共享密钥检查、`safeFilename` 方向控制符过滤、`sas.ts` unused import 清理、homepage/social preview/topics、vitest 统一测试跑器。
7. 提交 `update_audit_*` 等历史脚本已移至 `scripts/dev/`，如确认无用可由维护者自行删除（本 goal 只移动不删除）。

## 对 Codex for OSS 申请的影响

P0-1（无签名领 token）与 P0-2（信任所有证书）修复后，安全叙事成立；发布链路（provenance、校验和、CI 全绿）可作为工程规范证据。建议攒一段真实采用数据后按此前评估的叙事申请。
