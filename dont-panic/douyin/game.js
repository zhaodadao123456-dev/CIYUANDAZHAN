/* 别慌 · 抖音小游戏版
 * 与网页版（dont-panic/index.html）同一套玩法，改用 tt.* 小游戏 API 重写：
 * 单张 canvas 上绘制全部画面 + HUD + 菜单/结算界面，触摸事件直接绑在 tt.onTouch*。
 */

var sys = tt.getSystemInfoSync();
var dpr = sys.pixelRatio || 1;
var W = sys.windowWidth;
var H = sys.windowHeight;

var canvas = tt.createCanvas();
canvas.width = W * dpr;
canvas.height = H * dpr;
var ctx = canvas.getContext('2d');
ctx.scale(dpr, dpr);

var raf = canvas.requestAnimationFrame
  ? canvas.requestAnimationFrame.bind(canvas)
  : (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (cb) { setTimeout(cb, 16); });

// ---- audio (synth only, no asset files) ----
var actx = null;
function ensureAudio() {
  if (!actx && typeof tt.createWebAudioContext === 'function') {
    actx = tt.createWebAudioContext();
  }
}
function beep(freq, dur, gain, type) {
  if (!actx) return;
  var o = actx.createOscillator(), g = actx.createGain();
  o.type = type || 'sine'; o.frequency.value = freq;
  g.gain.value = gain || 0.05;
  o.connect(g); g.connect(actx.destination);
  var t0 = actx.currentTime;
  g.gain.setValueAtTime(g.gain.value, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.start(t0); o.stop(t0 + dur);
}
function thump() { beep(70, 0.16, 0.09, 'sine'); }
function hitSound() { beep(140, 0.28, 0.14, 'sawtooth'); }
function grazeSound() { beep(880, 0.09, 0.05, 'triangle'); }

// ---- constants ----
var BASE_BPM = 60, MAX_BPM = 200, CALM_FLOOR = 55;
var LIVES_MAX = 3;

// ---- state ----
var state = 'menu'; // menu | playing | gameover
var player, enemies, particles, pulse, lives, t, lastBeat, graze, invuln, nextSpawn;

var best = Number(tt.getStorageSync('dp_best')) || 0;

// touch tracking: identifier -> {x,y,role:'move'|'calm'}
var activeTouches = {};

var calmBtn = { x: W - 78, y: H - 110, r: 48 };
var startBtn = { x: W / 2 - 130, y: 0, w: 260, h: 56 }; // y filled in at draw time

function inCircle(px, py, c) { return Math.hypot(px - c.x, py - c.y) <= c.r; }
function inRect(px, py, r) { return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h; }

function reset() {
  player = { x: W / 2, y: H / 2, r: 13, vx: 0, vy: 0 };
  enemies = [];
  particles = [];
  pulse = BASE_BPM;
  lives = LIVES_MAX;
  t = 0;
  lastBeat = 0;
  graze = 0;
  invuln = 0;
  nextSpawn = 0.6;
}

function spawnEnemy() {
  var edge = Math.floor(Math.random() * 4);
  var margin = 30, x, y;
  if (edge === 0) { x = -margin; y = Math.random() * H; }
  else if (edge === 1) { x = W + margin; y = Math.random() * H; }
  else if (edge === 2) { x = Math.random() * W; y = -margin; }
  else { x = Math.random() * W; y = H + margin; }
  enemies.push({ x: x, y: y, r: 9 + Math.random() * 5, minDist: 99999, scored: false, hue: 350 + Math.random() * 20 });
}

function pulseSpeedFactor() { return Math.max(1, Math.min(3.3, pulse / BASE_BPM)); }

function calming() {
  for (var id in activeTouches) if (activeTouches[id].role === 'calm') return true;
  return false;
}
function moveTarget() {
  var last = null;
  for (var id in activeTouches) if (activeTouches[id].role === 'move') last = activeTouches[id];
  return last;
}

function update(dt) {
  t += dt;
  var isCalming = calming();
  var target = isCalming ? null : moveTarget();

  var mvx = 0, mvy = 0;
  if (target) {
    var dx = target.x - player.x, dy = target.y - player.y;
    var d = Math.hypot(dx, dy);
    if (d > 4) { mvx = dx / d; mvy = dy / d; }
  }

  var accel = 900, maxSpeed = 260, friction = 8;
  player.vx += mvx * accel * dt; player.vy += mvy * accel * dt;
  var sp = Math.hypot(player.vx, player.vy);
  if (sp > maxSpeed) { player.vx *= maxSpeed / sp; player.vy *= maxSpeed / sp; }
  player.vx -= player.vx * Math.min(1, friction * dt);
  player.vy -= player.vy * Math.min(1, friction * dt);
  player.x += player.vx * dt; player.y += player.vy * dt;
  player.x = Math.max(player.r, Math.min(W - player.r, player.x));
  player.y = Math.max(player.r, Math.min(H - player.r, player.y));

  var moving = Math.hypot(player.vx, player.vy) > 30;

  if (isCalming) {
    pulse += (CALM_FLOOR - pulse) * Math.min(1, 3.2 * dt);
  } else if (moving) {
    pulse = Math.min(MAX_BPM, pulse + 26 * dt);
  } else {
    pulse += (BASE_BPM - pulse) * Math.min(1, 0.9 * dt);
  }
  if (invuln > 0) invuln -= dt;

  var beatInterval = 60 / pulse;
  if (t - lastBeat >= beatInterval) { lastBeat = t; thump(); }

  var timeRamp = 1 + Math.min(2.2, t / 70);
  var fearRamp = 1 + Math.max(0, (pulse - BASE_BPM) / MAX_BPM) * 1.4;
  nextSpawn -= dt;
  if (nextSpawn <= 0) {
    spawnEnemy();
    nextSpawn = 1.15 / (timeRamp * fearRamp) + Math.random() * 0.25;
  }

  var speedFactor = pulseSpeedFactor() * Math.sqrt(timeRamp);
  var baseSpeed = 46;
  for (var i = enemies.length - 1; i >= 0; i--) {
    var e = enemies[i];
    var edx = player.x - e.x, edy = player.y - e.y;
    var ed = Math.hypot(edx, edy) || 1;
    var sfac = baseSpeed * speedFactor;
    e.x += edx / ed * sfac * dt; e.y += edy / ed * sfac * dt;
    if (ed < e.minDist) e.minDist = ed;

    var hitDist = e.r + player.r;
    if (ed < hitDist) {
      if (invuln <= 0) {
        lives -= 1;
        invuln = 1.3;
        pulse = Math.min(MAX_BPM, pulse + 45);
        hitSound();
        burst(player.x, player.y, '#ff5f7a');
        var kdx = (player.x - e.x) / ed, kdy = (player.y - e.y) / ed;
        player.vx += kdx * 260; player.vy += kdy * 260;
        enemies.splice(i, 1);
        if (lives <= 0) { gameOver(); return; }
      } else {
        enemies.splice(i, 1);
      }
      continue;
    }

    var offscreen = e.x < -60 || e.x > W + 60 || e.y < -60 || e.y > H + 60;
    if (offscreen) {
      if (!e.scored && e.minDist < (e.r + player.r + 34)) {
        graze++;
        grazeSound();
      }
      enemies.splice(i, 1);
    }
  }

  for (var p = particles.length - 1; p >= 0; p--) {
    var pt = particles[p];
    pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.life -= dt;
    pt.vx *= 0.9; pt.vy *= 0.9;
    if (pt.life <= 0) particles.splice(p, 1);
  }
}

function burst(x, y, color) {
  for (var i = 0; i < 16; i++) {
    var a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 160;
    particles.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5 + Math.random() * 0.3, color: color });
  }
}

