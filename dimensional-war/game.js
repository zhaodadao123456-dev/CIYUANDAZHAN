/* ============================================================
 * 次元大战 - 核心游戏逻辑
 * ============================================================ */

const SAVE_KEY = 'dimensional-war-save-v1';
const AP_PER_DAY = 5;          // 每天行动点
const WAR_DAY = 7;             // 每周第7天开战
const OVERLAP_START_DAY = 5;   // 每周第5天起出现重叠区

let S = null;        // 全局存档状态
let combatCtx = null; // 当前战斗上下文

/* ---------- 工具 ---------- */
const $ = (id) => document.getElementById(id);
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const dimById = (id) => DIMENSIONS.find((d) => d.id === id);

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

/* ---------- 装备 ---------- */
function makeEquip(dimId, level, minRarity = 0) {
  const dim = dimById(dimId);
  const slot = pick(SLOTS);
  const rIdx = rollRarity(minRarity);
  const r = RARITIES[rIdx];
  const namePool = slot.key === 'weapon' ? dim.weaponNames : slot.key === 'armor' ? dim.armorNames : dim.accNames;
  const base = slot.stat === 'hp' ? 20 + level * 8 : 4 + level * 2;
  return {
    id: Date.now() + Math.random(),
    name: `${r.name}·${pick(namePool)}`,
    slot: slot.key,
    stat: slot.stat,
    value: Math.round(base * r.mult * (0.9 + Math.random() * 0.2)),
    rarity: rIdx,
    dim: dimId,
  };
}

function equipScore(p) {
  let s = 0;
  for (const slot of SLOTS) {
    const e = p.equip[slot.key];
    if (e) s += e.stat === 'hp' ? e.value / 4 : e.value;
  }
  return Math.round(s);
}

/* ---------- 玩家属性 ---------- */
function playerStats() {
  const p = S.player;
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

function playerPower() {
  return Math.round(S.player.level * 20 + equipScore(S.player) + S.player.willBuff * 200);
}

function expNeed(lvl) { return 50 + (lvl - 1) * 45; }

function gainExp(n) {
  const p = S.player;
  p.exp += n;
  let leveled = false;
  while (p.exp >= expNeed(p.level)) {
    p.exp -= expNeed(p.level);
    p.level++;
    leveled = true;
    const newSkill = dimById(p.dim).skills.find((s) => s.lvl === p.level);
    log(`🆙 升级到 Lv.${p.level}！`, 'good');
    if (newSkill) log(`✨ 领悟新技能【${newSkill.name}】：${newSkill.desc}`, 'good');
  }
  if (leveled) S.player.hp = playerStats().maxHp; // 升级回满
}

function unlockedSkills() {
  return dimById(S.player.dim).skills.filter((s) => s.lvl <= S.player.level);
}

/* ---------- 存档 ---------- */
function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch (e) {} }
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function resetGame() {
  if (!confirm('确定要放弃当前进度，重新开始吗？')) return;
  localStorage.removeItem(SAVE_KEY);
  location.reload();
}

/* ---------- 新游戏 ---------- */
function newGame(dimId, name) {
  const dims = {};
  for (const d of DIMENSIONS) {
    dims[d.id] = {
      alive: true,
      wins: 0,
      npcs: Array.from({ length: 30 }, () => ({
        name: pick(d.playerNames) + '·' + rnd(1, 999),
        level: rnd(1, 3),
      })),
    };
  }
  S = {
    player: {
      name: name || '降临者',
      dim: dimId,
      level: 1, exp: 0, gold: 50, hp: 0,
      equip: { weapon: null, armor: null, acc: null },
      bag: [],
      willBuff: 0,        // 世界意志永久加成
      invites: 0,
      kills: 0, pvpWins: 0, rebirths: 0,
    },
    day: 1,
    ap: AP_PER_DAY,
    dims,
    nextWar: null,        // {a, b}
    overlapRegions: [],   // 本周重叠区索引
    finished: false,
    logs: [],
  };
  S.player.hp = playerStats().maxHp;
  scheduleNextWar();
  log(`🌌 你作为降临者来到了【${dimById(dimId).name}】！世界意志低语：第${WAR_DAY}天将开启次元大战，变强吧！`, 'sys');
  log(`📜 规则：同次元玩家受世界规则保护无法互相战斗；大战前夕(第${OVERLAP_START_DAY}~${WAR_DAY - 1}天)随机区域将与敌对次元重叠。`, 'sys');
  showGame();
}

