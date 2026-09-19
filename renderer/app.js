// 会议 demo 渲染层逻辑: 信令 + WebRTC mesh (语音/摄像头/屏幕共享)
(() => {
  'use strict';

  // 信令服务地址: 优先取 preload 注入的真实 IP(window.api.SIGNAL_URL, 由 main.js 计算)
  // 再回退到页面注入的 window.SIGNAL_URL, 最后回退到同源的 http://<当前主机>:3001
  function resolveSignalUrl() {
    if (window.api && window.api.SIGNAL_URL) return window.api.SIGNAL_URL;
    if (window.SIGNAL_URL) return window.SIGNAL_URL;
    const host = location.hostname || 'localhost';
    return `http://${host}:3001`;
  }
  const SIGNAL_URL = resolveSignalUrl();

  // 状态
  let socket = null;
  let myId = null;
  let roomId = null;
  let localStream = null;   // 摄像头 + 麦克风
  let screenStream = null;  // 屏幕共享流
  let activeLocalTrackType = 'camera'; // camera | screen

  // 单格放大层状态(模块作用域, 供远端屏幕格子结束时自动退出)
  let focusStream = null;
  let closeFocus = () => {};

  // peerId -> { pc, remoteStream }
  const peers = new Map();

  // DOM
  const $ = (id) => document.getElementById(id);
  const joinPanel = $('joinPanel');
  const meetView = $('meetView');
  const grid = $('grid');
  const localVideo = $('localVideo');
  const localLabel = $('localLabel');
  const localCell = $('localCell');
  const screenVideo = $('screenVideo');
  const screenCanvas = $('screenCanvas');
  const micSelect = $('micSelect');
  const camSelect = $('camSelect');
  const micMuteBtn = $('micMuteBtn');
  const camToggleBtn = $('camToggleBtn');
  const localName = $('localName');
  let screenRaf = null;

  // 置顶参会者浮窗开关状态(UI 态/变量/IPC 三者必须同步)
  let pipOpen = false;
  const pipBtn = $('pipBtn');
  function setPipOpen(on) {
    pipOpen = !!on;
    if (pipBtn) {
      pipBtn.textContent = pipOpen ? '关闭浮窗' : '参会者浮窗';
      pipBtn.classList.toggle('on', pipOpen);
    }
  }

  // ---------- WebRTC 网络/画质调优参数 ----------
  // ICE: 多 STUN(国内+Google, Radmin/局域网环境主要走 host 候选, STUN 仅兜底);
  // iceCandidatePoolSize 预收集候选, 入会后/ICE 重启时建连更快, 弱网切换更顺滑
  const cfg = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.qq.com:3478' },
      { urls: 'stun:stun.miwifi.com:3478' },
    ],
    iceCandidatePoolSize: 4,
    bundlePolicy: 'max-bundle',   // 音视频/屏幕复用同一传输, 减少弱网下的通道开销
    rtcpMuxPolicy: 'require',
  };

  // 发送端编码档位: 屏幕共享按"分辨率×帧率"给足码率, 这是 1K 清晰的关键
  // (不显式设置时 Chromium 默认码率上限偏低, 高动态画面会被压糊)
  // [30fps 档, 60fps 档], 单位 bps
  const SCREEN_BITRATE = {
    '1920x1080': [4_500_000, 9_000_000],   // 1K: 30fps 4.5M / 60fps 9M
    '2560x1440': [8_000_000, 14_000_000],  // 2K
    '3840x2160': [16_000_000, 28_000_000], // 4K
  };
  // 摄像头档位: 720p 流畅优先
  const CAMERA_PROFILE = { maxBitrate: 1_200_000, maxFramerate: 30, degradation: 'maintain-framerate' };
  // 音频: Opus 32kbps, 弱网靠 FEC 抗丢包 + DTX 静音省带宽(另在 SDP 里开启)
  const AUDIO_PROFILE = { maxBitrate: 32_000 };
  // 当前屏幕共享的发送档位, 共享开始时根据用户选择计算
  let screenProfile = null;

  // 应用单个 sender 的编码参数(码率上限/帧率上限/弱网降级方向/优先级)
  async function tuneSender(sender, profile) {
    if (!sender || !profile) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      const enc = params.encodings[0];
      if (profile.maxBitrate != null) enc.maxBitrate = profile.maxBitrate;
      if (profile.maxFramerate != null) enc.maxFramerate = profile.maxFramerate;
      if (profile.degradation) {
        // maintain-framerate: 弱网降分辨率保帧率(60fps 流畅档, 宁糊不卡)
        // maintain-resolution: 弱网丢帧保清晰度(30fps 清晰档, 文字始终锐利)
        params.degradationPreference = profile.degradation;
      }
      if (profile.priority) enc.priority = profile.priority;
      if (profile.networkPriority) enc.networkPriority = profile.networkPriority;
      // 屏幕捕获常按显示器原生分辨率出帧, 用缩放系数强制编码到用户选定的分辨率
      enc.scaleResolutionDownBy = profile.scaleResolutionDownBy != null ? profile.scaleResolutionDownBy : 1;
      await sender.setParameters(params);
    } catch (e) {
      console.log('[webrtc] tuneSender failed:', e && e.message);
    }
  }

  // 给一条 PC 的所有发送轨按类型应用档位
  function applySendProfiles(pc) {
    for (const sender of pc.getSenders()) {
      const t = sender.track;
      if (!t) continue;
      if (t.kind === 'video') {
        tuneSender(sender, t._screen && screenProfile ? screenProfile : CAMERA_PROFILE);
      } else if (t.kind === 'audio') {
        tuneSender(sender, AUDIO_PROFILE);
      }
    }
  }

  // 视频编码优先 H.264: Windows 上走硬件编码, 1K 屏幕共享的压缩效率/延迟都优于软编;
  // 不支持时浏览器自动回退 VP9/VP8。RTX 重传码必须紧跟其对应的主编码, 顺序需小心
  function preferH264(pc) {
    try {
      const caps = typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities
        ? RTCRtpReceiver.getCapabilities('video') : null;
      if (!caps || !caps.codecs) return;
      const h264 = caps.codecs.filter((c) => /video\/h264/i.test(c.mimeType) && !/rtx/i.test(c.mimeType));
      if (!h264.length) return;
      const h264Pts = new Set(h264.map((c) => String(c.payloadType)));
      const isRtxForH264 = (c) => /video\/rtx/i.test(c.mimeType)
        && c.sdpFmtpLine && [...h264Pts].some((pt) => new RegExp('apt=' + pt + '\\b').test(c.sdpFmtpLine));
      // 顺序: H264 主码 -> 对应的 rtx, 其余编码保持原相对顺序
      const rtx = caps.codecs.filter(isRtxForH264);
      const rest = caps.codecs.filter((c) => !h264.includes(c) && !rtx.includes(c));
      const ordered = [...h264, ...rtx, ...rest];
      for (const tr of pc.getTransceivers()) {
        const kind = (tr.sender && tr.sender.track && tr.sender.track.kind)
          || (tr.receiver && tr.receiver.track && tr.receiver.track.kind);
        if (kind === 'video') {
          try { tr.setCodecPreferences(ordered); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  // 接收端低延迟: 缩小抖动缓冲目标。弱网下迟到的视频帧直接丢弃,
  // 画面"跳帧跟随"而不是"堆积延迟后卡顿", 体感更流畅
  function tuneReceiver(receiver, kind) {
    if (kind !== 'video') return;
    try {
      if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0.2;
      else if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0.2;
    } catch (_) {}
  }

  function tuneAllReceivers(pc) {
    for (const r of pc.getReceivers()) tuneReceiver(r, r.track ? r.track.kind : '');
  }

  // 协商前的统一调优入口
  function applyPcTuning(pc) {
    preferH264(pc);
    applySendProfiles(pc);
    tuneAllReceivers(pc);
  }

  // SDP 微调: 给 Opus 音频打开带内 FEC(丢包重建) 与 DTX(静音不发包),
  // 限制 32kbps —— 网速差时声音仍连贯, 且不与屏幕抢带宽
  function mungeLocalSdp(desc) {
    try {
      const CRLF = '\r\n';
      const lines = desc.sdp.split(/\r?\n/).filter(Boolean);
      const opusPts = new Set();
      for (const line of lines) {
        const m = /^a=rtpmap:(\d+)\s+opus\/48000/i.exec(line);
        if (m) opusPts.add(m[1]);
      }
      if (!opusPts.size) return desc;
      for (let i = 0; i < lines.length; i++) {
        const m = /^a=fmtp:(\d+)\s*(.*)$/.exec(lines[i]);
        if (!m || !opusPts.has(m[1])) continue;
        const add = [];
        if (!/useinbandfec=/i.test(m[2])) add.push('useinbandfec=1');
        if (!/usedtx=/i.test(m[2])) add.push('usedtx=1');
        if (!/maxaveragebitrate=/i.test(m[2])) add.push('maxaveragebitrate=32000');
        if (add.length) lines[i] = m[2] ? `a=fmtp:${m[1]} ${m[2]};${add.join(';')}` : `a=fmtp:${m[1]} ${add.join(';')}`;
      }
      desc.sdp = lines.join(CRLF) + CRLF;
    } catch (_) {}
    return desc;
  }

  // ---------- 工具 ----------
  function makeCell(peerId, label, remote = false) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.peerId = peerId;
    const v = document.createElement('video');
    v.autoplay = true;
    v.playsinline = true;
    if (remote) v.muted = false;
    else v.muted = true;
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = label;
    const hint = document.createElement('div');
    hint.className = 'fs-hint';
    hint.textContent = '点击放大';
    cell.appendChild(v);
    cell.appendChild(l);
    cell.appendChild(hint);
    // 远端成员右下角麦克风角标(跟随对方静音状态); 本地格用昵称条里的音量水位, 不加
    let micEl = null;
    if (remote) {
      micEl = document.createElement('div');
      micEl.className = 'mic-indicator';
      micEl.title = '麦克风正常';
      micEl.textContent = '🎤';
      cell.appendChild(micEl);
    }
    grid.appendChild(cell);
    return { cell, video: v, labelEl: l, micEl };
  }

  // 更新远端成员麦克风角标: 🎤 正常 / 🔇 已静音
  function setRemoteMicMuted(peerId, muted) {
    const p = peers.get(peerId);
    const el = p && p.micEl;
    if (!el) return;
    el.textContent = muted ? '🔇' : '🎤';
    el.classList.toggle('muted', !!muted);
    el.title = muted ? '麦克风已静音' : '麦克风正常';
  }

  function setLocalVideoMuted(muted) {
    localVideo.muted = muted;
  }

  // ---------- 状态栏 ----------
  const statusConn = $('statusConn');
  const statusMedia = $('statusMedia');
  function setStatusMedia(msg, isErr = false) {
    if (!statusMedia) return;
    statusMedia.textContent = msg;
    statusMedia.classList.toggle('err', !!isErr);
  }
  function setConnStatus(text, ok = false) {
    if (!statusConn) return;
    statusConn.textContent = text;
    statusConn.classList.toggle('ok', ok);
    statusConn.classList.toggle('err', !ok && text !== '信令: 连接中…');
  }

  // ---------- 信令连接 ----------
  let signalUrl = SIGNAL_URL; // 当前实际连接的信令地址(可在面板切换主机)

  function bindSocketEvents(sock, url) {
    sock.on('connect', () => {
      myId = sock.id;
      console.log('[connect] socket connected, myId =', myId, url);
      setConnStatus('信令: 已连接 ' + url, true);
    });
    sock.on('disconnect', () => {
      setConnStatus('信令: 断开', false);
    });
    sock.on('connect_error', (e) => {
      setConnStatus('信令: 连接失败 (' + e.message + ')', false);
    });

    // 服务端告知: 新加入者收到的当前在线成员(带昵称/麦克风状态)
    sock.on('room_members', ({ others }) => {
      for (const m of others) {
        const pid = m.peerId || m;
        // __panel__ 是置顶浮窗的旁听连接: 建 PC 供它取流, 但不建格子/不计入人数
        if (m.nick && m.nick.startsWith('__panel__')) {
          getOrCreatePc(pid).isPanel = true;
          continue;
        }
        addRemoteCell(pid, m.nick, m.micMuted);
        getOrCreatePc(pid);
      }
    });

    // 有人进来(带昵称): 已有成员主动发起 offer
    sock.on('peer_joined', ({ peerId, nick }) => {
      const isPanel = nick && nick.startsWith('__panel__');
      if (isPanel) {
        // 浮窗需要本端主动 offer 才能收到画面; 标记后不计入人数
        getOrCreatePc(peerId).isPanel = true;
        createOfferTo(peerId);
        return;
      }
      addRemoteCell(peerId, nick);
      createOfferTo(peerId);
    });

    // 有人离开
    sock.on('peer_left', ({ peerId }) => {
      closePeer(peerId);
      removeRemoteCell(peerId);
      updateCount();
    });

    // 远端成员麦克风静音/取消静音: 同步其格子右下角角标
    sock.on('mic_state', ({ peerId, muted }) => {
      setRemoteMicMuted(peerId, muted);
    });

    // WebRTC 信令
    sock.on('webrtc_signal', (msg) => {
      const { targetId, kind, data, sourceId } = msg;
      if (targetId && targetId !== myId) return; // 不是发给我的
      handleSignal(sourceId, kind, data);
    });
  }

  // 首次连接 / 切换主机地址时重建 socket
  function ensureSocket(url) {
    if (!url) return;
    if (socket && socket.io && socket.io.uri === url) return;
    if (socket) {
      try { socket.removeAllListeners(); socket.disconnect(); } catch (_) {}
      socket = null;
    }
    signalUrl = url;
    // 只用 websocket: 跳过 polling 升级握手, 弱网下信令(ICE/重协商)延迟更低;
    // 重连起步快、上限低, 网络抖动后能迅速回到会议
    socket = io(url, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 200,
      reconnectionDelayMax: 2000,
      timeout: 5000,
    });
    bindSocketEvents(socket, url);
  }

  // 入会前等待信令连接就绪(最多 timeout 毫秒)
  function waitSignalConnected(timeout = 3500) {
    return new Promise((resolve) => {
      if (socket && socket.connected) return resolve(true);
      const t = setTimeout(() => resolve(!!(socket && socket.connected)), timeout);
      const ok = () => { clearTimeout(t); resolve(true); };
      if (socket) socket.once('connect', ok);
      else setTimeout(() => { clearTimeout(t); resolve(false); }, 0);
    });
  }

  function sendSignal(targetId, kind, data) {
    socket.emit('webrtc_signal', {
      roomId,
      targetId,
      kind,
      data,
      sourceId: myId,
    });
  }

  function flushCandidates(p) {
    if (!p.pendingCandidates) return;
    const list = p.pendingCandidates;
    p.pendingCandidates = [];
    for (const c of list) {
      p.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    }
  }

  function handleSignal(sourceId, kind, data) {
    if (kind === 'offer') {
      // 我是被呼叫方, 先挂好本端轨, 再回 answer
      const { pc } = getOrCreatePc(sourceId);
      for (const s of currentLocalTracks()) {
        for (const track of s.getTracks()) {
          if (!pc.getSenders().some((x) => x.track === track)) pc.addTrack(track, s);
        }
      }
      // 协商前应用编码档位/编码偏好/接收端调优
      applyPcTuning(pc);
      pc.setRemoteDescription(new RTCSessionDescription(data))
        .then(() => { flushCandidates(peers.get(sourceId)); })
        .then(() => pc.createAnswer())
        .then((ans) => pc.setLocalDescription(mungeLocalSdp(ans)))
        .then(() => sendSignal(sourceId, 'answer', pc.localDescription))
        .catch((err) => console.log('[webrtc] answer flow error:', err));
    } else if (kind === 'answer') {
      const p = peers.get(sourceId);
      if (p && p.pc) {
        p.pc.setRemoteDescription(new RTCSessionDescription(data))
          .then(() => flushCandidates(p))
          .catch((e) => console.log('[webrtc] setRemote answer err:', e));
      }
    } else if (kind === 'ice') {
      const p = peers.get(sourceId);
      if (!p) return;
      if (p.pc && p.pc.remoteDescription) {
        p.pc.addIceCandidate(new RTCIceCandidate(data)).catch(() => {});
      } else {
        (p.pendingCandidates = p.pendingCandidates || []).push(data);
      }
    }
  }

  // ---------- WebRTC ----------
  // 弱网/切网后 ICE 自动恢复: failed 立即重启; disconnected 持续 4s 不自愈也重启。
  // 6s 节流, 避免弱网抖动时反复重协商
  function tryIceRestart(peerId, pc) {
    const p = peers.get(peerId);
    if (!p || !p.pc || p.pc !== pc) return;
    if (pc.connectionState === 'closed' || pc.signalingState !== 'stable') return;
    const now = Date.now();
    if (p.lastIceRestart && now - p.lastIceRestart < 6000) return;
    p.lastIceRestart = now;
    console.log('[webrtc] ICE restart ->', peerId);
    pc.createOffer({ iceRestart: true })
      .then((offer) => pc.setLocalDescription(mungeLocalSdp(offer)))
      .then(() => sendSignal(peerId, 'offer', pc.localDescription))
      .catch((e) => console.log('[webrtc] ice restart failed:', e));
  }

  function createPc(peerId, p) {
    const pc = new RTCPeerConnection(cfg);
    p.pc = pc;
    pc.onnegotiationneeded = () => {
      // 仅在本地有轨且对方无会话描述时触发
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal(peerId, 'ice', e.candidate);
    };
    // ICE 状态监控: 弱网下的自动恢复
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (p.iceRecoverTimer) { clearTimeout(p.iceRecoverTimer); p.iceRecoverTimer = null; }
      if (s === 'connected' || s === 'completed' || s === 'closed') return;
      if (s === 'failed') { tryIceRestart(peerId, pc); return; }
      if (s === 'disconnected') {
        // disconnected 在弱网抖动时很常见, 先等 4s 看能否自愈
        p.iceRecoverTimer = setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected') tryIceRestart(peerId, pc);
        }, 4000);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') tryIceRestart(peerId, pc);
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;
      const track = e.track;
      // 接收端: 视频低延迟抖动缓冲(迟到帧丢弃, 弱网不堆延迟)
      tuneReceiver(e.receiver, track.kind);
      // 第一条流(麦克风+摄像头)绑定到该成员的主格子
      if (!p.remoteStream) {
        p.remoteStream = stream;
        if (p.video) p.video.srcObject = stream;
        else {
          const cell = grid.querySelector(`.cell[data-peer-id="${peerId}"]`);
          if (cell) cell.video.srcObject = stream;
        }
        return;
      }
      // 后续流视为屏幕共享 → 单独开一个格子显示, 可点击放大
      if (stream !== p.remoteStream) {
        addRemoteScreenTile(peerId, stream, track);
      }
    };
    return pc;
  }

  function getOrCreatePc(peerId) {
    let p = peers.get(peerId);
    if (!p) {
      p = { pc: null, remoteStream: null };
      peers.set(peerId, p);
    }
    if (!p.pc) createPc(peerId, p);
    return p;
  }

  function createOfferTo(peerId) {
    const { pc } = getOrCreatePc(peerId);
    const streams = currentLocalTracks();
    for (const s of streams) {
      for (const track of s.getTracks()) {
        if (!pc.getSenders().some((sender) => sender.track === track)) {
          pc.addTrack(track, s);
        }
      }
    }
    // 协商前应用编码档位/H264 偏好/接收端调优
    applyPcTuning(pc);
    pc.createOffer().then((offer) => {
      return pc.setLocalDescription(mungeLocalSdp(offer));
    }).then(() => {
      sendSignal(peerId, 'offer', pc.localDescription);
    });
    attachIce(pc, peerId);
  }

  // 收集当前要发给别人的轨道: 摄像头流 + (若正在共享屏幕) 屏幕流
  function currentLocalTracks() {
    const list = [];
    if (localStream) list.push(localStream);
    if (screenStream) list.push(screenStream);
    return list;
  }

  function attachIce(pc, peerId) {
    // 由 onicecandidate 触发, 无需额外处理
  }

  function closePeer(peerId) {
    const p = peers.get(peerId);
    if (p) {
      if (p.iceRecoverTimer) { clearTimeout(p.iceRecoverTimer); p.iceRecoverTimer = null; }
      p.pc.close();
      if (p.remoteStream) p.remoteStream.getTracks().forEach((t) => t.stop());
      // 清理该成员的所有屏幕共享流及其 DOM 格子(否则留下黑屏格子)
      if (p.screenTiles) {
        for (const t of p.screenTiles.values()) {
          t.stream.getTracks().forEach((tr) => tr.stop());
          if (t.cell && t.cell.parentNode) t.cell.parentNode.removeChild(t.cell);
        }
        p.screenTiles.clear();
      }
      peers.delete(peerId);
    }
  }

  // ---------- 远端屏幕共享格子 ----------
  // 每个远端成员的屏幕共享作为独立格子挂在 grid 里, 可点击放大
  function addRemoteScreenTile(peerId, stream, track) {
    const p = peers.get(peerId);
    if (!p) return;
    if (!p.screenTiles) p.screenTiles = new Map();
    if (p.screenTiles.has(stream.id)) return;
    // 同一成员同时只有一路屏幕共享: 新流到达时移除旧流格子,
    // 避免对端"停止再共享"协商过程中旧格子没收到 ended 而残留黑屏
    for (const [oldId, old] of p.screenTiles) {
      if (focusStream === old.stream) closeFocus();
      if (old.cell && old.cell.parentNode) old.cell.parentNode.removeChild(old.cell);
      p.screenTiles.delete(oldId);
    }
    const nick = p.nick || `成员 ${peerId.slice(0, 6)}`;
    const cell = document.createElement('div');
    cell.className = 'cell screen-cell';
    cell.dataset.peerId = peerId;
    cell.dataset.screenStream = stream.id;
    const v = document.createElement('video');
    v.autoplay = true;
    v.playsinline = true;
    v.srcObject = stream;
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = `${nick} 的屏幕`;
    const hint = document.createElement('div');
    hint.className = 'fs-hint';
    hint.textContent = '点击放大';
    cell.appendChild(v);
    cell.appendChild(l);
    cell.appendChild(hint);
    grid.appendChild(cell);
    p.screenTiles.set(stream.id, { cell, video: v, stream });
    // 轨道结束(对方停止共享)或被移除时删掉该格子, 避免黑屏残留
    const onEnded = () => removeRemoteScreenTile(peerId, stream.id);
    if (track) track.addEventListener('ended', onEnded, { once: true });
    stream.addEventListener('removetrack', (e) => {
      if (!track || e.track === track) onEnded();
    });
  }

  function removeRemoteScreenTile(peerId, streamId) {
    const p = peers.get(peerId);
    if (!p || !p.screenTiles) return;
    const t = p.screenTiles.get(streamId);
    if (t) {
      // 若放大层正显示这路画面, 先退出
      if (focusStream === t.stream) closeFocus();
      t.cell.remove();
      p.screenTiles.delete(streamId);
    }
  }

  // ---------- 本地麦克风音量(图标内绿色水位) ----------
  const micLevelEl = $('micLevel');
  const micWaterEl = $('micWater');
  let audioCtx = null;
  let analyser = null;
  let voiceRAF = null;
  let micLevel = 0;

  function startVoiceVisualizer(stream) {
    if (!micWaterEl) return;
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    const src = audioCtx.createMediaStreamSource(stream);
    src.connect(analyser);

    const dataArr = new Uint8Array(analyser.frequencyBinCount);
    // 胶囊区域: 高 28, 底部 y=30
    const CAP_H = 28, CAP_BOTTOM = 30;
    function draw() {
      analyser.getByteTimeDomainData(dataArr);
      // 用时域波形算 RMS 音量
      let sum = 0;
      for (let i = 0; i < dataArr.length; i++) {
        const x = (dataArr[i] - 128) / 128;
        sum += x * x;
      }
      let rms = Math.sqrt(sum / dataArr.length);
      // 放大并限幅, 普通说话也能明显看到水位
      let target = Math.min(1, rms * 4.5);
      // 指数平滑, 涨得快落得慢
      micLevel += (target - micLevel) * (target > micLevel ? 0.45 : 0.18);
      const h = CAP_H * micLevel;
      micWaterEl.setAttribute('y', CAP_BOTTOM - h);
      micWaterEl.setAttribute('height', h);
      voiceRAF = requestAnimationFrame(draw);
    }
    draw();
  }

  function stopVoiceVisualizer() {
    if (voiceRAF) cancelAnimationFrame(voiceRAF);
    voiceRAF = null;
    micLevel = 0;
    if (micWaterEl) { micWaterEl.setAttribute('y', 30); micWaterEl.setAttribute('height', 0); }
    if (analyser) { analyser.disconnect(); analyser = null; }
  }

  // ---------- 媒体 ----------
  async function startLocalMedia() {
    setStatusMedia('请求摄像头/麦克风…');
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: 640, height: 480 },
      });
      localStream.getVideoTracks().forEach((t) => (t._camera = true));
      localVideo.srcObject = localStream;
      startVoiceVisualizer(localStream); // 本地说话时波形跳动
      loadDevices(); // 加载麦克风/摄像头设备列表到下拉框
      setStatusMedia('本地媒体: 正常', false);
    } catch (e) {
      // 即使没有摄像头, 只要有麦克风也能启动波形
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStream.getAudioTracks().forEach((t) => (t._camera = false));
        startVoiceVisualizer(localStream);
        loadDevices();
        setStatusMedia('本地媒体: 仅音频(无摄像头)', false);
      } catch (e2) {
        setStatusMedia('媒体错误: ' + e.name + ' ' + e.message, true);
        throw e;
      }
    }
  }

  // 加载麦克风/摄像头设备列表到下拉框
  async function loadDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === 'audioinput');
      const cams = devices.filter((d) => d.kind === 'videoinput');

      // 当前使用的设备 id
      const curMic = localStream?.getAudioTracks()[0]?.getSettings?.()?.deviceId;
      const curCam = localStream?.getVideoTracks().find((t) => t._camera)?.getSettings?.()?.deviceId;

      micSelect.innerHTML = '';
      mics.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `麦克风 ${micSelect.options.length + 1}`;
        if (d.deviceId === curMic) opt.selected = true;
        micSelect.appendChild(opt);
      });

      camSelect.innerHTML = '';
      cams.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `摄像头 ${camSelect.options.length + 1}`;
        if (d.deviceId === curCam) opt.selected = true;
        camSelect.appendChild(opt);
      });
    } catch (e) {
      console.log('[loadDevices] failed:', e);
    }
  }

  async function startScreenShare() {
    try {
      // 1. 获取屏幕源列表
      setStatusMedia('正在获取屏幕源…');
      const sources = await window.api.getScreenSources();
      if (!sources || sources.length === 0) {
        setStatusMedia('屏幕共享失败: 没有可用的屏幕源', true);
        return;
      }
      // 2. 弹选择器选屏幕源 + 画质帧率
      const choice = showScreenPicker(sources);
      const picked = await choice.promise;
      if (!picked) {
        setStatusMedia('已取消屏幕共享', false);
        return;
      }
      // 3. 把选中的源 id 发给主进程, 然后用 getDisplayMedia 获取流
      await window.api.setScreenSource(picked.source.id);
      setStatusMedia('正在共享屏幕…');
      const got = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: picked.width },
          height: { ideal: picked.height },
          frameRate: { ideal: picked.frameRate },
          cursor: 'always',
        },
        audio: false,
      });
      screenStream = got;
      activeLocalTrackType = 'screen';

      // 根据"分辨率×帧率"计算编码档位
      const bitrateRow = SCREEN_BITRATE[`${picked.width}x${picked.height}`] || SCREEN_BITRATE['1920x1080'];
      // 实际捕获分辨率可能高于所选(如 2K/4K 屏选 1K), 计算编码缩放系数, 保证输出就是选定的 1K
      const capSettings = screenStream.getVideoTracks()[0].getSettings() || {};
      const scaleResolutionDownBy = capSettings.width
        ? Math.max(1, Math.round((capSettings.width / picked.width) * 100) / 100) : 1;
      if (picked.frameRate >= 60) {
        // 60fps 流畅档: 给足码率, 弱网时降分辨率保帧率(宁糊不卡), motion 提示走流畅优化
        screenProfile = {
          maxBitrate: bitrateRow[1], maxFramerate: 60,
          degradation: 'maintain-framerate', priority: 'high', networkPriority: 'high',
          scaleResolutionDownBy,
        };
      } else {
        // 30fps 清晰档: 弱网时丢帧保 1K 清晰度(文字锐利不糊), 延迟不堆积
        screenProfile = {
          maxBitrate: bitrateRow[0], maxFramerate: 30,
          degradation: 'maintain-resolution', priority: 'high', networkPriority: 'high',
          scaleResolutionDownBy,
        };
      }

      // 屏幕共享画面 → video 直接显示
      screenVideo.srcObject = screenStream;
      screenVideo.classList.remove('hidden');
      screenVideo.play().catch(() => {});
      grid.classList.add('screen-sharing');
      // 隐藏本地画中画(主窗口最小化后看不到了)
      localCell.classList.add('hidden');

      setStatusMedia(`屏幕共享中 ${picked.width}×${picked.height} @ ${picked.frameRate}fps`, false);

      // 把屏幕轨道加入所有已有连接
      const track = screenStream.getVideoTracks()[0];
      track._screen = true;
      // 内容提示: 60fps 按运动内容编码(流畅), 30fps 按细节内容编码(文字清晰)
      try { track.contentHint = picked.frameRate >= 60 ? 'motion' : 'detail'; } catch (_) {}
      for (const [pid, p] of peers) {
        p.pc.addTrack(track, screenStream);
        // 应用屏幕档码率/帧率/降级策略后再协商, 对端才能收到真正的 1K 高清流
        applyPcTuning(p.pc);
        p.pc.createOffer().then((o) => p.pc.setLocalDescription(mungeLocalSdp(o))).then(() => {
          sendSignal(pid, 'offer', p.pc.localDescription);
        });
      }
      $('screenBtn').textContent = '停止共享';
      $('screenBtn').classList.remove('on');
      $('screenBtn').classList.add('toggle-off');

      // 打开摄像头置顶小窗, 然后最小化主窗口(避免会议窗口出现在共享画面里导致递归)
      // 传入本端 socket id, 面板据此把"自己"的格子做镜像显示
      if (window.api.openCameraPip) {
        try {
          await window.api.openCameraPip(roomId, signalUrl, myId);
          setPipOpen(true);
        } catch (e) {
          console.log('[openCameraPip] failed:', e);
        }
      }
      setTimeout(() => { if (window.api.minimizeWindow) window.api.minimizeWindow(); }, 400);
    } catch (err) {
      console.log('[startScreenShare] error:', err);
      setStatusMedia('屏幕共享失败: ' + (err.message || err), true);
      screenStream = null;
    }
  }

  // 屏幕源 + 画质/帧率选择器
  function showScreenPicker(sources) {
    let resolve;
    const promise = new Promise((r) => (resolve = r));

    // label 中标注推荐码率, 方便对照网络情况选择
    const QUALITY = [
      { label: '高清1K (推荐)', width: 1920, height: 1080 },
      { label: '2K', width: 2560, height: 1440 },
      { label: '原画4K', width: 3840, height: 2160 },
    ];
    // 30fps = 清晰优先(弱网丢帧保文字锐利); 60fps = 流畅优先(弱网降清晰度保帧率)
    const FRAMES = [
      { fps: 30, label: '30 fps · 清晰优先' },
      { fps: 60, label: '60 fps · 流畅优先' },
    ];

    let selQuality = 0;   // 默认 1K
    let selFrame = 1;     // 默认 60fps 流畅档
    let pickedSource = null;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#2a2a2a;border:1px solid #444;border-radius:8px;padding:16px;max-width:720px;max-height:85vh;overflow:auto;color:#eee;';
    box.innerHTML = '<h3 style="margin:0 0 12px;color:#fff;">选择要共享的屏幕或窗口</h3>';

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px;';
    sources.forEach((s) => {
      const item = document.createElement('div');
      item.style.cssText = 'cursor:pointer;border:2px solid #444;border-radius:6px;padding:6px;text-align:center;';
      item.innerHTML = `<img src="${s.thumbnail}" style="width:100%;border-radius:4px;display:block;"><div style="margin-top:6px;font-size:12px;">${s.name}</div>`;
      item.onmouseover = () => { if (pickedSource !== s) item.style.borderColor = '#4a90d9'; };
      item.onmouseout = () => { if (pickedSource !== s) item.style.borderColor = '#444'; };
      item.onclick = () => {
        pickedSource = s;
        [...grid.children].forEach((c) => (c.style.borderColor = '#444'));
        item.style.borderColor = '#4f8cff';
      };
      grid.appendChild(item);
    });
    box.appendChild(grid);

    // 画质选择
    const qBox = document.createElement('div');
    qBox.style.cssText = 'margin-top:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
    qBox.innerHTML = '<span style="color:#aaa;font-size:13px;">画质:</span>';
    QUALITY.forEach((q, i) => {
      const btn = document.createElement('button');
      btn.textContent = `${q.label} (${q.width}×${q.height})`;
      btn.style.cssText = 'padding:5px 10px;background:#3a3a44;color:#eee;border:none;border-radius:4px;cursor:pointer;font-size:12px;';
      if (i === selQuality) btn.style.background = '#4f8cff';
      btn.onclick = () => {
        selQuality = i;
        [...qBox.querySelectorAll('button')].forEach((b, j) => (b.style.background = j === i ? '#4f8cff' : '#3a3a44'));
      };
      qBox.appendChild(btn);
    });
    box.appendChild(qBox);

    // 帧率选择
    const fBox = document.createElement('div');
    fBox.style.cssText = 'margin-top:10px;display:flex;align-items:center;gap:8px;';
    fBox.innerHTML = '<span style="color:#aaa;font-size:13px;">帧率:</span>';
    FRAMES.forEach((f, i) => {
      const btn = document.createElement('button');
      btn.textContent = f.label;
      btn.style.cssText = 'padding:5px 10px;background:#3a3a44;color:#eee;border:none;border-radius:4px;cursor:pointer;font-size:12px;';
      if (i === selFrame) btn.style.background = '#4f8cff';
      btn.onclick = () => {
        selFrame = i;
        [...fBox.querySelectorAll('button')].forEach((b, j) => (b.style.background = j === i ? '#4f8cff' : '#3a3a44'));
      };
      fBox.appendChild(btn);
    });
    box.appendChild(fBox);

    // 弱网自适应说明
    const netHint = document.createElement('div');
    netHint.style.cssText = 'margin-top:10px;font-size:12px;color:#8fa3bf;line-height:1.5;';
    netHint.textContent = '弱网自动适配: 60fps 档网速差时自动降低清晰度保流畅(适当丢包); 30fps 档自动丢帧保画面清晰。音频开启抗丢包, 断线自动重连。';
    box.appendChild(netHint);

    // 按钮行
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'margin-top:14px;display:flex;gap:10px;justify-content:flex-end;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = 'padding:6px 16px;background:#555;color:#fff;border:none;border-radius:4px;cursor:pointer;';
    cancelBtn.onclick = () => { document.body.removeChild(overlay); resolve(null); };
    const okBtn = document.createElement('button');
    okBtn.textContent = '开始共享';
    okBtn.style.cssText = 'padding:6px 16px;background:#4f8cff;color:#fff;border:none;border-radius:4px;cursor:pointer;';
    okBtn.onclick = () => {
      if (!pickedSource) { alert('请先选择要共享的屏幕或窗口'); return; }
      document.body.removeChild(overlay);
      resolve({
        source: pickedSource,
        width: QUALITY[selQuality].width,
        height: QUALITY[selQuality].height,
        frameRate: FRAMES[selFrame].fps,
      });
    };
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    box.appendChild(btnRow);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    return { promise };
  }

  function stopScreenShare() {
    if (screenRaf) { cancelAnimationFrame(screenRaf); screenRaf = null; }
    const oldTrack = screenStream ? screenStream.getVideoTracks()[0] : null;
    if (screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      screenStream = null;
    }
    screenProfile = null;
    activeLocalTrackType = 'camera';
    // 恢复 grid 显示, 隐藏屏幕大屏, localCell 回到 grid 正常位置
    screenVideo.classList.add('hidden');
    screenVideo.srcObject = null;
    screenCanvas.classList.add('hidden');
    grid.classList.remove('screen-sharing');
    localCell.classList.remove('pip', 'hidden');
    // 把 localCell 移回 grid(作为第一个子元素)
    grid.insertBefore(localCell, grid.firstChild);
    // 恢复默认位置(拖拽可能改了 left/top)
    localCell.style.left = '';
    localCell.style.top = '';
    // 关闭摄像头浮窗, 恢复主窗口
    setPipOpen(false);
    if (window.api.closeCameraPip) window.api.closeCameraPip();
    if (window.api.restoreWindow) window.api.restoreWindow();
    localCell.style.right = '';
    localCell.style.bottom = '';
    if (localStream) localVideo.srcObject = localStream;
    // 若正在放大屏幕画面, 退出放大层
    if (focusStream) closeFocus();
    // 从所有连接真正移除屏幕轨道(sender 移除 + 重新协商,
    // 对端才会收到轨道结束/移除事件并删掉屏幕格子; 只 stop 轨道会留下黑屏)
    for (const [pid, p] of peers) {
      try {
        if (oldTrack) {
          const sender = p.pc.getSenders().find((s) => s.track === oldTrack);
          if (sender) p.pc.removeTrack(sender);
        }
        // 移除屏幕轨后, 摄像头重新应用摄像头档位
        applyPcTuning(p.pc);
        p.pc.createOffer()
          .then((o) => p.pc.setLocalDescription(mungeLocalSdp(o)))
          .then(() => sendSignal(pid, 'offer', p.pc.localDescription))
          .catch((e) => console.log('[stopScreenShare] renegotiate failed:', e));
      } catch (e) {
        console.log('[stopScreenShare] removeTrack failed:', e);
      }
    }
    $('screenBtn').textContent = '共享屏幕';
    $('screenBtn').classList.remove('toggle-off');
    setStatusMedia('本地媒体: 正常', false);
  }

  // ---------- 离开会议: 全量清理, 保证大厅不残留黑屏/浮窗/占用的摄像头 ----------
  function leaveMeeting() {
    if (socket) {
      try { socket.emit('leave_room', { roomId }); } catch (_) {}
    }
    // 屏幕共享: 走完整停止流程(恢复窗口/布局, 关闭浮窗, 移除发送轨)
    if (screenStream) {
      stopScreenShare();
    } else {
      // 没共享也要关掉手动打开的浮窗和可能停留的放大层
      setPipOpen(false);
      if (window.api && window.api.closeCameraPip) window.api.closeCameraPip();
      closeFocus(); // 未打开时是空操作, 安全
      if (window.api && window.api.restoreWindow) window.api.restoreWindow();
    }
    // 关闭所有远端连接并移除其格子(含屏幕格子)
    for (const pid of [...peers.keys()]) closePeer(pid);
    grid.querySelectorAll('.cell[data-peer-id]').forEach((c) => c.remove());
    // 释放本地摄像头/麦克风, 清空画面避免黑屏冻结帧
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    localVideo.srcObject = null;
    stopVoiceVisualizer();
    // 重置麦克风/摄像头按钮为默认态
    if (micMuteBtn) {
      micMuteBtn.textContent = '🎤';
      micMuteBtn.classList.remove('toggle-off');
      micMuteBtn.classList.add('on');
    }
    if (camToggleBtn) {
      camToggleBtn.textContent = '📷';
      camToggleBtn.classList.remove('toggle-off');
      camToggleBtn.classList.add('on');
    }
    setStatusMedia('');
    updateCount();
    // 回到大厅; 窗口若处于会议尺寸/最小化, 一并恢复
    meetView.classList.add('hidden');
    joinPanel.classList.remove('hidden');
    if (window.api && window.api.setWindowMode) window.api.setWindowMode('home');
  }

  // ---------- 远端 cell ----------
  function addRemoteCell(peerId, nick, micMuted = false) {
    if (grid.querySelector(`.cell[data-peer-id="${peerId}"]`)) return;
    const cell = makeCell(peerId, nick || `成员 ${peerId.slice(0, 6)}`, true);
    // 存起来, handleSignal 里拿到远端 video 时用它
    peers.set(peerId, { pc: null, remoteStream: null, video: cell.video, labelEl: cell.labelEl, micEl: cell.micEl, nick: nick || null });
    if (micMuted) setRemoteMicMuted(peerId, true);
    updateCount();
  }

  function removeRemoteCell(peerId) {
    const cell = grid.querySelector(`.cell[data-peer-id="${peerId}"]:not(.screen-cell)`);
    if (cell) cell.remove();
    // 移除该成员的所有屏幕共享格子
    grid.querySelectorAll(`.cell.screen-cell[data-peer-id="${peerId}"]`).forEach((c) => c.remove());
  }

  function updateCount() {
    // __panel__ 浮窗连接参与取流但不算参会者
    const n = [...peers.values()].filter((p) => !p.isPanel).length + 1;
    $('countTag').textContent = `${n} 人`;
  }

  // ---------- UI 绑定 ----------
  // 按钮点击视觉反馈: 加 .pressed 后移除, 让用户确认"点到了"
  function flash(el) {
    if (!el) return;
    el.classList.add('pressed');
    setTimeout(() => el.classList.remove('pressed'), 180);
  }

  function bindUI() {
    // 监听摄像头小窗的停止共享请求
    if (window.api.onStopShareFromPip) {
      window.api.onStopShareFromPip(() => { if (screenStream) stopScreenShare(); });
    }

    const hint = $('hint');
    if (hint) hint.textContent = '主机保持默认地址；其他电脑填入主机 IP 后点连接，再用相同房间号入会。';

    // ---------- 信令服务器: 本机主机模式 / 远程主机模式 ----------
    const srvDot = $('srvDot');
    const srvState = $('srvState');
    const srvAddr = $('srvAddr');
    const srvToggle = $('srvToggle');
    let lastFilledHost = '';
    // 本机主机模式: 服务器就在本机, socket 走 127.0.0.1 回环最可靠
    // (直接连本机网卡 IP 在部分网络/NAT/防火墙下会超时); 网卡 IP 仍展示给其他电脑填写
    function clientUrlFor(s) {
      if (s.mode === 'local') {
        const m = (s.url || '').match(/:(\d+)(?:\/|$)/);
        return `http://127.0.0.1:${m ? m[1] : '3001'}`;
      }
      return s.url;
    }
    function renderServerStatus(s) {
      if (!s) return;
      // 回填主机 IP, 但用户正在编辑(输入框有焦点且已手动改过)时不打断
      const editing = document.activeElement === srvAddr && srvAddr.value.trim() !== lastFilledHost;
      if (srvAddr && s.host && !editing) { srvAddr.value = s.host; lastFilledHost = s.host; }
      let label;
      if (s.state === 'starting') label = '连接中…';
      else if (s.state === 'running') {
        label = s.mode === 'remote' ? '运行中(远程主机)' : s.external ? '运行中(外部)' : '运行中(本机主机)';
      } else if (s.state === 'error') label = s.mode === 'remote' ? '无法连接主机' : '启动失败';
      else label = '已停止';
      if (srvState) srvState.textContent = label;
      if (srvDot) srvDot.className = 'dot ' + s.state;
      const running = s.state === 'running';
      joinBtn.disabled = !running;
      if (srvAddr) srvAddr.disabled = (s.state === 'running' || s.state === 'starting');
      if (srvToggle) {
        srvToggle.disabled = s.state === 'starting';
        if (running) {
          srvToggle.textContent = s.mode === 'remote' ? '断开' : '停止';
          // 外部进程启动的本机服务器, 本应用无权关闭
          if (s.external) { srvToggle.disabled = true; srvToggle.title = '服务器由外部进程启动, 本应用无法停止'; }
          else srvToggle.title = '';
        } else {
          srvToggle.textContent = '连接';
          srvToggle.title = '';
        }
      }
      // 服务器可用后, 让 socket 连到当前主机(本机模式走回环地址)
      if (running && s.url) ensureSocket(clientUrlFor(s));
    }
    if (srvToggle) {
      srvToggle.onclick = () => {
        flash(srvToggle);
        if (!window.api || !window.api.signalServer) return;
        if (srvToggle.textContent === '连接') {
          const host = srvAddr.value.trim();
          if (!host) { srvAddr.focus(); return; }
          window.api.signalServer.connect(host);
        } else {
          window.api.signalServer.disconnect();
        }
      };
    }
    if (srvAddr) {
      srvAddr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !srvToggle.disabled) srvToggle.click();
      });
    }
    if (window.api && window.api.signalServer) {
      window.api.signalServer.status().then(renderServerStatus);
      window.api.signalServer.onChange(renderServerStatus);
    }

    const randomBtn = $('randomBtn');
    if (randomBtn) randomBtn.onclick = () => {
      flash(randomBtn);
      $('roomId').value = String(Math.floor(100 + Math.random() * 900));
    };

    const joinBtn = $('joinBtn');
    if (joinBtn) joinBtn.onclick = async () => {
      flash(joinBtn);
      console.log('[joinBtn] clicked, socket =', !!socket, 'myId =', myId, 'connected =', socket ? socket.connected : null);
      const rid = $('roomId').value.trim();
      const nick = $('nick').value.trim() || '用户';
      if (!rid) { setHint('请先填房间号'); return; }
      roomId = rid;
      // 确保信令已连到当前主机(切换地址后重连可能需要一两秒)
      const signalOk = await waitSignalConnected();
      if (!signalOk) { setHint('信令服务器未连接，请检查主机地址后重试'); return; }
      try {
        // 先尝试拉摄像头+麦克风, 失败则降级到仅麦克风, 再失败就纯文字进会
        let mediaOk = false;
        try {
          await startLocalMedia();
          mediaOk = true;
        } catch (e) {
          console.log('[joinBtn] 拉设备失败, 降级进会:', e.message);
          mediaOk = false;
        }
        // 无论有没有媒体都能进会
        joinPanel.classList.add('hidden');
        meetView.classList.remove('hidden');
        if (window.api && window.api.setWindowMode) window.api.setWindowMode('meeting');
        $('roomTag').textContent = `房间: ${roomId}`;
        // 显示自己的昵称
        localName.textContent = nick + ' (我)';
        if (socket) socket.emit('join_room', { roomId, nick });
        updateCount();
        if (!mediaOk) setStatusMedia('无摄像头/麦克风, 纯文字进会', false);
        console.log('[joinBtn] join_room emitted, roomId =', roomId, 'media =', mediaOk);
      } catch (e) {
        console.log('[joinBtn] error:', e.message, e);
        const err = e.message || String(e);
        setHint('无法访问摄像头/麦克风: ' + err);
        setStatusMedia('媒体错误: ' + err, true);
      }
    };

    const leaveBtn = $('leaveBtn');
    if (leaveBtn) leaveBtn.onclick = () => {
      flash(leaveBtn);
      leaveMeeting();
    };

    // 置顶参会者浮窗: 一键打开/关闭, 不影响是否正在共享屏幕
    if (pipBtn) {
      pipBtn.onclick = async () => {
        flash(pipBtn);
        if (pipOpen) {
          if (window.api && window.api.closeCameraPip) window.api.closeCameraPip();
          return;
        }
        if (!roomId) { setStatusMedia('还未加入会议, 无法打开参会者浮窗', true); return; }
        if (window.api && window.api.openCameraPip) {
          try {
            await window.api.openCameraPip(roomId, signalUrl, myId);
            setPipOpen(true);
          } catch (e) {
            setStatusMedia('打开参会者浮窗失败: ' + (e.message || e), true);
          }
        }
      };
      // 浮窗被自己的 X 或主进程关闭时, 主窗口按钮状态同步复位;
      // 共享中主窗口是最小化的, 浮窗关掉后要把主窗口还原, 否则用户找不到应用
      if (window.api && window.api.onCameraPipClosed) {
        window.api.onCameraPipClosed(() => {
          setPipOpen(false);
          if (screenStream && window.api.restoreWindow) window.api.restoreWindow();
        });
      }
    }

    // 麦克风静音切换
    if (micMuteBtn) micMuteBtn.onclick = () => {
      flash(micMuteBtn);
      if (!localStream) { setStatusMedia('还没有本地媒体流', true); return; }
      const at = localStream.getAudioTracks()[0];
      if (!at) return;
      at.enabled = !at.enabled;
      const muted = !at.enabled;
      micMuteBtn.classList.toggle('toggle-off', muted);
      micMuteBtn.classList.toggle('on', !muted);
      micMuteBtn.textContent = muted ? '🔇' : '🎤';
      // 昵称栏的麦克风图标静音时变灰
      if (micLevelEl) micLevelEl.classList.toggle('muted', muted);
      // 广播静音状态, 置顶摄像头面板(及其他端)据此显示静音图标
      if (socket && socket.connected) socket.emit('mic_state', { roomId, muted });
    };

    // 摄像头开关
    if (camToggleBtn) camToggleBtn.onclick = () => {
      flash(camToggleBtn);
      if (!localStream) { setStatusMedia('还没有本地媒体流', true); return; }
      const vt = localStream.getVideoTracks().find((t) => t._camera);
      if (!vt) { setStatusMedia('没有摄像头轨道', true); return; }
      vt.enabled = !vt.enabled;
      camToggleBtn.classList.toggle('toggle-off', !vt.enabled);
      camToggleBtn.classList.toggle('on', vt.enabled);
      camToggleBtn.textContent = vt.enabled ? '📷' : '📷';
      if (vt.enabled) localVideo.srcObject = localStream;
    };

    // 麦克风设备切换
    if (micSelect) micSelect.onchange = async () => {
      const deviceId = micSelect.value;
      if (!deviceId || !localStream) return;
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: deviceId } },
          video: false,
        });
        // 替换音频轨道
        const oldAt = localStream.getAudioTracks()[0];
        const newAt = newStream.getAudioTracks()[0];
        newAt.enabled = oldAt ? oldAt.enabled : true;
        localStream.removeTrack(oldAt);
        localStream.addTrack(newAt);
        // 推流给所有远端(peers 的 value 是 {pc,...} 状态对象)
        peers.forEach((p) => {
          if (!p.pc) return;
          const sender = p.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
          if (sender) sender.replaceTrack(newAt);
        });
        startVoiceVisualizer(localStream);
      } catch (e) {
        setStatusMedia('切换麦克风失败: ' + e.message, true);
      }
    };

    // 摄像头设备切换
    if (camSelect) camSelect.onchange = async () => {
      const deviceId = camSelect.value;
      if (!deviceId || !localStream) return;
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { deviceId: { exact: deviceId }, width: 1280, height: 720 },
        });
        const oldVt = localStream.getVideoTracks().find((t) => t._camera);
        const newVt = newStream.getVideoTracks()[0];
        newVt._camera = true;
        newVt.enabled = oldVt ? oldVt.enabled : true;
        if (oldVt) localStream.removeTrack(oldVt);
        localStream.addTrack(newVt);
        localVideo.srcObject = localStream;
        peers.forEach((p) => {
          if (!p.pc) return;
          const sender = p.pc.getSenders().find((s) => s.track && s.track._camera);
          if (sender) sender.replaceTrack(newVt);
        });
      } catch (e) {
        setStatusMedia('切换摄像头失败: ' + e.message, true);
      }
    };

    const screenBtn = $('screenBtn');
    if (screenBtn) screenBtn.onclick = () => {
      flash(screenBtn);
      if (screenStream) stopScreenShare();
      else startScreenShare();
    };

    // ---------- 单格放大层: 点击任意视频/共享屏格子, 把该路画面放大铺满 ----------
    const focusOverlay = $('focusOverlay');
    const focusVideo = $('focusVideo');
    const focusLabel = $('focusLabel');
    const focusClose = $('focusClose');

    function openFocus(cell) {
      const v = cell.querySelector('video');
      const stream = v && v.srcObject;
      if (!stream) return;
      focusVideo.srcObject = stream;
      // 放大本地摄像头时保持镜像; 远端/屏幕共享不镜像
      focusVideo.classList.toggle('mirror', cell.id === 'localCell');
      const lbl = cell.querySelector('.label');
      focusLabel.textContent = lbl ? lbl.textContent : '';
      focusOverlay.classList.remove('hidden');
      focusStream = stream;
      // 该路画面结束(对方停止共享/离会)时自动退出放大
      const vt = stream.getVideoTracks()[0];
      if (vt) vt.addEventListener('ended', closeFocus, { once: true });
    }
    closeFocus = function () {
      focusOverlay.classList.add('hidden');
      focusVideo.srcObject = null;
      focusVideo.classList.remove('mirror');
      focusStream = null;
    };
    // 点击任意格子 → 放大(本地画中画拖拽模式除外)
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      if (cell.id === 'localCell' && cell.classList.contains('pip')) return;
      openFocus(cell);
    });
    if (focusClose) focusClose.addEventListener('click', closeFocus);
    // 点放大层空白处退出
    if (focusOverlay) focusOverlay.addEventListener('click', (e) => {
      if (e.target === focusOverlay) closeFocus();
    });

    // ---------- 窗口全屏: 双击共享大屏区域切换 Electron 窗口全屏, ESC 退出 ----------
    // 用原生窗口全屏而非 HTML5 全屏, 避免屏幕共享时递归显示
    let isWinFullscreen = false;
    async function toggleWindowFullscreen() {
      try {
        isWinFullscreen = !isWinFullscreen;
        await window.api.setFullScreen(isWinFullscreen);
      } catch (err) {
        console.log('[fs] setFullScreen failed:', err);
      }
    }
    let lastClickTime = 0;
    function onVideoAreaClick(e) {
      // 控制栏/顶部栏/状态栏不处理
      if (e.target.closest('.controls') || e.target.closest('.topbar') || e.target.closest('#statusBar')) return;
      // 格子单击由上面的 grid 委托处理为放大, 这里只处理共享大屏区域的双击
      if (e.target.closest('.cell')) return;
      if (!screenStream) return;
      const now = Date.now();
      const isDouble = (now - lastClickTime) < 500;
      lastClickTime = now;
      if (isDouble) toggleWindowFullscreen();
    }
    meetView.addEventListener('click', onVideoAreaClick);
    // ESC: 优先退出放大层, 再退出窗口全屏
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (focusOverlay && !focusOverlay.classList.contains('hidden')) {
        closeFocus();
        return;
      }
      if (isWinFullscreen) toggleWindowFullscreen();
    });

    // ---------- 画中画小窗拖拽: 屏幕共享时可拖动摄像头小窗 ----------
    let dragState = null;
    localCell.addEventListener('pointerdown', (e) => {
      if (!localCell.classList.contains('pip')) return; // 仅画中画模式可拖
      const rect = localCell.getBoundingClientRect();
      dragState = {
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
      };
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      const parent = meetView.getBoundingClientRect();
      let nx = e.clientX - parent.left - dragState.offsetX;
      let ny = e.clientY - parent.top - dragState.offsetY;
      // 限制在窗口内
      const cw = localCell.offsetWidth;
      const ch = localCell.offsetHeight;
      nx = Math.max(0, Math.min(nx, parent.width - cw));
      ny = Math.max(0, Math.min(ny, parent.height - ch));
      localCell.style.left = nx + 'px';
      localCell.style.top = ny + 'px';
      localCell.style.right = 'auto';
      localCell.style.bottom = 'auto';
    });
    document.addEventListener('pointerup', () => { dragState = null; });
  }

  // 顶部提示: 出错时把信息浮到界面上, 不用 alert
  function setHint(msg) {
    const h = $('hint');
    if (h) h.textContent = msg;
  }

  // ---------- 初始化 ----------
  // socket.io 已改为本地加载(socket.io.js), io 一定可用; 仍保留轮询兜底
  function init() {
    if (typeof io === 'undefined') {
      setTimeout(init, 300);
      return;
    }
    // 不在启动时自动连接信令: 默认不开启服务器, 等用户点"连接"、
    // 收到服务器 running 状态后再由 renderServerStatus 建立 socket
    bindUI();
    // 初始化 getDisplayMedia 请求处理器
    if (window.api.initDisplayMedia) window.api.initDisplayMedia();
    // 启动自检: 把每个关键元素的绑定情况打到主进程日志, 便于定位"点不动"
    const ids = ['nick','roomId','randomBtn','joinBtn','leaveBtn','micSelect','camSelect','micMuteBtn','camToggleBtn','screenBtn','pipBtn','hint','grid','srvDot','srvState','srvAddr','srvToggle'];
    const missing = ids.filter((id) => !document.getElementById(id));
    console.log('[bindUI-check] missing elements:', missing.length ? missing.join(',') : 'none');
    console.log('[bindUI-check] io available:', typeof io !== 'undefined', '| SIGNAL_URL:', SIGNAL_URL);
  }
  init();
})();
