// preload: 暴露最小 API 给渲染层
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 渲染层主要用 WebRTC API(getUserMedia/getDisplayMedia), Electron 默认已支持
  // 这里暴露一个标识, 方便渲染层确认运行在桌面环境
  isDesktop: true,
  // 主进程算好的信令地址(真实 IP), 渲染层优先用它, 避免 location.hostname 回退到 localhost
  SIGNAL_URL: process.env.MEET_SIGNAL_URL || '',
  // 屏幕共享: 获取桌面源列表
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  // 把选中的屏幕源 id 传给主进程, 供 getDisplayMedia handler 使用
  setScreenSource: (id) => ipcRenderer.invoke('set-screen-source', id),
  // 初始化 getDisplayMedia 请求处理器(只需调用一次)
  initDisplayMedia: () => ipcRenderer.invoke('init-display-media'),
  // 屏幕共享时主窗口最小化/恢复(避免递归)
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  restoreWindow: () => ipcRenderer.invoke('restore-window'),
  // 摄像头置顶小窗(signalUrl 可选: 远程联机时传主机信令地址; selfId: 本机主窗口 socket id, 面板据此镜像自己)
  openCameraPip: (roomId, signalUrl, selfId) => ipcRenderer.invoke('open-camera-pip', roomId, signalUrl, selfId),
  closeCameraPip: () => ipcRenderer.invoke('close-camera-pip'),
  // 浮窗被关闭(自身 X / 主窗口退出)时通知主窗口同步按钮状态
  onCameraPipClosed: (cb) => ipcRenderer.on('camera-pip-closed', cb),
  // 面板随人数自适应高度
  resizeCameraPip: (w, h) => ipcRenderer.invoke('resize-camera-pip', w, h),
  // 小窗停止共享
  onStopShareFromPip: (cb) => ipcRenderer.on('stop-share-from-pip', cb),
  // 小窗调用: 通知主窗口停止共享
  stopShare: () => ipcRenderer.invoke('pip-stop-share'),
  // 窗口全屏: 用 Electron 原生 setFullScreen, 避免 HTML5 全屏递归问题
  setFullScreen: (flag) => ipcRenderer.invoke('set-fullscreen', flag),
  isFullScreen: () => ipcRenderer.invoke('is-fullscreen'),
  // 信令服务器: 连接(本机地址=起服务器, 远程地址=仅连接)/断开/状态/订阅/本机IP列表
  signalServer: {
    connect: (host) => ipcRenderer.invoke('signal-server-connect', host),
    disconnect: () => ipcRenderer.invoke('signal-server-disconnect'),
    status: () => ipcRenderer.invoke('signal-server-status'),
    onChange: (cb) => ipcRenderer.on('signal-server-status', (_e, s) => cb(s)),
    listLocalIps: () => ipcRenderer.invoke('list-local-ips'),
  },
  // 入会前小窗 / 会议中大窗
  setWindowMode: (mode) => ipcRenderer.invoke('set-window-mode', mode),
});
