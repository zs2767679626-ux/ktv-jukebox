// WebSocket 连接管理：自动重连（1s 起步指数退避，上限 10s）
export function createWsClient(url, { onMessage, onStatus }) {
  let ws = null;
  let closed = false;
  let retry = 1000;

  function connect() {
    ws = new WebSocket(url);
    ws.onopen = () => { retry = 1000; onStatus('online'); };
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch { /* 忽略坏包 */ }
    };
    ws.onclose = () => {
      if (closed) return;
      onStatus('offline');
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 10000);
    };
    ws.onerror = () => ws.close();
  }

  return {
    connect,
    send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    close() { closed = true; if (ws) ws.close(); },
  };
}
