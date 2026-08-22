const t = (key, ...args) => (window.i18n ? window.i18n.t(key, ...args) : key);

const SELECTED_PEER_STORAGE_KEY = 'nearby_transfer_selected_peer';

const state = {
  peers: [],
  selectedPeerId: null,
  selectedFile: null,
  transfers: new Map()
};

function loadPersistedSelectedPeerId() {
  try {
    const stored = window.localStorage && window.localStorage.getItem(SELECTED_PEER_STORAGE_KEY);
    if (stored && typeof stored === 'string') {
      state.selectedPeerId = stored;
    }
  } catch (error) {
    // localStorage may be unavailable; fall back to no persisted selection
  }
}

function persistSelectedPeerId(deviceId) {
  try {
    if (deviceId && typeof deviceId === 'string') {
      window.localStorage.setItem(SELECTED_PEER_STORAGE_KEY, deviceId);
    } else {
      window.localStorage.removeItem(SELECTED_PEER_STORAGE_KEY);
    }
  } catch (error) {
    // best-effort persistence; ignore storage failures
  }
}

loadPersistedSelectedPeerId();

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
  autoCompletedPairingIds: new Set(),
  busyTrustedPeerIds: new Set(),
  message: '正在准备实验性配对服务...',
  messageIsError: false
};

const PAIRING_CAPABILITIES = Object.freeze(['pairing']);
const MINIMUM_PAIRING_PERMISSIONS = Object.freeze({ transfer: true });

const elements = {
  langZhBtn: document.getElementById('langZhBtn'),
  langEnBtn: document.getElementById('langEnBtn'),
  deviceName: document.getElementById('deviceName'),
  saveDirectory: document.getElementById('saveDirectory'),
  peerCount: document.getElementById('peerCount'),
  peers: document.getElementById('peers'),
  transfers: document.getElementById('transfers'),
  clearCompletedTransfersButton: document.getElementById('clearCompletedTransfersButton'),
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
  v2TransferJobRefresh: document.getElementById('v2TransferJobRefresh'),
  libraryStatusBadge: document.getElementById('libraryStatusBadge'),
  librarySharePath: document.getElementById('librarySharePath'),
  libraryShareMode: document.getElementById('libraryShareMode'),
  libraryWebDavUrl: document.getElementById('libraryWebDavUrl'),
  currentProtocolBadge: document.getElementById('currentProtocolBadge'),
  changeLibraryPathButton: document.getElementById('changeLibraryPathButton'),
  openLibraryFolderButton: document.getElementById('openLibraryFolderButton'),
  resetLibraryPathButton: document.getElementById('resetLibraryPathButton'),
  copyWebDavUrlButton: document.getElementById('copyWebDavUrlButton')
};

let selectedProtocol = 'v2-stream';
let selectedProtocolCategory = 'all';

function updateProtocolBadge(proto) {
  if (!elements.currentProtocolBadge) return;
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  const labelMap = {
    'v2-stream': isZh ? 'V2 稳定流' : 'V2 Stream',
    'turbo-parallel': isZh ? 'Turbo 极速' : 'Turbo Parallel',
    'quic-udp': isZh ? 'QUIC 弱网' : 'QUIC UDP',
    'smb-share': isZh ? 'SMB 共享' : 'SMB 3.0',
    'webdav-sync': isZh ? 'WebDAV NAS' : 'WebDAV Sync',
    'v1-classic': isZh ? 'V1 轻量' : 'V1 Classic',
    'ftps-secure': isZh ? 'FTPS 安全' : 'FTPS Secure'
  };
  elements.currentProtocolBadge.textContent = labelMap[proto] || proto;
}

function filterProtocolCards(category) {
  selectedProtocolCategory = category;
  const tabBtns = document.querySelectorAll('.proto-tab-btn');
  tabBtns.forEach(btn => {
    if (btn.getAttribute('data-category') === category) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  const cards = document.querySelectorAll('.protocol-card');
  cards.forEach(card => {
    const cardCat = card.getAttribute('data-category');
    if (category === 'all' || cardCat === category) {
      card.classList.remove('hidden');
    } else {
      card.classList.add('hidden');
    }
  });
}

function renderProtocolCards() {
  const cards = document.querySelectorAll('.protocol-card');
  cards.forEach(card => {
    const proto = card.getAttribute('data-protocol');
    const isActive = proto === selectedProtocol;
    if (isActive) {
      card.classList.add('active');
      card.setAttribute('aria-checked', 'true');
    } else {
      card.classList.remove('active');
      card.setAttribute('aria-checked', 'false');
    }
  });
  updateProtocolBadge(selectedProtocol);
}

function initializeProtocolSelector() {
  const tabBtns = document.querySelectorAll('.proto-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.getAttribute('data-category') || 'all';
      filterProtocolCards(cat);
    });
  });

  const cards = document.querySelectorAll('.protocol-card');
  cards.forEach(card => {
    const proto = card.getAttribute('data-protocol');
    const onSelect = async () => {
      selectedProtocol = proto;
      renderProtocolCards();
      if (window.lanTransfer && typeof window.lanTransfer.setProtocol === 'function') {
        try {
          await window.lanTransfer.setProtocol(proto);
        } catch (e) {
          console.error('Failed to set protocol:', e);
        }
      }
    };
    card.addEventListener('click', onSelect);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect();
      }
    });
  });

  if (window.lanTransfer && typeof window.lanTransfer.getProtocol === 'function') {
    window.lanTransfer.getProtocol().then(res => {
      if (res && res.protocol) {
        selectedProtocol = res.protocol;
        renderProtocolCards();
      }
    }).catch(e => {
      console.warn('Failed to get initial protocol:', e);
    });
  }
}

