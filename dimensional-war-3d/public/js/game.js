/* ============================================================
 * 次元大战 3D - 客户端：场景渲染 / 动作操控 / 实时同步
 * 操作：WASD移动 · 右键拖动转视角 · 滚轮缩放
 *       左键普攻 · Q弹道 · E范围爆发 · R突进斩 · 空格翻滚
 * ============================================================ */
const $ = (id) => document.getElementById(id);

/* ---------- 主题 ---------- */
const THEMES = {
  tech:    { ground: 0x16263e, fog: 0x0a1428, accent: 0x00a8ff },
  xiuxian: { ground: 0x163420, fog: 0x0c2012, accent: 0x2ecc71 },
  cyber:   { ground: 0x20122c, fog: 0x140a1e, accent: 0xe84393 },
  magic:   { ground: 0x251840, fog: 0x170e2a, accent: 0x9b59b6 },
  hunter:  { ground: 0x3a2a12, fog: 0x261a0a, accent: 0xe67e22 },
  war:     { ground: 0x301020, fog: 0x1c0a12, accent: 0xff3355 },
};
/* MAP_HALF / CLASSES / CLASS_NAMES 由 data.js 提供（窗口全局） */

/* ---------- 全局状态 ---------- */
let renderer, scene, camera, clock;
let ws = null, myId = null, myDim = null, myCls = 'warrior', curRoom = null;
let me = null;                 // {obj,x,z,ry,anim,hp,maxHp,level,...}
const remotes = new Map();     // id -> remote player
const monsters = new Map();    // id -> monster
const petsEnt = new Map();     // ownerId -> pet entity
const projectiles = new Map(); // id -> proj
const fxList = [];             // 特效
const dmgSprites = [];
let keys = {}, camYaw = 0, camPitch = 0.55, camDist = 11;
let cds = { basic: 0, q: 0, e: 0, r: 0 };
let burstT = 0, burstSpeed = 0, burstDir = [0, 0], dodgeCd = 0, rushTrail = 0;
let jumpUntil = 0, jumpCd = 0;          // 跳跃：竖直弧线 + 跳跃姿态
const JUMP_MS = 620, JUMP_H = 1.5;
let warInfo = { active: false };
let dead = false, deadAt = 0;
let joined = false;
let lastJoin = null;           // 断线自动重连凭据 {name, dim, cls}
let reconnectN = 0;
let shopData = [];             // 商店货架（welcome 下发）
let invData = { equip: {}, inv: [] };
const seenSkills = JSON.parse(localStorage.getItem('dw3d_seen_skills') || '{}');
const myClsDef = () => CLASSES.find((c) => c.id === myCls) || CLASSES[0];
const cdOf = (k) => { const s = myClsDef().skills[k]; return s ? s.cd : 600; };
const preview = { scene: null, camera: null, hero: null, dim: null, pedestal: null, ready: false };
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const joy = { active: false, id: -1, cx: 0, cy: 0, dx: 0, dy: 0 };   // 虚拟摇杆
const camTouch = { id: -1, lx: 0, ly: 0 };                            // 视角触摸

/* ============================================================
 * 启动
 * ============================================================ */
window.addEventListener('load', () => {
  renderer = new THREE.WebGLRenderer({ canvas: $('c3d'), antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 300);
  clock = new THREE.Clock();

  window.addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  // 上次登录信息回填（名字/次元/职业不用重输）
  const lastSave = JSON.parse(localStorage.getItem('dw3d_last_join') || 'null');
  let chosen = lastSave ? lastSave.dim : null;
  let chosenCls = lastSave ? lastSave.cls : 'warrior';
  let creatingNew = false;
  if (lastSave && lastSave.name) $('join-name').value = lastSave.name;

  // 次元选择卡片
  $('dim-cards').innerHTML = DIMENSIONS.map((d) => `
    <div class="dim-card" data-dim="${d.id}" style="border-color:${d.color}">
      <div class="dc-icon">${d.icon}</div>
      <div class="dc-name" style="color:${d.color}">${d.name}</div>
      ${d.id === 'hunter' ? '<div class="dc-perk">天赋:捕捉宝宝</div>' : ''}
    </div>`).join('');
  // 职业选择卡片
  const renderClassCards = () => {
    const names = (chosen && CLASS_NAMES[chosen]) || null;
    $('class-cards').innerHTML = CLASSES.map((c) => `
      <div class="class-card ${c.id === chosenCls ? 'chosen' : ''}" data-cls="${c.id}">
        <div class="cc-icon">${c.icon}</div>
        <div class="cc-name">${names ? names[c.id] : c.role}</div>
        <div class="cc-role">${c.role}</div>
      </div>`).join('');
    document.querySelectorAll('.class-card').forEach((el) => el.onclick = () => {
      chosenCls = el.dataset.cls;
      renderClassCards();
      setPreviewHero(chosen || 'xiuxian', chosenCls);
    });
  };
  renderClassCards();

  document.querySelectorAll('.dim-card').forEach((el) => el.onclick = () => {
    chosen = el.dataset.dim;
    document.querySelectorAll('.dim-card').forEach((x) => x.classList.remove('chosen'));
    el.classList.add('chosen');
    renderClassCards();
    setPreviewHero(chosen, chosenCls);
  });
  if (chosen) {
    const el = document.querySelector(`.dim-card[data-dim="${chosen}"]`);
    if (el) el.classList.add('chosen');
  }

  // 统一进入逻辑（手动选择 / 自动续上次角色 共用）
  async function doJoin(name, dim, cls) {
    const btn = $('btn-join');
    btn.disabled = true;
    await MODELS.loadAssets((done, total) => { btn.textContent = `⏳ 加载次元资产 ${done}/${total}…`; });
    btn.textContent = '⚔️ 降临次元';
    btn.disabled = false;
    localStorage.setItem('dw3d_last_join', JSON.stringify({ name, dim, cls }));
    connect(name, dim, cls);
  }

  $('btn-join').onclick = async () => {
    const name = $('join-name').value.trim();
    if (!name) return toast('请输入昵称');
    if (!chosen) return toast('请选择降临次元');
    if (!chosenCls) return toast('请选择职业');
    // 新建角色：名称必须与已有角色不同（避免覆盖原角色存档）
    if (creatingNew && lastSave && lastSave.name && name === lastSave.name)
      return toast('新建角色名称需与现有角色不同');
    doJoin(name, chosen, chosenCls);
  };

  // 「新建角色」：清空昵称、重新选择，强制取不同名字（其余全部从零开始）
  const btnNew = $('btn-newchar');
  if (btnNew) btnNew.onclick = () => {
    creatingNew = true;
    $('join-name').value = '';
    $('join-name').focus();
    toast('新建角色：取一个新昵称，从零开始闯荡次元');
  };

  initParticles();
  initPreview();
  // 页面打开即后台预载资产；就绪后展示默认英雄
  MODELS.loadAssets().then(() => { setPreviewHero(chosen || 'xiuxian', chosenCls); });

  // 自动续上次角色：已有存档且非「登出/新建」时，直接进入，跳过次元/英雄选择
  const forceSelect = sessionStorage.getItem('dw_force_select') === '1';
  sessionStorage.removeItem('dw_force_select');
  if (lastSave && lastSave.name && lastSave.dim && !forceSelect) {
    doJoin(lastSave.name, lastSave.dim, lastSave.cls || 'warrior');
  }

  // 音频：首次交互解锁（浏览器自动播放策略），菜单BGM待命
  AUDIO.setMusic('menu');
  const unlockAudio = () => AUDIO.unlock();
  addEventListener('pointerdown', unlockAudio, { once: true });
  addEventListener('keydown', unlockAudio, { once: true });
  $('btn-mute').textContent = AUDIO.isMuted() ? '🔇' : '🔊';
  $('btn-mute').onclick = () => { $('btn-mute').textContent = AUDIO.toggleMute() ? '🔇' : '🔊'; };

  if (isTouch) initTouch();

  bindInput();
  animate();
});

/* ============================================================
 * 移动端：虚拟摇杆 + 触屏技能 + 视角拖动
 * ============================================================ */
function initTouch() {
  document.body.classList.add('touch');
  const cv = $('c3d');
  cv.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      if (t.clientX < innerWidth * 0.45 && !joy.active) {
        joy.active = true; joy.id = t.identifier;
        joy.cx = t.clientX; joy.cy = t.clientY; joy.dx = joy.dy = 0;
        const base = $('joy');
        base.style.left = (t.clientX - 60) + 'px';
        base.style.top = (t.clientY - 60) + 'px';
        base.classList.remove('hidden');
      } else if (camTouch.id === -1) {
        camTouch.id = t.identifier; camTouch.lx = t.clientX; camTouch.ly = t.clientY;
      }
    }
    e.preventDefault();
  }, { passive: false });
  cv.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === joy.id) {
        let dx = t.clientX - joy.cx, dy = t.clientY - joy.cy;
        const len = Math.hypot(dx, dy);
        if (len > 52) { dx = dx / len * 52; dy = dy / len * 52; }
        joy.dx = dx / 52; joy.dy = dy / 52;
        $('joy-knob').style.transform = `translate(${dx}px, ${dy}px)`;
      } else if (t.identifier === camTouch.id) {
        camYaw -= (t.clientX - camTouch.lx) * 0.007;
        camPitch = Math.min(1.25, Math.max(0.12, camPitch + (t.clientY - camTouch.ly) * 0.005));
        camTouch.lx = t.clientX; camTouch.ly = t.clientY;
      }
    }
    e.preventDefault();
  }, { passive: false });
  const endTouch = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === joy.id) {
        joy.active = false; joy.id = -1; joy.dx = joy.dy = 0;
        $('joy').classList.add('hidden');
        $('joy-knob').style.transform = '';
      }
      if (t.identifier === camTouch.id) camTouch.id = -1;
    }
  };
  cv.addEventListener('touchend', endTouch);
  cv.addEventListener('touchcancel', endTouch);

  // 触屏技能键
  const bindTap = (id, fn) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); fn(); }, { passive: false });
  };
  bindTap('sk-basic', () => castSkill('basic'));
  bindTap('sk-q', () => castSkill('q'));
  bindTap('sk-e', () => castSkill('e'));
  bindTap('sk-r', () => castSkill('r'));
  bindTap('sk-dodge', dodge);
  bindTap('sk-pet', capturePet);
  bindTap('btn-atk', () => castSkill('basic'));
}

/* ============================================================
 * 英雄选择 3D 预览转盘
 * ============================================================ */
function initPreview() {
  preview.scene = new THREE.Scene();
  preview.scene.background = new THREE.Color(0x1c1c38);
  preview.scene.fog = new THREE.Fog(0x1c1c38, 10, 26);
  preview.camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 50);
  // 宽屏时相机正对、视线偏左 → 英雄渲染在屏幕右侧，给左侧选择面板完整让位；窄屏居中
  preview.lookX = innerWidth > 760 ? -2.6 : 0;
  preview.camera.position.set(0, 1.7, 5.0);
  preview.camera.lookAt(preview.lookX, 0.95, 0);
  preview.scene.add(new THREE.HemisphereLight(0xdde8ff, 0x3a3a52, 1.35));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(2.5, 4, 3);
  preview.scene.add(key);
  const rim = new THREE.DirectionalLight(0xaab0ff, 1.5);
  rim.position.set(-3, 2.5, -3);
  preview.scene.add(rim);
  window.addEventListener('resize', () => {
    preview.camera.aspect = innerWidth / innerHeight;
    preview.lookX = innerWidth > 760 ? -2.6 : 0;
    preview.camera.lookAt(preview.lookX, 0.95, 0);
    preview.camera.updateProjectionMatrix();
  });
}

function setPreviewHero(dimId, clsId) {
  if (!preview.scene || !MODELS.isReady() || joined) return;
  if (preview.hero) { preview.scene.remove(preview.hero); preview.hero = null; }
  if (preview.pedestal) { preview.scene.remove(preview.pedestal); preview.pedestal = null; }
  preview.dim = dimId;
  const accent = dimAccent(dimId);
  // 发光底座
  const ped = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, 0.16, 40),
    new THREE.MeshStandardMaterial({ color: 0x1a1a30, roughness: 0.4, metalness: 0.6 }));
  disc.position.y = -0.08;
  ped.add(disc);
  const glowRing = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.045, 10, 60),
    new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1.6 }));
  glowRing.rotation.x = Math.PI / 2;
  glowRing.position.y = 0.02;
  ped.add(glowRing);
  const pl = new THREE.PointLight(accent, 2.2, 7);
  pl.position.set(0, 1.6, 0);
  ped.add(pl);
  preview.pedestal = ped;
  preview.scene.add(ped);

  preview.hero = MODELS.makeHero(dimId, accent, clsId || 'warrior');
  preview.scene.add(preview.hero);
  // 切换时播一段攻击动作展示
  setTimeout(() => { if (preview.hero) MODELS.attackAnim(preview.hero, dimId, 'basic'); }, 350);
  preview.ready = true;
}

