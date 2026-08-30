'use strict';

const translations = {
  zh: {
    app_title: '附近传输',
    choose_file: '选择文件',
    drag_help: '也可以直接把文件或文件夹拖到这里',
    no_file_selected: '未选择文件。',
    send_button: '发送',
    initial_status: '先选择附近设备，再选择要发送的文件。',
    ready_to_send: '已准备好发送。',
    transfer_progress_label: '传输进度',
    trusted_device_name_label: '受信设备显示名称',
    recoverable_transfers_title: '实验性 v2 持久化任务',
    recoverable_transfers_intro: '这里仅显示实验性 v2 任务状态；当前经典桌面传输不在此面板中，也不支持断点恢复。',
    recoverable_transfers_loading: '正在读取实验性 v2 任务...',
    recoverable_transfers_empty: '暂无实验性 v2 任务。',
    recoverable_transfers_refresh: '刷新任务',
    persistent_jobs_actions: '可在此管理持久化 v2 任务；仅标记为可恢复的暂停或失败任务可继续或重试。',
    details: '详情',
    collapse: '收起',
    refreshing: '正在刷新...',
    library_not_running: '未运行',
    library_no_lan_address: '未检测到可供其他设备访问的局域网地址',
    transfer_live_intro: '显示当前经典桌面传输记录；可用操作取决于任务状态。',
    clear_completed: '清除已完成',
    live_badge: '实时',
    selected_peer_offline: '所选设备当前离线，上线后将自动恢复选中。',
    nearby_peers: '附近设备',
    refresh_peers: '刷新设备',
    this_device: '本机',
    device_name_label: '名称',
    device_starting: '正在启动...',
    save_directory_label: '收到的文件保存到',
    change_save_dir: '更改保存位置',
    reset_save_dir: '恢复默认下载目录',
    nas_library_title: 'Nearby Transfer 共享文件库',
    library_ready_badge: '已就绪',
    library_intro: '受支持的 Nearby Transfer 客户端可在签名会话协商后访问此 HTTPS 共享库；它不是通用免密 WebDAV 挂载点。默认共享目录只读，用户明确选择的目录才允许写入。',
    current_share_folder: '当前共享文件夹',
    loading: '正在加载...',
    webdav_url_label: 'Nearby Transfer 共享库地址',
    change_share_folder: '更改共享文件夹',
    open_in_explorer: '在资源管理器中打开',
    reset_share_folder: '恢复默认共享目录',
    copy_webdav_url: '复制共享库地址',
    copied: '已复制！',
    v2_pairing_title: 'v2 实验性配对',
    v2_pairing_intro: '发现不等于信任。请仅在双方当面核对相同的安全码后确认配对。',
    v2_not_connected: '未连接',
    v2_preparing: '正在准备实验性配对服务...',
    v2_discovered_peers: '可配对设备',
    v2_discovered_help: '仅显示 v2 发现公告；不会显示主机地址、端口或公钥。',
    v2_searching: '正在搜索支持 v2 配对的设备...',
    v2_refresh_peers: '刷新 v2 设备',
    v2_active_sessions: '配对中会话',
    v2_sessions_help: '请在两台设备上核对安全码；仅在完全一致时点击确认。',
    v2_no_active_sessions: '暂无正在进行的配对会话。',
    v2_trusted_devices: '已信任设备',
    v2_trusted_help: '配对只保存设备身份，默认不授予任何权限；请按需显式开启。',
    v2_no_trusted_devices: '暂无已信任设备。',
    btn_pair: '发起配对',
    btn_confirm: '确认并完成配对',
    pair_auto_completing: '双方已确认，正在自动保存信任...',
    btn_cancel: '取消',
    btn_revoke: '解除信任',
    btn_open_folder: '打开目录',
    btn_pause: '暂停',
    btn_resume: '继续',
    btn_abort: '终止',
    transfers_title: '传输任务',
    no_transfers: '暂无活动传输。',
    speed_format: '速率：%1$s',
    progress_format: '%1$s / %2$s (%3$s%%)',
    drag_hint: '请从文件管理器拖入文件。',
    cannot_use_file: '无法使用这个文件。',
    select_file_first: '请先选择文件。',
    select_peer_first: '请先选择附近设备。',
    waiting_peer_confirm: '正在等待对方确认接收...',
    batch_sending_format: '正在发送 (%1$s/%2$s): %3$s',
    batch_complete_format: '全部发送完成 (成功 %1$s 个)。',
    send_complete: '发送完成。',
    send_failed: '发送失败。',
    send_failed_format: '发送失败：%1$s',
    operation_failed: '操作失败',
    searching_peers: '正在局域网内搜索设备...',
    files_selected_format: '已选择 %1$s 个文件 (%2$s 等)',
    default_save_mode: '默认下载目录',
    custom_save_mode: '自定义目录',
    library_read_only_mode: '只读共享',
    library_writable_mode: '可写共享（已由用户明确选择）',
    revoke_confirm: '确定要解除对设备“%1$s”的信任吗？解除后后续传输需重新配对。',
    pair_request_sent: '已向 %1$s 发起配对，请在对方设备查看安全码。',
    pair_confirmed_waiting: '本机已确认，正在等待对方确认...',
    pair_complete_trusted: '配对成功！已将 %1$s 加入可信设备。默认未授予任何权限，请在受信设备列表中按需开启。',
    protocol_settings_title: '传输协议状态',
    protocol_settings_subtitle: 'V1 经典协议当前可用；其余协议为正在集成的实验性适配器',
    protocol_category_all: '全部 (7)',
    protocol_category_fast: '🚀 极速传输',
    protocol_category_system: '🪟 系统共享',
    protocol_category_standard: '🌐 标准服务',
    protocol_unavailable: '该协议仍处于实验阶段，尚未接入桌面文件传输。',
    protocol_experimental_badge: '实验性 / 尚不可用',
    protocol_v2_name: 'V2 高可靠流式协议',
    protocol_v2_badge: '组件测试中 / 桌面未接入',
    protocol_v2_pros: '现状：核心分块、检查点与控制组件已有自动化测试。',
    protocol_v2_cons: '限制：尚未接入当前桌面发送与接收数据通路。',
    protocol_v2_scenario: '规划：完成跨端集成和兼容性验证后再开放选择。',
    protocol_v2_client: '可用客户端：暂无完整端到端支持',
    protocol_turbo_name: 'Turbo 极速多通道并发协议',
    protocol_turbo_badge: '路线图 / 未实现',
    protocol_turbo_pros: '现状：仅保留协议驱动接口与路线图条目，没有可用数据通路。',
    protocol_turbo_cons: '限制：性能、资源占用和兼容性均尚未验证。',
    protocol_turbo_scenario: '规划：实现后再通过基准测试确定适用场景。',
    protocol_turbo_client: '可用客户端：无',
    protocol_quic_name: 'QUIC / UDP 极速抗弱网协议',
    protocol_quic_badge: '路线图 / 未实现',
    protocol_quic_pros: '现状：仅保留协议驱动接口，尚无 QUIC 运行时。',
    protocol_quic_cons: '限制：网络行为和平台兼容性均尚未验证。',
    protocol_quic_scenario: '规划：实现并完成弱网测试后再说明适用场景。',
    protocol_quic_client: '可用客户端：无',
    protocol_smb_name: 'SMB 3.0 局域网网络邻居协议',
    protocol_smb_badge: '路线图 / 未实现',
    protocol_smb_pros: '现状：项目尚未提供 SMB 服务端或桌面传输数据通路。',
    protocol_smb_cons: '限制：认证、权限和平台兼容性设计尚未完成。',
    protocol_smb_scenario: '规划：实现并验证各平台挂载行为后再开放。',
    protocol_smb_client: '可用客户端：无',
    protocol_webdav_name: 'WebDAV 直连云盘同步协议',
    protocol_webdav_badge: '共享库预览 / 非传输驱动',
    protocol_webdav_pros: '现状：共享库提供受限 WebDAV 方法集，但尚未作为桌面传输协议接入。',
    protocol_webdav_cons: '缺点：散碎小文件浏览时有 XML 元数据解析开销。',
    protocol_webdav_scenario: '适用：在能力矩阵所列限制内进行共享库预览。',
    protocol_webdav_client: '兼容性：需按客户端单独验证',
    protocol_v1_name: 'V1 经典 HTTP 流加密协议',
    protocol_v1_badge: '当前桌面默认',
    protocol_v1_pros: '现状：当前桌面端使用签名请求与加密分帧进行流式文件传输。',
    protocol_v1_cons: '缺点：不支持细粒度分块断点重续，传输中断需整体重试。',
    protocol_v1_scenario: '适用：日常局域网文件传输；中断后需整体重试。',
    protocol_v1_client: '兼容：支持当前签名发现与加密帧格式的 Nearby Transfer 客户端',
    protocol_ftps_name: 'FTPS 极速安全传输服务协议',
    protocol_ftps_badge: '路线图 / 未实现',
    protocol_ftps_pros: '现状：项目尚未提供 FTPS 服务端或客户端数据通路。',
    protocol_ftps_cons: '限制：认证、证书和客户端兼容性尚未设计完成。',
    protocol_ftps_scenario: '规划：实现并完成第三方客户端验证后再开放。',
    protocol_ftps_client: '可用客户端：无',
    protocol_active_badge: '当前生效',
    lang_toggle_zh: '中文',
    lang_toggle_en: 'English'
  },
  en: {
    app_title: 'Nearby Transfer',
    choose_file: 'Select Files',
    drag_help: 'Or drag and drop files / folders here',
    no_file_selected: 'No file selected.',
    send_button: 'Send',
    initial_status: 'Select a nearby device first, then choose a file to send.',
    ready_to_send: 'Ready to send.',
    transfer_progress_label: 'Transfer progress',
    trusted_device_name_label: 'Trusted device display name',
    recoverable_transfers_title: 'Experimental v2 Persistent Jobs',
    recoverable_transfers_intro: 'This panel shows experimental v2 job state only. Current classic desktop transfers are not listed here and are not resumable.',
    recoverable_transfers_loading: 'Loading experimental v2 jobs…',
    recoverable_transfers_empty: 'No experimental v2 jobs.',
    recoverable_transfers_refresh: 'Refresh Jobs',
    persistent_jobs_actions: 'Manage persistent v2 jobs here. Only paused or failed jobs marked recoverable can be resumed or retried.',
    details: 'Details',
    collapse: 'Collapse',
    refreshing: 'Refreshing…',
    library_not_running: 'Not running',
    library_no_lan_address: 'No LAN address available to other devices',
    transfer_live_intro: 'Shows current classic desktop transfer records; available actions depend on job state.',
    clear_completed: 'Clear completed',
    live_badge: 'Live',
    selected_peer_offline: 'The selected device is offline; it will be re-selected automatically when it comes back online.',
    nearby_peers: 'Nearby Devices',
    refresh_peers: 'Refresh Devices',
    this_device: 'This Device',
    device_name_label: 'Name',
    device_starting: 'Starting…',
    save_directory_label: 'Save received files to',
    change_save_dir: 'Change Save Location',
    reset_save_dir: 'Reset to Default Downloads',
    nas_library_title: 'Nearby Transfer Shared Library',
    library_ready_badge: 'Ready',
    library_intro: 'Supported Nearby Transfer clients can access this HTTPS library after signed session negotiation; it is not a generic password-free WebDAV mount. The default share is read-only, and writing is enabled only for a folder the user explicitly selects.',
    current_share_folder: 'Current Shared Folder',
    loading: 'Loading…',
    webdav_url_label: 'Nearby Transfer Library URL',
    change_share_folder: 'Change Shared Folder',
    open_in_explorer: 'Open in File Explorer',
    reset_share_folder: 'Reset to Default Share',
    copy_webdav_url: 'Copy Library URL',
    copied: 'Copied!',
    v2_pairing_title: 'v2 Experimental Pairing',
    v2_pairing_intro: 'Discovery does not mean trust. Only pair after verifying the 6-digit code in person.',
    v2_not_connected: 'Not Connected',
    v2_preparing: 'Preparing pairing service…',
    v2_discovered_peers: 'Discovered Peers',
    v2_discovered_help: 'Shows discovery announcements only; hides host address, port, and keys.',
    v2_searching: 'Searching for v2 compatible devices…',
    v2_refresh_peers: 'Refresh v2 Devices',
    v2_active_sessions: 'Active Pairing Sessions',
    v2_sessions_help: 'Verify 6-digit security code on both devices; confirm only if identical.',
    v2_no_active_sessions: 'No active pairing sessions.',
    v2_trusted_devices: 'Trusted Devices',
    v2_trusted_help: 'Pairing stores device identity only. No permissions are granted by default; enable each permission explicitly.',
    v2_no_trusted_devices: 'No trusted devices yet.',
    btn_pair: 'Pair',
    btn_confirm: 'Confirm & Complete Pairing',
    pair_auto_completing: 'Both confirmed, saving trust automatically...',
    btn_cancel: 'Cancel',
    btn_revoke: 'Revoke',
    btn_open_folder: 'Open Folder',
    btn_pause: 'Pause',
    btn_resume: 'Resume',
    btn_abort: 'Cancel',
    transfers_title: 'Transfers',
    no_transfers: 'No active transfers.',
    speed_format: 'Speed: %1$s',
    progress_format: '%1$s / %2$s (%3$s%%)',
    drag_hint: 'Please drag and drop files from your file manager.',
    cannot_use_file: 'Cannot use this file.',
    select_file_first: 'Please select a file first.',
    select_peer_first: 'Please select a nearby device first.',
    waiting_peer_confirm: 'Waiting for the remote device to accept…',
    batch_sending_format: 'Sending (%1$s/%2$s): %3$s',
    batch_complete_format: 'All transfers completed (%1$s succeeded).',
    send_complete: 'Transfer completed.',
    send_failed: 'Transfer failed.',
    send_failed_format: 'Transfer failed: %1$s',
    operation_failed: 'Operation failed',
    searching_peers: 'Searching for devices on local network…',
    files_selected_format: '%1$s files selected (%2$s, etc.)',
    default_save_mode: 'Default Downloads folder',
    custom_save_mode: 'Custom folder',
    library_read_only_mode: 'Read-only share',
    library_writable_mode: 'Writable share (explicitly selected)',
    revoke_confirm: 'Are you sure you want to revoke trust for "%1$s"? Future transfers will require pairing again.',
    pair_request_sent: 'Pairing request sent to %1$s. Please verify the code on their device.',
    pair_confirmed_waiting: 'Confirmed on this device. Waiting for remote device confirmation…',
    pair_complete_trusted: 'Pairing successful! %1$s has been added to trusted devices. No permissions are granted by default - enable them on the trusted device card as needed.',
    protocol_settings_title: 'Transfer Protocol Status',
    protocol_settings_subtitle: 'V1 Classic is currently available; the remaining protocols are experimental adapters under integration',
    protocol_category_all: 'All Protocols (7)',
    protocol_category_fast: '🚀 Fast P2P',
    protocol_category_system: '🪟 OS Native Share',
    protocol_category_standard: '🌐 Standard Services',
    protocol_unavailable: 'This protocol is experimental and is not connected to desktop file transfer yet.',
    protocol_experimental_badge: 'Experimental / Unavailable',
    protocol_v2_name: 'V2 Robust Stream Protocol',
    protocol_v2_badge: 'Components Tested / Not Integrated',
    protocol_v2_pros: 'Current state: core chunk, checkpoint, and control components have automated tests.',
    protocol_v2_cons: 'Limit: it is not wired into the current desktop send/receive data path.',
    protocol_v2_scenario: 'Roadmap: enable only after cross-client integration and compatibility testing.',
    protocol_v2_client: 'Complete end-to-end clients: none yet',
    protocol_turbo_name: 'Turbo Parallel Multi-Stream',
    protocol_turbo_badge: 'Roadmap / Not Implemented',
    protocol_turbo_pros: 'Current state: driver interface and roadmap entry only; no working data path.',
    protocol_turbo_cons: 'Limit: performance, resource use, and compatibility have not been validated.',
    protocol_turbo_scenario: 'Roadmap: determine use cases only after implementation and benchmarks.',
    protocol_turbo_client: 'Available clients: none',
    protocol_quic_name: 'QUIC / UDP Fast Loss-Tolerant',
    protocol_quic_badge: 'Roadmap / Not Implemented',
    protocol_quic_pros: 'Current state: driver interface only; no QUIC runtime is included.',
    protocol_quic_cons: 'Limit: network behavior and platform compatibility have not been validated.',
    protocol_quic_scenario: 'Roadmap: describe use cases only after implementation and network-condition testing.',
    protocol_quic_client: 'Available clients: none',
    protocol_smb_name: 'SMB 3.0 LAN Network Share',
    protocol_smb_badge: 'Roadmap / Not Implemented',
    protocol_smb_pros: 'Current state: no SMB server or desktop transfer data path is included.',
    protocol_smb_cons: 'Limit: authentication, permissions, and platform compatibility are not designed yet.',
    protocol_smb_scenario: 'Roadmap: enable only after platform mount behavior is verified.',
    protocol_smb_client: 'Available clients: none',
    protocol_webdav_name: 'WebDAV Direct Cloud Sync',
    protocol_webdav_badge: 'Library Preview / Not a Transfer Driver',
    protocol_webdav_pros: 'Current state: the shared library implements a limited WebDAV method set; it is not wired as a desktop transfer protocol.',
    protocol_webdav_cons: 'Cons: XML metadata parsing overhead on massive small file hierarchies.',
    protocol_webdav_scenario: 'Use only within the limits documented in the capability matrix.',
    protocol_webdav_client: 'Compatibility must be verified per client',
    protocol_v1_name: 'V1 Classic HTTP Stream',
    protocol_v1_badge: 'Current Desktop Default',
    protocol_v1_pros: 'Current state: desktop transfers use signed requests and encrypted framing over a streaming connection.',
    protocol_v1_cons: 'Cons: No fine-grained chunk resume; full restart needed on connection drop.',
    protocol_v1_scenario: 'Use: everyday local-network file transfer; interrupted transfers restart from the beginning.',
    protocol_v1_client: 'Clients: Nearby Transfer builds that support the current signed discovery and encrypted frame format',
    protocol_ftps_name: 'FTPS Secure High-Speed Transfer',
    protocol_ftps_badge: 'Roadmap / Not Implemented',
    protocol_ftps_pros: 'Current state: no FTPS server or client data path is included.',
    protocol_ftps_cons: 'Limit: authentication, certificates, and client compatibility are not designed yet.',
    protocol_ftps_scenario: 'Roadmap: enable only after third-party client compatibility testing.',
    protocol_ftps_client: 'Available clients: none',
    protocol_active_badge: 'Active',
    lang_toggle_zh: '中文',
    lang_toggle_en: 'English'
  }
};

