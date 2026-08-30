# Nearby Transfer 三台虚拟机全矩阵极限压测与混沌互通测试报告

> 历史、非权威测试记录。机器地址已匿名化；不得使用本文调整当前主机网络或判断当前版本能力。

**测试执行时间：** 2026-08-28T22:10:35.886093 ~ 2026-08-28T22:14:21.919555
**测试状态：** ✅ 100% 全部通过 (ALL PASS)
**总用例数：** 53 | **通过：** 53 | **失败：** 0

---

## 一、 参与测试的虚拟机节点

| 节点 | 操作系统 | IP 地址 | 角色 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| **Ubuntu** | Ubuntu 24.04 (Linux x86_64) | `<test-host-a>` | 发送端 / 接收端 / WebDAV 服务端 | 历史记录 |
| **CentOS** | CentOS Stream 9 (Linux x86_64) | `<test-host-b>` | 发送端 / 接收端 / 压力测试端 | 历史记录 |
| **Windows VM** | Windows 10 (Win32 x86_64) | `<test-host-c>` | 发送端 / 接收端 / Windows 客户端 | 历史记录 |
| **宿主机** | Windows 11 | `<test-controller>` | 自动化调度中心 | 历史记录 |

---

## 二、 各阶段测试结果明细

### Phase 1: Full-Mesh Bidirectional Matrix

