/* ============================================================
 * 次元大战 · 多人在线版 服务端
 * 服务器权威：世界时钟 / 次元大战结算 / 战斗 / 掠夺 / 邀请
 *
 * 环境变量：
 *   PORT              监听端口（默认 3000）
 *   GAME_DAY_MINUTES  一个游戏日的真实分钟数（默认 1440 = 现实1天，
 *                     即每周开战一次；测试时可设为 2，14分钟一周）
 *   ADMIN_KEY         管理密钥，设置后可用 /admin/tick 手动推进时间
 * ============================================================ */
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { DIMENSIONS, RARITIES, SLOTS, INVITE_REWARDS } = require('./game/data');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DAY_MS = (parseInt(process.env.GAME_DAY_MINUTES || '1440', 10)) * 60 * 1000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const SAVE_FILE = path.join(__dirname, 'world.json');

const WAR_DAY = 7;             // 每周第7天结束时开战
const OVERLAP_START_DAY = 5;   // 第5天起出现重叠区
const ENERGY_CAP = 50;
const ENERGY_REGEN_MS = 3 * 60 * 1000;   // 3分钟回1点体力
const HP_REGEN_PCT_PER_MIN = 0.02;       // 每分钟回2%血
const PVP_SHIELD_MS = 30 * 60 * 1000;    // 被击杀后30分钟保护
const PVP_PAIR_LOCK_MS = 60 * 60 * 1000; // 同一对手1小时内不能再抢

/* ---------- 工具 ---------- */
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const dimById = (id) => DIMENSIONS.find((d) => d.id === id);
const now = () => Date.now();

/* ============================================================
 * 世界状态
 * ============================================================ */
let world = null;
let dirty = false;

function newWorld(season = 1) {
  const dims = {};
  for (const d of DIMENSIONS) {
    dims[d.id] = { alive: true, wins: 0, merit: 0, npcBase: 800 };
  }
  return {
    season,
    day: 1,
    lastTickAt: now(),
    dims,
    nextWar: null,
    overlapRegions: [],
    finished: false,
    champion: null,
    logs: [],
    players: {},   // user -> player record
  };
}

function loadWorld() {
  try {
    if (fs.existsSync(SAVE_FILE)) {
      world = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
      console.log(`[world] 已加载存档：第${world.season}赛季 第${world.day}天，玩家${Object.keys(world.players).length}人`);
      return;
    }
  } catch (e) { console.error('[world] 存档损坏，新建世界', e); }
  world = newWorld();
  scheduleWar();
  worldLog(`🌌 第${world.season}赛季开启！五大次元就位，每周第${WAR_DAY}天将开启次元大战！`, 'sys');
}

function saveWorld() {
  if (!dirty) return;
  try {
    fs.writeFileSync(SAVE_FILE + '.tmp', JSON.stringify(world));
    fs.renameSync(SAVE_FILE + '.tmp', SAVE_FILE);
    dirty = false;
  } catch (e) { console.error('[world] 保存失败', e); }
}
const markDirty = () => { dirty = true; };

/* ---------- 时间 ---------- */
const dayOfWeek = () => ((world.day - 1) % 7) + 1;
const weekNo = () => Math.floor((world.day - 1) / 7) + 1;
const aliveDims = () => DIMENSIONS.filter((d) => world.dims[d.id].alive);

/* ---------- 日志 / 邮件 ---------- */
function worldLog(msg, cls = '') {
  const entry = { msg, cls, day: world.day, ts: now() };
  world.logs.unshift(entry);
  if (world.logs.length > 120) world.logs.pop();
  broadcast({ t: 'log', entry });
  markDirty();
}

function mail(p, msg) {
  p.mail.unshift({ msg, ts: now() });
  if (p.mail.length > 50) p.mail.pop();
  const ws = userConn.get(p.user);
  if (ws) send(ws, { t: 'mail', mail: p.mail });
  markDirty();
}

/* ============================================================
 * 玩家
 * ============================================================ */
function hashPass(pass, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pass, salt, 32).toString('hex');
  return { salt, hash };
}

function newPlayer(user, pass, name, dimId) {
  return {
    user, name, dim: dimId,
    auth: hashPass(pass),
    token: crypto.randomBytes(24).toString('hex'),
    level: 1, exp: 0, gold: 50,
    hp: -1, hpTs: now(),            // hp=-1 表示满血
    energy: ENERGY_CAP, energyTs: now(),
    equip: { weapon: null, armor: null, acc: null },
    bag: [],
    willBuff: 0, invites: 0,
    inviteCode: 'DW-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
    kills: 0, pvpWins: 0, pvpLosses: 0, rebirths: 0,
    mail: [],
    createdAt: now(), lastSeen: now(),
  };
}

