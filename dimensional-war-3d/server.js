/* ============================================================
 * 次元大战 3D · 实时动作多人服务端
 * 10Hz 世界模拟：怪物AI / 技能与弹道判定 / 重叠战场PvP / 升级掉落
 *
 * 环境变量：
 *   PORT                  端口（默认 3000）
 *   WAR_INTERVAL_MINUTES  重叠战场间隔（默认 12 分钟）
 *   WAR_DURATION_MINUTES  战场持续时间（默认 5 分钟）
 *   ADMIN_KEY             设置后可 /admin/war 手动开战
 * ============================================================ */
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const { DIMENSIONS, LAIR_ANGLES, MAP_HALF, LAIR_R, CLASSES, RARITIES } = require('./public/js/data.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const WAR_INTERVAL = (parseFloat(process.env.WAR_INTERVAL_MINUTES) || 12) * 60000;
const WAR_DURATION = (parseFloat(process.env.WAR_DURATION_MINUTES) || 5) * 60000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const SAVE_FILE = path.join(__dirname, 'players.json');

const TICK_MS = 100;            // 10Hz 模拟
const SNAP_MS = 100;            // 10Hz 快照
const MAX_SPEED = 26;            // 位置防作弊：最大移动速度（含翻滚/突进冲刺）
const MONSTER_RESPAWN_MS = 9000;
const PLAYER_RESPAWN_MS = 4000;
const SAFE_R = 12;              // 出生村庄安全区半径

/* 职业表（技能/属性均以服务器为准，定义在共享 data.js） */
const CLASS_MAP = Object.fromEntries(CLASSES.map((c) => [c.id, c]));
const clsOf = (p) => CLASS_MAP[p.cls] || CLASS_MAP.warrior;

const rnd = (a, b) => a + Math.random() * (b - a);
const dist2 = (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => Date.now();

/* ---------- 持久化（按昵称保存成长） ---------- */
let saved = {};
try { saved = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')); } catch (e) {}
let saveDirty = false;
setInterval(() => {
  if (!saveDirty) return;
  saveDirty = false;
  try { fs.writeFileSync(SAVE_FILE, JSON.stringify(saved)); } catch (e) {}
}, 30000);

/* ---------- 房间（每个次元一张地图 + 重叠战场） ---------- */
const rooms = {};
for (const d of DIMENSIONS) rooms[d.id] = makeRoom(d.id);
rooms.war = makeRoom('war');

function makeRoom(id) {
  return { id, players: new Map(), monsters: new Map(), projectiles: new Map() };
}

/* ---------- 怪物 ---------- */
let nextMid = 1;
function spawnMonsters(room, dimId) {
  const dim = DIMENSIONS.find((d) => d.id === dimId);
  if (!dim) return;
  for (let tier = 1; tier <= 4; tier++) {
    const names = dim.regions[tier - 1].monsters;
    for (let i = 0; i < 6; i++) {
      let ang, r;
      if (tier === 4) {
        // T4 怪聚集在 Boss 巢穴
        ang = (LAIR_ANGLES[dimId] || 0) + rnd(-0.12, 0.12);
        r = LAIR_R + rnd(-3, 3);
      } else {
        ang = rnd(0, Math.PI * 2);
        r = 16 + tier * 10.5 + rnd(-4, 4); // T1≈26 起，出生村庄(r<SAFE_R)为安全区
      }
      addMonster(room, {
        name: names[i % names.length], tier,
        x: Math.cos(ang) * r, z: Math.sin(ang) * r,
      });
    }
  }
}

function addMonster(room, { name, tier, x, z }) {
  const id = 'm' + nextMid++;
  room.monsters.set(id, {
    id, name, tier,
    x, z, spawnX: x, spawnZ: z, ry: rnd(0, 6.28),
    hp: 60 + tier * 70, maxHp: 60 + tier * 70,
    atk: 8 + tier * 7, speed: 3.0 + tier * 0.35,
    exp: 22 + tier * 20, gold: 8 + tier * 12,
    state: 'idle', targetId: null, atkT: 0, dieT: 0, wanderT: 0, wx: x, wz: z,
  });
}
for (const d of DIMENSIONS) spawnMonsters(rooms[d.id], d.id);

/* ---------- 世界BOSS：定时降临随机次元，击杀必掉史诗+装备 ---------- */
const BOSS_MS = +process.env.DW_BOSS_MS || 5 * 60 * 1000;
const BOSS_NAMES = {
  tech: '湮灭机神·零', xiuxian: '上古剑魔·殇', cyber: '霓虹暴君·VOID',
  magic: '深渊魔龙·灾厄', hunter: '万兽之王·饕餮',
};
let worldBoss = null;   // { roomId, mid, dim, name, x, z }
function spawnWorldBoss() {
  if (worldBoss) return;
  const dim = DIMENSIONS[Math.floor(Math.random() * DIMENSIONS.length)];
  const room = rooms[dim.id];
  const ang = (LAIR_ANGLES[dim.id] || 0);
  const id = 'm' + nextMid++;
  const bx = Math.cos(ang) * (LAIR_R - 8), bz = Math.sin(ang) * (LAIR_R - 8);
  const name = BOSS_NAMES[dim.id] || '次元主宰';
  room.monsters.set(id, {
    id, name, tier: 5, boss: true,
    x: bx, z: bz, spawnX: bx, spawnZ: bz, ry: 0,
    hp: 3200, maxHp: 3200, atk: 46, speed: 4.4,
    exp: 900, gold: 600,
    state: 'idle', targetId: null, atkT: 0, aoeT: now(), dieT: 0, wanderT: 0, wx: bx, wz: bz,
  });
  worldBoss = { roomId: dim.id, mid: id, dim: dim.id, name, x: +bx.toFixed(1), z: +bz.toFixed(1) };
  allCast({ t: 'feed', msg: `🔥🔥 世界BOSS【${name}】降临【${dim.name}】BOSS巢穴！击杀者必得史诗级装备与海量金币！` });
  allCast({ t: 'boss', alive: 1, dim: dim.id, name, x: worldBoss.x, z: worldBoss.z });
}
setInterval(spawnWorldBoss, BOSS_MS);

/* ---------- 玩家 ---------- */
let nextPid = 1;
const conns = new Map(); // ws -> player

function newPlayer(ws, name, dimId, clsId) {
  const id = 'p' + nextPid++;
  const rec = saved[name] || {};
  const p = {
    id, ws, name, dim: dimId, cls: clsId, room: dimId,
    x: rnd(-4, 4), z: rnd(-4, 4), ry: 0, anim: 'idle',
    level: rec.level || 1, exp: rec.exp || 0, gold: rec.gold || 0,
    kills: rec.kills || 0, pvpKills: rec.pvpKills || 0,
    hp: 0, dead: false, dieT: 0,
    cds: { basic: 0, q: 0, e: 0, r: 0 },
    pet: null, capCd: 0,
    sk: { basic: 1, q: 1, e: 1, r: 1, ...(rec.sk || {}) },
    skPts: rec.skPts != null ? rec.skPts : Math.max(0, (rec.level || 1) - 1),
    inv: Array.isArray(rec.inv) ? rec.inv.slice(0, INV_MAX) : [],
    equip: { weapon: null, helmet: null, armor: null, boots: null, acc: null, ...(rec.equip || {}) },
    lastMoveT: now(), lastX: 0, lastZ: 0,
  };
  // 恢复已捕捉的宝宝（满血归来）
  if (rec.pet && dimId === 'hunter') {
    p.pet = { ...rec.pet, hp: rec.pet.maxHp, x: p.x + 1.2, z: p.z + 1.2, ry: 0, atkT: 0, state: 'idle' };
  }
  p.hp = maxHp(p);
  return p;
}

/* ---------- 属性计算（基础 × 职业系数 + 装备加成） ---------- */
function statsOf(p) {
  const c = clsOf(p);
  let hp = (200 + p.level * 30) * c.hpMul;
  const base = (18 + p.level * 4) * c.dmgMul;
  let patk = c.dmgType === 'magic' ? base * 0.35 : base;
  let matk = c.dmgType === 'magic' ? base : base * 0.35;
  let armor = 6 + p.level * 1.2;
  let mres = 6 + p.level * 1.2;
  let spd = c.speed;
  for (const slot of Object.keys(p.equip || {})) {
    const it = p.equip[slot];
    if (!it) continue;
    hp += it.hp || 0; patk += it.patk || 0; matk += it.matk || 0;
    armor += it.armor || 0; mres += it.mres || 0; spd += it.spd || 0;
  }
  return { maxHp: Math.round(hp), patk, matk, armor, mres, spd };
}
const maxHp = (p) => statsOf(p).maxHp;
const atkOf = (p) => { const st = statsOf(p); return clsOf(p).dmgType === 'magic' ? st.matk : st.patk; };
const expNeed = (lvl) => 80 + (lvl - 1) * 60;
/* 技能等级增益：每点+18%伤害 / +15%治疗 */
const skDmgMul = (p, k) => 1 + 0.18 * ((p.sk[k] || 1) - 1);
const skHealMul = (p, k) => 1 + 0.15 * ((p.sk[k] || 1) - 1);

function persist(p) {
  saved[p.name] = {
    level: p.level, exp: p.exp, gold: p.gold, kills: p.kills, pvpKills: p.pvpKills,
    cls: p.cls, dim: p.dim, sk: p.sk, skPts: p.skPts, inv: p.inv, equip: p.equip,
    pet: p.pet ? { name: p.pet.name, tier: p.pet.tier, maxHp: p.pet.maxHp, atk: p.pet.atk } : null,
  };
  saveDirty = true;
}

function gainExp(p, n) {
  p.exp += n;
  let ups = 0;
  while (p.exp >= expNeed(p.level)) { p.exp -= expNeed(p.level); p.level++; ups++; }
  if (ups) {
    p.skPts += ups;
    p.hp = maxHp(p);
    roomCast(p.room, { t: 'lvl', id: p.id, level: p.level });
    send(p.ws, { t: 'feed', msg: `✨ 获得 ${ups} 个技能点，点击技能栏上的「+」升级技能！` });
  }
  sendYou(p);
  persist(p);
}

/* ---------- 装备与商店 ---------- */
const INV_MAX = 24;
const SLOT_NAMES = { weapon: '武器', helmet: '帽子', armor: '衣服', boots: '鞋子', acc: '饰品' };
const HELMET_NAMES = ['强化头盔', '守护之盔', '贤者之冠'];
const BOOTS_NAMES = ['疾行之靴', '迅捷之靴', '神行靴'];
const SHOP_WEAPON = ['制式利刃', '精工战刃', '名匠神兵'];
const SHOP_ARMOR = ['制式战甲', '精工铠甲', '名匠圣铠'];
const SHOP_ACC = ['力量徽记', '勇气勋章', '王者徽章'];

/* 按槽位/品质生成装备数值；q 为强度系数 */
function makeItem(slot, name, rar, q, spdBonus = 0) {
  const it = { slot, name: `${RARITIES[rar].name}·${name}`, rar, val: Math.round(110 * q) };
  if (slot === 'weapon') { it.patk = Math.round(9 * q); it.matk = Math.round(9 * q); }
  else if (slot === 'helmet') { it.hp = Math.round(55 * q); it.mres = Math.round(6 * q); }
  else if (slot === 'armor') { it.hp = Math.round(80 * q); it.armor = Math.round(8 * q); }
  else if (slot === 'boots') { it.hp = Math.round(35 * q); it.spd = +(0.25 + spdBonus).toFixed(2); }
  else { it.patk = Math.round(4.5 * q); it.matk = Math.round(4.5 * q); it.hp = Math.round(28 * q); }
  return it;
}

/* 野怪掉落：槽位随机，稀有度受怪物层级限制 */
function rollDrop(tier, dimId, minRar = 0) {
  const slots = ['weapon', 'helmet', 'armor', 'boots', 'acc'];
  const slot = slots[Math.floor(Math.random() * slots.length)];
  const maxRar = Math.min(4, tier);   // T1最多精良…T4可出传说
  let pool = RARITIES.slice(0, maxRar + 1);
  const total = pool.reduce((s, r) => s + r.weight, 0);
  let roll = Math.random() * total, rar = 0;
  for (let i = 0; i < pool.length; i++) { roll -= pool[i].weight; if (roll <= 0) { rar = i; break; } }
  rar = Math.min(maxRar, Math.max(rar, minRar));
  const dim = DIMENSIONS.find((d) => d.id === dimId) || DIMENSIONS[0];
  const idx = Math.min(2, Math.max(0, rar - 1));
  const name = slot === 'weapon' ? dim.weaponNames[idx]
    : slot === 'armor' ? dim.armorNames[idx]
    : slot === 'acc' ? dim.accNames[idx]
    : slot === 'helmet' ? HELMET_NAMES[idx] : BOOTS_NAMES[idx];
  const q = RARITIES[rar].mult * (0.7 + tier * 0.22);
  return makeItem(slot, name, rar, q, rar * 0.12);
}

/* 商店固定货架：每槽位 精良/稀有/史诗 三档 */
const SHOP = [];
{
  const prices = [350, 900, 2200];
  const defs = [
    ['weapon', SHOP_WEAPON], ['helmet', HELMET_NAMES], ['armor', SHOP_ARMOR],
    ['boots', BOOTS_NAMES], ['acc', SHOP_ACC],
  ];
  for (const [slot, names] of defs) {
    for (let i = 0; i < 3; i++) {
      const rar = i + 1;
      const it = makeItem(slot, names[i], rar, RARITIES[rar].mult * 1.15, i * 0.15);
      it.id = `s_${slot}_${i}`;
      it.price = prices[i];
      SHOP.push(it);
    }
  }
}

function sendInv(p) {
  send(p.ws, { t: 'inv', equip: p.equip, inv: p.inv, gold: p.gold });
}

function giveItem(p, item, srcText) {
  if (p.inv.length >= INV_MAX) {
    const g = Math.round(item.val * 0.5);
    p.gold += g;
    send(p.ws, { t: 'feed', msg: `🎒 背包已满，${srcText}的【${item.name}】自动折算 ${g} 金币` });
  } else {
    p.inv.push(item);
    send(p.ws, { t: 'feed', msg: `🎁 ${srcText}：获得【${item.name}】` });
    sendInv(p);
  }
  sendYou(p);
  persist(p);
}

/* ---------- 网络 ---------- */
const app = express();
/* 模型/音频等大文件强缓存 7 天，刷新页面无需重新下载 */
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '7d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => {
  res.json({ ok: true, online: conns.size, war: warState() });
});
app.get('/debug/room/:id', (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'no room' });
  res.json({
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, x: +p.x.toFixed(1), z: +p.z.toFixed(1), hp: Math.round(p.hp), dead: p.dead, room: p.room })),
    monsters: [...room.monsters.values()].slice(0, 50).map((m) => ({ id: m.id, name: m.name, tier: m.tier, x: +m.x.toFixed(1), z: +m.z.toFixed(1), hp: m.hp, state: m.state, targetId: m.targetId })),
  });
});
app.get('/admin/war', (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  startWar(req.query.a, req.query.b);
  res.json({ ok: true, war: warState() });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function roomCast(roomId, obj, exceptId = null) {
  const room = rooms[roomId];
  if (!room) return;
  const raw = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(raw);
  }
}
function allCast(obj) {
  const raw = JSON.stringify(obj);
  for (const p of conns.values()) if (p.ws.readyState === 1) p.ws.send(raw);
}

function sendYou(p) {
  const st = statsOf(p);
  send(p.ws, {
    t: 'you', hp: Math.max(0, Math.round(p.hp)), maxHp: st.maxHp, level: p.level, exp: p.exp, expNeed: expNeed(p.level),
    gold: p.gold, kills: p.kills, pvpKills: p.pvpKills, room: p.room, dim: p.dim,
    patk: Math.round(st.patk), matk: Math.round(st.matk), armor: Math.round(st.armor), mres: Math.round(st.mres),
    spd: +st.spd.toFixed(2), skPts: p.skPts, sk: p.sk,
  });
}

function publicP(p) {
  return { id: p.id, name: p.name, dim: p.dim, cls: p.cls, level: p.level, x: +p.x.toFixed(2), z: +p.z.toFixed(2), ry: +p.ry.toFixed(2), anim: p.anim, hp: Math.round(p.hp), maxHp: maxHp(p), dead: p.dead };
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    try { handle(ws, m); } catch (e) { console.error('[handle]', e); }
  });
  ws.on('close', () => {
    const p = conns.get(ws);
    if (!p) return;
    persist(p);
    leaveParty(p);
    rooms[p.room].players.delete(p.id);
    roomCast(p.room, { t: 'pleave', id: p.id });
    conns.delete(ws);
  });
});

