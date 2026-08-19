const state = {
  peers: [],
  selectedPeerId: null,
  selectedFile: null,
  transfers: new Map()
};

const transferJobState = {
  jobs: [],
  loading: false,
  busyTaskIds: new Set(),
  message: '正在读取可恢复传输任务...',
  messageIsError: false
};

const pairingState = {
  discoveredPeers: [],
  trustedPeers: [],
  sessions: new Map(),
  loading: false,
  refreshVersion: 0,
  startingPeerIds: new Set(),
  busySessionIds: new Set(),
  busyTrustedPeerIds: new Set(),
  message: '正在准备实验性配对服务...',
  messageIsError: false
};

const PAIRING_CAPABILITIES = Object.freeze(['pairing']);
const MINIMUM_PAIRING_PERMISSIONS = Object.freeze({ transfer: true });

const elements = {
  deviceName: document.getElementById('deviceName'),
  saveDirectory: document.getElementById('saveDirectory'),
  peerCount: document.getElementById('peerCount'),
  peers: document.getElementById('peers'),
  transfers: document.getElementById('transfers'),
  refreshButton: document.getElementById('refreshButton'),
  changeSaveDirectoryButton: document.getElementById('changeSaveDirectoryButton'),
  resetSaveDirectoryButton: document.getElementById('resetSaveDirectoryButton'),
  dropZone: document.getElementById('dropZone'),
  selectedFile: document.getElementById('selectedFile'),
  sendButton: document.getElementById('sendButton'),
  statusText: document.getElementById('statusText'),
  saveDirectoryMode: document.getElementById('saveDirectoryMode'),
  v2PairingSummary: document.getElementById('v2PairingSummary'),
  v2PairingStatus: document.getElementById('v2PairingStatus'),
  v2DiscoveredCount: document.getElementById('v2DiscoveredCount'),
  v2DiscoveredPeers: document.getElementById('v2DiscoveredPeers'),
  v2RefreshButton: document.getElementById('v2RefreshButton'),
  v2SessionCount: document.getElementById('v2SessionCount'),
  v2PairingSessions: document.getElementById('v2PairingSessions'),
  v2TrustedCount: document.getElementById('v2TrustedCount'),
  v2TrustedPeers: document.getElementById('v2TrustedPeers'),
  v2TransferJobSummary: document.getElementById('v2TransferJobSummary'),
  v2TransferJobStatus: document.getElementById('v2TransferJobStatus'),
  v2TransferJobs: document.getElementById('v2TransferJobs'),
  v2TransferJobRefresh: document.getElementById('v2TransferJobRefresh')
};

window.lanTransfer.getState().then(applyState);
initializeV2Pairing();
initializeTransferJobs();

window.lanTransfer.onState(applyState);
window.lanTransfer.onPeers((peers) => {
  state.peers = peers;
  keepSelectedPeerOnline();
  renderPeers();
  renderSendState();
});
window.lanTransfer.onTransferEvent((event) => {
  const previous = state.transfers.get(event.transferId) || {};
  state.transfers.set(event.transferId, Object.assign({}, previous, event));
  renderTransfers();
});

elements.refreshButton.addEventListener('click', async () => {
  const peers = await window.lanTransfer.refreshPeers();
  state.peers = peers;
  keepSelectedPeerOnline();
  renderPeers();
  renderSendState();
});

elements.changeSaveDirectoryButton.addEventListener('click', async () => {
  const result = await window.lanTransfer.chooseSaveDirectory();
  if (!result || result.cancelled) {
    return;
  }
  if (!result.ok) {
    setStatus(result.error || '无法更改保存位置。');
    return;
  }
  elements.saveDirectory.textContent = result.saveDirectory || '-';
  elements.saveDirectoryMode.textContent = result.saveDirectoryMode || '-';
  setStatus('保存位置已更新。');
});

elements.resetSaveDirectoryButton.addEventListener('click', async () => {
  const result = await window.lanTransfer.resetSaveDirectory();
  if (!result || result.cancelled) {
    return;
  }
  if (!result.ok) {
    setStatus(result.error || '无法恢复默认下载目录。');
    return;
  }
  elements.saveDirectory.textContent = result.saveDirectory || '-';
  elements.saveDirectoryMode.textContent = result.saveDirectoryMode || '-';
  setStatus('已恢复默认下载目录。');
});

elements.dropZone.addEventListener('click', chooseFile);
elements.dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    chooseFile();
  }
});
elements.sendButton.addEventListener('click', sendSelectedFile);

for (const eventName of ['dragenter', 'dragover']) {
  document.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    elements.dropZone.classList.add('dragging');
  });
}

