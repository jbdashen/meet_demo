// 摄像头面板: 加入同一房间, 只接收所有参会者的视频流, 纵向排列显示
(() => {
  const qs = new URLSearchParams(location.search);
  const roomId = qs.get('room') || '100';
  // 主机地址优先用主进程通过 query 传入的值(远程联机时是对端 IP), 其次 preload 注入值
  const SIGNAL_URL = qs.get('signal') || window.api.SIGNAL_URL;
  // 主窗口(本机用户)的 socket id: 对应格子做镜像显示
  const selfId = qs.get('self') || '';
  const peers = new Map(); // peerId -> { pc, cell, analyser, level, micMuted }
  const list = document.getElementById('list');
  const title = document.getElementById('title');
  let myId = null;

  // ---------- 麦克风音量分析(只分析不出声, 避免与主窗口双重播放/回声) ----------
  let audioCtx = null;
  const METER_BINS = 128;
  const meterData = new Uint8Array(METER_BINS);

  function ensureAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  // 接收远端/自己的音频轨, 接入 AnalyserNode(不连 destination, 不发声)
  // 注意(Chromium): 远端 WebRTC 音频轨若不被任何媒体元素渲染,
  // 接收侧不解码音频数据, WebAudio 图谱里的 AnalyserNode 永远是静音。
  // 因此同时挂到一个隐藏的 <audio volume=0> 上强制解码(零音量, 不发声无回声)。
  function attachAudioMeter(peerId, track) {
    const p = peers.get(peerId);
    if (!p || p.audioTrackId === track.id) return;
    p.audioTrackId = track.id;
    const ctx = ensureAudioCtx();
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.4;
    src.connect(analyser);
    p.audioSource = src;
    p.analyser = analyser;
    if (!p.audioEl) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.volume = 0; // 强制解码但不发声
      el.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.body.appendChild(el);
      p.audioEl = el;
    }
    p.audioEl.srcObject = new MediaStream([track]);
    p.audioEl.play().catch(() => {});
    track.addEventListener('ended', () => {
      if (peers.get(peerId) === p) p.analyser = null;
      try { src.disconnect(); } catch (_) {}
    });
  }

  // 每帧更新每个格子的麦克风水位 + 说话绿框
  function micTick() {
    for (const p of peers.values()) {
      const mic = p.cell && p.cell.querySelector('.mic');
      if (!mic) continue;
      let level = 0;
      if (p.analyser && !p.micMuted) {
        const data = meterData;
        p.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const d = (data[i] - 128) / 128;
          sum += d * d;
        }
        level = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
      }
      // 平滑, 衰减稍快避免"常亮"
      p.level = (p.level || 0) * 0.55 + level * 0.45;
      const water = mic.querySelector('.water');
      if (water && !p.micMuted) {
        const h = Math.round(p.level * 28);
        water.setAttribute('y', 30 - h);
        water.setAttribute('height', h);
      }
      if (p.level > 0.08 && !p.micMuted) p.cell.classList.add('speaking');
      else p.cell.classList.remove('speaking');
    }
    requestAnimationFrame(micTick);
  }
  requestAnimationFrame(micTick);

  // X 只关闭浮窗本身; 屏幕共享由主窗口的"停止共享"控制, 两者互不干扰
  document.getElementById('closeBtn').onclick = () => {
    if (window.api && window.api.closeCameraPip) window.api.closeCameraPip();
  };

  // ICE 配置与主窗口一致: 多 STUN 兜底 + 预收集候选(弱网/切网恢复更快) + 传输复用
  const cfg = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.qq.com:3478' },
      { urls: 'stun:stun.miwifi.com:3478' },
    ],
    iceCandidatePoolSize: 4,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  };

  // SDP 微调: Opus 带内 FEC(丢包重建) + DTX(静音省带宽), 弱网下水位分析/声音更连贯
  function mungeLocalSdp(desc) {
    try {
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
      desc.sdp = lines.join('\r\n') + '\r\n';
    } catch (_) {}
    return desc;
  }

  // 视频接收端低延迟: 弱网下迟到帧直接跳过, 不堆积延迟(面板画面跟随更实时)
  function tuneVideoReceiver(pc) {
    try {
      for (const r of pc.getReceivers()) {
        if (r.track && r.track.kind === 'video') {
          if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0.2;
          else if ('playoutDelayHint' in r) r.playoutDelayHint = 0.2;
        }
      }
    } catch (_) {}
  }

  // 上次已应用的窗口高度; 宽度在窗口生命周期内固定不变(见 main.js), 避免尺寸反馈环
  let lastH = 0;

  function fitHeight() {
    // 按格子实际高度累加, 1 人=1 格, 每加一人增高一格; 避免和窗口高度循环依赖
    requestAnimationFrame(() => {
      const panel = document.getElementById('panel');
      const header = document.getElementById('header');
      const cells = [...list.children];
      const cs = getComputedStyle(list);
      const gap = parseFloat(cs.gap) || 0;
      const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const cellsH = cells.reduce((sum, c) => sum + c.offsetHeight, 0)
        + (cells.length > 1 ? gap * (cells.length - 1) : 0);
      const border = parseFloat(getComputedStyle(panel).borderTopWidth)
        + parseFloat(getComputedStyle(panel).borderBottomWidth);
      // +2px 余量: 亚像素舍入/系统边框可能让窗口实际可用高度少 1px,
      // 差 1px 就会触发滚动条显示→格子变窄变矮→滚动条消失…逐帧振荡(面板晃动)
      const h = Math.ceil(header.offsetHeight + cellsH + padV + border) + 2;
      if (window.api && window.api.resizeCameraPip && h > 0
        && Math.abs(h - lastH) >= 2) {
        lastH = h;
        // 宽度传 0: 主进程保持当前宽度, 不从测量值反算(宽度环的根源)
        window.api.resizeCameraPip(0, h);
      }
    });
  }

  function addCell(peerId, nick, micMutedFlag = false) {
    const cell = document.createElement('div');
    cell.className = 'cell' + (peerId === selfId ? ' self' : '');
    cell.dataset.peerId = peerId;
    // clipPath id 必须全局唯一(socket id 只含字母数字, 净化后用作后缀)
    const uid = String(peerId).replace(/[^a-zA-Z0-9]/g, '') || Math.random().toString(36).slice(2);
    cell.innerHTML =
      '<video autoplay muted playsinline></video>'
      + '<span class="name"></span>'
      + '<span class="mic" title="麦克风">'
      +   `<svg viewBox="0 0 40 50" width="13" height="16">`
      +     `<defs><clipPath id="pipMic${uid}"><rect x="9" y="2" width="22" height="28" rx="11"/></clipPath></defs>`
      +     `<g clip-path="url(#pipMic${uid})"><rect class="water" x="9" y="30" width="22" height="0" fill="#17c98b"/></g>`
      +     '<g class="body" fill="none" stroke="#ffffff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">'
      +       '<rect x="9" y="2" width="22" height="28" rx="11"/>'
      +       '<path d="M8 18 a12 12 0 0 0 24 0"/>'
      +       '<line x1="20" y1="33" x2="20" y2="41"/>'
      +       '<line x1="14" y1="44" x2="26" y2="44"/>'
      +     '</g>'
      +     '<line class="muted-slash" x1="7" y1="7" x2="33" y2="41" stroke="#ff5a52" stroke-width="4.5" stroke-linecap="round"/>'
      +   '</svg>'
      + '</span>';
    cell.querySelector('.name').textContent = nick || peerId.slice(0, 6);
    if (micMutedFlag) cell.querySelector('.mic').classList.add('muted');
    list.appendChild(cell);
    title.textContent = `参会者 (${list.children.length})`;
    fitHeight();
    return cell;
  }

  function removeCell(peerId) {
    const cell = list.querySelector(`[data-peer-id="${peerId}"]`);
    if (cell) cell.remove();
    title.textContent = `参会者 (${list.children.length})`;
    fitHeight();
  }

  // 更新某人的静音状态: 角标加/去 muted 类, 水位清零, 去掉说话绿框
  function setMicMuted(peerId, muted) {
    const p = peers.get(peerId);
    if (!p) return;
    p.micMuted = !!muted;
    const mic = p.cell.querySelector('.mic');
    if (mic) mic.classList.toggle('muted', !!muted);
    if (muted) {
      const water = mic && mic.querySelector('.water');
      if (water) { water.setAttribute('y', 30); water.setAttribute('height', 0); }
      p.cell.classList.remove('speaking');
    }
  }

  function createPeer(peerId, nick, micMutedFlag) {
    let p = peers.get(peerId);
    if (p) {
      // 已存在(room_members 先建过, offer 再到): 仅在明确给出静音状态时同步
      if (typeof micMutedFlag === 'boolean') setMicMuted(peerId, micMutedFlag);
      return p.pc;
    }
    const pc = new RTCPeerConnection(cfg);
    const cell = addCell(peerId, nick, micMutedFlag);
    p = { pc, cell, micMuted: !!micMutedFlag, level: 0 };
    peers.set(peerId, p);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('webrtc_signal', { roomId, targetId: peerId, kind: 'ice', data: e.candidate, sourceId: myId });
      }
    };
    pc.ontrack = (e) => {
      const t = e.track;
      // 新接收器到达后应用低延迟抖动缓冲
      tuneVideoReceiver(pc);
      if (t.kind === 'audio') {
        // 音频不播放, 仅用于麦克风音量分析(隐藏 audio 元素负责强制解码)
        attachAudioMeter(peerId, t);
        return;
      }
      // 每人只取第一条视频轨(摄像头); 屏幕共享轨后到, 忽略
      if (t.kind !== 'video' || p.videoTrack) return;
      p.videoTrack = t;
      const video = cell.querySelector('video');
      video.muted = true;
      video.srcObject = new MediaStream([t]);
      const pr = video.play();
      if (pr) pr.catch((err) => {
        if (err.name !== 'AbortError') console.log('[panel] video.play error:', err.name, err.message);
      });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') console.log('[panel] connection failed:', peerId);
    };
    return pc;
  }

  // 仅用 websocket + 快速重连: 弱网下信令延迟更低, 抖断后迅速恢复
  const socket = io(SIGNAL_URL, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 200,
    reconnectionDelayMax: 2000,
    timeout: 5000,
  });

  socket.on('connect', () => {
    myId = socket.id;
    socket.emit('join_room', { roomId, nick: '__panel__' });
  });

  socket.on('connect_error', (e) => console.log('[panel] connect_error:', e.message));

  // 收到房间已有成员, 等待对方主动 offer(避免双方同时 offer 冲突)
  socket.on('room_members', ({ others }) => {
    for (const m of others) {
      if (m.nick && m.nick.startsWith('__panel__')) continue; // 忽略其他置顶面板
      const pid = m.peerId || m;
      createPeer(pid, m.nick, !!m.micMuted); // 只创建格子和 PC, 不主动 offer
    }
  });

  // 有人加入, 等待对方主动 offer
  socket.on('peer_joined', ({ peerId, nick }) => {
    if (nick && nick.startsWith('__panel__')) return; // 忽略其他面板
    createPeer(peerId, nick);
  });

  // 有人离开
  socket.on('peer_left', ({ peerId }) => {
    removeCell(peerId);
    const p = peers.get(peerId);
    if (p) {
      try { if (p.audioSource) p.audioSource.disconnect(); } catch (_) {}
      try { if (p.audioEl) { p.audioEl.pause(); p.audioEl.srcObject = null; } } catch (_) {}
      p.pc.close();
      peers.delete(peerId);
    }
  });

  // 某人麦克风静音/取消静音
  socket.on('mic_state', ({ peerId, muted }) => {
    setMicMuted(peerId, muted);
  });

  // WebRTC 信令
  socket.on('webrtc_signal', (msg) => {
    if (msg.targetId && msg.targetId !== myId) return;
    const peerId = msg.sourceId;
    const p = peers.get(peerId);
    if (msg.kind === 'offer') {
      const pc = createPeer(peerId, msg.nick);
      pc.setRemoteDescription(new RTCSessionDescription(msg.data))
        .then(() => {
          // 冲刷早到的 ICE 候选
          const target = peers.get(peerId);
          if (target && target.pendingCandidates) {
            const list = target.pendingCandidates;
            target.pendingCandidates = [];
            list.forEach((c) => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
          }
          tuneVideoReceiver(pc);
        })
        .then(() => pc.createAnswer())
        .then((a) => pc.setLocalDescription(mungeLocalSdp(a)))
        .then(() => {
          socket.emit('webrtc_signal', { roomId, targetId: peerId, kind: 'answer', data: pc.localDescription, sourceId: myId });
        })
        .catch((err) => console.log('[panel] offer/answer error:', err));
    } else if (msg.kind === 'answer') {
      if (p) p.pc.setRemoteDescription(new RTCSessionDescription(msg.data)).catch(() => {});
    } else if (msg.kind === 'ice') {
      if (!p) return;
      if (p.pc.remoteDescription) p.pc.addIceCandidate(new RTCIceCandidate(msg.data)).catch(() => {});
      else (p.pendingCandidates = p.pendingCandidates || []).push(msg.data);
    }
  });
})();