/* ---------- 组队（最多4人，BOSS战共享经验） ---------- */
let nextPartyId = 1;
const parties = new Map();   // id -> { id, members: [player] }
const PARTY_MAX = 4;
const partyOf = (p) => (p.partyId ? parties.get(p.partyId) : null);

function partyMsg(party) {
  return {
    t: 'party',
    members: party ? party.members.map((m) => ({
      name: m.name, cls: m.cls, level: m.level,
      hp: Math.max(0, Math.round(m.hp)), maxHp: maxHp(m),
    })) : [],
  };
}
function partySync(party) { for (const m of party.members) send(m.ws, partyMsg(party)); }

function leaveParty(p) {
  const pa = partyOf(p);
  if (!pa) return;
  pa.members = pa.members.filter((m) => m !== p);
  p.partyId = null;
  send(p.ws, partyMsg(null));
  if (pa.members.length <= 1) {
    for (const m of pa.members) {
      m.partyId = null;
      send(m.ws, partyMsg(null));
      send(m.ws, { t: 'feed', msg: '👥 队伍已解散' });
    }
    parties.delete(pa.id);
  } else {
    partySync(pa);
    for (const m of pa.members) send(m.ws, { t: 'feed', msg: `👥 ${p.name} 离开了队伍` });
  }
}

