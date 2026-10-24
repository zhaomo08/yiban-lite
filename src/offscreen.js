// Chrome 138+ 的本地网络访问限制会拦截 service worker 发往 127.0.0.1 / 局域网的请求，扩展页面不受影响；
// 后台把模型请求交给这个隐藏页面执行。
const controllers = new Map();

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'offscreen') return;
  if (message.type === 'ABORT') { controllers.get(message.id)?.abort(); return; }
  if (message.type !== 'FETCH') return;
  const controller = new AbortController(); controllers.set(message.id, controller);
  fetch(message.url, { ...message.init, signal: controller.signal })
    .then(async response => respond({ ok: response.ok, status: response.status, text: await response.text() }),
      error => respond({ error: error.name === 'AbortError' ? 'abort' : `${error.name}: ${error.message}` }))
    .finally(() => controllers.delete(message.id));
  return true;
});
