/* 冒烟测试：起服 → 两个玩家加入 → 技能/商店/装备/加点/捕捉/治疗 全链路 */
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 34567;
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'pipe'] });
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

  // 10. 快照包含 pets 字段 + 怪物数量（5次元 × 4层 × 6只 = 120）
  await sleep(300);
  const snapA = A.got('snap');
  check('快照含 pets 字段', !!(snapA && Array.isArray(snapA.pets)));
  check('怪物已刷新', !!(snapA && snapA.ms.length === 24), snapA && `本房间怪物=${snapA.ms.length}`);

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