function handleParty(p, m) {
  const op = m.op;
  if (op === 'invite') {
    const tgt = [...conns.values()].find((o) => o.name === String(m.name || ''));
    if (!tgt || tgt === p) return send(p.ws, { t: 'err', msg: '找不到该玩家（需在线）' });
    if (tgt.dim !== p.dim) return send(p.ws, { t: 'err', msg: '只能邀请同次元的玩家' });
    if (tgt.partyId) return send(p.ws, { t: 'err', msg: '对方已有队伍' });
    const pa = partyOf(p);
    if (pa && pa.members.length >= PARTY_MAX) return send(p.ws, { t: 'err', msg: `队伍已满（${PARTY_MAX}人）` });
    tgt.pinvite = { from: p.name, at: now() };
    send(tgt.ws, { t: 'pinvite', from: p.name });
    send(p.ws, { t: 'feed', msg: `👥 已向 ${tgt.name} 发出组队邀请` });
  } else if (op === 'accept') {
    const inv = p.pinvite;
    p.pinvite = null;
    if (!inv || now() - inv.at > 30000) return send(p.ws, { t: 'err', msg: '邀请已过期' });
    if (p.partyId) return;
    const inviter = [...conns.values()].find((o) => o.name === inv.from);
    if (!inviter) return send(p.ws, { t: 'err', msg: '邀请者已离线' });
    let pa = partyOf(inviter);
    if (!pa) {
      pa = { id: nextPartyId++, members: [inviter] };
      inviter.partyId = pa.id;
      parties.set(pa.id, pa);
    }
    if (pa.members.length >= PARTY_MAX) return send(p.ws, { t: 'err', msg: '队伍已满' });
    pa.members.push(p);
    p.partyId = pa.id;
    partySync(pa);
    for (const mm of pa.members) send(mm.ws, { t: 'feed', msg: `👥 ${p.name} 加入了队伍（${pa.members.length}/${PARTY_MAX}）` });
  } else if (op === 'decline') {
    if (p.pinvite) {
      const inviter = [...conns.values()].find((o) => o.name === p.pinvite.from);
      if (inviter) send(inviter.ws, { t: 'feed', msg: `👥 ${p.name} 婉拒了你的组队邀请` });
      p.pinvite = null;
    }
  } else if (op === 'leave') {
    leaveParty(p);
  }
}