function playerStats(p) {
  const buff = 1 + p.willBuff;
  let atk = 10 + p.level * 4;
  let def = 4 + p.level * 2;
  let hp = 100 + p.level * 22;
  for (const slot of SLOTS) {
    const e = p.equip[slot.key];
    if (!e) continue;
    if (e.stat === 'atk') atk += e.value;
    if (e.stat === 'def') def += e.value;
    if (e.stat === 'hp') hp += e.value;
  }
  return { atk: Math.round(atk * buff), def: Math.round(def * buff), maxHp: Math.round(hp * buff) };
}

function equipScoreOf(p) {
  let s = 0;
  for (const slot of SLOTS) {
    const e = p.equip[slot.key];
    if (e) s += e.stat === 'hp' ? e.value / 4 : e.value;
  }
  return Math.round(s);
}

const playerPower = (p) => Math.round(p.level * 20 + equipScoreOf(p) + p.willBuff * 200);
const expNeed = (lvl) => 50 + (lvl - 1) * 45;

function touchPlayer(p) {
  // 体力恢复
  const t = now();
  const gain = Math.floor((t - p.energyTs) / ENERGY_REGEN_MS);
  if (gain > 0) {
    p.energy = Math.min(ENERGY_CAP, p.energy + gain);
    p.energyTs = p.energy >= ENERGY_CAP ? t : p.energyTs + gain * ENERGY_REGEN_MS;
  }
  // 生命恢复
  const st = playerStats(p);
  if (p.hp < 0 || p.hp >= st.maxHp) { p.hp = -1; }
  else {
    const mins = (t - p.hpTs) / 60000;
    const healed = p.hp + st.maxHp * HP_REGEN_PCT_PER_MIN * mins;
    p.hp = healed >= st.maxHp ? -1 : healed;
  }
  p.hpTs = t;
}

const curHp = (p) => { const st = playerStats(p); return p.hp < 0 ? st.maxHp : Math.round(p.hp); };

function gainExp(p, n, lines) {
  p.exp += n;
  while (p.exp >= expNeed(p.level)) {
    p.exp -= expNeed(p.level);
    p.level++;
    p.hp = -1;
    lines && lines.push({ msg: `🆙 升级到 Lv.${p.level}！`, cls: 'good' });
    const sk = dimById(p.dim).skills.find((s) => s.lvl === p.level);
    if (sk) lines && lines.push({ msg: `✨ 领悟新技能【${sk.name}】：${sk.desc}`, cls: 'good' });
  }
  markDirty();
}

function rollRarity(minIdx = 0) {
  const pool = RARITIES.slice(minIdx);
  const total = pool.reduce((s, r) => s + r.weight, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= pool[i].weight;
    if (roll <= 0) return minIdx + i;
  }
  return minIdx;
}

function makeEquip(dimId, level, minRarity = 0) {
  const dim = dimById(dimId);
  const slot = pick(SLOTS);
  const rIdx = rollRarity(minRarity);
  const r = RARITIES[rIdx];
  const pool = slot.key === 'weapon' ? dim.weaponNames : slot.key === 'armor' ? dim.armorNames : dim.accNames;
  const base = slot.stat === 'hp' ? 20 + level * 8 : 4 + level * 2;
  return {
    id: crypto.randomBytes(8).toString('hex'),
    name: `${r.name}·${pick(pool)}`,
    slot: slot.key, stat: slot.stat,
    value: Math.round(base * r.mult * (0.9 + Math.random() * 0.2)),
    rarity: rIdx, dim: dimId,
  };
}

const playersInDim = (dimId) => Object.values(world.players).filter((p) => p.dim === dimId);

function dimPower(dimId) {
  const info = world.dims[dimId];
  let p = info.npcBase * (1 + 0.02 * world.day);
  for (const pl of playersInDim(dimId)) p += playerPower(pl) * 3;
  p += info.merit * 15;
  p *= 1 + info.wins * 0.1;
  return Math.round(p);
}

/* ============================================================
 * 世界时钟：每个游戏日 tick 一次
 * ============================================================ */
function tick() {
  // 第7天结束 → 结算次元大战
  if (!world.finished && dayOfWeek() === WAR_DAY && world.nextWar) resolveWar();

  world.day++;
  world.lastTickAt = now();

  if (world.finished) {
    // 终局后的下一个游戏日 → 开启新赛季
    startNewSeason();
  } else {
    const dow = dayOfWeek();
    if (dow === 1 && !world.nextWar) scheduleWar();
    if (dow === OVERLAP_START_DAY && world.nextWar) openOverlap();
    if (dow === WAR_DAY && world.nextWar) {
      const a = dimById(world.nextWar.a), b = dimById(world.nextWar.b);
      worldLog(`🔥 今日为大战之日！【${a.name}】与【${b.name}】的次元之战将在今天结束时结算，重叠区仍在开放，抓紧最后的掠夺机会、为本方积累战意！`, 'warn');
    }
  }
  markDirty();
  broadcastWorld();
}

