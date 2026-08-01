const $ = s => document.querySelector(s);
let state = null, dirty = false, busy = false;
async function api(url, options = {}) { const r = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } }); const data = await r.json(); if (!r.ok) throw new Error(data.error || '请求失败'); return data; }
function message(el, text, good = false) { el.textContent = text; el.className = `message ${good ? 'success' : ''}`; }
function render(s) {
  state = s; $('#chapter').textContent = s.chapter; $('#location').textContent = s.location; $('#time').textContent = s.time; $('#statName').textContent = s.playerName; $('#statTurn').textContent = `第 ${s.turn} 回合`; $('#statHp').textContent = s.hpStatus; $('#resAntibiotic').textContent = `${s.resources.antibiotic} 片`; $('#resFlashlight').textContent = `${s.resources.flashlight} 次`;
  $('#affections').innerHTML = Object.entries(s.affections).map(([name, value]) => `<div class="affection"><div><span>${escapeHtml(name)}</span><b>${value}</b></div><i><em style="width:${Math.max(0, Math.min(100, (value + 50) / 1.5))}%"></em></i></div>`).join('');
  $('#storyText').innerHTML = s.narrative.split(/\n+/).filter(Boolean).map(p => `<p>${escapeHtml(p)}</p>`).join('');
  $('#options').innerHTML = s.options.map((o, i) => `<button data-option="${i + 1}"><span>${i + 1}</span>${escapeHtml(o)}</button>`).join('');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function escapeHtml(t) { const d = document.createElement('div'); d.textContent = String(t); return d.innerHTML; }
function setBusy(value) { busy = value; $('#busy').classList.toggle('hidden', !value); $('#sendBtn').disabled = value; }
async function takeTurn(input) { if (busy) return; setBusy(true); message($('#gameMessage'), ''); try { const data = await api('/api/game/turn', { method: 'POST', body: JSON.stringify({ input }) }); dirty = true; render(data.state); $('#actionInput').value = ''; } catch (e) { message($('#gameMessage'), e.message); } finally { setBusy(false); } }
$('#loginForm').addEventListener('submit', async e => { e.preventDefault(); const submit = e.submitter; submit.disabled = true; try { const data = await api('/api/game/login', { method: 'POST', body: JSON.stringify({ name: $('#playerName').value, password: $('#playerPassword').value, mode: new FormData(e.target).get('mode') }) }); dirty = false; $('#loginView').classList.add('hidden'); $('#gameView').classList.remove('hidden'); render(data.state); } catch (err) { message($('#loginMessage'), err.message); } finally { submit.disabled = false; } });
$('#options').addEventListener('click', e => { const btn = e.target.closest('button[data-option]'); if (btn) takeTurn(`${btn.dataset.option}. ${btn.textContent.slice(1).trim()}`); });
$('#actionForm').addEventListener('submit', e => { e.preventDefault(); const value = $('#actionInput').value.trim(); if (value) takeTurn(value); });
$('#saveBtn').addEventListener('click', async () => { try { await api('/api/game/save', { method: 'POST', body: '{}' }); dirty = false; message($('#gameMessage'), '进度已保存', true); } catch (e) { message($('#gameMessage'), e.message); } });
$('#quitBtn').addEventListener('click', () => { if (dirty) $('#quitDialog').showModal(); else quit(false); });
$('#saveQuit').addEventListener('click', e => { e.preventDefault(); quit(true); }); $('#discardQuit').addEventListener('click', e => { e.preventDefault(); quit(false); });
async function quit(save) { try { await api('/api/game/quit', { method: 'POST', body: JSON.stringify({ save }) }); dirty = false; location.reload(); } catch (e) { message($('#gameMessage'), e.message); } }
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
setInterval(() => { if (state && !document.hidden) fetch('/api/game/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {}); }, 30000);
api('/api/game/state').then(data => { dirty = data.dirty; $('#loginView').classList.add('hidden'); $('#gameView').classList.remove('hidden'); render(data.state); }).catch(() => {});
