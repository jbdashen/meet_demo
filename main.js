// Electron 主进程: 创建窗口, 加载渲染层
const { app, BrowserWindow, Menu, ipcMain, desktopCapturer, session } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

// 打包后应用代码在只读的 app.asar 内, 注入用 HTML 必须写到可写的 userData;
// 同时注入 <base>, 让其中相对路径的 css/js 仍指向 asar 内的 renderer 目录
function buildInjectedHtml(htmlName, replacements) {
  const rendererDir = path.join(__dirname, 'renderer');
  let html = fs.readFileSync(path.join(rendererDir, htmlName), 'utf-8');
  for (const [k, v] of Object.entries(replacements || {})) html = html.split(k).join(v);
  const baseUri = 'file:///' + rendererDir.replace(/\\/g, '/').replace(/^\//, '') + '/';
  if (!/<base /i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => `${m}<base href="${baseUri}">`);
  }
  const outDir = path.join(app.getPath('userData'), 'injected');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, '.' + htmlName.replace(/\.html$/, '') + '.injected.html');
  fs.writeFileSync(outPath, html);
  return outPath;
}

// 屏幕共享: 通过 IPC 让渲染层获取桌面源(desktopCapturer 只能在主进程用)
ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

// 渲染进程选好屏幕源后, 把 id 存到这里, 供 getDisplayMedia handler 使用
let pendingSourceId = null;
ipcMain.handle('set-screen-source', (e, id) => {
  pendingSourceId = id;
});

// getDisplayMedia 的请求处理: 用渲染进程预选的源, 走 Chromium 原生捕获路径(渲染更稳定)
ipcMain.handle('init-display-media', () => {
  const ses = session.defaultSession;
  if (ses.displayMediaHandlerRegistered) return;
  ses.displayMediaHandlerRegistered = true;
  ses.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      const src = sources.find((s) => s.id === pendingSourceId) || sources[0];
      callback({ video: src, audio: false });
    }).catch(() => callback(null));
  });
});

// 窗口全屏: 用 Electron 原生 setFullScreen, 避免 HTML5 全屏在屏幕共享时递归
ipcMain.handle('set-fullscreen', (e, flag) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.setFullScreen(!!flag);
  return win ? win.isFullScreen() : false;
});
ipcMain.handle('is-fullscreen', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win ? win.isFullScreen() : false;
});

// 屏幕共享时主窗口最小化/恢复(避免会议窗口出现在共享画面里导致递归)
ipcMain.handle('minimize-window', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.minimize();
});
ipcMain.handle('restore-window', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) { win.restore(); win.focus(); }
});

