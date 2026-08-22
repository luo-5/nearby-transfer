'use strict';

const translations = {
  zh: {
    app_title: '附近传输',
    choose_file: '选择文件',
    drag_help: '也可以直接把文件或文件夹拖到这里',
    no_file_selected: '未选择文件。',
    send_button: '发送',
    initial_status: '先选择文件，再选择附近设备。',
    nearby_peers: '附近设备',
    refresh_peers: '刷新设备',
    this_device: '本机',
    device_name_label: '名称',
    device_starting: '正在启动...',
    save_directory_label: '收到的文件保存到',
    change_save_dir: '更改保存位置',
    reset_save_dir: '恢复默认下载目录',
    nas_library_title: 'NAS 共享文件库 (WebDAV)',
    library_ready_badge: '已就绪',
    library_intro: '手机与其它设备可通过受控免密会话或 WebDAV 直接访问与同步该目录下的所有文件。',
    current_share_folder: '当前共享文件夹',
    loading: '正在加载...',
    webdav_url_label: '局域网 WebDAV 挂载地址',
    change_share_folder: '更改共享文件夹',
    open_in_explorer: '在资源管理器中打开',
    reset_share_folder: '恢复默认共享目录',
    copy_webdav_url: '复制挂载链接',
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
    v2_trusted_help: '已持久化保存公钥的设备，可直接发起传输与文件库免密访问。',
    v2_no_trusted_devices: '暂无已信任设备。',
    btn_pair: '发起配对',
    btn_confirm: '确认配对',
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
    revoke_confirm: '确定要解除对设备“%1$s”的信任吗？解除后后续传输需重新配对。',
    pair_request_sent: '已向 %1$s 发起配对，请在对方设备查看安全码。',
    pair_confirmed_waiting: '本机已确认，正在等待对方确认...',
    pair_complete_trusted: '配对成功！已将 %1$s 加入可信设备。',
    protocol_settings_title: '传输协议矩阵设置',
    protocol_settings_subtitle: '支持自研极速流、系统原生共享与国际标准存储 7 大主流协议热切换',
    protocol_category_all: '全部 (7)',
    protocol_category_fast: '🚀 极速传输',
    protocol_category_system: '🪟 系统共享',
    protocol_category_standard: '🌐 标准服务',
    protocol_v2_name: 'V2 高可靠流式协议',
    protocol_v2_badge: '自研 / 稳定推荐',
    protocol_v2_pros: '优势：毫秒级断点续传、分块确认(ACK)防丢包、双向暂停恢复与网络自动重连。',
    protocol_v2_cons: '缺点：带有二进制分帧与 ACK 心跳开销。',
    protocol_v2_scenario: '适用：跨端日常互传、大文件传输、Wi-Fi 波动弱网环境。',
    protocol_v2_client: '兼容：Nearby Transfer 官方桌面与移动端',
    protocol_turbo_name: 'Turbo 极速多通道并发协议',
    protocol_turbo_badge: '4~8路并发 / 千兆极限',
    protocol_turbo_pros: '优势：4~8 路并发管道高速分片吞吐，极限压榨 Wi-Fi 6 / 2.5G 千兆局域网硬件带宽。',
    protocol_turbo_cons: '缺点：并发占用较多系统 Socket，对老旧弱单核路由器有一定压力。',
    protocol_turbo_scenario: '适用：强信号 5GHz Wi-Fi / 有线千兆内网、传输 5GB+ 4K 电影与超大文件。',
    protocol_turbo_client: '兼容：Nearby Transfer Turbo 极速引擎',
    protocol_quic_name: 'QUIC / UDP 极速抗弱网协议',
    protocol_quic_badge: 'UDP / 0-RTT 弱网利器',
    protocol_quic_pros: '优势：基于 UDP 彻底无队头阻塞，丢包率 20%~30% 时仍能维持极高速率，0-RTT 极速握手。',
    protocol_quic_cons: '缺点：部分严格企业/校园网防火墙会限制或阻断 UDP 流量。',
    protocol_quic_scenario: '适用：弱信号 Wi-Fi 边缘、公共咖啡厅热点、手机移动热点共享。',
    protocol_quic_client: '兼容：Nearby Transfer QUIC 加速引擎',
    protocol_smb_name: 'SMB 3.0 局域网网络邻居协议',
    protocol_smb_badge: '免装客户端 / 系统原生',
    protocol_smb_pros: '优势：Windows 资源管理器与 macOS Finder 原生直接挂载，无需安装任何 App 即可直接双击打开与编辑。',
    protocol_smb_cons: '缺点：跨网段容易被防火墙拦截 445 端口，协议握手较重。',
    protocol_smb_scenario: '适用：办公室局域网电脑互访、家庭局域网多设备文件免装客户端直拷。',
    protocol_smb_client: '兼容：Windows 资源管理器、Mac Finder、Linux Samba',
    protocol_webdav_name: 'WebDAV 直连云盘同步协议',
    protocol_webdav_badge: 'RFC 4918 / 云盘挂载',
    protocol_webdav_pros: '优势：基于标准 RFC 4918 协议，支持手机直接挂载电脑磁盘、在线浏览与按需下载点播。',
    protocol_webdav_cons: '缺点：散碎小文件浏览时有 XML 元数据解析开销。',
    protocol_webdav_scenario: '适用：手机文件管理器挂载电脑共享库、照片库增量自动备份、在线视频播放。',
    protocol_webdav_client: '兼容：Android SAF、Solid Explorer、WPS、Infuse',
    protocol_v1_name: 'V1 经典 HTTP 流加密协议',
    protocol_v1_badge: '轻量 / 极低开销',
    protocol_v1_pros: '优势：标准 RESTful HTTP 流式传输，防火墙穿透性极好，内存与 CPU 占用极低。',
    protocol_v1_cons: '缺点：不支持细粒度分块断点重续，传输中断需整体重试。',
    protocol_v1_scenario: '适用：低功耗/低配设备、老旧路由器、散碎小文件与日常照片。',
    protocol_v1_client: '兼容：通用 HTTP 客户端、Web 浏览器、Nearby Transfer v1',
    protocol_ftps_name: 'FTPS 极速安全传输服务协议',
    protocol_ftps_badge: 'TLS 加密 / 专业工具',
    protocol_ftps_pros: '优势：数十年工业级验证的高速传输协议，完美适配第三方专业文件管理工具。',
    protocol_ftps_cons: '缺点：主动/被动模式对复杂 NAT 端口映射要求较高。',
    protocol_ftps_scenario: '适用：专业开发者、Linux 终端脚本同步、开发板与 NAS 极速拉取。',
    protocol_ftps_client: '兼容：FileZilla、Total Commander、ES 文件浏览器、lftp',
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
    initial_status: 'Select a file first, then choose a nearby device.',
    nearby_peers: 'Nearby Devices',
    refresh_peers: 'Refresh Devices',
    this_device: 'This Device',
    device_name_label: 'Name',
    device_starting: 'Starting…',
    save_directory_label: 'Save received files to',
    change_save_dir: 'Change Save Location',
    reset_save_dir: 'Reset to Default Downloads',
    nas_library_title: 'NAS Shared Library (WebDAV)',
    library_ready_badge: 'Ready',
    library_intro: 'Mobile and other devices can directly access and sync files via controlled session or WebDAV.',
    current_share_folder: 'Current Shared Folder',
    loading: 'Loading…',
    webdav_url_label: 'Local WebDAV URL',
    change_share_folder: 'Change Shared Folder',
    open_in_explorer: 'Open in File Explorer',
    reset_share_folder: 'Reset to Default Share',
    copy_webdav_url: 'Copy WebDAV URL',
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
    v2_trusted_help: 'Paired devices with saved public keys; allows fast transfers & library sync.',
    v2_no_trusted_devices: 'No trusted devices yet.',
    btn_pair: 'Pair',
    btn_confirm: 'Confirm Code',
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
    revoke_confirm: 'Are you sure you want to revoke trust for "%1$s"? Future transfers will require pairing again.',
    pair_request_sent: 'Pairing request sent to %1$s. Please verify the code on their device.',
    pair_confirmed_waiting: 'Confirmed on this device. Waiting for remote device confirmation…',
    pair_complete_trusted: 'Pairing successful! %1$s has been added to trusted devices.',
    protocol_settings_title: 'Transfer Protocol Matrix',
    protocol_settings_subtitle: 'Seamlessly switch across 7 mainstream protocols (Fast P2P, OS Native, Standard Services)',
    protocol_category_all: 'All Protocols (7)',
    protocol_category_fast: '🚀 Fast P2P',
    protocol_category_system: '🪟 OS Native Share',
    protocol_category_standard: '🌐 Standard Services',
    protocol_v2_name: 'V2 Robust Stream Protocol',
    protocol_v2_badge: 'In-House / Recommended',
    protocol_v2_pros: 'Pros: Resumable checkpoints, chunk-level ACKs, bidirectional pause/resume & auto reconnect.',
    protocol_v2_cons: 'Cons: Lightweight binary framing and ACK heartbeat overhead.',
    protocol_v2_scenario: 'Best for: Cross-device transfers, large files, fluctuating Wi-Fi.',
    protocol_v2_client: 'Clients: Nearby Transfer Desktop & Mobile',
    protocol_turbo_name: 'Turbo Parallel Multi-Stream',
    protocol_turbo_badge: '4~8 Streams / Gigabit Limit',
    protocol_turbo_pros: 'Pros: 4~8 parallel streams, multi-chunk parallel throughput, saturating Wi-Fi 6 & 2.5G LAN.',
    protocol_turbo_cons: 'Cons: Consumes more system sockets; higher load on weak routers.',
    protocol_turbo_scenario: 'Best for: Strong 5GHz Wi-Fi / Gigabit LAN, 5GB+ 4K movies & large archives.',
    protocol_turbo_client: 'Clients: Nearby Transfer Turbo Engine',
    protocol_quic_name: 'QUIC / UDP Fast Loss-Tolerant',
    protocol_quic_badge: 'UDP / 0-RTT Anti-Loss',
    protocol_quic_pros: 'Pros: Zero head-of-line blocking on UDP, maintains high speed with 20%~30% loss, 0-RTT handshake.',
    protocol_quic_cons: 'Cons: Some strict enterprise / campus firewalls may throttle or block UDP.',
    protocol_quic_scenario: 'Best for: Weak Wi-Fi edges, public coffee shop hotspots, cellular hotspot tethering.',
    protocol_quic_client: 'Clients: Nearby Transfer QUIC Engine',
    protocol_smb_name: 'SMB 3.0 LAN Network Share',
    protocol_smb_badge: 'No App Needed / OS Native',
    protocol_smb_pros: 'Pros: Native direct mount on Windows Explorer & Mac Finder without installing apps, in-place edit.',
    protocol_smb_cons: 'Cons: Port 445 often blocked across subnets; heavier protocol handshake.',
    protocol_smb_scenario: 'Best for: Office LAN PC-to-PC file browsing, home LAN direct copy without installing apps.',
    protocol_smb_client: 'Clients: Windows File Explorer, Mac Finder, Linux Samba',
    protocol_webdav_name: 'WebDAV Direct Cloud Sync',
    protocol_webdav_badge: 'RFC 4918 / Cloud Mount',
    protocol_webdav_pros: 'Pros: RFC 4918 standard, mount as mobile drive, online browsing & on-demand video streaming.',
    protocol_webdav_cons: 'Cons: XML metadata parsing overhead on massive small file hierarchies.',
    protocol_webdav_scenario: 'Best for: Mobile file manager disk mounting, automated photo backups, video streaming.',
    protocol_webdav_client: 'Clients: Android SAF, Solid Explorer, WPS, Infuse',
    protocol_v1_name: 'V1 Classic HTTP Stream',
    protocol_v1_badge: 'Lightweight / Low CPU',
    protocol_v1_pros: 'Pros: Standard RESTful HTTP stream, great firewall compatibility, lowest CPU & RAM usage.',
    protocol_v1_cons: 'Cons: No fine-grained chunk resume; full restart needed on connection drop.',
    protocol_v1_scenario: 'Best for: Low-end devices, legacy routers, small photos & documents.',
    protocol_v1_client: 'Clients: Web Browsers, generic HTTP clients, Nearby Transfer v1',
    protocol_ftps_name: 'FTPS Secure High-Speed Transfer',
    protocol_ftps_badge: 'TLS Encrypted / Pro Tools',
    protocol_ftps_pros: 'Pros: Decades of industrial verification, perfect compatibility with professional FTP tools.',
    protocol_ftps_cons: 'Cons: Active/passive modes require NAT port configurations.',
    protocol_ftps_scenario: 'Best for: Developers, Linux terminal sync, devboards and NAS rapid pull.',
    protocol_ftps_client: 'Clients: FileZilla, Total Commander, ES File Explorer, lftp',
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
