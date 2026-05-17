const state = {
  peers: [],
  selectedPeerId: null,
  selectedFile: null,
  transfers: new Map()
};

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
  saveDirectoryMode: document.getElementById('saveDirectoryMode')
};

window.lanTransfer.getState().then(applyState);

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