function scheduleWar() {
  const alive = aliveDims();
  if (alive.length < 2) { world.nextWar = null; return; }
  const sh = [...alive].sort(() => Math.random() - 0.5);
  world.nextWar = { a: sh[0].id, b: sh[1].id };
  world.overlapRegions = [];
  world.dims[sh[0].id].merit = 0;
  world.dims[sh[1].id].merit = 0;
  worldLog(`⚡ 世界意志公告：第${weekNo()}周次元大战对阵——【${sh[0].name}】 VS 【${sh[1].name}】！第${OVERLAP_START_DAY}天起两界将出现重叠区！`, 'warn');
}

function openOverlap() {
  world.overlapRegions = [0, 1, 2, 3].sort(() => Math.random() - 0.5).slice(0, 2);
  const a = dimById(world.nextWar.a), b = dimById(world.nextWar.b);
  const names = world.overlapRegions
    .map((i) => `${a.regions[i].name}↔${b.regions[i].name}`).join('、');
  worldLog(`🌀 次元壁垒松动！【${a.name}】与【${b.name}】的地图区域开始重叠（${names}）！双方降临者将在重叠区相遇，击杀敌方可掠夺其金币与装备，并为本方积累战意！`, 'warn');
}

function resolveWar() {
  const { a, b } = world.nextWar;
  const pa = dimPower(a) * (0.95 + Math.random() * 0.1);
  const pb = dimPower(b) * (0.95 + Math.random() * 0.1);
  const winner = pa >= pb ? a : b;
  const loser = winner === a ? b : a;
  const wName = dimById(winner).name, lName = dimById(loser).name;

  world.dims[winner].wins++;
  world.dims[loser].alive = false;
  // 败方NPC底蕴并入各存活次元
  const share = world.dims[loser].npcBase / Math.max(1, aliveDims().length);
  for (const d of aliveDims()) world.dims[d.id].npcBase += share;
  world.dims[loser].npcBase = 0;

  worldLog(`🏁 第${weekNo()}周次元大战结算：【${wName}】(战力${Math.round(winner === a ? pa : pb)}) 击败 【${lName}】(战力${Math.round(winner === a ? pb : pa)})！【${lName}】次元壁崩塌，归于虚无……`, 'warn');

  // 胜方玩家发奖
  for (const p of playersInDim(winner)) {
    const gold = 300 + weekNo() * 150;
    p.gold += gold;
    const eq = makeEquip(winner, p.level + 2, 3);
    p.bag.push(eq);
    gainExp(p, 120 + weekNo() * 60, null);
    mail(p, `🎊 次元大战胜利！世界意志降下嘉奖：${gold}金币、【${eq.name}】与大量经验！本次元晋级下一轮！`);
  }
  // 败方玩家重生
  const survivors = aliveDims();
  for (const p of playersInDim(loser)) {
    const target = pick(survivors);
    const lost = Math.floor(p.gold * 0.3);
    p.gold -= lost;
    p.dim = target.id;
    p.rebirths++;
    p.hp = -1;
    mail(p, `💔 次元大战失败，【${lName}】崩塌……世界意志将你接引重生至【${target.name}】（损失${lost}金币，等级与装备保留，技能体系已转换）。`);
  }
  worldLog(`🌱 【${lName}】的降临者已被世界意志接引，重生于其余次元。`, 'sys');

  world.nextWar = null;
  world.overlapRegions = [];

  if (survivors.length <= 1) {
    world.finished = true;
    world.champion = survivors[0] ? survivors[0].id : null;
    const champ = survivors[0];
    worldLog(`👑 【${champ.name}】吞并诸天，成为第${world.season}赛季最后的胜利者！其降临者共享至高荣耀！新赛季将于次日开启。`, 'warn');
    for (const p of playersInDim(champ.id)) {
      p.gold += 2000;
      p.willBuff += 0.1;
      mail(p, `👑 你所在的【${champ.name}】成为第${world.season}赛季总冠军！世界意志赐予：2000金币 + 全属性永久+10%！`);
    }
  }
  // 通知所有在线玩家刷新自身状态
  for (const [user, ws] of userConn) {
    const p = world.players[user];
    if (p) send(ws, { t: 'you', you: youSnapshot(p) });
  }
  markDirty();
}