/* ============================================================
 * 网络
 * ============================================================ */
function connect(name, dim, cls) {
  lastJoin = { name, dim, cls };
  myCls = cls;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { reconnectN = 0; ws.send(JSON.stringify({ t: 'join', name, dim, cls })); };
  ws.onmessage = (ev) => onMsg(JSON.parse(ev.data));
  // 断线（切后台/锁屏/网络抖动）自动重连重进，不踢回登录页
  ws.onclose = () => {
    if (!joined || !lastJoin) return;
    if (++reconnectN > 30) { toast('🔌 无法连接服务器，请刷新页面'); return; }
    toast('🔌 连接断开，正在自动重连…');
    setTimeout(() => connect(lastJoin.name, lastJoin.dim, lastJoin.cls), Math.min(5000, 1000 * reconnectN));
  };
}
// 切回前台时若连接已死立刻重连（iOS 切后台会挂起定时器）
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && joined && lastJoin && (!ws || ws.readyState >= 2)) {
    connect(lastJoin.name, lastJoin.dim, lastJoin.cls);
  }
});
const net = (obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

function onMsg(m) {
  switch (m.t) {
    case 'welcome': {
      myId = m.id;
      myDim = m.you.dim;
      if (m.you.cls) myCls = m.you.cls;
      if (m.shop) shopData = m.shop;
      if (m.achDefs) achDefs = m.achDefs;
      if (m.ach) myAch = new Set(m.ach);
      if (m.achEquip !== undefined) achEquip = m.achEquip;
      if (m.bagMode) bagMode = m.bagMode;
      if (m.dimSkill) { dimSkillDef = m.dimSkill; updateDimSkillSlot(); }
      if (m.equip || m.inv) { invData = { equip: m.equip || {}, inv: m.inv || [] }; renderPanel(); }
      obstacles = m.obstacles || [];
      enterRoom(m.room, m);
      setBoss(m.boss);
      if (m.melee) { meleeInfo = m.melee; renderMeleeBanner(); }
      if (m.first && !joined) {
        joined = true;
        $('join-screen').classList.add('hidden');
        $('hud').classList.remove('hidden');
        const cn = (CLASS_NAMES[myDim] || {})[myCls] || '';
        toast(`🌌 欢迎降临【${dimName(myDim)}】！你是一名${cn}，打怪升级，等待次元重叠！`);
      }
      setupSkillBar();
      updateDimSkillSlot();
      AUDIO.setMusic(m.room === 'war' ? 'war' : 'world');
      updateYou(m.you);
      setWar(m.war);
      break;
    }
    case 'inv': {
      invData = { equip: m.equip || {}, inv: m.inv || [] };
      renderPanel();
      break;
    }
    case 'rank': {
      rankData = m.list || [];
      if (m.mode) rankMode = m.mode;
      renderPanel();
      break;
    }
    case 'heal': {
      const pos = m.id === myId ? (me && me.obj.position) : (remotes.get(m.id) || {}).obj && remotes.get(m.id).obj.position;
      if (pos) {
        dmgNumber(pos, '+' + m.amt, '#6dff8a');
        sparks(pos.x, 0.5, pos.z, 0x6dff8a, { count: 16, speed: 3.5, life: 0.8, gravity: 2, up: 1.2 });
      }
      if (m.id !== myId) {
        const r = remotes.get(m.id);
        if (r) { r.hp = m.hp; drawBar(r); }
      }
      break;
    }
    case 'snap': onSnap(m); break;
    case 'pjoin': addRemote(m.p); break;
    case 'pleave': removeRemote(m.id); break;
    case 'cast': {
      const r = remotes.get(m.id);
      if (r) {
        r.attackT = clock.elapsedTime;
        r.obj.rotation.y = Math.atan2(m.dx, m.dz);
        MODELS.attackAnim(r.obj, r.dim, m.k);
      }
      const cc = dimAccent(r ? r.dim : myDim);
      if (me) AUDIO.sfxAt(m.k === 'q' ? 'laser' : m.k === 'e' ? 'explosion' : 'swing', Math.hypot(m.x - me.x, m.z - me.z), 0.8);
      if (m.k === 'e') {
        ringFx(m.x, m.z, 5.5, cc);
        sparks(m.x, 0.4, m.z, cc, { count: 30, speed: 8, life: 0.7, gravity: -6, up: 1.4 });
        flashLight(m.x, 1.5, m.z, cc, 4, 12, 0.35);
      }
      break;
    }
    case 'proj': spawnProj(m); break;
    case 'projhit': {
      const pr = projectiles.get(m.id);
      if (pr) {
        burstFx(m.x, 1.1, m.z, pr.color);
        if (me) AUDIO.sfxAt('explosion', Math.hypot(m.x - me.x, m.z - me.z), 0.9);
        sparks(m.x, 1.1, m.z, pr.color, { count: 22, speed: 6.5, life: 0.6 });
        flashLight(m.x, 1.2, m.z, pr.color, 3.5, 10, 0.28);
        scene.remove(pr.obj);
        projectiles.delete(m.id);
      }
      break;
    }
    case 'dmg': onDmg(m); break;
    case 'mdie': {
      const mo = monsters.get(m.id);
      if (mo) {
        mo.state = 'dead';
        sparks(mo.obj.position.x, 0.8, mo.obj.position.z, 0xccccdd, { count: 20, speed: 5, life: 0.7 });
        sparks(mo.obj.position.x, 0.6, mo.obj.position.z, 0xffd166, { count: 8, speed: 3.5, life: 0.8 });
        if (m.by === myId) { toast2('+击杀'); AUDIO.sfx('coin', 0.8); }
      }
      break;
    }
    case 'mrespawn': {
      const mo = monsters.get(m.id);
      if (mo) { mo.tx = m.x; mo.tz = m.z; mo.hp = m.hp; mo.state = 'idle'; if (!mo.obj.userData.rig) mo.obj.scale.setScalar(0.2); updateBar(mo); }
      break;
    }
    case 'pdie': {
      if (m.id === myId) {
        dead = true; deadAt = Date.now(); $('death').classList.remove('hidden');
        AUDIO.sfx('hurt', 1, 0.6);
        sparks(me.x, 1.0, me.z, 0xff4455, { count: 30, speed: 6, life: 0.8 });
      } else {
        const r = remotes.get(m.id);
        if (r) { r.anim = 'dead'; sparks(r.obj.position.x, 1.0, r.obj.position.z, 0xff4455, { count: 30, speed: 6, life: 0.8 }); }
      }
      break;
    }
    case 'prespawn': {
      if (m.id === myId) { dead = false; me.x = m.x; me.z = m.z; me.hp = m.hp; $('death').classList.add('hidden'); }
      else { const r = remotes.get(m.id); if (r) { r.anim = 'idle'; r.tx = m.x; r.tz = m.z; r.obj.rotation.x = 0; r.obj.position.y = 0; } }
      break;
    }
    case 'lvl': {
      if (m.id === myId) {
        levelUpBanner(m.level);
        AUDIO.sfx('levelup', 0.9);
        sparks(me.x, 0.3, me.z, 0xffd166, { count: 40, speed: 7, life: 1.0, gravity: -4, up: 2.0 });
        flashLight(me.x, 1.8, me.z, 0xffd166, 4, 12, 0.5);
      }
      const r = remotes.get(m.id);
      if (r) {
        r.level = m.level; drawBar(r);
        sparks(r.obj.position.x, 0.3, r.obj.position.z, 0xffd166, { count: 30, speed: 7, life: 1.0, gravity: -4, up: 2.0 });
      }
      break;
    }
    case 'you': updateYou(m); break;
    case 'war': setWar(m.state); break;
    case 'boss': setBoss(m); break;
    case 'melee': meleeInfo = m.state; renderMeleeBanner(); break;
    case 'party':
      partyMembers = m.members || [];
      renderPartyHud();
      if (panelTab === 'party') renderPanel();
      break;
    case 'ach': {
      myAch.add(m.id);
      feed(`${m.icon} 达成成就【${m.name}】：${m.desc}`);
      achBanner(m);
      if (panelTab === 'ach') renderPanel();
      break;
    }
    case 'dimfx': onDimFx(m); break;
    case 'ccfx': onCcFx(m); break;
    case 'cc': onCc(m); break;
    case 'rooted': cc.rootUntil = performance.now() + (m.ms || 2000); toast('🔮 你被禁锢了！'); break;
    case 'pinvite': {
      pendingInviteFrom = m.from;
      $('invite-text').textContent = `👥 ${m.from} 邀请你组队（共享经验）`;
      $('invite-prompt').classList.remove('hidden');
      clearTimeout(inviteTimer);
      inviteTimer = setTimeout(() => $('invite-prompt').classList.add('hidden'), 30000);
      break;
    }
    case 'warn': {
      // 世界BOSS技能预警：地面危险圈从中心填满，填满即落地——看圈走位躲技能
      warnFx(m.x, m.z, m.r || 7, (m.delay || 1100) / 1000, m.kind);
      break;
    }
    case 'baoe': {
      // 世界BOSS震地轰击：红色冲击环 + 红光
      ringFx(m.x, m.z, m.r || 7, 0xff3344);
      flashLight(m.x, 1.5, m.z, 0xff3344, 4, 14, 0.35);
      break;
    }
    case 'maoe': {
      // 精英怪范围震击：紫色冲击环
      ringFx(m.x, m.z, m.r || 4.5, 0xb050ff);
      flashLight(m.x, 1.3, m.z, 0xb050ff, 3, 10, 0.3);
      break;
    }
    case 'bstorm': {
      // 世界BOSS大范围魔法风暴：超大紫色冲击环 + 强光
      ringFx(m.x, m.z, m.r || 16, 0xcc44ff);
      ringFx(m.x, m.z, (m.r || 16) * 0.6, 0x8822ff);
      flashLight(m.x, 2.0, m.z, 0xcc44ff, 6, 28, 0.6);
      break;
    }
    case 'feed': feed(m.msg); break;
    case 'chat': {
      const d = DIMENSIONS.find((x) => x.id === m.dim);
      feed(`💬 ${d ? d.icon : ''}${m.name}：${m.msg}`);  // feed 用 textContent，天然防注入
      break;
    }
    case 'err': toast('⚠️ ' + m.msg); break;
  }
}

/* ============================================================
 * 房间/场景
 * ============================================================ */
function enterRoom(roomId, m) {
  curRoom = roomId;
  // 清空场景实体
  for (const r of remotes.values()) disposeEntity(r);
  for (const mo of monsters.values()) disposeEntity(mo);
  for (const pe of petsEnt.values()) disposeEntity(pe);
  for (const pr of projectiles.values()) scene.remove(pr.obj);
  remotes.clear(); monsters.clear(); petsEnt.clear(); projectiles.clear();

  buildMap(roomId);

  // 本地英雄
  if (me && me.obj) scene.remove(me.obj);
  const accent = dimAccent(myDim);
  const obj = MODELS.makeHero(myDim, accent, myCls);
  scene.add(obj);
  me = { obj, x: m.x, z: m.z, ry: 0, anim: 'idle', attackT: 0, dim: myDim };
  obj.position.set(me.x, 0, me.z);
  dead = false;
  $('death').classList.add('hidden');

  for (const p of m.players) addRemote(p);
  $('room-name').textContent = roomId === 'war' ? '🌀 重叠战场' : `${dimIcon(myDim)} ${dimName(myDim)}`;
}

let mapObjects = [];
function buildMap(roomId) {
  for (const o of mapObjects) scene.remove(o);
  mapObjects = [];
  const theme = THEMES[roomId === 'war' ? 'war' : myDim];
  scene.fog = new THREE.Fog(theme.fog, 35, 150);
  scene.background = new THREE.Color(theme.fog);

  const add = (o) => { scene.add(o); mapObjects.push(o); };

  // 地面
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_HALF * 2 + 30, MAP_HALF * 2 + 30),
    new THREE.MeshStandardMaterial({ color: theme.ground, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  add(ground);
  const grid = new THREE.GridHelper(MAP_HALF * 2, 30, theme.accent, theme.ground);
  grid.material.opacity = 0.18; grid.material.transparent = true;
  add(grid);

  // 灯光
  add(new THREE.HemisphereLight(0xbbccff, theme.ground, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(35, 60, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(isTouch ? 1024 : 2048, isTouch ? 1024 : 2048);
  sun.shadow.camera.left = -85; sun.shadow.camera.right = 85;
  sun.shadow.camera.top = 85; sun.shadow.camera.bottom = -85;
  sun.shadow.camera.far = 200;
  sun.shadow.bias = -0.0008;
  add(sun);

  // 主题摆件
  const rng = mulberry32(roomId === 'war' ? 999 : hashCode(roomId));
  const themeKey = roomId === 'war' ? 'war' : myDim;
  if (roomId === 'war') buildWarLayout(add, rng, theme);
  else buildHomeLayout(themeKey, add, rng, theme);
  // 四条主题大道（视觉指引，与摆件留出的通道一致）
  if (roomId !== 'war') {
    for (let i = 0; i < 4; i++) {
      const road = new THREE.Mesh(new THREE.PlaneGeometry(3.2, MAP_HALF - 6),
        new THREE.MeshBasicMaterial({ color: theme.accent, transparent: true, opacity: 0.06 }));
      road.rotation.x = -Math.PI / 2;
      road.rotation.z = i * Math.PI / 2;
      const a = i * Math.PI / 2;
      road.position.set(Math.sin(a) * (MAP_HALF / 2 + 3), 0.03, Math.cos(a) * (MAP_HALF / 2 + 3));
      add(road);
    }
  }
  // 战场：双方出生区光柱
  if (roomId === 'war') {
    for (const [x, c] of [[-60, dimAccent(warInfo.a)], [60, dimAccent(warInfo.b)]]) {
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 40, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.12, side: THREE.DoubleSide }));
      beam.position.set(x, 20, 0);
      add(beam);
    }
  }
  // 边界提示
  const border = new THREE.Mesh(new THREE.RingGeometry(MAP_HALF - 0.3, MAP_HALF + 0.6, 64),
    new THREE.MeshBasicMaterial({ color: theme.accent, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
  border.rotation.x = -Math.PI / 2;
  border.position.y = 0.05;
  add(border);
}

/* ---------- 手工关卡布局 ---------- */
/* 村庄建筑 / 村庄灯饰 / 巢穴立柱：每主题指定 prop 名称 */
const LAYOUT_DEFS = {
  tech:    { house: ['basemodule_A', 'basemodule_B'], lamp: 'containers_A',      lairPillar: 'drill_structure' },
  xiuxian: { house: ['tree_single_A', 'column'],      lamp: 'torch_lit',         lairPillar: 'column' },
  cyber:   { house: ['building_A', 'building_B', 'building_D'], lamp: 'streetlight', lairPillar: 'trafficlight_A' },
  magic:   { house: ['pillar_decorated', 'crates_stacked'], lamp: 'torch_lit',   lairPillar: 'pillar_decorated' },
  hunter:  { house: ['tree_pine_orange_small', 'tree_pine_yellow_small'], lamp: 'lantern_standing', lairPillar: 'tree_dead_medium' },
};
const ROAD_HALF_ANGLE = 0.22;  // 四条大道的半张角
const inRoad = (a) => {
  const norm = ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
  return norm < ROAD_HALF_ANGLE || norm > Math.PI / 2 - ROAD_HALF_ANGLE;
};

function buildHomeLayout(themeKey, add, rng, theme) {
  const defs = LAYOUT_DEFS[themeKey] || LAYOUT_DEFS.tech;
  const propFn = PROPS[themeKey] || PROPS.tech;
  const fallback = () => propFn(rng, theme.accent);

  // 1) 出生村庄：环形建筑朝向中心
  const houses = 6;
  for (let i = 0; i < houses; i++) {
    const a = (i / houses) * Math.PI * 2 + 0.4;
    if (inRoad(a)) continue;
    const name = defs.house[i % defs.house.length];
    const o = MODELS.makePropNamed(themeKey, name, 0.8) || fallback();
    o.position.set(Math.cos(a) * 7.6, 0, Math.sin(a) * 7.6);
    o.rotation.y = -a + Math.PI / 2;   // 朝向村中心
    add(o);
  }
  // 2) 村庄灯饰环 + 中心篝火光
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const o = MODELS.makePropNamed(themeKey, defs.lamp, 0.85);
    if (o) { o.position.set(Math.cos(a) * 4.6, 0, Math.sin(a) * 4.6); o.rotation.y = -a; add(o); }
  }
  const campfire = new THREE.PointLight(theme.accent, 2.0, 16);
  campfire.position.set(0, 2.5, 0);
  add(campfire);

  // 3) 野外障碍：在服务器障碍点放可见的树/巨石/建筑（看得见=走不过去）
  const lairA = (typeof LAIR_ANGLES !== 'undefined' && LAIR_ANGLES[themeKey]) || 0;
  for (const ob of obstacles) {
    const o = MODELS.makeProp(themeKey, rng) || fallback();
    o.position.set(ob.x, 0, ob.z);
    o.rotation.y = rng() * 6.28;
    o.scale.multiplyScalar(Math.max(1, ob.r * 0.9));   // 体积匹配碰撞半径
    add(o);
  }

  // 4) Boss 巢穴：立柱环 + 红色凶光 + 地面警示环
  const lx = Math.cos(lairA) * LAIR_R, lz = Math.sin(lairA) * LAIR_R;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const o = MODELS.makePropNamed(themeKey, defs.lairPillar, 1.15) || fallback();
    o.position.set(lx + Math.cos(a) * 7.5, 0, lz + Math.sin(a) * 7.5);
    o.rotation.y = -a;
    add(o);
  }
  const lairRing = new THREE.Mesh(new THREE.RingGeometry(8.2, 8.9, 48),
    new THREE.MeshBasicMaterial({ color: 0xff3344, transparent: true, opacity: 0.3, side: THREE.DoubleSide }));
  lairRing.rotation.x = -Math.PI / 2;
  lairRing.position.set(lx, 0.06, lz);
  add(lairRing);
  const lairLight = new THREE.PointLight(0xff3344, 2.4, 22);
  lairLight.position.set(lx, 4, lz);
  add(lairLight);
}

function buildWarLayout(add, rng, theme) {
  // 中央方尖碑
  const obelisk = MODELS.makePropNamed('war', 'pillar', 2.4);
  if (obelisk) { obelisk.position.set(0, 0, 0); add(obelisk); }
  const beacon = new THREE.PointLight(0xff3355, 2.5, 26);
  beacon.position.set(0, 6, 0);
  add(beacon);

  // 对称掩体阵（沿X轴镜像，给两侧推进提供掩护；随地图扩大外推）
  const covers = [
    ['rubble_large', 15, 0], ['rubble_large', 33, 9], ['rubble_half', 33, -9],
    ['pillar', 24, 18], ['pillar', 24, -18], ['gravestone', 42, 0],
    ['rubble_half', 12, 21], ['rubble_large', 12, -21], ['fence_pillar_broken', 46, 15], ['fence_pillar_broken', 46, -15],
  ];
  for (const [name, x, z] of covers) {
    for (const sx of [-1, 1]) {
      const o = MODELS.makePropNamed('war', name, 1);
      if (!o) continue;
      o.position.set(x * sx, 0, z);
      o.rotation.y = rng() * 6.28;
      add(o);
    }
  }
  // 火把走廊（中线）
  for (let i = -5; i <= 5; i++) {
    if (i === 0) continue;
    const o = MODELS.makePropNamed('war', 'torch_lit', 1);
    if (o) { o.position.set(i * 7, 0, i % 2 === 0 ? 4 : -4); add(o); }
  }
  // 外圈废墟
  for (let i = 0; i < 26; i++) {
    const a = rng() * Math.PI * 2;
    const r = 52 + rng() * 14;
    const o = MODELS.makeProp('war', rng) || PROPS.war(rng, theme.accent);
    o.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    o.rotation.y = rng() * 6.28;
    add(o);
  }
}

const PROPS = {
  tech: (rng, accent) => {
    const g = new THREE.Group();
    const h = 1.5 + rng() * 4;
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.2 + rng(), h, 1.2 + rng()),
      new THREE.MeshStandardMaterial({ color: 0x39495e, roughness: 0.6, metalness: 0.5 }));
    b.position.y = h / 2; g.add(b);
    const w = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.12, 0.05),
      new THREE.MeshStandardMaterial({ color: accent, emissive: accent }));
    w.position.set(0, h * 0.7, (0.6 + rng() * 0.5) + 0.03); g.add(w);
    return g;
  },
  xiuxian: (rng) => {
    const g = new THREE.Group();
    if (rng() < 0.7) {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 1.4),
        new THREE.MeshStandardMaterial({ color: 0x5a4030 }));
      trunk.position.y = 0.7; g.add(trunk);
      for (let i = 0; i < 2; i++) {
        const leaf = new THREE.Mesh(new THREE.ConeGeometry(1.1 - i * 0.35, 1.3, 7),
          new THREE.MeshStandardMaterial({ color: 0x2d7a40, roughness: 0.9 }));
        leaf.position.y = 1.7 + i * 0.8; g.add(leaf);
      }
    } else {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 2.2 + rng() * 1.5, 6),
        new THREE.MeshStandardMaterial({ color: 0x8a8a92, roughness: 0.9 }));
      p.position.y = 1.2; g.add(p);
    }
    return g;
  },
  cyber: (rng, accent) => {
    const g = new THREE.Group();
    const h = 3 + rng() * 7;
    const b = new THREE.Mesh(new THREE.BoxGeometry(1 + rng() * 1.5, h, 1 + rng() * 1.5),
      new THREE.MeshStandardMaterial({ color: 0x14101e, roughness: 0.4, metalness: 0.6 }));
    b.position.y = h / 2; g.add(b);
    const neonColors = [accent, 0x00e5ff, 0xffe14d];
    const e = new THREE.Mesh(new THREE.BoxGeometry(0.08, h * (0.5 + rng() * 0.4), 0.08),
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: neonColors[Math.floor(rng() * 3)], emissiveIntensity: 2 }));
    e.position.set(0.55 + rng() * 0.4, h * 0.45, 0.55); g.add(e);
    return g;
  },
  magic: (rng, accent) => {
    const g = new THREE.Group();
    const s = 0.5 + rng() * 1.3;
    const c = new THREE.Mesh(new THREE.OctahedronGeometry(s),
      new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.5, transparent: true, opacity: 0.85 }));
    c.position.y = s * 0.9;
    c.rotation.z = (rng() - 0.5) * 0.6;
    g.add(c);
    return g;
  },
  hunter: (rng) => {
    const g = new THREE.Group();
    if (rng() < 0.5) {
      const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.6 + rng() * 0.9, 0),
        new THREE.MeshStandardMaterial({ color: 0x6e6256, roughness: 1 }));
      r.position.y = 0.5; g.add(r);
    } else {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 2.2),
        new THREE.MeshStandardMaterial({ color: 0x4a3826 }));
      trunk.position.y = 1.1; g.add(trunk);
      const top = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.5, 8),
        new THREE.MeshStandardMaterial({ color: 0x5e7a30, roughness: 0.9 }));
      top.position.y = 2.4; g.add(top);
    }
    return g;
  },
  war: (rng, accent) => {
    const g = new THREE.Group();
    const h = 1 + rng() * 3.2;
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.55, h, 6),
      new THREE.MeshStandardMaterial({ color: 0x4a3a45, roughness: 0.9 }));
    p.position.y = h / 2;
    p.rotation.z = (rng() - 0.5) * 0.3;
    g.add(p);
    if (rng() < 0.3) {
      const fire = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.7, 6),
        new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 2 }));
      fire.position.y = h + 0.3; g.add(fire);
    }
    return g;
  },
};