/* ---------- 日志 ---------- */
function log(msg, cls = '') {
  S.logs.unshift({ msg, cls, day: S.day });
  if (S.logs.length > 80) S.logs.pop();
  renderLog();
}

/* ---------- 时间系统 ---------- */
function dayOfWeek() { return ((S.day - 1) % 7) + 1; }
function weekNo() { return Math.floor((S.day - 1) / 7) + 1; }
function aliveDims() { return DIMENSIONS.filter((d) => S.dims[d.id].alive); }

function scheduleNextWar() {
  const alive = aliveDims();
  if (alive.length < 2) { S.nextWar = null; return; }
  const shuffled = [...alive].sort(() => Math.random() - 0.5);
  S.nextWar = { a: shuffled[0].id, b: shuffled[1].id };
  S.overlapRegions = [];
  const aName = dimById(S.nextWar.a).name, bName = dimById(S.nextWar.b).name;
  log(`⚡ 世界意志公告：第${weekNo()}周次元大战对阵——【${aName}】 VS 【${bName}】！`, 'warn');
}

function playerInWar() {
  return S.nextWar && (S.nextWar.a === S.player.dim || S.nextWar.b === S.player.dim);
}
function enemyWarDim() {
  if (!playerInWar()) return null;
  return S.nextWar.a === S.player.dim ? S.nextWar.b : S.nextWar.a;
}

function nextDay() {
  if (S.finished) return;
  // 第7天点击按钮 = 开启次元大战
  if (dayOfWeek() === WAR_DAY && S.nextWar) { startWar(); return; }

  S.day++;
  S.ap = AP_PER_DAY;
  S.player.hp = playerStats().maxHp; // 每日休整回满
  npcDailyGrowth();

  const dow = dayOfWeek();
  if (dow === OVERLAP_START_DAY && S.nextWar) {
    // 随机两个区域成为重叠区
    const idxs = [0, 1, 2, 3].sort(() => Math.random() - 0.5).slice(0, 2);
    S.overlapRegions = idxs;
    const aName = dimById(S.nextWar.a).name, bName = dimById(S.nextWar.b).name;
    log(`🌀 次元壁垒松动！【${aName}】与【${bName}】的部分地图区域开始重叠，双方降临者将在重叠区相遇！`, 'warn');
    if (playerInWar()) log(`⚠️ 你所在的次元即将参战！进入🌀重叠区可猎杀敌方玩家，夺取金钱与装备！`, 'warn');
  }
  if (dow === WAR_DAY) log(`🔥 次元大战之日已至！点击「开启次元大战」按钮决一死战！`, 'warn');
  save();
  renderAll();
}

function npcDailyGrowth() {
  for (const d of aliveDims()) {
    for (const npc of S.dims[d.id].npcs) {
      if (Math.random() < 0.6) npc.level += 1;
    }
  }
}

function dimPower(dimId) {
  const info = S.dims[dimId];
  let p = info.npcs.reduce((s, n) => s + n.level * 10, 0);
  p *= 1 + info.wins * 0.1; // 胜场加成
  if (dimId === S.player.dim) p += playerPower() * 3;
  return Math.round(p);
}

/* ---------- 探索/打怪 ---------- */
function hunt(regionIdx) {
  if (S.finished) return;
  if (S.ap <= 0) { log('💤 今日行动点已用尽，请进入下一天休整。', ''); renderAll(); return; }
  if (S.player.hp <= 1) { log('🩸 你重伤未愈，请进入下一天休整。', ''); renderAll(); return; }
  S.ap--;

  const isOverlap = playerInWar() && S.overlapRegions.includes(regionIdx);
  if (isOverlap && Math.random() < 0.55) { encounterEnemyPlayer(regionIdx); return; }

  // 同次元玩家相遇事件（不可战斗）
  if (Math.random() < 0.12) {
    const friend = pick(dimById(S.player.dim).playerNames) + '·' + rnd(1, 999);
    const gift = rnd(5, 15) + S.player.level * 2;
    S.player.gold += gift;
    log(`🤝 在野外遇到同次元玩家【${friend}】。世界规则禁止同次元相残，你们交换情报，获得${gift}金币。`, 'good');
    save(); renderAll();
    return;
  }

  startMonsterFight(regionIdx);
}