function handle(ws, m) {
  let p = conns.get(ws);

  if (m.t === 'join') {
    if (p) return;
    const name = String(m.name || '').trim().slice(0, 12);
    const dim = DIMENSIONS.find((d) => d.id === m.dim);
    if (!name || !dim) return send(ws, { t: 'err', msg: '请输入昵称并选择次元' });
    const cls = CLASS_MAP[m.cls] ? m.cls : 'warrior';
    // 同名顶号
    for (const [ows, op] of conns) if (op.name === name) { send(ows, { t: 'err', msg: '该昵称在别处登录' }); ows.close(); }
    p = newPlayer(ws, name, dim.id, cls);
    conns.set(ws, p);
    joinRoom(p, dim.id, true);
    return;
  }
  if (!p) return;

  switch (m.t) {
    case 'mv': {
      if (p.dead) return;
      const t = now();
      const dt = Math.max(0.03, (t - p.lastMoveT) / 1000);
      let x = clamp(+m.x || 0, -MAP_HALF, MAP_HALF);
      let z = clamp(+m.z || 0, -MAP_HALF, MAP_HALF);
      // 速度防作弊：超速则按方向限幅
      const d = Math.sqrt(dist2(x, z, p.x, p.z));
      const maxD = MAX_SPEED * dt;
      if (d > maxD && d > 0) {
        x = p.x + (x - p.x) / d * maxD;
        z = p.z + (z - p.z) / d * maxD;
      }
      p.x = x; p.z = z;
      p.ry = +m.ry || 0;
      p.anim = m.anim === 'run' ? 'run' : 'idle';
      p.lastMoveT = t;
      return;
    }
    case 'cast': return cast(p, m);
    case 'war': {
      if (!war.active) return send(p.ws, { t: 'err', msg: '重叠战场未开启' });
      if (m.enter) {
        if (p.dim !== war.a && p.dim !== war.b) return send(p.ws, { t: 'err', msg: '你的次元未参战' });
        if (p.room !== 'war') joinRoom(p, 'war');
      } else if (p.room === 'war') {
        joinRoom(p, p.dim);
      }
      return;
    }
    case 'respawn': {
      if (!p.dead || now() - p.dieT < PLAYER_RESPAWN_MS) return;
      p.dead = false;
      p.hp = maxHp(p);
      const sp = spawnPoint(p);
      p.x = sp.x; p.z = sp.z;
      if (p.pet) { p.pet.hp = p.pet.maxHp; p.pet.x = p.x + 1.2; p.pet.z = p.z + 1.2; }
      roomCast(p.room, { t: 'prespawn', id: p.id, x: p.x, z: p.z, hp: p.hp });
      sendYou(p);
      return;
    }
    case 'capture': return capturePet(p);
    case 'party': return handleParty(p, m);
    case 'chat': {
      const msg = String(m.msg || '').trim().slice(0, 60);
      if (!msg) return;
      const t = now();
      if (p.lastChatT && t - p.lastChatT < 1200) return;  // 防刷屏
      p.lastChatT = t;
      roomCast(p.room, { t: 'chat', name: p.name, dim: p.dim, msg });
      return;
    }
    case 'rank': {
      // 全服排行榜：含离线玩家（存档）+ 在线实时数据
      const all = new Map();
      for (const [name, rec] of Object.entries(saved)) {
        all.set(name, { name, level: rec.level || 1, kills: rec.kills || 0, pvpKills: rec.pvpKills || 0, gold: rec.gold || 0, dim: rec.dim || '', cls: rec.cls || '', online: false });
      }
      for (const op of conns.values()) {
        all.set(op.name, { name: op.name, level: op.level, kills: op.kills, pvpKills: op.pvpKills, gold: op.gold, dim: op.dim, cls: op.cls, online: true });
      }
      const list = [...all.values()]
        .sort((a, b) => b.level - a.level || b.pvpKills - a.pvpKills || b.kills - a.kills)
        .slice(0, 20);
      return send(p.ws, { t: 'rank', list });
    }
    case 'sklvl': {
      const k = ['basic', 'q', 'e', 'r'].includes(m.k) ? m.k : null;
      if (!k || p.skPts <= 0) return;
      const sk = clsOf(p).skills[k];
      if (sk.minLvl && p.level < sk.minLvl) return send(p.ws, { t: 'err', msg: `该技能 Lv.${sk.minLvl} 才解锁` });
      if (p.sk[k] >= 5) return send(p.ws, { t: 'err', msg: '该技能已升满（5级）' });
      p.sk[k]++; p.skPts--;
      send(p.ws, { t: 'feed', msg: `⬆️ 【${sk.name}】升至 ${p.sk[k]} 级！` });
      sendYou(p); persist(p);
      return;
    }
    case 'equip': {
      const i = m.i | 0;
      const item = p.inv[i];
      if (!item || !SLOT_NAMES[item.slot]) return;
      const old = p.equip[item.slot];
      p.inv.splice(i, 1);
      if (old) p.inv.push(old);
      p.equip[item.slot] = item;
      p.hp = Math.min(p.hp, maxHp(p));
      sendInv(p); sendYou(p); persist(p);
      return;
    }
    case 'unequip': {
      const slot = SLOT_NAMES[m.slot] ? m.slot : null;
      if (!slot || !p.equip[slot]) return;
      if (p.inv.length >= INV_MAX) return send(p.ws, { t: 'err', msg: '背包已满，无法卸下' });
      p.inv.push(p.equip[slot]);
      p.equip[slot] = null;
      p.hp = Math.min(p.hp, maxHp(p));
      sendInv(p); sendYou(p); persist(p);
      return;
    }
    case 'sell': {
      const i = m.i | 0;
      const item = p.inv[i];
      if (!item) return;
      const g = Math.round(item.val * 0.4);
      p.inv.splice(i, 1);
      p.gold += g;
      send(p.ws, { t: 'feed', msg: `💰 出售【${item.name}】获得 ${g} 金币` });
      sendInv(p); sendYou(p); persist(p);
      return;
    }
    case 'buy': {
      const it = SHOP.find((s) => s.id === m.id);
      if (!it) return;
      if (p.gold < it.price) return send(p.ws, { t: 'err', msg: `金币不足（需要 ${it.price}）` });
      if (p.inv.length >= INV_MAX) return send(p.ws, { t: 'err', msg: '背包已满' });
      p.gold -= it.price;
      const { id, price, ...item } = it;
      p.inv.push({ ...item });
      send(p.ws, { t: 'feed', msg: `🛒 购买【${it.name}】成功！记得在背包中装备` });
      sendInv(p); sendYou(p); persist(p);
      return;
    }
  }
}

