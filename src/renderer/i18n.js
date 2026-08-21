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
    lang_toggle_zh: '中文',
    lang_toggle_en: 'English'
  }
};

let currentLang = 'zh';

function getInitialLanguage() {
  const saved = localStorage.getItem('nearby_transfer_lang');
  if (saved && (saved === 'zh' || saved === 'en')) {
    return saved;
  }
  const sysLang = (navigator.language || '').toLowerCase();
  return sysLang.startsWith('zh') ? 'zh' : 'en';
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
  } catch (_) {}
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