/* ============================================================
 * 实体管理
 * ============================================================ */
function addRemote(p) {
  if (remotes.has(p.id) || p.id === myId) return;
  const obj = MODELS.makeHero(p.dim, dimAccent(p.dim), p.cls);
  obj.position.set(p.x, 0, p.z);
  scene.add(obj);
  const r = { ...p, obj, tx: p.x, tz: p.z, try_: p.ry, attackT: 0, anim: p.dead ? 'dead' : p.anim };
  r.bar = makeBar(r, p.dim === myDim ? '#2ecc71' : '#ff5566');
  remotes.set(p.id, r);
}
function addPetEnt(ownerId, tier, x, z, ry, state, hp, maxHp, name) {
  const obj = MODELS.makeMonster(tier, dimAccent('hunter'), true);
  obj.position.set(x, 0, z);
  scene.add(obj);
  const pe = { id: ownerId, obj, tx: x, tz: z, try_: ry, state, hp, maxHp, tier, name: '🐾' + name, isMonster: true, isPet: true };
  pe.bar = makeBar(pe, '#7CFC9A');
  petsEnt.set(ownerId, pe);
}
function removeRemote(id) {
  const r = remotes.get(id);
  if (r) { disposeEntity(r); remotes.delete(id); }
}
function addMonsterEnt(id, x, z, ry, state, hp, maxHp, tier, name, level) {
  const obj = MODELS.makeMonster(tier, THEMES[curRoom === 'war' ? 'war' : myDim].accent);
  obj.position.set(x, 0, z);
  scene.add(obj);
  const mo = { id, obj, tx: x, tz: z, try_: ry, state, hp, maxHp, tier, name, level: level || 1, isMonster: true };
  mo.bar = makeBar(mo, '#ffaa33');
  monsters.set(id, mo);
}
function disposeEntity(e) {
  scene.remove(e.obj);
  if (e.bar) scene.remove(e.bar.sprite);
}