for (const eventName of ['dragleave', 'drop']) {
  document.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (eventName === 'drop' || event.target === document.documentElement || event.target === document.body) {
      elements.dropZone.classList.remove('dragging');
    }
  });
}

document.addEventListener('drop', async (event) => {
  const files = Array.from(event.dataTransfer.files || []);
  if (files.length === 0) {
    setStatus('请从文件管理器拖入一个文件。');
    return;
  }
  if (files.length > 1) {
    setStatus('一次只能发送一个文件。');
    return;
  }

  const result = await window.lanTransfer.selectDroppedFile(files[0]);
  applySelectedFile(result);
});

async function chooseFile() {
  const result = await window.lanTransfer.chooseFile();
  applySelectedFile(result);
}

function applySelectedFile(result) {
  if (!result || result.cancelled) {
    return;
  }
  if (!result.ok) {
    setStatus(result.error || '无法使用这个文件。');
    return;
  }

  state.selectedFile = result.file;
  renderSendState();
}

async function sendSelectedFile() {
  if (!state.selectedFile) {
    setStatus('请先选择文件。');
    return;
  }
  if (!state.selectedPeerId) {
    setStatus('请先选择附近设备。');
    return;
  }

  elements.sendButton.disabled = true;
  setStatus('正在等待对方确认接收...');
  let finalStatus = null;
  try {
    const result = await window.lanTransfer.sendSelectedFileToPeer(state.selectedPeerId);
    if (result && result.ok) {
      finalStatus = '发送完成。';
      return;
    }
    finalStatus = (result && result.error) || '发送失败。';
  } catch (error) {
    finalStatus = `发送失败：${error.message || '操作失败'}`;
  } finally {
    renderSendState();
    if (finalStatus) {
      setStatus(finalStatus);
    }
  }
}

function applyState(nextState) {
  if (!nextState) {
    return;
  }

  if (nextState.device) {
    elements.deviceName.textContent = nextState.device.deviceName;
  }
  elements.saveDirectory.textContent = nextState.saveDirectory || '-';
  elements.saveDirectoryMode.textContent = nextState.saveDirectoryMode || '-';
  state.peers = nextState.peers || [];
  keepSelectedPeerOnline();
  renderPeers();
  renderSendState();
}

function keepSelectedPeerOnline() {
  if (state.selectedPeerId && !state.peers.some((peer) => peer.deviceId === state.selectedPeerId)) {
    state.selectedPeerId = null;
  }
}

function renderPeers() {
  elements.peerCount.textContent = String(state.peers.length);
  if (state.peers.length === 0) {
    elements.peers.className = 'peers empty';
    elements.peers.textContent = '正在局域网内搜索设备...';
    return;
  }

  elements.peers.className = 'peers';
  elements.peers.replaceChildren(...state.peers.map((peer) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = peer.deviceId === state.selectedPeerId ? 'peer-card selected' : 'peer-card';
    button.addEventListener('click', () => {
      state.selectedPeerId = peer.deviceId;
      renderPeers();
      renderSendState();
    });

    const details = document.createElement('span');
    details.className = 'peer-details';

    const name = document.createElement('span');
    name.className = 'peer-name';
    name.textContent = peer.deviceName;

    const meta = document.createElement('span');
    meta.className = 'peer-meta';
    meta.textContent = `${peer.host}:${peer.port} | 指纹 ${peer.fingerprint || '未知'}`;

    const status = document.createElement('span');
    status.className = 'peer-status';
    status.textContent = peer.deviceId === state.selectedPeerId ? '已选择' : '选择';

    details.append(name, meta);
    button.append(details, status);
    return button;
  }));
}

function renderSendState() {
  if (state.selectedFile) {
    elements.selectedFile.className = 'selected-file';
    elements.selectedFile.textContent = `${state.selectedFile.name} (${formatBytes(state.selectedFile.size)})`;
  } else {
    elements.selectedFile.className = 'selected-file empty';
    elements.selectedFile.textContent = '未选择文件。';
  }

  const canSend = Boolean(state.selectedFile && state.selectedPeerId);
  elements.sendButton.disabled = !canSend;

  if (!state.selectedFile && !state.selectedPeerId) {
    setStatus('先选择文件，再选择附近设备。');
  } else if (!state.selectedFile) {
    setStatus('请选择文件，或把文件拖到窗口里。');
  } else if (!state.selectedPeerId) {
    setStatus('请在下方选择附近设备。');
  } else {
    setStatus('已准备好，可以发送。');
  }
}

