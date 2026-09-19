// Node 信令服务器: 管理房间 + 转发 WebRTC 信令消息
// socket.io Server 自带 /socket.io/socket.io.js 客户端库, 渲染层直接引用
const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer();
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// 在内存中维护一个房间的参与者列表(仅用于广播房间成员)
const rooms = new Map(); // roomId -> Set<socketId>
const nicks = new Map(); // socketId -> nick
const micMuted = new Map(); // socketId -> bool (麦克风是否静音)

function broadcastRoom(roomId, payload, exceptSocketId = null) {
  const members = rooms.get(roomId);
  if (!members) return;
  for (const sid of members) {
    if (sid === exceptSocketId) continue;
    io.to(sid).emit(payload.type, payload.data);
  }
}

io.on('connection', (socket) => {
  // 加入房间
  socket.on('join_room', ({ roomId, nick }) => {
    socket.join(roomId);
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    rooms.get(roomId).add(socket.id);
    if (nick) nicks.set(socket.id, nick);

    // 让新加入的人得到当前所有在线成员(用于 mesh 连接), 含昵称与麦克风静音状态
    const others = [...rooms.get(roomId)].filter((id) => id !== socket.id)
      .map((id) => ({ peerId: id, nick: nicks.get(id) || id.slice(0, 8), micMuted: !!micMuted.get(id) }));
    socket.emit('room_members', { roomId, others });

    // 让旧成员知道新的人来了, 附带昵称
    for (const id of others) {
      io.to(id.peerId).emit('peer_joined', { roomId, peerId: socket.id, nick: nick || socket.id.slice(0, 8) });
    }

    console.log(`[server] ${socket.id} (${nick || 'anon'}) joined room ${roomId} (total ${rooms.get(roomId).size})`);
  });

  // 离开房间
  socket.on('leave_room', ({ roomId }) => {
    const members = rooms.get(roomId);
    if (!members) return;
    members.delete(socket.id);
    nicks.delete(socket.id);
    micMuted.delete(socket.id);
    socket.leave(roomId);
    if (members.size === 0) rooms.delete(roomId);

    for (const id of members) {
      io.to(id).emit('peer_left', { roomId, peerId: socket.id });
    }
    console.log(`[server] ${socket.id} left room ${roomId} (total ${members.size})`);
  });

  // 麦克风静音状态变化: 记录并转发给房间内其他人(置顶摄像头面板据此显示静音图标)
  socket.on('mic_state', ({ roomId, muted }) => {
    micMuted.set(socket.id, !!muted);
    const members = rooms.get(roomId);
    if (!members) return;
    for (const id of members) {
      if (id === socket.id) continue;
      io.to(id).emit('mic_state', { roomId, peerId: socket.id, muted: !!muted });
    }
  });

  // 转发 ICE candidate / offer / answer 等 WebRTC 信令消息
  socket.on('webrtc_signal', (msg) => {
    // msg: { roomId, targetId, kind: 'offer'|'answer'|'ice', data }
    if (msg.targetId) {
      io.to(msg.targetId).emit('webrtc_signal', msg);
    } else {
      broadcastRoom(msg.roomId, { type: 'webrtc_signal', data: msg });
    }
  });

  socket.on('disconnect', () => {
    micMuted.delete(socket.id);
    for (const [roomId, members] of rooms) {
      if (members.has(socket.id)) {
        members.delete(socket.id);
        if (members.size === 0) rooms.delete(roomId);
        for (const id of members) {
          io.to(id).emit('peer_left', { roomId, peerId: socket.id });
        }
        console.log(`[server] ${socket.id} disconnected from room ${roomId}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[server] 端口 ${PORT} 已被占用 —— 信令服务很可能已在运行，无需重复启动。`);
    console.log(`[server] 如需重启，请先关掉旧进程：`);
    console.log(`         1) 找出占用进程:  Get-NetTCPConnection -LocalPort ${PORT} -State Listen | Select OwningProcess`);
    console.log(`         2) 杀掉它:        Stop-Process -Id <PID> -Force`);
    process.exit(0);
  }
  throw err;
});
server.listen(PORT, () => {
  console.log(`[server] signaling server listening on http://localhost:${PORT}`);
});
