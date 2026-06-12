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
const { DIMENSIONS, LAIR_ANGLES } = require('./public/js/data.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const WAR_INTERVAL = (parseFloat(process.env.WAR_INTERVAL_MINUTES) || 12) * 60000;
const WAR_DURATION = (parseFloat(process.env.WAR_DURATION_MINUTES) || 5) * 60000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const SAVE_FILE = path.join(__dirname, 'players.json');

const TICK_MS = 100;            // 10Hz 模拟
const SNAP_MS = 100;            // 10Hz 快照
const MAP_HALF = 45;            // 地图边界 ±45
const MAX_SPEED = 26;            // 位置防作弊：最大移动速度（含翻滚/突进冲刺）
const MONSTER_RESPAWN_MS = 9000;
const PLAYER_RESPAWN_MS = 4000;

/* 技能参数（与客户端一致，服务器为准）*/
const SKILLS = {
  basic: { cd: 600,  range: 4.2, arc: Math.PI * 0.7, mult: 1.0 },
  q:     { cd: 3000, mult: 1.5, speed: 22, radius: 1.6, life: 1800, minLvl: 1 },  // 弹道
  e:     { cd: 7000, radius: 5.5, mult: 2.2, minLvl: 3 },                          // 范围爆发
  r:     { cd: 12000, range: 5.0, arc: Math.PI, mult: 3.0, minLvl: 5 },            // 突进斩击
};

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
    for (let i = 0; i < 4; i++) {
      let ang, r;
      if (tier === 4) {
        // T4 怪聚集在 Boss 巢穴
        ang = (LAIR_ANGLES[dimId] || 0) + rnd(-0.12, 0.12);
        r = 37 + rnd(-2.5, 2.5);
      } else {
        ang = rnd(0, Math.PI * 2);
        r = 10 + tier * 7.5 + rnd(-3, 3); // T1≈17 起，出生区(r<9)为安全区
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

/* ---------- 玩家 ---------- */
let nextPid = 1;
const conns = new Map(); // ws -> player

function newPlayer(ws, name, dimId) {
  const id = 'p' + nextPid++;
  const rec = saved[name] || {};
  const p = {
    id, ws, name, dim: dimId, room: dimId,
    x: rnd(-4, 4), z: rnd(-4, 4), ry: 0, anim: 'idle',
    level: rec.level || 1, exp: rec.exp || 0, gold: rec.gold || 0,
    kills: rec.kills || 0, pvpKills: rec.pvpKills || 0,
    hp: 0, dead: false, dieT: 0,
    cds: { basic: 0, q: 0, e: 0, r: 0 },
    lastMoveT: now(), lastX: 0, lastZ: 0,
  };
  p.hp = maxHp(p);
  return p;
}

const maxHp = (p) => 200 + p.level * 30;
const baseDmg = (p) => 18 + p.level * 4;
const expNeed = (lvl) => 80 + (lvl - 1) * 60;

function persist(p) {
  saved[p.name] = { level: p.level, exp: p.exp, gold: p.gold, kills: p.kills, pvpKills: p.pvpKills };
  saveDirty = true;
}

function gainExp(p, n) {
  p.exp += n;
  let ups = 0;
  while (p.exp >= expNeed(p.level)) { p.exp -= expNeed(p.level); p.level++; ups++; }
  if (ups) {
    p.hp = maxHp(p);
    roomCast(p.room, { t: 'lvl', id: p.id, level: p.level });
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
  send(p.ws, { t: 'you', hp: Math.max(0, Math.round(p.hp)), maxHp: maxHp(p), level: p.level, exp: p.exp, expNeed: expNeed(p.level), gold: p.gold, kills: p.kills, pvpKills: p.pvpKills, room: p.room, dim: p.dim });
}

function publicP(p) {
  return { id: p.id, name: p.name, dim: p.dim, level: p.level, x: +p.x.toFixed(2), z: +p.z.toFixed(2), ry: +p.ry.toFixed(2), anim: p.anim, hp: Math.round(p.hp), maxHp: maxHp(p), dead: p.dead };
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
    rooms[p.room].players.delete(p.id);
    roomCast(p.room, { t: 'pleave', id: p.id });
    conns.delete(ws);
  });
});

function handle(ws, m) {
  let p = conns.get(ws);

  if (m.t === 'join') {
    if (p) return;
    const name = String(m.name || '').trim().slice(0, 12);
    const dim = DIMENSIONS.find((d) => d.id === m.dim);
    if (!name || !dim) return send(ws, { t: 'err', msg: '请输入昵称并选择次元' });
    // 同名顶号
    for (const [ows, op] of conns) if (op.name === name) { send(ows, { t: 'err', msg: '该昵称在别处登录' }); ows.close(); }
    p = newPlayer(ws, name, dim.id);
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
      roomCast(p.room, { t: 'prespawn', id: p.id, x: p.x, z: p.z, hp: p.hp });
      sendYou(p);
      return;
    }
  }
}