function startMonsterFight(regionIdx) {
  const dim = dimById(S.player.dim);
  const region = dim.regions[regionIdx];
  const mLvl = Math.max(1, region.tier * 3 - 2 + rnd(0, 2) + Math.floor((weekNo() - 1) * 1.5));
  const enemy = {
    name: pick(region.monsters),
    level: mLvl,
    hp: 45 + mLvl * 16, maxHp: 45 + mLvl * 16,
    atk: 7 + mLvl * 3, def: 2 + mLvl * 1.4,
  };
  startCombat(enemy, `🗺️ ${region.name}（怪物等级 Lv.${mLvl}）`, (win) => {
    if (win) {
      const exp = 25 + mLvl * 12;
      const gold = 12 + mLvl * 6 + rnd(0, 10);
      S.player.gold += gold;
      S.player.kills++;
      log(`⚔️ 击败【${enemy.name}】Lv.${mLvl}，获得 ${exp}经验 / ${gold}金币。`, 'good');
      gainExp(exp);
      if (Math.random() < 0.35) {
        const eq = makeEquip(S.player.dim, S.player.level, region.tier >= 3 ? 1 : 0);
        S.player.bag.push(eq);
        log(`🎁 怪物掉落装备【${eq.name}】(${SLOTS.find(s=>s.key===eq.slot).name} +${eq.value}${eq.stat==='hp'?'生命':eq.stat==='atk'?'攻击':'防御'})`, 'drop');
      }
    } else {
      const lost = Math.floor(S.player.gold * 0.1);
      S.player.gold -= lost;
      log(`💀 被【${enemy.name}】击败，重伤逃回，丢失${lost}金币。`, 'bad');
    }
    save(); renderAll();
  });
}

/* ---------- 重叠区 PvP ---------- */
function encounterEnemyPlayer(regionIdx) {
  const eDimId = enemyWarDim();
  const eDim = dimById(eDimId);
  const lvl = Math.max(1, S.player.level + rnd(-2, 2));
  const enemy = {
    name: pick(eDim.playerNames) + '·' + rnd(1, 999),
    level: lvl, isPlayer: true, dimId: eDimId,
    hp: 90 + lvl * 20, maxHp: 90 + lvl * 20,
    atk: 9 + lvl * 3.6, def: 3 + lvl * 1.8,
  };
  log(`🌀 重叠区中你遭遇了【${eDim.name}】的降临者【${enemy.name}】Lv.${lvl}！次元之敌，不死不休！`, 'warn');
  startCombat(enemy, `🌀 重叠区遭遇战 — ${eDim.icon} ${eDim.name}玩家`, (win) => {
    if (win) {
      const loot = 40 + lvl * 16 + rnd(0, 30);
      S.player.gold += loot;
      S.player.pvpWins++;
      gainExp(40 + lvl * 14);
      log(`🏆 击杀敌方玩家【${enemy.name}】！掠夺其${loot}金币。`, 'good');
      if (Math.random() < 0.65) {
        const eq = makeEquip(eDimId, lvl, 1);
        S.player.bag.push(eq);
        log(`💰 缴获敌方装备【${eq.name}】！(异次元装备同样可用)`, 'drop');
      }
    } else {
      const lost = Math.floor(S.player.gold * 0.2);
      S.player.gold -= lost;
      log(`💀 不敌【${enemy.name}】，被掠夺${lost}金币，狼狈逃离重叠区。`, 'bad');
    }
    save(); renderAll();
  });
}

/* ---------- 回合制战斗 ---------- */
function startCombat(enemy, title, onEnd) {
  combatCtx = { enemy, onEnd, cds: {}, stunned: 0, over: false };
  $('combat-title').textContent = title;
  $('combat-log').innerHTML = '';
  $('combat-modal').classList.remove('hidden');
  combatLog(`遭遇 ${enemy.name}（Lv.${enemy.level}）！战斗开始！`);
  renderCombat();
}