// 摄像头置顶小窗: 共享屏幕时浮在屏幕上方, 显示所有参会者摄像头, 可拖拽
let pipWindow = null;
ipcMain.handle('open-camera-pip', (e, roomId, signalUrl, selfId) => {
  if (pipWindow && !pipWindow.isDestroyed()) return;
  // 面板跟随当前实际连接的主机地址(远程联机时是对端 Radmin IP), 通过 query 传递不污染进程 env
  const panelUrl = signalUrl || activeUrl();
  const panelSelf = selfId || '';
  pipWindow = new BrowserWindow({
    width: 220,
    height: 200,
    minWidth: 200,
    minHeight: 120,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  pipWindow.setAlwaysOnTop(true, 'screen-saver');
  // 默认贴屏幕右侧
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay().workAreaSize;
  pipWindow.setPosition(display.width - 240, 80);
  // 替换 CSP 占位符后写到可写目录加载(打包后 asar 只读)
  const panelTarget = buildInjectedHtml('video-panel.html', { __SIGNAL_URL__: panelUrl });
  pipWindow.loadFile(panelTarget, {
    query: { room: roomId || '100', signal: panelUrl, self: panelSelf },
  });
  // 转发面板日志到主进程
  pipWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[panel] ${message} (line ${line})`);
  });
  // 浮窗关闭(X / close-camera-pip / 主窗口退出)时通知主窗口同步按钮状态
  pipWindow.on('closed', () => {
    pipWindow = null;
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('camera-pip-closed');
    }
  });
});
ipcMain.handle('close-camera-pip', () => {
  if (pipWindow && !pipWindow.isDestroyed()) {
    pipWindow.close();
  }
});
// 面板高度随参会人数自适应: 1 人只占一格, 人多则增高(不超过屏幕)
// width 传 0/省略 = 保持当前宽度; 宽度永不在此改变, 切断"测量宽度→resize→回流"的反馈环
ipcMain.handle('resize-camera-pip', (e, width, height) => {
  if (!pipWindow || pipWindow.isDestroyed()) return;
  const { screen } = require('electron');
  const maxH = screen.getPrimaryDisplay().workAreaSize.height - 20;
  const h = Math.max(120, Math.min(Math.round(height), maxH));
  const b = pipWindow.getBounds();
  const w = width ? Math.round(width) : b.width;
  // 尺寸完全相同则跳过: setBounds 即便同值也会触发重排/重绘, 累积起来表现为抖动
  if (w === b.width && h === b.height) return;
  // 保持顶部位置不变, 向下生长
  pipWindow.setBounds({ x: b.x, y: b.y, width: w, height: h });
});
// 小窗通知主窗口停止共享
ipcMain.handle('pip-stop-share', (e) => {
  // 通知渲染层停止共享
  const mainWin = BrowserWindow.getAllWindows().find((w) => w !== pipWindow);
  if (mainWin) mainWin.webContents.send('stop-share-from-pip');
});

// 开发时把 userData 指到项目本地目录, 避开 Windows 全局缓存目录的权限冲突;
// 打包后 __dirname 在 只读 app.asar 内, 必须用系统默认的可写 userData (%APPDATA%/MeetDemo)
// MEET_USER_DATA 仅用于本机双开自测(第二个实例需要独立 userData 避开单例锁)
if (process.env.MEET_USER_DATA) {
  app.setPath('userData', process.env.MEET_USER_DATA);
} else if (!app.isPackaged) {
  app.setPath('userData', path.join(__dirname, '.electron_user_data'));
}
app.commandLine.appendSwitch('allow-running-insecure-content');
// 开启硬件加速, 禁止窗口遮挡检测(避免被遮挡时停止渲染导致黑屏)
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// 开启桌面捕获(屏幕共享), getDisplayMedia / desktop capture 需要
app.commandLine.appendSwitch('enable-media-stream-capture');
app.commandLine.appendSwitch('enable-desktop-capture');

// ---------- 本机网卡 IP ----------
function listLocalIPv4() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name]) {
      if (info.family === 'IPv4' && !info.internal) out.push({ address: info.address, name });
    }
  }
  return out;
}
// Radmin VPN / Hamachi 等虚拟局域网默认使用 25.x / 26.x 段, 优先识别
function isVirtualLanIp(a) { return /^(25|26)\./.test(a); }
// 挑选默认信令地址: 虚拟局域网 IP > 家宽 192.168/10 > 其他
function pickLocalIp() {
  const all = listLocalIPv4().map((x) => x.address);
  return (
    all.find(isVirtualLanIp)
    || all.find((a) => /^192\.168\./.test(a) || /^10\./.test(a))
    || all.find((a) => !/^127\./.test(a) && !/^172\.(1[6-9]|2\d|3[01])\./.test(a))
    || '127.0.0.1'
  );
}
const SIGNAL_PORT = 3001;
const SIGNAL_URL = `http://${pickLocalIp()}:${SIGNAL_PORT}`;

// 让同进程的 preload 能读到真实信令地址(远程主机模式下会被更新成主机地址)
process.env.MEET_SIGNAL_URL = SIGNAL_URL;

// 把用户输入规范化成纯 host(去协议/路径/端口)
function normalizeHost(input) {
  if (!input) return '';
  return String(input).trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0].split(':')[0];
}
function hostIsLocal(host) {
  const h = normalizeHost(host);
  if (!h || h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  return listLocalIPv4().some((x) => x.address.toLowerCase() === h);
}
function isReachable(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} resolve(v); } };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    setTimeout(() => finish(false), timeout);
  });
}