function onSnap(m) {
  const seen = new Set();
  for (const [id, x, z, ry, anim, hp, maxHp, level, isDead] of m.ps) {
    if (id === myId) { continue; }
    seen.add(id);
    let r = remotes.get(id);
    if (!r) continue; // 等 pjoin
    r.tx = x; r.tz = z; r.try_ = ry;
    r.anim = isDead ? 'dead' : anim;
    if (r.hp !== hp || r.level !== level) { r.hp = hp; r.maxHp = maxHp; r.level = level; drawBar(r); }
  }
  for (const id of [...remotes.keys()]) if (!seen.has(id)) removeRemote(id);
  updatePartyHud();

  const seenM = new Set();
  for (const [id, x, z, ry, state, hp, maxHp, tier, name, level] of m.ms) {
    seenM.add(id);
    let mo = monsters.get(id);
    if (!mo) { addMonsterEnt(id, x, z, ry, state, hp, maxHp, tier, name, level); continue; }
    mo.tx = x; mo.tz = z; mo.try_ = ry; mo.state = state;
    if (mo.hp !== hp || mo.level !== level) { mo.hp = hp; mo.level = level || mo.level; drawBar(mo); }
  }
  for (const id of [...monsters.keys()]) if (!seenM.has(id)) { disposeEntity(monsters.get(id)); monsters.delete(id); }

  // 猎人宝宝
  const seenPet = new Set();
  for (const [oid, tier, x, z, ry, state, hp, maxHp, name] of (m.pets || [])) {
    seenPet.add(oid);
    let pe = petsEnt.get(oid);
    if (!pe) { addPetEnt(oid, tier, x, z, ry, state, hp, maxHp, name); continue; }
    pe.tx = x; pe.tz = z; pe.try_ = ry; pe.state = state;
    if (pe.hp !== hp) { pe.hp = hp; drawBar(pe); }
  }
  for (const id of [...petsEnt.keys()]) if (!seenPet.has(id)) { disposeEntity(petsEnt.get(id)); petsEnt.delete(id); }
}

function onDmg(m) {
  if (m.kind === 'm') {
    const mo = monsters.get(m.id);
    if (mo) {
      mo.hp = m.hp; drawBar(mo);
      dmgNumber(mo.obj.position, m.crit ? m.amt + ' 暴击!' : m.amt, m.crit ? '#ff9f1a' : (m.by === myId ? '#ffe14d' : '#ffffff'), m.crit);
      flash(mo.obj);
      if (m.by === myId) AUDIO.sfx('hit', 0.6);
      sparks(mo.obj.position.x, 1.0, mo.obj.position.z, m.crit ? 0xff9f1a : 0xffcc55, { count: m.crit ? 14 : 7, speed: 4, life: 0.4 });
    }
  } else if (m.kind === 'pet') {
    const pe = petsEnt.get(m.id);
    if (pe) {
      pe.hp = m.hp; drawBar(pe);
      dmgNumber(pe.obj.position, m.amt, '#ffaa88');
      flash(pe.obj);
    }
  } else {
    if (m.id === myId) {
      dmgNumber(me.obj.position, m.crit ? m.amt + ' 暴击!' : m.amt, '#ff5566', m.crit);
      AUDIO.sfx('hurt', 0.7);
      $('hurt').classList.remove('hidden');
      setTimeout(() => $('hurt').classList.add('hidden'), 120);
    } else {
      const r = remotes.get(m.id);
      if (r) { r.hp = m.hp; drawBar(r); dmgNumber(r.obj.position, m.crit ? m.amt + ' 暴击!' : m.amt, m.crit ? '#ff9f1a' : (m.by === myId ? '#ffe14d' : '#ffffff'), m.crit); flash(r.obj); }
    }
  }
}

/* ============================================================
 * 输入与操控
 * ============================================================ */
function bindInput() {
  addEventListener('keydown', (e) => {
    if (!joined) return;
    // 聊天框打开时键盘只归输入框
    if (document.activeElement === $('chat-input')) {
      if (e.code === 'Enter' || e.code === 'NumpadEnter') sendChat();
      if (e.code === 'Escape') closeChat();
      return;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); openChat(); return; }
    keys[e.code] = true;
    if (e.code === 'KeyQ') castSkill('q');
    if (e.code === 'KeyE') castSkill('e');
    if (e.code === 'KeyR') castSkill('r');
    if (e.code === 'KeyF') capturePet();
    if (e.code === 'KeyB') togglePanel();
    if (e.code === 'Space') { e.preventDefault(); dodge(); }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') jump();
  });
  addEventListener('keyup', (e) => keys[e.code] = false);
  $('btn-chat').onclick = openChat;

  const cv = $('c3d');
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  if (!isTouch) cv.addEventListener('mousedown', (e) => { if (e.button === 0 && joined) castSkill('basic'); });
  addEventListener('mousemove', (e) => {
    if (e.buttons & 2) {
      camYaw -= e.movementX * 0.005;
      camPitch = Math.min(1.25, Math.max(0.12, camPitch + e.movementY * 0.004));
    }
  });
  addEventListener('wheel', (e) => { camDist = Math.min(18, Math.max(6, camDist + e.deltaY * 0.01)); });

  $('btn-respawn').onclick = () => { AUDIO.sfx('click', 0.6); net({ t: 'respawn' }); };
  $('btn-war').onclick = () => {
    AUDIO.sfx('click', 0.6);
    if (curRoom === 'war') net({ t: 'war', enter: 0 });
    else net({ t: 'war', enter: 1 });
  };
  // 退出对局：回到选择界面（进度已自动保存）。用 sessionStorage 标记，避免重载后又自动续登
  $('btn-exit').onclick = () => {
    sessionStorage.setItem('dw_force_select', '1');
    joined = false; lastJoin = null;
    try { if (ws) ws.close(); } catch (e) {}
    location.reload();
  };
  $('btn-bag').onclick = togglePanel;
  $('btn-inv-yes').onclick = () => {
    $('invite-prompt').classList.add('hidden');
    net({ t: 'party', op: 'accept' });
  };
  $('btn-inv-no').onclick = () => {
    $('invite-prompt').classList.add('hidden');
    net({ t: 'party', op: 'decline' });
  };
  document.querySelectorAll('.panel-tab').forEach((el) => el.onclick = () => {
    panelTab = el.dataset.tab;
    if (panelTab === 'rank') net({ t: 'rank', mode: rankMode });   // 打开时拉取最新榜单
    renderPanel();
  });
  $('btn-panel-close').onclick = togglePanel;
}

function capturePet() {   // 现为「次元专属技能」F 键，按当前次元触发
  if (!joined || performance.now() < ccHardUntil()) return;
  const t = performance.now();
  if (t < capCdEnd) return;
  capCdEnd = t + ((dimSkillDef && dimSkillDef.cd) || 3000);
  net({ t: 'dimskill' });
}
function togglePanel() {
  if (!joined) return;
  $('panel').classList.toggle('hidden');
  if (!$('panel').classList.contains('hidden')) renderPanel();
}

/* 相机相对移动向量（键盘 WASD 或虚拟摇杆） */
let obstacles = [];

/* ---------- 小地图（地图扩大后导航用） ---------- */
function drawMinimap() {
  const cv = $('minimap');
  if (!cv || !joined || !me) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, pad = 6;
  const half = MAP_HALF;
  const toPx = (x, z) => [pad + (x + half) / (half * 2) * (W - pad * 2),
                          pad + (z + half) / (half * 2) * (H - pad * 2)];
  ctx.clearRect(0, 0, W, H);
  // 障碍（暗点）
  ctx.fillStyle = 'rgba(150,160,190,0.35)';
  for (const o of obstacles) { const [px, py] = toPx(o.x, o.z); ctx.fillRect(px - 1, py - 1, 2, 2); }
  // 安全村庄
  const [cx, cy] = toPx(0, 0);
  ctx.strokeStyle = 'rgba(120,220,140,0.5)'; ctx.beginPath(); ctx.arc(cx, cy, 7, 0, 7); ctx.stroke();
  // BOSS 巢穴方向（本次元）
  if (curRoom !== 'war' && curRoom !== 'melee' && typeof LAIR_ANGLES !== 'undefined') {
    const la = LAIR_ANGLES[myDim] || 0;
    const [lx, ly] = toPx(Math.cos(la) * LAIR_R, Math.sin(la) * LAIR_R);
    ctx.fillStyle = '#ff5544'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('💀', lx, ly + 4);
  }
  // 怪物（红点）
  ctx.fillStyle = '#ff7744';
  for (const mo of monsters.values()) { if (mo.tier >= 5) continue; const [px, py] = toPx(mo.tx, mo.tz); ctx.fillRect(px - 1, py - 1, 2, 2); }
  // 世界BOSS（大红星，若在本房间）
  for (const mo of monsters.values()) if (mo.tier >= 5) {
    const [px, py] = toPx(mo.tx, mo.tz);
    ctx.fillStyle = '#ff2244'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('★', px, py + 5);
  }
  // 其他玩家（队友绿/敌人橙）
  for (const r of remotes.values()) {
    const [px, py] = toPx(r.tx, r.tz);
    ctx.fillStyle = r.dim === myDim ? '#5cf07a' : '#ffaa33';
    ctx.beginPath(); ctx.arc(px, py, 2.4, 0, 7); ctx.fill();
  }
  // 自己（绿色朝向三角）
  const [mx, my] = toPx(me.x, me.z);
  const ang = me.obj ? me.obj.rotation.y : 0;
  ctx.save(); ctx.translate(mx, my); ctx.rotate(-ang);
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(3.5, 4); ctx.lineTo(-3.5, 4); ctx.closePath(); ctx.fill();
  ctx.restore();
}
setInterval(drawMinimap, 120);

function resolveObstacles(x, z, rad) {
  for (let k = 0; k < obstacles.length; k++) {
    const o = obstacles[k];
    const dx = x - o.x, dz = z - o.z, min = o.r + rad;
    const d2 = dx * dx + dz * dz;
    if (d2 < min * min) {
      const d = Math.sqrt(d2) || 0.001;
      x = o.x + dx / d * min; z = o.z + dz / d * min;
    }
  }
  return [x, z];
}

function moveVec() {
  let fx = 0, fz = 0;
  if (joy.active && (joy.dx || joy.dy)) {
    fx = joy.dx; fz = -joy.dy;     // 摇杆向上 = 前进
  } else {
    if (keys.KeyW) fz += 1;
    if (keys.KeyS) fz -= 1;
    if (keys.KeyA) fx -= 1;
    if (keys.KeyD) fx += 1;
  }
  if (!fx && !fz) return null;
  if (performance.now() < ccHardUntil()) return null;   // 眩晕/定身无法移动
  const l = Math.hypot(fx, fz); fx /= l; fz /= l;
  const s = Math.sin(camYaw), c = Math.cos(camYaw);
  // 相机指向玩家的前方 = (-sin(yaw), -cos(yaw))；fx为左右分量
  return [fx * c - fz * s, fx * -s - fz * c];
}