function combatLog(msg, cls = '') {
  const el = document.createElement('div');
  el.className = 'clog ' + cls;
  el.textContent = msg;
  $('combat-log').prepend(el);
}

function renderCombat() {
  if (!combatCtx) return;
  const st = playerStats();
  const p = S.player, e = combatCtx.enemy;
  $('cb-pname').textContent = `${p.name} Lv.${p.level}`;
  $('cb-ename').textContent = `${e.name} Lv.${e.level}`;
  $('cb-php').style.width = Math.max(0, (p.hp / st.maxHp) * 100) + '%';
  $('cb-ehp').style.width = Math.max(0, (e.hp / e.maxHp) * 100) + '%';
  $('cb-php-t').textContent = `${Math.max(0, Math.round(p.hp))}/${st.maxHp}`;
  $('cb-ehp-t').textContent = `${Math.max(0, Math.round(e.hp))}/${e.maxHp}`;

  const box = $('combat-actions');
  box.innerHTML = '';
  if (combatCtx.over) return;
  const atkBtn = document.createElement('button');
  atkBtn.className = 'btn skill-btn';
  atkBtn.textContent = '🗡️ 普通攻击';
  atkBtn.onclick = () => playerAct({ type: 'dmg', mult: 1.0, name: '普通攻击', cd: 0 });
  box.appendChild(atkBtn);
  for (const sk of unlockedSkills()) {
    const b = document.createElement('button');
    b.className = 'btn skill-btn';
    const cd = combatCtx.cds[sk.name] || 0;
    b.textContent = cd > 0 ? `${sk.name} (冷却${cd})` : sk.name;
    b.title = sk.desc;
    b.disabled = cd > 0;
    b.onclick = () => playerAct(sk);
    box.appendChild(b);
  }
}

function dmgCalc(atk, def, mult) {
  const raw = atk * mult * (0.85 + Math.random() * 0.3) - def * 0.5;
  return Math.max(1, Math.round(raw));
}

function playerAct(skill) {
  if (!combatCtx || combatCtx.over) return;
  const st = playerStats();
  const e = combatCtx.enemy;
  // 进入冷却
  if (skill.cd > 0) combatCtx.cds[skill.name] = skill.cd + 1;
  for (const k in combatCtx.cds) if (combatCtx.cds[k] > 0) combatCtx.cds[k]--;

  if (skill.type === 'heal') {
    const heal = Math.round(st.maxHp * skill.pct);
    S.player.hp = Math.min(st.maxHp, S.player.hp + heal);
    combatLog(`✨ 你使用【${skill.name}】，恢复${heal}点生命。`, 'good');
  } else {
    const dmg = dmgCalc(st.atk, e.def, skill.mult);
    e.hp -= dmg;
    combatLog(`⚔️ 你使用【${skill.name}】，对${e.name}造成${dmg}点伤害！`, '');
    if (skill.type === 'stun' && e.hp > 0) {
      combatCtx.stunned = 1;
      combatLog(`💫 ${e.name}被控制，下回合无法行动！`, 'good');
    }
  }

  if (e.hp <= 0) { endCombat(true); return; }
  renderCombat();
  setTimeout(enemyAct, 450);
}

function enemyAct() {
  if (!combatCtx || combatCtx.over) return;
  const e = combatCtx.enemy;
  if (combatCtx.stunned > 0) {
    combatCtx.stunned--;
    combatLog(`💫 ${e.name}无法行动！`, 'good');
    renderCombat();
    return;
  }
  const st = playerStats();
  let mult = 1.0, name = '攻击';
  if (e.isPlayer && Math.random() < 0.3) { mult = 1.5; name = '次元技能'; }
  const dmg = dmgCalc(e.atk, st.def, mult);
  S.player.hp -= dmg;
  combatLog(`🩸 ${e.name}对你发动${name}，造成${dmg}点伤害！`, 'bad');
  if (S.player.hp <= 0) { S.player.hp = 1; endCombat(false); return; }
  renderCombat();
}

function endCombat(win) {
  combatCtx.over = true;
  combatLog(win ? '🎉 战斗胜利！' : '💀 战斗失败……', win ? 'good' : 'bad');
  renderCombat();
  const cb = combatCtx.onEnd;
  setTimeout(() => {
    $('combat-modal').classList.add('hidden');
    combatCtx = null;
    cb(win);
  }, 900);
}