function startNewSeason() {
  const season = world.season + 1;
  for (const d of DIMENSIONS) {
    world.dims[d.id] = { alive: true, wins: 0, merit: 0, npcBase: 800 };
  }
  world.finished = false;
  world.champion = null;
  world.nextWar = null;
  world.overlapRegions = [];
  world.season = season;
  world.day = 1;
  // 玩家保留全部进度，由世界意志重新投放至五大次元
  for (const p of Object.values(world.players)) {
    const target = pick(DIMENSIONS);
    p.dim = target.id;
    p.hp = -1;
    mail(p, `🌌 第${season}赛季开启！世界意志将你投放至【${target.name}】，进度全部保留。新的征伐开始了！`);
  }
  scheduleWar();
  worldLog(`🌌 第${season}赛季开启！五大次元重铸，所有降临者已重新投放！`, 'sys');
}

/* ============================================================
 * 战斗（服务器权威，回合制）
 * ============================================================ */
const sessions = new Map();    // user -> combat session
const pvpShield = new Map();   // victimUser -> ts（被击杀保护）
const pvpPairLock = new Map(); // "attacker:victim" -> ts

function startCombat(p, ws, enemy, kind, extra = {}) {
  const session = {
    user: p.user, kind, enemy, cds: {}, stunned: 0, ...extra,
    lines: [{ msg: `遭遇 ${enemy.name}（Lv.${enemy.level}）！战斗开始！`, cls: '' }],
  };
  sessions.set(p.user, session);
  send(ws, { t: 'combat', state: combatState(p, session) });
}

function combatState(p, s) {
  const st = playerStats(p);
  return {
    title: s.title || '',
    you: { name: p.name, level: p.level, hp: curHp(p), maxHp: st.maxHp },
    enemy: { name: s.enemy.name, level: s.enemy.level, hp: Math.max(0, Math.round(s.enemy.hp)), maxHp: s.enemy.maxHp, isPlayer: !!s.enemy.isPlayer },
    skills: dimById(p.dim).skills
      .filter((sk) => sk.lvl <= p.level)
      .map((sk) => ({ name: sk.name, desc: sk.desc, cd: s.cds[sk.name] || 0 })),
    lines: s.lines.slice(0, 30),
  };
}

const dmgCalc = (atk, def, mult) => Math.max(1, Math.round(atk * mult * (0.85 + Math.random() * 0.3) - def * 0.5));

function combatAct(p, ws, skillName) {
  const s = sessions.get(p.user);
  if (!s) return send(ws, { t: 'error', msg: '当前没有进行中的战斗' });
  const st = playerStats(p);
  let skill = { name: '普通攻击', type: 'dmg', mult: 1.0, cd: 0 };
  if (skillName && skillName !== '普通攻击') {
    const found = dimById(p.dim).skills.find((k) => k.name === skillName && k.lvl <= p.level);
    if (!found) return send(ws, { t: 'error', msg: '未掌握该技能' });
    if ((s.cds[found.name] || 0) > 0) return send(ws, { t: 'error', msg: '技能冷却中' });
    skill = found;
  }
  if (skill.cd > 0) s.cds[skill.name] = skill.cd + 1;
  for (const k in s.cds) if (s.cds[k] > 0) s.cds[k]--;

  if (skill.type === 'heal') {
    const heal = Math.round(st.maxHp * skill.pct);
    p.hp = Math.min(st.maxHp, curHp(p) + heal);
    if (p.hp >= st.maxHp) p.hp = -1;
    s.lines.unshift({ msg: `✨ 你使用【${skill.name}】，恢复${heal}点生命。`, cls: 'good' });
  } else {
    const dmg = dmgCalc(st.atk, s.enemy.def, skill.mult);
    s.enemy.hp -= dmg;
    s.lines.unshift({ msg: `⚔️ 你使用【${skill.name}】，对${s.enemy.name}造成${dmg}点伤害！`, cls: '' });
    if (skill.type === 'stun' && s.enemy.hp > 0) {
      s.stunned = 1;
      s.lines.unshift({ msg: `💫 ${s.enemy.name}被控制，下回合无法行动！`, cls: 'good' });
    }
  }

  if (s.enemy.hp <= 0) return endCombat(p, ws, s, true);

  // 敌方回合
  if (s.stunned > 0) {
    s.stunned--;
    s.lines.unshift({ msg: `💫 ${s.enemy.name}无法行动！`, cls: 'good' });
  } else {
    let mult = 1.0, label = '攻击';
    if (s.enemy.isPlayer && Math.random() < 0.3) { mult = 1.5; label = '次元技能'; }
    const dmg = dmgCalc(s.enemy.atk, st.def, mult);
    p.hp = Math.max(0, curHp(p) - dmg);
    s.lines.unshift({ msg: `🩸 ${s.enemy.name}对你发动${label}，造成${dmg}点伤害！`, cls: 'bad' });
    if (p.hp <= 0) { p.hp = 1; return endCombat(p, ws, s, false); }
  }
  markDirty();
  send(ws, { t: 'combat', state: combatState(p, s) });
}