function burst(dir, speed, durMs) {
  burstDir = dir;
  burstSpeed = speed;
  burstT = performance.now() + durMs;
}

function dodge() {
  const t = performance.now();
  if (t < dodgeCd || dead) return;
  const mv = moveVec() || [Math.sin(me.obj.rotation.y), Math.cos(me.obj.rotation.y)];
  burst(mv, 21, 240);
  MODELS.dodgeAnim(me.obj);
  AUDIO.sfx('dodge', 0.5);
  dodgeCd = t + 1200;
}

function jump() {
  const t = performance.now();
  if (t < jumpCd || dead || t < ccHardUntil()) return;   // 被控时不能跳
  jumpUntil = t + JUMP_MS;
  jumpCd = t + 760;
  MODELS.jumpAnim(me.obj);
  AUDIO.sfx('dodge', 0.35, 1.4);
}

function nearestEnemy(maxDist = 15) {
  let best = null, bd = maxDist * maxDist;
  for (const mo of monsters.values()) {
    if (mo.state === 'dead') continue;
    const d2 = (mo.obj.position.x - me.x) ** 2 + (mo.obj.position.z - me.z) ** 2;
    if (d2 < bd) { bd = d2; best = mo; }
  }
  if (curRoom === 'war') {
    for (const r of remotes.values()) {
      if (r.dim === myDim || r.anim === 'dead') continue;
      const d2 = (r.obj.position.x - me.x) ** 2 + (r.obj.position.z - me.z) ** 2;
      if (d2 < bd) { bd = d2; best = r; }
    }
  }
  return best;
}

function castSkill(kind) {
  if (dead || !me) return;
  const sk = myClsDef().skills[kind];
  if (!sk) return;
  const t = performance.now();
  if (t < cds[kind]) return;
  if (sk.minLvl && (HUD.level || 1) < sk.minLvl) return toast(`⚠️ 【${sk.name}】需要 Lv.${sk.minLvl} 解锁`);
  cds[kind] = t + sk.cd;
  showSkillIntro(kind, sk);   // 首次使用弹出技能介绍（参考LOL）

  // 朝向：锁定最近敌人，否则面前
  const isProj = sk.kind === 'proj';
  let dx = Math.sin(me.obj.rotation.y), dz = Math.cos(me.obj.rotation.y);
  const tgt = nearestEnemy(isProj ? 26 : 9);
  if (tgt) {
    const vx = tgt.obj.position.x - me.x, vz = tgt.obj.position.z - me.z;
    const l = Math.hypot(vx, vz) || 1;
    dx = vx / l; dz = vz / l;
    me.obj.rotation.y = Math.atan2(dx, dz);
  }
  me.attackT = clock.elapsedTime;
  MODELS.attackAnim(me.obj, myDim, kind);

  const accent = dimAccent(myDim);
  if (sk.kind === 'heal' || sk.kind === 'aoeheal') {
    AUDIO.sfx('levelup', 0.55, 1.3);
    ringFx(me.x, me.z, sk.radius || 4, 0x6dff8a);
    sparks(me.x, 0.4, me.z, 0x6dff8a, { count: 26, speed: 4.5, life: 0.9, gravity: 2, up: 1.6 });
  } else if (sk.kind === 'aoe') {
    AUDIO.sfx('explosion', 1);
    ringFx(me.x, me.z, sk.radius, accent);
    sparks(me.x, 0.4, me.z, accent, { count: 34, speed: 8, life: 0.7, gravity: -6, up: 1.4 });
    flashLight(me.x, 1.5, me.z, accent, 4, 12, 0.35);
  } else if (isProj) {
    AUDIO.sfx('laser', kind === 'basic' ? 0.6 : 1);
  } else {
    AUDIO.sfx('swing', kind === 'basic' ? 0.8 : 1, sk.kind === 'dashmelee' ? 0.8 : 1);
  }
  if (sk.kind === 'dashmelee') { burst([dx, dz], 25, 180); rushTrail = 0.2; } // 突进冲刺+残影拖尾
  net({ t: 'cast', k: kind, dx, dz });
}

/* ---------- 技能栏：名称/等级/加点（+号）/首次介绍 ---------- */
function setupSkillBar() {
  const def = myClsDef();
  const keysMap = { basic: isTouch ? '' : '左键', q: 'Q', e: 'E', r: 'R' };
  for (const k of ['basic', 'q', 'e', 'r']) {
    const slot = $('sk-' + k);
    slot.querySelector('.key').textContent = keysMap[k];
    slot.querySelector('.sk-name').textContent = def.skills[k].name;
    const plus = slot.querySelector('.sk-plus');
    if (plus && !plus.dataset.bound) {
      plus.dataset.bound = '1';
      const up = (e) => { e.preventDefault(); e.stopPropagation(); AUDIO.sfx('click', 0.5); net({ t: 'sklvl', k }); };
      plus.addEventListener('click', up);
      plus.addEventListener('touchstart', up, { passive: false });
    }
    // 悬停查看技能说明
    slot.title = `${def.skills[k].name}：${def.skills[k].desc || ''}`;
  }
}

function showSkillIntro(kind, sk) {
  const key = myCls + '_' + kind;
  if (seenSkills[key]) return;
  seenSkills[key] = 1;
  localStorage.setItem('dw3d_seen_skills', JSON.stringify(seenSkills));
  const el = $('skill-intro');
  el.innerHTML = `<div class="si-name">${myClsDef().icon} ${sk.name}</div><div class="si-desc">${sk.desc || ''}</div><div class="si-tip">升级获得技能点后，点技能格上的「+」可强化该技能</div>`;
  el.classList.remove('hidden');
  clearTimeout(showSkillIntro._t);
  showSkillIntro._t = setTimeout(() => el.classList.add('hidden'), 5000);
}

/* ============================================================
 * 粒子池（单一 Points 容纳全部粒子，高性能）
 * ============================================================ */
const POOL_N = 1600;
let pool = null;
function initParticles() {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(POOL_N * 3).fill(-999);
  const col = new Float32Array(POOL_N * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.22, vertexColors: true, transparent: true, opacity: 0.95,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
  pool = { pts: new THREE.Points(geo, mat), pos, col, items: new Array(POOL_N).fill(null), cursor: 0 };
  pool.pts.frustumCulled = false;
  pool.pts.renderOrder = 5;
}
function ensureParticlesInScene() { if (pool && pool.pts.parent !== scene) scene.add(pool.pts); }

function sparks(x, y, z, color, { count = 12, speed = 5, life = 0.55, gravity = -9, up = 0.5 } = {}) {
  if (!pool) return;
  ensureParticlesInScene();
  const c = new THREE.Color(color);
  for (let n = 0; n < count; n++) {
    const i = pool.cursor = (pool.cursor + 1) % POOL_N;
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.4 + Math.random() * 0.6);
    pool.items[i] = {
      vx: Math.cos(a) * v, vy: (Math.random() * 0.8 + up) * v * 0.8, vz: Math.sin(a) * v,
      age: 0, life: life * (0.6 + Math.random() * 0.7), gravity,
    };
    pool.pos.set([x, y, z], i * 3);
    pool.col.set([c.r, c.g, c.b], i * 3);
  }
  pool.pts.geometry.attributes.position.needsUpdate = true;
  pool.pts.geometry.attributes.color.needsUpdate = true;
}

function updateParticles(dt) {
  if (!pool) return;
  const pos = pool.pos;
  let dirty = false;
  for (let i = 0; i < POOL_N; i++) {
    const p = pool.items[i];
    if (!p) continue;
    p.age += dt;
    if (p.age >= p.life) { pool.items[i] = null; pos[i * 3 + 1] = -999; dirty = true; continue; }
    p.vy += p.gravity * dt;
    pos[i * 3] += p.vx * dt;
    pos[i * 3 + 1] += p.vy * dt;
    pos[i * 3 + 2] += p.vz * dt;
    if (pos[i * 3 + 1] < 0.02) { pos[i * 3 + 1] = 0.02; p.vy *= -0.35; p.vx *= 0.7; p.vz *= 0.7; }
    dirty = true;
  }
  if (dirty) pool.pts.geometry.attributes.position.needsUpdate = true;
}

/* 短促闪光 */
function flashLight(x, y, z, color, intensity = 3, dist = 9, life = 0.25) {
  const l = new THREE.PointLight(color, intensity, dist);
  l.position.set(x, y, z);
  scene.add(l);
  fxList.push({ obj: l, age: 0, life, update(dt) { this.age += dt; l.intensity = intensity * (1 - this.age / this.life); } });
}

/* ============================================================
 * 弹道 & 特效
 * ============================================================ */
function spawnProj(m) {
  const color = m.dim === 'mon' ? 0xff4444 : dimAccent(m.dim);   // 怪物弹幕=红色
  const obj = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 10),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2 }));
  obj.position.set(m.x, 1.1, m.z);
  scene.add(obj);
  const glow = new THREE.PointLight(color, 1.6, 7);
  obj.add(glow);
  projectiles.set(m.id, { obj, dx: m.dx, dz: m.dz, speed: m.speed, color, trailT: 0 });
  sparks(m.x, 1.1, m.z, color, { count: 8, speed: 3, life: 0.3, gravity: 0, up: 0.2 });
  flashLight(m.x, 1.3, m.z, color, 2.2, 6, 0.18);
}

function ringFx(x, z, radius, color) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.8, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.15, z);
  scene.add(ring);
  fxList.push({ obj: ring, age: 0, life: 0.45, update(dt) {
    this.age += dt;
    const k = this.age / this.life;
    ring.scale.setScalar(1 + k * (radius - 1));
    ring.material.opacity = 0.9 * (1 - k);
  } });
}

/* BOSS技能预警：地面危险区。轮廓环常驻急闪标出最终半径，
 * 内部填充盘随 delaySec 由中心扩张到满——填满瞬间即落地，玩家据此走位躲避。 */
function warnFx(x, z, radius, delaySec, kind) {
  const color = kind === 'bstorm' ? 0xcc44ff : 0xff3344;
  const fill = new THREE.Mesh(new THREE.CircleGeometry(radius, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false }));
  fill.rotation.x = -Math.PI / 2;
  fill.position.set(x, 0.08, z);
  fill.scale.setScalar(0.001);
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.93, radius, 56),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.09, z);
  scene.add(fill); scene.add(ring);
  fxList.push({ obj: fill, age: 0, life: delaySec, update(dt) {
    this.age += dt;
    const k = Math.min(1, this.age / this.life);
    fill.scale.setScalar(Math.max(0.001, k));
    fill.material.opacity = 0.18 + 0.28 * k;                              // 越临近落地越红
    ring.material.opacity = 0.5 + 0.45 * Math.abs(Math.sin(this.age * 13)); // 急促闪烁警示
  }, done() { scene.remove(ring); ring.geometry.dispose(); ring.material.dispose(); fill.geometry.dispose(); fill.material.dispose(); } });
}

function burstFx(x, y, z, color) {
  const s = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 10),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }));
  s.position.set(x, y, z);
  scene.add(s);
  fxList.push({ obj: s, age: 0, life: 0.35, update(dt) {
    this.age += dt;
    const k = this.age / this.life;
    s.scale.setScalar(1 + k * 4);
    s.material.opacity = 0.85 * (1 - k);
  } });
}

function flash(obj) {
  obj.traverse((c) => {
    if (c.isMesh && c.material && c.material.emissive) {
      const old = c.material.emissiveIntensity;
      c.material.emissiveIntensity = 3;
      setTimeout(() => c.material.emissiveIntensity = old, 90);
    }
  });
}

