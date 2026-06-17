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
const { DIMENSIONS, LAIR_ANGLES, MAP_HALF, CLASSES, RARITIES, AFFIXES, AFFIX_COUNT, ENH_MAX, enhMul, enhCost, enhRate, FUSE_N, fuseFee, rankTier, rankDelta } = require('./public/js/data.js');
const LAIR_R = +process.env.DW_LAIR_R || require('./public/js/data.js').LAIR_R;   // 可被测试覆盖

const PORT = parseInt(process.env.PORT || '3000', 10);
const WAR_INTERVAL = (parseFloat(process.env.WAR_INTERVAL_MINUTES) || 12) * 60000;
const WAR_DURATION = (parseFloat(process.env.WAR_DURATION_MINUTES) || 5) * 60000;
// 五次元大混战：每晚 MELEE_HOUR 点开战，到 MELEE_END_HOUR 点或只剩一个次元存活
const MELEE_HOUR = parseInt(process.env.DW_MELEE_HOUR || '21', 10);
const MELEE_END_HOUR = parseInt(process.env.DW_MELEE_END_HOUR || '23', 10);
const MELEE_MS = parseInt(process.env.DW_MELEE_MS || '0', 10);  // >0：固定时长（测试用）
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const SAVE_FILE = path.join(__dirname, 'players.json');

const TICK_MS = 100;            // 10Hz 模拟
const SNAP_MS = 100;            // 10Hz 快照
const MAX_SPEED = 26;            // 位置防作弊：最大移动速度（含翻滚/突进冲刺）
const MONSTER_RESPAWN_MS = 9000;
const PLAYER_RESPAWN_MS = 4000;
const MON_MAX_LEVEL = parseInt(process.env.DW_MON_MAXLEVEL || '100', 10);   // 怪物等级上限（测试可下调）
const MON_PER_TIER = parseInt(process.env.DW_MON_COUNT || '28', 10);        // 每层刷怪数（测试可下调）
const SAFE_R = 20;              // 出生村庄安全区半径

/* 职业表（技能/属性均以服务器为准，定义在共享 data.js） */
const CLASS_MAP = Object.fromEntries(CLASSES.map((c) => [c.id, c]));
const clsOf = (p) => CLASS_MAP[p.cls] || CLASS_MAP.warrior;

