/* ============================================================
 * 次元大战 Online - 浏览器客户端
 * ============================================================ */
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'dw-online-token';

let ws = null;
let YOU = null;     // 玩家快照（服务器下发）
let WORLD = null;   // 世界快照
let chosenDim = null;
let chatLog = [];
let reconnectDelay = 1000;

/* ---------- 连接 ---------- */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    reconnectDelay = 1000;
    setConn('✅ 已连接服务器');
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) sendMsg({ t: 'resume', token });
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    onMessage(m);
  };
  ws.onclose = () => {
    setConn('🔌 连接断开，重连中……');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
}

function sendMsg(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function setConn(text) { const el = $('conn-status'); if (el) el.textContent = text; }

/* ---------- 消息处理 ---------- */
function onMessage(m) {
  switch (m.t) {
    case 'auth':
      localStorage.setItem(TOKEN_KEY, m.token);
      YOU = m.you; WORLD = m.world;
      showGame();
      renderAll();
      reqTop();
      break;
    case 'you': YOU = m.you; renderYou(); break;
    case 'world': WORLD = m.world; renderWorld(); break;
    case 'combat': renderCombat(m.state); break;
    case 'combatEnd': onCombatEnd(m); break;
    case 'event': toast(m.msg); break;
    case 'log':
      if (WORLD) { WORLD.logs.unshift(m.entry); WORLD.logs = WORLD.logs.slice(0, 60); renderLog(); }
      toastIfImportant(m.entry);
      break;
    case 'chat': chatLog.unshift(m.entry); chatLog = chatLog.slice(0, 50); renderChat(); break;
    case 'mail': if (YOU) { YOU.mail = m.mail; renderMail(); toast(m.mail[0] ? '📬 ' + m.mail[0].msg : '📬 新战报'); } break;
    case 'top': renderTop(m.rows); break;
    case 'error':
      if (m.msg === 'TOKEN_INVALID') { localStorage.removeItem(TOKEN_KEY); return; }
      toast('⚠️ ' + m.msg);
      break;
  }
}

function toastIfImportant(entry) {
  if (entry.cls === 'warn') toast(entry.msg);
}

/* ---------- 登录/注册 ---------- */
function doLogin() {
  sendMsg({ t: 'login', user: $('li-user').value, pass: $('li-pass').value });
}
function doRegister() {
  if (!chosenDim && !$('rg-invite').value.trim()) return toast('⚠️ 请选择降临次元或填写邀请码');
  sendMsg({
    t: 'register',
    user: $('rg-user').value, pass: $('rg-pass').value,
    name: $('rg-name').value, dim: chosenDim, invite: $('rg-invite').value,
  });
}
function logout() {
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
}

function renderDimSelect() {
  $('dim-cards').innerHTML = DIMENSIONS.map((d) => `
    <div class="dim-card ${chosenDim === d.id ? 'chosen' : ''}" id="card-${d.id}" style="border-color:${d.color}" onclick="chooseDim('${d.id}')">
      <div class="dim-card-icon">${d.icon}</div>
      <div class="dim-card-name" style="color:${d.color}">${d.name}</div>
      <div class="dim-card-desc">${d.desc}</div>
    </div>`).join('');
}
function chooseDim(id) {
  chosenDim = id;
  document.querySelectorAll('.dim-card').forEach((el) => el.classList.remove('chosen'));
  $('card-' + id).classList.add('chosen');
}

/* ---------- 游戏操作 ---------- */
function hunt(i) { sendMsg({ t: 'hunt', region: i }); }
function act(skill) { sendMsg({ t: 'act', skill }); }
function flee() { sendMsg({ t: 'flee' }); }
function equipItem(id) { sendMsg({ t: 'equip', id }); }
function sellItem(id) { sendMsg({ t: 'sell', id }); }
function reqTop() { sendMsg({ t: 'top' }); }
function sendChat() {
  const text = $('chat-text').value.trim();
  if (!text) return;
  $('chat-text').value = '';
  sendMsg({ t: 'chat', text });
}
function copyInvite() {
  const text = `【次元大战】快来和我并肩作战！注册时填写我的邀请码 ${YOU.inviteCode}，降临【${dimName(YOU.dim)}】，我们一起打赢次元大战！地址：${location.origin}`;
  navigator.clipboard ? navigator.clipboard.writeText(text).then(() => toast('📋 邀请信息已复制，发给好友吧！')) : prompt('复制以下内容发送给好友：', text);
}
function toggleMail() { $('char-mail').classList.toggle('hidden'); }

/* ---------- 工具 ---------- */
const dimOf = (id) => DIMENSIONS.find((d) => d.id === id);
const dimName = (id) => { const d = dimOf(id); return d ? d.name : id; };
const statName = (s) => (s === 'hp' ? '生命' : s === 'atk' ? '攻击' : '防御');

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

/* ---------- 渲染 ---------- */
function showGame() {
  $('screen-login').classList.add('hidden');
  $('screen-game').classList.remove('hidden');
}

function renderAll() { renderYou(); renderWorld(); renderChat(); }

function renderYou() {
  if (!YOU) return;
  const d = dimOf(YOU.dim);
  $('hud-dim').innerHTML = `<span style="color:${d.color}">${d.icon} ${d.name}</span>`;
  $('hud-energy').textContent = `⚡体力 ${YOU.energy}/${YOU.energyCap}`;

  $('char-info').innerHTML = `
    <div class="char-name">${YOU.name} <span class="lv">Lv.${YOU.level}</span></div>
    <div class="bar"><div class="bar-fill hp" style="width:${(YOU.hp / YOU.maxHp) * 100}%"></div><span>HP ${YOU.hp}/${YOU.maxHp}</span></div>
    <div class="bar"><div class="bar-fill exp" style="width:${(YOU.exp / YOU.expNeed) * 100}%"></div><span>EXP ${YOU.exp}/${YOU.expNeed}</span></div>
    <div class="stat-row">⚔️攻击 ${YOU.atk} ｜ 🛡️防御 ${YOU.def} ｜ 💰金币 ${YOU.gold}</div>
    <div class="stat-row">🔥战力 ${YOU.power} ｜ 🌟世界意志加成 +${Math.round(YOU.willBuff * 100)}%</div>
    <div class="stat-row dim-text">击杀${YOU.kills} · PvP ${YOU.pvpWins}胜${YOU.pvpLosses}负 · 重生${YOU.rebirths}次</div>`;

  let eqHtml = '';
  const slotNames = { weapon: '武器', armor: '防具', acc: '饰品' };
  for (const key of ['weapon', 'armor', 'acc']) {
    const e = YOU.equip[key];
    eqHtml += `<div class="equip-slot">${slotNames[key]}：${e
      ? `<span style="color:${RARITIES[e.rarity].color}">${e.name}</span> (+${e.value}${statName(e.stat)})`
      : '<span class="dim-text">空</span>'}</div>`;
  }
  $('char-equip').innerHTML = eqHtml;

  $('char-skills').innerHTML = YOU.skills.map((sk) =>
    `<div class="skill ${sk.unlocked ? '' : 'locked'}" title="${sk.desc}">
      ${sk.unlocked ? '✅' : '🔒'} ${sk.name} <span class="dim-text">(Lv.${sk.lvl})</span></div>`).join('');

  $('char-bag').innerHTML = YOU.bag.length === 0
    ? '<div class="dim-text">背包空空如也</div>'
    : YOU.bag.map((e) =>
      `<div class="bag-item">
        <span style="color:${RARITIES[e.rarity].color}">${e.name}</span>
        <span class="dim-text">+${e.value}${statName(e.stat)}</span>
        <button class="mini-btn" onclick="equipItem('${e.id}')">装备</button>
        <button class="mini-btn" onclick="sellItem('${e.id}')">出售</button>
      </div>`).join('');

  $('invite-count').textContent = YOU.invites;
  $('invite-code').textContent = YOU.inviteCode;
  renderMail();
  renderMap();
}

function renderMail() {
  if (!YOU) return;
  $('char-mail').innerHTML = YOU.mail.length === 0
    ? '<div class="dim-text">暂无战报</div>'
    : YOU.mail.map((m) => `<div class="bag-item"><span>${m.msg}</span></div>`).join('');
}

function renderWorld() {
  if (!WORLD) return;
  $('hud-day').textContent = `第${WORLD.season}赛季 · 第${WORLD.week}周第${WORLD.dayOfWeek}天`;
  $('hud-online').textContent = `🟢 在线 ${WORLD.onlineCount} 人`;

  if (WORLD.nextWar) {
    const a = dimOf(WORLD.nextWar.a), b = dimOf(WORLD.nextWar.b);
    const daysLeft = WORLD.warDay - WORLD.dayOfWeek;
    const mine = YOU && (WORLD.nextWar.a === YOU.dim || WORLD.nextWar.b === YOU.dim);
    $('hud-war').innerHTML = `⚡ 本周大战：<b style="color:${a.color}">${a.name}</b> VS <b style="color:${b.color}">${b.name}</b>` +
      (daysLeft > 0 ? `（${daysLeft}天后结算）` : '（今天结算！）') + (mine ? ' 🚨你方参战' : '');
  } else {
    $('hud-war').textContent = WORLD.finished ? `👑 ${dimName(WORLD.champion)} 称霸诸天，新赛季即将开启` : '';
  }

  $('dims-list').innerHTML = WORLD.dims.map((info) => {
    const d = dimOf(info.id);
    const isMine = YOU && info.id === YOU.dim;
    const inWar = WORLD.nextWar && (WORLD.nextWar.a === info.id || WORLD.nextWar.b === info.id);
    return `<div class="dim-row ${info.alive ? '' : 'dead'} ${isMine ? 'mine' : ''}">
      <span style="color:${d.color}">${d.icon} ${d.name}</span>
      ${isMine ? '<span class="tag mine-tag">我方</span>' : ''}
      ${inWar && info.alive ? '<span class="tag war-tag">参战</span>' : ''}
      ${info.alive
        ? `<span class="dim-text">玩家${info.players}(在线${info.online}) · 战力${info.power} · ${info.wins}连胜${info.merit ? ' · 战意' + info.merit : ''}</span>`
        : '<span class="dim-text">💀 已淹灭</span>'}
    </div>`;
  }).join('');

  renderLog();
  renderMap();
}

function renderMap() {
  if (!YOU || !WORLD) return;
  const d = dimOf(YOU.dim);
  const inWar = WORLD.nextWar && (WORLD.nextWar.a === YOU.dim || WORLD.nextWar.b === YOU.dim);
  $('map-title').innerHTML = `${d.icon} ${d.name} · 地图`;
  $('map-regions').innerHTML = d.regions.map((r, i) => {
    const overlap = inWar && WORLD.overlapRegions.includes(i);
    const eDim = overlap ? dimOf(WORLD.nextWar.a === YOU.dim ? WORLD.nextWar.b : WORLD.nextWar.a) : null;
    return `<div class="region ${overlap ? 'overlap' : ''}" onclick="hunt(${i})">
      <div class="region-name">${overlap ? '🌀 ' : ''}${r.name} <span class="tier">T${r.tier}</span></div>
      <div class="region-desc dim-text">${overlap
        ? `重叠区！与${eDim.icon}${eDim.name}重叠，可遭遇并掠夺敌方玩家`
        : `怪物：${r.monsters.join('、')}`}</div>
      <div class="region-hint">点击探索（消耗1体力）</div>
    </div>`;
  }).join('');
}

function renderLog() {
  if (!WORLD) return;
  $('log-list').innerHTML = WORLD.logs.map((l) =>
    `<div class="log-item ${l.cls}"><span class="log-day">D${l.day}</span> ${l.msg}</div>`).join('');
}

function renderChat() {
  $('chat-list').innerHTML = chatLog.map((c) =>
    `<div class="log-item"><b>${c.from}</b>：${escapeHtml(c.text)}</div>`).join('');
}

function renderTop(rows) {
  $('top-list').innerHTML = rows.map((r, i) => {
    const d = dimOf(r.dim);
    return `<div class="dim-row">
      <span class="dim-text">#${i + 1}</span>
      <span>${r.online ? '🟢' : '⚪'} ${r.name}</span>
      <span style="color:${d.color}">${d.icon}</span>
      <span class="dim-text">Lv.${r.level} · 战力${r.power} · PvP${r.pvpWins}胜</span>
    </div>`;
  }).join('');
}

/* ---------- 战斗 ---------- */
function renderCombat(state) {
  $('combat-modal').classList.remove('hidden');
  $('combat-title').textContent = state.title;
  $('cb-pname').textContent = `${state.you.name} Lv.${state.you.level}`;
  $('cb-ename').textContent = `${state.enemy.name} Lv.${state.enemy.level}${state.enemy.isPlayer ? ' 👤' : ''}`;
  $('cb-php').style.width = Math.max(0, (state.you.hp / state.you.maxHp) * 100) + '%';
  $('cb-ehp').style.width = Math.max(0, (state.enemy.hp / state.enemy.maxHp) * 100) + '%';
  $('cb-php-t').textContent = `${state.you.hp}/${state.you.maxHp}`;
  $('cb-ehp-t').textContent = `${state.enemy.hp}/${state.enemy.maxHp}`;

  const box = $('combat-actions');
  box.innerHTML = '';
  const atkBtn = document.createElement('button');
  atkBtn.className = 'btn skill-btn';
  atkBtn.textContent = '🗡️ 普通攻击';
  atkBtn.onclick = () => act('普通攻击');
  box.appendChild(atkBtn);
  for (const sk of state.skills) {
    const b = document.createElement('button');
    b.className = 'btn skill-btn';
    b.textContent = sk.cd > 0 ? `${sk.name} (冷却${sk.cd})` : sk.name;
    b.title = sk.desc;
    b.disabled = sk.cd > 0;
    b.onclick = () => act(sk.name);
    box.appendChild(b);
  }
  const fleeBtn = document.createElement('button');
  fleeBtn.className = 'btn danger skill-btn';
  fleeBtn.textContent = '🏃 逃跑';
  fleeBtn.onclick = flee;
  box.appendChild(fleeBtn);

  $('combat-log').innerHTML = state.lines.map((l) => `<div class="clog ${l.cls}">${l.msg}</div>`).join('');
}

function onCombatEnd(m) {
  YOU = m.you;
  const logEl = $('combat-log');
  logEl.innerHTML = m.lines.map((l) => `<div class="clog ${l.cls}">${l.msg}</div>`).join('') + logEl.innerHTML;
  $('combat-actions').innerHTML = `<div class="${m.win ? 'clog good' : 'clog bad'}" style="font-size:15px">${m.win ? '🎉 战斗胜利！' : '💀 战斗失败……'}</div>
    <button class="btn primary" onclick="closeCombat()">确定</button>`;
  renderYou();
}
function closeCombat() { $('combat-modal').classList.add('hidden'); }

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 倒计时 ---------- */
setInterval(() => {
  if (!WORLD || !WORLD.nextDayAt) return;
  const ms = WORLD.nextDayAt - Date.now();
  if (ms <= 0) { $('hud-countdown').textContent = '⏳ 世界时间推进中……'; return; }
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  $('hud-countdown').textContent = `⏳ 距下一天 ${h > 0 ? h + ':' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}, 1000);

/* 体力定时刷新 */
setInterval(() => { if (YOU && ws && ws.readyState === 1) sendMsg({ t: 'you' }); }, 60 * 1000);

/* ---------- 初始化 ---------- */
window.addEventListener('load', () => {
  renderDimSelect();
  $('tab-login').onclick = () => {
    $('tab-login').classList.add('active'); $('tab-register').classList.remove('active');
    $('form-login').classList.remove('hidden'); $('form-register').classList.add('hidden');
  };
  $('tab-register').onclick = () => {
    $('tab-register').classList.add('active'); $('tab-login').classList.remove('active');
    $('form-register').classList.remove('hidden'); $('form-login').classList.add('hidden');
  };
  $('chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  $('li-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  connect();
});
