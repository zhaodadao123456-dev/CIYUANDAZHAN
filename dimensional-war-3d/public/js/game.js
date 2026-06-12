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
const SKILL_CDS = { basic: 600, q: 3000, e: 7000, r: 12000 };
const MAP_HALF = 45;

/* ---------- 全局状态 ---------- */
let renderer, scene, camera, clock;
let ws = null, myId = null, myDim = null, curRoom = null;
let me = null;                 // {obj,x,z,ry,anim,hp,maxHp,level,...}
const remotes = new Map();     // id -> remote player
const monsters = new Map();    // id -> monster
const projectiles = new Map(); // id -> proj
const fxList = [];             // 特效
const dmgSprites = [];
let keys = {}, camYaw = 0, camPitch = 0.55, camDist = 11;
let cds = { basic: 0, q: 0, e: 0, r: 0 };
let burstT = 0, burstSpeed = 0, burstDir = [0, 0], dodgeCd = 0, rushTrail = 0;
let warInfo = { active: false };
let dead = false, deadAt = 0;
let joined = false;
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

  // 次元选择卡片
  $('dim-cards').innerHTML = DIMENSIONS.map((d) => `
    <div class="dim-card" data-dim="${d.id}" style="border-color:${d.color}">
      <div class="dc-icon">${d.icon}</div>
      <div class="dc-name" style="color:${d.color}">${d.name}</div>
    </div>`).join('');
  let chosen = null;
  document.querySelectorAll('.dim-card').forEach((el) => el.onclick = () => {
    chosen = el.dataset.dim;
    document.querySelectorAll('.dim-card').forEach((x) => x.classList.remove('chosen'));
    el.classList.add('chosen');
    setPreviewHero(chosen);
  });
  $('btn-join').onclick = async () => {
    const name = $('join-name').value.trim();
    if (!name) return toast('请输入昵称');
    if (!chosen) return toast('请选择降临次元');
    const btn = $('btn-join');
    btn.disabled = true;
    await MODELS.loadAssets((done, total) => { btn.textContent = `⏳ 加载次元资产 ${done}/${total}…`; });
    btn.textContent = '⚔️ 降临次元';
    btn.disabled = false;
    connect(name, chosen);
  };

  initParticles();
  initPreview();
  // 页面打开即后台预载资产；就绪后展示默认英雄
  MODELS.loadAssets().then(() => { setPreviewHero(chosen || 'xiuxian'); });

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
  bindTap('btn-atk', () => castSkill('basic'));
}

/* ============================================================
 * 英雄选择 3D 预览转盘
 * ============================================================ */
function initPreview() {
  preview.scene = new THREE.Scene();
  preview.scene.background = new THREE.Color(0x0b0b1c);
  preview.scene.fog = new THREE.Fog(0x0b0b1c, 8, 22);
  preview.camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 50);
  preview.camera.position.set(0, 1.8, 5.2);
  preview.camera.lookAt(0, 0.95, 0);
  preview.scene.add(new THREE.HemisphereLight(0xccddff, 0x202035, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2.5, 4, 3);
  preview.scene.add(key);
  const rim = new THREE.DirectionalLight(0x8888ff, 1.2);
  rim.position.set(-3, 2.5, -3);
  preview.scene.add(rim);
  window.addEventListener('resize', () => {
    preview.camera.aspect = innerWidth / innerHeight;
    preview.camera.updateProjectionMatrix();
  });
}

function setPreviewHero(dimId) {
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

  preview.hero = MODELS.makeHero(dimId, accent);
  preview.scene.add(preview.hero);
  // 切换时播一段攻击动作展示
  setTimeout(() => { if (preview.hero) MODELS.attackAnim(preview.hero, dimId, 'basic'); }, 350);
  preview.ready = true;
}

/* ============================================================
 * 网络
 * ============================================================ */