/* ---------- 猎人专属：捕捉宝宝 ---------- */
function capturePet(p) {
  if (p.dead) return;
  if (p.dim !== 'hunter') return send(p.ws, { t: 'err', msg: '只有猎人世界的降临者拥有捕捉天赋' });
  const t = now();
  if (t < p.capCd) return;
  p.capCd = t + 3000;
  const room = rooms[p.room];
  let best = null, bd = 6.5 * 6.5;
  for (const mo of room.monsters.values()) {
    if (mo.state === 'dead' || mo.tier > 3) continue;
    const d2 = dist2(p.x, p.z, mo.x, mo.z);
    if (d2 < bd) { bd = d2; best = mo; }
  }
  if (!best) return send(p.ws, { t: 'err', msg: '附近没有可捕捉的野怪（T4头目无法捕捉）' });
  const ratio = best.hp / best.maxHp;
  if (ratio > 0.4) return send(p.ws, { t: 'err', msg: `先把【${best.name}】打到40%血以下再捕捉（当前${Math.round(ratio * 100)}%）` });
  const chance = Math.min(0.9, 0.95 - ratio * 1.5);   // 40%血≈35%成功率，10%血≈80%
  if (Math.random() < chance) {
    best.state = 'dead'; best.dieT = t;
    roomCast(p.room, { t: 'mdie', id: best.id, by: p.id });
    if (p.pet) send(p.ws, { t: 'feed', msg: `🔄 你放生了【${p.pet.name}】` });
    p.pet = {
      name: best.name, tier: best.tier,
      maxHp: Math.round(best.maxHp * 1.1), hp: Math.round(best.maxHp * 1.1),
      atk: Math.round(best.atk * 0.9),
      x: p.x + 1.2, z: p.z + 1.2, ry: 0, atkT: 0, state: 'idle',
    };
    persist(p);
    roomCast(p.room, { t: 'feed', msg: `🐾 ${p.name} 成功捕捉【${best.name}】当宝宝，它将替主人战斗！` });
  } else {
    send(p.ws, { t: 'err', msg: `💨 【${best.name}】挣脱了捕捉！（成功率${Math.round(chance * 100)}%，血越少越容易抓）` });
  }
}

function spawnPoint(p) {
  if (p.room === 'war') {
    const side = p.dim === war.a ? -1 : 1;
    return { x: side * 60 + rnd(-3, 3), z: rnd(-10, 10) };
  }
  return { x: rnd(-4, 4), z: rnd(-4, 4) };
}

function joinRoom(p, roomId, isFirst = false) {
  if (p.room && rooms[p.room].players.has(p.id)) {
    rooms[p.room].players.delete(p.id);
    roomCast(p.room, { t: 'pleave', id: p.id });
  }
  p.room = roomId;
  const sp = spawnPoint(p);
  p.x = sp.x; p.z = sp.z;
  p.dead = false;
  if (p.pet) { p.pet.x = p.x + 1.2; p.pet.z = p.z + 1.2; }
  if (p.hp <= 0) p.hp = maxHp(p);
  rooms[roomId].players.set(p.id, p);
  send(p.ws, {
    t: 'welcome', id: p.id, room: roomId, first: isFirst,
    you: { name: p.name, dim: p.dim, cls: p.cls, level: p.level, exp: p.exp, expNeed: expNeed(p.level), gold: p.gold, hp: Math.round(p.hp), maxHp: maxHp(p), kills: p.kills, pvpKills: p.pvpKills },
    players: [...rooms[roomId].players.values()].filter((o) => o.id !== p.id).map(publicP),
    war: warState(),
    boss: worldBoss ? { alive: 1, dim: worldBoss.dim, name: worldBoss.name, x: worldBoss.x, z: worldBoss.z } : null,
    shop: isFirst ? SHOP : undefined,
    equip: p.equip, inv: p.inv,
    x: p.x, z: p.z,
  });
  sendYou(p);
  roomCast(roomId, { t: 'pjoin', p: publicP(p) }, p.id);
}

/* ---------- 技能施放（服务器判定，按职业差异化） ---------- */
function cast(p, m) {
  if (p.dead) return;
  const kind = ['basic', 'q', 'e', 'r'].includes(m.k) ? m.k : null;
  if (!kind) return;
  const sk = clsOf(p).skills[kind];
  if (sk.minLvl && p.level < sk.minLvl) return send(p.ws, { t: 'err', msg: `${kind.toUpperCase()}技能需要 Lv.${sk.minLvl}` });
  const t = now();
  if (t < p.cds[kind]) return;
  p.cds[kind] = t + sk.cd;

  let dx = +m.dx || 0, dz = +m.dz || 0;
  const dl = Math.sqrt(dx * dx + dz * dz) || 1;
  dx /= dl; dz /= dl;
  p.ry = Math.atan2(dx, dz);

  // 广播给同房间其他人（用于播放动作/特效）
  roomCast(p.room, { t: 'cast', id: p.id, k: kind, kk: sk.kind, x: p.x, z: p.z, dx, dz }, p.id);

  const room = rooms[p.room];
  const dmgType = clsOf(p).dmgType;

  if (sk.kind === 'proj') {
    const id = 'j' + nextMid++;
    room.projectiles.set(id, {
      id, owner: p.id, x: p.x + dx * 0.5, z: p.z + dz * 0.5, dx, dz,
      speed: sk.speed, born: t, life: sk.life, hitR: sk.radius || 1.6,
      dmg: atkOf(p) * sk.mult * skDmgMul(p, kind), dmgType,
    });
    roomCast(p.room, { t: 'proj', id, owner: p.id, x: p.x, z: p.z, dx, dz, speed: sk.speed, dim: p.dim });
    return;
  }

  if (sk.kind === 'heal') {
    // 治疗自己 + 范围内伤势最重的队友
    const healed = new Set([p]);
    let worst = null, worstRatio = 1;
    for (const o of room.players.values()) {
      if (o.id === p.id || o.dead || o.dim !== p.dim) continue;
      if (dist2(p.x, p.z, o.x, o.z) > sk.range * sk.range) continue;
      const r = o.hp / maxHp(o);
      if (r < worstRatio) { worstRatio = r; worst = o; }
    }
    if (worst) healed.add(worst);
    for (const tgt of healed) applyHeal(p, tgt, sk.pct * skHealMul(p, kind));
    return;
  }

  if (sk.kind === 'aoeheal') {
    for (const o of room.players.values()) {
      if (o.dead || o.dim !== p.dim) continue;
      if (dist2(p.x, p.z, o.x, o.z) <= sk.radius * sk.radius) applyHeal(p, o, sk.pct * skHealMul(p, kind));
    }
    return;
  }

  // melee / aoe / dashmelee：立即判定
  const dmg = atkOf(p) * sk.mult * skDmgMul(p, kind) * rnd(0.9, 1.15);
  for (const tgt of targetsOf(p)) {
    const dx2 = tgt.x - p.x, dz2 = tgt.z - p.z;
    const d = Math.sqrt(dx2 * dx2 + dz2 * dz2);
    let hit = false;
    if (sk.kind === 'aoe') hit = d <= sk.radius;
    else {
      if (d <= sk.range) {
        const ang = Math.acos(clamp((dx2 * dx + dz2 * dz) / (d || 1), -1, 1));
        hit = ang <= sk.arc / 2;
      }
    }
    if (hit) applyDamage(p, tgt, dmg, dmgType);
  }
}