function endCombat(p, ws, s, win) {
  sessions.delete(p.user);
  const lines = [];
  if (s.kind === 'pve') {
    const mLvl = s.enemy.level;
    if (win) {
      const exp = 25 + mLvl * 12;
      const gold = 12 + mLvl * 6 + rnd(0, 10);
      p.gold += gold; p.kills++;
      lines.push({ msg: `⚔️ 击败【${s.enemy.name}】，获得 ${exp}经验 / ${gold}金币。`, cls: 'good' });
      gainExp(p, exp, lines);
      if (Math.random() < 0.35) {
        const eq = makeEquip(p.dim, p.level, s.regionTier >= 3 ? 1 : 0);
        p.bag.push(eq);
        lines.push({ msg: `🎁 掉落装备【${eq.name}】！`, cls: 'drop' });
      }
    } else {
      const lost = Math.floor(p.gold * 0.1);
      p.gold -= lost;
      lines.push({ msg: `💀 被【${s.enemy.name}】击败，重伤逃回，丢失${lost}金币。`, cls: 'bad' });
    }
  } else if (s.kind === 'pvp') {
    const victim = world.players[s.victimUser];
    if (win) {
      p.pvpWins++;
      world.dims[p.dim].merit++;
      pvpShield.set(s.victimUser, now());
      let lootGold = 0, lootItem = null;
      if (victim) {
        lootGold = Math.min(victim.gold, 30 + victim.level * 12 + rnd(0, 30));
        victim.gold -= lootGold;
        if (victim.bag.length > 0 && Math.random() < 0.6) {
          const idx = rnd(0, victim.bag.length - 1);
          lootItem = victim.bag.splice(idx, 1)[0];
          p.bag.push(lootItem);
        }
        victim.pvpLosses++;
        mail(victim, `🩸 你在重叠区被【${dimById(p.dim).name}】的降临者【${p.name}】击败，被掠夺${lootGold}金币${lootItem ? `和【${lootItem.name}】` : ''}！（30分钟内受世界意志保护）`);
      }
      p.gold += lootGold;
      gainExp(p, 40 + s.enemy.level * 14, lines);
      lines.push({ msg: `🏆 击杀敌方降临者【${s.enemy.name}】！掠夺其${lootGold}金币${lootItem ? `，缴获【${lootItem.name}】` : ''}！本方战意+1`, cls: 'good' });
      worldLog(`⚡ 重叠区战报：【${dimById(p.dim).name}】${p.name} 击败了 【${dimById(s.victimDim).name}】${s.enemy.name}！`, '');
    } else {
      const lost = Math.floor(p.gold * 0.2);
      p.gold -= lost;
      if (victim) {
        victim.gold += lost;
        victim.pvpWins++;
        world.dims[victim.dim].merit++;
        mail(victim, `🛡️ 你的化身在重叠区击退了【${dimById(p.dim).name}】的入侵者【${p.name}】，夺得${lost}金币！本方战意+1`);
      }
      lines.push({ msg: `💀 不敌【${s.enemy.name}】，被掠夺${lost}金币，狼狈逃离重叠区。`, cls: 'bad' });
    }
  }
  markDirty();
  send(ws, { t: 'combatEnd', win, lines, you: youSnapshot(p) });
}

/* ============================================================
 * 探索 / 遭遇
 * ============================================================ */
