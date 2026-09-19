// 摄像头小窗: 获取摄像头显示, 关闭按钮停止共享
(async () => {
  const video = document.getElementById('cam');
  const closeBtn = document.getElementById('closeBtn');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    video.srcObject = stream;
    video.play();
  } catch (e) {
    document.getElementById('label').textContent = '无摄像头';
  }

  closeBtn.onclick = () => {
    if (window.api && window.api.stopShare) window.api.stopShare();
  };
})();