function applyHeal(healer, tgt, pct) {
  const mx = maxHp(tgt);
  const amt = Math.round(mx * pct);
  if (amt <= 0 || tgt.hp >= mx) return;
  tgt.hp = Math.min(mx, tgt.hp + amt);
  roomCast(healer.room, { t: 'heal', id: tgt.id, amt, hp: Math.round(tgt.hp), by: healer.id });
  sendYou(tgt);
}

/* 可被 p 攻击的目标：本房间怪物 + （战场内）敌方次元玩家 */
function targetsOf(p) {
  const room = rooms[p.room];
  const list = [...room.monsters.values()].filter((mo) => mo.state !== 'dead');
  if (p.room === 'war') {
    for (const o of room.players.values()) {
      if (o.id !== p.id && !o.dead && o.dim !== p.dim) list.push(o);
    }
  }
  return list;
}

/* 伤害结算：经过目标防御(物防/法防)与职业减伤 */
function applyDamage(attacker, tgt, dmg, dmgType = 'phys') {
  const isMonster = !!tgt.tier;
  const def = isMonster
    ? (dmgType === 'phys' ? tgt.tier * 7 : tgt.tier * 5)
    : (dmgType === 'phys' ? statsOf(tgt).armor : statsOf(tgt).mres);
  dmg = dmg * 100 / (100 + def);
  if (!isMonster) dmg *= clsOf(tgt).dmgTakenMul;
  dmg = Math.max(1, Math.round(dmg));
  tgt.hp -= dmg;
  roomCast(attacker.room, { t: 'dmg', kind: isMonster ? 'm' : 'p', id: tgt.id, amt: dmg, hp: Math.max(0, Math.round(tgt.hp)), by: attacker.id });
  if (isMonster) {
    tgt.targetId = attacker.id;
    if (tgt.state === 'idle') tgt.state = 'chase';
    if (tgt.hp <= 0) killMonster(attacker, tgt);
  } else {
    sendYou(tgt);
    if (tgt.hp <= 0) killPlayer(attacker, tgt);
  }
}

function killMonster(p, mo) {
  mo.state = 'dead';
  mo.dieT = now();
  p.kills++;
  p.gold += mo.gold;
  roomCast(p.room, { t: 'mdie', id: mo.id, by: p.id });
  if (mo.boss) {
    // 世界BOSS：必掉史诗级以上装备，全服公告
    giveItem(p, rollDrop(4, p.dim, 3), `世界BOSS【${mo.name}】掉落`);
    allCast({ t: 'feed', msg: `👑 【${dimName(p.dim)}】${p.name} 讨伐了世界BOSS【${mo.name}】，获得史诗战利品！` });
    allCast({ t: 'boss', alive: 0 });
    worldBoss = null;
  } else if (Math.random() < 0.14 + mo.tier * 0.05) {
    // 几率掉落装备（层级越高概率越大、品质越好）
    giveItem(p, rollDrop(mo.tier, p.dim), `【${mo.name}】掉落`);
  }
  gainExp(p, mo.exp); // 内部会 sendYou + persist
  // 组队共享经验：30米内的存活队友各得70%
  const pa = partyOf(p);
  if (pa) {
    for (const mm of pa.members) {
      if (mm !== p && !mm.dead && mm.room === p.room && dist2(mm.x, mm.z, p.x, p.z) < 30 * 30) {
        gainExp(mm, Math.max(1, Math.round(mo.exp * 0.7)));
      }
    }
  }
}

function killPlayer(killer, victim) {
  victim.hp = 0;
  victim.dead = true;
  victim.dieT = now();
  victim.anim = 'dead';
  const loot = Math.floor(victim.gold * 0.1);
  victim.gold -= loot;
  killer.gold += loot;
  killer.pvpKills++;
  if (war.active) {
    if (killer.dim === war.a) war.killsA++;
    else if (killer.dim === war.b) war.killsB++;
    allCast({ t: 'war', state: warState() });
  }
  roomCast(victim.room, { t: 'pdie', id: victim.id, by: killer.id });
  allCast({ t: 'feed', msg: `⚔️ 【${dimName(killer.dim)}】${killer.name} 在重叠战场击杀了 【${dimName(victim.dim)}】${victim.name}，掠夺 ${loot} 金币！` });
  sendYou(victim);
  gainExp(killer, 30 + victim.level * 10);
  persist(victim);
}

const dimName = (id) => { const d = DIMENSIONS.find((x) => x.id === id); return d ? d.name : id; };

const inSafeZone = (room, x, z) => room.id !== 'war' && x * x + z * z < SAFE_R * SAFE_R;

/* ---------- 重叠战场 ---------- */
const war = { active: false, a: null, b: null, endsAt: 0, nextAt: now() + WAR_INTERVAL, killsA: 0, killsB: 0 };

function warState() {
  return { active: war.active, a: war.a, b: war.b, endsAt: war.endsAt, nextAt: war.nextAt, killsA: war.killsA, killsB: war.killsB, duration: WAR_DURATION };
}

function startWar(a, b) {
  const ids = DIMENSIONS.map((d) => d.id);
  if (!ids.includes(a) || !ids.includes(b) || a === b) {
    const sh = [...ids].sort(() => Math.random() - 0.5);
    a = sh[0]; b = sh[1];
  }
  war.active = true; war.a = a; war.b = b;
  war.endsAt = now() + WAR_DURATION;
  war.killsA = 0; war.killsB = 0;
  // 战场刷新双方怪物（中立巨兽）
  rooms.war.monsters.clear();
  rooms.war.projectiles.clear();
  for (let i = 0; i < 8; i++) {
    addMonster(rooms.war, { name: '次元裂隙兽', tier: 3 + (i % 2), x: rnd(-24, 24), z: rnd(-24, 24) });
  }
  allCast({ t: 'war', state: warState() });
  allCast({ t: 'feed', msg: `🌀 次元重叠！【${dimName(a)}】与【${dimName(b)}】的重叠战场开启，参战次元的降临者可进入战场厮杀（${Math.round(WAR_DURATION / 60000)}分钟）！` });
}