const rnd = (a, b) => a + Math.random() * (b - a);
const dist2 = (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => Date.now();

/* ---------- 持久化（按昵称保存成长） ---------- */
let saved = {};                 // 主键 = 唯一找回码(uid)；记录里含 name(可改的显示名)
const nameIndex = {};           // 昵称(小写)→uid：兼容老客户端按昵称登录 + 将来改名
try { saved = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')); } catch (e) {}
function uniqCode(store) { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c; do { c = 'DW'; for (let i = 0; i < 7; i++) c += A[Math.floor(Math.random() * A.length)]; } while (store[c]); return c; }
function genCode() { return uniqCode(saved); }
function isCode(k) { return /^DW[A-Z0-9]{6,}$/.test(k); }
// 把旧版「按昵称存档」迁移成「按唯一编码存档」；建立 昵称→编码 索引
(function migrateSaved() {
  const out = {};
  for (const [k, rec] of Object.entries(saved)) {
    if (!rec || typeof rec !== 'object') continue;
    let uid;
    if (rec.uid && isCode(k)) { uid = k; }
    else { uid = uniqCode(out); rec.name = rec.name || k; rec.uid = uid; }
    out[uid] = rec;
    if (rec.name) nameIndex[String(rec.name).trim().toLowerCase()] = uid;
  }
  saved = out;
})();
let saveDirty = false;
setInterval(() => {
  if (!saveDirty) return;
  saveDirty = false;
  try { fs.writeFileSync(SAVE_FILE, JSON.stringify(saved)); } catch (e) {}
}, 30000);

/* ---------- 房间（每个次元一张地图 + 重叠战场） ---------- */
const rooms = {};

function makeRoom(id) {
  return { id, players: new Map(), monsters: new Map(), projectiles: new Map(), obstacles: [] };
}

/* 确定性随机（按字符串种子），保证服务器与各端布局一致 */
function seededRand(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}

/* 生成一张地图的障碍物（树木/建筑/巨石），服务器与客户端共用此布局做碰撞与渲染 */
function genObstacles(dimId) {
  const rng = seededRand('dw-obstacles-' + dimId);
  const lairA = (LAIR_ANGLES && LAIR_ANGLES[dimId]) || 0;
  const list = [];
  const tries = 220;
  for (let i = 0; i < tries && list.length < 90; i++) {
    const a = rng() * Math.PI * 2;
    const r = SAFE_R + 8 + rng() * (MAP_HALF - SAFE_R - 18);
    // 4 条主干道留出通路
    const roadGap = Math.abs(((a % (Math.PI / 2)) / (Math.PI / 2)) - 0.5);
    if (roadGap > 0.42) continue;
    // 巢穴正前方留空
    let da = Math.abs(a - lairA); if (da > Math.PI) da = Math.PI * 2 - da;
    if (da < 0.5 && r > LAIR_R - 18) continue;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (list.some((o) => (o.x - x) * (o.x - x) + (o.z - z) * (o.z - z) < 36)) continue; // 间距≥6
    const t = i % 3;                  // 0 树 1 巨石 2 建筑
    const rad = t === 2 ? 2.4 : t === 1 ? 1.6 : 1.1;
    list.push({ x: +x.toFixed(1), z: +z.toFixed(1), r: rad, t });
  }
  return list;
}

for (const d of DIMENSIONS) { rooms[d.id] = makeRoom(d.id); rooms[d.id].obstacles = genObstacles(d.id); }
rooms.war = makeRoom('war');
rooms.melee = makeRoom('melee');

/* 把坐标推出所有障碍圆（实体半径 rad），返回 {x,z} */
function resolveObstacles(room, x, z, rad) {
  const obs = room.obstacles;
  if (!obs || obs.length === 0) return { x, z };
  for (let k = 0; k < obs.length; k++) {
    const o = obs[k];
    const dx = x - o.x, dz = z - o.z;
    const min = o.r + rad;
    const d2 = dx * dx + dz * dz;
    if (d2 < min * min) {
      const d = Math.sqrt(d2) || 0.001;
      x = o.x + (dx / d) * min;
      z = o.z + (dz / d) * min;
    }
  }
  return { x, z };
}

/* 把坐标推出有体积的怪物（世界BOSS r=3：玩家撞不进它的庞大身躯） */
function resolveBoss(room, x, z, rad) {
  for (const mo of room.monsters.values()) {
    if (!mo.r || mo.state === 'dead') continue;
    const dx = x - mo.x, dz = z - mo.z, min = mo.r + rad;
    const d2 = dx * dx + dz * dz;
    if (d2 < min * min) {
      const d = Math.sqrt(d2) || 0.001;
      x = mo.x + (dx / d) * min;
      z = mo.z + (dz / d) * min;
    }
  }
  return { x, z };
}

/* ---------- 怪物 ---------- */
let nextMid = 1;
function spawnMonsters(room, dimId) {
  const dim = DIMENSIONS.find((d) => d.id === dimId);
  if (!dim) return;
  for (let tier = 1; tier <= 4; tier++) {
    const names = dim.regions[tier - 1].monsters;
    for (let i = 0; i < MON_PER_TIER; i++) {   // 怪潮：每层更多怪
      let ang, r;
      if (tier === 4) {
        // T4 怪聚集在 Boss 巢穴
        ang = (LAIR_ANGLES[dimId] || 0) + rnd(-0.18, 0.18);
        r = LAIR_R + rnd(-8, 8);
      } else {
        ang = rnd(0, Math.PI * 2);
        r = 30 + tier * 42 + rnd(-12, 12); // T1≈72 起，出生村庄(r<SAFE_R)为安全区
      }
      addMonster(room, {
        name: names[i % names.length], tier,
        x: Math.cos(ang) * r, z: Math.sin(ang) * r,
      });
    }
  }
}

let monSpawnCount = 0;   // 全局生成计数：每 10 个出 1 个精英
function addMonster(room, { name, tier, x, z, level, elite }) {
  const id = 'm' + nextMid++;
  // 等级随「离出生点(地图中心)的距离」平滑增长：出生点附近≈1级，地图边缘≈100级
  if (level == null) {
    const r = Math.sqrt(x * x + z * z);
    const frac = clamp((r - 55) / (MAP_HALF - 55), 0, 1);
    level = clamp(Math.round(frac * 99 + 1 + rnd(-3, 3)), 1, MON_MAX_LEVEL);
  }
  level = clamp(Math.round(level), 1, MON_MAX_LEVEL);
  if (elite == null) elite = (++monSpawnCount % 10 === 0);   // 每 10 个 1 个精英
  // 怪物分近战/远程：约 40% 远程弹幕，其余近战；精英必带技能（远程或范围震击）
  let skill;
  if (elite) skill = Math.random() < 0.5 ? 'ranged' : 'aoe';
  else if (tier >= 3) skill = Math.random() < 0.5 ? (Math.random() < 0.5 ? 'ranged' : 'aoe') : 'none';
  else skill = Math.random() < 0.4 ? 'ranged' : 'none';
  // 数值大幅增强（基础血/攻提高，随等级更陡）
  let hp = Math.round((120 + tier * 100) * (1 + level * 0.11));
  let atk = Math.round((14 + tier * 9) * (1 + level * 0.07));
  let exp = Math.round((22 + tier * 18) * (1 + level * 0.09));
  let gold = Math.round((8 + tier * 11) * (1 + level * 0.07));
  let speed = 3.0 + tier * 0.35, nm = name;
  if (elite) { hp = Math.round(hp * 2.6); atk = Math.round(atk * 1.7); exp = Math.round(exp * 3); gold = Math.round(gold * 3); speed += 0.4; nm = '精英·' + name; }
  room.monsters.set(id, {
    id, name: nm, tier, level, skill, elite: !!elite,
    x, z, spawnX: x, spawnZ: z, ry: rnd(0, 6.28),
    hp, maxHp: hp, atk, speed, exp, gold,
    state: 'idle', targetId: null, atkT: 0, skillT: 0, dieT: 0, wanderT: 0, wx: x, wz: z,
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
    id, name, tier: 5, boss: true, level: 100, skill: 'none', skillT: 0, r: 3,
    x: bx, z: bz, spawnX: bx, spawnZ: bz, ry: 0,
    hp: +process.env.DW_BOSS_HP || 6000, maxHp: +process.env.DW_BOSS_HP || 6000, atk: 58, speed: 4.6,
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

function newPlayer(ws, uid, name, dimId, clsId, rec) {
  const id = 'p' + nextPid++;
  rec = rec || {};
  // 老角色：次元/职业以服务器存档为准（用找回码/昵称找回同一角色）；新角色才用本次选择
  if (rec.dim && DIMENSIONS.some((d) => d.id === rec.dim)) dimId = rec.dim;
  if (rec.cls && CLASS_MAP[rec.cls]) clsId = rec.cls;
  if (!DIMENSIONS.some((d) => d.id === dimId)) dimId = 'tech';
  const p = {
    id, ws, uid, name, dim: dimId, cls: clsId, room: dimId,
    x: rnd(-4, 4), z: rnd(-4, 4), ry: 0, anim: 'idle',
    level: rec.level || 1, exp: rec.exp || 0, gold: rec.gold || 0,
    kills: rec.kills || 0, pvpKills: rec.pvpKills || 0, rankPts: rec.rankPts || 0,
    ach: { ...(rec.ach || {}) }, achEquip: rec.achEquip || null,
    bagMode: rec.bagMode || 'sell',
    // 药剂按类型计数；兼容旧存档（旧版 potions 是数字 = 治疗药剂数量）
    potions: typeof rec.potions === 'number' ? { pot_hp: rec.potions } : { ...(rec.potions || {}) },
    potCd: {},
    hp: 0, dead: false, dieT: 0,
    cds: { basic: 0, q: 0, e: 0, r: 0 },
    pet: null, capCd: 0,
    statBuff: null, vehicle: null, treasure: null,   // 次元技能临时增益（不入档）
    amp: null,                                        // 赛博强化针剂：全属性/范围/体型倍增
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
  // 退出重进：恢复下线时的血量与坐标（存活时才存），不再回满血/瞬移
  if (rec.hp != null && rec.hp > 0) p.hp = clamp(Math.round(rec.hp), 1, maxHp(p));
  if (typeof rec.px === 'number' && typeof rec.pz === 'number') { p._rx = rec.px; p._rz = rec.pz; }
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
  // 特殊词条：暴击率 / 暴击伤害(基础50%) / 吸血 / 穿透 / 冷却缩减 / 韧性
  let crit = 0, critDmg = 50, lifesteal = 0, pen = 0, cdr = 0, tenacity = 0;
  for (const slot of Object.keys(p.equip || {})) {
    const it = p.equip[slot];
    if (!it) continue;
    const ef = enhMul(it);   // 强化只放大基础属性，不放大特殊词条
    hp += (it.hp || 0) * ef; patk += (it.patk || 0) * ef; matk += (it.matk || 0) * ef;
    armor += (it.armor || 0) * ef; mres += (it.mres || 0) * ef; spd += it.spd || 0;
    crit += it.crit || 0; critDmg += it.critDmg || 0; lifesteal += it.lifesteal || 0;
    pen += it.pen || 0; cdr += it.cdr || 0; tenacity += it.tenacity || 0;
  }
  // 已装备成就的属性增益
  const ae = achEff(p);
  if (ae) {
    const all = ae.allPct || 0;
    hp *= 1 + (ae.hpPct || 0) + all;
    patk *= 1 + (ae.atkPct || 0) + all; matk *= 1 + (ae.atkPct || 0) + all;
    armor *= 1 + (ae.armorPct || 0) + all; mres *= 1 + (ae.mresPct || 0) + all;
    spd += ae.spd || 0;
    crit += ae.crit || 0; critDmg += ae.critDmg || 0; lifesteal += ae.lifesteal || 0;
    cdr += ae.cdr || 0; tenacity += ae.tenacity || 0;
  }
  // 次元技能临时增益（炼宝诀法宝 / 载具加速 / 天使加持等）
  if (p.statBuff && now() < p.statBuff.until) {
    const b = p.statBuff.bonus || {};
    hp += b.hp || 0; patk += b.patk || 0; matk += b.matk || 0;
    armor += b.armor || 0; mres += b.mres || 0; spd += b.spd || 0;
    crit += b.crit || 0; critDmg += b.critDmg || 0;
  }
  // 赛博·强化针剂：全属性 ×(1+等级/10)
  if (p.amp && now() < p.amp.until) {
    const mul = p.amp.mul;
    hp *= mul; patk *= mul; matk *= mul; armor *= mul; mres *= mul; spd *= mul;
  }
  return {
    maxHp: Math.round(hp), patk, matk, armor, mres, spd,
    crit: clamp(crit, 0, 75), critDmg, lifesteal: clamp(lifesteal, 0, 60),
    pen: Math.max(0, pen), cdr: clamp(cdr, 0, 40), tenacity: clamp(tenacity, 0, 60),
  };
}
const maxHp = (p) => statsOf(p).maxHp;
const atkOf = (p) => { const st = statsOf(p); return clsOf(p).dmgType === 'magic' ? st.matk : st.patk; };
const expNeed = (lvl) => (80 + (lvl - 1) * 60) * 3;   // 升级难度×3
/* 技能等级增益：每点+18%伤害 / +15%治疗 */
const skDmgMul = (p, k) => 1 + 0.18 * ((p.sk[k] || 1) - 1);
const skHealMul = (p, k) => 1 + 0.15 * ((p.sk[k] || 1) - 1);

function persist(p) {
  // 只在「本次元正常房间 + 存活」时保存血量/坐标，避免退出重进=回满血+瞬移（战场/混战/死亡则按常规重生）
  const normalRoom = p.room && p.room !== 'war' && p.room !== 'melee';
  const keepState = normalRoom && !p.dead && p.hp > 0;
  saved[p.uid] = {
    uid: p.uid, name: p.name,
    level: p.level, exp: p.exp, gold: p.gold, kills: p.kills, pvpKills: p.pvpKills, rankPts: p.rankPts || 0,
    cls: p.cls, dim: p.dim, sk: p.sk, skPts: p.skPts, inv: p.inv, equip: p.equip,
    daily: p.daily, dailyStreak: p.dailyStreak, ach: p.ach || {}, achEquip: p.achEquip || null,
    bagMode: p.bagMode || 'sell', potions: p.potions || {},
    pet: p.pet ? { name: p.pet.name, tier: p.pet.tier, maxHp: p.pet.maxHp, atk: p.pet.atk } : null,
    hp: keepState ? Math.round(p.hp) : undefined,
    px: keepState ? +p.x.toFixed(2) : undefined,
    pz: keepState ? +p.z.toFixed(2) : undefined,
  };
  nameIndex[String(p.name).trim().toLowerCase()] = p.uid;
  saveDirty = true;
}

/* ---------- 成就系统（可装备，每次装备1个，提供专属增益；获取门槛更高） ---------- */
const ACHIEVEMENTS = [
  { id: 'lv5',     name: '初露锋芒', icon: '⭐', desc: '达到 5 级',            eff: { hpPct: 0.06 },                       effText: '生命上限 +6%' },
  { id: 'lv10',    name: '次元强者', icon: '🌟', desc: '达到 15 级',           eff: { atkPct: 0.07 },                      effText: '攻击 +7%' },
  { id: 'lv20',    name: '位面传说', icon: '💫', desc: '达到 30 级', bc: 1,    eff: { allPct: 0.09 },                      effText: '全属性 +9%' },
  { id: 'kill100', name: '百兽屠戮', icon: '🗡', desc: '累计击杀 300 只野怪',  eff: { dmgPct: 0.12, vs: 'monster' },       effText: '对野怪伤害 +12%' },
  { id: 'kill500', name: '千军辟易', icon: '⚔️', desc: '累计击杀 1500 只野怪', bc: 1, eff: { atkPct: 0.08, crit: 5 },        effText: '攻击 +8%，暴击 +5%' },
  { id: 'pvp10',   name: '次元猎手', icon: '🎯', desc: '战场/混战击杀 25 名玩家', eff: { dmgPct: 0.12, vs: 'player' },      effText: '对玩家伤害 +12%' },
  { id: 'pvp50',   name: '战场死神', icon: '💀', desc: '战场/混战击杀 120 名玩家', bc: 1, eff: { dmgPct: 0.10, vs: 'player', lifesteal: 6 }, effText: '对玩家伤害 +10%，吸血 +6%' },
  { id: 'rich5k',  name: '富甲一方', icon: '💰', desc: '持有金币达到 30000',   eff: { goldPct: 0.25 },                     effText: '金币获取 +25%' },
  { id: 'pet1',    name: '驯兽师',   icon: '🐾', desc: '捕捉第一只宝宝',        eff: { hpPct: 0.05, spd: 0.4 },             effText: '生命 +5%，移速 +0.4' },
  { id: 'boss1',   name: '屠灭者',   icon: '👑', desc: '参与讨伐世界BOSS',      eff: { dmgPct: 0.15, vs: 'boss' },          effText: '对世界BOSS伤害 +15%' },
  { id: 'mvp1',    name: '讨伐MVP', icon: '🏅', desc: '在BOSS战中输出第一', bc: 1, eff: { crit: 8, critDmg: 18 },         effText: '暴击 +8%，暴伤 +18%' },
  { id: 'melee_win', name: '混战之王', icon: '🏆', desc: '赢得五次元大混战', bc: 1, eff: { allPct: 0.06, tenacity: 10 },   effText: '全属性 +6%，韧性 +10%' },
  { id: 'rank_gold', name: '黄金斗士',  icon: '🥇', desc: 'PvP 段位达到黄金',  eff: { armorPct: 0.12, mresPct: 0.12 },     effText: '物防/法防 +12%' },
  { id: 'rank_dia',  name: '钻石强者',  icon: '💠', desc: 'PvP 段位达到钻石', bc: 1, eff: { allPct: 0.07, cdr: 6 },        effText: '全属性 +7%，冷却缩减 +6%' },
  { id: 'rank_king', name: '次元王者',  icon: '👑', desc: 'PvP 段位达到王者', bc: 1, eff: { allPct: 0.10, crit: 6, lifesteal: 5 }, effText: '全属性 +10%，暴击 +6%，吸血 +5%' },
];
const ACH_MAP = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));
/* 当前装备且已解锁的成就效果（否则 null） */
const achEff = (p) => (p && p.achEquip && p.ach && p.ach[p.achEquip] && ACH_MAP[p.achEquip]) ? ACH_MAP[p.achEquip].eff : null;

function unlock(p, id) {
  if (!p || !ACH_MAP[id]) return;
  p.ach = p.ach || {};
  if (p.ach[id]) return;
  p.ach[id] = 1;
  const a = ACH_MAP[id];
  send(p.ws, { t: 'ach', id: a.id, name: a.name, icon: a.icon, desc: a.desc });
  if (a.bc) allCast({ t: 'feed', msg: `${a.icon} 【${dimName(p.dim)}】${p.name} 达成成就【${a.name}】！` });
  persist(p);
}

/* 数值类成就统一检查（升级/击杀/金币变化后调用） */
function checkAch(p) {
  if (p.level >= 5) unlock(p, 'lv5');
  if (p.level >= 15) unlock(p, 'lv10');
  if (p.level >= 30) unlock(p, 'lv20');
  if (p.kills >= 300) unlock(p, 'kill100');
  if (p.kills >= 1500) unlock(p, 'kill500');
  if (p.pvpKills >= 25) unlock(p, 'pvp10');
  if (p.pvpKills >= 120) unlock(p, 'pvp50');
  if (p.gold >= 30000) unlock(p, 'rich5k');
  if ((p.rankPts || 0) >= 500) unlock(p, 'rank_gold');
  if ((p.rankPts || 0) >= 1800) unlock(p, 'rank_dia');
  if ((p.rankPts || 0) >= 5000) unlock(p, 'rank_king');
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
  checkAch(p);
}

/* ---------- 装备与商店 ---------- */
const INV_MAX = 24;
const SLOT_NAMES = { weapon: '武器', helmet: '帽子', armor: '衣服', boots: '鞋子', acc: '饰品' };
const HELMET_NAMES = ['强化头盔', '守护之盔', '贤者之冠'];
const BOOTS_NAMES = ['疾行之靴', '迅捷之靴', '神行靴'];
const SHOP_WEAPON = ['制式利刃', '精工战刃', '名匠神兵'];
const SHOP_ARMOR = ['制式战甲', '精工铠甲', '名匠圣铠'];
const SHOP_ACC = ['力量徽记', '勇气勋章', '王者徽章'];

/* 装备强化公式（ENH_MAX/enhMul/enhCost/enhRate）来自共享 data.js */

/* 按槽位/品质生成装备数值；q 为强度系数 */
function makeItem(slot, name, rar, q, spdBonus = 0, affixBonus = 0) {
  const it = { slot, name: `${RARITIES[rar].name}·${name}`, rar, val: Math.round(110 * q) };
  if (slot === 'weapon') { it.patk = Math.round(9 * q); it.matk = Math.round(9 * q); }
  else if (slot === 'helmet') { it.hp = Math.round(55 * q); it.mres = Math.round(6 * q); }
  else if (slot === 'armor') { it.hp = Math.round(80 * q); it.armor = Math.round(8 * q); }
  else if (slot === 'boots') { it.hp = Math.round(35 * q); it.spd = +(0.25 + spdBonus).toFixed(2); }
  else { it.patk = Math.round(4.5 * q); it.matk = Math.round(4.5 * q); it.hp = Math.round(28 * q); }
  rollAffixes(it, rar, affixBonus);
  return it;
}

/* 滚动特殊词条（暴击/暴伤/吸血/穿透/冷却缩减/韧性）：品质越高条数越多、数值越大。
 * affixBonus：额外强度系数（如世界BOSS/混战极品装备），让顶级掉落词条拉满。 */
function rollAffixes(it, rar, affixBonus = 0) {
  const n = (AFFIX_COUNT[rar] || 0) + (affixBonus > 0 ? 1 : 0);
  if (n <= 0) return;
  it.affixes = [];
  const pool = AFFIXES.filter((a) => a.slots.includes(it.slot));
  for (let i = 0; i < n && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    const a = pool.splice(idx, 1)[0];
    const scale = 0.85 + rar * 0.06 + affixBonus;   // 品质 + 额外加成
    const v = Math.max(1, Math.round((a.min + Math.random() * (a.max - a.min)) * scale));
    it[a.key] = (it[a.key] || 0) + v;
    it.affixes.push(a.key);
  }
}

/* 次元至宝：大混战 MVP 专属武器，传说品质且全部武器词条拉满（暴击/暴伤/吸血/穿透） */
function makeDimRelic(dimId) {
  const dim = DIMENSIONS.find((d) => d.id === dimId) || DIMENSIONS[0];
  const base = dim.weaponNames[2] || '次元神兵';
  const it = { slot: 'weapon', name: `次元至宝·${base}`, rar: 4, relic: 1, val: 6000 };
  it.patk = Math.round(9 * RARITIES[4].mult * 1.6);
  it.matk = it.patk;
  it.affixes = [];
  for (const a of AFFIXES) {
    if (!a.slots.includes('weapon')) continue;
    it[a.key] = Math.round(a.max * 1.25);   // 拉满并超额
    it.affixes.push(a.key);
  }
  return it;
}

/* 野怪掉落：槽位随机，稀有度受怪物层级限制 */
function rollDrop(tier, dimId, minRar = 0, affixBonus = 0) {
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
  return makeItem(slot, name, rar, q, rar * 0.12, affixBonus);
}

/* 合成：按指定槽位与品质造一件装备（用于 3 合 1 升品） */
function makeNamed(dimId, slot, rar) {
  const dim = DIMENSIONS.find((d) => d.id === dimId) || DIMENSIONS[0];
  const idx = Math.min(2, Math.max(0, rar - 1));
  const name = slot === 'weapon' ? dim.weaponNames[idx]
    : slot === 'armor' ? dim.armorNames[idx]
    : slot === 'acc' ? dim.accNames[idx]
    : slot === 'helmet' ? HELMET_NAMES[idx] : BOOTS_NAMES[idx];
  return makeItem(slot, name, rar, RARITIES[rar].mult * 1.25, rar * 0.12);
}
/* 合成参数 FUSE_N / fuseFee 来自共享 data.js */

/* 商店固定货架：每槽位 精良/稀有/史诗 三档 */
const SHOP = [];
{
  const prices = [3500, 9000, 22000];   // 装备购买价×10
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

/* 消耗品：四种药剂（治疗/高级治疗/能量/复活）。复活为阵亡时被动触发，其余主动使用。 */
const POTIONS = [
  { id: 'pot_hp',  name: '治疗药剂',   icon: '🧪', kind: 'heal',   healPct: 0.5, price: 70,  cd: 9000,  desc: '回复 50% 生命' },
  { id: 'pot_hpL', name: '高级治疗药剂', icon: '💉', kind: 'heal',  healPct: 1.0, price: 180, cd: 12000, desc: '回满全部生命' },
  { id: 'pot_en',  name: '能量药剂',   icon: '⚡', kind: 'energy', price: 160, cd: 20000, desc: '立即重置全部技能与次元特技冷却' },
  { id: 'pot_rev', name: '复活药',     icon: '🔮', kind: 'revive', price: 400, desc: '阵亡时自动原地复活并恢复 50% 生命（被动）' },
];
const POT_MAP = Object.fromEntries(POTIONS.map((x) => [x.id, x]));
const POT_MAX = 99;

/* 复活药：阵亡瞬间若持有则消耗一瓶，原地满血一半复活，返回是否触发 */
function tryRevive(p) {
  if (!p.potions || (p.potions.pot_rev || 0) <= 0) return false;
  p.potions.pot_rev -= 1;
  const mx = maxHp(p);
  p.hp = Math.round(mx * 0.5);
  p.dead = false; p.anim = 'idle';
  cleanseCC(p);
  roomCast(p.room, { t: 'heal', id: p.id, amt: Math.round(mx * 0.5), hp: Math.round(p.hp), by: p.id });
  roomCast(p.room, { t: 'dimfx', kind: 'field', id: p.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2), r: 4 });
  send(p.ws, { t: 'feed', msg: `🔮 复活药生效！原地复活并恢复 50% 生命（剩 ${p.potions.pot_rev} 瓶）` });
  sendYou(p);
  return true;
}

function sendInv(p) {
  send(p.ws, { t: 'inv', equip: p.equip, inv: p.inv, gold: p.gold });
}

/* 装备综合评分：品质优先，其次强化等级与价值；至宝最高 */
const itemScore = (it) => (it.relic ? 1e7 : 0) + (it.rar || 0) * 1e5 + (it.enh || 0) * 600 + (it.val || 0);

/* 满包时自动用金币强化「强化等级最低」的一件穿戴装备（成功率照常，失败仅耗金） */
function autoEnhance(p) {
  let best = null, bestSlot = null;
  for (const slot of Object.keys(p.equip || {})) {
    const it = p.equip[slot];
    if (!it || (it.enh || 0) >= ENH_MAX) continue;
    if (!best || (it.enh || 0) < (best.enh || 0)) { best = it; bestSlot = slot; }
  }
  if (!best) return false;
  const cost = enhCost(best);
  if (p.gold < cost) return false;
  p.gold -= cost;
  if (Math.random() < enhRate(best.enh || 0)) {
    best.enh = (best.enh || 0) + 1;
    send(p.ws, { t: 'feed', msg: `🔨 自动强化：${SLOT_NAMES[bestSlot]}【${best.name}】+${best.enh}（花费 ${cost} 金）` });
    p.hp = Math.min(p.hp, maxHp(p));
  } else {
    send(p.ws, { t: 'feed', msg: `🔨 自动强化失败（花费 ${cost} 金，装备无损）` });
  }
  return true;
}

function giveItem(p, item, srcText) {
  if (p.inv.length >= INV_MAX) {
    // 背包满：在「背包+新装备」里找品质最低的一件卖掉腾位，保留更好的
    let worstIdx = -1, worst = item;
    for (let i = 0; i < p.inv.length; i++) {
      if (itemScore(p.inv[i]) < itemScore(worst)) { worst = p.inv[i]; worstIdx = i; }
    }
    if (worstIdx === -1) {
      const g = Math.round(item.val * 0.5);
      p.gold += g;
      send(p.ws, { t: 'feed', msg: `🎒 背包已满且新装备品质最低，${srcText}的【${item.name}】自动卖出折 ${g} 金` });
    } else {
      const sold = p.inv[worstIdx];
      const g = Math.round(sold.val * 0.5);
      p.gold += g;
      p.inv.splice(worstIdx, 1);
      p.inv.push(item);
      send(p.ws, { t: 'feed', msg: `🎒 背包已满：自动卖出低品质【${sold.name}】(+${g}金)，收入 ${srcText}【${item.name}】` });
      sendInv(p);
    }
    // 「自动强化」模式：把这波金币顺手投入强化穿戴装备
    if (p.bagMode === 'enhance') { autoEnhance(p); sendInv(p); }
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
    gold: p.gold, kills: p.kills, pvpKills: p.pvpKills, rankPts: p.rankPts || 0, room: p.room, dim: p.dim,
    patk: Math.round(st.patk), matk: Math.round(st.matk), armor: Math.round(st.armor), mres: Math.round(st.mres),
    spd: +st.spd.toFixed(2), skPts: p.skPts, sk: p.sk,
    crit: Math.round(st.crit), critDmg: Math.round(st.critDmg), lifesteal: Math.round(st.lifesteal),
    pen: Math.round(st.pen), cdr: Math.round(st.cdr), tenacity: Math.round(st.tenacity),
    achEquip: p.achEquip || null, bagMode: p.bagMode || 'sell', potions: p.potions || {},
    shield: (p.shield > 0 && now() < p.shieldUntil) ? p.shield : 0,
    treasure: (p.treasure && now() < p.treasure.until) ? p.treasure.cls : null,        // 头顶法宝(炼宝诀)
    vehicle: (p.vehicle && now() < p.vehicle.until) ? { hp: Math.round(p.vehicle.hp), maxHp: Math.round(p.vehicle.maxHp) } : null,
    amp: (p.amp && now() < p.amp.until) ? +p.amp.mul.toFixed(2) : 0,                     // 强化针剂倍率→客户端放大体型
  });
}

function publicP(p) {
  return {
    id: p.id, name: p.name, dim: p.dim, cls: p.cls, level: p.level, x: +p.x.toFixed(2), z: +p.z.toFixed(2), ry: +p.ry.toFixed(2), anim: p.anim, hp: Math.round(p.hp), maxHp: maxHp(p), dead: p.dead,
    tr: (p.treasure && now() < p.treasure.until) ? 1 : 0,                                // 别人看你头顶法宝
    veh: (p.vehicle && now() < p.vehicle.until) ? 1 : 0,                                 // 别人看你载具
    amp: (p.amp && now() < p.amp.until) ? +p.amp.mul.toFixed(2) : 0,                     // 别人看你强化变大
  };
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
    const code = String(m.code || '').trim().toUpperCase();
    let uid, rec, name, dimId, clsId;
    if (code && saved[code]) {                       // 找回码 / 自动登录：按编码读回角色
      uid = code; rec = saved[code]; name = rec.name || '降临者'; dimId = rec.dim; clsId = rec.cls;
    } else if (code) {                               // 提供了编码但服务器没有
      return send(ws, { t: 'err', msg: '找回码无效，请检查或新建角色' });
    } else {                                         // 新建 / 老客户端按昵称登录
      name = String(m.name || '').trim().slice(0, 12);
      const dim = DIMENSIONS.find((d) => d.id === m.dim);
      if (!name || !dim) return send(ws, { t: 'err', msg: '请输入昵称并选择次元' });
      clsId = CLASS_MAP[m.cls] ? m.cls : 'warrior'; dimId = dim.id;
      const li = nameIndex[name.toLowerCase()];
      if (li && saved[li]) { uid = li; rec = saved[li]; dimId = rec.dim; clsId = rec.cls; name = rec.name || name; }
      else { uid = genCode(); rec = null; }
    }
    // 顶号：同一账号(编码)已在线则踢掉旧连接
    for (const [ows, op] of conns) if (op.uid === uid) { send(ows, { t: 'err', msg: '该账号已在别处登录' }); ows.close(); }
    p = newPlayer(ws, uid, name, dimId, clsId, rec);
    conns.set(ws, p);
    joinRoom(p, p.dim, true);
    return;
  }
  if (!p) return;

  switch (m.t) {
    case 'mv': {
      if (p.dead) return;
      const t = now();
      // 眩晕/定身：服务器锁定位置，转向仍可
      if (isHardCC(p)) { p.ry = +m.ry || 0; p.anim = 'idle'; p.lastMoveT = t; return; }
      const dt = Math.max(0.03, (t - p.lastMoveT) / 1000);
      let x = clamp(+m.x || 0, -MAP_HALF, MAP_HALF);
      let z = clamp(+m.z || 0, -MAP_HALF, MAP_HALF);
      // 速度防作弊：超速则按方向限幅（减速时上限同步收紧）
      const d = Math.sqrt(dist2(x, z, p.x, p.z));
      const slowMul = (p.slowUntil && t < p.slowUntil) ? (1 - (p.slowPct || 0)) : 1;
      const maxD = MAX_SPEED * slowMul * dt;
      if (d > maxD && d > 0) {
        x = p.x + (x - p.x) / d * maxD;
        z = p.z + (z - p.z) / d * maxD;
      }
      const r0 = resolveObstacles(rooms[p.room], x, z, 0.6);   // 障碍物碰撞
      const rp = resolveBoss(rooms[p.room], r0.x, r0.z, 0.6);  // 世界BOSS 庞大身躯碰撞
      p.x = rp.x; p.z = rp.z;
      p.ry = +m.ry || 0;
      p.anim = m.anim === 'run' ? 'run' : 'idle';
      p.lastMoveT = t;
      return;
    }
    case 'cast': return cast(p, m);
    case 'emote': {   // 动作/表情：广播给同房间其他人播放
      const s = String(m.s || '').slice(0, 16);
      if (!s || p.dead) return;
      const t = now();
      if (t < (p.emoteCd || 0)) return;
      p.emoteCd = t + 400;
      roomCast(p.room, { t: 'emote', id: p.id, s }, p.id);
      return;
    }
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
    case 'melee': {
      if (!melee.active) return send(p.ws, { t: 'err', msg: '五次元大混战未开启（每晚开战）' });
      if (m.enter) {
        if (meleeEliminated.has(p.uid)) return send(p.ws, { t: 'err', msg: '你已被淘汰，下次大混战再来！' });
        if (p.room !== 'melee') { joinRoom(p, 'melee'); melee.participants.add(p.uid); }
      } else if (p.room === 'melee') {
        joinRoom(p, p.dim);
      }
      return;
    }
    case 'respawn': {
      if (!p.dead || now() - p.dieT < PLAYER_RESPAWN_MS) return;
      p.dead = false;
      p.hp = maxHp(p);
      // 次元重叠/大混战中不能原地复活，只能回本次元复活
      if (p.room === 'war' || p.room === 'melee') { joinRoom(p, p.dim); return; }
      const sp = spawnPoint(p);
      p.x = sp.x; p.z = sp.z;
      if (p.pet) { p.pet.hp = p.pet.maxHp; p.pet.x = p.x + 1.2; p.pet.z = p.z + 1.2; }
      roomCast(p.room, { t: 'prespawn', id: p.id, x: p.x, z: p.z, hp: p.hp });
      sendYou(p);
      return;
    }
    case 'capture': return capturePet(p);   // 兼容旧客户端
    case 'dimskill': return dimSkill(p);
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
      // 全服排行榜：含离线玩家（存档）+ 在线实时数据。mode='ladder' 按段位分排，否则按等级
      const all = new Map();
      for (const [uid, rec] of Object.entries(saved)) {
        all.set(uid, { name: rec.name || '玩家', level: rec.level || 1, kills: rec.kills || 0, pvpKills: rec.pvpKills || 0, rankPts: rec.rankPts || 0, gold: rec.gold || 0, dim: rec.dim || '', cls: rec.cls || '', ach: Object.keys(rec.ach || {}).length, online: false });
      }
      for (const op of conns.values()) {
        all.set(op.uid, { name: op.name, level: op.level, kills: op.kills, pvpKills: op.pvpKills, rankPts: op.rankPts || 0, gold: op.gold, dim: op.dim, cls: op.cls, ach: Object.keys(op.ach || {}).length, online: true });
      }
      const ladder = m.mode === 'ladder';
      const list = [...all.values()]
        .sort(ladder
          ? (a, b) => b.rankPts - a.rankPts || b.pvpKills - a.pvpKills || b.level - a.level
          : (a, b) => b.level - a.level || b.pvpKills - a.pvpKills || b.kills - a.kills)
        .slice(0, 20);
      return send(p.ws, { t: 'rank', list, mode: ladder ? 'ladder' : 'level' });
    }
    case 'sklvl': {
      const k = ['basic', 'q', 'e', 'r'].includes(m.k) ? m.k : null;
      if (!k || p.skPts <= 0) return;
      const sk = clsOf(p).skills[k];
      if (sk.minLvl && p.level < sk.minLvl) return send(p.ws, { t: 'err', msg: `该技能 Lv.${sk.minLvl} 才解锁` });
      p.sk[k]++; p.skPts--;   // 技能无上限，可无限强化
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
      // 药剂（消耗品，按类型计数，可一次买多瓶）
      if (POT_MAP[m.id]) {
        const def = POT_MAP[m.id];
        const qty = Math.max(1, Math.min(20, m.qty | 0 || 1));
        const have = p.potions[m.id] || 0;
        const canBuy = Math.min(qty, POT_MAX - have);
        if (canBuy <= 0) return send(p.ws, { t: 'err', msg: `${def.name}已达上限 ${POT_MAX}` });
        const cost = def.price * canBuy;
        if (p.gold < cost) return send(p.ws, { t: 'err', msg: `金币不足（需要 ${cost}）` });
        p.gold -= cost;
        p.potions[m.id] = have + canBuy;
        send(p.ws, { t: 'feed', msg: `${def.icon} 购买【${def.name}】×${canBuy}（花费 ${cost} 金）` });
        sendYou(p); persist(p);
        return;
      }
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
    case 'enhance': {
      // 装备强化：消耗金币提升基础属性，+4 起有失败率（失败仅耗金、不掉级、不损坏）
      const item = m.slot ? p.equip[SLOT_NAMES[m.slot] ? m.slot : null] : p.inv[m.i | 0];
      if (!item) return send(p.ws, { t: 'err', msg: '没有可强化的装备' });
      const enh = item.enh || 0;
      if (enh >= ENH_MAX) return send(p.ws, { t: 'err', msg: `已达强化上限 +${ENH_MAX}` });
      const cost = enhCost(item);
      if (p.gold < cost) return send(p.ws, { t: 'err', msg: `强化需要 ${cost} 金币` });
      p.gold -= cost;
      const rate = enhRate(enh);
      if (Math.random() < rate) {
        item.enh = enh + 1;
        send(p.ws, { t: 'feed', msg: `🔨 强化成功！【${item.name}】+${item.enh}（花费 ${cost} 金）` });
        roomCast(p.room, { t: 'dimfx', kind: 'heal', id: p.id });   // 复用金光特效
      } else {
        send(p.ws, { t: 'feed', msg: `💢 强化失败…【${item.name}】保持 +${enh}（花费 ${cost} 金，装备无损）` });
      }
      p.hp = Math.min(p.hp, maxHp(p));
      sendInv(p); sendYou(p); persist(p);
      return;
    }
    case 'achequip': {
      // 装备/卸下成就（每次仅一个，需已解锁）
      const id = m.id || null;
      if (id === null || id === p.achEquip) { p.achEquip = null; }
      else if (ACH_MAP[id] && p.ach && p.ach[id]) {
        p.achEquip = id;
        send(p.ws, { t: 'feed', msg: `🏅 已装备成就【${ACH_MAP[id].name}】：${ACH_MAP[id].effText}` });
      } else return send(p.ws, { t: 'err', msg: '该成就尚未解锁' });
      p.hp = Math.min(p.hp, maxHp(p));
      sendYou(p); persist(p);
      return;
    }
    case 'bagmode': {
      p.bagMode = m.mode === 'enhance' ? 'enhance' : 'sell';
      send(p.ws, { t: 'feed', msg: p.bagMode === 'enhance' ? '🔨 满包将自动强化穿戴装备' : '💰 满包将自动卖出低品质装备' });
      sendYou(p); persist(p);
      return;
    }
    case 'usepotion': {
      if (p.dead) return send(p.ws, { t: 'err', msg: '阵亡状态无法使用药剂' });
      const def = POT_MAP[m.id];
      if (!def) return;
      if (def.kind === 'revive') return send(p.ws, { t: 'err', msg: '复活药在阵亡时自动触发，无需手动使用' });
      if ((p.potions[m.id] || 0) <= 0) return send(p.ws, { t: 'err', msg: `没有${def.name}了，去商店购买` });
      const t = now();
      if (t < (p.potCd[m.id] || 0)) return send(p.ws, { t: 'err', msg: `${def.name}冷却中（${Math.ceil((p.potCd[m.id] - t) / 1000)}s）` });
      if (def.kind === 'heal') {
        const mx = maxHp(p);
        const petCanHeal = p.pet && p.pet.hp < p.pet.maxHp;
        if (p.hp >= mx && !petCanHeal) return send(p.ws, { t: 'err', msg: '生命已满' });
        const heal = Math.round(mx * def.healPct);
        p.hp = Math.min(mx, p.hp + heal);
        roomCast(p.room, { t: 'heal', id: p.id, amt: heal, hp: Math.round(p.hp), by: p.id });
        roomCast(p.room, { t: 'dimfx', kind: 'heal', id: p.id });
        // 猎人吃药同时为宝宝加血
        if (p.pet) {
          const ph = Math.round(p.pet.maxHp * def.healPct);
          p.pet.hp = Math.min(p.pet.maxHp, p.pet.hp + ph);
          roomCast(p.room, { t: 'heal', kind: 'pet', id: p.id, amt: ph, hp: Math.round(p.pet.hp), by: p.id });
        }
        send(p.ws, { t: 'feed', msg: `${def.icon} 服用${def.name}，恢复 ${heal} 点生命${p.pet ? '（宝宝也回血）' : ''}` });
      } else if (def.kind === 'energy') {
        p.cds = { basic: 0, q: 0, e: 0, r: 0 };
        p.dimCd = 0;
        roomCast(p.room, { t: 'dimfx', kind: 'emp', id: p.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2), r: 3 });
        send(p.ws, { t: 'cdreset' });
        send(p.ws, { t: 'feed', msg: `⚡ 能量药剂：所有技能冷却已重置！` });
      }
      p.potCd[m.id] = t + (def.cd || 0);
      p.potions[m.id] -= 1;
      sendYou(p); persist(p);
      return;
    }
    case 'fuse': {
      // 合成：消耗 FUSE_N 件同品质装备（取该品质里价值最低的几件）+ 金币，产出高一级品质装备
      const rar = m.rar | 0;
      if (rar < 0 || rar >= 4) return send(p.ws, { t: 'err', msg: '该品质无法继续合成' });
      const cand = p.inv.map((it, i) => ({ it, i })).filter((x) => (x.it.rar || 0) === rar && !x.it.relic);
      if (cand.length < FUSE_N) return send(p.ws, { t: 'err', msg: `需要 ${FUSE_N} 件【${RARITIES[rar].name}】装备才能合成` });
      const fee = fuseFee(rar);
      if (p.gold < fee) return send(p.ws, { t: 'err', msg: `合成需要 ${fee} 金币` });
      cand.sort((a, b) => (a.it.val || 0) - (b.it.val || 0));      // 优先消耗价值最低的
      const use = cand.slice(0, FUSE_N);
      const slot = use[use.length - 1].it.slot;                    // 产出沿用其中一件的槽位
      p.gold -= fee;
      for (const x of use.sort((a, b) => b.i - a.i)) p.inv.splice(x.i, 1);   // 从后往前删，索引不串位
      const out = makeNamed(p.dim, slot, rar + 1);
      p.inv.push(out);
      send(p.ws, { t: 'feed', msg: `⚗️ 合成成功！${FUSE_N}×【${RARITIES[rar].name}】→【${out.name}】（花费 ${fee} 金）` });
      roomCast(p.room, { t: 'dimfx', kind: 'heal', id: p.id });
      sendInv(p); sendYou(p); persist(p);
      return;
    }
  }
}

/* ---------- 猎人专属：捕捉宝宝 ---------- */
/* ---------- 次元专属技能（F 键，各次元独有） ---------- */
/* 次元技能统一：持续 60 秒、冷却 5 分钟（猎人捕捉为高频特例，保持原样） */
const DIM_DUR = 60000, DIM_CD = 300000;
const DIM_SKILL = {
  tech:    { name: '载具冲锋', cd: DIM_CD, dur: DIM_DUR, desc: '召唤战斗载具：移速大幅提升，载具有独立护甲优先承伤。持续60秒，冷却5分钟' },
  xiuxian: { name: '炼宝诀',   cd: DIM_CD, dur: DIM_DUR, desc: '熔炼背包前5件装备为法宝悬浮头顶，按(5件属性总和×等级/10)全面强化自身。持续60秒，冷却5分钟' },
  cyber:   { name: '强化针剂', cd: DIM_CD, dur: DIM_DUR, desc: '注射强化针剂：体型、技能范围、伤害与全属性 ×(1+等级/10)。持续60秒，冷却5分钟' },
  magic:   { name: '召唤天使恶魔', cd: DIM_CD, dur: DIM_DUR, desc: '天使为你和队友加增益，恶魔削弱周围敌人。持续60秒，冷却5分钟' },
  hunter:  { name: '猎手陷阱', cd: 3000,  desc: '将虚弱野怪收为宝宝；对附近敌人布下缠丝，命中减速' },
};
/* 合并临时增益（叠加在现有 statBuff 上，刷新到新的截止时间） */
function mergeBuff(p, until, add) {
  const b = (p.statBuff && now() < p.statBuff.until) ? { ...p.statBuff.bonus } : {};
  for (const k of Object.keys(add)) b[k] = (b[k] || 0) + add[k];
  return { until, bonus: b };
}

/* 玩家受伤时先扣护盾，返回穿透到生命的伤害（被多处伤害入口调用） */
function absorbShield(p, dmg) {
  // 科技载具：独立血量优先承伤
  if (p && p.vehicle && now() < p.vehicle.until && p.vehicle.hp > 0) {
    const a = Math.min(p.vehicle.hp, dmg);
    p.vehicle.hp -= a; dmg -= a;
    if (p.vehicle.hp <= 0) { p.vehicle = null; if (p.ws) send(p.ws, { t: 'feed', msg: '🚗 战斗载具被击毁！' }); }
  }
  if (p && p.shield > 0 && now() < p.shieldUntil) {
    const a = Math.min(p.shield, dmg);
    p.shield -= a; dmg -= a;
    if (p.shield <= 0) { p.shield = 0; p.shieldUntil = 0; }
  }
  return dmg;
}

/* ---------- 控制效果（眩晕/定身/减速）统一入口 ---------- */
const CC_LABEL = { stun: '眩晕', root: '定身', slow: '减速' };
/* 给目标施加控制：玩家受韧性减免，世界BOSS免疫硬控（仍可减速），保证BOSS是走位战。 */
function applyCC(src, tgt, cc) {
  if (!cc || !tgt || tgt.dead || tgt.state === 'dead') return;
  const t = now();
  const isMon = !!tgt.tier;
  if (isMon && tgt.boss && cc.type !== 'slow') return;   // BOSS 免疫眩晕/定身
  let ms = cc.ms;
  if (!isMon) { const ten = statsOf(tgt).tenacity || 0; ms = Math.round(ms * (1 - ten / 100)); }
  if (ms < 100) return;
  if (cc.type === 'slow') { tgt.slowUntil = Math.max(tgt.slowUntil || 0, t + ms); tgt.slowPct = Math.max(tgt.slowPct || 0, cc.pct || 0.3); }
  else if (cc.type === 'root') { tgt.rootUntil = Math.max(tgt.rootUntil || 0, t + ms); }
  else { tgt.stunUntil = Math.max(tgt.stunUntil || 0, t + ms); }
  roomCast(src.room, { t: 'ccfx', id: tgt.id, kind: cc.type });
  if (!isMon) send(tgt.ws, { t: 'cc', kind: cc.type, ms, pct: cc.pct || 0 });
}
/* 玩家当前是否被硬控（不能移动/施法） */
const isHardCC = (p) => { const t = now(); return (p.stunUntil && t < p.stunUntil) || (p.rootUntil && t < p.rootUntil); };
const isStunned = (p) => p.stunUntil && now() < p.stunUntil;

/* 预警型地面AoE：先广播警示圈，delay 毫秒后才真正落地结算。
 * 落地瞬间按玩家「当时」的位置判定——站在圈内才吃伤害，跑出去即可躲避，
 * 让世界BOSS是技术战（看预警走位）而非纯数值硬吃。 */
function bossAoE(room, mo, cx, cz, radius, opt) {
  const { delay = 1100, dmgMul = 1.5, dmgType = 'magic', kind = 'baoe', note } = opt || {};
  const A = mo.atk;
  const r2 = radius * radius;
  cx = +cx.toFixed(1); cz = +cz.toFixed(1);
  // 预警圈：客户端依 delay 把危险区从中心填满，填满即落地
  roomCast(room.id, { t: 'warn', x: cx, z: cz, r: radius, delay, kind });
  setTimeout(() => {
    roomCast(room.id, { t: kind, x: cx, z: cz, r: radius });      // 落地冲击特效
    for (const pl of room.players.values()) {
      if (pl.dead || inSafeZone(room, pl.x, pl.z)) continue;
      if (dist2(cx, cz, pl.x, pl.z) <= r2) hurtPlayer(room, mo, pl, A * dmgMul, dmgType, note);
    }
  }, delay);
}

/* 世界BOSS 五大技能轮换（含大范围魔法风暴） */
function bossCast(room, mo, tgt) {
  const t = now();
  const nSkills = mo.hp < mo.maxHp * 0.7 ? 7 : 5;   // 二阶段(<70%)解锁陨石雨/旋转弹幕
  mo.skIdx = ((mo.skIdx || 0) + 1) % nSkills;
  const alive = [...room.players.values()].filter((p) => !p.dead && !inSafeZone(room, p.x, p.z));
  const A = mo.atk;
  const tele = mo.enraged ? 800 : 1150;   // 狂暴后预警更短，留给玩家的躲避窗口更紧
  switch (mo.skIdx) {
    case 0: { // ① 震地轰击：7米物理（预警后落地）
      bossAoE(room, mo, mo.x, mo.z, 7, { delay: tele, dmgMul: 1.7, dmgType: 'phys', kind: 'baoe',
        note: (l) => `💀 你被【${mo.name}】震地轰击粉碎，丢失 ${l} 金币。` });
      break;
    }
    case 1: { // ② 大范围魔法风暴：16米法术（招牌技能，预警后落地）
      allCast({ t: 'feed', msg: `🌪️ 世界BOSS【${mo.name}】蓄力【毁灭魔法风暴】，速速逃离红圈！` });
      bossAoE(room, mo, mo.x, mo.z, 16, { delay: tele + 350, dmgMul: 1.6, dmgType: 'magic', kind: 'bstorm',
        note: (l) => `💀 你被【${mo.name}】的魔法风暴吞没，丢失 ${l} 金币。` });
      break;
    }
    case 2: { // ③ 弹幕扇射：朝最近玩家扇形 5 连发
      const near = alive.sort((a, b) => dist2(mo.x, mo.z, a.x, a.z) - dist2(mo.x, mo.z, b.x, b.z))[0] || tgt;
      const base = Math.atan2(near.x - mo.x, near.z - mo.z);
      for (let k = -2; k <= 2; k++) {
        const ang = base + k * 0.2;
        const ux = Math.sin(ang), uz = Math.cos(ang);
        const pid = 'j' + nextMid++;
        room.projectiles.set(pid, {
          id: pid, owner: mo.id, fromMonster: true,
          x: mo.x + ux * 0.6, z: mo.z + uz * 0.6, dx: ux, dz: uz,
          speed: 17, born: t, life: 2.6, hitR: 1.5, dmg: A * 1.1, dmgType: 'magic',
        });
        roomCast(room.id, { t: 'proj', id: pid, owner: mo.id, x: +mo.x.toFixed(2), z: +mo.z.toFixed(2), dx: +ux.toFixed(3), dz: +uz.toFixed(3), speed: 17, dim: 'mon' });
      }
      break;
    }
    case 3: { // ④ 召唤爪牙：3 只精英小弟
      allCast({ t: 'feed', msg: `👹 世界BOSS【${mo.name}】召唤了爪牙助战！` });
      for (let i = 0; i < 3; i++) {
        const ang = rnd(0, Math.PI * 2);
        addMonster(room, { name: mo.name + '·爪牙', tier: 3, x: mo.x + Math.cos(ang) * 4, z: mo.z + Math.sin(ang) * 4 });
      }
      break;
    }
    case 4: { // ⑤ 天降陨石：锁定最多 3 名玩家脚下落 5 米法术圈（预警后落地，走开即躲过）
      for (const pl of alive.slice(0, 3)) {
        bossAoE(room, mo, pl.x, pl.z, 5, { delay: tele, dmgMul: 1.3, dmgType: 'magic', kind: 'baoe',
          note: (l) => `💀 你被【${mo.name}】的陨石砸中，丢失 ${l} 金币。` });
      }
      break;
    }
    case 5: { // ⑥ 陨石雨：全场随机落 6 颗陨石，错峰落地，逼迫持续走位寻找安全点
      allCast({ t: 'feed', msg: `☄️ 世界BOSS【${mo.name}】召来【陨石雨】，全场连环轰炸，别站定！` });
      for (let i = 0; i < 6; i++) {
        const ax = mo.x + rnd(-13, 13), az = mo.z + rnd(-13, 13);
        setTimeout(() => bossAoE(room, mo, ax, az, 4.5, { delay: tele, dmgMul: 1.2, dmgType: 'magic', kind: 'baoe',
          note: (l) => `💀 你被【${mo.name}】的陨石雨击中，丢失 ${l} 金币。` }), i * 260);
      }
      break;
    }
    case 6: { // ⑦ 旋转弹幕：螺旋状射出弹丸（bullet-hell），需走出弹幕缝隙
      const arms = mo.enraged ? 10 : 8;
      const base = Math.random() * Math.PI * 2;
      for (let k = 0; k < arms; k++) {
        const ang = base + (k / arms) * Math.PI * 2;
        const ux = Math.sin(ang), uz = Math.cos(ang);
        const pid = 'j' + nextMid++;
        room.projectiles.set(pid, {
          id: pid, owner: mo.id, fromMonster: true,
          x: mo.x + ux * 0.6, z: mo.z + uz * 0.6, dx: ux, dz: uz,
          speed: 13, born: t, life: 3.0, hitR: 1.3, dmg: A * 0.9, dmgType: 'magic',
        });
        roomCast(room.id, { t: 'proj', id: pid, owner: mo.id, x: +mo.x.toFixed(2), z: +mo.z.toFixed(2), dx: +ux.toFixed(3), dz: +uz.toFixed(3), speed: 13, dim: 'mon' });
      }
      break;
    }
  }
}

/* 怪物对玩家造成伤害（近战/范围/远程统一入口），含护盾、死亡结算 */
function hurtPlayer(room, mo, pl, rawDmg, dmgType, deathNote) {
  if (pl.dead) return;
  const st = statsOf(pl);
  const def = dmgType === 'magic' ? st.mres : st.armor;
  let dmg = rawDmg * 100 / (100 + def) * clsOf(pl).dmgTakenMul;
  dmg = Math.max(1, Math.round(dmg));
  dmg = absorbShield(pl, dmg);
  pl.hp -= dmg;
  roomCast(room.id, { t: 'dmg', kind: 'p', id: pl.id, amt: dmg, hp: Math.max(0, Math.round(pl.hp)), by: mo.id });
  sendYou(pl);
  if (pl.hp <= 0) {
    if (tryRevive(pl)) { if (mo.targetId === pl.id) { mo.targetId = null; mo.state = 'idle'; } return; }
    pl.hp = 0; pl.dead = true; pl.dieT = now(); pl.anim = 'dead';
    const lost = Math.floor(pl.gold * 0.05);
    pl.gold -= lost;
    roomCast(room.id, { t: 'pdie', id: pl.id, by: mo.id });
    send(pl.ws, { t: 'feed', msg: deathNote ? deathNote(lost) : `💀 你被【${mo.name}】击杀，丢失 ${lost} 金币。` });
    sendYou(pl); persist(pl);
    if (mo.targetId === pl.id) { mo.targetId = null; mo.state = 'idle'; }
  }
}

function dimSkill(p) {
  if (p.dead) return;
  if (p.dim === 'hunter') return capturePet(p);
  const t = now();
  const def = DIM_SKILL[p.dim];
  if (!def) return;
  if (t < (p.dimCd || 0)) return;
  const room = rooms[p.room];
  const dur = def.dur || DIM_DUR;
  const until = t + dur;

  if (p.dim === 'xiuxian') {
    // 炼宝诀：熔炼背包前5件装备 → 法宝，加成 = 5件属性总和 × 等级/10，悬浮头顶，持续60秒
    if (!Array.isArray(p.inv) || p.inv.length < 5)
      return send(p.ws, { t: 'err', msg: '炼宝诀需要背包中至少 5 件装备来熔炼' });
    p.dimCd = t + def.cd;
    const keys = ['hp', 'patk', 'matk', 'armor', 'mres', 'spd', 'crit', 'critDmg'];
    const sum = {}; for (const k of keys) sum[k] = 0;
    for (const it of p.inv.slice(0, 5)) for (const k of keys) sum[k] += (it[k] || 0);
    p.inv = p.inv.slice(5);                       // 消耗前5件
    const f = p.level / 10;
    const bonus = {}; for (const k of keys) bonus[k] = Math.round(sum[k] * f);
    p.statBuff = mergeBuff(p, until, bonus);
    p.treasure = { until, cls: p.cls };           // 客户端据此在头顶渲染法宝模型
    roomCast(p.room, { t: 'dimfx', kind: 'treasure', id: p.id, cls: p.cls });
    persist(p);
    send(p.ws, { t: 'feed', msg: '⚗️ 炼宝诀！5件装备炼成法宝悬浮头顶，全属性大增，持续60秒' });
    sendYou(p);
    return;
  }

  p.dimCd = t + def.cd;
  if (p.dim === 'tech') {
    // 载具冲锋：召唤载具，移速大增 + 独立护甲优先承伤
    const vhp = Math.round(maxHp(p) * 1.2);
    p.vehicle = { until, hp: vhp, maxHp: vhp };
    p.statBuff = mergeBuff(p, until, { spd: 4 });
    roomCast(p.room, { t: 'dimfx', kind: 'vehicle', id: p.id, cls: p.cls });
    send(p.ws, { t: 'feed', msg: `🚗 战斗载具召唤！独立护甲 ${vhp}、移速大增，持续60秒` });
    sendYou(p);
  } else if (p.dim === 'cyber') {
    // 强化针剂：全属性 / 技能范围 / 体型 ×(1+等级/10)（不足1为1倍），持续60秒
    const mul = Math.max(1, 1 + p.level / 10);
    p.amp = { until, mul };
    roomCast(p.room, { t: 'dimfx', kind: 'amp', id: p.id });
    send(p.ws, { t: 'feed', msg: `💉 强化针剂：全属性·技能范围·体型 ×${mul.toFixed(1)}，持续60秒` });
    sendYou(p);
  } else if (p.dim === 'magic') {
    // 召唤天使恶魔：天使加持己方(自身+队友)，恶魔削弱周围敌人
    const atk = atkOf(p);
    p.statBuff = mergeBuff(p, until, { patk: Math.round(atk * 0.25), matk: Math.round(atk * 0.25), armor: 30, mres: 30 });
    const pa = partyOf(p);
    if (pa) for (const mm of pa.members) {
      if (mm === p || mm.dead || mm.room !== p.room) continue;
      const ma = atkOf(mm);
      mm.statBuff = mergeBuff(mm, until, { patk: Math.round(ma * 0.2), matk: Math.round(ma * 0.2) });
      send(mm.ws, { t: 'feed', msg: '😇 天使加持：攻击提升，持续60秒' }); sendYou(mm);
    }
    const R = 8, dmg = Math.round(atk * 1.0);
    for (const mo of room.monsters.values())
      if (mo.state !== 'dead' && dist2(p.x, p.z, mo.x, mo.z) <= R * R) { applyCC(p, mo, { type: 'slow', ms: 4000, pct: 0.4 }); applyDamage(p, mo, dmg, 'magic'); }
    if (p.room === 'war' || p.room === 'melee')
      for (const o of room.players.values())
        if (!o.dead && o.dim !== p.dim && dist2(p.x, p.z, o.x, o.z) <= R * R) { applyCC(p, o, { type: 'slow', ms: 4000, pct: 0.4 }); applyDamage(p, o, dmg, 'magic'); }
    roomCast(p.room, { t: 'dimfx', kind: 'angeldemon', id: p.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2), r: R });
    send(p.ws, { t: 'feed', msg: '😇👿 天使恶魔降临：己方增益、敌方减益，持续60秒' });
    sendYou(p);
  }
}