function renderTransfers() {
  const transfers = Array.from(state.transfers.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  if (transfers.length === 0) {
    elements.transfers.className = 'transfers empty';
    elements.transfers.textContent = '暂无传输记录。';
    return;
  }

  elements.transfers.className = 'transfers';
  elements.transfers.replaceChildren(...transfers.map((transfer) => {
    const card = document.createElement('div');
    card.className = 'transfer-card';

    const details = document.createElement('div');
    const fileName = document.createElement('div');
    fileName.className = transfer.status === 'failed' ? 'transfer-name failed' : 'transfer-name';
    fileName.textContent = transfer.file && transfer.file.name ? transfer.file.name : transfer.transferId;

    const meta = document.createElement('div');
    meta.className = 'transfer-meta';
    meta.textContent = describeTransfer(transfer);

    const progress = document.createElement('div');
    progress.className = 'progress';
    const bar = document.createElement('span');
    bar.style.width = `${progressPercent(transfer)}%`;
    progress.append(bar);

    details.append(fileName, meta, progress);
    card.append(details);
    return card;
  }));
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function describeTransfer(transfer) {
  const direction = transfer.direction === 'send' ? '发送' : transfer.direction === 'receive' ? '接收' : '系统';
  const total = transfer.total || (transfer.file && transfer.file.size) || 0;
  const status = transfer.error ? `${translateStatus(transfer.status)}：${transfer.error}` : translateStatus(transfer.status);
  return `${direction} | ${status} | ${formatBytes(transfer.bytes || 0)} / ${formatBytes(total)}`;
}

function translateStatus(status) {
  const statuses = new Map([
    ['requesting', '等待确认'],
    ['rejected', '已拒绝'],
    ['sending', '发送中'],
    ['receiving', '接收中'],
    ['accepted', '已接受'],
    ['completed', '已完成'],
    ['failed', '失败']
  ]);
  return statuses.get(status) || status || '未知';
}

function progressPercent(transfer) {
  const total = transfer.total || (transfer.file && transfer.file.size) || 0;
  if (!total) {
    return transfer.status === 'completed' ? 100 : 2;
  }
  return Math.max(2, Math.min(100, Math.round(((transfer.bytes || 0) / total) * 100)));
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function getTransferJobApi() {
  const api = window.lanTransfer && window.lanTransfer.transferJobs;
  if (!api || typeof api.list !== 'function' || typeof api.pause !== 'function' ||
      typeof api.resume !== 'function' || typeof api.retry !== 'function' || typeof api.cancel !== 'function') {
    return null;
  }
  return api;
}

function initializeTransferJobs() {
  const api = getTransferJobApi();
  if (!api) {
    setTransferJobMessage('当前版本未提供持久化传输任务。', true);
    renderTransferJobs();
    return;
  }
  elements.v2TransferJobRefresh.addEventListener('click', () => refreshTransferJobs());
  refreshTransferJobs({ silent: true });
}

async function refreshTransferJobs({ silent = false } = {}) {
  const api = getTransferJobApi();
  if (!api || transferJobState.loading) return;
  transferJobState.loading = true;
  if (!silent) setTransferJobMessage('正在刷新传输任务...');
  renderTransferJobs();
  try {
    const jobs = await api.list();
    transferJobState.jobs = (Array.isArray(jobs) ? jobs : [])
      .filter((job) => job && typeof job.taskId === 'string' && typeof job.status === 'string')
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
    setTransferJobMessage(transferJobState.jobs.length > 0 ? '可在此恢复、暂停、重试或取消持久化任务。' : '暂无持久化传输任务。');
  } catch (error) {
    setTransferJobMessage(`读取传输任务失败：${errorMessage(error)}`, true);
  } finally {
    transferJobState.loading = false;
    renderTransferJobs();
  }
}

function renderTransferJobs() {
  const api = getTransferJobApi();
  const jobs = transferJobState.jobs;
  elements.v2TransferJobSummary.textContent = String(jobs.length);
  elements.v2TransferJobStatus.textContent = transferJobState.message;
  elements.v2TransferJobStatus.className = transferJobState.messageIsError ? 'pairing-status failed' : 'pairing-status';
  elements.v2TransferJobRefresh.disabled = !api || transferJobState.loading;
  elements.v2TransferJobRefresh.textContent = transferJobState.loading ? '正在刷新...' : '刷新任务';
  if (jobs.length === 0) {
    elements.v2TransferJobs.className = 'transfers empty';
    elements.v2TransferJobs.textContent = transferJobState.loading ? '正在读取传输任务...' : '暂无持久化传输任务。';
    return;
  }

  elements.v2TransferJobs.className = 'transfers';
  elements.v2TransferJobs.replaceChildren(...jobs.map((job) => {
    const card = document.createElement('article');
    card.className = 'transfer-card transfer-job-card';
    const details = document.createElement('div');
    const title = document.createElement('div');
    title.className = job.status === 'failed' ? 'transfer-name failed' : 'transfer-name';
    const files = job.manifest && Array.isArray(job.manifest.entries) ? job.manifest.entries : [];
    title.textContent = files.length === 1 ? files[0].relativePath : `${files.length || 0} 个文件`;
    const meta = document.createElement('div');
    meta.className = 'transfer-meta';
    const progress = job.progress || {};
    meta.textContent = `${job.direction === 'incoming' ? '接收' : '发送'} | ${translateJobStatus(job.status)} | ${formatBytes(progress.transferredBytes)} / ${formatBytes(progress.totalBytes)}`;
    const diagnostic = document.createElement('div');
    diagnostic.className = 'transfer-diagnostic';
    diagnostic.textContent = job.errorMessage ? `${job.diagnosticCode || 'ERROR'}：${job.errorMessage}` : (job.diagnosticCode ? `诊断：${job.diagnosticCode}` : `设备：${shortDeviceId(job.peerDeviceId)}`);
    const progressTrack = document.createElement('div');
    progressTrack.className = 'progress';
    const bar = document.createElement('span');
    bar.style.width = `${jobProgressPercent(job)}%`;
    progressTrack.append(bar);
    details.append(title, meta, diagnostic, progressTrack);

    const actions = document.createElement('div');
    actions.className = 'transfer-job-actions';
    const busy = transferJobState.busyTaskIds.has(job.taskId);
    for (const action of transferJobActions(job)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = action.kind === 'cancel' ? 'secondary pairing-button pairing-cancel' : 'secondary pairing-button';
      button.disabled = !api || busy;
      button.textContent = busy ? '正在处理...' : action.label;
      button.addEventListener('click', () => runTransferJobAction(job, action.kind));
      actions.append(button);
    }
    card.append(details, actions);
    return card;
  }));
}

function transferJobActions(job) {
  const actions = [];
  if (job.status === 'transferring') actions.push({ kind: 'pause', label: '暂停' });
  if (job.status === 'paused') actions.push({ kind: 'resume', label: '继续' });
  if (job.status === 'failed') actions.push({ kind: 'retry', label: '重试' });
  if (!['completed', 'cancelled'].includes(job.status)) actions.push({ kind: 'cancel', label: '取消任务' });
  return actions;
}

async function runTransferJobAction(job, action) {
  const api = getTransferJobApi();
  if (!api || transferJobState.busyTaskIds.has(job.taskId) || typeof api[action] !== 'function') return;
  transferJobState.busyTaskIds.add(job.taskId);
  setTransferJobMessage('正在更新传输任务...');
  renderTransferJobs();
  try {
    await api[action](job.taskId);
    await refreshTransferJobs({ silent: true });
  } catch (error) {
    setTransferJobMessage(`传输任务操作失败：${errorMessage(error)}`, true);
  } finally {
    transferJobState.busyTaskIds.delete(job.taskId);
    renderTransferJobs();
  }
}

function setTransferJobMessage(message, isError = false) {
  transferJobState.message = message;
  transferJobState.messageIsError = isError;
}

function translateJobStatus(status) {
  return ({ queued: '排队中', 'awaiting-approval': '等待接收确认', transferring: '传输中', paused: '已暂停', failed: '失败', completed: '已完成', cancelled: '已取消' })[status] || status;
}

function jobProgressPercent(job) {
  const progress = job.progress || {};
  const total = Number(progress.totalBytes) || 0;
  if (!total) return job.status === 'completed' ? 100 : 2;
  return Math.max(2, Math.min(100, Math.round(((Number(progress.transferredBytes) || 0) / total) * 100)));
}

function shortDeviceId(deviceId) {
  return typeof deviceId === 'string' && deviceId.length > 12 ? `${deviceId.slice(0, 8)}…${deviceId.slice(-4)}` : (deviceId || '未知');
}

function initializeV2Pairing() {
  const pairingApi = getPairingApi();
  if (!pairingApi) {
    setPairingMessage('当前版本未提供 v2 配对服务。', true);
    renderV2Pairing();
    return;
  }

  elements.v2RefreshButton.addEventListener('click', () => {
    refreshV2Pairing({ announce: true });
  });

  if (typeof window.lanTransfer.onV2Peers === 'function') {
    window.lanTransfer.onV2Peers((peers) => {
      pairingState.discoveredPeers = normalizePeers(peers);
      pairingState.loading = false;
      if (!pairingState.messageIsError) {
        setPairingMessage(pairingState.discoveredPeers.length > 0 ? '已更新 v2 设备发现结果。' : '正在局域网内搜索支持 v2 配对的设备。');
      }
      renderV2Pairing();
    });
  }

  if (typeof window.lanTransfer.onV2PairingSession === 'function') {
    window.lanTransfer.onV2PairingSession((session) => {
      if (session && typeof session.pairingId === 'string') {
        pairingState.sessions.set(session.pairingId, session);
      } else {
        // 完成或取消后主进程可能只通知会话列表已变化；以 IPC 列表为准刷新。
        refreshV2Pairing({ silent: true });
      }
      renderV2Pairing();
    });
  }

  refreshV2Pairing({ silent: true });
}

function getPairingApi() {
  const api = window.lanTransfer && window.lanTransfer.pairing;
  if (!api || typeof api.listDiscoveredPeers !== 'function' || typeof api.listTrustedPeers !== 'function' ||
      typeof api.revokeTrustedPeer !== 'function' || typeof api.listSessions !== 'function' || typeof api.start !== 'function' ||
      typeof api.confirm !== 'function' || typeof api.complete !== 'function' || typeof api.cancel !== 'function') {
    return null;
  }
  return api;
}

async function refreshV2Pairing({ announce = false, silent = false } = {}) {
  const pairingApi = getPairingApi();
  if (!pairingApi) return;

  const version = ++pairingState.refreshVersion;
  pairingState.loading = true;
  if (announce) setPairingMessage('正在刷新 v2 配对信息...');
  renderV2Pairing();

  const [peersResult, sessionsResult, trustedResult] = await Promise.allSettled([
    pairingApi.listDiscoveredPeers(),
    pairingApi.listSessions(),
    pairingApi.listTrustedPeers()
  ]);

  if (version !== pairingState.refreshVersion) return;
  pairingState.loading = false;
  const errors = [];

  if (peersResult.status === 'fulfilled') pairingState.discoveredPeers = normalizePeers(peersResult.value);
  else errors.push(`发现设备：${errorMessage(peersResult.reason)}`);

  if (sessionsResult.status === 'fulfilled') replacePairingSessions(sessionsResult.value);
  else errors.push(`读取配对会话：${errorMessage(sessionsResult.reason)}`);

  if (trustedResult.status === 'fulfilled') pairingState.trustedPeers = normalizeTrustedPeers(trustedResult.value);
  else errors.push(`读取受信设备：${errorMessage(trustedResult.reason)}`);

  if (errors.length > 0) {
    setPairingMessage(errors.join('；'), true);
  } else if (!silent || !pairingState.messageIsError) {
    setPairingMessage(pairingState.discoveredPeers.length > 0 ? 'v2 配对设备列表已更新。' : '正在局域网内搜索支持 v2 配对的设备。');
  }
  renderV2Pairing();
}

function replacePairingSessions(sessions) {
  pairingState.sessions = new Map(normalizeSessions(sessions).map((session) => [session.pairingId, session]));
}

function normalizePeers(peers) {
  const uniquePeers = new Map();
  for (const peer of Array.isArray(peers) ? peers : []) {
    if (!peer || typeof peer.deviceId !== 'string' || typeof peer.deviceName !== 'string') continue;
    uniquePeers.set(peer.deviceId, peer);
  }
  return Array.from(uniquePeers.values()).sort(compareByName);
}

function normalizeSessions(sessions) {
  const uniqueSessions = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || typeof session.pairingId !== 'string' || typeof session.status !== 'string') continue;
    uniqueSessions.set(session.pairingId, session);
  }
  return Array.from(uniqueSessions.values()).sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
}

function normalizeTrustedPeers(peers) {
  const uniquePeers = new Map();
  for (const peer of Array.isArray(peers) ? peers : []) {
    if (!peer || typeof peer.deviceId !== 'string') continue;
    uniquePeers.set(peer.deviceId, peer);
  }
  return Array.from(uniquePeers.values()).sort(compareByName);
}

function compareByName(left, right) {
  return peerLabel(left).localeCompare(peerLabel(right), 'zh-CN');
}

function renderV2Pairing() {
  const pairingApi = getPairingApi();
  elements.v2RefreshButton.disabled = !pairingApi || pairingState.loading;
  elements.v2RefreshButton.textContent = pairingState.loading ? '正在刷新...' : '刷新 v2 设备';
  elements.v2PairingStatus.textContent = pairingState.message;
  elements.v2PairingStatus.className = pairingState.messageIsError ? 'pairing-status failed' : 'pairing-status';
  elements.v2PairingSummary.textContent = pairingApi ? `${pairingState.sessions.size} 个会话` : '不可用';
  renderV2DiscoveredPeers(pairingApi);
  renderV2PairingSessions(pairingApi);
  renderV2TrustedPeers();
}

function renderV2DiscoveredPeers(pairingApi) {
  const peers = pairingState.discoveredPeers;
  elements.v2DiscoveredCount.textContent = String(peers.length);
  if (peers.length === 0) {
    elements.v2DiscoveredPeers.className = 'pairing-list empty';
    elements.v2DiscoveredPeers.textContent = pairingState.loading ? '正在刷新 v2 设备...' : '未发现可配对的 v2 设备。';
    return;
  }

  elements.v2DiscoveredPeers.className = 'pairing-list';
  elements.v2DiscoveredPeers.replaceChildren(...peers.map((peer) => {
    const card = document.createElement('article');
    card.className = 'pairing-card';

    const details = document.createElement('div');
    details.className = 'pairing-details';
    const name = document.createElement('strong');
    name.className = 'pairing-name';
    name.textContent = peerLabel(peer);
    const fingerprint = document.createElement('span');
    fingerprint.className = 'pairing-meta';
    fingerprint.textContent = `设备指纹：${shortFingerprint(peer.fingerprint)}`;
    const discovery = document.createElement('span');
    discovery.className = 'pairing-meta';
    discovery.textContent = formatLastSeen(peer.lastSeen);
    details.append(name, fingerprint, discovery);

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'primary pairing-button';
    const isStarting = pairingState.startingPeerIds.has(peer.deviceId);
    action.disabled = !pairingApi || isStarting;
    action.textContent = isStarting ? '正在开始...' : '开始配对';
    action.addEventListener('click', () => startV2Pairing(peer));

    card.append(details, action);
    return card;
  }));
}

function renderV2PairingSessions(pairingApi) {
  const sessions = Array.from(pairingState.sessions.values()).sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
  elements.v2SessionCount.textContent = String(sessions.length);
  if (sessions.length === 0) {
    elements.v2PairingSessions.className = 'pairing-list empty';
    elements.v2PairingSessions.textContent = '暂无进行中的配对。';
    return;
  }

  elements.v2PairingSessions.className = 'pairing-list';
  elements.v2PairingSessions.replaceChildren(...sessions.map((session) => createPairingSessionCard(session, pairingApi)));
}

function createPairingSessionCard(session, pairingApi) {
  const card = document.createElement('article');
  card.className = 'pairing-card pairing-session-card';

  const details = document.createElement('div');
  details.className = 'pairing-details';
  const name = document.createElement('strong');
  name.className = 'pairing-name';
  name.textContent = session.peer ? peerLabel(session.peer) : '正在等待对方设备信息';
  const status = document.createElement('span');
  status.className = 'pairing-meta';
  status.textContent = `状态：${translatePairingStatus(session.status)}`;
  details.append(name, status);

  if (session.peer && session.peer.fingerprint) {
    const fingerprint = document.createElement('span');
    fingerprint.className = 'pairing-meta';
    fingerprint.textContent = `设备指纹：${shortFingerprint(session.peer.fingerprint)}`;
    details.append(fingerprint);
  }

  if (typeof session.pairingCode === 'string' && session.pairingCode.length > 0) {
    const sasLabel = document.createElement('span');
    sasLabel.className = 'pairing-sas-label';
    sasLabel.textContent = '请双方核对以下安全码（SAS）';
    const sas = document.createElement('output');
    sas.className = 'pairing-sas';
    sas.textContent = session.pairingCode;
    details.append(sasLabel, sas);
  } else {
    const pending = document.createElement('span');
    pending.className = 'pairing-meta';
    pending.textContent = '等待获取双方可核对的安全码...';
    details.append(pending);
  }

  const expires = formatExpiration(session.expiresAt);
  if (expires) {
    const expiration = document.createElement('span');
    expiration.className = 'pairing-meta';
    expiration.textContent = expires;
    details.append(expiration);
  }

  const actions = document.createElement('div');
  actions.className = 'pairing-button-row';
  const isBusy = pairingState.busySessionIds.has(session.pairingId);

  if (session.status === 'awaiting-local-confirmation') {
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'primary pairing-button';
    confirm.disabled = !pairingApi || isBusy || !session.pairingCode;
    confirm.textContent = isBusy ? '正在确认...' : '安全码一致，确认';
    confirm.addEventListener('click', () => confirmV2Pairing(session));
    actions.append(confirm);
  }

  if (session.status === 'ready-to-trust') {
    const complete = document.createElement('button');
    complete.type = 'button';
    complete.className = 'primary pairing-button';
    complete.disabled = !pairingApi || isBusy;
    complete.textContent = isBusy ? '正在信任...' : '完成信任';
    complete.addEventListener('click', () => completeV2Pairing(session));
    actions.append(complete);
  }

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary pairing-button pairing-cancel';
  cancel.disabled = !pairingApi || isBusy;
  cancel.textContent = isBusy ? '正在处理...' : '取消';
  cancel.addEventListener('click', () => cancelV2Pairing(session));
  actions.append(cancel);

  card.append(details, actions);
  return card;
}

function renderV2TrustedPeers() {
  const pairingApi = getPairingApi();
  const peers = pairingState.trustedPeers;
  elements.v2TrustedCount.textContent = String(peers.length);
  if (peers.length === 0) {
    elements.v2TrustedPeers.className = 'pairing-list empty';
    elements.v2TrustedPeers.textContent = '暂无受信设备。';
    return;
  }

  elements.v2TrustedPeers.className = 'pairing-list';
  elements.v2TrustedPeers.replaceChildren(...peers.map((peer) => {
    const card = document.createElement('article');
    card.className = 'pairing-card trusted-peer-card';
    const details = document.createElement('div');
    details.className = 'pairing-details';
    const name = document.createElement('strong');
    name.className = 'pairing-name';
    name.textContent = peer.displayName || peerLabel(peer);
    const device = document.createElement('span');
    device.className = 'pairing-meta';
    device.textContent = `设备：${peerLabel(peer)}`;
    const fingerprint = document.createElement('span');
    fingerprint.className = 'pairing-meta';
    fingerprint.textContent = `设备指纹：${shortFingerprint(peer.fingerprint)}`;
    const permissions = document.createElement('span');
    permissions.className = 'pairing-permissions';
    permissions.textContent = describePairingPermissions(peer.permissions);
    const lastSeen = document.createElement('span');
    lastSeen.className = 'pairing-meta';
    lastSeen.textContent = `最近活动：${formatLastSeen(peer.lastSeen)}`;
    details.append(name, device, fingerprint, permissions, lastSeen);

    const actions = document.createElement('div');
    actions.className = 'pairing-button-row';
    const revoke = document.createElement('button');
    const isBusy = pairingState.busyTrustedPeerIds.has(peer.deviceId);
    revoke.type = 'button';
    revoke.className = 'secondary pairing-button pairing-cancel';
    revoke.disabled = !pairingApi || isBusy;
    revoke.textContent = isBusy ? '正在撤销...' : '撤销信任';
    revoke.addEventListener('click', () => revokeV2TrustedPeer(peer));
    actions.append(revoke);
    card.append(details, actions);
    return card;
  }));
}

async function revokeV2TrustedPeer(peer) {
  const pairingApi = getPairingApi();
  if (!pairingApi || pairingState.busyTrustedPeerIds.has(peer.deviceId)) return;

  pairingState.busyTrustedPeerIds.add(peer.deviceId);
  setPairingMessage(`正在撤销“${peer.displayName || peerLabel(peer)}”的信任...`);
  renderV2Pairing();
  try {
    const revoked = await pairingApi.revokeTrustedPeer(peer.deviceId);
    if (!revoked) throw new Error('该设备已不在受信列表中');
    pairingState.trustedPeers = pairingState.trustedPeers.filter((candidate) => candidate.deviceId !== peer.deviceId);
    setPairingMessage('已撤销设备信任；后续传输前需要重新配对。');
    await refreshV2Pairing({ silent: true });
  } catch (error) {
    setPairingMessage(`撤销信任失败：${errorMessage(error)}`, true);
  } finally {
    pairingState.busyTrustedPeerIds.delete(peer.deviceId);
    renderV2Pairing();
  }
}

async function startV2Pairing(peer) {
  const pairingApi = getPairingApi();
  if (!pairingApi || pairingState.startingPeerIds.has(peer.deviceId)) return;

  pairingState.startingPeerIds.add(peer.deviceId);
  setPairingMessage(`正在向“${peerLabel(peer)}”发起配对...`);
  renderV2Pairing();
  try {
    const session = await pairingApi.start({ peerDeviceId: peer.deviceId, capabilities: PAIRING_CAPABILITIES.slice() });
    if (session && typeof session.pairingId === 'string') pairingState.sessions.set(session.pairingId, session);
    setPairingMessage(`已发起与“${peerLabel(peer)}”的配对，等待双方安全码。`);
    await refreshV2Pairing({ silent: true });
  } catch (error) {
    setPairingMessage(`无法开始配对：${errorMessage(error)}`, true);
  } finally {
    pairingState.startingPeerIds.delete(peer.deviceId);
    renderV2Pairing();
  }
}

async function confirmV2Pairing(session) {
  await runV2SessionAction(session, '正在确认双方安全码...', async (pairingApi) => {
    await pairingApi.confirm(session.pairingId);
    setPairingMessage('本机已确认安全码，正在等待或同步对方确认。');
  });
}

async function completeV2Pairing(session) {
  await runV2SessionAction(session, '正在将设备加入受信列表...', async (pairingApi) => {
    const displayName = session.peer && typeof session.peer.deviceName === 'string' ? session.peer.deviceName : undefined;
    const trustedPeer = await pairingApi.complete({
      pairingId: session.pairingId,
      displayName,
      permissions: Object.assign({}, MINIMUM_PAIRING_PERMISSIONS)
    });
    if (trustedPeer && typeof trustedPeer.deviceId === 'string') {
      pairingState.trustedPeers = normalizeTrustedPeers([trustedPeer, ...pairingState.trustedPeers]);
    }
    pairingState.sessions.delete(session.pairingId);
    setPairingMessage('配对完成：设备已受信任，已授予最小“传输”权限。');
  });
}

async function cancelV2Pairing(session) {
  await runV2SessionAction(session, '正在取消配对...', async (pairingApi) => {
    await pairingApi.cancel(session.pairingId);
    pairingState.sessions.delete(session.pairingId);
    setPairingMessage('已取消配对。');
  });
}

async function runV2SessionAction(session, pendingMessage, action) {
  const pairingApi = getPairingApi();
  if (!pairingApi || pairingState.busySessionIds.has(session.pairingId)) return;

  pairingState.busySessionIds.add(session.pairingId);
  setPairingMessage(pendingMessage);
  renderV2Pairing();
  try {
    await action(pairingApi);
    await refreshV2Pairing({ silent: true });
  } catch (error) {
    setPairingMessage(`配对操作失败：${errorMessage(error)}`, true);
  } finally {
    pairingState.busySessionIds.delete(session.pairingId);
    renderV2Pairing();
  }
}

function setPairingMessage(message, isError = false) {
  pairingState.message = message;
  pairingState.messageIsError = isError;
}

function peerLabel(peer) {
  return peer && typeof peer.deviceName === 'string' && peer.deviceName.trim() ? peer.deviceName.trim() : '未命名设备';
}

function shortFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) return '未知';
  return fingerprint.length > 20 ? `${fingerprint.slice(0, 10)}…${fingerprint.slice(-8)}` : fingerprint;
}

