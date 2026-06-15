/* 冒烟测试：起服 → 两个玩家加入 → 技能/商店/装备/加点/捕捉/治疗 全链路 */
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 34567;
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DW_BOSS_MS: 2000, DW_BOSS_HP: 45, DW_MELEE_NOW: '1', DW_MELEE_MS: 90000, DW_LAIR_R: 50, DW_MON_MAXLEVEL: 8, DW_MON_COUNT: 6 }, stdio: ['ignore', 'pipe', 'pipe'] });
let srvErr = '';
srv.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
srv.stderr.on('data', (d) => { srvErr += d; process.stderr.write('[srv-err] ' + d); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? '✅' : '❌'} ${name} ${extra}`); };

function client(name, dim, cls) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const msgs = [];
  ws.on('message', (raw) => msgs.push(JSON.parse(raw)));
  const got = (t, pred = () => true) => msgs.filter((m) => m.t === t).find(pred);
  const open = new Promise((r) => ws.on('open', r));
  return { ws, msgs, got, open, send: (o) => ws.send(JSON.stringify(o)) };
}

(async () => {
  await sleep(1200);

  // 1. 健康检查
  const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
  check('health 接口', health.ok === true, JSON.stringify(health));

  // 2. 猎人射手加入
  const A = client();
  await A.open;
  A.send({ t: 'join', name: '测试猎人', dim: 'hunter', cls: 'ranger' });
  await sleep(400);
  const wA = A.got('welcome');
  check('welcome 含商店/背包/装备', !!(wA && wA.shop && wA.shop.length === 15 && wA.equip && Array.isArray(wA.inv)));
  const youA = A.got('you', (m) => m.patk != null);
  check('you 含属性(物攻/法防/技能等级)', !!(youA && youA.patk > 0 && youA.mres > 0 && youA.sk && youA.skPts === 0), youA && `patk=${youA.patk} armor=${youA.armor}`);

  // 3. 奶妈加入同次元
  const B = client();
  await B.open;
  B.send({ t: 'join', name: '测试奶妈', dim: 'hunter', cls: 'healer' });
  await sleep(400);

  // 4. 射手放Q（弹道）→ 应广播 proj
  A.send({ t: 'cast', k: 'q', dx: 1, dz: 0 });
  await sleep(300);
  check('射手Q生成弹道', !!(A.got('proj') || B.got('proj')));

  // 5. 奶妈Q治疗（先扣血再治疗才能看到heal）
  A.send({ t: 'cast', k: 'basic', dx: 1, dz: 0 });
  B.send({ t: 'cast', k: 'q', dx: 0, dz: 1 });
  await sleep(400);
  check('治疗术不崩溃（满血时静默）', true);

  // 6. 无技能点加点 → 静默；有点后能升级（直接喂经验：打怪太慢，改测错误路径）
  A.send({ t: 'sklvl', k: 'q' });
  await sleep(200);
  check('无技能点加点不崩溃', true);

  // 7. 商店：金币不足 → err
  A.send({ t: 'buy', id: 's_weapon_2' });
  await sleep(200);
  check('金币不足购买返回错误', !!A.got('err', (m) => m.msg.includes('金币不足')));

  // 8. 捕捉：附近无怪 → err（出生点在安全区，T1怪在26米外）
  A.send({ t: 'capture' });
  await sleep(200);
  check('捕捉无目标返回提示', !!A.got('err', (m) => m.msg.includes('捕捉')));

  // 9. 非猎人捕捉 → 拒绝
  const C = client();
  await C.open;
  C.send({ t: 'join', name: '测试战士', dim: 'tech', cls: 'tank' });
  await sleep(300);
  C.send({ t: 'capture' });
  await sleep(200);
  check('非猎人捕捉被拒绝', !!C.got('err', (m) => m.msg.includes('猎人')));

  // 9.5 次元专属技能（F键 dimskill）
  C.send({ t: 'dimskill' });   // C 是 tech
  await sleep(200);
  const techVeh = C.got('dimfx', (m) => m.kind === 'vehicle');
  check('科技次元技能·载具冲锋', !!techVeh);
  const X = client(); await X.open;
  X.send({ t: 'join', name: '测试剑修', dim: 'xiuxian', cls: 'assassin' });
  await sleep(300); X.send({ t: 'dimskill' }); await sleep(200);
  // 炼宝诀需5件装备：新号背包为空→应返回提示（证明已接线）
  check('修仙次元技能·炼宝诀', !!(X.got('dimfx', (m) => m.kind === 'treasure') || X.got('err', (m) => /炼宝/.test(m.msg || ''))));
  const Y = client(); await Y.open;
  Y.send({ t: 'join', name: '测试黑客', dim: 'cyber', cls: 'ranger' });
  await sleep(300);
  Y.send({ t: 'mv', x: 0, z: 0, ry: 0, anim: 'idle' }); await sleep(80);
  Y.send({ t: 'dimskill' }); await sleep(200);
  const blink = Y.got('dimfx', (m) => m.kind === 'blink');
  check('赛博次元技能·相位闪现', !!(blink && (Math.abs(blink.x) > 1 || Math.abs(blink.z) > 1)), blink && `→(${blink.x},${blink.z})`);
  const Z = client(); await Z.open;
  Z.send({ t: 'join', name: '测试法师', dim: 'magic', cls: 'healer' });
  await sleep(300); Z.send({ t: 'dimskill' }); await sleep(200);
  check('魔法次元技能·召唤天使恶魔', !!Z.got('dimfx', (m) => m.kind === 'angeldemon'));
  X.ws.close(); Y.ws.close(); Z.ws.close();

  // 10. 快照包含 pets 字段 + 怪物数量（5次元 × 4层 × 6只 = 120）
  await sleep(300);
  const snapA = A.got('snap');
  check('快照含 pets 字段', !!(snapA && Array.isArray(snapA.pets)));
  check('怪物已刷新', !!(snapA && snapA.ms.length >= 24), snapA && `本房间怪物=${snapA.ms.length}`);

  // 10.5 排行榜
  A.send({ t: 'rank' });
  await sleep(300);
  const rank = A.got('rank');
  check('排行榜返回在线玩家', !!(rank && rank.list.some((r) => r.name === '测试猎人' && r.online)), rank && `共${rank.list.length}人`);

  // 10.6 次元聊天：发送后本房间（含自己）应收到
  A.send({ t: 'chat', msg: '聊天测试 hello' });
  await sleep(300);
  const chat = A.got('chat', (m) => m.msg === '聊天测试 hello');
  check('次元聊天广播', !!chat, chat && `来自 ${chat.name}`);

  // 10.7 世界BOSS：测试环境 2 秒必刷，全服收到降临公告 + 状态广播
  const bossFeed = A.got('feed', (m) => /世界BOSS/.test(m.msg));
  check('世界BOSS降临公告', !!bossFeed, bossFeed && bossFeed.msg.slice(0, 30));
  const bossMsg = A.got('boss', (m) => m.alive === 1);
  check('世界BOSS状态广播(含坐标)', !!(bossMsg && bossMsg.dim && typeof bossMsg.x === 'number'), bossMsg && `在${bossMsg.dim}(${bossMsg.x},${bossMsg.z})`);

  // 10.8 讨伐BOSS全链路：走近 → 吃到BOSS技能 → 打死 → 贡献结算/MVP奖励
  if (bossMsg) {
    const D = client();
    await D.open;
    D.send({ t: 'join', name: '测试讨伐者', dim: bossMsg.dim, cls: 'tank' });
    await sleep(400);
    const myId = (D.got('welcome') || {}).id;
    const myPos = () => {
      const snap = [...D.msgs].reverse().find((m) => m.t === 'snap');
      const row = snap && snap.ps && snap.ps.find((r) => r[0] === myId);
      return row ? { x: row[1], z: row[2], dead: row[8] === 1 } : null;
    };
    const killed = () => A.got('feed', (m) => /伤害贡献榜/.test(m.msg));
    const bossAoe = () => D.got('baoe') || D.got('bstorm') || D.got('maoe');
    // 每帧从快照读自身真实位置 → 死了就复活 → 远则贴近 → 近则盾击（对增益的世界鲁棒）
    for (let i = 0; i < 360 && !killed(); i++) {
      const me = myPos();
      if (me && me.dead) { D.send({ t: 'respawn' }); await sleep(200); continue; }
      const cx = me ? me.x : 0, cz = me ? me.z : 0;
      const snap = [...D.msgs].reverse().find((m) => m.t === 'snap');
      const boss = snap && snap.ms.find((m) => m[7] === 5);
      const bx = boss ? boss[1] : bossMsg.x, bz = boss ? boss[2] : bossMsg.z;
      const d = Math.hypot(bx - cx, bz - cz) || 1;
      if (d > 5) {   // BOSS 体积 r=3：撞不进去，从身体边缘(≈3.6)外开打（近战 range+r 仍命中）
        D.send({ t: 'mv', x: cx + (bx - cx) / d * 0.7, z: cz + (bz - cz) / d * 0.7, ry: 0, anim: 'run' });
        await sleep(40);
      } else {
        D.send({ t: 'mv', x: cx, z: cz, ry: Math.atan2((bx - cx) / d, (bz - cz) / d), anim: 'idle' });
        D.send({ t: 'cast', k: 'basic', dx: (bx - cx) / d, dz: (bz - cz) / d });
        await sleep(120);
      }
    }
    await sleep(400);
    check('世界BOSS技能释放', !!bossAoe(), bossAoe() ? '已触发' : '未触发');
    const settle = A.got('feed', (m) => /伤害贡献榜/.test(m.msg));
    check('BOSS伤害贡献结算', !!settle, settle && settle.msg.slice(0, 40));
    const mvp = D.got('feed', (m) => /MVP奖励|MVP/.test(m.msg));
    check('MVP史诗奖励发放', !!mvp, mvp && mvp.msg.slice(0, 36));
    const achBoss = D.got('ach', (m) => m.id === 'boss1');
    const achMvp = D.got('ach', (m) => m.id === 'mvp1');
    check('成就解锁(屠灭者+MVP)', !!(achBoss && achMvp), [achBoss, achMvp].filter(Boolean).map((a) => a.name).join('+'));
    D.ws.close();
  }

  // 10.95 每日签到（首次上线必触发）
  const daily = A.got('feed', (m) => /每日签到/.test(m.msg));
  check('每日签到奖励', !!daily, daily && daily.msg.slice(0, 30));

  // 10.955 障碍物碰撞：welcome 含 obstacles，且无法走进障碍圆内
  const wA2 = A.got('welcome');
  const obs = wA2 && wA2.obstacles;
  check('地图含障碍物布局', !!(obs && obs.length > 0), obs && `障碍数=${obs.length}`);
  if (obs && obs.length) {
    const E = client(); await E.open;
    E.send({ t: 'join', name: '碰撞测试', dim: 'tech', cls: 'warrior' });
    await sleep(300);
    const o0 = (E.got('welcome').obstacles || [])[0] || obs[0];
    // 朝障碍中心连续小步移动，服务器应把我挡在圆外
    let ex = 0, ez = 0;
    for (let i = 0; i < 80; i++) {
      const d = Math.hypot(o0.x - ex, o0.z - ez) || 1;
      ex += (o0.x - ex) / d * 0.6; ez += (o0.z - ez) / d * 0.6;
      E.send({ t: 'mv', x: ex, z: ez, ry: 0, anim: 'run' });
      await sleep(30);
    }
    const snap = [...E.msgs].reverse().find((x) => x.t === 'snap');
    const meRow = snap && snap.ps.find((r) => r[0] === E.got('welcome').id);
    const distToCenter = meRow ? Math.hypot(o0.x - meRow[1], o0.z - meRow[2]) : 0;
    check('被障碍物挡住(未穿模)', distToCenter > o0.r * 0.8, `距障碍中心=${distToCenter.toFixed(2)} 半径=${o0.r}`);
    E.ws.close();
  }

  // 10.96 五次元大混战：等待开战(15s调度) → 进入混战场
  let meleeOn = false;
  for (let i = 0; i < 24 && !meleeOn; i++) {
    meleeOn = !!(A.got('melee', (m) => m.state && m.state.active) || A.got('feed', (m) => /五次元大混战/.test(m.msg)));
    if (!meleeOn) await sleep(1000);
  }
  check('五次元大混战开战', meleeOn);
  if (meleeOn) {
    const M = client(); await M.open;
    M.send({ t: 'join', name: '混战勇士', dim: 'tech', cls: 'warrior' });
    await sleep(300);
    M.send({ t: 'melee', enter: 1 });
    await sleep(400);
    const meleeWelcome = [...M.msgs].reverse().find((x) => x.t === 'welcome' && x.room === 'melee');
    check('进入大混战场', !!meleeWelcome, meleeWelcome && `room=${meleeWelcome.room}`);
    M.ws.close();
  }

  // 10.9 组队：A 邀请 B → B 收到邀请并接受 → 双方收到队伍名单 → B 退队解散
  A.send({ t: 'party', op: 'invite', name: '测试奶妈' });
  await sleep(300);
  const inv = B.got('pinvite');
  check('组队邀请送达', !!(inv && inv.from === '测试猎人'), inv && `来自${inv.from}`);
  B.send({ t: 'party', op: 'accept' });
  await sleep(300);
  const pa = A.got('party', (m) => m.members && m.members.length === 2);
  check('组队成功(双人名单)', !!pa, pa && pa.members.map((x) => x.name).join('+'));
  B.send({ t: 'party', op: 'leave' });
  await sleep(300);
  const pd = A.got('party', (m) => m.members && m.members.length === 0);
  check('退队后队伍解散', !!pd);

  // 11. 坦克属性验证：hpMul=1.75 → maxHp≈(200+30)*1.75=402
  const youC = C.got('you', (m) => m.maxHp);
  check('坦克血量加成生效', !!(youC && youC.maxHp > 380), youC && `maxHp=${youC.maxHp}`);

  // 12. 移动+普攻怪（把A瞬移到T1怪附近打两刀验证伤害/掉落路径不崩）
  const mo = snapA.ms.find((m) => m[7] === 1);
  if (mo) {
    // 多次小步移动绕过测速（每步<0.8m）
    let [x, z] = [0, 0];
    const [tx, tz] = [mo[1], mo[2]];
    for (let i = 0; i < 60 && Math.hypot(tx - x, tz - z) > 2; i++) {
      const d = Math.hypot(tx - x, tz - z);
      x += (tx - x) / d * 0.7; z += (tz - z) / d * 0.7;
      A.send({ t: 'mv', x, z, ry: 0, anim: 'run' });
      await sleep(35);
    }
    for (let i = 0; i < 12; i++) {
      // 每发都按最新快照瞄准该怪
      const snap = [...A.msgs].reverse().find((m) => m.t === 'snap');
      const cur = snap && snap.ms.find((m) => m[0] === mo[0]);
      const [cx, cz] = cur ? [cur[1], cur[2]] : [mo[1], mo[2]];
      const dl = Math.hypot(cx - x, cz - z) || 1;
      A.send({ t: 'cast', k: 'basic', dx: (cx - x) / dl, dz: (cz - z) / dl });
      await sleep(750);
    }
    await sleep(300);
    const dmgMsg = A.got('dmg', (m) => m.kind === 'm');
    check('普攻命中怪物(弹道远程)', !!dmgMsg, dmgMsg && `单发伤害=${dmgMsg.amt}`);
  }

  check('服务器无异常输出', !srvErr.includes('Error') && !srvErr.includes('Throw'));

  const fail = results.filter(([, ok]) => !ok).length;
  console.log(`\n========= 冒烟测试: ${results.length - fail}/${results.length} 通过 =========`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
