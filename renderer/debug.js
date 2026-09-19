// 调试: 确认 input 是否能获取焦点/输入
['nick', 'roomId'].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) { console.log('[debug] ' + id + ' not found'); return; }
  console.log('[debug] ' + id + ' found, readonly=' + el.readOnly, 'disabled=' + el.disabled, 'tabIndex=' + el.tabIndex, 'value=' + el.value);
  el.addEventListener('focus', () => console.log('[debug] ' + id + ' focused'));
  el.addEventListener('input', () => console.log('[debug] ' + id + ' input event, value=' + el.value));
  el.addEventListener('click', () => console.log('[debug] ' + id + ' clicked'));
  el.addEventListener('mousedown', () => console.log('[debug] ' + id + ' mousedown'));
});
console.log('[debug] window.api =', JSON.stringify(window.api || null));
console.log('[debug] io type =', typeof io, '| io connected?', !!(io && io.prototype));