/* 净化：解除目标全部控制状态（修仙吐纳净化用） */
function cleanseCC(p) {
  p.stunUntil = 0; p.rootUntil = 0; p.slowUntil = 0; p.slowPct = 0;
  if (p.ws) send(p.ws, { t: 'cc', kind: 'cleanse', ms: 0 });
}

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
  if (ratio > 0.3) return send(p.ws, { t: 'err', msg: `先把【${best.name}】打到30%血以下再捕捉（当前${Math.round(ratio * 100)}%）` });
  const chance = Math.min(0.6, 0.65 - ratio * 1.6);   // 捕捉更难：30%血≈17%，5%血≈57%
  if (Math.random() < chance) {
    best.state = 'dead'; best.dieT = t;
    roomCast(p.room, { t: 'mdie', id: best.id, by: p.id });
    // 新宝宝与上一只融合：叠加上一只 60% 的属性，越抓越强
    const old = p.pet;
    let nHp = best.maxHp * 1.1, nAtk = best.atk * 0.9;
    if (old) { nHp += (old.maxHp || 0) * 0.6; nAtk += (old.atk || 0) * 0.6; send(p.ws, { t: 'feed', msg: `🧬 新宝宝与【${old.name}】融合，属性叠加增强！` }); }
    p.pet = {
      name: best.name, tier: best.tier,
      maxHp: Math.round(nHp), hp: Math.round(nHp),
      atk: Math.round(nAtk),
      x: p.x + 1.2, z: p.z + 1.2, ry: 0, atkT: 0, state: 'idle',
    };
    persist(p);
    roomCast(p.room, { t: 'feed', msg: `🐾 ${p.name} 成功捕捉【${best.name}】当宝宝，它将替主人战斗！` });
    unlock(p, 'pet1');
  } else {
    send(p.ws, { t: 'err', msg: `💨 【${best.name}】挣脱了捕捉！（成功率${Math.round(chance * 100)}%，血越少越容易抓）` });
  }
}

