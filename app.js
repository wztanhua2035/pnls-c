const $ = selector => document.querySelector(selector);
let state = null, dirty = false, busy = false;
let typingQueue = '', typingText = '', typingTimer = null, typingWaiters = [];

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const raw = await response.text(); let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`服务器返回 ${response.status}：${raw.slice(0, 120) || '无法解析的响应'}`); }
  if (!response.ok) throw new Error(data.error || '请求失败'); return data;
}
function message(element, text, good = false) { element.textContent = text; element.className = `message ${good ? 'success' : ''}`; }
function escapeHtml(text) { const div = document.createElement('div'); div.textContent = String(text); return div.innerHTML; }
function renderMeta(next) {
  state = next;
  $('#chapter').textContent = next.chapter; $('#location').textContent = next.location; $('#time').textContent = next.time;
  $('#statName').textContent = next.playerName; $('#statTurn').textContent = `第 ${next.turn} 回合`; $('#statHp').textContent = next.hpStatus;
  $('#resAntibiotic').textContent = `${next.resources.antibiotic} 片`; $('#resFlashlight').textContent = `${next.resources.flashlight} 次`;
  const relations = Object.entries(next.affections || {});
  $('#affections').innerHTML = relations.length ? relations.map(([name, value]) => `<div class="affection"><div><span>${escapeHtml(name)}</span><b>${value}</b></div><i><em style="width:${Math.max(0, Math.min(100, (value + 50) / 1.5))}%"></em></i></div>`).join('') : '<p class="muted relation-empty">尚未结识可记录的人物</p>';
}
function renderStory(text) {
  $('#storyText').classList.remove('streaming');
  $('#storyText').innerHTML = String(text || '').split(/\n+/).filter(Boolean).map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join('');
}
function renderOptions(options = []) {
  $('#options').innerHTML = options.map((option, index) => `<button data-option="${index + 1}"><span>${index + 1}</span>${escapeHtml(option)}</button>`).join('');
}
function render(next) { renderMeta(next); renderStory(next.narrative); renderOptions(next.options); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function setBusy(value) {
  busy = value; $('#busy').classList.toggle('hidden', !value); $('#sendBtn').disabled = value; $('#actionInput').disabled = value;
  $('#saveBtn').disabled = value; $('#quitBtn').disabled = value;
}
function hideBusyOverlay() { $('#busy').classList.add('hidden'); }
function resetTyping() {
  if (typingTimer) clearTimeout(typingTimer); typingTimer = null; typingQueue = ''; typingText = '';
  typingWaiters.splice(0).forEach(resolve => resolve()); $('#storyText').textContent = ''; $('#storyText').classList.add('streaming');
}
function runTyping() {
  if (typingTimer || !typingQueue) return;
  const tick = () => {
    if (!typingQueue) { typingTimer = null; typingWaiters.splice(0).forEach(resolve => resolve()); return; }
    typingText += typingQueue[0]; typingQueue = typingQueue.slice(1); $('#storyText').textContent = typingText;
    const delay = typingQueue.length > 160 ? 6 : typingQueue.length > 60 ? 10 : 16; typingTimer = setTimeout(tick, delay);
  };
  typingTimer = setTimeout(tick, 0);
}
function enqueueNarrative(text) { typingQueue += text; runTyping(); }
function waitForTyping() { return !typingQueue && !typingTimer ? Promise.resolve() : new Promise(resolve => typingWaiters.push(resolve)); }
async function readTurnStream(response) {
  if (!response.ok) { const raw = await response.text(); try { throw new Error(JSON.parse(raw).error || '请求失败'); } catch (error) { if (error instanceof SyntaxError) throw new Error(`服务器返回 ${response.status}：${raw.slice(0, 120)}`); throw error; } }
  if (!response.body) throw new Error('浏览器无法接收流式剧情');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '', completed = null;
  const handle = event => {
    if (event.type === 'narrative') { hideBusyOverlay(); enqueueNarrative(event.text || ''); }
    if (event.type === 'complete') completed = event;
    if (event.type === 'error') throw new Error(event.error || '剧情生成失败');
  };
  while (true) {
    const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
    for (const line of lines) if (line.trim()) handle(JSON.parse(line));
  }
  if (buffer.trim()) handle(JSON.parse(buffer)); if (!completed) throw new Error('剧情流意外中断，请重试'); return completed;
}
async function takeTurn(input) {
  if (busy) return; const previous = state; setBusy(true); message($('#gameMessage'), ''); $('#options').innerHTML = ''; $('#actionInput').value = ''; resetTyping();
  try {
    const response = await fetch('/api/game/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
    const completed = await readTurnStream(response); await waitForTyping(); dirty = true;
    renderStory(completed.state.narrative); renderMeta(completed.state); renderOptions(completed.state.options); message($('#gameMessage'), '剧情与状态已更新', true);
  } catch (error) {
    if (previous) render(previous); message($('#gameMessage'), error.message);
  } finally { setBusy(false); }
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault(); const submit = event.submitter; submit.disabled = true;
  try {
    const data = await api('/api/game/login', { method: 'POST', body: JSON.stringify({ name: $('#playerName').value, password: $('#playerPassword').value, mode: new FormData(event.target).get('mode') }) });
    dirty = false; $('#loginView').classList.add('hidden'); $('#gameView').classList.remove('hidden'); render(data.state);
  } catch (error) { message($('#loginMessage'), error.message); } finally { submit.disabled = false; }
});
$('#options').addEventListener('click', event => { const button = event.target.closest('button[data-option]'); if (button && !busy) takeTurn(`${button.dataset.option}. ${button.textContent.slice(1).trim()}`); });
$('#actionForm').addEventListener('submit', event => { event.preventDefault(); const value = $('#actionInput').value.trim(); if (value) takeTurn(value); });
$('#saveBtn').addEventListener('click', async () => { try { await api('/api/game/save', { method: 'POST', body: '{}' }); dirty = false; message($('#gameMessage'), '进度已保存', true); } catch (error) { message($('#gameMessage'), error.message); } });
$('#quitBtn').addEventListener('click', () => { if (dirty) $('#quitDialog').showModal(); else quit(false); });
$('#saveQuit').addEventListener('click', event => { event.preventDefault(); quit(true); }); $('#discardQuit').addEventListener('click', event => { event.preventDefault(); quit(false); });
async function quit(save) { try { await api('/api/game/quit', { method: 'POST', body: JSON.stringify({ save }) }); dirty = false; location.reload(); } catch (error) { message($('#gameMessage'), error.message); } }
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
setInterval(() => { if (state && !document.hidden) fetch('/api/game/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {}); }, 30000);
api('/api/game/state').then(data => { dirty = data.dirty; $('#loginView').classList.add('hidden'); $('#gameView').classList.remove('hidden'); render(data.state); }).catch(() => {});
