'use strict';

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'docs', 'migration_audit_log.json');
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

const issue6 = {
  id: 'ISSUE-006',
  title: '活跃传输缺少实时暂停、继续与终止控制按钮',
  severity: 'HIGH',
  category: 'TRANSFER_CONTROLS_AND_UX',
  status: 'PENDING_IMPLEMENTATION',
  description: '当前手机端与电脑端的传输卡片中仅展示单向传输进度条与状态文案，缺少用户主动触发的「暂停（Pause）」、「继续（Resume）」与「终止/取消（Cancel/Terminate）」交互按钮，无法对大文件传输或网络波动进行实时人工控制。',
  solution_plan: '1) 电脑端在渲染器 transfer-card 中增加操作按钮行（[暂停] / [继续] / [终止]），联动 v2 transferJob API (pause/resume/cancel) 与 v1 StreamControl 协议；2) 手机端 MainActivity 传输列表项与通知栏中增加控制按钮与回调；3) 完善传输流中断与协议级终止信令。'
};

if (!data.issues) data.issues = [];
if (!data.issues.find(i => i.id === 'ISSUE-006')) {
  data.issues.push(issue6);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('[+] ISSUE-006 added to audit log successfully.');
}