/* ---------- 次元大战 ---------- */
function startWar() {
  const { a, b } = S.nextWar;
  if (playerInWar()) {
    startPlayerWar(a, b);
  } else {
    autoResolveWar(a, b, 0);
    afterWar();
  }
}

/* 玩家参战：连续迎战3名敌方勇士，胜场为本方提供战力加成 */
function startPlayerWar(a, b) {
  const eDimId = enemyWarDim();
  const eDim = dimById(eDimId);
  const champs = [...S.dims[eDimId].npcs].sort((x, y) => y.level - x.level).slice(0, 3);
  let wins = 0, idx = 0;
  S.player.hp = playerStats().maxHp;

  const fightNext = () => {
    if (idx >= champs.length) {
      const bonus = wins * 0.12;
      log(`🛡️ 大战前哨战结束：你击败了${wins}/3名敌方勇士，为本方战力提升${Math.round(bonus * 100)}%！`, wins >= 2 ? 'good' : '');
      autoResolveWar(a, b, S.player.dim === a ? bonus : 0, S.player.dim === b ? bonus : 0);
      afterWar();
      return;
    }
    const c = champs[idx];
    const lvl = Math.max(1, c.level);
    const enemy = {
      name: c.name, level: lvl, isPlayer: true, dimId: eDimId,
      hp: 90 + lvl * 20, maxHp: 90 + lvl * 20,
      atk: 9 + lvl * 3.4, def: 3 + lvl * 1.7,
    };
    idx++;
    S.player.hp = playerStats().maxHp; // 每场前恢复
    startCombat(enemy, `⚔️ 次元大战 第${idx}/3阵 — 迎战${eDim.icon}${eDim.name}勇士`, (win) => {
      if (win) { wins++; gainExp(30 + lvl * 10); }
      fightNext();
    });
  };
  log(`🔥 第${weekNo()}周次元大战爆发！【${dimById(a).name}】 VS 【${dimById(b).name}】！你将代表本次元出战3阵！`, 'warn');
  fightNext();
}

function autoResolveWar(a, b, bonusA = 0, bonusB = 0) {
  let pa = dimPower(a) * (1 + bonusA + (Math.random() * 0.2 - 0.1));
  let pb = dimPower(b) * (1 + bonusB + (Math.random() * 0.2 - 0.1));
  // 玩家参战奖励在 startPlayerWar 中以 bonus 形式叠加到玩家所在方
  const winner = pa >= pb ? a : b;
  const loser = winner === a ? b : a;
  S.lastWar = { winner, loser, pa: Math.round(pa), pb: Math.round(pb), a, b };

  S.dims[winner].wins++;
  S.dims[loser].alive = false;

  const wName = dimById(winner).name, lName = dimById(loser).name;
  log(`🏁 次元大战结果：【${wName}】(战力${Math.round(winner===a?pa:pb)}) 战胜 【${lName}】(战力${Math.round(winner===a?pb:pa)})！【${lName}】次元壁崩塌，归于虚无……`, 'warn');

  // 败方幸存者重生到其他存活次元
  const survivors = S.dims[loser].npcs;
  const alive = aliveDims();
  for (const npc of survivors) {
    const target = pick(alive);
    S.dims[target.id].npcs.push(npc);
  }
  S.dims[loser].npcs = [];
  log(`🌱 【${lName}】的${survivors.length}名降临者被世界意志接引，重生于其余次元。`, 'sys');
}