function hunt(p, ws, regionIdx) {
  if (sessions.has(p.user)) return send(ws, { t: 'error', msg: '你正在战斗中' });
  if (world.finished) return send(ws, { t: 'error', msg: '本赛季已落幕，等待新赛季开启' });
  touchPlayer(p);
  if (p.energy < 1) return send(ws, { t: 'error', msg: '体力不足，每3分钟恢复1点' });
  const dim = dimById(p.dim);
  const region = dim.regions[regionIdx];
  if (!region) return send(ws, { t: 'error', msg: '无效区域' });
  p.energy--;
  if (p.energy === ENERGY_CAP - 1) p.energyTs = now();
  markDirty();

  const inWar = world.nextWar && (world.nextWar.a === p.dim || world.nextWar.b === p.dim);
  const isOverlap = inWar && world.overlapRegions.includes(regionIdx);

  if (isOverlap && Math.random() < 0.6) {
    const enemyDimId = world.nextWar.a === p.dim ? world.nextWar.b : world.nextWar.a;
    const victim = pickVictim(p, enemyDimId);
    if (victim) return startPvp(p, ws, victim, enemyDimId);
    // 没有可掠夺的真实玩家 → 遭遇敌方次元的游荡者(NPC)
    return startWandererFight(p, ws, enemyDimId);
  }

  // 同次元玩家相遇（不可战斗）
  if (Math.random() < 0.1) {
    const mates = playersInDim(p.dim).filter((x) => x.user !== p.user);
    const mate = mates.length ? pick(mates) : null;
    const gift = rnd(5, 15) + p.level * 2;
    p.gold += gift;
    markDirty();
    send(ws, { t: 'event', msg: mate
      ? `🤝 在${region.name}遇到同次元玩家【${mate.name}】(Lv.${mate.level})。世界规则禁止同次元相残，你们交换情报，获得${gift}金币。`
      : `🤝 在${region.name}遇到一位同次元修行者。世界规则禁止同次元相残，你们交换情报，获得${gift}金币。` });
    return send(ws, { t: 'you', you: youSnapshot(p) });
  }

  // 普通打怪
  const mLvl = Math.max(1, region.tier * 3 - 2 + rnd(0, 2) + Math.floor((weekNo() - 1) * 1.5));
  startCombat(p, ws, {
    name: pick(region.monsters), level: mLvl,
    hp: 45 + mLvl * 16, maxHp: 45 + mLvl * 16,
    atk: 7 + mLvl * 3, def: 2 + mLvl * 1.4,
  }, 'pve', { regionTier: region.tier, title: `🗺️ ${region.name}（怪物等级 Lv.${mLvl}）` });
}

function pickVictim(p, enemyDimId) {
  const t = now();
  const candidates = playersInDim(enemyDimId).filter((v) => {
    if ((pvpShield.get(v.user) || 0) + PVP_SHIELD_MS > t) return false;
    if ((pvpPairLock.get(p.user + ':' + v.user) || 0) + PVP_PAIR_LOCK_MS > t) return false;
    return true;
  });
  if (!candidates.length) return null;
  // 优先选等级相近的
  candidates.sort((x, y) => Math.abs(x.level - p.level) - Math.abs(y.level - p.level));
  return pick(candidates.slice(0, 5));
}

function startPvp(p, ws, victim, enemyDimId) {
  pvpPairLock.set(p.user + ':' + victim.user, now());
  touchPlayer(victim);
  const vst = playerStats(victim);
  const online = userConn.has(victim.user) ? '（在线）' : '';
  startCombat(p, ws, {
    name: victim.name, level: victim.level, isPlayer: true,
    hp: vst.maxHp, maxHp: vst.maxHp, atk: vst.atk, def: vst.def,
  }, 'pvp', {
    victimUser: victim.user, victimDim: enemyDimId,
    title: `🌀 重叠区遭遇战 — ${dimById(enemyDimId).icon}${dimById(enemyDimId).name}玩家${online}`,
  });
}

function startWandererFight(p, ws, enemyDimId) {
  const eDim = dimById(enemyDimId);
  const lvl = Math.max(1, p.level + rnd(-2, 2));
  startCombat(p, ws, {
    name: `${eDim.name}游荡者`, level: lvl, isPlayer: true,
    hp: 90 + lvl * 20, maxHp: 90 + lvl * 20,
    atk: 9 + lvl * 3.6, def: 3 + lvl * 1.8,
  }, 'pve', { regionTier: 2, title: `🌀 重叠区 — 遭遇${eDim.icon}${eDim.name}的游荡者` });
}

/* ============================================================
 * 快照
 * ============================================================ */
function youSnapshot(p) {
  touchPlayer(p);
  const st = playerStats(p);
  const dim = dimById(p.dim);
  return {
    user: p.user, name: p.name, dim: p.dim,
    level: p.level, exp: p.exp, expNeed: expNeed(p.level),
    gold: p.gold, hp: curHp(p), maxHp: st.maxHp, atk: st.atk, def: st.def,
    energy: p.energy, energyCap: ENERGY_CAP,
    power: playerPower(p), willBuff: p.willBuff,
    invites: p.invites, inviteCode: p.inviteCode,
    equip: p.equip, bag: p.bag,
    skills: dim.skills.map((s) => ({ name: s.name, desc: s.desc, lvl: s.lvl, unlocked: s.lvl <= p.level })),
    kills: p.kills, pvpWins: p.pvpWins, pvpLosses: p.pvpLosses, rebirths: p.rebirths,
    mail: p.mail,
  };
}