// ---------- 信令服务器管理 ----------
// 模式: local = 本机作为主机(拉起/管理本地服务器); remote = 加入别人的主机(仅探测)
let signalChild = null;
let signalState = 'stopped';   // starting | running | stopped | error
let signalMode = null;         // 'local' | 'remote'
let signalExternal = false;    // local 模式下端口被外部进程占用
let activeHost = pickLocalIp();
let remotePoll = null;

function activeUrl() { return `http://${activeHost}:${SIGNAL_PORT}`; }

function broadcastSignalState(state, extra = {}) {
  signalState = state;
  const payload = {
    state, mode: signalMode, external: signalExternal,
    host: activeHost, url: activeUrl(), ...extra,
  };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('signal-server-status', payload);
  }
  console.log(`[signal] state -> ${state} (${signalMode || 'none'}${signalExternal ? ',external' : ''}) ${activeUrl()}`);
}

function startLocalServer() {
  return new Promise((resolve) => {
    if (signalState === 'running' || signalState === 'starting') return resolve();
    broadcastSignalState('starting');
    isReachable('127.0.0.1', SIGNAL_PORT).then((portBusy) => {
      if (portBusy) {
        // 端口已被占: 外部已运行服务器, 直接当作可用
        signalExternal = !signalChild;
        broadcastSignalState('running', { external: signalExternal });
        return resolve();
      }
      signalExternal = false;
      const serverPath = path.join(__dirname, 'server', 'index.js');
      // NODE_PATH 指向打包后 asar 内的 node_modules, 保证子进程能 require 到 socket.io
      const modulesDir = path.join(__dirname, 'node_modules');
      let child;
      try {
        child = spawn(process.execPath, [serverPath], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            PORT: String(SIGNAL_PORT),
            NODE_PATH: modulesDir + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : ''),
          },
          cwd: app.getPath('userData'),
        });
      } catch (err) {
        broadcastSignalState('error', { message: err.message });
        return resolve();
      }
      signalChild = child;
      let started = false;
      child.stdout.on('data', (d) => {
        const s = d.toString();
        console.log(`[signal-server] ${s.trim()}`);
        if (!started && s.includes('listening')) {
          started = true;
          broadcastSignalState('running', { external: false });
          resolve();
        }
      });
      child.stderr.on('data', (d) => console.log(`[signal-server-err] ${d.toString().trim()}`));
      child.on('exit', () => {
        if (signalChild === child) signalChild = null;
        if (!started) {
          // 未等到 listening 就退出: 多为 EADDRINUSE, 按"外部已在运行"处理
          signalExternal = true;
          broadcastSignalState('running', { external: true });
        } else {
          broadcastSignalState('stopped');
        }
        resolve();
      });
    });
  });
}

function stopLocalServer() {
  if (signalExternal || !signalChild) {
    broadcastSignalState(signalChild ? signalState : 'stopped');
    return;
  }
  killSignalChild();
  broadcastSignalState('stopped');
}

// 杀掉本应用拉起的信令服务器: 先 kill, Windows 再用 taskkill /T /F 兜底杀进程树,
// 防止残留 node 子进程继续占用 3001 端口(下次打开软件时被误判为"外部服务器")
let killing = false;
function killSignalChild() {
  const child = signalChild;
  signalChild = null;
  if (!child || child.killed || killing) return;
  killing = true;
  const pid = child.pid;
  try { child.kill(); } catch (_) {}
  if (pid && process.platform === 'win32') {
    try {
      // 同步执行, 保证应用退出前终止命令已发出
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } catch (_) {}
  }
  killing = false;
}

function stopRemotePoll() {
  if (remotePoll) { clearInterval(remotePoll); remotePoll = null; }
}

function startRemotePoll() {
  stopRemotePoll();
  remotePoll = setInterval(async () => {
    const ok = await isReachable(activeHost, SIGNAL_PORT);
    const want = ok ? 'running' : 'error';
    if (signalState !== want) broadcastSignalState(want);
  }, 3000);
}