function afterWar() {
  const { winner, loser } = S.lastWar;
  const pDim = S.player.dim;

  if (pDim === winner) {
    // 胜利奖励
    const gold = 300 + weekNo() * 150;
    const eq = makeEquip(pDim, S.player.level + 2, 3);
    S.player.gold += gold;
    S.player.bag.push(eq);
    gainExp(120 + weekNo() * 60);
    log(`🎊 次元大战胜利！世界意志降下嘉奖：${gold}金币、【${eq.name}】，并获得大量经验！本次元晋级下一轮！`, 'good');
  } else if (pDim === loser) {
    // 玩家重生
    const alive = aliveDims();
    const newDim = pick(alive);
    const lostGold = Math.floor(S.player.gold * 0.3);
    S.player.gold -= lostGold;
    S.player.dim = newDim.id;
    S.player.rebirths++;
    S.player.hp = playerStats().maxHp;
    log(`💔 次元大战失败！你的世界崩塌了……世界意志将你接引重生至【${newDim.name}】（损失${lostGold}金币，等级与装备保留，技能体系转换为新次元）。`, 'bad');
    showRebirth(newDim);
  }

  // 大战落幕，进入新的一周
  S.day++;
  S.ap = AP_PER_DAY;
  S.player.hp = playerStats().maxHp;
  npcDailyGrowth();

  // 检查终局
  const alive = aliveDims();
  if (alive.length <= 1) {
    S.finished = true;
    S.nextWar = null;
    const champion = alive[0];
    const playerWon = champion && champion.id === S.player.dim;
    log(playerWon
      ? `👑 【${champion.name}】成为诸天万界最后的胜利者！而你，正是这个次元的传奇！`
      : `👑 【${champion.name}】成为最后的胜利者。你的征程到此为止……`, 'warn');
    showEnding(playerWon, champion);
  } else {
    scheduleNextWar();
  }
  save();
  renderAll();
}

function showRebirth(newDim) {
  $('event-title').textContent = '💫 次元重生';
  $('event-body').innerHTML = `
    <p>你的次元在大战中败亡，次元壁崩塌的瞬间，世界意志将你包裹……</p>
    <p>再睁眼时，你已身处 <b style="color:${newDim.color}">${newDim.icon} ${newDim.name}</b>。</p>
    <p class="dim-desc">${newDim.desc}</p>
    <p>✅ 等级、经验、金币(70%)、装备全部保留<br>✅ 技能体系已转换为新次元的同阶技能</p>`;
  $('event-modal').classList.remove('hidden');
}

function showEnding(playerWon, champion) {
  const p = S.player;
  $('event-title').textContent = playerWon ? '👑 最终胜利！' : '🌑 大战落幕';
  $('event-body').innerHTML = `
    <p>${playerWon
      ? `历经${weekNo()}周血战，<b style="color:${champion.color}">${champion.icon} ${champion.name}</b> 吞并诸天，成为唯一的次元！你作为本次元的降临者，共享至高荣耀！`
      : `【${champion ? champion.name : '???'}】笑到了最后，你的次元已成为历史尘埃。`}</p>
    <p>📊 战绩统计：等级 Lv.${p.level} ｜ 击杀怪物 ${p.kills} ｜ PvP胜场 ${p.pvpWins} ｜ 重生次数 ${p.rebirths} ｜ 邀请好友 ${p.invites}</p>
    <p><button class="btn primary" onclick="resetGame()">🔄 开启新的轮回</button></p>`;
  $('event-modal').classList.remove('hidden');
}

/* ---------- 邀请系统 ---------- */
function genInviteCode() {
  const code = 'DW-' + S.player.dim.toUpperCase().slice(0, 4) + '-' + rnd(1000, 9999);
  $('invite-code').textContent = code;
  $('invite-code-box').classList.remove('hidden');
  log(`📨 已生成邀请码 ${code}，分享给好友即可邀请其降临【${dimById(S.player.dim).name}】！`, 'sys');
  save();
}

/* 演示用：模拟好友通过邀请码加入 */
function friendJoin() {
  if (S.finished) return;
  const p = S.player;
  const dim = dimById(p.dim);
  const tier = Math.min(p.invites, INVITE_REWARDS.length - 1);
  const rw = INVITE_REWARDS[tier];
  p.invites++;
  p.gold += rw.gold;
  p.willBuff += rw.buff;
  const eq = makeEquip(p.dim, p.level + 2, rw.item + 1);
  p.bag.push(eq);
  // 好友成为本次元强力 NPC，提升次元大战战力
  const friend = { name: '好友·' + pick(dim.playerNames), level: Math.max(3, p.level), isFriend: true };
  S.dims[p.dim].npcs.push(friend);
  p.hp = playerStats().maxHp;
  log(`🎉 好友【${friend.name}】通过邀请降临【${dim.name}】！`, 'good');
  log(`🌟 ${rw.text}，获得【${eq.name}】！好友将在次元大战中与你并肩作战！`, 'good');
  save();
  renderAll();
}