function describePairingPermissions(permissions) {
  const granted = [];
  if (permissions && permissions.transfer) granted.push('传输');
  if (permissions && permissions.libraryRead) granted.push('读取媒体库');
  if (permissions && permissions.libraryUpload) granted.push('写入媒体库');
  return granted.length > 0 ? `已授权：${granted.join('、')}` : '未授予可用权限';
}

function formatLastSeen(lastSeen) {
  const timestamp = Number(lastSeen);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '最近发现';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return '刚刚发现';
  if (seconds < 60) return `${seconds} 秒前发现`;
  return `${Math.floor(seconds / 60)} 分钟前发现`;
}

function formatExpiration(expiresAt) {
  const timestamp = Number(expiresAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const remainingSeconds = Math.ceil((timestamp - Date.now()) / 1000);
  if (remainingSeconds <= 0) return '会话即将过期，请刷新状态。';
  if (remainingSeconds < 60) return `安全码将在约 ${remainingSeconds} 秒后过期`;
  return `安全码将在约 ${Math.ceil(remainingSeconds / 60)} 分钟后过期`;
}

function translatePairingStatus(status) {
  const labels = new Map([
    ['awaiting-remote-offer', '等待对方响应'],
    ['awaiting-local-confirmation', '请核对并确认安全码'],
    ['awaiting-remote-confirmation', '已确认，等待对方确认'],
    ['ready-to-trust', '双方已确认，可完成信任'],
    ['completed', '已完成'],
    ['cancelled', '已取消'],
    ['expired', '已过期']
  ]);
  return labels.get(status) || '处理中';
}

function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message.trim()) return error.message.trim();
  return '未知错误';
}
