const input = document.getElementById('server-url');
const button = document.getElementById('connect');
const status = document.getElementById('status');
window.workpivotConnection.settings().then((settings) => {
  input.value = settings.serverUrl;
  status.textContent = settings.error || '';
});
document.getElementById('connection-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  button.textContent = '正在连接…';
  status.textContent = '';
  try {
    const result = await window.workpivotDesktop.loginServer(input.value, document.getElementById('username').value, document.getElementById('password').value);
    if (!result.ok) status.textContent = result.error;
  } catch { status.textContent = '无法连接服务器，请检查地址和网络后重试。'; }
  finally { button.disabled = false; button.textContent = '登录'; }
});