function updateLanguageButtons() {
  if (!window.i18n) return;
  const current = window.i18n.getCurrentLanguage();
  if (elements.langZhBtn) elements.langZhBtn.className = current === 'zh' ? 'lang-btn active' : 'lang-btn';
  if (elements.langEnBtn) elements.langEnBtn.className = current === 'en' ? 'lang-btn active' : 'lang-btn';
}

if (elements.langZhBtn) {
  elements.langZhBtn.addEventListener('click', () => {
    if (window.i18n) {
      window.i18n.setLanguage('zh');
      updateLanguageButtons();
      reRenderAll();
    }
  });
}

if (elements.langEnBtn) {
  elements.langEnBtn.addEventListener('click', () => {
    if (window.i18n) {
      window.i18n.setLanguage('en');
      updateLanguageButtons();
      reRenderAll();
    }
  });
}

function reRenderAll() {
  renderPeers();
  renderSendState();
  renderTransfers();
  refreshLibraryInfo();
  renderV2Pairing();
  renderTransferJobs();
  updateProtocolBadge(selectedProtocol);
}

updateLanguageButtons();
if (window.i18n) window.i18n.applyI18nToDOM();

window.lanTransfer.getState().then(applyState);
initializeProtocolSelector();
initializeV2Pairing();
initializeTransferJobs();
refreshLibraryInfo();

async function refreshLibraryInfo() {
  if (!window.lanTransfer || !window.lanTransfer.library) return;
  try {
    const status = await window.lanTransfer.library.getStatus();
    if (elements.libraryStatusBadge) {
      elements.libraryStatusBadge.textContent = status.running ? `${t('library_ready_badge')} :${status.port}` : t('v2_not_connected');
    }
    if (elements.librarySharePath) {
      elements.librarySharePath.textContent = (status.primaryShare && status.primaryShare.localPath) || '-';
    }
    if (elements.libraryShareMode) {
      elements.libraryShareMode.textContent = status.isDefault ? t('default_save_mode') : t('custom_save_mode');
    }
    if (elements.libraryWebDavUrl) {
      elements.libraryWebDavUrl.textContent = status.webDavUrl || `https://127.0.0.1:${status.port || 56578}/webdav/default-share`;
    }
  } catch (err) {
    console.error('Failed to get library status:', err);
  }
}

if (elements.changeLibraryPathButton) {
  elements.changeLibraryPathButton.addEventListener('click', async () => {
    const res = await window.lanTransfer.library.chooseShareDirectory();
    if (res && res.ok) {
      setStatus(t('change_save_dir') + ' OK');
      refreshLibraryInfo();
    }
  });
}

if (elements.openLibraryFolderButton) {
  elements.openLibraryFolderButton.addEventListener('click', async () => {
    await window.lanTransfer.library.openShareDirectory('default-share');
  });
}

if (elements.resetLibraryPathButton) {
  elements.resetLibraryPathButton.addEventListener('click', async () => {
    const res = await window.lanTransfer.library.resetShareDirectory();
    if (res && res.ok) {
      setStatus(t('reset_save_dir') + ' OK');
      refreshLibraryInfo();
    }
  });
}

if (elements.copyWebDavUrlButton) {
  elements.copyWebDavUrlButton.addEventListener('click', async () => {
    const url = elements.libraryWebDavUrl?.textContent;
    if (url && url !== '-') {
      try {
        await navigator.clipboard.writeText(url);
        setStatus(t('copied'));
      } catch (_e) {
        setStatus(url);
      }
    }
  });
}

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

if (elements.clearCompletedTransfersButton) {
  elements.clearCompletedTransfersButton.addEventListener('click', () => {
    for (const [id, t] of state.transfers.entries()) {
      if (['completed', 'failed', 'cancelled', 'rejected'].includes(t.status)) {
        state.transfers.delete(id);
      }
    }
    renderTransfers();
    setStatus(t('no_transfers'));
  });
}

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
    setStatus(result.error || t('operation_failed'));
    return;
  }
  elements.saveDirectory.textContent = result.saveDirectory || '-';
  elements.saveDirectoryMode.textContent = result.saveDirectoryMode || '-';
  setStatus(t('change_save_dir') + ' OK');
});

elements.resetSaveDirectoryButton.addEventListener('click', async () => {
  const result = await window.lanTransfer.resetSaveDirectory();
  if (!result || result.cancelled) {
    return;
  }
  if (!result.ok) {
    setStatus(result.error || t('operation_failed'));
    return;
  }
  elements.saveDirectory.textContent = result.saveDirectory || '-';
  elements.saveDirectoryMode.textContent = result.saveDirectoryMode || '-';
  setStatus(t('reset_save_dir') + ' OK');
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
    setStatus(t('drag_hint'));
    return;
  }

  let result;
  if (files.length === 1) {
    result = await window.lanTransfer.selectDroppedFile(files[0]);
  } else {
    result = await window.lanTransfer.selectDroppedFiles(files);
  }
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
    setStatus(result.error || t('cannot_use_file'));
    return;
  }

  state.selectedFile = result.file;
  renderSendState();
}