function connect(name, dim) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, dim }));
  ws.onmessage = (ev) => onMsg(JSON.parse(ev.data));
  ws.onclose = () => { if (joined) { toast('🔌 与服务器断开，3秒后刷新'); setTimeout(() => location.reload(), 3000); } };
}
const net = (obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

function onMsg(m) {
  switch (m.t) {
    case 'welcome': {
      myId = m.id;
      myDim = m.you.dim;
      enterRoom(m.room, m);
      if (m.first) {
        joined = true;
        $('join-screen').classList.add('hidden');
        $('hud').classList.remove('hidden');
        toast(`🌌 欢迎降临【${dimName(myDim)}】！打怪升级，等待次元重叠！`);
      }
      AUDIO.setMusic(m.room === 'war' ? 'war' : 'world');
      updateYou(m.you);
      setWar(m.war);
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
        toast(`🆙 升级到 Lv.${m.level}！${m.level === 3 ? 'E技能解锁！' : m.level === 5 ? 'R技能解锁！' : ''}`);
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
    case 'feed': feed(m.msg); break;
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
  for (const pr of projectiles.values()) scene.remove(pr.obj);
  remotes.clear(); monsters.clear(); projectiles.clear();

  buildMap(roomId);

  // 本地英雄
  if (me && me.obj) scene.remove(me.obj);
  const accent = dimAccent(myDim);
  const obj = MODELS.makeHero(myDim, accent);
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
  scene.fog = new THREE.Fog(theme.fog, 30, 120);
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
  sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
  sun.shadow.camera.far = 160;
  sun.shadow.bias = -0.0008;
  add(sun);

  // 主题摆件
  const rng = mulberry32(roomId === 'war' ? 999 : hashCode(roomId));
  const themeKey = roomId === 'war' ? 'war' : myDim;
  if (roomId === 'war') buildWarLayout(add, rng, theme);
  else buildHomeLayout(themeKey, add, rng, theme);
  // 战场：双方出生区光柱
  if (roomId === 'war') {
    for (const [x, c] of [[-38, dimAccent(warInfo.a)], [38, dimAccent(warInfo.b)]]) {
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

  // 3) 野外散布（避开大道与巢穴方向）
  const lairA = (typeof LAIR_ANGLES !== 'undefined' && LAIR_ANGLES[themeKey]) || 0;
  const count = themeKey === 'cyber' ? 38 : 48;
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    if (inRoad(a)) continue;
    let da = Math.abs(a - lairA);
    if (da > Math.PI) da = Math.PI * 2 - da;
    const r = 13 + rng() * 20;
    if (da < 0.45 && r > 28) continue;  // 巢穴前留空地
    const o = MODELS.makeProp(themeKey, rng) || fallback();
    o.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    o.rotation.y = rng() * 6.28;
    add(o);
  }

  // 4) Boss 巢穴：立柱环 + 红色凶光 + 地面警示环
  const lx = Math.cos(lairA) * 37, lz = Math.sin(lairA) * 37;
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

  // 对称掩体阵（沿X轴镜像，给两侧推进提供掩护）
  const covers = [
    ['rubble_large', 10, 0], ['rubble_large', 22, 6], ['rubble_half', 22, -6],
    ['pillar', 16, 12], ['pillar', 16, -12], ['gravestone', 28, 0],
    ['rubble_half', 8, 14], ['rubble_large', 8, -14], ['fence_pillar_broken', 30, 10], ['fence_pillar_broken', 30, -10],
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
  for (let i = -3; i <= 3; i++) {
    if (i === 0) continue;
    const o = MODELS.makePropNamed('war', 'torch_lit', 1);
    if (o) { o.position.set(i * 6, 0, i % 2 === 0 ? 3 : -3); add(o); }
  }
  // 外圈废墟
  for (let i = 0; i < 18; i++) {
    const a = rng() * Math.PI * 2;
    const r = 34 + rng() * 9;
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
  const obj = MODELS.makeHero(p.dim, dimAccent(p.dim));
  obj.position.set(p.x, 0, p.z);
  scene.add(obj);
  const r = { ...p, obj, tx: p.x, tz: p.z, try_: p.ry, attackT: 0, anim: p.dead ? 'dead' : p.anim };
  r.bar = makeBar(r, p.dim === myDim ? '#2ecc71' : '#ff5566');
  remotes.set(p.id, r);
}
function removeRemote(id) {
  const r = remotes.get(id);
  if (r) { disposeEntity(r); remotes.delete(id); }
}
function addMonsterEnt(id, x, z, ry, state, hp, maxHp, tier, name) {
  const obj = MODELS.makeMonster(tier, THEMES[curRoom === 'war' ? 'war' : myDim].accent);
  obj.position.set(x, 0, z);
  scene.add(obj);
  const mo = { id, obj, tx: x, tz: z, try_: ry, state, hp, maxHp, tier, name, isMonster: true };
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

  const seenM = new Set();
  for (const [id, x, z, ry, state, hp, maxHp, tier, name] of m.ms) {
    seenM.add(id);
    let mo = monsters.get(id);
    if (!mo) { addMonsterEnt(id, x, z, ry, state, hp, maxHp, tier, name); continue; }
    mo.tx = x; mo.tz = z; mo.try_ = ry; mo.state = state;
    if (mo.hp !== hp) { mo.hp = hp; drawBar(mo); }
  }
  for (const id of [...monsters.keys()]) if (!seenM.has(id)) { disposeEntity(monsters.get(id)); monsters.delete(id); }
}

function onDmg(m) {
  if (m.kind === 'm') {
    const mo = monsters.get(m.id);
    if (mo) {
      mo.hp = m.hp; drawBar(mo);
      dmgNumber(mo.obj.position, m.amt, m.by === myId ? '#ffe14d' : '#ffffff');
      flash(mo.obj);
      if (m.by === myId) AUDIO.sfx('hit', 0.6);
      sparks(mo.obj.position.x, 1.0, mo.obj.position.z, 0xffcc55, { count: 7, speed: 4, life: 0.4 });
    }
  } else {
    if (m.id === myId) {
      dmgNumber(me.obj.position, m.amt, '#ff5566');
      AUDIO.sfx('hurt', 0.7);
      $('hurt').classList.remove('hidden');
      setTimeout(() => $('hurt').classList.add('hidden'), 120);
    } else {
      const r = remotes.get(m.id);
      if (r) { r.hp = m.hp; drawBar(r); dmgNumber(r.obj.position, m.amt, m.by === myId ? '#ffe14d' : '#ffffff'); flash(r.obj); }
    }
  }
}

/* ============================================================
 * 输入与操控
 * ============================================================ */
function bindInput() {
  addEventListener('keydown', (e) => {
    if (!joined) return;
    keys[e.code] = true;
    if (e.code === 'KeyQ') castSkill('q');
    if (e.code === 'KeyE') castSkill('e');
    if (e.code === 'KeyR') castSkill('r');
    if (e.code === 'Space') { e.preventDefault(); dodge(); }
  });
  addEventListener('keyup', (e) => keys[e.code] = false);

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
}

/* 相机相对移动向量（键盘 WASD 或虚拟摇杆） */
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
  const t = performance.now();
  if (t < cds[kind]) return;
  const lvlReq = { e: 3, r: 5 }[kind];
  if (lvlReq && (HUD.level || 1) < lvlReq) return toast(`⚠️ ${kind.toUpperCase()} 技能需要 Lv.${lvlReq}`);
  cds[kind] = t + SKILL_CDS[kind];

  // 朝向：锁定最近敌人，否则面前
  let dx = Math.sin(me.obj.rotation.y), dz = Math.cos(me.obj.rotation.y);
  const tgt = nearestEnemy(kind === 'q' ? 24 : 9);
  if (tgt) {
    const vx = tgt.obj.position.x - me.x, vz = tgt.obj.position.z - me.z;
    const l = Math.hypot(vx, vz) || 1;
    dx = vx / l; dz = vz / l;
    me.obj.rotation.y = Math.atan2(dx, dz);
  }
  me.attackT = clock.elapsedTime;
  MODELS.attackAnim(me.obj, myDim, kind);
  AUDIO.sfx(kind === 'q' ? 'laser' : kind === 'e' ? 'explosion' : 'swing', kind === 'basic' ? 0.8 : 1, kind === 'r' ? 0.8 : 1);
  if (kind === 'e') {
    ringFx(me.x, me.z, 5.5, dimAccent(myDim));
    sparks(me.x, 0.4, me.z, dimAccent(myDim), { count: 34, speed: 8, life: 0.7, gravity: -6, up: 1.4 });
    flashLight(me.x, 1.5, me.z, dimAccent(myDim), 4, 12, 0.35);
  }
  if (kind === 'r') { burst([dx, dz], 25, 180); rushTrail = 0.2; } // 突进冲刺+残影拖尾
  net({ t: 'cast', k: kind, dx, dz });
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
  const color = dimAccent(m.dim);
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

function dmgNumber(pos, amt, color) {
  const cv = document.createElement('canvas');
  cv.width = 192; cv.height = 96;
  const ctx = cv.getContext('2d');
  ctx.font = 'bold 56px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 7;
  ctx.strokeText(amt, 96, 64);
  ctx.fillText(amt, 96, 64);
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(2.2, 1.1, 1);
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
  const label = ent.isMonster ? `${ent.name} T${ent.tier}` : `${ent.name} Lv.${ent.level}`;
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 4;
  ctx.strokeText(label, 128, 24);
  ctx.fillText(label, 128, 24);
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(48, 34, 160, 14);
  ctx.fillStyle = color;
  ctx.fillRect(50, 36, 156 * Math.max(0, ent.hp / ent.maxHp), 10);
  tex.needsUpdate = true;
}
function updateBar(ent) { drawBar(ent); }

/* ============================================================
 * HUD
 * ============================================================ */
const HUD = { level: 1 };
function updateYou(y) {
  HUD.level = y.level;
  $('hp-fill').style.width = Math.max(0, y.hp / y.maxHp * 100) + '%';
  $('hp-text').textContent = `${y.hp}/${y.maxHp}`;
  $('exp-fill').style.width = (y.exp / y.expNeed * 100) + '%';
  $('stat-line').textContent = `Lv.${y.level} ｜ 💰${y.gold} ｜ 击杀${y.kills} ｜ PvP${y.pvpKills}`;
  if (me) me.hp = y.hp;
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

function feed(msg) {
  const el = document.createElement('div');
  el.className = 'feed-item';
  el.textContent = msg;
  $('feed').prepend(el);
  while ($('feed').children.length > 6) $('feed').lastChild.remove();
  setTimeout(() => el.remove(), 12000);
}

let toastTimer;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 3000);
}
function toast2(msg) { feed(msg); }

/* 技能栏冷却 */
function renderSkillBar() {
  const t = performance.now();
  for (const k of ['basic', 'q', 'e', 'r']) {
    const slot = $('sk-' + k);
    const remain = Math.max(0, cds[k] - t);
    const pct = remain / SKILL_CDS[k];
    slot.querySelector('.cd').style.height = (pct * 100) + '%';
    const lvlReq = { e: 3, r: 5 }[k];
    slot.classList.toggle('locked', !!(lvlReq && HUD.level < lvlReq));
  }
  const dPct = Math.max(0, dodgeCd - t) / 1200;
  $('sk-dodge').querySelector('.cd').style.height = (dPct * 100) + '%';
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
      let vx = 0, vz = 0, speed = 8;
      if (t < burstT) {
        vx = burstDir[0]; vz = burstDir[1]; speed = burstSpeed;
        if (rushTrail > 0) { rushTrail -= dt; sparks(me.x, 0.7, me.z, dimAccent(myDim), { count: 3, speed: 1.2, life: 0.4, gravity: 0, up: 0.3 }); }
      }
      else {
        const mv = moveVec();
        if (mv) { vx = mv[0]; vz = mv[1]; }
      }
      if (vx || vz) {
        me.x = Math.max(-MAP_HALF, Math.min(MAP_HALF, me.x + vx * speed * dt));
        me.z = Math.max(-MAP_HALF, Math.min(MAP_HALF, me.z + vz * speed * dt));
        if (time - me.attackT > 0.25) me.obj.rotation.y = Math.atan2(vx, vz);
        me.anim = 'run';
      } else me.anim = 'idle';
      me.obj.position.set(me.x, me.obj.position.y, me.z);
    } else me.anim = 'dead';

    if (!MODELS.drive(me.obj, me.anim, dt)) MODELS.animateHumanoid(me.obj, me.anim, time, me.attackT);

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
    if (fx.age >= fx.life) { scene.remove(fx.obj); fxList.splice(i, 1); }
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
