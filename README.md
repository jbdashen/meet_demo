# 会议 Demo (Electron + WebRTC)

仿腾讯会议的多人语音/摄像头/屏幕共享 demo。

## 目录结构
- `server/index.js` 信令服务器 (Node + socket.io, 端口 3001)
- `main.js` / `preload.js` Electron 主进程
- `renderer/` 渲染层 UI + WebRTC mesh 逻辑
  - `index.html` `styles.css` `app.js`
- `start.bat` 一键启动

## 运行方式
```
P:\meet_demo\start.bat
```
或手动两步:
```
node server/index.js          # 1) 信令服务
node_modules\electron\dist\electron.exe P:\meet_demo   # 2) 客户端
```

## 多人测试
打开 **多个** `start.bat`（或多个 electron 窗口），全部加入**相同房间号**（默认 100）即可互看：
- 远端的人出现一个独立视频格子
- 麦克风 / 摄像头按钮可静音、关画面
- “共享屏幕”按钮调用 `getDisplayMedia`，把自己共享的窗口/桌面发给房间内其他人

> 需要本机能访问摄像头/麦克风；屏幕共享会弹出系统选择窗口。
> 公网互连需要 TURN/STUN 支持，demo 默认仅局域网 P2P（ICE 用 Google STUN）。

## 已解决的环境坑
- electron 二进制下载：本机 CA 校验失败 → 改用国内镜像 `registry.npmmirror.com` 手动下载解压
- Windows GPU 缓存“拒绝访问” → `disableHardwareAcceleration()` + `setPath('userData', 本地目录)`