function endWar() {
  const { a, b, killsA, killsB } = war;
  war.active = false;
  war.nextAt = now() + WAR_INTERVAL;
  const winner = killsA === killsB ? null : (killsA > killsB ? a : b);
  // 发奖并把战场玩家送回本次元
  for (const p of [...rooms.war.players.values()]) {
    const reward = winner === null ? 150 : (p.dim === winner ? 400 : 100);
    p.gold += reward;
    send(p.ws, { t: 'feed', msg: `🏁 战场结算：你获得 ${reward} 金币！` });
    persist(p);
    joinRoom(p, p.dim);
  }
  allCast({ t: 'war', state: warState() });
  allCast({ t: 'feed', msg: winner
    ? `🏁 重叠战场结束：【${dimName(winner)}】以 ${Math.max(killsA, killsB)}:${Math.min(killsA, killsB)} 击杀获胜！`
    : `🏁 重叠战场结束：双方 ${killsA}:${killsB} 战平！` });
}

/* ---------- 世界模拟主循环 ---------- */
function tickRoom(room) {
  const t = now();
  const dt = TICK_MS / 1000;

  // 弹道（扫掠式分段碰撞：高速弹丸不会穿过贴脸目标）
  for (const pr of [...room.projectiles.values()]) {
    const step = pr.speed * dt;
    const hr = pr.hitR || 1.6;
    const subs = Math.max(1, Math.ceil(step / Math.max(0.7, hr * 0.7)));
    let hitId = null;
    const owner = [...room.players.values()].find((p) => p.id === pr.owner);
    const targets = owner ? targetsOf(owner) : [];
    for (let s = 0; s <= subs && !hitId; s++) {
      const px = pr.x + pr.dx * step * (s / subs);
      const pz = pr.z + pr.dz * step * (s / subs);
      for (const tgt of targets) {
        if (dist2(px, pz, tgt.x, tgt.z) < hr * hr) {
          applyDamage(owner, tgt, pr.dmg, pr.dmgType);
          hitId = tgt.id; pr.x = px; pr.z = pz;
          break;
        }
      }
    }
    if (!hitId) { pr.x += pr.dx * step; pr.z += pr.dz * step; }
    if (hitId || t - pr.born > pr.life || Math.abs(pr.x) > MAP_HALF || Math.abs(pr.z) > MAP_HALF) {
      room.projectiles.delete(pr.id);
      roomCast(room.id, { t: 'projhit', id: pr.id, x: +pr.x.toFixed(2), z: +pr.z.toFixed(2) });
    }
  }

  // 怪物AI
  for (const mo of room.monsters.values()) {
    if (mo.state === 'dead') {
      if (mo.boss) {
        if (t - mo.dieT > 8000) room.monsters.delete(mo.id);  // BOSS不复活，尸体消散
        continue;
      }
      if (t - mo.dieT > MONSTER_RESPAWN_MS && room.id !== 'war') {
        mo.hp = mo.maxHp; mo.state = 'idle'; mo.targetId = null;
        mo.x = mo.spawnX; mo.z = mo.spawnZ;
        roomCast(room.id, { t: 'mrespawn', id: mo.id, x: mo.x, z: mo.z, hp: mo.hp });
      }
      continue;
    }
    let tgt = mo.targetId ? room.players.get(mo.targetId) : null;
    if (tgt && (tgt.dead || inSafeZone(room, tgt.x, tgt.z) || dist2(mo.x, mo.z, tgt.x, tgt.z) > 26 * 26)) { tgt = null; mo.targetId = null; }
    if (!tgt) {
      // 索敌
      let best = null, bd = 13 * 13;
      for (const p of room.players.values()) {
        if (p.dead || inSafeZone(room, p.x, p.z)) continue;
        const d2 = dist2(mo.x, mo.z, p.x, p.z);
        if (d2 < bd) { bd = d2; best = p; }
      }
      if (best) { mo.targetId = best.id; mo.state = 'chase'; tgt = best; }
    }
    // 世界BOSS：半血狂暴
    if (mo.boss && !mo.enraged && mo.hp < mo.maxHp * 0.5) {
      mo.enraged = true;
      mo.atk = Math.round(mo.atk * 1.5);
      mo.speed *= 1.3;
      allCast({ t: 'feed', msg: `💢 世界BOSS【${mo.name}】进入狂暴状态！攻速与移速大幅提升，小心走位！` });
    }
    if (tgt) {
      const d = Math.sqrt(dist2(mo.x, mo.z, tgt.x, tgt.z));
      mo.ry = Math.atan2(tgt.x - mo.x, tgt.z - mo.z);
      // 世界BOSS：周期性震地轰击（7米范围，伤害=1.6倍攻击）
      if (mo.boss && d < 11 && t - mo.aoeT > 6000) {
        mo.aoeT = t;
        roomCast(room.id, { t: 'baoe', x: +mo.x.toFixed(1), z: +mo.z.toFixed(1), r: 7 });
        for (const pl of room.players.values()) {
          if (pl.dead || dist2(mo.x, mo.z, pl.x, pl.z) > 7 * 7) continue;
          const pst = statsOf(pl);
          let adm = mo.atk * 1.6 * 100 / (100 + pst.armor) * clsOf(pl).dmgTakenMul;
          adm = Math.max(1, Math.round(adm));
          pl.hp -= adm;
          roomCast(room.id, { t: 'dmg', kind: 'p', id: pl.id, amt: adm, hp: Math.max(0, Math.round(pl.hp)), by: mo.id });
          sendYou(pl);
          if (pl.hp <= 0) {
            pl.hp = 0;
            pl.dead = true; pl.dieT = t; pl.anim = 'dead';
            const lost = Math.floor(pl.gold * 0.05);
            pl.gold -= lost;
            roomCast(room.id, { t: 'pdie', id: pl.id, by: mo.id });
            send(pl.ws, { t: 'feed', msg: `💀 你被世界BOSS【${mo.name}】的震地轰击粉碎，丢失 ${lost} 金币。` });
            sendYou(pl);
            persist(pl);
          }
        }
      }
      if (tgt.dead) {           // 轰击若击杀了目标，本帧停手
        mo.targetId = null; mo.state = 'idle';
      } else if (d > 2.0) {
        mo.state = 'chase';
        mo.x += (tgt.x - mo.x) / d * mo.speed * dt;
        mo.z += (tgt.z - mo.z) / d * mo.speed * dt;
      } else if (t - mo.atkT > 1100) {
        mo.atkT = t;
        mo.state = 'attack';
        let dmg = mo.atk * rnd(0.9, 1.15);
        // 宝宝护主：宝宝贴身时替主人挡刀
        const pet = tgt.pet;
        if (pet && dist2(mo.x, mo.z, pet.x, pet.z) < 2.8 * 2.8) {
          const pdmg = Math.round(dmg);
          pet.hp -= pdmg;
          roomCast(room.id, { t: 'dmg', kind: 'pet', id: tgt.id, amt: pdmg, hp: Math.max(0, Math.round(pet.hp)), by: mo.id });
          if (pet.hp <= 0) {
            tgt.pet = null;
            send(tgt.ws, { t: 'feed', msg: `💔 你的宝宝【${pet.name}】为保护你战死了…重新捕捉一只吧` });
            persist(tgt);
          }
        } else {
          const st = statsOf(tgt);
          dmg = dmg * 100 / (100 + st.armor) * clsOf(tgt).dmgTakenMul;
          dmg = Math.max(1, Math.round(dmg));
          tgt.hp -= dmg;
          roomCast(room.id, { t: 'dmg', kind: 'p', id: tgt.id, amt: dmg, hp: Math.max(0, Math.round(tgt.hp)), by: mo.id });
          sendYou(tgt);
          if (tgt.hp <= 0) {
            tgt.hp = 0;
            tgt.dead = true; tgt.dieT = t; tgt.anim = 'dead';
            const lost = Math.floor(tgt.gold * 0.05);
            tgt.gold -= lost;
            roomCast(room.id, { t: 'pdie', id: tgt.id, by: mo.id });
            send(tgt.ws, { t: 'feed', msg: `💀 你被【${mo.name}】击杀，丢失 ${lost} 金币。` });
            sendYou(tgt);
            persist(tgt);
            mo.targetId = null; mo.state = 'idle';
          }
        }
      }
    } else if (mo.state !== 'idle') {
      // 回巢
      const d = Math.sqrt(dist2(mo.x, mo.z, mo.spawnX, mo.spawnZ));
      if (d < 0.5) { mo.state = 'idle'; if (mo.hp < mo.maxHp) mo.hp = mo.maxHp; }
      else {
        mo.x += (mo.spawnX - mo.x) / d * mo.speed * 1.5 * dt;
        mo.z += (mo.spawnZ - mo.z) / d * mo.speed * 1.5 * dt;
      }
    } else if (t > mo.wanderT) {
      // 闲逛
      mo.wanderT = t + rnd(2000, 6000);
      mo.wx = mo.spawnX + rnd(-4, 4); mo.wz = mo.spawnZ + rnd(-4, 4);
    } else {
      const d = Math.sqrt(dist2(mo.x, mo.z, mo.wx, mo.wz));
      if (d > 0.3) {
        mo.x += (mo.wx - mo.x) / d * mo.speed * 0.35 * dt;
        mo.z += (mo.wz - mo.z) / d * mo.speed * 0.35 * dt;
        mo.ry = Math.atan2(mo.wx - mo.x, mo.wz - mo.z);
      }
    }
  }

  // 猎人宝宝AI：跟随主人，自动攻击附近敌人，伤害归主人
  for (const p of room.players.values()) {
    const pet = p.pet;
    if (!pet) continue;
    if (p.dead) { pet.state = 'idle'; continue; }
    let best = null, bd = 9 * 9;
    for (const tgt of targetsOf(p)) {
      if (tgt === pet) continue;
      if (dist2(p.x, p.z, tgt.x, tgt.z) > 16 * 16) continue;   // 不离主人太远
      const d2 = dist2(pet.x, pet.z, tgt.x, tgt.z);
      if (d2 < bd) { bd = d2; best = tgt; }
    }
    if (best) {
      const d = Math.sqrt(dist2(pet.x, pet.z, best.x, best.z));
      pet.ry = Math.atan2(best.x - pet.x, best.z - pet.z);
      if (d > 1.9) {
        pet.state = 'chase';
        pet.x += (best.x - pet.x) / d * 8.5 * dt;
        pet.z += (best.z - pet.z) / d * 8.5 * dt;
      } else if (t - pet.atkT > 1000) {
        pet.atkT = t;
        pet.state = 'attack';
        applyDamage(p, best, pet.atk * rnd(0.9, 1.1), 'phys');
      }
    } else {
      // 跟随主人身侧
      const hx = p.x - Math.sin(p.ry) * 1.8 + 0.9, hz = p.z - Math.cos(p.ry) * 1.8;
      const d = Math.sqrt(dist2(pet.x, pet.z, hx, hz));
      if (d > 2.0) {
        pet.state = 'chase';
        const sp = Math.min(24, 8 + d * 1.5);   // 落太远会加速追赶
        pet.x += (hx - pet.x) / d * sp * dt;
        pet.z += (hz - pet.z) / d * sp * dt;
        pet.ry = Math.atan2(hx - pet.x, hz - pet.z);
      } else pet.state = 'idle';
    }
  }
}

