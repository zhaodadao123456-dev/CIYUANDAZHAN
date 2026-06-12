/* ============================================================
 * 次元大战 3D - 角色模型与动画系统
 *
 * 首选：KayKit 专业美术资产（CC0授权，带骨骼动画的GLB）
 *   英雄：Knight/Rogue/Rogue_Hooded/Mage/Barbarian → 五大次元
 *   怪物：Skeleton Minion/Rogue/Mage/Warrior → T1~T4
 * 兜底：程序化低模（资产加载失败时自动使用）
 * ============================================================ */
const MODELS = (() => {

  /* ============ GLTF 资产管线 ============ */
  const cache = {};   // key -> { scene, anims, height }
  let assetsReady = false;
  let loadPromise = null;
  const progressCbs = [];

  /* 场景摆件：[文件名, 目标高度, 出现权重] */
  const PROP_DEFS = {
    tech: [
      ['basemodule_A', 3.5, 1], ['basemodule_B', 3.5, 1], ['containers_A', 1.6, 2],
      ['solarpanel', 1.6, 2], ['drill_structure', 4.5, 1], ['rocks_A', 1.2, 2],
    ],
    xiuxian: [
      ['tree_single_A', 4.5, 3], ['trees_B_medium', 5.0, 1], ['rock_single_A', 1.4, 2],
      ['column', 3.0, 1], ['torch_lit', 1.7, 1],
    ],
    cyber: [
      ['building_A', 8.0, 1], ['building_B', 9.0, 1], ['building_D', 7.0, 1],
      ['streetlight', 4.0, 2], ['trafficlight_A', 3.5, 1], ['dumpster', 1.3, 1],
    ],
    magic: [
      ['pillar_decorated', 3.5, 2], ['column', 3.0, 2], ['torch_lit', 1.7, 2],
      ['chest_gold', 1.0, 1], ['rubble_large', 1.2, 1], ['crates_stacked', 1.6, 1],
    ],
    hunter: [
      ['tree_pine_orange_small', 3.5, 3], ['tree_pine_yellow_small', 3.5, 2],
      ['tree_dead_medium', 3.8, 1], ['rock_single_C', 1.5, 2], ['lantern_standing', 1.8, 1],
    ],
    war: [
      ['rubble_large', 1.4, 2], ['rubble_half', 1.0, 1], ['pillar', 3.0, 2],
      ['torch_lit', 1.7, 2], ['gravestone', 1.2, 1], ['fence_pillar_broken', 1.2, 1],
    ],
  };

  const ASSET_LIST = [
    ['hero_tech',    'assets/heroes/tech.glb'],
    ['hero_xiuxian', 'assets/heroes/xiuxian.glb'],
    ['hero_cyber',   'assets/heroes/cyber.glb'],
    ['hero_magic',   'assets/heroes/magic.glb'],
    ['hero_hunter',  'assets/heroes/hunter.glb'],
    ['mon_t1', 'assets/monsters/t1.glb'],
    ['mon_t2', 'assets/monsters/t2.glb'],
    ['mon_t3', 'assets/monsters/t3.glb'],
    ['mon_t4', 'assets/monsters/t4.glb'],
  ];
  for (const [theme, defs] of Object.entries(PROP_DEFS)) {
    for (const [name] of defs) ASSET_LIST.push([`prop_${theme}_${name}`, `assets/props/${theme}_${name}.glb`]);
  }

  /* 每个次元隐藏多余配件，形成专属武器外观 */
  const HIDE = {
    tech:    ['2H_Sword', '1H_Sword_Offhand', 'Badge_Shield', 'Rectangle_Shield', 'Spike_Shield'], // 单手剑+圆盾
    xiuxian: ['1H_Crossbow', '2H_Crossbow', 'Throwable'],                                          // 双刀剑客
    cyber:   ['Knife', '2H_Crossbow', 'Throwable'],                                                // 弩枪+副手刀
    magic:   ['1H_Wand', 'Spellbook', 'Spellbook_open'],                                           // 双手法杖
    hunter:  ['1H_Axe', '1H_Axe_Offhand', 'Barbarian_Round_Shield', 'Mug'],                        // 双手巨斧
  };

  /* 技能 → 骨骼动画映射（按次元差异化） */
  const SKILL_ANIM = {
    basic: { default: '1H_Melee_Attack_Slice_Diagonal', xiuxian: 'Dualwield_Melee_Attack_Slice', magic: 'Spellcast_Shoot', cyber: '1H_Melee_Attack_Slice_Horizontal', hunter: '2H_Melee_Attack_Slice' },
    q:     { default: 'Spellcast_Shoot' },
    e:     { default: '2H_Melee_Attack_Spin', magic: 'Spellcast_Long' },
    r:     { default: '2H_Melee_Attack_Slice', magic: '1H_Melee_Attack_Stab', xiuxian: '1H_Melee_Attack_Stab' },
  };

  /* 单例加载：页面打开即可后台预载，多处调用共享同一进度 */
  function loadAssets(onProgress) {
    if (onProgress) progressCbs.push(onProgress);
    if (loadPromise) return loadPromise;
    const loader = new GLTFLoader();
    let done = 0;
    const finishOne = () => { done++; for (const cb of progressCbs) cb(done, ASSET_LIST.length); };
    /* 单个资产：失败/超时自动重试一次，仍不行就用程序化模型兜底，绝不卡死加载 */
    const loadOne = ([key, url], animMap) => new Promise((resolve) => {
      let settled = false;
      const settle = () => { if (!settled) { settled = true; finishOne(); resolve(); } };
      const attempt = (retriesLeft) => {
        const timer = setTimeout(() => {
          if (settled) return;
          if (retriesLeft > 0) { console.warn('资产加载超时，重试:', url); attempt(retriesLeft - 1); }
          else { console.warn('资产加载超时，使用程序化模型兜底:', url); settle(); }
        }, 30000);
        // 重试时加随机参数，强制发起全新请求而不是复用卡死的连接
        const requestUrl = retriesLeft === 1 ? url : `${url}?r=${Date.now()}`;
        loader.load(requestUrl, (gltf) => {
          clearTimeout(timer);
          if (settled) return;
          const box = new THREE.Box3().setFromObject(gltf.scene);
          cache[key] = { scene: gltf.scene, anims: gltf.animations, height: Math.max(0.1, box.max.y - box.min.y), animMap: animMap || null };
          settle();
        }, undefined, (err) => {
          clearTimeout(timer);
          if (settled) return;
          if (retriesLeft > 0) { console.warn('资产加载失败，重试:', url, err); attempt(retriesLeft - 1); }
          else { console.warn('资产加载失败，使用程序化模型兜底:', url, err); settle(); }
        });
      };
      attempt(1);
    });
    /* 高级素材覆盖：服务器上若存在 assets/premium/manifest.json（购买的精品模型，
     * 直接 SFTP 上传到服务器，不入 Git），优先加载其中声明的模型。
     * 格式见 docs/premium-assets.md */
    loadPromise = fetch('assets/premium/manifest.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((premium) => {
        const overrides = (premium && premium.overrides) || {};
        return Promise.all(ASSET_LIST.map(([key, url]) => {
          const ov = overrides[key];
          if (ov && ov.url) return loadOne([key, 'assets/premium/' + ov.url.replace(/^\/+/, '')], ov.animMap);
          return loadOne([key, url]);
        }));
      })
      .then(() => { assetsReady = true; });
    return loadPromise;
  }

  function instantiate(key, targetH) {
    const tpl = cache[key];
    if (!tpl) return null;
    const obj = window.skeletonClone(tpl.scene);
    obj.scale.setScalar(targetH / tpl.height);
    obj.traverse((c) => {
      if (c.isMesh || c.isSkinnedMesh) { c.castShadow = true; c.frustumCulled = false; }
    });
    const mixer = new THREE.AnimationMixer(obj);
    const actions = {};
    for (const clip of tpl.anims) actions[clip.name] = mixer.clipAction(clip);
    obj.userData.rig = { mixer, actions, base: null, baseName: '', one: null, busyUntil: 0, deadDone: false, deadAction: null, animMap: tpl.animMap };
    return obj;
  }

  /* 高级素材的动画名翻译：购买包的动画命名各不相同，按 manifest 的 animMap 映射 */
  function animName(rig, name) {
    return (rig.animMap && rig.animMap[name]) || name;
  }

  /* 向次元主色染色（克隆材质，避免影响其他实例） */
  function tint(obj, accent, amount) {
    if (accent == null || !amount) return;
    const target = new THREE.Color(accent);
    obj.traverse((c) => {
      if ((c.isMesh || c.isSkinnedMesh) && c.material && c.material.color) {
        c.material = c.material.clone();
        c.material.color.lerp(target, amount);
      }
    });
  }

  /* ============ 对外：创建角色 ============ */
  /* 英雄模型按职业定型（clsId → CLASSES.model），再按次元主色染色 */
  function makeHero(dimId, accent, clsId) {
    const cls = (typeof CLASSES !== 'undefined') && CLASSES.find((c) => c.id === clsId);
    const modelKey = cls ? cls.model : dimId;
    const obj = instantiate('hero_' + modelKey, cls && cls.id === 'tank' ? 2.0 : 1.85);
    if (!obj) return makeHeroProc(dimId, accent);
    const hide = HIDE[modelKey] || [];
    obj.traverse((c) => { if (hide.includes(c.name)) c.visible = false; });
    obj.userData.modelKey = modelKey;
    tint(obj, accent, 0.22);
    return obj;
  }

  /* 怪物按所在次元主色染色；small=true 用于猎人宝宝 */
  function makeMonster(tier, accent, small = false) {
    // tier 5 = 世界BOSS：复用 T4 模型放大（premium 可覆盖 mon_t4）
    const obj = instantiate('mon_t' + Math.min(4, tier), small ? 0.75 + tier * 0.25 : 1.15 + tier * 0.4);
    if (!obj) return makeMonsterProc(tier, accent);
    tint(obj, accent, small ? 0.45 : 0.3);
    obj.userData.tier = tier;
    return obj;
  }

  /* 指定名称的摆件（用于手工关卡布局），scaleMul 可微调大小 */
  function makePropNamed(theme, name, scaleMul = 1) {
    const defs = PROP_DEFS[theme];
    const def = defs && defs.find((d) => d[0] === name);
    const tpl = cache[`prop_${theme}_${name}`];
    if (!def || !tpl) return null;
    const obj = tpl.scene.clone(true);
    obj.scale.setScalar((def[1] / tpl.height) * scaleMul);
    obj.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    return obj;
  }

  /* 场景摆件：按主题加权随机；资产未就绪返回 null（由调用方走程序化兜底） */
  function makeProp(theme, rnd) {
    const defs = PROP_DEFS[theme];
    if (!defs) return null;
    const total = defs.reduce((s, d) => s + d[2], 0);
    let roll = rnd() * total;
    let pick = defs[0];
    for (const d of defs) { roll -= d[2]; if (roll <= 0) { pick = d; break; } }
    const tpl = cache[`prop_${theme}_${pick[0]}`];
    if (!tpl) return null;
    const obj = tpl.scene.clone(true);
    obj.scale.setScalar((pick[1] / tpl.height) * (0.85 + rnd() * 0.3));
    obj.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    return obj;
  }

  /* ============ 骨骼动画状态机 ============ */
  function setBase(rig, name, fade = 0.18) {
    if (rig.baseName === name) return;
    const a = rig.actions[animName(rig, name)];
    if (!a) return;
    if (rig.base) rig.base.fadeOut(fade);
    a.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(fade).play();
    rig.base = a;
    rig.baseName = name;
  }

  /* 每帧驱动；返回 false 表示该模型没有骨骼（走程序化动画） */
  function drive(obj, state, dt) {
    const rig = obj.userData.rig;
    if (!rig) return false;
    rig.mixer.update(dt);
    const t = performance.now();

    if (state === 'dead') {
      if (!rig.deadDone) {
        rig.deadDone = true;
        if (rig.one) { rig.one.fadeOut(0.1); rig.one = null; }
        if (rig.base) { rig.base.fadeOut(0.1); rig.base = null; rig.baseName = ''; }
        const d = rig.actions[animName(rig, 'Death_A')];
        if (d) { d.reset().setLoop(THREE.LoopOnce, 1); d.clampWhenFinished = true; d.fadeIn(0.1).play(); rig.deadAction = d; }
      }
      return true;
    }
    if (rig.deadDone) {
      rig.deadDone = false;
      if (rig.deadAction) { rig.deadAction.fadeOut(0.25); rig.deadAction = null; }
    }
    if (t < rig.busyUntil) return true;       // 攻击动作占用全身
    if (rig.one) { rig.one.fadeOut(0.15); rig.one = null; }
    setBase(rig, state === 'run' ? 'Running_A' : 'Idle');
    return true;
  }

  function playOnce(rig, name, speed) {
    const a = rig.actions[animName(rig, name)];
    if (!a) return;
    rig.busyUntil = performance.now() + (a.getClip().duration / speed) * 1000 - 60;
    if (rig.base) { rig.base.fadeOut(0.08); rig.base = null; rig.baseName = ''; }
    if (rig.one) rig.one.stop();
    a.reset().setLoop(THREE.LoopOnce, 1);
    a.timeScale = speed;
    a.clampWhenFinished = false;
    a.fadeIn(0.06).play();
    rig.one = a;
  }

  /* 玩家技能动作（动作集跟随英雄模型而非次元） */
  function attackAnim(obj, dimId, kind) {
    const rig = obj.userData.rig;
    if (!rig) { obj.userData.attackT = performance.now() / 1000; return; }
    const map = SKILL_ANIM[kind] || SKILL_ANIM.basic;
    const key = obj.userData.modelKey || dimId;
    playOnce(rig, map[key] || map.default, kind === 'basic' ? 1.7 : 1.25);
  }

  /* 怪物攻击动作 */
  function monsterAttack(obj) {
    const rig = obj.userData.rig;
    if (!rig) return;
    playOnce(rig, '1H_Melee_Attack_Slice_Horizontal', 1.3);
  }

  /* 翻滚动作 */
  function dodgeAnim(obj) {
    const rig = obj.userData.rig;
    if (!rig) return;
    playOnce(rig, 'Dodge_Forward', 1.4);
  }

  /* ============ 程序化兜底模型（资产加载失败时） ============ */
  const M = (color, opts = {}) => new THREE.MeshStandardMaterial({
    color, roughness: opts.rough ?? 0.7, metalness: opts.metal ?? 0.15,
    emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.ei ?? 1,
  });
  const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  const sph = (r, mat, seg = 12) => new THREE.Mesh(new THREE.SphereGeometry(r, seg, seg), mat);
  const cyl = (rt, rb, h, mat, seg = 10) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  const cone = (r, h, mat, seg = 8) => new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat);

  function makeHeroProc(dimId, accent) {
    const g = new THREE.Group();
    const cMain = M(accent, { metal: 0.35, rough: 0.5 });
    const cDark = M(0x23232f, { rough: 0.8 });
    const cSkin = M(0xe8c39e, { rough: 0.9 });
    const cGlow = M(accent, { emissive: accent, ei: 0.9 });
    const torso = box(0.52, 0.62, 0.3, cMain); torso.position.y = 1.18; g.add(torso);
    const belt = box(0.54, 0.1, 0.32, cDark); belt.position.y = 0.9; g.add(belt);
    const chest = box(0.56, 0.16, 0.34, cGlow); chest.position.y = 1.34; g.add(chest);
    const headG = new THREE.Group(); headG.position.y = 1.62;
    const head = sph(0.18, cSkin); head.position.y = 0.12; headG.add(head);
    const helm = cyl(0.2, 0.21, 0.14, cMain); helm.position.y = 0.2; headG.add(helm);
    const visor = box(0.3, 0.06, 0.05, cGlow); visor.position.set(0, 0.12, 0.16); headG.add(visor);
    g.add(headG);
    for (const s of [-1, 1]) { const pad = box(0.2, 0.12, 0.26, cMain); pad.position.set(s * 0.38, 1.47, 0); g.add(pad); }
    const mkLimb = (w, len, mat) => { const j = new THREE.Group(); const m2 = box(w, len, w, mat); m2.position.y = -len / 2; j.add(m2); return j; };
    const lArm = mkLimb(0.13, 0.62, cMain); lArm.position.set(-0.36, 1.45, 0);
    const rArm = mkLimb(0.13, 0.62, cMain); rArm.position.set(0.36, 1.45, 0);
    const lLeg = mkLimb(0.17, 0.86, cDark); lLeg.position.set(-0.15, 0.88, 0);
    const rLeg = mkLimb(0.17, 0.86, cDark); rLeg.position.set(0.15, 0.88, 0);
    g.add(lArm, rArm, lLeg, rLeg);
    const blade = box(0.05, 1.0, 0.16, cGlow); blade.position.y = 0.0; blade.position.set(0, -0.3, 0.3); rArm.add(blade);
    g.userData.parts = { headG, lArm, rArm, lLeg, rLeg, torso };
    g.userData.attackT = 0;
    g.traverse((c) => { if (c.isMesh) c.castShadow = true; });
    return g;
  }

  function makeMonsterProc(tier, accent) {
    const g = new THREE.Group();
    const s = 0.55 + tier * 0.28;
    const bodyColor = [0x7a8a5a, 0x6a7ab0, 0xb06a6a, 0x8a3a6a][tier - 1] || 0x888888;
    const cBody = M(bodyColor, { rough: 0.85 });
    const cGlow = M(accent, { emissive: tier >= 3 ? 0xff3344 : accent, ei: 1.0 });
    const body = new THREE.Mesh(new THREE.IcosahedronGeometry(s * 0.55, 0), cBody);
    body.position.y = s * 0.62; body.scale.y = 0.85; g.add(body);
    for (const side of [-1, 1]) { const eye = sph(s * 0.09, cGlow, 8); eye.position.set(side * s * 0.2, s * 0.72, s * 0.45); g.add(eye); }
    const spikes = Math.min(2 + tier, 6);
    for (let i = 0; i < spikes; i++) {
      const sp = cone(s * 0.1, s * 0.36, cGlow, 5);
      const a = (i / spikes) * Math.PI - Math.PI / 2;
      sp.position.set(Math.sin(a) * s * 0.4, s * 0.95, -Math.cos(a) * s * 0.25);
      sp.rotation.z = -Math.sin(a) * 0.7;
      g.add(sp);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = box(s * 0.14, s * 0.3, s * 0.14, cBody);
      leg.position.set(sx * s * 0.3, s * 0.15, sz * s * 0.25);
      g.add(leg);
    }
    g.userData.bodyMesh = body;
    g.userData.tier = tier;
    g.traverse((c) => { if (c.isMesh) c.castShadow = true; });
    return g;
  }

  /* 程序化人形动画（兜底） */
  function animateHumanoid(g, anim, time, attackT) {
    const P = g.userData.parts;
    if (!P) return;
    const atkAge = attackT ? (time - attackT) : 99;
    if (anim === 'dead') {
      g.rotation.x = Math.min(g.rotation.x + 0.12, Math.PI / 2);
      g.position.y = Math.max(g.position.y - 0.02, -0.35);
      return;
    }
    g.rotation.x = 0;
    if (g.position.y < 0) g.position.y = 0;
    if (anim === 'run') {
      const t = time * 11;
      P.lLeg.rotation.x = Math.sin(t) * 0.85;
      P.rLeg.rotation.x = Math.sin(t + Math.PI) * 0.85;
      P.lArm.rotation.x = Math.sin(t + Math.PI) * 0.7;
      if (atkAge > 0.38) P.rArm.rotation.x = Math.sin(t) * 0.7;
      P.torso.position.y = 1.18 + Math.abs(Math.sin(t)) * 0.04;
    } else {
      const t = time * 1.8;
      P.lLeg.rotation.x = P.rLeg.rotation.x = 0;
      P.lArm.rotation.x = Math.sin(t) * 0.07;
      if (atkAge > 0.38) P.rArm.rotation.x = Math.sin(t + 1) * 0.07;
      P.torso.position.y = 1.18 + Math.sin(t) * 0.015;
    }
    if (atkAge <= 0.38) {
      const k = atkAge / 0.38;
      P.rArm.rotation.x = k < 0.35 ? -2.4 * (k / 0.35) : -2.4 + 3.1 * ((k - 0.35) / 0.65);
    }
  }

  /* 程序化怪物动画（兜底） */
  function animateMonster(g, state, time) {
    const body = g.userData.bodyMesh;
    if (!body) return;
    if (state === 'dead') { g.scale.multiplyScalar(0.9); return; }
    if (g.scale.x < 1) g.scale.setScalar(Math.min(1, g.scale.x * 1.15 + 0.01));
    const hop = state === 'chase' || state === 'attack' ? 0.12 : 0.045;
    const spd = state === 'chase' ? 13 : 3;
    g.position.y = Math.abs(Math.sin(time * spd)) * hop;
    g.rotation.z = state === 'attack' ? Math.sin(time * 25) * 0.08 : 0;
  }

  return { loadAssets, makeHero, makeMonster, makeProp, makePropNamed, drive, attackAnim, monsterAttack, dodgeAnim, animateHumanoid, animateMonster, isReady: () => assetsReady };
})();