function dmgNumber(pos, amt, color, crit) {
  const cv = document.createElement('canvas');
  cv.width = 320; cv.height = 96;
  const ctx = cv.getContext('2d');
  ctx.font = `bold ${crit ? 70 : 56}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = crit ? 9 : 7;
  ctx.strokeText(amt, 160, 66);
  ctx.fillText(amt, 160, 66);
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  const s = crit ? 1.5 : 1;
  sp.scale.set(3.6 * s, 1.1 * s, 1);
  sp.position.set(pos.x + (Math.random() - 0.5), pos.y + 2.2, pos.z);
  scene.add(sp);
  dmgSprites.push({ sp, age: 0 });
}

/* ---------- 头顶血条 ---------- */
function makeBar(ent, color) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(2.6, 0.65, 1);
  scene.add(sp);
  ent.bar = { sprite: sp, cv, tex, color };
  drawBar(ent);
  return ent.bar;
}
function drawBar(ent) {
  if (!ent.bar) return;
  const { cv, tex, color } = ent.bar;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, 256, 64);
  let label = ent.isMonster ? `${ent.name} Lv.${ent.level || 1}` : `${ent.name} Lv.${ent.level}`;
  let nameColor = ent.isMonster ? '#ffd56b' : '#fff';
  if (ent.isMonster) {
    // 按与玩家的等级差着色，一眼看出危险程度（配合 1-100 等级梯度）
    const d = (ent.level || 1) - (HUD.level || 1);
    if (d >= 10) { nameColor = '#ff3b3b'; label = '☠ ' + label; }   // 致命
    else if (d >= 5) nameColor = '#ff8a33';                          // 危险
    else if (d >= -2) nameColor = '#ffd56b';                         // 相当
    else if (d >= -6) nameColor = '#9be36b';                         // 轻松
    else nameColor = '#9a9ab5';                                      // 碾压
  }
  ctx.font = 'bold 30px sans-serif';
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 7;
  ctx.strokeText(label, 128, 26);
  ctx.fillStyle = nameColor;
  ctx.fillText(label, 128, 26);
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(46, 40, 164, 14);
  ctx.fillStyle = color;
  ctx.fillRect(48, 42, 160 * Math.max(0, ent.hp / ent.maxHp), 10);
  tex.needsUpdate = true;
}
function updateBar(ent) { drawBar(ent); }

/* ============================================================
 * HUD
 * ============================================================ */
const HUD = { level: 1, sk: { basic: 1, q: 1, e: 1, r: 1 }, skPts: 0, spd: 0 };
function updateYou(y) {
  HUD.level = y.level;
  if (y.sk) HUD.sk = y.sk;
  if (y.skPts != null) HUD.skPts = y.skPts;
  if (y.spd != null) HUD.spd = y.spd;
  for (const k of ['patk', 'matk', 'armor', 'mres', 'gold', 'maxHp', 'hp', 'exp', 'expNeed', 'kills', 'pvpKills',
                   'crit', 'critDmg', 'lifesteal', 'pen', 'cdr', 'tenacity', 'rankPts']) {
    if (y[k] != null) HUD[k] = y[k];
  }
  $('hp-fill').style.width = Math.max(0, y.hp / y.maxHp * 100) + '%';
  $('hp-text').textContent = (y.shield ? `🛡${y.shield} ` : '') + `${y.hp}/${y.maxHp}`;
  $('exp-fill').style.width = (y.exp / y.expNeed * 100) + '%';
  $('stat-line').textContent = `Lv.${y.level} ｜ 💰${y.gold} ｜ 击杀${y.kills} ｜ PvP${y.pvpKills}` + (HUD.skPts > 0 ? ` ｜ ✨技能点×${HUD.skPts}` : '');
  if (y.achEquip !== undefined) achEquip = y.achEquip;
  if (y.bagMode) bagMode = y.bagMode;
  if (me) me.hp = y.hp;
  if (!$('panel').classList.contains('hidden')) renderPanel();
}

/* ---------- 属性/背包/商店 面板 ---------- */
let panelTab = 'stats';
let rankData = [];
let rankMode = 'level';
const RAR_COLORS = ['#95a5a6', '#2ecc71', '#3498db', '#9b59b6', '#f39c12'];
function itemStatText(it) {
  const ef = enhMul(it);   // 强化放大基础属性（与服务器一致）
  const parts = [];
  if (it.patk) parts.push(`物攻+${Math.round(it.patk * ef)}`);
  if (it.matk) parts.push(`法攻+${Math.round(it.matk * ef)}`);
  if (it.armor) parts.push(`物防+${Math.round(it.armor * ef)}`);
  if (it.mres) parts.push(`法防+${Math.round(it.mres * ef)}`);
  if (it.hp) parts.push(`生命+${Math.round(it.hp * ef)}`);
  if (it.spd) parts.push(`移速+${it.spd}`);
  return parts.join(' ');
}
/* 装备名（含 🏆 至宝标记与 +N 强化等级） */
function itemName(it) {
  return `<span style="color:${RAR_COLORS[it.rar]}">${it.relic ? '🏆' : ''}${it.name}</span>${it.enh ? `<b style="color:#ffce54"> +${it.enh}</b>` : ''}`;
}
/* 特殊词条文本（暴击/吸血等），用金色高亮以区别基础属性 */
function itemAffixText(it) {
  const a = [];
  if (it.crit) a.push(`暴击+${it.crit}%`);
  if (it.critDmg) a.push(`暴伤+${it.critDmg}%`);
  if (it.lifesteal) a.push(`吸血+${it.lifesteal}%`);
  if (it.pen) a.push(`穿透+${it.pen}`);
  if (it.cdr) a.push(`冷却-${it.cdr}%`);
  if (it.tenacity) a.push(`韧性+${it.tenacity}%`);
  return a.length ? `<span style="color:#ffce54">✦ ${a.join(' ')}</span>` : '';
}
function itemFullText(it) {
  const base = itemStatText(it), af = itemAffixText(it);
  return base + (af ? '<br>' + af : '');
}
function renderPanel() {
  const panel = $('panel');
  if (!panel || panel.classList.contains('hidden')) return;
  document.querySelectorAll('.panel-tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === panelTab));
  const body = $('panel-body');
  const cn = (CLASS_NAMES[myDim] || {})[myCls] || myClsDef().role;
  if (panelTab === 'stats') {
    const def = myClsDef();
    body.innerHTML = `
      <div class="stat-grid">
        <div>🎖️ 职业</div><div>${def.icon} ${cn}（${def.role}）</div>
        <div>📈 等级</div><div>Lv.${HUD.level}（经验 ${HUD.exp || 0}/${HUD.expNeed || 0}）</div>
        <div>❤️ 体力(生命上限)</div><div>${HUD.maxHp || '-'}（当前 ${HUD.hp || 0}）</div>
        <div>⚔️ 物理攻击</div><div>${HUD.patk || 0}</div>
        <div>🔮 法术攻击</div><div>${HUD.matk || 0}</div>
        <div>🛡️ 物理防御</div><div>${HUD.armor || 0}</div>
        <div>✨ 法术防御</div><div>${HUD.mres || 0}</div>
        <div>👟 移动速度</div><div>${HUD.spd || myClsDef().speed}</div>
        <div>💥 暴击</div><div>${HUD.crit || 0}% ｜ 暴伤 ${100 + (HUD.critDmg || 50)}%</div>
        <div>🩸 吸血</div><div>${HUD.lifesteal || 0}%</div>
        <div>🗡️ 穿透</div><div>${HUD.pen || 0}</div>
        <div>⏱️ 冷却缩减</div><div>${HUD.cdr || 0}%</div>
        <div>🧱 韧性(抗控)</div><div>${HUD.tenacity || 0}%</div>
        <div>💰 金币</div><div>${HUD.gold || 0}</div>
        <div>🏅 段位</div><div><span style="color:${rankTier(HUD.rankPts || 0).color}">${rankTier(HUD.rankPts || 0).icon} ${rankTier(HUD.rankPts || 0).name}</span>（${HUD.rankPts || 0} 分，重叠战场/大混战击杀+分）</div>
        <div>🗡️ 击杀</div><div>野怪${HUD.kills || 0} / 玩家${HUD.pvpKills || 0}</div>
        <div>✨ 技能点</div><div>${HUD.skPts}（升级获得，点技能格上的＋加点）</div>
      </div>
      <div class="panel-sub">技能（${cn}）</div>
      ${['basic', 'q', 'e', 'r'].map((k) => {
        const s = def.skills[k];
        const lv = HUD.sk[k] || 1;
        return `<div class="skill-row"><b>${s.name}</b> <span class="sk-lv-tag">Lv.${lv}</span><br><span class="dim-text">${s.desc || ''}</span></div>`;
      }).join('')}`;
  } else if (panelTab === 'bag') {
    const eq = invData.equip || {};
    const slotNames = { weapon: '武器', helmet: '帽子', armor: '衣服', boots: '鞋子', acc: '饰品' };
    const enhBtn = (it, attr) => (it.enh || 0) >= ENH_MAX
      ? `<button disabled>满级 +${it.enh}</button>`
      : `<button ${attr}>🔨${enhCost(it)}金${(it.enh || 0) >= 4 ? `(${Math.round(enhRate(it.enh) * 100)}%)` : ''}</button>`;
    body.innerHTML = `
      <div class="panel-sub">已装备（点击名称卸下 · 🔨强化）</div>
      <div class="equip-row">${Object.keys(slotNames).map((s) => {
        const it = eq[s];
        return `<div class="equip-slot">${slotNames[s]}<br>${it
          ? `<span class="eq-name" data-slot="${s}">${itemName(it)}</span><br><small>${itemFullText(it)}</small><br>${enhBtn(it, `data-enh-slot="${s}"`)}`
          : '<span class="dim-text">空</span>'}</div>`;
      }).join('')}</div>
      <div class="panel-sub">背包（${(invData.inv || []).length}/24）</div>
      <div class="bagmode-row">背包满时：
        <button class="bagmode ${bagMode === 'sell' ? 'on' : ''}" data-bm="sell">💰 自动卖低品质</button>
        <button class="bagmode ${bagMode === 'enhance' ? 'on' : ''}" data-bm="enhance">🔨 自动强化穿戴</button>
      </div>
      ${(invData.inv || []).map((it, i) => `
        <div class="inv-row">
          <span>${itemName(it)} <small class="dim-text">${itemFullText(it)}</small></span>
          <span class="inv-btns"><button data-eq="${i}">装备</button>${enhBtn(it, `data-enh-i="${i}"`)}<button data-sell="${i}">卖${Math.round(it.val * 0.4)}金</button></span>
        </div>`).join('') || '<div class="dim-text">背包空空如也，去打怪掉装备或商店购买吧</div>'}`;
    body.querySelectorAll('[data-bm]').forEach((b) => b.onclick = () => { if (bagMode !== b.dataset.bm) net({ t: 'bagmode', mode: b.dataset.bm }); });
    body.querySelectorAll('[data-enh-i]').forEach((b) => b.onclick = () => net({ t: 'enhance', i: +b.dataset.enhI }));
    body.querySelectorAll('[data-enh-slot]').forEach((b) => b.onclick = () => net({ t: 'enhance', slot: b.dataset.enhSlot }));
    body.querySelectorAll('[data-eq]').forEach((b) => b.onclick = () => net({ t: 'equip', i: +b.dataset.eq }));
    body.querySelectorAll('[data-sell]').forEach((b) => b.onclick = () => net({ t: 'sell', i: +b.dataset.sell }));
    body.querySelectorAll('.eq-name').forEach((el) => el.onclick = () => { if ((invData.equip || {})[el.dataset.slot]) net({ t: 'unequip', slot: el.dataset.slot }); });
  } else if (panelTab === 'party') {
    const mine = playerName();
    const nearby = [...remotes.values()].filter((r) => r.dim === myDim && !partyMembers.some((m) => m.name === r.name));
    body.innerHTML = `
      <div class="panel-sub">👥 我的队伍（${partyMembers.length}/4）｜ 30米内队友共享70%经验</div>
      ${partyMembers.length === 0 ? '<div class="dim-text">暂无队伍。邀请下方同次元玩家一起讨伐世界BOSS吧！</div>'
        : partyMembers.map((m) => `
          <div class="inv-row"><span>${m.name === mine ? '⭐' : '👤'} <b>${m.name}</b> <small class="dim-text">Lv.${m.level} ${(CLASS_NAMES[myDim] || {})[m.cls] || ''}</small></span></div>`).join('')
        + `<div class="inv-row"><span></span><button class="btn" id="btn-party-leave">🚪 离开队伍</button></div>`}
      <div class="panel-sub" style="margin-top:10px">附近的同次元玩家</div>
      ${nearby.length === 0 ? '<div class="dim-text">附近暂无同次元玩家</div>' : nearby.map((r) => `
        <div class="inv-row"><span>👤 ${r.name} <small class="dim-text">Lv.${r.level}</small></span>
        <button class="btn btn-pinv" data-name="${r.name}">➕ 邀请</button></div>`).join('')}`;
    const lv = $('btn-party-leave');
    if (lv) lv.onclick = () => net({ t: 'party', op: 'leave' });
    body.querySelectorAll('.btn-pinv').forEach((b) => b.onclick = () => {
      net({ t: 'party', op: 'invite', name: b.dataset.name });
    });
  } else if (panelTab === 'ach') {
    const pct = achDefs.length ? Math.round(myAch.size / achDefs.length * 100) : 0;
    const cur = achDefs.find((a) => a.id === achEquip);
    body.innerHTML = `
      <div class="panel-sub">🏅 成就 ${myAch.size}/${achDefs.length}（${pct}%）｜ 每次可装备 1 个，享其专属增益</div>
      <div class="ach-bar"><span style="width:${pct}%"></span></div>
      <div class="ach-equipped">当前装备：${cur ? `${cur.icon} <b>${cur.name}</b> <span style="color:#7CFC9A">${cur.effText || ''}</span>` : '<span class="dim-text">无（点已解锁成就「装备」生效）</span>'}</div>
      <div class="ach-grid">
      ${achDefs.map((a) => {
        const got = myAch.has(a.id);
        const on = a.id === achEquip;
        return `<div class="ach-card ${got ? 'got' : 'locked'} ${on ? 'on' : ''}">
          <div class="ach-ic">${got ? a.icon : '🔒'}</div>
          <div class="ach-info">
            <div class="ach-nm">${a.name}</div>
            <div class="ach-ds">${a.desc}</div>
            ${a.effText ? `<div class="ach-eff">⚡ ${a.effText}</div>` : ''}
          </div>
          ${got ? `<button class="ach-eqbtn ${on ? 'on' : ''}" data-achid="${a.id}">${on ? '卸下' : '装备'}</button>` : '<span class="ach-chk">🔒</span>'}
        </div>`;
      }).join('')}</div>`;
    body.querySelectorAll('[data-achid]').forEach((b) => b.onclick = () => net({ t: 'achequip', id: b.dataset.achid }));
  } else if (panelTab === 'rank') {
    const dimIcon2 = (id) => { const d = DIMENSIONS.find((x) => x.id === id); return d ? d.icon : '❔'; };
    const dimAcc = (id) => { const d = DIMENSIONS.find((x) => x.id === id); return d ? d.color : '#aab'; };
    const mine = playerName();
    const ladder = rankMode === 'ladder';
    body.innerHTML = `
      <div class="rank-toggle">
        <button class="${ladder ? '' : 'on'}" data-rmode="level">📈 等级榜</button>
        <button class="${ladder ? 'on' : ''}" data-rmode="ladder">🏅 段位榜</button>
      </div>
      ${rankData.length === 0 ? '<div class="dim-text">加载中…</div>' : rankData.map((r, i) => {
        const pos = i < 3 ? ['🥇', '🥈', '🥉'][i] : (i + 1);
        const title = (CLASS_NAMES[r.dim] || {})[r.cls];
        const tier = rankTier(r.rankPts || 0);
        const cls = `rank-row${i < 3 ? ' top' + (i + 1) : ''}${r.name === mine ? ' self' : ''}`;
        const head = ladder
          ? `<span style="color:${tier.color}">${tier.icon}${tier.name} ${r.rankPts || 0}</span> ｜ ⚔️${r.pvpKills} ｜ Lv.${r.level}`
          : `${title ? `<span class="rank-tag">${title}</span>` : ''}Lv.${r.level} ｜ ⚔️PvP ${r.pvpKills} ｜ 🗡️${r.kills}`;
        return `<div class="${cls}">
          <div class="rank-pos">${pos}</div>
          <div class="rank-main">
            <div class="rank-name"><span class="dim-ic">${dimIcon2(r.dim)}</span><span style="color:${dimAcc(r.dim)}">${r.name}</span>${r.online ? '<span class="rank-dot" title="在线"></span>' : ''}</div>
            <div class="rank-sub">${head}${r.ach ? ` ｜ 🏅×${r.ach}` : ''}</div>
          </div>
        </div>`;
      }).join('')}`;
    body.querySelectorAll('[data-rmode]').forEach((b) => b.onclick = () => {
      if (rankMode === b.dataset.rmode) return;
      rankMode = b.dataset.rmode; rankData = []; renderPanel(); net({ t: 'rank', mode: rankMode });
    });
  } else {
    body.innerHTML = `
      <div class="panel-sub">商店（金币：💰${HUD.gold || 0}）</div>
      ${shopData.map((it) => `
        <div class="inv-row">
          <span><span style="color:${RAR_COLORS[it.rar]}">${it.name}</span> <small class="dim-text">[${({ weapon: '武器', helmet: '帽子', armor: '衣服', boots: '鞋子', acc: '饰品' })[it.slot]}] ${itemFullText(it)}</small></span>
          <span class="inv-btns"><button data-buy="${it.id}">💰${it.price}</button></span>
        </div>`).join('')}`;
    body.querySelectorAll('[data-buy]').forEach((b) => b.onclick = () => net({ t: 'buy', id: b.dataset.buy }));
  }
}

function setWar(w) {
  const wasActive = warInfo && warInfo.active;
  warInfo = w;
  if (w && w.active && !wasActive && joined) AUDIO.sfx('warhorn', 0.7);
  renderWarBanner();
}
function renderWarBanner() {
  const el = $('war-banner'), btn = $('btn-war');
  if (!warInfo || !joined) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  if (warInfo.active) {
    const mine = myDim === warInfo.a || myDim === warInfo.b;
    const remain = Math.max(0, Math.ceil((warInfo.endsAt - Date.now()) / 1000));
    el.querySelector('#war-text').innerHTML =
      `🌀 重叠战场：<b>${dimName(warInfo.a)}</b> ${warInfo.killsA} : ${warInfo.killsB} <b>${dimName(warInfo.b)}</b> ｜ 剩余 ${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, '0')}`;
    btn.classList.toggle('hidden', !mine);
    btn.textContent = curRoom === 'war' ? '↩️ 撤离战场' : '⚔️ 进入战场';
  } else {
    const remain = Math.max(0, Math.ceil((warInfo.nextAt - Date.now()) / 1000));
    el.querySelector('#war-text').textContent = `⏳ 下次次元重叠：${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, '0')} 后`;
    btn.classList.add('hidden');
  }
}
setInterval(renderWarBanner, 1000);

/* ---------- 组队 ---------- */
let partyMembers = [];
let pendingInviteFrom = null;
let inviteTimer;
let achDefs = [];
let myAch = new Set();
let achEquip = null;
let bagMode = 'sell';

function renderPartyHud() {
  const el = $('party-hud');
  if (partyMembers.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = partyMembers.map((m) => {
    const cn = (CLASS_NAMES[myDim] || {})[m.cls] || '';
    const pct = Math.max(0, Math.min(100, m.hp / m.maxHp * 100));
    return `<div class="party-mem" data-name="${m.name}">
      <span>${m.name === playerName() ? '⭐' : '👤'} ${m.name} <small class="dim-text">Lv.${m.level} ${cn}</small></span>
      <div class="pm-bar"><div class="pm-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
}