// 统一入口: 本机地址 -> 启动本地服务器; 远程地址 -> 仅探测+轮询
async function connectSignal(rawHost) {
  stopRemotePoll();
  const host = normalizeHost(rawHost) || pickLocalIp();
  activeHost = host;
  if (hostIsLocal(host)) {
    signalMode = 'local';
    await startLocalServer();
    return;
  }
  // 远程模式: 关闭本应用自起的本地服务器(外部手动启动的不动), 只探测对端
  if (signalChild) killSignalChild();
  signalMode = 'remote';
  signalExternal = false;
  broadcastSignalState('starting');
  const ok = await isReachable(host, SIGNAL_PORT);
  broadcastSignalState(ok ? 'running' : 'error');
  startRemotePoll();
}

function disconnectSignal() {
  stopRemotePoll();
  if (signalMode === 'local') stopLocalServer();
  else broadcastSignalState('stopped');
}

ipcMain.handle('signal-server-connect', (e, host) => connectSignal(host));
ipcMain.handle('signal-server-disconnect', () => disconnectSignal());
ipcMain.handle('signal-server-status', () => ({
  state: signalState, mode: signalMode, external: signalExternal,
  host: activeHost, url: activeUrl(),
}));
ipcMain.handle('list-local-ips', () => {
  const list = listLocalIPv4();
  const preferred = pickLocalIp();
  return { list, preferred };
});

// 入会前小窗 / 会议中大窗切换
ipcMain.handle('set-window-mode', (e, mode) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (mode === 'meeting') {
    win.setSize(1080, 720);
  } else {
    win.setSize(400, 500);
  }
  win.center();
});

function createWindow() {
  const win = new BrowserWindow({
    width: 400,
    height: 500,
    title: '会议 Demo',
    backgroundColor: '#1e1e24',
    webPreferences: {
      // 屏幕共享需要 navigator.getDisplayMedia, 桌面端 Electron 原生支持
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 最小化共享屏幕时不能节流, 否则 WebRTC 卡住
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
    },
  });

  // 移除菜单栏, 更接近会议客户端
  Menu.setApplicationMenu(null);
  win.setMenuBarVisibility(false);

  // 转发渲染层 console / JS 报错到主进程, 便于定位"点不动"的问题
  win.webContents.on('console-message', (e, level, message, line) => {
    console.log(`[renderer][${level}] ${message} (line ${line})`);
  });
  win.webContents.on('did-fail-load', (e, code, desc) => {
    console.log(`[renderer] did-fail-load ${code} ${desc}`);
  });

  // 主窗口被关闭(X / Alt+F4 / 任务栏关闭)时: 置顶浮窗是独立窗口,
  // 不主动关掉它会导致 app 因仍有窗口而不退出, 留下看不见的后台进程。
  // 这里连带销毁浮窗并显式退出, 之后 before-quit 会停掉信令服务器。
  win.on('close', (e) => {
    console.log('[main] main window close event; pipWindow =', pipWindow && !pipWindow.isDestroyed() ? 'alive' : 'null');
    // 先销毁记录在案的浮窗
    if (pipWindow && !pipWindow.isDestroyed()) {
      pipWindow.destroy();
      pipWindow = null;
    }
    // 兜底: 销毁其余所有非主窗口(任何遗漏的独立窗口都会阻止 app 退出)
    for (const w of BrowserWindow.getAllWindows()) {
      if (w !== win && !w.isDestroyed()) w.destroy();
    }
    // 显式退出, 不依赖 window-all-closed 的时序
    setImmediate(() => app.quit());
  });

  // 注入信令地址后写到可写目录加载(打包后 asar 只读, 见 buildInjectedHtml)
  const target = buildInjectedHtml('index.html', { __SIGNAL_URL__: SIGNAL_URL });
  console.log(`[meet_demo] signaling url -> ${SIGNAL_URL}`);
  win.loadFile(target);
}

app.whenReady().then(() => {
  // 默认不自动开启信令服务器: 用户在面板点"连接"(本机 IP=作为主机启动, 远程 IP=仅连接)
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出时关掉本应用拉起的信令服务器与远程探测(外部进程不动)
app.on('before-quit', () => {
  stopRemotePoll();
  killSignalChild();
});
// 兜底: 进程直接退出/异常终止路径下也尽力关掉服务器
app.on('will-quit', () => {
  stopRemotePoll();
  killSignalChild();
});
process.on('exit', () => {
  stopRemotePoll();
  killSignalChild();
});