// procedural heart icon (avoid relying on glyph/emoji font support)
function drawHeart(cx, cy, size, filled) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(size / 20, size / 20);
  ctx.beginPath();
  ctx.moveTo(0, 4);
  ctx.bezierCurveTo(0, -2, -10, -2, -10, 6);
  ctx.bezierCurveTo(-10, 13, 0, 16, 0, 20);
  ctx.bezierCurveTo(0, 16, 10, 13, 10, 6);
  ctx.bezierCurveTo(10, -2, 0, -2, 0, 4);
  ctx.closePath();
  ctx.fillStyle = filled ? '#ff6b8a' : 'rgba(255,255,255,0.15)';
  ctx.fill();
  ctx.restore();
}

function drawRoundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBackground() {
  var grad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75);
  grad.addColorStop(0, '#0c1224'); grad.addColorStop(1, '#03040a');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
}

function drawPlaying() {
  var ratio = Math.min(1, (pulse - BASE_BPM) / (MAX_BPM - BASE_BPM));
  if (ratio > 0.02) {
    var vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.7);
    vg.addColorStop(0, 'rgba(255,0,40,0)');
    vg.addColorStop(1, 'rgba(255,0,40,' + (ratio * 0.55) + ')');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  }

  enemies.forEach(function (e) {
    var dx = player.x - e.x, dy = player.y - e.y, ang = Math.atan2(dy, dx);
    ctx.save();
    ctx.translate(e.x, e.y); ctx.rotate(ang);
    ctx.shadowColor = 'hsl(' + e.hue + ',90%,55%)'; ctx.shadowBlur = 14;
    ctx.fillStyle = 'hsl(' + e.hue + ',85%,55%)';
    ctx.beginPath();
    ctx.moveTo(e.r * 1.4, 0); ctx.lineTo(-e.r, e.r * 0.85); ctx.lineTo(-e.r * 0.5, 0); ctx.lineTo(-e.r, -e.r * 0.85);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  });

  particles.forEach(function (pt) {
    ctx.globalAlpha = Math.max(0, pt.life / 0.8);
    ctx.fillStyle = pt.color;
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  });

  var beatInterval = 60 / pulse;
  var phase = (t - lastBeat) / beatInterval;
  var pulseR = player.r + Math.max(0, 1 - phase * 2.2) * 6;
  var blink = invuln > 0 && Math.floor(invuln * 14) % 2 === 0;
  if (!blink) {
    ctx.save();
    ctx.shadowColor = '#7ee0ff'; ctx.shadowBlur = 22;
    var pg = ctx.createRadialGradient(player.x, player.y, 0, player.x, player.y, pulseR);
    pg.addColorStop(0, '#ffffff'); pg.addColorStop(0.4, '#8fd8ff'); pg.addColorStop(1, 'rgba(70,140,255,0.15)');
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.arc(player.x, player.y, pulseR, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  for (var i = 0; i < LIVES_MAX; i++) drawHeart(24 + i * 30, H - 26, 18, i < lives);

  // calm button
  var isCalming = calming();
  ctx.save();
  ctx.beginPath(); ctx.arc(calmBtn.x, calmBtn.y, calmBtn.r, 0, Math.PI * 2);
  ctx.fillStyle = isCalming ? 'rgba(90,220,170,0.55)' : 'rgba(60,110,180,0.4)';
  ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = isCalming ? 'rgba(150,255,210,0.9)' : 'rgba(160,210,255,0.6)';
  ctx.stroke();
  ctx.fillStyle = '#eaf6ff'; ctx.font = '15px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('屏息', calmBtn.x, calmBtn.y - 4);
  ctx.fillText('冷静', calmBtn.x, calmBtn.y + 16);
  ctx.restore();

  // top-left HUD
  ctx.textAlign = 'left';
  ctx.fillStyle = '#dfe6ff'; ctx.font = '14px sans-serif';
  ctx.fillText('生存时间 ' + t.toFixed(1) + ' 秒', 14, 28);
  ctx.fillText('惊险闪避 ' + graze, 14, 50);

  // top-right BPM
  var bpmColor = 'rgb(' + Math.round(180 + ratio * 75) + ',' + Math.round(220 - ratio * 180) + ',' + Math.round(230 - ratio * 200) + ')';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#dfe6ff'; ctx.font = '13px sans-serif';
  ctx.fillText('心率', W - 14, 24);
  ctx.fillStyle = bpmColor; ctx.font = 'bold 22px sans-serif';
  ctx.fillText(Math.round(pulse) + ' BPM', W - 14, 48);
  ctx.textAlign = 'left';

  if (isCalming) {
    ctx.fillStyle = 'rgba(120,255,210,0.85)';
    ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('屏息中…', W / 2, 40);
    ctx.textAlign = 'left';
  }
}

function wrapText(text, x, y, maxWidth, lineHeight) {
  var words = text.split('');
  var line = '';
  for (var n = 0; n < words.length; n++) {
    var testLine = line + words[n];
    if (ctx.measureText(testLine).width > maxWidth && line.length > 0) {
      ctx.fillText(line, x, y);
      line = words[n];
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, x, y);
  return y + lineHeight;
}

function drawOverlay(title, bodyLines, statLabel, statValue, btnLabel) {
  ctx.fillStyle = 'rgba(3,5,10,0.88)';
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText(title, W / 2, H * 0.32);

  ctx.font = '14px sans-serif';
  ctx.fillStyle = '#b9c4e8';
  var y = H * 0.32 + 40;
  bodyLines.forEach(function (line) {
    y = wrapText(line, W / 2, y, W - 60, 22);
  });

  ctx.font = '15px sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(statLabel, W / 2 - 40, y + 14);
  ctx.fillStyle = '#7ee0ff';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText(statValue, W / 2 + 40, y + 14);

  startBtn.y = y + 40;
  var grad = ctx.createLinearGradient(startBtn.x, 0, startBtn.x + startBtn.w, 0);
  grad.addColorStop(0, '#ff6b8a'); grad.addColorStop(1, '#7b6bff');
  ctx.fillStyle = grad;
  drawRoundRect(startBtn.x, startBtn.y, startBtn.w, startBtn.h, 28);
  ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 17px sans-serif';
  ctx.fillText(btnLabel, W / 2, startBtn.y + startBtn.h / 2 + 6);
  ctx.textAlign = 'left';
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  drawBackground();

  if (state === 'playing') {
    drawPlaying();
  } else if (state === 'menu') {
    drawOverlay(
      '别慌',
      ['你的恐惧会喂养它们。', '移动能救你的命，但也会让你的心跳越来越快——而心跳越快，追捕你的影子就越快、越多。',
        '学会在「躲避」与「屏息平静」之间取舍，尽量活得更久。'],
      '最佳记录', best.toFixed(1) + ' 秒', '开始 / 重新开始'
    );
  } else if (state === 'gameover') {
    drawOverlay(
      '你被吞没了',
      ['存活 ' + t.toFixed(1) + ' 秒，惊险闪避 ' + graze + ' 次。', '越慌越乱——下次试着在关键时刻屏息，让心跳降下来。'],
      '最佳记录', best.toFixed(1) + ' 秒', '再试一次'
    );
  }
}

function startGame() {
  ensureAudio();
  reset();
  state = 'playing';
}

function gameOver() {
  state = 'gameover';
  if (t > best) {
    best = t;
    tt.setStorageSync('dp_best', best.toFixed(2));
  }
}

var last = null;
function loop(ts) {
  if (last === null) last = ts;
  var dt = Math.min(0.05, (ts - last) / 1000);
  last = ts;
  if (state === 'playing') update(dt);
  draw();
  raf(loop);
}
raf(loop);

// ---- touch input ----
tt.onTouchStart(function (e) {
  ensureAudio();
  e.touches.forEach(function (touch) {
    var x = touch.clientX, y = touch.clientY;
    if (state !== 'playing') {
      if (inRect(x, y, startBtn)) { startGame(); return; }
      return;
    }
    if (inCircle(x, y, calmBtn)) {
      activeTouches[touch.identifier] = { x: x, y: y, role: 'calm' };
    } else {
      activeTouches[touch.identifier] = { x: x, y: y, role: 'move' };
    }
  });
});

tt.onTouchMove(function (e) {
  e.touches.forEach(function (touch) {
    var rec = activeTouches[touch.identifier];
    if (rec && rec.role === 'move') { rec.x = touch.clientX; rec.y = touch.clientY; }
  });
});

tt.onTouchEnd(function (e) {
  e.changedTouches.forEach(function (touch) {
    delete activeTouches[touch.identifier];
  });
});

draw();
