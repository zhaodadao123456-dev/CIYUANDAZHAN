/* 深度测试：加点 / 商店买装备穿戴属性变化 / 捕捉宝宝 / 宝宝替主战斗 */
const { spawn } = require('child_process');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = 34568;
// 预置一个5级猎人射手：带技能点和金币
fs.writeFileSync('players.json', JSON.stringify({
  // daily 预置为今日，避免上线签到 +200 金币干扰精确金币断言
  '测试猎人2': { level: 18, exp: 0, gold: 5000, kills: 0, pvpKills: 0, cls: 'ranger', sk: { basic: 1, q: 1, e: 1, r: 1 }, skPts: 4, inv: [], equip: {}, ach: { lv10: 1 }, daily: new Date().toISOString().slice(0, 10) },
}));

const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'pipe'] });
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += d; process.stderr.write('[srv-err] ' + d); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? '✅' : '❌'} ${name} ${extra}`); };

(async () => {
  await sleep(1200);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const msgs = [];
  ws.on('message', (raw) => msgs.push(JSON.parse(raw)));
  ws.on('close', (code) => console.log(`[debug] !!! WS已断开 code=${code} 已收消息=${msgs.length}`));
  ws.on('error', (e) => console.log('[debug] WS错误', e.message));
  const lastYou = () => [...msgs].reverse().find((m) => m.t === 'you');
  const lastSnap = () => [...msgs].reverse().find((m) => m.t === 'snap');
  const lastInv = () => [...msgs].reverse().find((m) => m.t === 'inv');
  const send = (o) => ws.send(JSON.stringify(o));
  await new Promise((r) => ws.on('open', r));
  send({ t: 'join', name: '测试猎人2', dim: 'hunter', cls: 'ranger' });
  await sleep(500);

  let you = lastYou();
  const myId = msgs.find((m) => m.t === 'welcome').id;
  check('预置角色恢复(Lv18/4技能点/5000金)', you.level === 18 && you.skPts === 4 && you.gold === 5000, `lv=${you.level} pts=${you.skPts}`);
  const patk0 = you.patk;

  // 死亡自动复活并回到出生点
  const ensureAlive = async () => {
    const death = [...msgs].reverse().find((m) => (m.t === 'pdie' || m.t === 'prespawn') && m.id === myId);
    if (death && death.t === 'pdie') {
      await sleep(4500);
      send({ t: 'respawn' });
      await sleep(500);
      pos = { x: 0, z: 0 };
      return true;
    }
    return false;
  };

  // 1. 技能加点 ×2
  send({ t: 'sklvl', k: 'basic' });
  await sleep(150);
  send({ t: 'sklvl', k: 'basic' });
  await sleep(300);
  you = lastYou();
  check('技能加点生效(普攻Lv3,剩2点)', you.sk.basic === 3 && you.skPts === 2, `basic=${you.sk.basic} pts=${you.skPts}`);

  // 2. 商店买武器并装备 → 物攻提升
  send({ t: 'buy', id: 's_weapon_1' });   // 稀有武器 900金
  await sleep(300);
  let inv = lastInv();
  check('购买入背包+扣金币', inv && inv.inv.length === 1 && inv.gold === 4100, inv && `gold=${inv.gold}`);
  send({ t: 'equip', i: 0 });
  await sleep(300);
  inv = lastInv(); you = lastYou();
  check('穿戴武器+物攻提升', inv.equip.weapon && you.patk > patk0, `patk ${patk0}→${you.patk}`);

  // 2.5 强化已装备武器（+0→+1 必成）→ 物攻进一步提升、金币扣减
  const patkEq = you.patk, goldB = you.gold;
  send({ t: 'enhance', slot: 'weapon' });
  await sleep(300);
  inv = lastInv(); you = lastYou();
  check('装备强化(+1)生效', inv.equip.weapon.enh === 1 && you.patk > patkEq && you.gold < goldB,
    `enh=${inv.equip.weapon.enh} patk ${patkEq}→${you.patk} gold ${goldB}→${you.gold}`);

  // 2.6 装备成就（lv10「次元强者」攻击+7%）→ 物攻提升；卸下还原
  const patkBefore = lastYou().patk;
  send({ t: 'achequip', id: 'lv10' });
  await sleep(250);
  const patkAch = lastYou().patk;
  check('装备成就增益生效(攻击+7%)', patkAch > patkBefore, `patk ${patkBefore}→${patkAch}`);
  send({ t: 'achequip', id: 'lv10' });   // 再次=卸下
  await sleep(250);
  check('卸下成就还原属性', lastYou().patk === patkBefore, `patk=${lastYou().patk}`);

  // 3. 走向最近的T1怪并打残
  let snap = lastSnap();
  let pos = { x: 0, z: 0 };
  const isDead = () => {
    const last = [...msgs].reverse().find((m) => (m.t === 'pdie' || m.t === 'prespawn') && m.id === myId);
    return !!(last && last.t === 'pdie');
  };
  // 选"落单"的T1怪：离其他怪越远越好，避免被围殴
  const targetOf = () => {
    const s = lastSnap();
    let best = null, bestIso = -1;
    for (const m of s.ms) {
      if (m[7] !== 1 || m[4] === 'dead') continue;
      let iso = 1e9;
      for (const o of s.ms) {
        if (o === m || o[4] === 'dead') continue;
        iso = Math.min(iso, (m[1] - o[1]) ** 2 + (m[2] - o[2]) ** 2);
      }
      if (iso > bestIso) { bestIso = iso; best = m; }
    }
    return best;
  };
  let mo = targetOf();
  const approach = async (tx, tz, until = 2.5) => {
    for (let i = 0; i < 300 && Math.hypot(tx - pos.x, tz - pos.z) > until; i++) {
      if (isDead()) return;
      const d = Math.hypot(tx - pos.x, tz - pos.z);
      pos.x += (tx - pos.x) / d * 0.7; pos.z += (tz - pos.z) / d * 0.7;
      send({ t: 'mv', x: pos.x, z: pos.z, ry: 0, anim: 'run' });
      await sleep(35);
    }
  };
  await approach(mo[1], mo[2]);

  // 打到40%血以下再捕捉（每发重新瞄准）
  let captured = false;
  for (let i = 0; i < 40 && !captured; i++) {
    if (await ensureAlive()) { mo = targetOf(); if (mo) await approach(mo[1], mo[2]); continue; }
    const s = lastSnap();
    const cur = s.ms.find((m) => m[0] === mo[0]);
    if (!cur || cur[4] === 'dead') { mo = targetOf(); if (!mo) break; await approach(mo[1], mo[2]); continue; }
    const ratio = cur[5] / cur[6];
    const distNow = Math.hypot(cur[1] - pos.x, cur[2] - pos.z);
    console.log(`[debug] i=${i} 目标=${cur[8]} hp=${cur[5]}/${cur[6]}(${Math.round(ratio * 100)}%) 距离=${distNow.toFixed(1)}`);
    if (i === 3) {
      const dump = await fetch(`http://127.0.0.1:${PORT}/debug/room/hunter`).then((r) => r.json());
      console.log('[debug] 服务端玩家:', JSON.stringify(dump.players));
      console.log('[debug] 服务端目标怪:', JSON.stringify(dump.monsters.find((m) => m.id === cur[0])));
    }
    if (distNow > 6) { await approach(cur[1], cur[2]); continue; }
    if (ratio <= 0.38) {
      send({ t: 'capture' });
      await sleep(600);
      const feeds = msgs.filter((m) => m.t === 'feed' && m.msg.includes('成功捕捉'));
      if (feeds.length) { captured = true; break; }
      await sleep(2600);   // 捕捉失败等冷却
    } else {
      const dl = Math.hypot(cur[1] - pos.x, cur[2] - pos.z) || 1;
      send({ t: 'cast', k: 'basic', dx: (cur[1] - pos.x) / dl, dz: (cur[2] - pos.z) / dl });
      await sleep(750);
    }
  }
  if (!captured) console.log('[debug] err/feed:', JSON.stringify(msgs.filter((m) => m.t === 'err' || m.t === 'feed').slice(-8)));
  check('捕捉宝宝成功', captured);
  await sleep(500);
  snap = lastSnap();
  check('快照出现宝宝实体', snap.pets.length === 1, snap.pets.length && `宝宝=${snap.pets[0][8]} T${snap.pets[0][1]}`);

  // 4. 宝宝替主人战斗：走到下一只怪旁，主人不出手，看宝宝是否打出伤害
  mo = targetOf();
  if (mo) {
    await approach(mo[1], mo[2], 5);
    const before = msgs.length;
    await sleep(4000);
    const petDmg = msgs.slice(before).find((m) => m.t === 'dmg' && m.kind === 'm');
    check('宝宝自动攻击野怪(主人未出手)', !!petDmg, petDmg && `宝宝伤害=${petDmg.amt}`);
  }

  // 5. 存档校验：宝宝写入持久化
  send({ t: 'mv', x: pos.x, z: pos.z, ry: 0, anim: 'idle' });
  await sleep(200);
  ws.close();
  await sleep(31500);   // 等定时落盘（30s）
  const savedData = JSON.parse(fs.readFileSync('players.json', 'utf8'));
  const rec = savedData['测试猎人2'];
  check('存档含宝宝/装备/技能等级', !!(rec && rec.pet && rec.equip.weapon && rec.sk.basic === 3), rec && rec.pet && `宝宝=${rec.pet.name}`);

  check('服务器无异常输出', !srvErr.includes('Error'));
  const fail = results.filter(([, ok]) => !ok).length;
  console.log(`\n========= 深度测试: ${results.length - fail}/${results.length} 通过 =========`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