/* ---------- 背包/装备 ---------- */
function equipItem(idx) {
  const eq = S.player.bag[idx];
  if (!eq) return;
  const old = S.player.equip[eq.slot];
  S.player.equip[eq.slot] = eq;
  S.player.bag.splice(idx, 1);
  if (old) S.player.bag.push(old);
  const st = playerStats();
  if (S.player.hp > st.maxHp) S.player.hp = st.maxHp;
  log(`🔧 装备了【${eq.name}】。`, '');
  save(); renderAll();
}

function sellItem(idx) {
  const eq = S.player.bag[idx];
  if (!eq) return;
  const price = Math.round(eq.value * (eq.rarity + 1) * 1.5);
  S.player.gold += price;
  S.player.bag.splice(idx, 1);
  log(`💰 出售【${eq.name}】，获得${price}金币。`, '');
  save(); renderAll();
}

/* ---------- 渲染 ---------- */
function showGame() {
  $('screen-select').classList.add('hidden');
  $('screen-game').classList.remove('hidden');
  renderAll();
}

function renderAll() {
  renderHeader(); renderChar(); renderMap(); renderDims(); renderLog(); renderInvite();
}

function renderHeader() {
  const dim = dimById(S.player.dim);
  $('hud-dim').innerHTML = `<span style="color:${dim.color}">${dim.icon} ${dim.name}</span>`;
  $('hud-day').textContent = `第${weekNo()}周 · 第${dayOfWeek()}天（总第${S.day}天）`;
  $('hud-ap').textContent = `行动点 ${S.ap}/${AP_PER_DAY}`;
  const btn = $('btn-nextday');
  if (S.finished) {
    btn.textContent = '🏁 大战已落幕';
    btn.disabled = true;
  } else if (dayOfWeek() === WAR_DAY && S.nextWar) {
    btn.textContent = '🔥 开启次元大战！';
    btn.classList.add('war-btn');
    btn.disabled = false;
  } else {
    btn.textContent = '🌙 进入下一天';
    btn.classList.remove('war-btn');
    btn.disabled = false;
  }
  if (S.nextWar) {
    const a = dimById(S.nextWar.a), b = dimById(S.nextWar.b);
    const daysLeft = WAR_DAY - dayOfWeek();
    $('hud-war').innerHTML = `⚡ 本周大战：<b style="color:${a.color}">${a.name}</b> VS <b style="color:${b.color}">${b.name}</b>` +
      (daysLeft > 0 ? `（${daysLeft}天后开战）` : '（今日开战！）') +
      (playerInWar() ? ' 🚨你方参战' : '');
  } else {
    $('hud-war').textContent = S.finished ? '👑 诸天归一' : '';
  }
}

function renderChar() {
  const p = S.player, st = playerStats(), dim = dimById(p.dim);
  $('char-info').innerHTML = `
    <div class="char-name">${p.name} <span class="lv">Lv.${p.level}</span></div>
    <div class="bar"><div class="bar-fill hp" style="width:${(p.hp / st.maxHp) * 100}%"></div><span>HP ${Math.round(p.hp)}/${st.maxHp}</span></div>
    <div class="bar"><div class="bar-fill exp" style="width:${(p.exp / expNeed(p.level)) * 100}%"></div><span>EXP ${p.exp}/${expNeed(p.level)}</span></div>
    <div class="stat-row">⚔️攻击 ${st.atk} ｜ 🛡️防御 ${st.def} ｜ 💰金币 ${p.gold}</div>
    <div class="stat-row">🔥战力 ${playerPower()} ｜ 🌟世界意志加成 +${Math.round(p.willBuff * 100)}%</div>`;

  // 装备栏
  let eqHtml = '';
  for (const slot of SLOTS) {
    const e = p.equip[slot.key];
    eqHtml += `<div class="equip-slot">${slot.name}：${e
      ? `<span style="color:${RARITIES[e.rarity].color}">${e.name}</span> (+${e.value}${e.stat==='hp'?'生命':e.stat==='atk'?'攻击':'防御'})`
      : '<span class="dim-text">空</span>'}</div>`;
  }
  $('char-equip').innerHTML = eqHtml;

  // 技能
  $('char-skills').innerHTML = dim.skills.map((sk) =>
    `<div class="skill ${sk.lvl <= p.level ? '' : 'locked'}" title="${sk.desc}">
      ${sk.lvl <= p.level ? '✅' : '🔒'} ${sk.name} <span class="dim-text">(Lv.${sk.lvl})</span>
    </div>`).join('');

  // 背包
  $('char-bag').innerHTML = p.bag.length === 0
    ? '<div class="dim-text">背包空空如也</div>'
    : p.bag.map((e, i) =>
      `<div class="bag-item">
        <span style="color:${RARITIES[e.rarity].color}">${e.name}</span>
        <span class="dim-text">+${e.value}${e.stat==='hp'?'生命':e.stat==='atk'?'攻击':'防御'}</span>
        <button class="mini-btn" onclick="equipItem(${i})">装备</button>
        <button class="mini-btn" onclick="sellItem(${i})">出售</button>
      </div>`).join('');
}