/* 队友血条实时刷新（从快照里的同房间实体取血量） */
function updatePartyHud() {
  if (partyMembers.length === 0) return;
  const byName = new Map();
  for (const r of remotes.values()) byName.set(r.name, r);
  for (const m of partyMembers) {
    const el = document.querySelector(`.party-mem[data-name="${CSS.escape(m.name)}"] .pm-fill`);
    if (!el) continue;
    let hp = m.hp, max = m.maxHp;
    if (m.name === playerName()) { hp = HUD.hp ?? hp; max = HUD.maxHp ?? max; }
    else { const r = byName.get(m.name); if (r) { hp = r.hp; max = r.maxHp; } }
    el.style.width = `${Math.max(0, Math.min(100, hp / max * 100))}%`;
  }
}

function playerName() { return (lastJoin && lastJoin.name) || ''; }

/* ---------- 五次元大混战横幅 ---------- */
let meleeInfo = null;
function renderMeleeBanner() {
  const el = $('melee-banner'), btn = $('btn-melee');
  if (!el || !joined) { if (el) el.classList.add('hidden'); return; }
  if (!meleeInfo || !meleeInfo.active) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const remain = Math.max(0, Math.ceil((meleeInfo.endsAt - Date.now()) / 1000));
  const mm = Math.floor(remain / 60), ss = String(remain % 60).padStart(2, '0');
  el.querySelector('#melee-text').textContent = `🔥 五次元大混战进行中！存活最多的次元大胜 ｜ 剩余 ${mm}:${ss}`;
  btn.textContent = curRoom === 'melee' ? '↩️ 撤离' : '⚔️ 杀入混战';
  btn.onclick = () => { AUDIO.sfx('click', 0.6); net({ t: 'melee', enter: curRoom === 'melee' ? 0 : 1 }); };
}
setInterval(() => { if (meleeInfo && meleeInfo.active) renderMeleeBanner(); }, 1000);

/* ---------- 世界BOSS横幅 ---------- */
let bossInfo = null;
function setBoss(b) {
  bossInfo = b && b.alive ? b : null;
  const el = $('boss-banner');
  if (!el) return;
  if (!bossInfo) { el.classList.add('hidden'); return; }  // 横幅在 #hud 内，未入场时随 HUD 隐藏
  el.classList.remove('hidden');
  $('boss-text').textContent = bossInfo.dim === myDim
    ? `🔥 世界BOSS【${bossInfo.name}】就在本次元BOSS巢穴！讨伐必得史诗装备！`
    : `🔥 世界BOSS【${bossInfo.name}】正在肆虐【${dimName(bossInfo.dim)}】…`;
}

function feed(msg) {
  const el = document.createElement('div');
  el.className = 'feed-item';
  el.textContent = msg;
  $('feed').prepend(el);
  while ($('feed').children.length > 6) $('feed').lastChild.remove();
  setTimeout(() => el.remove(), 12000);
}

/* ---------- 次元聊天 ---------- */
function openChat() {
  $('chatbar').classList.remove('hidden');
  $('chat-input').focus();
}
function closeChat() {
  $('chatbar').classList.add('hidden');
  $('chat-input').blur();
}
function sendChat() {
  const msg = $('chat-input').value.trim();
  if (msg) net({ t: 'chat', msg });
  $('chat-input').value = '';
  closeChat();
}

let levelupTimer;
function levelUpBanner(level) {
  const el = $('levelup-banner');
  if (!el) return;
  const extra = level === 3 ? '　E技能解锁！' : level === 5 ? '　R技能解锁！' : '';
  el.innerHTML = `🆙 升级！ Lv.${level}<small>获得技能点${extra}</small>`;
  el.classList.remove('hidden');
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(levelupTimer);
  levelupTimer = setTimeout(() => el.classList.add('hidden'), 1500);
}

let achTimer;
function achBanner(a) {
  const el = $('ach-banner');
  if (!el) return toast(`${a.icon} 成就解锁：【${a.name}】`);
  el.innerHTML = `<div class="ab-ic">${a.icon}</div><div><div class="ab-t">🏅 成就解锁</div><div class="ab-n">${a.name}</div><div class="ab-d">${a.desc}</div></div>`;
  el.classList.remove('hidden');
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  try { AUDIO.sfx('coin', 0.6); } catch (e) {}
  clearTimeout(achTimer);
  achTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

let toastTimer;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 3000);
}
function toast2(msg) { feed(msg); }