function spawnPoint(p) {
  if (p.room === 'war') {
    const side = p.dim === war.a ? -1 : 1;
    return { x: side * 60 + rnd(-3, 3), z: rnd(-10, 10) };
  }
  if (p.room === 'melee') {   // 五次元各占一角
    const i = Math.max(0, DIMENSIONS.findIndex((d) => d.id === p.dim));
    const ang = (i / DIMENSIONS.length) * Math.PI * 2;
    return { x: Math.cos(ang) * 42 + rnd(-5, 5), z: Math.sin(ang) * 42 + rnd(-5, 5) };
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
  // 首次登录且回本次元、且有存档坐标 → 回到下线位置（配合 mkPlayer 的血量恢复，杜绝退出回血+瞬移）
  if (isFirst && roomId === p.dim && typeof p._rx === 'number') {
    p.x = clamp(p._rx, -MAP_HALF, MAP_HALF);
    p.z = clamp(p._rz, -MAP_HALF, MAP_HALF);
  } else {
    p.x = sp.x; p.z = sp.z;
  }
  p._rx = p._rz = undefined;
  p.dead = false;
  if (p.pet) { p.pet.x = p.x + 1.2; p.pet.z = p.z + 1.2; }
  if (p.hp <= 0) p.hp = maxHp(p);
  rooms[roomId].players.set(p.id, p);
  send(p.ws, {
    t: 'welcome', id: p.id, room: roomId, first: isFirst, code: p.uid,
    you: { name: p.name, dim: p.dim, cls: p.cls, level: p.level, exp: p.exp, expNeed: expNeed(p.level), gold: p.gold, hp: Math.round(p.hp), maxHp: maxHp(p), kills: p.kills, pvpKills: p.pvpKills },
    players: [...rooms[roomId].players.values()].filter((o) => o.id !== p.id).map(publicP),
    war: warState(),
    melee: meleeState(),
    boss: worldBoss ? { alive: 1, dim: worldBoss.dim, name: worldBoss.name, x: worldBoss.x, z: worldBoss.z } : null,
    obstacles: rooms[roomId].obstacles,
    shop: isFirst ? SHOP : undefined,
    potionDefs: isFirst ? POTIONS : undefined,
    achDefs: isFirst ? ACHIEVEMENTS : undefined,
    ach: Object.keys(p.ach || {}), achEquip: p.achEquip || null, bagMode: p.bagMode || 'sell',
    dimSkill: { ...DIM_SKILL[p.dim], dim: p.dim },
    equip: p.equip, inv: p.inv,
    x: p.x, z: p.z,
  });
  sendYou(p);
  roomCast(roomId, { t: 'pjoin', p: publicP(p) }, p.id);
  if (isFirst) grantDaily(p);
}

/* ---------- 每日签到：上线即领，连签递增（7天封顶） ---------- */
function grantDaily(p) {
  const today = new Date().toISOString().slice(0, 10);
  const rec = saved[p.uid] || {};
  if (rec.daily === today) {
    p.daily = rec.daily;
    p.dailyStreak = rec.dailyStreak || 1;
    return;
  }
  const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  p.dailyStreak = rec.daily === yest ? (rec.dailyStreak || 0) + 1 : 1;
  p.daily = today;
  const reward = 150 + 50 * Math.min(7, p.dailyStreak);
  p.gold += reward;
  send(p.ws, { t: 'feed', msg: `📅 每日签到成功！连续 ${p.dailyStreak} 天，获得 ${reward} 金币${p.dailyStreak >= 7 ? '（已满额 500/天）' : '（连签 7 天可达每日 500 金）'}` });
  sendYou(p);
  persist(p);
}

/* ---------- 技能施放（服务器判定，按职业差异化） ---------- */
function cast(p, m) {
  if (p.dead) return;
  const kind = ['basic', 'q', 'e', 'r'].includes(m.k) ? m.k : null;
  if (!kind) return;
  if (isHardCC(p)) return send(p.ws, { t: 'err', msg: '你正被控制，无法施法' });
  const sk = clsOf(p).skills[kind];
  if (sk.minLvl && p.level < sk.minLvl) return send(p.ws, { t: 'err', msg: `${kind.toUpperCase()}技能需要 Lv.${sk.minLvl}` });
  const t = now();
  if (t < p.cds[kind]) return;
  p.cds[kind] = t + Math.round(sk.cd * (1 - (statsOf(p).cdr || 0) / 100));   // 冷却缩减

  let dx = +m.dx || 0, dz = +m.dz || 0;
  const dl = Math.sqrt(dx * dx + dz * dz) || 1;
  dx /= dl; dz /= dl;
  p.ry = Math.atan2(dx, dz);

  // 广播给同房间其他人（用于播放动作/特效）
  roomCast(p.room, { t: 'cast', id: p.id, k: kind, kk: sk.kind, x: p.x, z: p.z, dx, dz }, p.id);

  const room = rooms[p.room];
  const dmgType = clsOf(p).dmgType;
  const rm = (p.amp && now() < p.amp.until) ? p.amp.mul : 1;   // 强化针剂：技能范围倍增

  if (sk.kind === 'proj') {
    const id = 'j' + nextMid++;
    room.projectiles.set(id, {
      id, owner: p.id, x: p.x + dx * 0.5, z: p.z + dz * 0.5, dx, dz,
      speed: sk.speed, born: t, life: sk.life, hitR: (sk.radius || 1.6) * rm,
      dmg: atkOf(p) * sk.mult * skDmgMul(p, kind), dmgType, cc: sk.cc || null,
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
      if (dist2(p.x, p.z, o.x, o.z) > (sk.range * rm) * (sk.range * rm)) continue;
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
      if (dist2(p.x, p.z, o.x, o.z) <= (sk.radius * rm) * (sk.radius * rm)) applyHeal(p, o, sk.pct * skHealMul(p, kind));
    }
    return;
  }

  // melee / aoe / dashmelee：立即判定
  const dmg = atkOf(p) * sk.mult * skDmgMul(p, kind) * rnd(0.9, 1.15);
  for (const tgt of targetsOf(p)) {
    const dx2 = tgt.x - p.x, dz2 = tgt.z - p.z;
    const d = Math.sqrt(dx2 * dx2 + dz2 * dz2);
    let hit = false;
    const br = tgt.r || 0;   // 大体积怪（BOSS）按其身体边缘判定，不必戳到中心
    if (sk.kind === 'aoe') hit = d <= sk.radius * rm + br;
    else {
      if (d <= sk.range * rm + br) {
        const ang = Math.acos(clamp((dx2 * dx + dz2 * dz) / (d || 1), -1, 1));
        hit = ang <= sk.arc / 2;
      }
    }
    if (hit) { applyDamage(p, tgt, dmg, dmgType); if (sk.cc) applyCC(p, tgt, sk.cc); }
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
  if (p.room === 'war' || p.room === 'melee') {   // 混战场：所有异次元玩家皆为敌
    for (const o of room.players.values()) {
      if (o.id !== p.id && !o.dead && o.dim !== p.dim) list.push(o);
    }
  }
  return list;
}

/* 伤害结算：经过目标防御(物防/法防)与职业减伤；含暴击/穿透/吸血（仅玩家攻击者） */
function applyDamage(attacker, tgt, dmg, dmgType = 'phys', opt = {}) {
  const isMonster = !!tgt.tier;
  const ast = (attacker && !attacker.tier) ? statsOf(attacker) : null;
  // 暴击：按攻击者暴击率滚动，命中则按暴击伤害放大
  let crit = false;
  if (ast && opt.canCrit !== false && Math.random() * 100 < ast.crit) {
    crit = true; dmg *= 1 + ast.critDmg / 100;
  }
  // 已装备成就的增伤（可限定对野怪/玩家/BOSS）
  if (ast) {
    const ae = achEff(attacker);
    if (ae && ae.dmgPct && (!ae.vs
        || (ae.vs === 'monster' && isMonster) || (ae.vs === 'boss' && tgt.boss) || (ae.vs === 'player' && !isMonster)))
      dmg *= 1 + ae.dmgPct;
  }
  let def = isMonster
    ? (dmgType === 'phys' ? tgt.tier * 7 : tgt.tier * 5)
    : (dmgType === 'phys' ? statsOf(tgt).armor : statsOf(tgt).mres);
  if (ast) def = Math.max(0, def - ast.pen);   // 穿透：无视部分防御
  dmg = dmg * 100 / (100 + def);
  if (!isMonster) dmg *= clsOf(tgt).dmgTakenMul;
  dmg = Math.max(1, Math.round(dmg));
  if (!isMonster) dmg = absorbShield(tgt, dmg);   // 科技护盾吸收
  tgt.hp -= dmg;
  // 吸血：玩家攻击者按造成伤害回复生命
  if (ast && ast.lifesteal > 0 && !attacker.dead) {
    const heal = Math.round(dmg * ast.lifesteal / 100);
    if (heal > 0 && attacker.hp < ast.maxHp) {
      attacker.hp = Math.min(ast.maxHp, attacker.hp + heal);
      sendYou(attacker);
    }
  }
  roomCast(attacker.room, { t: 'dmg', kind: isMonster ? 'm' : 'p', id: tgt.id, amt: dmg, hp: Math.max(0, Math.round(tgt.hp)), by: attacker.id, crit: crit ? 1 : 0 });
  if (isMonster && tgt.boss && attacker.name) {
    // BOSS战伤害贡献统计（按昵称，结算时分配奖励）
    tgt.dmgBy = tgt.dmgBy || new Map();
    tgt.dmgBy.set(attacker.name, (tgt.dmgBy.get(attacker.name) || 0) + dmg);
  }
  if (isMonster) {
    tgt.targetId = attacker.id;
    if (tgt.state === 'idle') tgt.state = 'chase';
    if (tgt.hp <= 0) killMonster(attacker, tgt);
  } else {
    if (tgt.hp <= 0) { if (!tryRevive(tgt)) killPlayer(attacker, tgt); }
    else sendYou(tgt);
  }
}

function killMonster(p, mo) {
  mo.state = 'dead';
  mo.dieT = now();
  p.kills++;
  p.gold += Math.round(mo.gold / 3 * (1 + ((achEff(p) || {}).goldPct || 0)));   // 金币获取难度×3（基础/3）+ 成就加成
  roomCast(p.room, { t: 'mdie', id: mo.id, by: p.id });
  if (mo.boss) {
    // 世界BOSS按伤害贡献结算：MVP必得史诗，≥10%贡献者得稀有+与半额经验，杜绝抢尾刀
    const total = Math.max(1, mo.maxHp);
    const contrib = [...(mo.dmgBy || new Map()).entries()].sort((a, b) => b[1] - a[1]);
    const topTxt = contrib.slice(0, 3)
      .map(([n, d]) => `${n} ${Math.min(100, Math.round(d / total * 100))}%`).join('、');
    allCast({ t: 'feed', msg: `👑 世界BOSS【${mo.name}】被讨伐！伤害贡献榜：${topTxt || p.name}` });
    let mvpGiven = false;
    for (const [name, d] of contrib) {
      const mem = [...conns.values()].find((o) => o.name === name);
      if (!mem) continue;
      if (!mvpGiven) {
        mvpGiven = true;
        giveItem(mem, rollDrop(4, mem.dim, 4, 0.6), `世界BOSS【${mo.name}】MVP奖励`);   // 传说+额外满词条
        allCast({ t: 'feed', msg: `🏅 本场BOSS战MVP：【${dimName(mem.dim)}】${mem.name}，顶级战利品到手！` });
        unlock(mem, 'mvp1');
      } else if (d / total >= 0.1) {
        giveItem(mem, rollDrop(4, mem.dim, 3, 0.3), `世界BOSS【${mo.name}】贡献奖励`);   // 史诗+强化词条
        if (mem !== p) gainExp(mem, Math.round(mo.exp * 0.5));
      }
      unlock(mem, 'boss1');
    }
    if (!mvpGiven) giveItem(p, rollDrop(4, p.dim, 4, 0.5), `世界BOSS【${mo.name}】掉落`);
    allCast({ t: 'boss', alive: 0 });
    worldBoss = null;
  } else if (Math.random() < (0.08 + mo.tier * 0.035) / 3) {
    // 几率掉落装备（获取难度×3：概率/3；层级越高概率越大、品质越好）
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
  // PvP 段位分结算：打强者得分多、打弱者得分少；阵亡者扣分（不低于0）
  const before = rankTier(killer.rankPts).name;
  const { gain, loss } = rankDelta(killer.rankPts || 0, victim.rankPts || 0);
  killer.rankPts = (killer.rankPts || 0) + gain;
  victim.rankPts = Math.max(0, (victim.rankPts || 0) - loss);
  send(killer.ws, { t: 'feed', msg: `🏅 段位 +${gain} 分（当前 ${killer.rankPts}｜${rankTier(killer.rankPts).icon}${rankTier(killer.rankPts).name}）` });
  send(victim.ws, { t: 'feed', msg: `📉 段位 -${loss} 分（当前 ${victim.rankPts}｜${rankTier(victim.rankPts).icon}${rankTier(victim.rankPts).name}）` });
  const after = rankTier(killer.rankPts).name;
  if (after !== before) allCast({ t: 'feed', msg: `${rankTier(killer.rankPts).icon} 【${dimName(killer.dim)}】${killer.name} 晋级【${after}】段位！` });
  checkAch(killer);
  if (war.active && victim.room === 'war') {
    if (killer.dim === war.a) war.killsA++;
    else if (killer.dim === war.b) war.killsB++;
    allCast({ t: 'war', state: warState() });
  }
  if (victim.room === 'melee') { meleeEliminated.add(victim.uid); killer.meleeKills = (killer.meleeKills || 0) + 1; }   // 混战：阵亡即淘汰，记 MVP 击杀
  roomCast(victim.room, { t: 'pdie', id: victim.id, by: killer.id });
  const arena = victim.room === 'melee' ? '五次元大混战' : '重叠战场';
  allCast({ t: 'feed', msg: `⚔️ 【${dimName(killer.dim)}】${killer.name} 在${arena}击杀了 【${dimName(victim.dim)}】${victim.name}，掠夺 ${loot} 金币！` });
  sendYou(victim);
  gainExp(killer, 30 + victim.level * 10);
  persist(victim);
}

const dimName = (id) => { const d = DIMENSIONS.find((x) => x.id === id); return d ? d.name : id; };

const inSafeZone = (room, x, z) => room.id !== 'war' && room.id !== 'melee' && x * x + z * z < SAFE_R * SAFE_R;

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

/* ---------- 五次元大混战 ---------- */
const melee = { active: false, endsAt: 0, day: null, startedAt: 0, participants: new Set() };
const meleeEliminated = new Set();
function meleeState() { return { active: melee.active, endsAt: melee.endsAt }; }

function startMelee() {
  melee.active = true;
  melee.day = new Date().toDateString();
  melee.startedAt = now();
  melee.endsAt = now() + (MELEE_MS > 0 ? MELEE_MS : Math.max(1, MELEE_END_HOUR - MELEE_HOUR) * 3600000);
  melee.participants.clear();
  meleeEliminated.clear();
  for (const c of conns.values()) c.meleeKills = 0;   // 重置 MVP 击杀计数
  rooms.melee.monsters.clear();
  rooms.melee.projectiles.clear();
  allCast({ t: 'melee', state: meleeState() });
  allCast({ t: 'feed', msg: '🔥🔥🔥 【五次元大混战】开战！所有次元的降临者可进入混战场，存活玩家最多的次元大胜，独享传说奖励！点顶部横幅进入！' });
}

function endMelee() {
  const aliveByDim = {};
  for (const p of rooms.melee.players.values()) {
    if (p.dead) continue;
    aliveByDim[p.dim] = (aliveByDim[p.dim] || 0) + 1;
  }
  let winner = null, best = -1;
  for (const [dim, n] of Object.entries(aliveByDim)) if (n > best) { best = n; winner = dim; }
  melee.active = false; melee.endsAt = 0;
  // MVP：本场混战击杀最多者（优先取胜方阵营），独享「次元至宝」满词条传说
  const roster = [...rooms.melee.players.values()];
  const mvpPool = winner ? roster.filter((p) => p.dim === winner) : roster;
  let mvp = null;
  for (const p of (mvpPool.length ? mvpPool : roster))
    if ((p.meleeKills || 0) > 0 && (!mvp || p.meleeKills > mvp.meleeKills)) mvp = p;
  for (const p of roster) {
    const win = winner && p.dim === winner && !p.dead;
    if (win) {
      giveItem(p, rollDrop(4, p.dim, 4), '五次元大混战·大胜');   // 传说装备
      p.gold += 2000; unlock(p, 'melee_win');
      send(p.ws, { t: 'feed', msg: `👑 你所在的【${dimName(winner)}】赢得五次元大混战！传说装备 + 2000 金币到手！` });
    } else {
      p.gold += 200;
      send(p.ws, { t: 'feed', msg: '🏁 大混战结束，参与奖励 200 金币。' });
    }
    if (p === mvp) {
      giveItem(p, makeDimRelic(p.dim), '五次元大混战·MVP');
      allCast({ t: 'feed', msg: `🏆✨ 本场五次元大混战 MVP：【${dimName(p.dim)}】${p.name}（${p.meleeKills} 杀）！独得最极品【次元至宝】！` });
    }
    persist(p);
    joinRoom(p, p.dim);
  }
  allCast({ t: 'melee', state: meleeState() });
  allCast({ t: 'feed', msg: winner ? `🏆 五次元大混战落幕：【${dimName(winner)}】以 ${best} 名存活者大胜！` : '🏆 五次元大混战落幕。' });
}

// 每 15 秒：到点开战 / 判断结束 / 清理已阵亡的淘汰者
setInterval(() => {
  const d = new Date();
  if (!melee.active) {
    const today = d.toDateString();
    if (melee.day !== today && conns.size > 0 &&
        (process.env.DW_MELEE_NOW === '1' || d.getHours() === MELEE_HOUR)) startMelee();
    return;
  }
  // 阵亡者超过 3 秒 → 淘汰并送回本次元
  for (const p of [...rooms.melee.players.values()]) {
    if (p.dead && now() - p.dieT > 3000) {
      meleeEliminated.add(p.uid);
      p.dead = false; p.hp = maxHp(p);
      joinRoom(p, p.dim);
      send(p.ws, { t: 'feed', msg: '💀 你已在大混战中被淘汰，下次再战！' });
      sendYou(p);
    }
  }
  const alive = [...rooms.melee.players.values()].filter((p) => !p.dead);
  const dims = new Set(alive.map((p) => p.dim));
  const elapsed = now() - melee.startedAt;
  if (now() > melee.endsAt) return endMelee();
  if (elapsed > 60000 && melee.participants.size >= 2 && alive.length >= 1 && dims.size <= 1) return endMelee();
  if (elapsed > 60000 && melee.participants.size >= 2 && alive.length <= 1) return endMelee();
}, 15000);

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
    const owner = pr.fromMonster ? null : [...room.players.values()].find((p) => p.id === pr.owner);
    const mob = pr.fromMonster ? room.monsters.get(pr.owner) : null;
    const targets = pr.fromMonster
      ? [...room.players.values()].filter((p) => !p.dead && !inSafeZone(room, p.x, p.z))
      : (owner ? targetsOf(owner) : []);
    for (let s = 0; s <= subs && !hitId; s++) {
      const px = pr.x + pr.dx * step * (s / subs);
      const pz = pr.z + pr.dz * step * (s / subs);
      for (const tgt of targets) {
        const er = hr + (tgt.r || 0);   // BOSS 体积加到命中半径
        if (dist2(px, pz, tgt.x, tgt.z) < er * er) {
          if (pr.fromMonster) hurtPlayer(room, mob || { id: pr.owner, name: '怪物', targetId: null }, tgt, pr.dmg, pr.dmgType);
          else { applyDamage(owner, tgt, pr.dmg, pr.dmgType); if (pr.cc && owner) applyCC(owner, tgt, pr.cc); }
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
    if (mo.stunUntil && t < mo.stunUntil) continue;            // 眩晕：完全无法行动
    const rooted = mo.rootUntil && t < mo.rootUntil;           // 定身：可攻击不可移动
    const moSpd = (mo.slowUntil && t < mo.slowUntil) ? mo.speed * (1 - (mo.slowPct || 0)) : mo.speed;  // 减速
    let tgt = mo.targetId ? room.players.get(mo.targetId) : null;
    if (tgt && (tgt.dead || inSafeZone(room, tgt.x, tgt.z) || dist2(mo.x, mo.z, tgt.x, tgt.z) > 26 * 26)) {
      tgt = null; mo.targetId = null;
      if (mo.hp < mo.maxHp) mo.hp = mo.maxHp;   // 脱战回满血
    }
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
    // 世界BOSS 阶段升级：70% 进入二阶段（解锁陨石雨/旋转弹幕 + 召唤援军），35% 进入狂暴
    if (mo.boss && !mo.phase2 && mo.maxHp >= 800 && mo.hp < mo.maxHp * 0.7) {
      mo.phase2 = true;
      allCast({ t: 'feed', msg: `🌀 世界BOSS【${mo.name}】进入第二阶段！解锁【陨石雨】【旋转弹幕】并召唤援军！` });
      for (let i = 0; i < 3; i++) {
        const ang = rnd(0, Math.PI * 2);
        addMonster(room, { name: mo.name + '·爪牙', tier: 3, x: mo.x + Math.cos(ang) * 4, z: mo.z + Math.sin(ang) * 4, level: 60 });
      }
    }
    if (mo.boss && !mo.enraged && mo.hp < mo.maxHp * 0.35) {
      mo.enraged = true;
      mo.atk = Math.round(mo.atk * 1.5);
      mo.speed *= 1.3;
      allCast({ t: 'feed', msg: `💢 世界BOSS【${mo.name}】血量告急，进入狂暴！技能更频繁、伤害更高，速速规避！` });
    }
    if (tgt) {
      const d = Math.sqrt(dist2(mo.x, mo.z, tgt.x, tgt.z));
      mo.ry = Math.atan2(tgt.x - mo.x, tgt.z - mo.z);
      // 世界BOSS：技能轮换释放（阶段越深越频繁）
      if (mo.boss && t - (mo.aoeT || 0) > (mo.enraged ? 2600 : mo.phase2 ? 3600 : 4500)) {
        mo.aoeT = t;
        bossCast(room, mo, tgt);
      }
      // 精英怪技能：远程弹幕 / 范围震击（按怪物 skill 字段）
      if (!mo.boss && mo.skill && mo.skill !== 'none' && t - mo.skillT > (mo.elite ? 2600 : 4200)) {
        if (mo.skill === 'ranged' && d > 3 && d < 18) {
          mo.skillT = t; mo.atkT = t; mo.state = 'attack';
          const pid = 'j' + nextMid++;
          const ux = (tgt.x - mo.x) / d, uz = (tgt.z - mo.z) / d;
          room.projectiles.set(pid, {
            id: pid, owner: mo.id, fromMonster: true,
            x: mo.x + ux * 0.6, z: mo.z + uz * 0.6, dx: ux, dz: uz,
            speed: 15, born: t, life: 2.5, hitR: 1.4,
            dmg: mo.atk * 1.3, dmgType: mo.tier >= 3 ? 'magic' : 'phys',
          });
          roomCast(room.id, { t: 'proj', id: pid, owner: mo.id, x: +mo.x.toFixed(2), z: +mo.z.toFixed(2), dx: +ux.toFixed(3), dz: +uz.toFixed(3), speed: 15, dim: 'mon' });
        } else if (mo.skill === 'aoe' && d < 6) {
          mo.skillT = t; mo.atkT = t; mo.state = 'attack';
          roomCast(room.id, { t: 'maoe', x: +mo.x.toFixed(1), z: +mo.z.toFixed(1), r: 4.5 });
          for (const pl of room.players.values()) {
            if (pl.dead || dist2(mo.x, mo.z, pl.x, pl.z) > 4.5 * 4.5) continue;
            hurtPlayer(room, mo, pl, mo.atk * 1.3, 'magic',
              (lost) => `💀 你被【${mo.name}】的震击击倒，丢失 ${lost} 金币。`);
          }
        }
      }
      const reach = 2.0 + (mo.r || 0);   // BOSS 身体半径计入近战距离，才够得到被挤到边缘的玩家
      if (tgt.dead) {           // 轰击若击杀了目标，本帧停手
        mo.targetId = null; mo.state = 'idle';
      } else if (d > reach && !rooted) {
        mo.state = 'chase';
        mo.x += (tgt.x - mo.x) / d * moSpd * dt;
        mo.z += (tgt.z - mo.z) / d * moSpd * dt;
        const rm = resolveObstacles(room, mo.x, mo.z, 0.8);
        mo.x = rm.x; mo.z = rm.z;
      } else if (d <= reach && t - mo.atkT > 1100) {
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
          hurtPlayer(room, mo, tgt, dmg, 'phys');
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

const VIEW_R2 = 95 * 95;   // 兴趣范围：只把该范围内的怪物下发给玩家（地图大、怪多时大幅省带宽与客户端渲染）
function snapRow(mo) {
  return [mo.id, +mo.x.toFixed(2), +mo.z.toFixed(2), +mo.ry.toFixed(2), mo.state, Math.max(0, Math.round(mo.hp)), mo.maxHp, mo.tier, mo.name, mo.level || 1, mo.elite ? 1 : 0];
}
function snapshot(room) {
  if (room.players.size === 0) return;
  // 玩家与宝宝数量少，整体下发；怪物按各玩家兴趣范围裁剪
  const ps = [...room.players.values()].map((p) => [p.id, +p.x.toFixed(2), +p.z.toFixed(2), +p.ry.toFixed(2), p.anim, Math.round(p.hp), maxHp(p), p.level, p.dead ? 1 : 0]);
  const pets = [...room.players.values()].filter((p) => p.pet).map((p) => {
    const pe = p.pet;
    return [p.id, pe.tier, +pe.x.toFixed(2), +pe.z.toFixed(2), +pe.ry.toFixed(2), pe.state, Math.max(0, Math.round(pe.hp)), pe.maxHp, pe.name];
  });
  const mons = [...room.monsters.values()];
  // 怪物少时无需逐人裁剪，整体下发省 CPU
  if (mons.length <= 40) {
    roomCast(room.id, { t: 'snap', ps, ms: mons.map(snapRow), pets });
    return;
  }
  for (const p of room.players.values()) {
    if (p.ws.readyState !== 1) continue;
    const ms = [];
    for (const mo of mons) if (dist2(p.x, p.z, mo.x, mo.z) <= VIEW_R2 || mo.boss) ms.push(snapRow(mo));
    send(p.ws, { t: 'snap', ps, ms, pets });
  }
}

setInterval(() => {
  for (const room of Object.values(rooms)) {
    if (room.players.size > 0 || room.id === 'war' || room.id === 'melee') tickRoom(room);
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