function renderMap() {
  const dim = dimById(S.player.dim);
  const inWar = playerInWar();
  $('map-title').innerHTML = `${dim.icon} ${dim.name} · 地图`;
  $('map-regions').innerHTML = dim.regions.map((r, i) => {
    const overlap = inWar && S.overlapRegions.includes(i);
    const eDim = overlap ? dimById(enemyWarDim()) : null;
    return `<div class="region ${overlap ? 'overlap' : ''}" onclick="hunt(${i})">
      <div class="region-name">${overlap ? '🌀 ' : ''}${r.name} <span class="tier">T${r.tier}</span></div>
      <div class="region-desc dim-text">${overlap
        ? `重叠区！与${eDim.icon}${eDim.name}重叠，可遭遇敌方玩家`
        : `怪物：${r.monsters.join('、')}`}</div>
      <div class="region-hint">点击探索（消耗1行动点）</div>
    </div>`;
  }).join('');
}

function renderDims() {
  $('dims-list').innerHTML = DIMENSIONS.map((d) => {
    const info = S.dims[d.id];
    const isMine = d.id === S.player.dim;
    const inWar = S.nextWar && (S.nextWar.a === d.id || S.nextWar.b === d.id);
    return `<div class="dim-row ${info.alive ? '' : 'dead'} ${isMine ? 'mine' : ''}">
      <span style="color:${d.color}">${d.icon} ${d.name}</span>
      ${isMine ? '<span class="tag mine-tag">我方</span>' : ''}
      ${inWar && info.alive ? '<span class="tag war-tag">参战</span>' : ''}
      ${info.alive
        ? `<span class="dim-text">人口${info.npcs.length + (isMine ? 1 : 0)} · 战力${dimPower(d.id)} · ${info.wins}连胜</span>`
        : '<span class="dim-text">💀 已淹灭</span>'}
    </div>`;
  }).join('');
}

function renderLog() {
  if (!S) return;
  $('log-list').innerHTML = S.logs.map((l) =>
    `<div class="log-item ${l.cls}"><span class="log-day">D${l.day}</span> ${l.msg}</div>`).join('');
}

function renderInvite() {
  $('invite-count').textContent = S.player.invites;
}

/* ---------- 初始化 ---------- */
function renderDimSelect() {
  $('dim-cards').innerHTML = DIMENSIONS.map((d) => `
    <div class="dim-card" style="border-color:${d.color}" onclick="chooseDim('${d.id}')">
      <div class="dim-card-icon">${d.icon}</div>
      <div class="dim-card-name" style="color:${d.color}">${d.name}</div>
      <div class="dim-card-desc">${d.desc}</div>
      <div class="dim-card-skills dim-text">技能：${d.skills.map((s) => s.name).join(' / ')}</div>
    </div>`).join('');
}

function chooseDim(dimId) {
  const name = $('player-name').value.trim() || '降临者';
  newGame(dimId, name);
}

window.addEventListener('load', () => {
  const saved = loadSave();
  if (saved && saved.player) {
    S = saved;
    showGame();
  } else {
    renderDimSelect();
  }
  $('btn-nextday').onclick = nextDay;
  $('event-close').onclick = () => $('event-modal').classList.add('hidden');
});
