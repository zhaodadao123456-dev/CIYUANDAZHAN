/* ============================================================
 * 次元大战 3D - 音频系统
 * 音乐：Juhani Junkala "Chiptune Adventures"（CC0，OpenGameArt）
 * 音效：Juhani Junkala "512 Sound Effects"（CC0，OpenGameArt）
 * SFX 用 WebAudio（低延迟可叠加），BGM 用 <audio> 循环
 * ============================================================ */
const AUDIO = (() => {
  const SFX_LIST = ['swing', 'laser', 'explosion', 'hit', 'coin', 'levelup', 'hurt', 'click', 'warhorn', 'dodge'];
  const BGM = {
    menu:  'assets/audio/bgm_menu.ogg',
    world: 'assets/audio/bgm_world.ogg',
    war:   'assets/audio/bgm_war.ogg',
  };
  let ctx = null;
  const buffers = {};
  let music = null, musicName = null;
  let muted = localStorage.getItem('dw-muted') === '1';
  let unlocked = false;

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    for (const name of SFX_LIST) {
      fetch(`assets/audio/${name}.wav`)
        .then((r) => r.arrayBuffer())
        .then((ab) => ctx.decodeAudioData(ab))
        .then((buf) => { buffers[name] = buf; })
        .catch(() => {});
    }
    if (musicName) setMusic(musicName, true);
  }

  function sfx(name, vol = 1, rate = 1) {
    if (muted || !ctx || !buffers[name]) return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buffers[name];
      src.playbackRate.value = rate * (0.94 + Math.random() * 0.12);
      const g = ctx.createGain();
      g.gain.value = Math.min(1, vol) * 0.5;
      src.connect(g).connect(ctx.destination);
      src.start();
    } catch (e) {}
  }

  /* 按与玩家的距离衰减播放 */
  function sfxAt(name, dist, vol = 1, rate = 1) {
    if (dist > 30) return;
    sfx(name, vol * Math.max(0.15, 1 - dist / 32), rate);
  }

  function setMusic(name, force = false) {
    if (name === musicName && !force) return;
    musicName = name;
    if (!unlocked) return;        // 等首次交互解锁后再起
    if (music) { music.pause(); music = null; }
    if (!name || muted) return;
    music = new Audio(BGM[name]);
    music.loop = true;
    music.volume = name === 'menu' ? 0.25 : 0.3;
    music.play().catch(() => {});
  }

  function toggleMute() {
    muted = !muted;
    localStorage.setItem('dw-muted', muted ? '1' : '0');
    if (muted) { if (music) { music.pause(); music = null; } }
    else setMusic(musicName, true);
    return muted;
  }

  return { unlock, sfx, sfxAt, setMusic, toggleMute, isMuted: () => muted };
})();