function spawnPoint(p) {
  if (p.room === 'war') {
    const side = p.dim === war.a ? -1 : 1;
    return { x: side * 38 + rnd(-3, 3), z: rnd(-8, 8) };
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
  if (p.hp <= 0) p.hp = maxHp(p);
  rooms[roomId].players.set(p.id, p);
  send(p.ws, {
    t: 'welcome', id: p.id, room: roomId, first: isFirst,
    you: { name: p.name, dim: p.dim, level: p.level, exp: p.exp, expNeed: expNeed(p.level), gold: p.gold, hp: Math.round(p.hp), maxHp: maxHp(p), kills: p.kills, pvpKills: p.pvpKills },
    players: [...rooms[roomId].players.values()].filter((o) => o.id !== p.id).map(publicP),
    war: warState(),
    x: p.x, z: p.z,
  });
  roomCast(roomId, { t: 'pjoin', p: publicP(p) }, p.id);
}

/* ---------- 技能施放（服务器判定） ---------- */
function cast(p, m) {
  if (p.dead) return;
  const kind = ['basic', 'q', 'e', 'r'].includes(m.k) ? m.k : null;
  if (!kind) return;
  const sk = SKILLS[kind];
  if (sk.minLvl && p.level < sk.minLvl) return send(p.ws, { t: 'err', msg: `${kind.toUpperCase()}技能需要 Lv.${sk.minLvl}` });
  const t = now();
  if (t < p.cds[kind]) return;
  p.cds[kind] = t + sk.cd;

  let dx = +m.dx || 0, dz = +m.dz || 0;
  const dl = Math.sqrt(dx * dx + dz * dz) || 1;
  dx /= dl; dz /= dl;
  p.ry = Math.atan2(dx, dz);

  // 广播给同房间其他人（用于播放动作/特效）
  roomCast(p.room, { t: 'cast', id: p.id, k: kind, x: p.x, z: p.z, dx, dz }, p.id);

  const room = rooms[p.room];
  if (kind === 'q') {
    const id = 'j' + nextMid++;
    room.projectiles.set(id, { id, owner: p.id, x: p.x + dx * 1.2, z: p.z + dz * 1.2, dx, dz, speed: sk.speed, born: t, life: sk.life, dmg: baseDmg(p) * sk.mult });
    roomCast(p.room, { t: 'proj', id, owner: p.id, x: p.x, z: p.z, dx, dz, speed: sk.speed, dim: p.dim });
    return;
  }

  // 近战/范围：立即判定
  const dmg = baseDmg(p) * sk.mult * rnd(0.9, 1.15);
  for (const tgt of targetsOf(p)) {
    const dx2 = tgt.x - p.x, dz2 = tgt.z - p.z;
    const d = Math.sqrt(dx2 * dx2 + dz2 * dz2);
    let hit = false;
    if (kind === 'e') hit = d <= sk.radius;
    else {
      if (d <= sk.range) {
        const ang = Math.acos(clamp((dx2 * dx + dz2 * dz) / (d || 1), -1, 1));
        hit = ang <= sk.arc / 2;
      }
    }
    if (hit) applyDamage(p, tgt, dmg);
  }
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

function applyDamage(attacker, tgt, dmg) {
  dmg = Math.round(dmg);
  tgt.hp -= dmg;
  const isMonster = !!tgt.tier;
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
  gainExp(p, mo.exp); // 内部会 sendYou + persist
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

const inSafeZone = (room, x, z) => room.id !== 'war' && x * x + z * z < 9 * 9;

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
  for (let i = 0; i < 6; i++) {
    addMonster(rooms.war, { name: '次元裂隙兽', tier: 3 + (i % 2), x: rnd(-15, 15), z: rnd(-15, 15) });
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

  // 弹道
  for (const pr of [...room.projectiles.values()]) {
    pr.x += pr.dx * pr.speed * dt;
    pr.z += pr.dz * pr.speed * dt;
    let hitId = null;
    const owner = [...room.players.values()].find((p) => p.id === pr.owner);
    if (owner) {
      for (const tgt of targetsOf(owner)) {
        if (dist2(pr.x, pr.z, tgt.x, tgt.z) < 1.6 * 1.6) { applyDamage(owner, tgt, pr.dmg); hitId = tgt.id; break; }
      }
    }
    if (hitId || t - pr.born > pr.life || Math.abs(pr.x) > MAP_HALF || Math.abs(pr.z) > MAP_HALF) {
      room.projectiles.delete(pr.id);
      roomCast(room.id, { t: 'projhit', id: pr.id, x: +pr.x.toFixed(2), z: +pr.z.toFixed(2) });
    }
  }

  // 怪物AI
  for (const mo of room.monsters.values()) {
    if (mo.state === 'dead') {
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
    if (tgt) {
      const d = Math.sqrt(dist2(mo.x, mo.z, tgt.x, tgt.z));
      mo.ry = Math.atan2(tgt.x - mo.x, tgt.z - mo.z);
      if (d > 2.0) {
        mo.state = 'chase';
        mo.x += (tgt.x - mo.x) / d * mo.speed * dt;
        mo.z += (tgt.z - mo.z) / d * mo.speed * dt;
      } else if (t - mo.atkT > 1100) {
        mo.atkT = t;
        mo.state = 'attack';
        const dmg = Math.round(mo.atk * rnd(0.9, 1.15));
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
}

function snapshot(room) {
  if (room.players.size === 0) return;
  const ps = [...room.players.values()].map((p) => [p.id, +p.x.toFixed(2), +p.z.toFixed(2), +p.ry.toFixed(2), p.anim, Math.round(p.hp), maxHp(p), p.level, p.dead ? 1 : 0]);
  const ms = [...room.monsters.values()].map((mo) => [mo.id, +mo.x.toFixed(2), +mo.z.toFixed(2), +mo.ry.toFixed(2), mo.state, Math.max(0, Math.round(mo.hp)), mo.maxHp, mo.tier, mo.name]);
  roomCast(room.id, { t: 'snap', ps, ms });
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