function snapshot(room) {
  if (room.players.size === 0) return;
  const ps = [...room.players.values()].map((p) => [p.id, +p.x.toFixed(2), +p.z.toFixed(2), +p.ry.toFixed(2), p.anim, Math.round(p.hp), maxHp(p), p.level, p.dead ? 1 : 0]);
  const ms = [...room.monsters.values()].map((mo) => [mo.id, +mo.x.toFixed(2), +mo.z.toFixed(2), +mo.ry.toFixed(2), mo.state, Math.max(0, Math.round(mo.hp)), mo.maxHp, mo.tier, mo.name]);
  const pets = [...room.players.values()].filter((p) => p.pet).map((p) => {
    const pe = p.pet;
    return [p.id, pe.tier, +pe.x.toFixed(2), +pe.z.toFixed(2), +pe.ry.toFixed(2), pe.state, Math.max(0, Math.round(pe.hp)), pe.maxHp, pe.name];
  });
  roomCast(room.id, { t: 'snap', ps, ms, pets });
}

setInterval(() => {
  for (const room of Object.values(rooms)) {
    if (room.players.size > 0 || room.id === 'war') tickRoom(room);
  }
  // 战场开关
  const t = now();
  if (war.active && t > war.endsAt) endWar();
  else if (!war.active && t > war.nextAt && conns.size > 0) startWar();
}, TICK_MS);

setInterval(() => { for (const room of Object.values(rooms)) snapshot(room); }, SNAP_MS);

process.on('SIGINT', () => { try { fs.writeFileSync(SAVE_FILE, JSON.stringify(saved)); } catch (e) {} process.exit(0); });
process.on('SIGTERM', () => { try { fs.writeFileSync(SAVE_FILE, JSON.stringify(saved)); } catch (e) {} process.exit(0); });

server.listen(PORT, () => {
  console.log(`[3d-server] 次元大战3D服务端启动: http://0.0.0.0:${PORT}`);
  console.log(`[3d-server] 重叠战场: 每${WAR_INTERVAL / 60000}分钟开启一次，持续${WAR_DURATION / 60000}分钟`);
});