| 测试用例 | 状态 | 传输细节 / 指标 |
| :--- | :---: | :--- |
| P1 [CENTOS ➔ UBUNTU] 0B (Empty) | ✅ PASS | 大小: 0 B, 耗时: 0.469s, **速率: 0.0 MB/s** |
| P1 [CENTOS ➔ UBUNTU] 1B (Single Byte) | ✅ PASS | 大小: 1 B, 耗时: 0.286s, **速率: 0.0 MB/s** |
| P1 [CENTOS ➔ UBUNTU] 64KB (Chunk Bound) | ✅ PASS | 大小: 65536 B, 耗时: 0.296s, **速率: 0.21 MB/s** |
| P1 [CENTOS ➔ UBUNTU] 256KB (Multi Chunk) | ✅ PASS | 大小: 262144 B, 耗时: 0.337s, **速率: 0.74 MB/s** |
| P1 [CENTOS ➔ UBUNTU] 10MB (Medium) | ✅ PASS | 大小: 10485760 B, 耗时: 0.566s, **速率: 17.68 MB/s** |
| P1 [CENTOS ➔ UBUNTU] 50MB (Large) | ✅ PASS | 大小: 52428800 B, 耗时: 1.557s, **速率: 32.12 MB/s** |
| P1 [UBUNTU ➔ CENTOS] 0B (Empty) | ✅ PASS | 大小: 0 B, 耗时: 0.322s, **速率: 0.0 MB/s** |
| P1 [UBUNTU ➔ CENTOS] 1B (Single Byte) | ✅ PASS | 大小: 1 B, 耗时: 0.26s, **速率: 0.0 MB/s** |
| P1 [UBUNTU ➔ CENTOS] 64KB (Chunk Bound) | ✅ PASS | 大小: 65536 B, 耗时: 0.291s, **速率: 0.22 MB/s** |
| P1 [UBUNTU ➔ CENTOS] 256KB (Multi Chunk) | ✅ PASS | 大小: 262144 B, 耗时: 0.292s, **速率: 0.86 MB/s** |
| P1 [UBUNTU ➔ CENTOS] 10MB (Medium) | ✅ PASS | 大小: 10485760 B, 耗时: 0.587s, **速率: 17.05 MB/s** |
| P1 [UBUNTU ➔ CENTOS] 50MB (Large) | ✅ PASS | 大小: 52428800 B, 耗时: 1.774s, **速率: 28.19 MB/s** |
| P1 [WINVM ➔ UBUNTU] 0B (Empty) | ✅ PASS | 大小: 0 B, 耗时: 1.18s, **速率: 0.0 MB/s** |
| P1 [WINVM ➔ UBUNTU] 1B (Single Byte) | ✅ PASS | 大小: 1 B, 耗时: 0.549s, **速率: 0.0 MB/s** |
| P1 [WINVM ➔ UBUNTU] 64KB (Chunk Bound) | ✅ PASS | 大小: 65536 B, 耗时: 0.467s, **速率: 0.13 MB/s** |
| P1 [WINVM ➔ UBUNTU] 256KB (Multi Chunk) | ✅ PASS | 大小: 262144 B, 耗时: 0.415s, **速率: 0.6 MB/s** |
| P1 [WINVM ➔ UBUNTU] 10MB (Medium) | ✅ PASS | 大小: 10485760 B, 耗时: 4.111s, **速率: 2.43 MB/s** |
| P1 [WINVM ➔ UBUNTU] 50MB (Large) | ✅ PASS | 大小: 52428800 B, 耗时: 2.252s, **速率: 22.2 MB/s** |
| P1 [UBUNTU ➔ WINVM] 0B (Empty) | ✅ PASS | 大小: 0 B, 耗时: 0.374s, **速率: 0.0 MB/s** |
| P1 [UBUNTU ➔ WINVM] 1B (Single Byte) | ✅ PASS | 大小: 1 B, 耗时: 0.287s, **速率: 0.0 MB/s** |
| P1 [UBUNTU ➔ WINVM] 64KB (Chunk Bound) | ✅ PASS | 大小: 65536 B, 耗时: 0.31s, **速率: 0.2 MB/s** |
| P1 [UBUNTU ➔ WINVM] 256KB (Multi Chunk) | ✅ PASS | 大小: 262144 B, 耗时: 0.315s, **速率: 0.79 MB/s** |
| P1 [UBUNTU ➔ WINVM] 10MB (Medium) | ✅ PASS | 大小: 10485760 B, 耗时: 0.792s, **速率: 12.62 MB/s** |
| P1 [UBUNTU ➔ WINVM] 50MB (Large) | ✅ PASS | 大小: 52428800 B, 耗时: 2.378s, **速率: 21.02 MB/s** |
| P1 [WINVM ➔ CENTOS] 0B (Empty) | ✅ PASS | 大小: 0 B, 耗时: 0.374s, **速率: 0.0 MB/s** |
| P1 [WINVM ➔ CENTOS] 1B (Single Byte) | ✅ PASS | 大小: 1 B, 耗时: 0.43s, **速率: 0.0 MB/s** |
| P1 [WINVM ➔ CENTOS] 64KB (Chunk Bound) | ✅ PASS | 大小: 65536 B, 耗时: 0.382s, **速率: 0.16 MB/s** |
| P1 [WINVM ➔ CENTOS] 256KB (Multi Chunk) | ✅ PASS | 大小: 262144 B, 耗时: 0.381s, **速率: 0.66 MB/s** |
| P1 [WINVM ➔ CENTOS] 10MB (Medium) | ✅ PASS | 大小: 10485760 B, 耗时: 0.75s, **速率: 13.33 MB/s** |
| P1 [WINVM ➔ CENTOS] 50MB (Large) | ✅ PASS | 大小: 52428800 B, 耗时: 2.014s, **速率: 24.83 MB/s** |
| P1 [CENTOS ➔ WINVM] 0B (Empty) | ✅ PASS | 大小: 0 B, 耗时: 0.294s, **速率: 0.0 MB/s** |
| P1 [CENTOS ➔ WINVM] 1B (Single Byte) | ✅ PASS | 大小: 1 B, 耗时: 0.321s, **速率: 0.0 MB/s** |
| P1 [CENTOS ➔ WINVM] 64KB (Chunk Bound) | ✅ PASS | 大小: 65536 B, 耗时: 0.311s, **速率: 0.2 MB/s** |
| P1 [CENTOS ➔ WINVM] 256KB (Multi Chunk) | ✅ PASS | 大小: 262144 B, 耗时: 0.329s, **速率: 0.76 MB/s** |
| P1 [CENTOS ➔ WINVM] 10MB (Medium) | ✅ PASS | 大小: 10485760 B, 耗时: 0.741s, **速率: 13.5 MB/s** |
| P1 [CENTOS ➔ WINVM] 50MB (Large) | ✅ PASS | 大小: 52428800 B, 耗时: 2.424s, **速率: 20.63 MB/s** |

### Phase 2: Filesystem Pathology & Stress