/* 技能栏冷却 + 技能等级/加点状态 */
function renderSkillBar() {
  const t = performance.now();
  const def = myClsDef();
  for (const k of ['basic', 'q', 'e', 'r']) {
    const slot = $('sk-' + k);
    const remain = Math.max(0, cds[k] - t);
    const pct = remain / cdOf(k);
    slot.querySelector('.cd').style.height = (pct * 100) + '%';
    const sk = def.skills[k];
    const locked = !!(sk.minLvl && HUD.level < sk.minLvl);
    slot.classList.toggle('locked', locked);
    const lv = (HUD.sk && HUD.sk[k]) || 1;
    const lvEl = slot.querySelector('.sk-lv');
    if (lvEl) lvEl.textContent = lv > 1 ? 'Lv' + lv : '';
    const plus = slot.querySelector('.sk-plus');
    if (plus) plus.classList.toggle('hidden', !(HUD.skPts > 0 && !locked));   // 技能无上限
  }
  const dPct = Math.max(0, dodgeCd - t) / 1200;
  $('sk-dodge').querySelector('.cd').style.height = (dPct * 100) + '%';
  const cap = $('sk-pet');
  if (cap && !cap.classList.contains('hidden')) {
    const cd = (dimSkillDef && dimSkillDef.cd) || 3000;
    const remain = Math.max(0, (capCdEnd || 0) - t);
    cap.querySelector('.cd').style.height = (remain / cd * 100) + '%';
  }
}
let capCdEnd = 0;
let dimSkillDef = null;
/* 控制状态（被服务器施加的眩晕/定身/减速） */
const cc = { stunUntil: 0, rootUntil: 0, slowUntil: 0, slowPct: 0 };
const ccHardUntil = () => Math.max(cc.stunUntil, cc.rootUntil);              // 不能移动的截止时刻
const ccSlowMul = () => (performance.now() < cc.slowUntil ? 1 - cc.slowPct : 1);
const CC_NAME = { stun: '眩晕', root: '定身', slow: '减速' };
function onCc(m) {
  const t = performance.now();
  if (m.kind === 'cleanse') { cc.stunUntil = cc.rootUntil = cc.slowUntil = 0; cc.slowPct = 0; toast('✨ 已净化所有控制'); return; }
  if (m.kind === 'slow') { cc.slowUntil = t + m.ms; cc.slowPct = m.pct || 0.3; }
  else if (m.kind === 'root') cc.rootUntil = t + m.ms;
  else cc.stunUntil = t + m.ms;
  toast(`💫 你被${CC_NAME[m.kind] || '控制'}了！`);
}
/* 任意实体被控时脚下闪一下提示环 */
function onCcFx(m) {
  const p = (m.id === myId) ? (me && me.obj && me.obj.position) : dimEntPos(m.id);
  const col = m.kind === 'slow' ? 0x3aa0ff : m.kind === 'root' ? 0x9b59b6 : 0xffd166;
  if (p) ringFx(p.x, p.z, m.kind === 'stun' ? 1.8 : 2.2, col);
}

/* 次元技能视觉特效 */
function dimEntPos(id) {
  if (id === myId) return me && me.obj && me.obj.position;
  const r = remotes.get(id);
  return r && r.obj && r.obj.position;
}
function onDimFx(m) {
  const p = dimEntPos(m.id);
  if (m.kind === 'shield') {
    if (!p) return;
    const sph = new THREE.Mesh(new THREE.SphereGeometry(1.5, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x00a8ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
    sph.position.copy(p); sph.position.y += 1;
    scene.add(sph);
    fxList.push({ obj: sph, age: 0, life: 6, update(dt) { this.age += dt; sph.position.copy(dimEntPos(m.id) || sph.position); sph.position.y += 1; sph.material.opacity = 0.32 * (1 - this.age / 6) + 0.08; } });
  } else if (m.kind === 'heal') {
    if (p) { ringFx(p.x, p.z, 2.5, 0x2ecc71); flashLight(p.x, 1.5, p.z, 0x2ecc71, 2.5, 8, 0.5); }
  } else if (m.kind === 'blink') {
    if (p) burstFx(p.x, 1.1, p.z, 0xe84393);
    burstFx(m.x, 1.1, m.z, 0xe84393);
    flashLight(m.x, 1.2, m.z, 0xe84393, 3, 9, 0.4);
  } else if (m.kind === 'field') {
    ringFx(m.x, m.z, (m.r || 6) * 1.1, 0x9b59b6);
    flashLight(m.x, 1.5, m.z, 0x9b59b6, 3.5, 14, 0.5);
  } else if (m.kind === 'emp') {
    // 磁暴电磁脉冲：青色双环 + 强光
    ringFx(m.x, m.z, (m.r || 6) * 1.1, 0x00d8ff);
    ringFx(m.x, m.z, (m.r || 6) * 0.6, 0x66f0ff);
    flashLight(m.x, 1.6, m.z, 0x00d8ff, 4, 16, 0.45);
    sparks(m.x, 1.0, m.z, 0x66f0ff, { count: 16, speed: 5, life: 0.5 });
  }
}

function updateDimSkillSlot() {
  const cap = $('sk-pet');
  if (!cap) return;
  cap.classList.remove('hidden');   // 每个次元都有专属技能
  cap.querySelector('.sk-name').textContent = dimSkillDef ? dimSkillDef.name : '次元';
}

/* ============================================================
 * 主循环
 * ============================================================ */
let lastNetT = 0;
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;

  // 英雄选择预览转盘
  if (!joined) {
    if (preview.ready && preview.hero) {
      preview.hero.rotation.y += dt * 0.55;
      MODELS.drive(preview.hero, 'idle', dt);
      if (preview.pedestal) preview.pedestal.rotation.y -= dt * 0.2;
    }
    if (preview.scene) renderer.render(preview.scene, preview.camera);
    return;
  }

  if (me && joined) {
    // 移动
    if (!dead) {
      const t = performance.now();
      let vx = 0, vz = 0, speed = HUD.spd || myClsDef().speed;
      const hardCC = t < ccHardUntil();   // 眩晕/定身：完全无法移动（含冲刺）
      if (t < burstT && !hardCC) {
        vx = burstDir[0]; vz = burstDir[1]; speed = burstSpeed;
        if (rushTrail > 0) { rushTrail -= dt; sparks(me.x, 0.7, me.z, dimAccent(myDim), { count: 3, speed: 1.2, life: 0.4, gravity: 0, up: 0.3 }); }
      }
      else if (!hardCC) {
        const mv = moveVec();
        if (mv) { vx = mv[0]; vz = mv[1]; }
        speed *= ccSlowMul();   // 减速
      }
      if (vx || vz) {
        me.x = Math.max(-MAP_HALF, Math.min(MAP_HALF, me.x + vx * speed * dt));
        me.z = Math.max(-MAP_HALF, Math.min(MAP_HALF, me.z + vz * speed * dt));
        const rp = resolveObstacles(me.x, me.z, 0.6);   // 撞树木/建筑停下
        me.x = rp[0]; me.z = rp[1];
        if (time - me.attackT > 0.25) me.obj.rotation.y = Math.atan2(vx, vz);
        me.anim = 'run';
      } else me.anim = 'idle';
      me.obj.position.set(me.x, me.obj.position.y, me.z);
    } else me.anim = 'dead';

    if (!MODELS.drive(me.obj, me.anim, dt)) MODELS.animateHumanoid(me.obj, me.anim, time, me.attackT);
    // 跳跃竖直弧线（叠加在动画之上，GLTF/程序化模型通用）
    if (performance.now() < jumpUntil) {
      const k = 1 - (jumpUntil - performance.now()) / JUMP_MS;
      me.obj.position.y = Math.sin(k * Math.PI) * JUMP_H;
    }

    // 网络同步 15Hz
    if (time - lastNetT > 0.066 && !dead) {
      lastNetT = time;
      net({ t: 'mv', x: +me.x.toFixed(2), z: +me.z.toFixed(2), ry: +me.obj.rotation.y.toFixed(2), anim: me.anim });
    }

    // 相机
    const cx = me.x + Math.sin(camYaw) * camDist * Math.cos(camPitch);
    const cz = me.z + Math.cos(camYaw) * camDist * Math.cos(camPitch);
    const cy = 1.5 + Math.sin(camPitch) * camDist;
    camera.position.lerp(new THREE.Vector3(cx, cy, cz), 0.25);
    camera.lookAt(me.x, 1.6, me.z);

    // 死亡复活倒计时
    if (dead) {
      const remain = Math.max(0, 4 - (Date.now() - deadAt) / 1000);
      $('death-cd').textContent = remain > 0 ? remain.toFixed(1) + 's' : '';
      $('btn-respawn').disabled = remain > 0;
      $('btn-respawn').textContent = (curRoom === 'war' || curRoom === 'melee') ? '↩️ 回本次元复活' : '⚔️ 立即复活';
      if (remain <= 0 && !$('btn-respawn').dataset.auto) {
        $('btn-respawn').dataset.auto = '1';
        setTimeout(() => { net({ t: 'respawn' }); delete $('btn-respawn').dataset.auto; }, 300);
      }
    }
    renderSkillBar();
  }

  // 远程玩家插值
  for (const r of remotes.values()) {
    r.obj.position.x += (r.tx - r.obj.position.x) * 0.2;
    r.obj.position.z += (r.tz - r.obj.position.z) * 0.2;
    let dy = r.try_ - r.obj.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    r.obj.rotation.y += dy * 0.25;
    if (!MODELS.drive(r.obj, r.anim, dt)) MODELS.animateHumanoid(r.obj, r.anim, time, r.attackT);
    if (r.bar) r.bar.sprite.position.set(r.obj.position.x, 2.55, r.obj.position.z);
  }
  // 宝宝插值（与怪物同款驱动，体型小、绿色血条）
  for (const pe of petsEnt.values()) {
    pe.obj.position.x += (pe.tx - pe.obj.position.x) * 0.22;
    pe.obj.position.z += (pe.tz - pe.obj.position.z) * 0.22;
    let dy = pe.try_ - pe.obj.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    pe.obj.rotation.y += dy * 0.25;
    if (pe.state === 'attack' && pe.prevState !== 'attack') MODELS.monsterAttack(pe.obj);
    pe.prevState = pe.state;
    const st = pe.state === 'chase' || pe.state === 'attack' ? 'run' : 'idle';
    if (!MODELS.drive(pe.obj, st, dt)) MODELS.animateMonster(pe.obj, pe.state, time);
    if (pe.bar) pe.bar.sprite.position.set(pe.obj.position.x, 1.3 + pe.tier * 0.3, pe.obj.position.z);
  }
  // 怪物插值
  for (const mo of monsters.values()) {
    mo.obj.position.x += (mo.tx - mo.obj.position.x) * 0.2;
    mo.obj.position.z += (mo.tz - mo.obj.position.z) * 0.2;
    let dy = mo.try_ - mo.obj.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    mo.obj.rotation.y += dy * 0.2;
    if (mo.state === 'attack' && mo.prevState !== 'attack') MODELS.monsterAttack(mo.obj);
    mo.prevState = mo.state;
    const st = mo.state === 'chase' || mo.state === 'attack' ? 'run' : mo.state === 'dead' ? 'dead' : 'idle';
    if (!MODELS.drive(mo.obj, st, dt)) MODELS.animateMonster(mo.obj, mo.state, time);
    if (mo.bar) {
      mo.bar.sprite.position.set(mo.obj.position.x, 1.2 + mo.tier * 0.45, mo.obj.position.z);
      mo.bar.sprite.visible = mo.state !== 'dead';
    }
  }
  // 弹道（带拖尾粒子）
  for (const pr of projectiles.values()) {
    pr.obj.position.x += pr.dx * pr.speed * dt;
    pr.obj.position.z += pr.dz * pr.speed * dt;
    pr.trailT += dt;
    if (pr.trailT > 0.035) {
      pr.trailT = 0;
      sparks(pr.obj.position.x, pr.obj.position.y, pr.obj.position.z, pr.color, { count: 2, speed: 0.7, life: 0.32, gravity: 0, up: 0.1 });
    }
  }
  updateParticles(dt);
  // 特效
  for (let i = fxList.length - 1; i >= 0; i--) {
    const fx = fxList[i];
    fx.update(dt);
    if (fx.age >= fx.life) { scene.remove(fx.obj); if (fx.done) fx.done(); fxList.splice(i, 1); }
  }
  // 伤害数字
  for (let i = dmgSprites.length - 1; i >= 0; i--) {
    const d = dmgSprites[i];
    d.age += dt;
    d.sp.position.y += dt * 1.6;
    d.sp.material.opacity = 1 - d.age / 1.1;
    if (d.age > 1.1) { scene.remove(d.sp); dmgSprites.splice(i, 1); }
  }

  renderer.render(scene, camera);
}

/* ---------- 工具 ---------- */
const dimName = (id) => { const d = DIMENSIONS.find((x) => x.id === id); return d ? d.name : id || '?'; };
const dimIcon = (id) => { const d = DIMENSIONS.find((x) => x.id === id); return d ? d.icon : ''; };
const dimAccent = (id) => THEMES[id] ? THEMES[id].accent : 0xffffff;
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashCode(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