function worldSnapshot() {
  return {
    season: world.season, day: world.day,
    dayOfWeek: dayOfWeek(), week: weekNo(),
    nextDayAt: world.lastTickAt + DAY_MS,
    warDay: WAR_DAY, overlapStartDay: OVERLAP_START_DAY,
    nextWar: world.nextWar, overlapRegions: world.overlapRegions,
    finished: world.finished, champion: world.champion,
    onlineCount: userConn.size,
    dims: DIMENSIONS.map((d) => {
      const info = world.dims[d.id];
      const players = playersInDim(d.id);
      return {
        id: d.id, alive: info.alive, wins: info.wins, merit: info.merit,
        players: players.length,
        online: players.filter((p) => userConn.has(p.user)).length,
        power: info.alive ? dimPower(d.id) : 0,
      };
    }),
    logs: world.logs.slice(0, 60),
  };
}

function leaderboard() {
  return Object.values(world.players)
    .map((p) => ({ name: p.name, dim: p.dim, level: p.level, power: playerPower(p), pvpWins: p.pvpWins, online: userConn.has(p.user) }))
    .sort((a, b) => b.power - a.power)
    .slice(0, 15);
}

/* ============================================================
 * 网络层
 * ============================================================ */
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/game', express.static(path.join(__dirname, 'game')));
app.get('/health', (_, res) => res.json({ ok: true, season: world.season, day: world.day, players: Object.keys(world.players).length, online: userConn.size }));

/* 管理接口：手动推进游戏日（需 ADMIN_KEY），便于测试大战流程 */
app.get('/admin/tick', (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  tick();
  res.json({ ok: true, season: world.season, day: world.day, dayOfWeek: dayOfWeek(), nextWar: world.nextWar, finished: world.finished });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const connUser = new Map();  // ws -> user
const userConn = new Map();  // user -> ws（单点登录）

function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj) { for (const ws of connUser.keys()) send(ws, obj); }
function broadcastWorld() { broadcast({ t: 'world', world: worldSnapshot() }); }

function bindUser(ws, p) {
  const old = userConn.get(p.user);
  if (old && old !== ws) { send(old, { t: 'error', msg: '账号在其他地方登录' }); old.close(); }
  connUser.set(ws, p.user);
  userConn.set(p.user, ws);
  p.lastSeen = now();
  send(ws, { t: 'auth', token: p.token, you: youSnapshot(p), world: worldSnapshot() });
  broadcastWorld(); // 在线人数变化
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    try { handle(ws, m); } catch (e) { console.error('[handle]', e); send(ws, { t: 'error', msg: '服务器内部错误' }); }
  });
  ws.on('close', () => {
    const user = connUser.get(ws);
    connUser.delete(ws);
    if (user && userConn.get(user) === ws) {
      userConn.delete(user);
      sessions.delete(user); // 掉线视为脱离战斗
      const p = world.players[user];
      if (p) { p.lastSeen = now(); markDirty(); }
      broadcastWorld();
    }
  });
});