let batchProgressHandler = null;

async function sendSelectedFile() {
  if (!state.selectedFile) {
    setStatus(t('select_file_first'));
    return;
  }
  if (!state.selectedPeerId) {
    setStatus(t('select_peer_first'));
    return;
  }

  elements.sendButton.disabled = true;
  setStatus(t('waiting_peer_confirm'));
  let finalStatus = null;
  
  if (!batchProgressHandler) {
    batchProgressHandler = (event, data) => {
      setStatus(t('batch_sending_format', data.current, data.total, data.name));
    };
    window.lanTransfer.onBatchProgress(batchProgressHandler);
  }

  try {
    const result = await window.lanTransfer.sendSelectedFileToPeer(state.selectedPeerId);
    if (result && result.ok) {
      if (result.total > 1) {
        finalStatus = t('batch_complete_format', result.successCount);
      } else {
        finalStatus = t('send_complete');
      }
      return;
    }
    finalStatus = (result && result.error) || t('send_failed');
  } catch (error) {
    finalStatus = t('send_failed_format', error.message || t('operation_failed'));
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
  // Intentionally do NOT clear selectedPeerId when the peer goes offline.
  // The selection is persisted so it auto-restores when the peer reappears;
  // renderSendState surfaces an "offline" hint while it is gone. Selecting a
  // different peer overwrites the persisted value, which is the graceful
  // fallback when a peer reinstalled its app and got a new deviceId.
}

function selectedPeerIsOffline() {
  return Boolean(state.selectedPeerId) && !state.peers.some((peer) => peer.deviceId === state.selectedPeerId);
}

function renderPeers() {
  elements.peerCount.textContent = String(state.peers.length);
  if (state.peers.length === 0) {
    elements.peers.className = 'peers empty';
    elements.peers.textContent = t('searching_peers');
    return;
  }

  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  elements.peers.className = 'peers';
  elements.peers.replaceChildren(...state.peers.map((peer) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = peer.deviceId === state.selectedPeerId ? 'peer-card selected' : 'peer-card';
    button.addEventListener('click', () => {
      state.selectedPeerId = peer.deviceId;
      persistSelectedPeerId(peer.deviceId);
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
    meta.textContent = `${peer.host}:${peer.port} | ${isZh ? '指纹' : 'Fingerprint'} ${peer.fingerprint || (isZh ? '未知' : 'Unknown')}`;

    const status = document.createElement('span');
    status.className = 'peer-status';
    status.textContent = peer.deviceId === state.selectedPeerId ? (isZh ? '已选择' : 'Selected') : (isZh ? '选择' : 'Select');

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
    elements.selectedFile.textContent = t('no_file_selected');
  }

  const canSend = Boolean(state.selectedFile && state.selectedPeerId && !selectedPeerIsOffline());
  elements.sendButton.disabled = !canSend;

  if (!state.selectedPeerId) {
    setStatus(t('select_peer_first'));
  } else if (selectedPeerIsOffline()) {
    setStatus(t('selected_peer_offline'));
  } else if (!state.selectedFile) {
    setStatus(t('select_file_first'));
  } else {
    setStatus(t('send_button') + ' Ready');
  }
}

function renderTransfers() {
  const transfers = Array.from(state.transfers.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  if (transfers.length === 0) {
    elements.transfers.className = 'transfers empty';
    elements.transfers.textContent = t('no_transfers');
    return;
  }

  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
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

    const actions = document.createElement('div');
    actions.className = 'transfer-actions';

    if (transfer.status === 'sending' || transfer.status === 'receiving') {
      const pauseBtn = document.createElement('button');
      pauseBtn.type = 'button';
      pauseBtn.className = 'secondary pairing-button';
      pauseBtn.textContent = t('btn_pause');
      pauseBtn.addEventListener('click', async () => {
        pauseBtn.disabled = true;
        if (window.lanTransfer && window.lanTransfer.pauseTransfer) {
          await window.lanTransfer.pauseTransfer(transfer.transferId);
        }
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'secondary pairing-button pairing-cancel';
      cancelBtn.textContent = t('btn_abort');
      cancelBtn.addEventListener('click', async () => {
        cancelBtn.disabled = true;
        if (window.lanTransfer && window.lanTransfer.cancelTransfer) {
          await window.lanTransfer.cancelTransfer(transfer.transferId);
        }
      });

      actions.append(pauseBtn, cancelBtn);
    } else if (transfer.status === 'paused') {
      const resumeBtn = document.createElement('button');
      resumeBtn.type = 'button';
      resumeBtn.className = 'secondary pairing-button';
      resumeBtn.textContent = t('btn_resume');
      resumeBtn.addEventListener('click', async () => {
        resumeBtn.disabled = true;
        if (window.lanTransfer && window.lanTransfer.resumeTransfer) {
          await window.lanTransfer.resumeTransfer(transfer.transferId);
        }
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'secondary pairing-button pairing-cancel';
      cancelBtn.textContent = t('btn_abort');
      cancelBtn.addEventListener('click', async () => {
        cancelBtn.disabled = true;
        if (window.lanTransfer && window.lanTransfer.cancelTransfer) {
          await window.lanTransfer.cancelTransfer(transfer.transferId);
        }
      });

      actions.append(resumeBtn, cancelBtn);
    } else if (transfer.status === 'completed') {
      if (transfer.savePath) {
        const openFolderBtn = document.createElement('button');
        openFolderBtn.type = 'button';
        openFolderBtn.className = 'secondary pairing-button';
        openFolderBtn.textContent = t('btn_open_folder');
        openFolderBtn.addEventListener('click', async () => {
          if (window.lanTransfer && window.lanTransfer.openTransferFolder) {
            await window.lanTransfer.openTransferFolder(transfer.savePath);
          }
        });
        actions.append(openFolderBtn);
      }
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'secondary pairing-button';
      removeBtn.textContent = isZh ? '🗑 移除' : '🗑 Remove';
      removeBtn.addEventListener('click', () => {
        state.transfers.delete(transfer.transferId);
        renderTransfers();
      });
      actions.append(removeBtn);
    } else {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'secondary pairing-button';
      removeBtn.textContent = isZh ? '🗑 移除' : '🗑 Remove';
      removeBtn.addEventListener('click', () => {
        state.transfers.delete(transfer.transferId);
        renderTransfers();
      });
      actions.append(removeBtn);
    }

    card.append(details, actions);
    return card;
  }));
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function describeTransfer(transfer) {
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  const direction = transfer.direction === 'send' ? (isZh ? '发送' : 'Send') : transfer.direction === 'receive' ? (isZh ? '接收' : 'Receive') : (isZh ? '系统' : 'System');
  const total = transfer.total || (transfer.file && transfer.file.size) || 0;
  const status = transfer.error ? `${translateStatus(transfer.status)}: ${transfer.error}` : translateStatus(transfer.status);
  return `${direction} | ${status} | ${formatBytes(transfer.bytes || 0)} / ${formatBytes(total)}`;
}

function translateStatus(status) {
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  const statuses = new Map(isZh ? [
    ['requesting', '等待确认'],
    ['rejected', '已拒绝'],
    ['sending', '发送中'],
    ['receiving', '接收中'],
    ['accepted', '已接受'],
    ['paused', '已暂停'],
    ['cancelled', '已终止'],
    ['completed', '已完成'],
    ['failed', '失败']
  ] : [
    ['requesting', 'Waiting for confirmation'],
    ['rejected', 'Rejected'],
    ['sending', 'Sending'],
    ['receiving', 'Receiving'],
    ['accepted', 'Accepted'],
    ['paused', 'Paused'],
    ['cancelled', 'Cancelled'],
    ['completed', 'Completed'],
    ['failed', 'Failed']
  ]);
  return statuses.get(status) || status || (isZh ? '未知' : 'Unknown');
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
    setTransferJobMessage(t('no_transfers'), true);
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
  if (!silent) setTransferJobMessage(t('loading'));
  renderTransferJobs();
  try {
    const jobs = await api.list();
    transferJobState.jobs = (Array.isArray(jobs) ? jobs : [])
      .filter((job) => job && typeof job.taskId === 'string' && typeof job.status === 'string')
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
    setTransferJobMessage(transferJobState.jobs.length > 0 ? (window.i18n.getCurrentLanguage() === 'zh' ? '可在此恢复、暂停、重试或取消持久化任务。' : 'Recover, pause, retry, or cancel persistent transfer tasks.') : t('no_transfers'));
  } catch (error) {
    setTransferJobMessage(errorMessage(error), true);
  } finally {
    transferJobState.loading = false;
    renderTransferJobs();
  }
}

function renderTransferJobs() {
  const api = getTransferJobApi();
  const jobs = transferJobState.jobs;
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  elements.v2TransferJobSummary.textContent = String(jobs.length);
  elements.v2TransferJobStatus.textContent = transferJobState.message;
  elements.v2TransferJobStatus.className = transferJobState.messageIsError ? 'pairing-status failed' : 'pairing-status';
  elements.v2TransferJobRefresh.disabled = !api || transferJobState.loading;
  elements.v2TransferJobRefresh.textContent = transferJobState.loading ? (isZh ? '正在刷新...' : 'Refreshing…') : (isZh ? '刷新任务' : 'Refresh Jobs');
  if (jobs.length === 0) {
    elements.v2TransferJobs.className = 'transfers empty';
    elements.v2TransferJobs.textContent = transferJobState.loading ? t('loading') : t('no_transfers');
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
    title.textContent = files.length === 1 ? files[0].relativePath : (isZh ? `${files.length || 0} 个文件` : `${files.length || 0} files`);
    const meta = document.createElement('div');
    meta.className = 'transfer-meta';
    const progress = job.progress || {};
    meta.textContent = `${job.direction === 'incoming' ? (isZh ? '接收' : 'Receive') : (isZh ? '发送' : 'Send')} | ${translateJobStatus(job.status)} | ${formatBytes(progress.transferredBytes)} / ${formatBytes(progress.totalBytes)}`;
    const diagnostic = document.createElement('div');
    diagnostic.className = 'transfer-diagnostic';
    diagnostic.textContent = job.errorMessage ? `${job.diagnosticCode || 'ERROR'}: ${job.errorMessage}` : (job.diagnosticCode ? (isZh ? `诊断：${job.diagnosticCode}` : `Diag: ${job.diagnosticCode}`) : (isZh ? `设备：${shortDeviceId(job.peerDeviceId)}` : `Device: ${shortDeviceId(job.peerDeviceId)}`));
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
      button.textContent = busy ? (isZh ? '正在处理...' : 'Processing…') : action.label;
      button.addEventListener('click', () => runTransferJobAction(job, action.kind));
      actions.append(button);
    }
    card.append(details, actions);
    return card;
  }));
}

function transferJobActions(job) {
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  const actions = [];
  if (job.status === 'transferring') actions.push({ kind: 'pause', label: t('btn_pause') });
  if (job.status === 'paused') actions.push({ kind: 'resume', label: t('btn_resume') });
  if (job.status === 'failed') actions.push({ kind: 'retry', label: isZh ? '重试' : 'Retry' });
  if (!['completed', 'cancelled'].includes(job.status)) actions.push({ kind: 'cancel', label: t('btn_cancel') });
  return actions;
}

async function runTransferJobAction(job, action) {
  const api = getTransferJobApi();
  if (!api || transferJobState.busyTaskIds.has(job.taskId) || typeof api[action] !== 'function') return;
  transferJobState.busyTaskIds.add(job.taskId);
  setTransferJobMessage(window.i18n.getCurrentLanguage() === 'zh' ? '正在更新传输任务...' : 'Updating transfer task…');
  renderTransferJobs();
  try {
    await api[action](job.taskId);
    await refreshTransferJobs({ silent: true });
  } catch (error) {
    setTransferJobMessage(errorMessage(error), true);
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
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  if (isZh) {
    return ({ queued: '排队中', 'awaiting-approval': '等待接收确认', transferring: '传输中', paused: '已暂停', failed: '失败', completed: '已完成', cancelled: '已取消' })[status] || status;
  }
  return ({ queued: 'Queued', 'awaiting-approval': 'Awaiting Approval', transferring: 'Transferring', paused: 'Paused', failed: 'Failed', completed: 'Completed', cancelled: 'Cancelled' })[status] || status;
}

function jobProgressPercent(job) {
  const progress = job.progress || {};
  const total = Number(progress.totalBytes) || 0;
  if (!total) return job.status === 'completed' ? 100 : 2;
  return Math.max(2, Math.min(100, Math.round(((Number(progress.transferredBytes) || 0) / total) * 100)));
}

function shortDeviceId(deviceId) {
  return typeof deviceId === 'string' && deviceId.length > 12 ? `${deviceId.slice(0, 8)}…${deviceId.slice(-4)}` : (deviceId || (window.i18n && window.i18n.getCurrentLanguage() === 'zh' ? '未知' : 'Unknown'));
}

function initializeV2Pairing() {
  const pairingApi = getPairingApi();
  if (!pairingApi) {
    setPairingMessage(t('v2_not_connected'), true);
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
        setPairingMessage(pairingState.discoveredPeers.length > 0 ? (window.i18n.getCurrentLanguage() === 'zh' ? '已更新 v2 设备发现结果。' : 'Discovered v2 devices updated.') : t('v2_searching'));
      }
      renderV2Pairing();
    });
  }

  if (typeof window.lanTransfer.onV2PairingSession === 'function') {
    window.lanTransfer.onV2PairingSession((session) => {
      if (session && typeof session.pairingId === 'string') {
        pairingState.sessions.set(session.pairingId, session);
        if (session.status === 'ready-to-trust'
            && !pairingState.busySessionIds.has(session.pairingId)
            && !pairingState.autoCompletedPairingIds.has(session.pairingId)) {
          pairingState.autoCompletedPairingIds.add(session.pairingId);
          autoCompleteV2Pairing(session);
        }
      } else {
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
      typeof api.revokeTrustedPeer !== 'function' || typeof api.updateTrustedPeerDisplayName !== 'function' ||
      typeof api.updateTrustedPeerPermissions !== 'function' || typeof api.updateTrustedPeer !== 'function' ||
      typeof api.listSessions !== 'function' || typeof api.start !== 'function' ||
      typeof api.confirm !== 'function' || typeof api.complete !== 'function' || typeof api.cancel !== 'function') {
    return null;
  }
  return api;
}

async function refreshV2Pairing({ announce = false, silent = false } = {}) {
  const pairingApi = getPairingApi();
  if (!pairingApi) return;

  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  const version = ++pairingState.refreshVersion;
  pairingState.loading = true;
  if (announce) setPairingMessage(isZh ? '正在刷新 v2 配对信息...' : 'Refreshing pairing information…');
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
  else errors.push(errorMessage(peersResult.reason));

  if (sessionsResult.status === 'fulfilled') replacePairingSessions(sessionsResult.value);
  else errors.push(errorMessage(sessionsResult.reason));

  if (trustedResult.status === 'fulfilled') pairingState.trustedPeers = normalizeTrustedPeers(trustedResult.value);
  else errors.push(errorMessage(trustedResult.reason));

  if (errors.length > 0) {
    setPairingMessage(errors.join('; '), true);
  } else if (!silent || !pairingState.messageIsError) {
    setPairingMessage(pairingState.discoveredPeers.length > 0 ? (isZh ? 'v2 配对设备列表已更新。' : 'Discovered v2 peers updated.') : t('v2_searching'));
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
  return peerLabel(left).localeCompare(peerLabel(right));
}

function renderV2Pairing() {
  const pairingApi = getPairingApi();
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  elements.v2RefreshButton.disabled = !pairingApi || pairingState.loading;
  elements.v2RefreshButton.textContent = pairingState.loading ? (isZh ? '正在刷新...' : 'Refreshing…') : t('v2_refresh_peers');
  elements.v2PairingStatus.textContent = pairingState.message;
  elements.v2PairingStatus.className = pairingState.messageIsError ? 'pairing-status failed' : 'pairing-status';
  elements.v2PairingSummary.textContent = pairingApi ? `${pairingState.sessions.size} ${isZh ? '个会话' : 'session(s)'}` : t('v2_not_connected');
  renderV2DiscoveredPeers(pairingApi);
  renderV2PairingSessions(pairingApi);
  renderV2TrustedPeers();
}

function renderV2DiscoveredPeers(pairingApi) {
  const trustedDeviceIds = new Set(pairingState.trustedPeers.map((peer) => peer.deviceId));
  const peers = pairingState.discoveredPeers.filter((peer) => !trustedDeviceIds.has(peer.deviceId));
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  elements.v2DiscoveredCount.textContent = String(peers.length);
  if (peers.length === 0) {
    elements.v2DiscoveredPeers.className = 'pairing-list empty';
    elements.v2DiscoveredPeers.textContent = pairingState.loading ? (isZh ? '正在刷新 v2 设备...' : 'Refreshing…') : t('v2_searching');
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
    fingerprint.textContent = `${isZh ? '设备指纹' : 'Fingerprint'}: ${shortFingerprint(peer.fingerprint)}`;
    const discovery = document.createElement('span');
    discovery.className = 'pairing-meta';
    discovery.textContent = formatLastSeen(peer.lastSeen);
    details.append(name, fingerprint, discovery);

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'primary pairing-button';
    const isStarting = pairingState.startingPeerIds.has(peer.deviceId);
    action.disabled = !pairingApi || isStarting;
    action.textContent = isStarting ? (isZh ? '正在开始...' : 'Starting…') : t('btn_pair');
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
    elements.v2PairingSessions.textContent = t('v2_no_active_sessions');
    return;
  }

  elements.v2PairingSessions.className = 'pairing-list';
  elements.v2PairingSessions.replaceChildren(...sessions.map((session) => createPairingSessionCard(session, pairingApi)));
}

function createPairingSessionCard(session, pairingApi) {
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  const card = document.createElement('article');
  card.className = 'pairing-card pairing-session-card';

  const details = document.createElement('div');
  details.className = 'pairing-details';
  const name = document.createElement('strong');
  name.className = 'pairing-name';
  name.textContent = session.peer ? peerLabel(session.peer) : (isZh ? '正在等待对方设备信息' : 'Waiting for peer device info');
  const status = document.createElement('span');
  status.className = 'pairing-meta';
  status.textContent = `${isZh ? '状态' : 'Status'}: ${translatePairingStatus(session.status)}`;
  details.append(name, status);

  if (session.peer && session.peer.fingerprint) {
    const fingerprint = document.createElement('span');
    fingerprint.className = 'pairing-meta';
    fingerprint.textContent = `${isZh ? '设备指纹' : 'Fingerprint'}: ${shortFingerprint(session.peer.fingerprint)}`;
    details.append(fingerprint);
  }

  if (typeof session.pairingCode === 'string' && session.pairingCode.length > 0) {
    const sasLabel = document.createElement('span');
    sasLabel.className = 'pairing-sas-label';
    sasLabel.textContent = isZh ? '请双方核对以下安全码（SAS）' : 'Verify the following 6-digit security code';
    const sas = document.createElement('output');
    sas.className = 'pairing-sas';
    sas.textContent = session.pairingCode;
    details.append(sasLabel, sas);
  } else {
    const pending = document.createElement('span');
    pending.className = 'pairing-meta';
    pending.textContent = isZh ? '等待获取双方可核对的安全码...' : 'Waiting for security code…';
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
    confirm.textContent = isBusy ? (isZh ? '正在确认...' : 'Confirming…') : t('btn_confirm');
    confirm.addEventListener('click', () => confirmV2Pairing(session));
    actions.append(confirm);
  }

  if (session.status === 'ready-to-trust') {
    const note = document.createElement('span');
    note.className = 'pairing-meta';
    note.textContent = isBusy ? (isZh ? '正在自动保存信任...' : 'Saving trust…') : t('pair_auto_completing');
    actions.append(note);
  }

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary pairing-button pairing-cancel';
  cancel.disabled = !pairingApi || isBusy;
  cancel.textContent = isBusy ? (isZh ? '正在处理...' : 'Processing…') : t('btn_cancel');
  cancel.addEventListener('click', () => cancelV2Pairing(session));
  actions.append(cancel);

  card.append(details, actions);
  return card;
}

function renderV2TrustedPeers() {
  const pairingApi = getPairingApi();
  const peers = pairingState.trustedPeers;
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  elements.v2TrustedCount.textContent = String(peers.length);
  if (peers.length === 0) {
    elements.v2TrustedPeers.className = 'pairing-list empty';
    elements.v2TrustedPeers.textContent = t('v2_no_trusted_devices');
    return;
  }

  elements.v2TrustedPeers.className = 'pairing-list';
  elements.v2TrustedPeers.replaceChildren(...peers.map((peer) => {
    const card = document.createElement('article');
    card.className = 'pairing-card trusted-peer-card';
    const isBusy = pairingState.busyTrustedPeerIds.has(peer.deviceId);
    const details = document.createElement('div');
    details.className = 'pairing-details';
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'pairing-name';
    name.value = peer.displayName || peerLabel(peer);
    name.maxLength = 128;
    name.placeholder = peerLabel(peer);
    name.disabled = !pairingApi || isBusy;
    const device = document.createElement('span');
    device.className = 'pairing-meta';
    device.textContent = `${isZh ? '设备' : 'Device'}: ${peerLabel(peer)}`;
    const fingerprint = document.createElement('span');
    fingerprint.className = 'pairing-meta';
    fingerprint.textContent = `${isZh ? '设备指纹' : 'Fingerprint'}: ${shortFingerprint(peer.fingerprint)}`;
    const permissions = document.createElement('span');
    permissions.className = 'pairing-permissions';
    permissions.textContent = describePairingPermissions(peer.permissions);
    const lastSeen = document.createElement('span');
    lastSeen.className = 'pairing-meta';
    lastSeen.textContent = `${isZh ? '最近活动' : 'Last Seen'}: ${formatLastSeen(peer.lastSeen)}`;
    const permissionControls = document.createElement('div');
    permissionControls.className = 'pairing-details';
    const permissionInputs = new Map();
    for (const [key, labelText] of (isZh ? [
      ['transfer', '允许传输'],
      ['libraryRead', '允许读取媒体库'],
      ['libraryUpload', '允许写入媒体库']
    ] : [
      ['transfer', 'Allow Transfer'],
      ['libraryRead', 'Allow Read Library'],
      ['libraryUpload', 'Allow Write Library']
    ])) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(peer.permissions && peer.permissions[key]);
      checkbox.disabled = !pairingApi || isBusy;
      checkbox.addEventListener('change', () => {
        saveV2TrustedPeer(peer, { displayName: name, permissions: permissionInputs });
      });
      permissionInputs.set(key, checkbox);
      label.append(checkbox, document.createTextNode(` ${labelText}`));
      permissionControls.append(label);
    }
    details.append(name, device, fingerprint, permissions, lastSeen, permissionControls);

    const actions = document.createElement('div');
    actions.className = 'pairing-button-row';
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'secondary pairing-button pairing-cancel';
    revoke.disabled = !pairingApi || isBusy;
    revoke.textContent = isBusy ? (isZh ? '正在处理...' : 'Processing…') : t('btn_revoke');
    revoke.addEventListener('click', () => {
      if (confirm(t('revoke_confirm', peer.displayName || peerLabel(peer)))) {
        revokeV2TrustedPeer(peer);
      }
    });
    actions.append(revoke);
    card.append(details, actions);
    return card;
  }));
}

async function saveV2TrustedPeer(peer, controls) {
  const pairingApi = getPairingApi();
  if (!pairingApi || pairingState.busyTrustedPeerIds.has(peer.deviceId)) return;

  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  pairingState.busyTrustedPeerIds.add(peer.deviceId);
  setPairingMessage(isZh ? `正在保存“${peer.displayName || peerLabel(peer)}”的受信设置...` : `Saving trust settings for "${peer.displayName || peerLabel(peer)}”…`);
  renderV2Pairing();
  try {
    const displayName = controls.displayName.value.trim();
    const permissions = Object.fromEntries(
      ['transfer', 'libraryRead', 'libraryUpload'].map((key) => [key, controls.permissions.get(key).checked])
    );
    const updated = await pairingApi.updateTrustedPeer(peer.deviceId, { displayName, permissions });
    if (!updated) throw new Error(isZh ? '该设备已不在受信列表中' : 'Device not found in trusted list');
    await refreshV2Pairing({ silent: true });
    if (!pairingState.messageIsError) setPairingMessage(isZh ? `已保存“${displayName}”的受信设置。` : `Saved trust settings for "${displayName}".`);
  } catch (error) {
    setPairingMessage(errorMessage(error), true);
  } finally {
    pairingState.busyTrustedPeerIds.delete(peer.deviceId);
    renderV2Pairing();
  }
}

async function revokeV2TrustedPeer(peer) {
  const pairingApi = getPairingApi();
  if (!pairingApi || pairingState.busyTrustedPeerIds.has(peer.deviceId)) return;

  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  pairingState.busyTrustedPeerIds.add(peer.deviceId);
  setPairingMessage(isZh ? `正在撤销“${peer.displayName || peerLabel(peer)}”的信任...` : `Revoking trust for "${peer.displayName || peerLabel(peer)}”…`);
  renderV2Pairing();
  try {
    const revoked = await pairingApi.revokeTrustedPeer(peer.deviceId);
    if (!revoked) throw new Error(isZh ? '该设备已不在受信列表中' : 'Device not found in trusted list');
    pairingState.trustedPeers = pairingState.trustedPeers.filter((candidate) => candidate.deviceId !== peer.deviceId);
    setPairingMessage(isZh ? '已撤销设备信任；后续传输前需要重新配对。' : 'Trust revoked. Future transfers will require pairing again.');
    await refreshV2Pairing({ silent: true });
  } catch (error) {
    setPairingMessage(errorMessage(error), true);
  } finally {
    pairingState.busyTrustedPeerIds.delete(peer.deviceId);
    renderV2Pairing();
  }
}

async function startV2Pairing(peer) {
  const pairingApi = getPairingApi();
  if (!pairingApi || pairingState.startingPeerIds.has(peer.deviceId)) return;

  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  pairingState.startingPeerIds.add(peer.deviceId);
  setPairingMessage(isZh ? `正在向“${peerLabel(peer)}”发起配对...` : `Starting pairing with "${peerLabel(peer)}”…`);
  renderV2Pairing();
  try {
    const session = await pairingApi.start({ peerDeviceId: peer.deviceId, capabilities: PAIRING_CAPABILITIES.slice() });
    if (session && typeof session.pairingId === 'string') pairingState.sessions.set(session.pairingId, session);
    setPairingMessage(t('pair_request_sent', peerLabel(peer)));
    await refreshV2Pairing({ silent: true });
  } catch (error) {
    setPairingMessage(errorMessage(error), true);
  } finally {
    pairingState.startingPeerIds.delete(peer.deviceId);
    renderV2Pairing();
  }
}

async function confirmV2Pairing(session) {
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  await runV2SessionAction(session, isZh ? '正在确认双方安全码...' : 'Confirming security code…', async (pairingApi) => {
    await pairingApi.confirm(session.pairingId);
    setPairingMessage(t('pair_confirmed_waiting'));
  });
}

async function completeV2Pairing(session) {
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  await runV2SessionAction(session, isZh ? '正在将设备加入受信列表...' : 'Adding device to trusted list…', async (pairingApi) => {
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
    setPairingMessage(t('pair_complete_trusted', displayName || (isZh ? '设备' : 'Device')));
  });
}

async function autoCompleteV2Pairing(session) {
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  setPairingMessage(isZh ? '双方已确认安全码，正在自动保存信任...' : 'Both confirmed, saving trust automatically…');
  try {
    await completeV2Pairing(session);
  } catch (error) {
    pairingState.autoCompletedPairingIds.delete(session.pairingId);
    setPairingMessage(errorMessage(error), true);
    renderV2Pairing();
  }
}

async function cancelV2Pairing(session) {
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  await runV2SessionAction(session, isZh ? '正在取消配对...' : 'Cancelling pairing…', async (pairingApi) => {
    await pairingApi.cancel(session.pairingId);
    pairingState.sessions.delete(session.pairingId);
    setPairingMessage(isZh ? '已取消配对。' : 'Pairing cancelled.');
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
    setPairingMessage(errorMessage(error), true);
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
  const fallback = window.i18n && window.i18n.getCurrentLanguage() === 'zh' ? '未命名设备' : 'Unnamed Device';
  return peer && typeof peer.deviceName === 'string' && peer.deviceName.trim() ? peer.deviceName.trim() : fallback;
}

function shortFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) return window.i18n && window.i18n.getCurrentLanguage() === 'zh' ? '未知' : 'Unknown';
  return fingerprint.length > 20 ? `${fingerprint.slice(0, 10)}…${fingerprint.slice(-8)}` : fingerprint;
}

function describePairingPermissions(permissions) {
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  const granted = [];
  if (permissions && permissions.transfer) granted.push(isZh ? '传输' : 'Transfer');
  if (permissions && permissions.libraryRead) granted.push(isZh ? '读取媒体库' : 'Read Library');
  if (permissions && permissions.libraryUpload) granted.push(isZh ? '写入媒体库' : 'Upload Library');
  if (isZh) {
    return granted.length > 0 ? `已授权：${granted.join('、')}` : '未授予可用权限';
  }
  return granted.length > 0 ? `Granted: ${granted.join(', ')}` : 'No permissions granted';
}

function formatLastSeen(lastSeen) {
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  const timestamp = Number(lastSeen);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return isZh ? '最近发现' : 'Recently seen';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return isZh ? '刚刚发现' : 'Just now';
  if (seconds < 60) return isZh ? `${seconds} 秒前发现` : `${seconds}s ago`;
  return isZh ? `${Math.floor(seconds / 60)} 分钟前发现` : `${Math.floor(seconds / 60)}m ago`;
}

function formatExpiration(expiresAt) {
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  const timestamp = Number(expiresAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const remainingSeconds = Math.ceil((timestamp - Date.now()) / 1000);
  if (remainingSeconds <= 0) return isZh ? '会话即将过期，请刷新状态。' : 'Session expiring soon, please refresh.';
  if (remainingSeconds < 60) return isZh ? `安全码将在约 ${remainingSeconds} 秒后过期` : `Code expires in ~${remainingSeconds}s`;
  return isZh ? `安全码将在约 ${Math.ceil(remainingSeconds / 60)} 分钟后过期` : `Code expires in ~${Math.ceil(remainingSeconds / 60)}m`;
}

function translatePairingStatus(status) {
  const isZh = (window.i18n ? window.i18n.getCurrentLanguage() : 'zh') === 'zh';
  if (isZh) {
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
  const labels = new Map([
    ['awaiting-remote-offer', 'Awaiting remote response'],
    ['awaiting-local-confirmation', 'Verify and confirm code'],
    ['awaiting-remote-confirmation', 'Confirmed, waiting for peer'],
    ['ready-to-trust', 'Both confirmed, ready to trust'],
    ['completed', 'Completed'],
    ['cancelled', 'Cancelled'],
    ['expired', 'Expired']
  ]);
  return labels.get(status) || 'Processing';
}

function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message.trim()) return error.message.trim();
  return window.i18n && window.i18n.getCurrentLanguage() === 'zh' ? '未知错误' : 'Unknown error';
}