| 测试用例 | 状态 | 传输细节 / 指标 |
| :--- | :---: | :--- |
| P2 [UBUNTU ➔ CENTOS] 20-Level Deep Nested Directory Hierarchy | ✅ PASS | 大小: 4367 B, 耗时: 0.436s, **速率: 0.01 MB/s** |
| P2 [UBUNTU ➔ CENTOS] Pathological CJK / GB18030 / Emoji / Special Chars | ✅ PASS | 大小: 61441 B, 耗时: 0.325s, **速率: 0.18 MB/s** |
| P2 [UBUNTU ➔ CENTOS] 200 File Batch Flood | ✅ PASS | 大小: 53500 B, 耗时: 1.785s, **速率: 0.03 MB/s** |
| P2 [CENTOS ➔ WINVM] 20-Level Deep Nested Directory Hierarchy | ✅ PASS | 大小: 4367 B, 耗时: 0.574s, **速率: 0.01 MB/s** |
| P2 [CENTOS ➔ WINVM] Pathological CJK / GB18030 / Emoji / Special Chars | ✅ PASS | 大小: 61441 B, 耗时: 0.406s, **速率: 0.14 MB/s** |
| P2 [CENTOS ➔ WINVM] 200 File Batch Flood | ✅ PASS | 大小: 53608 B, 耗时: 4.073s, **速率: 0.01 MB/s** |
| P2 [WINVM ➔ UBUNTU] 20-Level Deep Nested Directory Hierarchy | ✅ PASS | 大小: 4367 B, 耗时: 0.568s, **速率: 0.01 MB/s** |
| P2 [WINVM ➔ UBUNTU] Pathological CJK / GB18030 / Emoji / Special Chars | ✅ PASS | 大小: 61441 B, 耗时: 0.425s, **速率: 0.14 MB/s** |
| P2 [WINVM ➔ UBUNTU] 200 File Batch Flood | ✅ PASS | 大小: 53158 B, 耗时: 3.672s, **速率: 0.01 MB/s** |

### Phase 3: Flow Control & Cancellation

| 测试用例 | 状态 | 传输细节 / 指标 |
| :--- | :---: | :--- |
| P3 [CENTOS ➔ UBUNTU] Rapid Pause/Resume Oscillation (20 pulses @ 50ms) | ✅ PASS | 大小: 10485760 B, 耗时: 0.829s, **速率: 12.06 MB/s** |
| P3 [UBUNTU ➔ WINVM] Cancel Flow at 99% Completion | ✅ PASS | 状态机正常取消，零挂起句柄 |

### Phase 4: Protocol Security & Fuzzing

| 测试用例 | 状态 | 传输细节 / 指标 |
| :--- | :---: | :--- |
| P4 [CENTOS ➔ UBUNTU] Corrupted Bit-Flip Ciphertext Rejection | ✅ PASS | 安全鉴权严格拦截，零脏数据写入 |
| P4 [WINVM ➔ CENTOS] Forged Signature Wire Frame Rejection | ✅ PASS | 安全鉴权严格拦截，零脏数据写入 |
| P4 [CENTOS ➔ UBUNTU] Expired Replay Timestamp (>30s) Rejection | ✅ PASS | 安全鉴权严格拦截，零脏数据写入 |

### Phase 5: WebDAV & Tools Interoperability

| 测试用例 | 状态 | 传输细节 / 指标 |
| :--- | :---: | :--- |
| P5 [UBUNTU] WebDAV HTTPS Full CRUD & Security Defense Suite (36/36 Assertions) | ✅ PASS | {'output': 'me returns 207\n  [PASS] GET Chinese filename content matches\n  [PA |
| P5 [CENTOS] Multi-Round HTTPS WebDAV 10-Parallel Upload Stress & Concurrency | ✅ PASS | {'output': 'rd, 403 read-only) verified!\n\n--- ROUND 5: Real-time SSE Sync Noti |
| P5 [UBUNTU] 7-Protocol Engine Driver Matrix & Hot Switch Verification | ✅ PASS | {'output': 'ranslations and categories verified in i18n dictionary!\n[PASS] 2. C |

---

## 三、 结论与后续步骤

1. **虚拟机全网格互联**：全部 6 组双向跨操作系统传输矩阵（Linux ⇄ Linux、Linux ⇄ Windows VM）在 0B、1B、64KB、256KB、10MB、50MB 全阶梯尺寸下 **100% 通过 SHA-256 一致性校验**，零数据损坏。
2. **病理路径与海量文件**：20 层深层嵌套目录、生僻字 (GB18030)、复合 Emoji、特殊符号及 200+ 文件批量传输 **100% 成功接收**。
3. **高频流控与安全防攻击**：20 次脉冲 Pause/Resume 震荡零死锁，比特翻转与过期重放攻击 100% 鉴权拦截。
4. **主流工具生态**：WebDAV HTTPS 36 项 CRUD 断言与 10 并发压力测试、7 协议矩阵切换全绿通过。
5. **Android 移动端联调提示**：三台虚拟机所有极限测试已全部圆满完成！请用户通过 USB 调试将两台 Android 手机接入电脑，以开启 Android 端跨平台联调！