const STORAGE_KEY = 'nearby_transfer_lang';

let currentLang = 'zh';

function getInitialLanguage() {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('nearby_transfer_lang');
      if (saved && (saved === 'zh' || saved === 'en')) {
        return saved;
      }
    }
    if (typeof navigator !== 'undefined') {
      const sysLang = (navigator.language || '').toLowerCase();
      return sysLang.startsWith('zh') ? 'zh' : 'en';
    }
  } catch (_) {}
  return 'zh';
}

function t(key, ...args) {
  const dict = translations[currentLang] || translations.zh;
  let str = dict[key] || translations.zh[key] || key;
  if (args.length > 0) {
    args.forEach((arg, i) => {
      str = str.replace(new RegExp(`%${i + 1}\\$s`, 'g'), arg);
    });
  }
  return str;
}

function setLanguage(lang) {
  if (!translations[lang]) return;
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch (_) { }
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('app_title');
  if (typeof window !== 'undefined' && window.lanTransfer && typeof window.lanTransfer.setLanguage === 'function') {
    window.lanTransfer.setLanguage(lang);
  }
  applyI18nToDOM();
}

function applyI18nToDOM() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) {
      el.textContent = t(key);
    }
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) {
      el.setAttribute('placeholder', t(key));
    }
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (key) {
      el.setAttribute('title', t(key));
    }
  });
}

function getCurrentLanguage() {
  return currentLang;
}

// Initialize default language
currentLang = getInitialLanguage();
if (typeof document !== 'undefined') {
  document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('app_title');
}

if (typeof window !== 'undefined') {
  window.i18n = {
    t,
    setLanguage,
    getCurrentLanguage,
    applyI18nToDOM
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    translations,
    t,
    setLanguage,
    getCurrentLanguage
  };
}