function handle(ws, m) {
  const user = connUser.get(ws);
  const p = user ? world.players[user] : null;

  switch (m.t) {
    case 'register': {
      const u = String(m.user || '').trim().toLowerCase();
      const pass = String(m.pass || '');
      const name = String(m.name || '').trim().slice(0, 12) || u;
      if (!/^[a-z0-9_]{3,20}$/.test(u)) return send(ws, { t: 'error', msg: '账号需为3~20位字母/数字/下划线' });
      if (pass.length < 6) return send(ws, { t: 'error', msg: '密码至少6位' });
      if (world.players[u]) return send(ws, { t: 'error', msg: '账号已存在' });

      let dimId = m.dim, inviter = null;
      const code = String(m.invite || '').trim().toUpperCase();
      if (code) {
        inviter = Object.values(world.players).find((x) => x.inviteCode === code);
        if (!inviter) return send(ws, { t: 'error', msg: '邀请码无效' });
        dimId = inviter.dim; // 受邀者降临邀请人所在世界
      }
      if (!dimById(dimId)) return send(ws, { t: 'error', msg: '请选择降临次元' });
      if (!world.dims[dimId].alive) return send(ws, { t: 'error', msg: '该次元已淹灭，请选择其他次元' });

      const np = newPlayer(u, pass, name, dimId);
      world.players[u] = np;
      worldLog(`🌟 新的降临者【${np.name}】降临了【${dimById(dimId).name}】！`, 'sys');

      if (inviter) {
        const tier = Math.min(inviter.invites, INVITE_REWARDS.length - 1);
        const rw = INVITE_REWARDS[tier];
        inviter.invites++;
        inviter.gold += rw.gold;
        inviter.willBuff += rw.buff;
        const eq = makeEquip(inviter.dim, inviter.level + 2, rw.minRarity);
        inviter.bag.push(eq);
        mail(inviter, `🎉 好友【${np.name}】通过你的邀请码降临【${dimById(dimId).name}】！${rw.text}，获得【${eq.name}】！`);
        const iws = userConn.get(inviter.user);
        if (iws) send(iws, { t: 'you', you: youSnapshot(inviter) });
      }
      markDirty();
      return bindUser(ws, np);
    }
    case 'login': {
      const u = String(m.user || '').trim().toLowerCase();
      const rec = world.players[u];
      if (!rec) return send(ws, { t: 'error', msg: '账号不存在' });
      const { hash } = hashPass(String(m.pass || ''), rec.auth.salt);
      if (hash !== rec.auth.hash) return send(ws, { t: 'error', msg: '密码错误' });
      rec.token = crypto.randomBytes(24).toString('hex'); // 轮换token
      markDirty();
      return bindUser(ws, rec);
    }
    case 'resume': {
      const rec = Object.values(world.players).find((x) => x.token === m.token);
      if (!rec) return send(ws, { t: 'error', msg: 'TOKEN_INVALID' });
      return bindUser(ws, rec);
    }
  }

  if (!p) return send(ws, { t: 'error', msg: '请先登录' });
  p.lastSeen = now();

  switch (m.t) {
    case 'hunt': return hunt(p, ws, parseInt(m.region, 10));
    case 'act': return combatAct(p, ws, String(m.skill || ''));
    case 'flee': {
      if (sessions.delete(p.user)) send(ws, { t: 'combatEnd', win: false, lines: [{ msg: '🏃 你逃离了战斗。', cls: '' }], you: youSnapshot(p) });
      return;
    }
    case 'equip': {
      if (sessions.has(p.user)) return send(ws, { t: 'error', msg: '战斗中无法更换装备' });
      const idx = p.bag.findIndex((e) => e.id === m.id);
      if (idx < 0) return send(ws, { t: 'error', msg: '物品不存在' });
      const eq = p.bag.splice(idx, 1)[0];
      const old = p.equip[eq.slot];
      p.equip[eq.slot] = eq;
      if (old) p.bag.push(old);
      markDirty();
      return send(ws, { t: 'you', you: youSnapshot(p) });
    }
    case 'sell': {
      const idx = p.bag.findIndex((e) => e.id === m.id);
      if (idx < 0) return send(ws, { t: 'error', msg: '物品不存在' });
      const eq = p.bag.splice(idx, 1)[0];
      const price = Math.round(eq.value * (eq.rarity + 1) * 1.5);
      p.gold += price;
      markDirty();
      send(ws, { t: 'event', msg: `💰 出售【${eq.name}】，获得${price}金币。` });
      return send(ws, { t: 'you', you: youSnapshot(p) });
    }
    case 'chat': {
      const text = String(m.text || '').trim().slice(0, 200);
      if (!text) return;
      const entry = { from: p.name, dim: p.dim, text, ts: now() };
      for (const [u2, ws2] of userConn) {
        const p2 = world.players[u2];
        if (p2 && p2.dim === p.dim) send(ws2, { t: 'chat', entry });
      }
      return;
    }
    case 'world': return send(ws, { t: 'world', world: worldSnapshot() });
    case 'you': return send(ws, { t: 'you', you: youSnapshot(p) });
    case 'top': return send(ws, { t: 'top', rows: leaderboard() });
  }
}

/* ============================================================
 * 启动
 * ============================================================ */
loadWorld();

setInterval(() => {
  // 补齐错过的游戏日（如服务器重启后）
  let guard = 0;
  while (now() - world.lastTickAt >= DAY_MS && guard++ < 60) tick();
}, 15 * 1000);
setInterval(saveWorld, 30 * 1000);

process.on('SIGINT', () => { dirty = true; saveWorld(); process.exit(0); });
process.on('SIGTERM', () => { dirty = true; saveWorld(); process.exit(0); });

server.listen(PORT, () => {
  console.log(`[server] 次元大战服务端已启动: http://0.0.0.0:${PORT}`);
  console.log(`[server] 游戏日时长: ${DAY_MS / 60000} 分钟（每周第${WAR_DAY}天开战）`);
  if (ADMIN_KEY) console.log('[server] 管理接口已启用: GET /admin/tick?key=***');
});
