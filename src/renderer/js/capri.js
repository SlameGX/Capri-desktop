// Capri herself: where she is, how she moves, how she reacts.
// She acts with her head and her mane like in the show, and she's timed like cel animation:
// pose-to-pose acts (acting.js) drawn on twos, on ones for the action beats.
//
// Stances: floating ("stand"), perched on a window ("sit"), peeking in from a screen edge
// ("peek"), and falling ("fall") when the window under her goes away or you drop her.

import { SpriteRenderer, SPRITE } from './sprite.js';
import { ACTS, NEUTRAL, Player } from './acting.js';
import { sleep, rand, pick, clamp, lerp, ease, tween, reducedMotion, today } from './util.js';

const ON_TWOS = 1000 / 12;
const ON_ONES = 1000 / 24;
const ASLEEP = 1000 / 6;
const SLEEP_AFTER = 10 * 60 * 1000;
const DOZE_AFTER = 20 * 1000; // asleep this long, she comes apart down to her mask
const GRAVITY = 2600; // px/s²
const THIGH = 73;     // hip to knee, sprite px (see sprite.js)

const UPLINK_DAY = 'capri.uplinkDay'; // the last day she sent the red light up

const GREEN = [0.21, 1, 0.48];
const INK = [0.08, 0.06, 0.11];
const RED = [1, 0.13, 0.32];

export class Capri {
  constructor({ root, canvas, image, fx, voice }) {
    this.root = root;
    this.canvas = canvas;
    this.sprite = new SpriteRenderer(canvas, image);
    this.fx = fx;
    this.voice = voice;

    this.scale = 0.6;
    this.view = { w: innerWidth, h: innerHeight, floor: innerHeight }; // floor: the top of the taskbar
    this.pos = { x: innerWidth - 200, y: innerHeight - 6 }; // her feet
    this.facing = 1; // 1: as drawn (reaching left), -1: mirrored
    this.mode = 'idle'; // idle | work | alert | sleep
    this.stance = 'stand';
    this.perch = null;    // { id, dx }: the window she sits on, and where along it
    this.peekSide = null; // left | right | top
    this.windows = { fg: 0, wins: [] };
    this.busy = false;
    this.hidden = false;
    this.stowed = false;  // folded away in her biochip (Ctrl+Alt+C)
    this.dormant = false; // asleep, down to her mask
    this.wander = true;
    this.possessWindows = true; // tray: "Possess my windows"
    this.restOn = 'corner'; // where she rests when nothing's going on: her corner, or 'taskbar' (her menu)
    this.nextHome = 0;
    this.dragging = false;
    this.vx = 0;
    this.vy = 0;
    this.vRot = 0;
    this.bounces = 0;
    this.flung = false;
    this.edgeHits = 0;
    this.onFlingHit = null;
    this.wallSide = null;
    this.walkState = null;
    this.climbState = null;
    this.slideState = null;
    this.wallHangUntil = 0;

    this.p = {
      seed: 0, boil: 0.9, hair: 0, head: 0, mane: 0, armL: 0, armR: 0, longL: 1, longR: 1, sit: 0, kickL: 0, kickR: 0,
      smear: [0, 0], echo: [0, 0],
      glitch: 0, glitchSeed: 0, split: 0, collapse: 0, dissolve: 0, sparkle: 1, grade: 1,
      sil: INK, silAmount: 0, misreg: [-2.6, 2.2], alpha: 1,
    };
    this.bob = 0;
    this.tilt = 0;
    this.sx = 1;
    this.sy = 1;
    this.base = new Player('stand');
    this.act = null;
    this.lastDraw = 0;

    const now = performance.now();
    this.lastActivity = now;
    this.nextTwitch = now + rand(4000, 9000);
    this.nextMove = now + rand(40000, 80000);
    this.nextGaze = now + rand(40000, 90000);
    this.nextShed = now + rand(3000, 8000);
    this.nextNotice = 0;
    this.peekUntil = 0;
    this.lastGlyph = 0;
    this.sleptAt = 0;
    this.uplinkDue = false;
    this.pointing = null; // what she's showing you: { rect, aim, dir, side, reach, label, pointer }
    this.mouse = null; // last pointer position seen

    this.onMove = null;     // her head moved on screen
    this.onTeleport = null; // ('start' | 'end')
    this.onClick = null;
    this.onMenu = null;   // right-click on her
    this.onGaze = null;
    this.onMode = null;   // (mode, previous)
    this.onStow = null;   // she's in her biochip
    this.onUnstow = null; // she's coming out of it
    this.chipAt = null;   // () => the biochip's middle on screen
    this.onDoze = null;   // ('start', face) | 'waking' | 'end': down to her mask and back

    this.alphaMap = this.buildAlphaMap(image);
    this.setScale(this.scale);
    this.bindPointer();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // ---------- geometry ----------

  // Her silhouette at rest, for hit tests: the cut-out plus the mirrored right arm the shader adds.
  buildAlphaMap(image) {
    const { width: w, height: h, mirror } = SPRITE;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!SPRITE.armL(x, y) || mirror - x >= w) continue;
        const to = (y * w + mirror - x) * 4 + 3;
        data[to] = Math.max(data[to], data[(y * w + x) * 4 + 3]);
      }
    }
    return data;
  }

  setScale(scale) {
    this.scale = scale;
    this.sprite.resize(scale);
    this.pivot();
    this.place();
  }

  // Flip, lean and squash all pivot on her feet, or on her seat when she sits on a ledge
  // (so a squash presses her onto it instead of pulling her down through it).
  pivot() {
    const s = this.scale;
    const fx = (SPRITE.pad + SPRITE.feet.x) * s;
    const isHipStance = this.stance === 'sit' || this.stance === 'climb' || this.stance === 'wall_hang' || this.stance === 'wall_slide';
    const fy = (SPRITE.pad + (isHipStance ? SPRITE.hip : SPRITE.feet.y)) * s;
    this.canvas.style.transformOrigin = `${fx}px ${fy}px`;
  }

  setView(w, h, floor = h) {
    this.view = { w, h, floor };
    if (this.stance === 'stand') {
      this.pos.x = clamp(this.pos.x, 60, w - 60);
      this.pos.y = clamp(this.pos.y, SPRITE.height * this.scale, floor - 4);
    }
    this.place();
  }

  get upside() {
    return this.stance === 'peek' && this.peekSide === 'top';
  }

  place() {
    const s = this.scale;
    const left = this.pos.x - (SPRITE.pad + SPRITE.feet.x) * s;
    const top = this.pos.y - (SPRITE.pad + SPRITE.feet.y) * s + this.bob;
    const turn = (this.upside ? 180 : 0) + this.tilt;
    this.root.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    this.canvas.style.transform = `rotate(${turn.toFixed(2)}deg) scale(${(this.facing * this.sx).toFixed(3)}, ${this.sy.toFixed(3)})`;
    this.onMove?.(this.head());
  }

  // her face on screen, plus `top`: the tips of her mane
  head(at = this.pos, facing = this.facing) {
    const s = this.scale;
    const bob = at === this.pos ? this.bob : 0;
    const dx = (SPRITE.head.x - SPRITE.feet.x) * s * facing;
    const dy = (SPRITE.feet.y - SPRITE.head.y) * s;
    if (at === this.pos && this.upside) {
      const y = at.y + dy + bob;
      return { x: at.x - dx, y, top: y - 30 * s };
    }
    return { x: at.x + dx, y: at.y - dy + bob, top: at.y - SPRITE.feet.y * s + bob };
  }

  // Is this screen point on her body? Uses the cut-out's alpha so empty space stays click-through.
  hit(x, y) {
    if (this.hidden || this.p.alpha < 0.5) return false;
    if (this.perch?.id === 'taskbar' && y > this.view.floor) return false; // the taskbar under her legs stays clickable
    const s = this.scale;
    const fy = this.pos.y + this.bob;
    if (this.upside) {
      x = 2 * this.pos.x - x;
      y = 2 * fy - y;
    }
    if (this.tilt) {
      const rad = (-this.tilt * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const dx = x - this.pos.x;
      const dy = y - fy;
      x = this.pos.x + dx * cos - dy * sin;
      y = fy + dx * sin + dy * cos;
    }
    const sx = SPRITE.feet.x + ((x - this.pos.x) / s) * this.facing;
    let sy = SPRITE.feet.y - (fy - y) / s;
    if (this.p.sit > 0 && sy > SPRITE.hip) {
      // same fold as the shader: short thighs, legs ridden up
      const c = lerp(1, 0.3, this.p.sit);
      sy = sy <= SPRITE.hip + THIGH * c ? SPRITE.hip + (sy - SPRITE.hip) / c : sy + THIGH * (1 - c);
    }
    for (const [dx, dy] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]]) {
      const px = Math.round(sx + dx), py = Math.round(sy + dy);
      if (px < 0 || py < 0 || px >= SPRITE.width || py >= SPRITE.height) continue;
      if (this.alphaMap[(py * SPRITE.width + px) * 4 + 3] > 40) return true;
    }
    return false;
  }

  faceCenter() {
    this.facing = this.pos.x > this.view.w / 2 ? 1 : -1;
  }

  // Which way is the middle of the screen from her, -1 or 1.
  towardCenter() {
    return this.pos.x > this.view.w / 2 ? -1 : 1;
  }

  // the reaching side of the cut-out points toward screen x
  faceToward(x) {
    this.facing = x < this.pos.x ? 1 : -1;
  }

  get floor() {
    return this.view.floor - 6;
  }

  spot(name) {
    const { w } = this.view;
    const s = this.scale;
    const side = 150 * s + 30;
    switch (name) {
      case 'post':
        return { x: w - side - 30, y: this.floor };
      case 'stage':
        return { x: w * 0.5 + rand(-w * 0.12, w * 0.12), y: this.floor };
      case 'chip': // next to her biochip, bottom left
        return { x: side + 30, y: this.floor };
      default: {
        const y = Math.random() < 0.65 ? this.floor : rand(SPRITE.height * s + 200, this.floor);
        let x = rand(side, w - side);
        if (Math.abs(x - this.pos.x) < w * 0.2) x = clamp(w - x, side, w - side);
        return { x, y };
      }
    }
  }

  // ---------- windows ----------

  setWindows(data) {
    this.windows = data;
    if (this.stance !== 'sit' || this.busy || this.dragging) return;
    const win = this.perchWin(this.perch.id);
    const dx = win ? clamp(this.perch.dx, 50, win.w - 60) : 0;
    if (!win || !this.canSit(win) || this.covered(win, win.x + dx)) {
      this.fall(); // the ledge is gone (closed, minimized, maximized or covered)
      return;
    }
    const to = this.seat(win, dx);
    if (to.x !== this.pos.x || to.y !== this.pos.y) {
      this.pos = to; // ride along with the window
      this.place();
    }
  }

  // Where her feet go so that her hips rest on the window's top edge.
  seat(win, dx) {
    return { x: win.x + dx, y: win.y + 3 + (SPRITE.feet.y - SPRITE.hip) * this.scale };
  }

  canSit(win) {
    if (win.id === 'taskbar') return true;
    const roomAbove = SPRITE.hip * this.scale + 12;
    return !win.max && win.w > 260 && win.y > roomAbove && win.y < this.view.floor - 80;
  }

  // Is her spot on that ledge hidden under a window that's above it?
  covered(win, x) {
    if (win.id === 'taskbar') return false; // nothing goes over the taskbar
    const half = 34 * this.scale;
    const { wins } = this.windows;
    for (const o of wins) {
      if (o === win || o.id === win.id) return false; // reached it: everything after is below
      if (o.x < x + half && o.x + o.w > x - half && o.y <= win.y && o.y + o.h >= win.y) return true;
    }
    return false; // window not in the list any more
  }

  // A window she could sit on, the one in front first. Returns { win, dx } or null.
  // The top of the taskbar (the bottom of her screen), as a ledge to sit on like a window's: her
  // legs hang down behind it.
  ledge() {
    return { id: 'taskbar', x: 0, y: this.view.floor, w: this.view.w, h: this.view.h - this.view.floor, max: false };
  }

  // What she's perched on, from its id: a window, or the taskbar.
  perchWin(id) {
    return id === 'taskbar' ? this.ledge() : this.windows.wins.find((w) => w.id === id);
  }

  // Back to where she rests: her corner, or sitting on the taskbar below it.
  goHome() {
    const post = this.spot('post');
    if (this.restOn !== 'taskbar') return this.teleport(post);
    if (this.stance === 'sit' && this.perch?.id === 'taskbar') return Promise.resolve();
    // left of the clock and the tray icons, right of the middle (the app icons, on Windows 11)
    return this.sitOn({ win: this.ledge(), dx: clamp(this.view.w - 440, this.view.w * 0.6, post.x) });
  }

  pickSeat({ frontOnly = false, except = null } = {}) {
    const options = [];
    for (const win of this.windows.wins) {
      if (win.id === except || !this.canSit(win)) continue;
      const dx = clamp(rand(win.w * 0.18, win.w * 0.6), 60, Math.max(60, win.w - 190));
      if (this.covered(win, win.x + dx)) continue;
      options.push({ win, dx });
    }
    const front = options.find((o) => o.win.id === this.windows.fg);
    if (frontOnly) return front || null;
    return front || options[0] || null;
  }

  // ---------- frame loop ----------

  interval() {
    if (this.stance === 'fall' || this.stance === 'walk' || this.stance === 'climb' || this.stance === 'wall_slide') return 0;
    if (this.busy || this.act?.player.act.fps === 24) return ON_ONES;
    return this.mode === 'sleep' ? ASLEEP : ON_TWOS;
  }

  loop(now) {
    requestAnimationFrame(this.loop);
    if (this.hidden) return;
    if (now - this.lastDraw < this.interval() - 1) return;
    this.drawFrame(now);
    this.behave(now);
  }

  drawFrame(now = performance.now()) {
    this.lastDraw = now;
    this.animate(now);
    this.sprite.draw(this.p);
    this.place();
  }

  // Pick the drawing: the stance's cycle underneath, the current act on top.
  animate(now) {
    const p = this.p;
    p.seed = Math.random() * 100; // a fresh drawing, so the line boils

    const under = this.base.sample(now);
    const base = under ? this.base.resolve(under.pose, this.facing) : {};
    let act = null;
    let cue = null;
    if (under && under.index !== this.baseIndex) {
      this.baseIndex = under.index;
      if (!this.act) cue = under.cue; // the stance's own cues, when no act is on top
    }
    if (this.act) {
      const drawing = this.act.player.sample(now);
      if (drawing) {
        act = this.act.player.resolve(drawing.pose, this.facing);
        if (drawing.index !== this.act.index) {
          this.act.index = drawing.index;
          cue = drawing.cue;
        }
      } else {
        this.endAct(true);
      }
    }
    const pose = { ...NEUTRAL, ...base, ...act };
    if (this.mode === 'sleep' && this.stance === 'sit' && !act) {
      Object.assign(pose, { head: 0.12, mane: -0.1, kickL: 0.03, kickR: 0.03, armL: -0.45, armR: -0.45 }); // dozing on the ledge
    }

    p.head = pose.head;
    p.mane = pose.mane;
    p.hair = pose.hair;
    p.armL = pose.armL;
    p.armR = pose.armR;
    p.longL = pose.longL;
    p.longR = pose.longR;
    p.kickL = pose.kickL;
    p.kickR = pose.kickR;
    p.smear = pose.smear;
    p.echo = pose.echo;
    if (pose.sit !== undefined) {
      p.sit = pose.sit;
    } else if (this.stance !== 'sit') {
      p.sit = 0;
    }
    if (!this.act && this.stance === 'fall' && (Math.abs(this.vx) > 50 || Math.abs(this.vy) > 100)) {
      p.smear = [-clamp(this.vx * 0.015, -18, 18), -clamp(this.vy * 0.015, -24, 24)];
      p.echo = [-clamp(this.vx * 0.008, -12, 12), -clamp(this.vy * 0.008, -14, 14)];
    }
    // on a ledge she stays seated: no lifting off it, no sinking through it
    const bob = this.stance === 'sit' ? clamp(pose.bob, -3, 2) : pose.bob;
    this.bob = this.dragging ? 0 : bob;
    if ((this.act || this.stance !== 'fall') && !this.dragging) {
      this.tilt = pose.tilt;
    }
    if (!this.act && this.stance === 'fall') {
      const speedStretch = clamp(Math.abs(this.vy) / 2800, 0, 0.16);
      this.sy = pose.sy + speedStretch;
      this.sx = pose.sx - speedStretch * 0.55;
    } else {
      this.sx = pose.sx;
      this.sy = pose.sy;
    }
    if (this.debug) Object.assign(p, this.debug); // --dev pose overrides
    if (cue) this.onCue(cue);
  }

  behave(now) {
    if (this.stance === 'fall') {
      this.updateFall(now);
      return;
    }
    if (this.stance === 'walk') {
      this.updateWalk(now);
      return;
    }
    if (this.stance === 'climb') {
      this.updateClimb(now);
      return;
    }
    if (this.stance === 'wall_slide') {
      this.updateWallSlide(now);
      return;
    }
    if (this.stance === 'wall_hang') {
      this.updateWallHang(now);
      return;
    }
    if (this.busy || this.dragging) return;

    if (now > this.nextTwitch) {
      this.nextTwitch = now + rand(5000, 13000);
      if (!reducedMotion.matches && this.mode !== 'sleep') this.twitch();
    }

    // a shard of her mane breaks off now and then and drifts away
    if (now > this.nextShed) {
      this.nextShed = now + rand(4000, 11000) * (this.mode === 'sleep' ? 2.5 : 1);
      if (!reducedMotion.matches && this.stance !== 'peek') this.shed();
    }

    if (this.mode === 'idle' && this.stance !== 'peek' && now > this.nextGaze) {
      this.nextGaze = now + rand(90000, 180000);
      this.gaze();
    }

    if (this.mode === 'idle' && now - this.lastActivity > SLEEP_AFTER) this.setMode('sleep');
    if (this.mode === 'sleep' && now - this.sleptAt > DOZE_AFTER) {
      this.doze();
      return;
    }

    if (this.stance === 'peek' && now > this.peekUntil) {
      this.unpeek();
      return;
    }

    // resting on the taskbar: a little while after anything happens, she goes back to sit on it
    if (this.restOn === 'taskbar' && this.mode === 'idle' && this.stance === 'stand'
      && now - this.lastActivity > 6000 && now > this.nextHome) {
      this.nextHome = now + 8000;
      this.goHome();
      return;
    }

    if (this.mode === 'idle' && now > this.nextMove) {
      this.nextMove = now + rand(25000, 70000);
      this.wanderStep();
    }

    if (this.mode === 'work' && now - this.lastGlyph > 420) {
      this.lastGlyph = now;
      const h = this.head();
      this.fx.glyph(h.x, h.y - 30);
    }
  }

  // What she does with herself when nobody needs her: walking, climbing walls, perching, flourishing.
  wanderStep() {
    if (!this.wander || this.stance === 'peek' || this.stance === 'walk' || this.stance === 'climb' || this.stance === 'wall_hang' || this.stance === 'wall_slide') {
      if (this.stance !== 'peek' && this.stance !== 'walk' && this.stance !== 'climb' && this.stance !== 'wall_hang' && this.stance !== 'wall_slide') {
        this.flourish();
      }
      return;
    }

    const s = this.scale;
    const minX = 40 * s + 15;
    const maxX = this.view.w - (40 * s + 15);

    // 1. If currently on a window ledge
    if (this.stance === 'sit' && this.perch?.id !== 'taskbar') {
      const win = this.perchWin(this.perch.id);
      const r = Math.random();
      if (win && r < 0.40) {
        // Walk along the window ledge!
        this.walkLedge(win);
        return;
      } else if (r < 0.60 && this.canPossess()) {
        this.possess();
        return;
      } else if (r < 0.80) {
        this.fall(); // hops off ledge with gravity
        return;
      } else if (r < 0.90) {
        this.flourish();
        return;
      } else {
        this.teleport(this.spot('random'));
        return;
      }
    }

    // 2. If sitting on taskbar ledge
    if (this.stance === 'sit' && this.perch?.id === 'taskbar') {
      const r = Math.random();
      if (r < 0.45) {
        // Stand up and walk across desktop
        const targetX = rand(minX, maxX);
        this.walkTo(targetX);
        return;
      } else if (r < 0.70) {
        // Walk directly to a wall and climb!
        const wallSide = Math.random() < 0.5 ? 'left' : 'right';
        this.walkTo(wallSide === 'left' ? minX : maxX, { climbOnWall: true });
        return;
      } else if (r < 0.85) {
        this.flourish();
        return;
      } else {
        this.teleport(this.spot('random'));
        return;
      }
    }

    // 3. If standing on the floor or floating
    const onGround = Math.abs(this.pos.y - this.floor) < 30;
    const seat = this.pickSeat();
    const r = Math.random();

    if (onGround) {
      if (r < 0.42) {
        // Roam/walk across desktop floor
        const targetX = rand(minX, maxX);
        const willClimb = Math.random() < 0.40;
        this.walkTo(willClimb ? (Math.random() < 0.5 ? minX : maxX) : targetX, { climbOnWall: willClimb });
        return;
      } else if (r < 0.68) {
        // Walk directly to closest wall and climb up!
        const wallSide = this.pos.x < this.view.w / 2 ? 'left' : 'right';
        this.walkTo(wallSide === 'left' ? minX : maxX, { climbOnWall: true });
        return;
      } else if (seat && r < 0.84) {
        this.sitOn(seat);
        return;
      } else if (r < 0.92) {
        this.peek();
        return;
      } else {
        this.flourish();
        return;
      }
    } else {
      // Floating higher up
      if (seat && r < 0.35) {
        this.sitOn(seat);
        return;
      } else if (r < 0.60) {
        // Climb nearby wall
        const wallSide = this.pos.x < this.view.w / 2 ? 'left' : 'right';
        this.startClimb(wallSide);
        return;
      } else if (r < 0.80) {
        this.fall();
        return;
      } else {
        this.flourish();
        return;
      }
    }
  }

  flourish() {
    if (this.stance === 'sit') this.perform(pick(['look', 'look', 'split']));
    else this.perform(pick(['spin', 'look', 'hop', 'curious', 'split', 'wave']), this.towardCenter());
  }

  // ---------- acting ----------

  // Play an act from acting.js. Resolves when it's over (or cut off by a stronger one).
  perform(name, dir = 0, { reach = 1 } = {}) {
    if (this.stowed || this.dormant) return Promise.resolve(); // nobody to act: she's in her biochip, or just her mask
    const act = ACTS[name];
    if (reducedMotion.matches && act.fps === 24) {
      if (act.flip) this.facing *= -1;
      return Promise.resolve();
    }
    const next = new Player(name, { dir, reach });
    if (this.act && this.act.player.priority > next.priority) return Promise.resolve();
    this.endAct(false);
    return new Promise((done) => {
      this.act = { player: next, done };
    });
  }

  endAct(completed) {
    const current = this.act;
    if (!current) return;
    this.act = null;
    if (completed && current.player.act.flip) this.facing *= -1;
    current.done();
  }

  // A warm wave to say hi: turns toward you, twitches and waves her claw hand
  wave() {
    if (this.stowed) this.unstow();
    if (this.dormant) this.rouse();
    this.wake();
    if (this.stance === 'peek') this.unpeek();
    this.endAct(false);
    this.facing = this.towardCenter();
    this.twitch();
    this.voice.play('hello');
    return this.perform('wave', this.towardCenter());
  }

  handshake() {
    return this.wave();
  }

  setStance(stance, { perch = null, peekSide = null, wallSide = null, dir = 0 } = {}) {
    this.stance = stance;
    this.perch = perch;
    this.peekSide = peekSide;
    this.wallSide = wallSide;
    this.p.sit = stance === 'sit' ? 1 : 0;
    this.base = this.restBase(dir);
    this.pivot();
  }

  // The cycle under her acts: her stance's, or holding her arm out at what she's showing you.
  restBase(dir = 0) {
    const pt = this.pointing;
    if (pt && (this.stance === 'stand' || this.stance === 'sit')) return new Player('pointing', { dir: pt.dir, reach: pt.reach });
    return new Player(this.baseAct(), { dir });
  }

  baseAct() {
    if (this.stance === 'sit') return 'sit';
    if (this.stance === 'peek') return 'peek';
    if (this.stance === 'fall') return 'fall';
    if (this.stance === 'walk') return 'walk';
    if (this.stance === 'climb') return 'climb';
    if (this.stance === 'wall_hang') return 'wall_hang';
    if (this.stance === 'wall_slide') return 'wall_slide';
    return this.mode === 'sleep' ? 'sleep' : 'stand';
  }

  setMode(mode) {
    const now = performance.now();
    if (mode !== 'sleep') this.lastActivity = now;
    // after anything happens, stay put a while (so she doesn't wander off right after "done")
    this.nextMove = Math.max(this.nextMove, now + rand(55000, 120000));
    this.nextGaze = Math.max(this.nextGaze, now + rand(30000, 70000));
    if (this.mode === mode) return;
    const prev = this.mode;
    this.mode = mode;
    if (mode === 'sleep') this.sleptAt = now;
    this.onMode?.(mode, prev);
    if (this.stance === 'stand') this.base = this.restBase();
    const p = this.p;
    if (mode === 'sleep') tween(p, { alpha: 0.55, sparkle: 0.35, boil: 0.4 }, 900, ease.inOut);
    else tween(p, { alpha: 1, sparkle: 1, boil: 0.9 }, 250, ease.out);
  }

  wake() {
    if (this.mode === 'sleep') this.setMode('idle');
    this.lastActivity = performance.now();
    if (this.dormant) this.rouse(); // down to her mask: she comes back
  }

  // Somewhere to be while Claude works: on the window in front if she can sit on it, else her corner.
  goToWork() {
    this.stopWalking();
    this.stopClimbing();
    this.setMode('work');
    const seat = this.pickSeat({ frontOnly: true });
    if (seat) {
      if (this.stance === 'sit' && this.perch?.id === seat.win.id) return;
      this.sitOn(seat);
      return;
    }
    if (this.restOn === 'taskbar') {
      this.goHome();
      return;
    }
    const post = this.spot('post');
    if (this.stance !== 'stand' || Math.hypot(post.x - this.pos.x, post.y - this.pos.y) > 320) this.teleport(post);
  }

  // Claude did something: come out of hiding.
  attend() {
    this.wake();
    this.stopWalking();
    this.stopClimbing();
    if (this.stance === 'peek' && !this.busy) this.teleport(this.spot('post'));
  }

  twitch() {
    const p = this.p;
    p.glitchSeed = Math.random() * 100;
    p.glitch = rand(0.15, 0.3);
    p.split = 2;
    setTimeout(() => {
      p.glitch = 0;
      p.split = 0;
    }, ON_TWOS * 2);
  }

  // a small jolt each time Claude touches something
  pulse() {
    if (this.busy || reducedMotion.matches) return;
    const p = this.p;
    p.glitchSeed = Math.random() * 100;
    p.glitch = 0.12;
    setTimeout(() => { p.glitch = 0; }, ON_TWOS);
  }

  shed() {
    const s = this.scale;
    const h = this.head();
    const a = rand(-Math.PI * 0.95, -Math.PI * 0.05); // somewhere on the upper rim of the mane
    const r = rand(70, 100) * s;
    this.fx.drift(h.x + Math.cos(a) * r, h.y - 40 * s + Math.sin(a) * r * 0.85, a);
  }

  // A point of the sprite (sprite px) on screen, where she stands, the way she faces.
  toScreen(sx, sy) {
    const s = this.scale;
    return {
      x: this.pos.x + (sx - SPRITE.feet.x) * s * this.facing,
      y: this.pos.y - (SPRITE.feet.y - sy) * s + this.bob,
    };
  }

  // Which arm points to screen side `dir`: 'L' or 'R' (the sprite may be mirrored).
  armToward(dir) {
    return dir * this.facing < 0 ? 'L' : 'R';
  }

  // Shoulder and hand of one arm on screen, at the arm's current angle (same turn as the shader).
  limb(side) {
    const { shoulder, hand, mirror } = SPRITE;
    const a = side === 'L' ? this.p.armL : this.p.armR;
    const k = side === 'L' ? this.p.longL : this.p.longR;
    const vx = (hand.x - shoulder.x) * k, vy = (hand.y - shoulder.y) * k;
    let hx = shoulder.x + Math.cos(a) * vx - Math.sin(a) * vy;
    const hy = shoulder.y + Math.sin(a) * vx + Math.cos(a) * vy;
    let sx = shoulder.x;
    if (side === 'R') {
      hx = mirror - hx;
      sx = mirror - sx;
    }
    return { shoulder: this.toScreen(sx, shoulder.y), hand: this.toScreen(hx, hy) };
  }

  // The satellite. It crosses high over the open side of the screen, slowly, and her hand
  // follows it. Mostly she just looks at it ("gaze"). She sends the red light up to it
  // ("uplink") only when it means something: the first time of the day, and a little while
  // after Claude finishes a long job (earnUplink). The cues in onCue do the sky.
  gaze({ big } = {}) {
    if (this.busy || this.hidden || this.act || this.stance === 'peek' || this.stance === 'fall') return false;
    big ??= this.uplinkDue || this.lastUplinkDay() !== today();
    if (reducedMotion.matches) big = false; // no strobing bolt
    if (big) {
      this.uplinkDue = false;
      try {
        localStorage.setItem(UPLINK_DAY, today());
      } catch {
        // no storage: she'll just do it again next launch
      }
    }
    const dir = this.towardCenter();
    const { w } = this.view;
    const side = this.armToward(dir);
    const { shoulder } = this.limb(side);
    // up and well off to the side, so her arm points at it clear of her mane
    const y = clamp(shoulder.y - rand(280, 400), 50, shoulder.y - 180);
    const x = clamp(shoulder.x + dir * rand(380, 520), 40, w - 40);
    const to = { x: clamp(x + dir * rand(170, 260), 30, w - 30), y: y - rand(10, 40) };
    const sat = this.fx.satellite({ x, y }, to, { duration: 9500 });
    // how far up the arm must come to point at it right now (it hangs ~30 degrees low at rest)
    const reach = () => {
      const at = sat.pos();
      const sh = this.limb(side).shoulder;
      return clamp(Math.atan2(sh.y - at.y, Math.abs(at.x - sh.x)) + 0.52, 0.5, 1.6);
    };
    // from her fingertips to it
    const road = () => [this.limb(side).hand, sat.pos()];
    this.sky = { sat, road, dir, side, motes: null, surge: null, head: null };
    if (!big) this.onGaze?.('start');
    this.perform(big ? 'uplink' : 'gaze', dir, { reach }).then(() => {
      this.clearSky();
      if (big) this.onGaze?.('end');
    });
    return true;
  }

  lastUplinkDay() {
    try {
      return localStorage.getItem(UPLINK_DAY);
    } catch {
      return null;
    }
  }

  // Claude just finished a long job: the next time she looks up, once things have settled, it's the whole thing.
  earnUplink() {
    this.uplinkDue = true;
    this.nextGaze = performance.now() + rand(25000, 40000);
  }

  clearSky() {
    if (!this.sky) return;
    const { sat, motes, surge } = this.sky;
    surge?.break();
    motes?.home(...this.moved());
    sat.fade();
    this.sky = null;
    tween(this.p, { sparkle: this.mode === 'sleep' ? 0.35 : 1 }, 400, ease.out);
  }

  // How far her head has moved since her stars lifted off it.
  moved() {
    const was = this.sky?.head;
    if (!was) return [0, 0];
    const h = this.head();
    return [h.x - was.x, h.y - was.y];
  }

  // Points on her mane, where her white specks are (for the stars that lift off it).
  manePoints(n) {
    const s = this.scale;
    const h = this.head();
    return Array.from({ length: n }, () => {
      const a = rand(0, Math.PI * 2), r = Math.sqrt(Math.random());
      return { x: h.x + Math.cos(a) * r * 92 * s, y: h.y - 44 * s + Math.sin(a) * r * 66 * s };
    });
  }

  // Red sparks off her fingers: she's hacking something. On a window, she jacks into it:
  // the sparks go down into the ledge and run along it.
  spark() {
    if (this.busy || this.hidden || reducedMotion.matches || this.stance === 'peek' || this.stance === 'fall') return;
    const s = this.scale;
    const side = Math.random() < 0.5 ? 'L' : 'R';
    const { hand } = this.limb(side);
    const out = (side === 'L' ? -1 : 1) * this.facing;
    if (this.stance === 'sit') {
      const ledge = this.pos.y - (SPRITE.feet.y - SPRITE.hip) * s - 3;
      const at = { x: hand.x + out * rand(10, 40) * s, y: ledge };
      const run = { x: at.x + out * rand(90, 200), y: ledge + rand(-2, 2) };
      this.fx.bolt(hand, at, { life: 200, forks: 1, width: 2 });
      this.fx.bolt(at, run, { life: 260, forks: 2, width: 2 });
    } else {
      for (let i = 0; i < 2; i++) {
        const to = { x: hand.x + out * rand(30, 80) * s, y: hand.y + rand(-50, 30) * s };
        this.fx.bolt(hand, to, { life: rand(140, 220), forks: 1, width: 2 });
      }
    }
    this.voice.play('bolt', { soft: true });
  }

  // The menace: a jolt of red lightning at your pointer, and a grin.
  zap(x, y) {
    if (this.busy || this.hidden || this.act || reducedMotion.matches || this.stance !== 'stand') return false;
    const dir = x < this.pos.x ? -1 : 1;
    const side = this.armToward(dir);
    const reach = () => {
      const sh = this.limb(side).shoulder;
      return clamp(Math.atan2(sh.y - y, Math.abs(x - sh.x)) + 0.52, -0.3, 1.6);
    };
    this.zapAt = { x, y, side, dir };
    this.perform('zap', dir, { reach });
    return true;
  }

  // Where a cut-in goes, as fx.cutin's (x, y, dir): next to her head on the `dir` side, else on
  // the other side (unless `flip` is off because something is going on there), else over her mane.
  cutinAt(dir, { flip = true } = {}) {
    const s = this.scale;
    const h = this.head();
    const gap = 85 * s + 24, width = 274; // the band plus its slant, see fx.js
    const fits = (d) => (d > 0 ? h.x + gap + width < this.view.w - 8 : h.x - gap - width > 8);
    if (fits(dir)) return [h.x + dir * gap, h.y - 18, dir];
    if (flip && fits(-dir)) return [h.x - dir * gap, h.y - 18, -dir];
    return [clamp(h.x - width / 2, 8, this.view.w - width - 8), Math.max(56, h.top - 58), 1];
  }

  // Flat-colour impact frames, one drawing each.
  async flash(colors) {
    const p = this.p;
    for (const color of colors) {
      p.sil = color;
      p.silAmount = 1;
      this.drawFrame();
      await sleep(ON_ONES);
    }
    p.silAmount = 0;
  }

  // Effects and sounds pinned to drawings of an act (the third item of a key in acting.js).
  onCue(cue) {
    const s = this.scale;
    const h = this.head();
    const mane = { x: h.x, y: h.y - 40 * s };
    switch (cue) {
      case 'gather': // shards sucked into the mane before it blows
        this.fx.burst(mane.x, mane.y, { count: 18, inward: true, power: 0.7, spread: 170 * s });
        break;
      case 'launch':
        this.voice.play('rise');
        this.fx.slices(h.x - 70 * s, h.y - 40 * s, 170 * s, 300 * s, { count: 5 });
        break;
      case 'peak':
        this.voice.play('done');
        this.fx.lines(mane.x, mane.y, { inner: 150 * s + 30 });
        this.fx.ring(mane.x, mane.y);
        this.fx.burst(mane.x, mane.y, { count: 34, power: 1.2, spread: 140 * s });
        setTimeout(() => this.flash([GREEN, INK, GREEN]), 0);
        break;
      case 'speak':
        this.fireSpeak();
        break;
      case 'laugh':
        this.fx.cutin(...this.cutinAt(this.act?.player.dir || this.towardCenter()), { kind: pick(['laugh', 'grin']) });
        break;
      case 'stare': // every eye she has, on you
        this.fx.cutin(...this.cutinAt(this.act?.player.dir || this.towardCenter()), { kind: 'many', life: 640 });
        break;
      case 'notice':
        this.twitch();
        break;
      case 'zap':
        if (this.zapAt) {
          const { x, y, side } = this.zapAt;
          this.fx.bolt(this.limb(side).hand, { x, y }, { life: 240, forks: 2, width: 3 });
          this.fx.burst(x, y, { count: 8, power: 0.35, spread: 16 });
          this.fx.ring(x, y, { size: 0.22 });
          this.voice.play('bolt');
        }
        break;
      case 'grin':
        if (this.zapAt && Math.random() < 0.6) this.fx.cutin(...this.cutinAt(-this.zapAt.dir), { kind: 'look', life: 560 });
        this.zapAt = null;
        break;
      // pointing at something (pointAt)
      case 'spot': // her head snaps to it: a glint where she's looking
        if (this.pointing) {
          const { aim } = this.pointing;
          this.fx.ring(aim.x, aim.y, { size: 0.18 });
          this.voice.play('tick');
        }
        break;
      case 'coil': // winding up: shards pulled into her, a crackle
        this.fx.burst(h.x, h.y + 40 * s, { count: 10, inward: true, power: 0.45, spread: 90 * s });
        this.voice.play('bolt', { soft: true });
        break;
      case 'lock': { // the strike: lightning off her fingertip, the reticle slams onto it
        const pt = this.pointing;
        if (pt && !pt.pointer) {
          const hand = this.limb(pt.side).hand;
          pt.pointer = this.fx.pointer(() => this.limb(pt.side).hand, pt.rect, pt.aim, { label: pt.label });
          if (!reducedMotion.matches) {
            this.fx.bolt(hand, pt.aim, { life: 260, forks: 3, width: 3 });
            this.fx.ring(pt.aim.x, pt.aim.y, { size: 0.55 });
            this.fx.burst(pt.aim.x, pt.aim.y, { count: 12, power: 0.5, spread: 20 });
            // her eyes lock on, on the side away from it
            this.fx.cutin(...this.cutinAt(-pt.dir, { flip: false }), { kind: 'eyes', life: 480 });
          }
          this.voice.play('bolt');
        }
        break;
      }
      case 'tap':
        this.pointing?.pointer?.tap();
        break;
      case 'minds':
        this.twitch();
        break;
      case 'snap':
        this.twitch();
        this.voice.play('tick');
        break;
      case 'step':
        this.voice.play('tick', { soft: true });
        this.fx.burst(this.pos.x, this.pos.y - 2, { count: 3, power: 0.18, spread: 8 * s });
        break;
      case 'grip': {
        this.voice.play('tick', { soft: true });
        const wallX = this.wallSide === 'left' ? this.pos.x - 8 * s : this.pos.x + 8 * s;
        this.fx.burst(wallX, this.pos.y - 110 * s, { count: 3, power: 0.25, spread: 12 * s });
        break;
      }
      case 'slide_spark': {
        this.voice.play('tick', { soft: true });
        const sparkX = this.wallSide === 'left' ? this.pos.x - 8 * s : this.pos.x + 8 * s;
        this.fx.burst(sparkX, this.pos.y - 80 * s, { count: 4, power: 0.35, spread: 16 * s });
        break;
      }
      case 'trip_slip':
        this.voice.play('blip', { mood: 'alert' });
        this.fx.burst(this.pos.x, this.pos.y - 4, { count: 6, power: 0.35, spread: 22 * s });
        break;
      case 'land_impact':
        this.voice.play('tick', { soft: true });
        break;
      case 'trip_impact':
        this.voice.play('tick');
        this.fx.burst(this.pos.x, this.pos.y - 4, { count: 12, power: 0.55, spread: 35 * s });
        this.p.glitch = 0.22;
        setTimeout(() => { this.p.glitch = 0; }, 90);
        this.onTripFall?.();
        break;
      default:
        if (this.sky) this.skyCue(cue);
        break;
    }
  }

  // The satellite's cues (acting.js "gaze" and "uplink").
  skyCue(cue) {
    const s = this.scale;
    const sky = this.sky;
    const hand = () => this.limb(sky.side).hand;
    switch (cue) {
      case 'glint':
        this.voice.play('star');
        break;
      case 'starlight': // her specks catch its light
        tween(this.p, { sparkle: 1.8 }, 500, ease.out);
        break;
      case 'stars': // they lift off and become a sky; her mane goes dark without them
        sky.head = this.head();
        sky.motes = this.fx.motes(this.manePoints(30), { lift: 230 * s + 60, spread: 320 * s + 80 });
        tween(this.p, { sparkle: 0.15 }, 500, ease.out);
        break;
      case 'align': // into a road, from her fingers to it
        sky.motes?.align(sky.road);
        this.voice.play('tick');
        break;
      case 'charge': {
        this.fx.crackle(hand, { life: 640, radius: 70 * s + 14, count: 3 });
        const at = hand();
        this.fx.burst(at.x, at.y, { count: 14, inward: true, power: 0.5, spread: 90 * s });
        this.fx.cutin(...this.cutinAt(-sky.dir, { flip: false }), { kind: 'eyes', life: 600 }); // never over the road
        this.voice.play('charge');
        break;
      }
      case 'surge': { // the red light goes up
        const at = hand();
        sky.surge = this.fx.surge(sky.road, {
          onHit: () => {
            const top = sky.sat.pos();
            sky.sat.twinkle(1.25);
            this.fx.ring(top.x, top.y, { size: 0.55 });
            this.fx.lines(top.x, top.y, { inner: 60, life: 460 });
            this.voice.play('star');
          },
        });
        sky.motes?.light(125);
        this.fx.ring(at.x, at.y, { size: 0.6 });
        this.flash([INK, RED]);
        this.voice.play('bolt');
        this.voice.play('rise');
        break;
      }
      case 'break':
        sky.surge?.break();
        sky.surge = null;
        sky.motes?.dim();
        this.voice.play('tick');
        break;
      case 'twinkle': { // and it answers
        const at = sky.sat.pos();
        sky.sat.twinkle(1);
        this.fx.ring(at.x, at.y, { size: 0.4 });
        this.voice.play('star');
        break;
      }
      case 'glimmer':
        sky.sat.twinkle(0.55);
        if (!sky.motes) this.voice.play('star');
        break;
      case 'home': // her stars come back to her, and her mane lights up with them
        sky.motes?.home(...this.moved());
        sky.motes = null;
        tween(this.p, { sparkle: 1.7 }, 400, ease.out).then(() => tween(this.p, { sparkle: 1 }, 700, ease.inOut));
        break;
    }
  }

  fireSpeak() {
    const fn = this.onSpeak;
    this.onSpeak = null;
    fn?.();
  }

  async hurt() {
    this.perform('flinch');
    if (reducedMotion.matches) return;
    const p = this.p;
    p.sil = RED;
    p.silAmount = 1;
    this.drawFrame();
    await sleep(ON_TWOS);
    p.silAmount = 0;
    p.glitchSeed = Math.random() * 100;
    p.glitch = 0.7;
    p.split = 7;
    await tween(p, { glitch: 0, split: 0 }, 450, ease.out);
  }

  // Job done: the victory sequence (acting.js), its effects on cue. onSpeak runs when she
  // comes back down (that's when the "done" panel comes in), or at the end if anything cut it short.
  async celebrate({ onSpeak } = {}) {
    this.onSpeak = onSpeak;
    if (reducedMotion.matches || this.stowed || this.dormant) {
      this.voice.play('done');
      this.fireSpeak();
      return;
    }
    await this.perform('victory', this.towardCenter());
    this.fireSpeak();
  }

  // ---------- moving around ----------

  // Collapse into a line of light and go. Leaves her invisible; the caller puts her somewhere.
  async vanish({ beam = true } = {}) {
    const p = this.p;
    const s = this.scale;
    const from = { ...this.pos };
    const head = this.head();
    if (this.sky) this.endAct(false); // the satellite stays here, she doesn't
    this.stopPointing(); // nor does what she was showing you
    if (reducedMotion.matches) {
      await tween(p, { alpha: 0 }, 160, ease.linear);
      return head;
    }
    this.voice.play('teleport-out');
    p.glitchSeed = Math.random() * 100;
    await tween(p, { glitch: 0.35, split: 3 }, 90, ease.linear);
    this.fx.burst(head.x, head.y + 70 * s, { count: 22, spread: 150 * s });
    this.fx.slices(head.x - 70 * s, head.y - 40 * s, 170 * s, 320 * s);
    await tween(p, { collapse: 1, glitch: 1, dissolve: 0.5, split: 9 }, 170, ease.in);
    p.alpha = 0;
    const ground = from.y - (this.p.sit ? (SPRITE.feet.y - SPRITE.hip) * s : 0);
    if (!this.upside) {
      // the void she leaves behind, like in the show: a black slit with a red line in it
      this.fx.slit(from.x - 10 * s * this.facing, head.top, ground, { width: 56 * s + 10 });
      if (beam) this.fx.beam(from.x, ground, { width: 40 * s + 8 });
    }
    return head;
  }

  // Come back at `to`: a column of light down to her, the body unfolding, two impact frames.
  async arrive(to, { face = null, stance = 'stand', perch = null, peekSide = null, dir = 0, fromHead = null, beam = true } = {}) {
    const p = this.p;
    const s = this.scale;
    const facing = face ?? (to.x > this.view.w / 2 ? 1 : -1);
    const toHead = this.head(to, facing);
    if (fromHead && !reducedMotion.matches) {
      this.fx.streak(fromHead.x, fromHead.y, toHead.x, toHead.y);
      await sleep(60);
    }
    this.pos = { ...to };
    this.facing = facing;
    this.setStance(stance, { perch, peekSide, dir });
    this.place();

    if (reducedMotion.matches) {
      p.collapse = 0;
      p.dissolve = 0;
      await tween(p, { alpha: this.mode === 'sleep' ? 0.55 : 1 }, 160, ease.linear);
      return;
    }
    const ground = stance === 'sit' ? to.y - (SPRITE.feet.y - SPRITE.hip) * s : to.y;
    if (beam) this.fx.beam(to.x, ground, { down: true, width: 40 * s + 8 });
    // her pieces spiral back in, mane shards and green eye-stars
    this.fx.vortex(toHead.x, toHead.y + 30 * s, { radius: 170 * s + 40 });
    this.voice.play('teleport-in');
    await sleep(50);

    p.alpha = this.mode === 'sleep' ? 0.55 : 1;
    p.glitchSeed = Math.random() * 100;
    await tween(p, { collapse: 0, dissolve: 0, glitch: 0.6, split: 6 }, 200, ease.out);

    // two impact frames, the anime way
    p.sil = GREEN;
    p.silAmount = 1;
    this.drawFrame();
    await sleep(ON_ONES);
    p.sil = INK;
    this.drawFrame();
    await sleep(ON_ONES);
    p.silAmount = 0;
    this.fx.burst(toHead.x, toHead.y + 60 * s, { count: 10, power: 0.55, spread: 110 * s });
    if (stance === 'sit') this.perform('plop');
    await tween(p, { glitch: 0, split: 0 }, 220, ease.out);
  }

  // Leave in a column of light, reappear somewhere else.
  async teleport(to, opts = {}) {
    if (this.stowed) return; // put away: she stays in her biochip
    if (this.busy || this.dormant) {
      this.pending = { to, opts };
      if (this.dormant) this.rouse(); // asleep, down to her mask: she comes back first, then goes
      return;
    }
    this.busy = true;
    this.wake();
    this.onTeleport?.('start');
    const fromHead = await this.vanish();
    await sleep(70);
    await this.arrive(to, { ...opts, fromHead });
    await this.settle();
  }

  // After a move: free again, stay put a while, the panel back, and the move that was waiting, if any.
  async settle() {
    this.busy = false;
    this.nextMove = Math.max(this.nextMove, performance.now() + rand(25000, 60000));
    this.onTeleport?.('end');
    if (this.pending) {
      const next = this.pending;
      this.pending = null;
      await this.teleport(next.to, next.opts);
    }
  }

  // Ctrl+Alt+C: she folds herself into her biochip in the corner (she pulls in, collapses, and
  // a streak runs from her to the chip). Asleep down to her mask, it's the mask that goes.
  async stow() {
    if (this.stowed || this.stowing) return;
    this.stowing = true;
    for (let i = 0; this.busy && i < 30; i++) await sleep(100); // let a move finish
    this.busy = true;
    this.endAct(false);
    this.onTeleport?.('start');
    let from = null;
    if (this.dormant) {
      from = this.head();
      this.dormant = false;
      this.onDoze?.('end');
    }
    if (reducedMotion.matches) {
      await tween(this.p, { alpha: 0 }, 160, ease.linear);
    } else {
      if (!from) {
        await this.perform('fold');
        from = await this.vanish({ beam: false });
      }
      const chip = this.chipAt();
      this.fx.streak(from.x, from.y, chip.x, chip.y);
      await sleep(60);
      this.fx.burst(chip.x, chip.y, { count: 12, inward: true, power: 0.45, spread: 40 });
      this.fx.ring(chip.x, chip.y, { size: 0.3 });
      this.voice.play('land');
    }
    this.setStance('stand');
    this.stowed = true;
    this.stowing = false;
    this.hidden = true;
    this.root.hidden = true;
    this.onStow?.();
    this.busy = false;
    if (this.unstowAfter) this.unstow(); // called back out while she was folding herself away
  }

  // Already in it, no show (put away last time, she starts in it).
  stowNow() {
    this.stowed = true;
    this.hidden = true;
    this.root.hidden = true;
    this.p.alpha = 0;
    this.onTeleport?.('start');
    this.onStow?.();
  }

  // Asleep a while: her mane and her body come apart (shards drifting down, the drawing
  // dissolving) and all that's left is her mask, floating there, eyes shut (chip.js Mask).
  async doze() {
    if (this.busy || this.dormant || this.stowed || this.hidden) return;
    this.busy = true;
    this.endAct(false);
    this.onTeleport?.('start');
    this.dozedOn = this.stance === 'sit' ? { ...this.perch } : null;
    const s = this.scale;
    const h = this.head();
    if (!reducedMotion.matches) {
      for (let i = 0; i < 10; i++) this.shed();
      this.fx.burst(h.x, h.y + 60 * s, { count: 10, power: 0.3, spread: 120 * s });
      this.p.glitchSeed = Math.random() * 100;
      await tween(this.p, { dissolve: 0.9, glitch: 0.25, sparkle: 0 }, 700, ease.in);
    }
    this.setStance('stand'); // no ledge to fall off while she's away
    Object.assign(this.p, { alpha: 0, dissolve: 0, glitch: 0 });
    this.hidden = true;
    this.root.hidden = true;
    this.dormant = true;
    this.onDoze?.('start', h);
    this.busy = false;
  }

  // Back from her mask: her eyes snap open, then she comes back together around it,
  // on her ledge again if it's still there.
  async rouse() {
    if (!this.dormant) return;
    this.dormant = false;
    this.busy = true;
    this.onDoze?.('waking');
    if (this.mode === 'sleep') this.setMode('idle');
    this.lastActivity = performance.now();
    await sleep(reducedMotion.matches ? 0 : 280);
    this.onDoze?.('end');
    this.hidden = false;
    this.root.hidden = false;
    Object.assign(this.p, { alpha: 0, collapse: 0.6, dissolve: 0.5, glitch: 0, split: 0, sparkle: 1 });
    const win = this.dozedOn && this.perchWin(this.dozedOn.id);
    if (win && this.canSit(win) && !this.covered(win, win.x + this.dozedOn.dx)) {
      await this.arrive(this.seat(win, this.dozedOn.dx), { face: this.facing, stance: 'sit', perch: this.dozedOn, beam: false });
    } else {
      await this.arrive({ x: this.pos.x, y: this.dozedOn ? this.floor : this.pos.y }, { face: this.facing, beam: false });
    }
    this.dozedOn = null;
    await this.settle();
  }

  // Out of her biochip: a streak from the chip, and she arrives next to it.
  async unstow() {
    this.unstowAfter = this.stowing;
    if (!this.stowed) return;
    this.stowed = false;
    this.busy = true;
    this.onUnstow?.();
    this.hidden = false;
    this.root.hidden = false;
    if (this.mode === 'sleep') this.setMode('idle');
    this.lastActivity = performance.now();
    Object.assign(this.p, { alpha: 0, collapse: 1, dissolve: 0.5, glitch: 0, split: 0 });
    const chip = this.chipAt();
    const to = this.spot('chip');
    const face = to.x > this.view.w / 2 ? 1 : -1;
    if (!reducedMotion.matches) {
      const toHead = this.head(to, face);
      this.fx.burst(chip.x, chip.y, { count: 10, power: 0.5, spread: 30 });
      this.fx.streak(chip.x, chip.y, toHead.x, toHead.y);
      await sleep(60);
    }
    await this.arrive(to, { face, beam: false });
    await this.settle();
  }

  sitOn({ win, dx }) {
    return this.teleport(this.seat(win, dx), { stance: 'sit', perch: { id: win.id, dx }, face: this.facing });
  }

  canPossess() {
    return this.possessWindows && !this.busy && !this.hidden && this.stance === 'sit' && !reducedMotion.matches
      && this.windows.wins.some((w) => w.id === this.perch?.id);
  }

  // Like in the show, she gets into things: she dives into the window she sits on and takes it
  // over (fx.possess: its frame crackles, it glitches, it looks at you with her eyes), then comes
  // out of another window, or further along this one if there's no other.
  async possess() {
    if (!this.canPossess()) return false;
    const s = this.scale;
    const id = this.perch.id;
    const win = this.windows.wins.find((w) => w.id === id);
    const entry = this.pos.x - win.x;
    this.busy = true;
    this.wake();
    this.onTeleport?.('start');
    await this.perform('dive');
    const head = await this.vanish({ beam: false });
    this.fx.streak(head.x, head.y, this.pos.x, win.y + 40 * s);

    const rect = () => this.windows.wins.find((w) => w.id === id) || null;
    const covers = () => {
      const front = [];
      for (const o of this.windows.wins) {
        if (o.id === id) break;
        front.push(o);
      }
      return front;
    };
    const taken = this.fx.possess(rect, { covers, entry, look: () => this.mouse });
    this.voice.play('bolt');
    await sleep(300);
    this.voice.play('possess');
    await sleep(1600);
    taken.leave();
    await sleep(260);

    const here = rect();
    let seat = this.pickSeat({ except: id });
    if (!seat && here && this.canSit(here)) {
      const dx = clamp(here.w - entry + rand(-60, 60), 60, Math.max(60, here.w - 190)); // the other end of it
      if (!this.covered(here, here.x + dx)) seat = { win: here, dx };
    }
    const to = seat ? this.seat(seat.win, seat.dx) : this.spot('random');
    const toHead = this.head(to);
    if (here) {
      // out through the system, from the middle of the window to where she comes out
      this.fx.streak(here.x + here.w / 2, here.y + here.h * 0.46, toHead.x, toHead.y);
      await sleep(60);
    }
    if (seat) this.fx.slit(to.x, toHead.top, seat.win.y, { width: 56 * s + 10 }); // the void she climbs out of
    await this.arrive(to, seat ? { stance: 'sit', perch: { id: seat.win.id, dx: seat.dx }, beam: false } : {});
    await this.settle();
    return true;
  }

  // Lean in from an edge of the screen: vanish, then slide in on twos, three drawings.
  async peek(side = pick(['left', 'right', 'top'])) {
    if (this.busy) return;
    const s = this.scale;
    const { w, h } = this.view;
    let at, from, facing, dir;
    if (side === 'left') {
      const y = rand(h * 0.55, this.floor);
      facing = -1;
      dir = 1;
      at = { x: 14 * s, y };
      from = { x: -170 * s, y };
    } else if (side === 'right') {
      const y = rand(h * 0.55, this.floor);
      facing = 1;
      dir = -1;
      at = { x: w - 14 * s, y };
      from = { x: w + 170 * s, y };
    } else {
      // hanging upside down from the top edge, only the head and the mane showing
      const x = rand(w * 0.2, w * 0.8);
      facing = pick([1, -1]);
      dir = x > w / 2 ? -1 : 1;
      at = { x, y: -226 * s };
      from = { x, y: -470 * s };
    }

    this.busy = true;
    this.wake();
    this.onTeleport?.('start');
    if (this.p.alpha > 0) await this.vanish();
    this.pos = { ...from };
    this.facing = facing;
    this.setStance('peek', { peekSide: side, dir });
    this.p.collapse = 0;
    this.p.dissolve = 0;
    this.p.glitch = 0;
    this.p.split = 0;
    this.p.alpha = this.mode === 'sleep' ? 0.55 : 1;
    if (reducedMotion.matches) {
      this.pos = at;
    } else {
      for (const k of [0.45, 0.8, 1]) {
        this.pos = { x: lerp(from.x, at.x, k), y: lerp(from.y, at.y, k) };
        this.drawFrame();
        await sleep(ON_TWOS);
      }
    }
    this.peekFrom = from;
    this.peekUntil = performance.now() + rand(15000, 40000);
    this.busy = false;
    this.onTeleport?.('end');
  }

  // Duck back out of view, then show up somewhere else (or peek from another edge, if shy).
  async unpeek({ shy = false } = {}) {
    if (this.busy || this.stance !== 'peek') return;
    this.busy = true;
    const at = { ...this.pos };
    const from = this.peekFrom || at;
    if (!reducedMotion.matches) {
      for (const k of [0.4, 0.8, 1]) {
        this.pos = { x: lerp(at.x, from.x, k), y: lerp(at.y, from.y, k) };
        this.drawFrame();
        await sleep(ON_TWOS);
      }
    }
    this.p.alpha = 0;
    this.p.collapse = 1;
    this.p.dissolve = 0.5;
    this.busy = false;
    const side = this.peekSide;
    this.setStance('stand');
    if (shy && Math.random() < 0.6) {
      this.peek(pick(['left', 'right', 'top'].filter((x) => x !== side)));
      return;
    }
    this.busy = true;
    this.onTeleport?.('start');
    const seat = this.wander ? this.pickSeat() : null;
    if (seat && Math.random() < 0.4) {
      await this.arrive(this.seat(seat.win, seat.dx), { stance: 'sit', perch: { id: seat.win.id, dx: seat.dx } });
    } else {
      await this.arrive(this.spot('random'));
    }
    this.busy = false;
    this.onTeleport?.('end');
  }

  // Where she'd end up falling straight down from here: a free ledge under her, or the floor.
  landing() {
    const hip = this.pos.y - (SPRITE.feet.y - SPRITE.hip) * this.scale;
    let best = null;
    for (const win of this.windows.wins) {
      if (!this.canSit(win) || win.y < hip - 4) continue;
      if (this.pos.x < win.x + 40 || this.pos.x > win.x + win.w - 40) continue;
      if (this.covered(win, this.pos.x)) continue;
      if (!best || win.y < best.y) best = win;
    }
    if (best) {
      const dx = this.pos.x - best.x;
      return { y: this.seat(best, dx).y, stance: 'sit', perch: { id: best.id, dx } };
    }
    return { y: this.floor, stance: 'stand', perch: null };
  }

  fall({ vx = 0, vy = 0, flung = false } = {}) {
    if (this.stance === 'fall') {
      this.vx = vx;
      this.vy = vy;
      this.flung = flung;
      this.bounces = 0;
      return;
    }
    if (this.sky) this.endAct(false);
    this.landingSpot = this.landing();
    this.setStance('fall');
    this.vx = vx;
    this.vy = vy;
    this.flung = flung;
    this.bounces = 0;
    this.edgeHits = 0;
    this.vRot = flung ? clamp(vx * 0.15, -420, 420) : 0;
    this.lastFall = performance.now();
    if (flung) {
      this.voice.play('rise');
      if (Math.hypot(vx, vy) > 650) {
        this.voice.play('blip', { mood: 'alert' });
      }
      this.p.glitch = 0.22;
      setTimeout(() => { this.p.glitch = 0; }, 120);
      this.fx.burst(this.pos.x, this.pos.y - 40 * this.scale, { count: 8, power: 0.5, spread: 30 * this.scale });
    }
    if (reducedMotion.matches) this.updateFall(this.lastFall + 10000);
  }

  fling(vx, vy) {
    this.fall({ vx, vy, flung: true });
  }

  updateFall(now) {
    const dt = Math.min(0.04, (now - this.lastFall) / 1000);
    this.lastFall = now;
    if (dt <= 0) return;

    const s = this.scale;
    if (reducedMotion.matches) {
      const spot = this.landingSpot || this.landing();
      this.pos = { x: clamp(this.pos.x, 60, this.view.w - 60), y: spot.y };
      this.settleLanded(spot.stance, spot.perch);
      return;
    }

    // 1. Gravity
    this.vy = Math.min(this.vy + GRAVITY * dt, 2600);

    // 2. Air resistance / damping
    this.vx *= Math.pow(0.985, dt * 60);

    // 3. Rotation & tilt dynamics
    if (!this.act) {
      if (Math.abs(this.vRot) > 5) {
        this.tilt += this.vRot * dt;
        this.vRot *= Math.pow(0.90, dt * 60);
      } else {
        const targetTilt = clamp(this.vx * 0.04, -30, 30);
        // Dynamic air turbulence wobble: rushing air buffeting her body
        const windWobble = Math.abs(this.vy) > 250
          ? Math.sin(now * 0.015) * clamp(Math.abs(this.vy) / 1600, 0, 1) * 4.5
          : 0;
        this.tilt = lerp(this.tilt, targetTilt + windWobble, 0.18);
      }
    }

    // Facing direction matches travel if moving horizontally
    if (Math.abs(this.vx) > 30) {
      this.faceToward(this.pos.x + this.vx);
    }

    // Speed trails & air streaks during high-speed free fall
    if (this.vy > 850 && !reducedMotion.matches) {
      this.lastWindTrail = this.lastWindTrail || 0;
      if (now - this.lastWindTrail > 80) {
        this.lastWindTrail = now;
        const streakX = this.pos.x + (Math.random() - 0.5) * 36 * s;
        const streakY = this.pos.y - rand(40, 90) * s;
        this.fx.streak(streakX, streakY, streakX, streakY - rand(35, 70) * s, { life: 85 });
      }
    }

    const prevX = this.pos.x;
    const prevY = this.pos.y;
    let nextX = prevX + this.vx * dt;
    let nextY = prevY + this.vy * dt;

    const minX = 40 * s + 15;
    const maxX = this.view.w - (40 * s + 15);
    const minY = SPRITE.feet.y * s + 10;
    const maxY = this.floor;

    // 4. Side walls collision & bounce (or grab wall with claws!)
    if (nextX <= minX && this.vx < 0) {
      nextX = minX;
      if (Math.abs(this.vx) < 650 && this.vy > -120 && Math.random() < 0.35) {
        this.vx = 0;
        this.vy = 0;
        this.vRot = 0;
        this.tilt = 0;
        this.flung = false;
        this.bounces = 0;
        this.pos = { x: minX, y: nextY };
        this.hangOnWall('left');
        return;
      }
      this.vx = -this.vx * 0.58;
      if (this.flung) {
        this.edgeHits = (this.edgeHits || 0) + 1;
        this.onFlingHit?.(this.edgeHits);
      }
      this.voice.play('tick');
      this.voice.play('blip', { mood: 'alert' });
      if (Math.abs(this.vx) > 120) {
        this.fx.burst(minX, nextY - 120 * s, { count: 8, power: 0.5, spread: 30 * s });
        this.p.glitch = 0.22;
        setTimeout(() => { this.p.glitch = 0; }, 70);
        this.vRot = (this.vy > 0 ? 1 : -1) * clamp(Math.abs(this.vx) * 0.8, 150, 400);
      }
    } else if (nextX >= maxX && this.vx > 0) {
      nextX = maxX;
      if (Math.abs(this.vx) < 650 && this.vy > -120 && Math.random() < 0.35) {
        this.vx = 0;
        this.vy = 0;
        this.vRot = 0;
        this.tilt = 0;
        this.flung = false;
        this.bounces = 0;
        this.pos = { x: maxX, y: nextY };
        this.hangOnWall('right');
        return;
      }
      this.vx = -this.vx * 0.58;
      if (this.flung) {
        this.edgeHits = (this.edgeHits || 0) + 1;
        this.onFlingHit?.(this.edgeHits);
      }
      this.voice.play('tick');
      this.voice.play('blip', { mood: 'alert' });
      if (Math.abs(this.vx) > 120) {
        this.fx.burst(maxX, nextY - 120 * s, { count: 8, power: 0.5, spread: 30 * s });
        this.p.glitch = 0.22;
        setTimeout(() => { this.p.glitch = 0; }, 70);
        this.vRot = (this.vy > 0 ? -1 : 1) * clamp(Math.abs(this.vx) * 0.8, 150, 400);
      }
    }

    // 5. Ceiling collision & bounce
    if (nextY <= minY && this.vy < 0) {
      nextY = minY;
      this.vy = Math.abs(this.vy) * 0.45;
      if (this.flung) {
        this.edgeHits = (this.edgeHits || 0) + 1;
        this.onFlingHit?.(this.edgeHits);
      }
      this.voice.play('tick');
      this.voice.play('blip', { mood: 'alert' });
      if (Math.abs(this.vy) > 150) {
        this.fx.burst(nextX, 20, { count: 8, power: 0.5, spread: 40 * s });
        this.p.glitch = 0.2;
        setTimeout(() => { this.p.glitch = 0; }, 70);
        this.vRot = (Math.random() - 0.5) * 260;
      }
    }

    // 6. Window ledges (perch or skim while descending)
    if (this.vy > 0) {
      const hipOffset = (SPRITE.feet.y - SPRITE.hip) * s;
      const prevHip = prevY - hipOffset;
      const nextHip = nextY - hipOffset;

      for (const win of this.windows.wins) {
        if (!this.canSit(win)) continue;
        if (prevHip <= win.y + 6 && nextHip >= win.y - 6) {
          if (nextX >= win.x + 40 && nextX <= win.x + win.w - 40 && !this.covered(win, nextX)) {
            if (Math.abs(this.vx) < 550) {
              const dx = clamp(nextX - win.x, 40, win.w - 40);
              const impactVy = Math.abs(this.vy);
              this.pos = this.seat(win, dx);
              this.settleLanded('sit', { id: win.id, dx }, { impactVy });
              return;
            } else {
              nextY = this.seat(win, nextX - win.x).y - 2;
              this.vy = -Math.abs(this.vy) * 0.38;
              this.vx *= 0.68;
              this.voice.play('tick');
              this.fx.burst(nextX, win.y, { count: 6, power: 0.4, spread: 25 });
              break;
            }
          }
        }
      }
    }

    // 7. Floor collision & landing
    if (nextY >= maxY) {
      nextY = maxY;
      const impactVy = this.lastImpactVy || Math.abs(this.vy);
      if (this.vy > 320 && (this.bounces || 0) < 3) {
        this.lastImpactVy = Math.abs(this.vy);
        this.bounces = (this.bounces || 0) + 1;
        if (this.flung) {
          this.edgeHits = (this.edgeHits || 0) + 1;
          this.onFlingHit?.(this.edgeHits);
        }
        this.vy = -this.vy * 0.36;
        this.vx *= 0.65;
        this.vRot *= 0.4;
        this.fx.burst(nextX, maxY - 15 * s, { count: 8, power: 0.4, spread: 40 * s });
        this.voice.play('tick');
        this.voice.play('blip', { mood: 'alert' });
        this.p.glitch = 0.18;
        setTimeout(() => { this.p.glitch = 0; }, 60);
      } else {
        if (Math.abs(this.vx) > 160) {
          this.vx *= Math.pow(0.85, dt * 60);
          this.vy = 0;
          this.tilt = clamp(this.vx * 0.03, -20, 20);
        } else {
          this.pos = { x: nextX, y: maxY };
          this.settleLanded('stand', null, { impactVy });
          return;
        }
      }
    }

    this.pos = { x: nextX, y: nextY };
    this.place();
  }

  settleLanded(stance, perch, { impactVy = 0 } = {}) {
    const hardImpact = impactVy > 550 || this.flung;
    this.lastImpactVy = 0;
    this.vx = 0;
    this.vy = 0;
    this.vRot = 0;
    this.tilt = 0;
    this.bounces = 0;
    this.flung = false;
    this.edgeHits = 0;
    this.p.smear = [0, 0];
    this.p.echo = [0, 0];
    this.setStance(stance, { perch });
    const s = this.scale;
    if (stance === 'sit') {
      this.perform('plop');
      if (hardImpact) {
        this.fx.burst(this.pos.x, this.pos.y - 10 * s, { count: 8, power: 0.4, spread: 30 * s });
      }
    } else {
      this.perform('land');
      const burstCount = hardImpact ? 20 : 12;
      const burstPower = hardImpact ? 0.8 : 0.55;
      const burstSpread = hardImpact ? 80 * s : 50 * s;
      this.fx.burst(this.pos.x, this.pos.y - 20 * s, { count: burstCount, power: burstPower, spread: burstSpread });
      if (hardImpact) {
        this.fx.ring(this.pos.x, this.pos.y - 6, { size: 0.5 });
      }
    }
    this.voice.play('land');
    const p = this.p;
    p.glitchSeed = Math.random() * 100;
    p.glitch = hardImpact ? 0.32 : 0.22;
    setTimeout(() => { p.glitch = 0; }, ON_ONES * 3);
    this.onTeleport?.('end');
    this.place();
  }

  // First appearance: drop in from the top of the screen.
  async materialize(at) {
    const p = this.p;
    this.pos = { ...at };
    this.faceCenter();
    this.setStance('stand');
    if (reducedMotion.matches) {
      p.alpha = 0;
      this.place();
      await tween(p, { alpha: 1 }, 300, ease.linear);
      return;
    }
    this.busy = true;
    p.alpha = 0;
    p.collapse = 1;
    p.dissolve = 0.5;
    this.place();
    await sleep(250);
    this.fx.beam(at.x, at.y, { down: true, width: 40 * this.scale + 8, life: 260 });
    this.voice.play('teleport-in');
    await sleep(80);
    p.alpha = 1;
    await tween(p, { collapse: 0, dissolve: 0, glitch: 0.5, split: 5 }, 240, ease.out);
    await tween(p, { glitch: 0, split: 0 }, 260, ease.out);
    this.busy = false;
  }

  // Her intro, when she starts: she grabs your screen by its edges, huge, says hi, then her hands
  // slip and she dives down to where she stands, and her body unfolds from her face (fx.intro).
  // `still`: no motion, it comes and goes where it is (Windows' animations off).
  async intro(at, { label = 'hi', caption = 'PROJECT CAPRICORN', still = reducedMotion.matches } = {}) {
    const p = this.p;
    this.pos = { ...at };
    this.faceCenter();
    this.setStance('stand');
    this.busy = true;
    this.onTeleport?.('start'); // the panel waits for her
    p.alpha = 0;
    p.collapse = 1;
    p.dissolve = 0.5;
    this.place();
    const head = this.head(at, this.facing);
    await this.fx.intro({
      to: { x: head.x, y: head.y, size: 100 * this.scale },
      label,
      caption,
      still,
      onCue: (cue) => {
        if (cue === 'open') this.voice.play('charge'); // the edges of the screen crackling
        else if (cue === 'hand') this.voice.play('land'); // a hand on the edge
        else if (cue === 'wave') this.voice.play('rise'); // a hand off it, to wave
        else if (cue === 'grab') {
          this.voice.play('land'); // she slams into it
          this.voice.play('bolt');
        } else if (cue === 'hi') this.voice.play('hello');
        else if (cue === 'slip') this.voice.play('teleport-out');
      },
    });
    await this.arrive(at, { face: this.facing, beam: false });
    this.busy = false;
    this.onTeleport?.('end');
  }

  // ---------- showing you things ----------

  // The point of `rect` (overlay coordinates) she aims at from where she is: its closest point,
  // a little inside. Off her screen (the tray, down in the taskbar), the edge of her screen.
  aimPoint(rect) {
    const { w, h } = this.view;
    const sh = this.limb(this.armToward(rect.x + rect.w / 2 < this.pos.x ? -1 : 1)).shoulder;
    const inset = Math.min(24, rect.w / 3, rect.h / 3);
    return {
      x: clamp(clamp(sh.x, rect.x + inset, rect.x + rect.w - inset), 6, w - 6),
      y: clamp(clamp(sh.y, rect.y + inset, rect.y + rect.h - inset), 6, h - 4),
    };
  }

  // Where to stand to point at `rect`: beside it, on the side with more room, her shoulder a bit
  // below its middle (on the floor for things low on the screen).
  spotNear(rect) {
    const s = this.scale;
    const { w, h } = this.view;
    const side = 150 * s + 30;
    const reach = 230 * s + 90; // from her feet to what she points at: room for the arm to shoot out
    const roomLeft = rect.x, roomRight = w - (rect.x + rect.w);
    let x;
    if (Math.max(roomLeft, roomRight) >= side + 40) {
      x = roomRight >= roomLeft ? rect.x + rect.w + reach : rect.x - reach;
    } else {
      x = rect.x + rect.w / 2 < w / 2 ? w - side : side; // nowhere beside it: the far side of the screen
    }
    x = clamp(x, side, w - side);
    const cy = clamp(rect.y + rect.h / 2, 0, h);
    const shoulderToFeet = (SPRITE.feet.y - SPRITE.shoulder.y) * s;
    const y = cy > h * 0.6 ? this.floor : clamp(cy + shoulderToFeet + 50, SPRITE.height * s + 40, this.floor);
    return { x, y, face: rect.x + rect.w / 2 < x ? 1 : -1 };
  }

  // Go and point at `rect`, and keep pointing (a dashed line from her finger, brackets, `label`)
  // until stopPointing(). Resolves once she's there with her arm out.
  async pointAt(rect, { label = '' } = {}) {
    if (this.stowed) return false;
    this.stopPointing();
    const spot = this.spotNear(rect);
    if (this.stance !== 'stand' || Math.hypot(spot.x - this.pos.x, spot.y - this.pos.y) > 140) {
      await this.teleport({ x: spot.x, y: spot.y }, { face: spot.face });
    }
    if (this.stowed || this.hidden) return false;
    const aim = this.aimPoint(rect);
    const dir = aim.x < this.pos.x ? -1 : 1;
    const side = this.armToward(dir);
    // how far up the arm comes to point at it (it hangs ~30 degrees low at rest)
    const reach = () => {
      const sh = this.limb(side).shoulder;
      return clamp(Math.atan2(sh.y - aim.y, Math.abs(aim.x - sh.x)) + 0.52, -0.6, 1.7);
    };
    this.pointing = { rect, aim, dir, side, reach, label, pointer: null };
    this.base = this.restBase();
    await this.perform('point', dir, { reach });
    if (this.pointing && !this.pointing.pointer) this.onCue('lock'); // the act was cut short
    return true;
  }

  // Done showing: the line reels back into her finger, the reticle lets go, the arm snaps back.
  stopPointing() {
    const pt = this.pointing;
    if (!pt) return;
    this.pointing = null;
    pt.pointer?.retract();
    this.base = this.restBase();
    if (!this.busy && !this.hidden && this.stance === 'stand') this.perform('unpoint', pt.dir);
  }

  // Can she point at this window so you'd see it: not maximized, its top not under other windows.
  canPoint(win) {
    return Boolean(win && !win.max && win.w > 120 && win.y > -10 && !this.covered(win, win.x + win.w / 2));
  }

  // Show up next to the mouse pointer (used when Claude needs you).
  async summon(cursor) {
    const { w } = this.view;
    const s = this.scale;
    const side = 150 * s + 30;
    const dx = cursor.x > w / 2 ? -260 : 260;
    const to = {
      x: clamp(cursor.x + dx, side, w - side),
      y: clamp(cursor.y + SPRITE.height * s * 0.45, SPRITE.height * s + 120, this.floor),
    };
    if (this.stance === 'stand' && Math.hypot(to.x - this.pos.x, to.y - this.pos.y) < 160) {
      this.facing = cursor.x < this.pos.x ? 1 : -1;
      return;
    }
    await this.teleport(to, { face: cursor.x < to.x ? 1 : -1 });
  }

  setHidden(hidden) {
    this.hidden = hidden;
    this.root.hidden = hidden;
  }

  // ---------- walking & climbing ----------

  stopWalking() {
    if (this.walkState) {
      const cb = this.walkState.onDone;
      this.walkState = null;
      cb?.();
    }
  }

  stopClimbing() {
    if (this.climbState) {
      const cb = this.climbState.onDone;
      this.climbState = null;
      cb?.();
    }
    this.slideState = null;
    this.wallHangUntil = 0;
  }

  walk(targetX, opts) {
    return this.walkTo(targetX, opts);
  }

  climb(wallSide, opts) {
    return this.startClimb(wallSide, opts);
  }

  walkTo(targetX, { win = null, speed = 125, climbOnWall = false, onDone = null, forceTrip = false, allowTrip = true } = {}) {
    if (this.busy || this.hidden || this.dormant || this.stowed) return false;
    if (this.stance === 'fall' || this.stance === 'peek') return false;

    this.stopClimbing();
    const s = this.scale;
    const minX = 40 * s + 15;
    const maxX = this.view.w - (40 * s + 15);
    const clampedTargetX = clamp(Number(targetX) || this.pos.x, minX, maxX);

    if (Math.abs(clampedTargetX - this.pos.x) < 8) {
      if (climbOnWall && (this.pos.x <= minX + 15 || this.pos.x >= maxX - 15)) {
        this.startClimb(this.pos.x <= minX + 15 ? 'left' : 'right', { onDone });
        return true;
      }
      onDone?.();
      return true;
    }

    if (reducedMotion.matches) {
      this.pos.x = clampedTargetX;
      if (win) this.settleLanded('sit', { id: win.id, dx: clamp(clampedTargetX - win.x, 40, win.w - 40) });
      else this.settleLanded('stand', null);
      onDone?.();
      return true;
    }

    const dir = clampedTargetX < this.pos.x ? -1 : 1;
    this.faceToward(clampedTargetX);
    this.setStance('walk', { perch: win ? { id: win.id, dx: this.pos.x - win.x } : null, dir });

    const totalDist = Math.abs(clampedTargetX - this.pos.x);
    let tripDist = null;
    if (forceTrip) {
      tripDist = Math.max(25, Math.min(100, totalDist * 0.45));
    } else if (allowTrip && !win && totalDist > 160 && Math.random() < 0.08) {
      // Rare slip & fall during longer walks on the floor (~8% chance)
      tripDist = totalDist * rand(0.35, 0.65);
    }

    this.walkState = {
      targetX: clampedTargetX,
      speed,
      win,
      climbOnWall,
      onDone,
      dir,
      tripDist,
      traveledDist: 0,
      lastTime: performance.now(),
    };
    return true;
  }

  async trip({ dir = null } = {}) {
    if (this.busy) return;
    this.stopClimbing();
    this.stopWalking();
    this.busy = true;

    const tripDir = dir ?? (this.facing < 0 ? 1 : -1);
    await this.perform('trip', tripDir);
    this.busy = false;
    this.settleLanded('stand', null);
  }

  walkLedge(win, { dx = null, onDone = null } = {}) {
    if (!win || !this.canSit(win)) return false;
    const minDx = 45;
    const maxDx = Math.max(minDx, win.w - 45);
    const curDx = this.perch?.id === win.id ? this.perch.dx : (this.pos.x - win.x);
    const targetDx = dx ?? (curDx > win.w * 0.5 ? rand(minDx, win.w * 0.35) : rand(win.w * 0.65, maxDx));
    const targetX = win.x + clamp(targetDx, minDx, maxDx);
    return this.walkTo(targetX, { win, onDone });
  }

  updateWalk(now) {
    if (!this.walkState) {
      this.setStance('stand');
      return;
    }
    const dt = Math.min(0.04, (now - this.walkState.lastTime) / 1000);
    this.walkState.lastTime = now;
    if (dt <= 0) return;

    const s = this.scale;
    const minX = 40 * s + 15;
    const maxX = this.view.w - (40 * s + 15);
    const { targetX, speed, win, climbOnWall, onDone } = this.walkState;

    if (win) {
      const liveWin = this.perchWin(win.id);
      if (!liveWin || !this.canSit(liveWin) || this.covered(liveWin, this.pos.x)) {
        this.walkState = null;
        this.fall();
        return;
      }
      this.pos.y = this.seat(liveWin, this.pos.x - liveWin.x).y;
    } else {
      this.pos.y = this.floor;
    }

    const stepDist = speed * dt;
    const dist = targetX - this.pos.x;

    this.walkState.traveledDist = (this.walkState.traveledDist || 0) + stepDist;
    if (this.walkState.tripDist && this.walkState.traveledDist >= this.walkState.tripDist) {
      const walkDir = this.walkState.dir;
      this.walkState = null;
      this.trip({ dir: walkDir });
      return;
    }

    if (Math.abs(dist) <= stepDist) {
      this.pos.x = targetX;
      const doneCb = onDone;
      const shouldClimb = climbOnWall && (targetX <= minX + 15 || targetX >= maxX - 15);
      this.walkState = null;

      if (shouldClimb) {
        this.startClimb(targetX <= minX + 15 ? 'left' : 'right', { onDone: doneCb });
        return;
      }

      if (win) {
        const dx = clamp(this.pos.x - win.x, 40, win.w - 40);
        this.settleLanded('sit', { id: win.id, dx });
      } else {
        this.settleLanded('stand', null);
      }
      doneCb?.();
      return;
    }

    this.pos.x += Math.sign(dist) * stepDist;

    if (!win) {
      if (this.pos.x <= minX && dist < 0) {
        this.pos.x = minX;
        const doneCb = onDone;
        this.walkState = null;
        if (climbOnWall) {
          this.startClimb('left', { onDone: doneCb });
        } else {
          this.settleLanded('stand', null);
          doneCb?.();
        }
        return;
      } else if (this.pos.x >= maxX && dist > 0) {
        this.pos.x = maxX;
        const doneCb = onDone;
        this.walkState = null;
        if (climbOnWall) {
          this.startClimb('right', { onDone: doneCb });
        } else {
          this.settleLanded('stand', null);
          doneCb?.();
        }
        return;
      }
    } else {
      const minWinX = win.x + 35;
      const maxWinX = win.x + win.w - 35;
      if (this.pos.x <= minWinX && dist < 0) {
        this.pos.x = minWinX;
        this.walkState = null;
        this.settleLanded('sit', { id: win.id, dx: 35 });
        onDone?.();
        return;
      } else if (this.pos.x >= maxWinX && dist > 0) {
        this.pos.x = maxWinX;
        this.walkState = null;
        this.settleLanded('sit', { id: win.id, dx: win.w - 35 });
        onDone?.();
        return;
      }
    }

    this.place();
  }

  startClimb(wallSide = 'left', { targetY = null, speed = 90, onDone = null } = {}) {
    if (this.busy || this.hidden || this.dormant || this.stowed) return false;
    this.stopWalking();
    const s = this.scale;
    const minX = 40 * s + 15;
    const maxX = this.view.w - (40 * s + 15);
    const side = (wallSide === 'right' || wallSide === 1) ? 'right' : 'left';
    const wallX = side === 'left' ? minX : maxX;

    this.pos.x = wallX;
    this.facing = side === 'left' ? 1 : -1;

    const destY = targetY ?? rand(this.view.h * 0.22, this.view.h * 0.55);

    if (reducedMotion.matches) {
      this.pos.y = destY;
      this.hangOnWall(side);
      onDone?.();
      return true;
    }

    this.setStance('climb', { wallSide: side, dir: side === 'left' ? -1 : 1 });
    this.climbState = {
      wallSide: side,
      targetY: destY,
      speed,
      onDone,
      lastTime: performance.now(),
    };
    this.voice.play('tick');
    this.fx.burst(wallX, this.pos.y - 60 * s, { count: 5, power: 0.3, spread: 20 * s });
    return true;
  }

  updateClimb(now) {
    if (!this.climbState) {
      this.setStance('stand');
      return;
    }
    const dt = Math.min(0.04, (now - this.climbState.lastTime) / 1000);
    this.climbState.lastTime = now;
    if (dt <= 0) return;

    const s = this.scale;
    const { wallSide, targetY, speed, onDone } = this.climbState;
    const minX = 40 * s + 15;
    const maxX = this.view.w - (40 * s + 15);
    this.pos.x = wallSide === 'left' ? minX : maxX;

    const minY = SPRITE.feet.y * s + 30;
    const effectiveTargetY = Math.max(targetY, minY);
    const stepDist = speed * dt;

    if (this.pos.y - stepDist <= effectiveTargetY) {
      this.pos.y = effectiveTargetY;
      const doneCb = onDone;
      this.climbState = null;
      this.hangOnWall(wallSide);
      doneCb?.();
      return;
    }

    this.pos.y -= stepDist;
    this.place();
  }

  hangOnWall(wallSide, durationMs = rand(3500, 7500)) {
    this.stopWalking();
    this.stopClimbing();
    this.endAct(false);
    const s = this.scale;
    const minX = 40 * s + 15;
    const maxX = this.view.w - (40 * s + 15);
    const side = (wallSide === 'right' || wallSide === 1) ? 'right' : 'left';
    this.pos.x = side === 'left' ? minX : maxX;
    this.facing = side === 'left' ? 1 : -1;
    this.setStance('wall_hang', { wallSide: side, dir: side === 'left' ? -1 : 1 });
    this.wallHangUntil = performance.now() + durationMs;
    this.voice.play('tick');
    this.fx.burst(this.pos.x, this.pos.y - 80 * s, { count: 4, power: 0.25, spread: 15 * s });
  }

  updateWallHang(now) {
    if (now > this.wallHangUntil) {
      this.wallHangUntil = Infinity;
      this.wallHangAction();
    }
  }

  wallHangAction() {
    if (this.busy || this.stance !== 'wall_hang') return;
    const side = this.wallSide || (this.pos.x < this.view.w / 2 ? 'left' : 'right');
    const r = Math.random();

    if (r < 0.55) {
      // Wall leap into desktop!
      this.wallLeap();
    } else if (r < 0.75 && this.pos.y < this.view.h * 0.35) {
      // Near top of screen: peek in from the edge/top!
      this.peek(pick([side, 'top']));
    } else {
      // Slide down wall with sparks!
      this.wallSlide();
    }
  }

  async wallLeap(style = null) {
    if (this.busy) return;
    const side = this.wallSide || (this.pos.x < this.view.w / 2 ? 'left' : 'right');
    const outDir = side === 'left' ? 1 : -1;
    this.stopClimbing();
    this.stopWalking();
    this.wallHangUntil = Infinity;
    this.busy = true;

    const styles = ['standard', 'flip', 'spin', 'dive'];
    const selectedStyle = style && styles.includes(style) ? style : (style === 'random' || !style ? pick(styles) : 'standard');

    let actName = 'wall_leap';
    let vx = outDir * rand(340, 520);
    let vy = rand(-380, -220);

    if (selectedStyle === 'flip') {
      actName = 'wall_leap_flip';
      vx = outDir * rand(380, 560);
      vy = rand(-460, -320);
    } else if (selectedStyle === 'spin') {
      actName = 'wall_leap_spin';
      vx = outDir * rand(440, 620);
      vy = rand(-360, -220);
    } else if (selectedStyle === 'dive') {
      actName = 'wall_leap_dive';
      vx = outDir * rand(520, 750);
      vy = rand(-260, -150);
    }

    // 1. Play the leap act (starts with anticipation coil against the wall)
    this.facing = side === 'left' ? 1 : -1;
    const actPromise = this.perform(actName, outDir);

    // 2. Wait for coil anticipation before launching (3 frames @ 24fps = 125ms)
    const coilMs = reducedMotion.matches ? 0 : (1000 / 24) * 3;
    if (coilMs > 0) {
      await sleep(coilMs);
    }

    this.busy = false;

    // 3. Explode off the wall into physics flight while animation continues playing
    this.fling(vx, vy);
    this.vRot = 0; // rotation is handled cleanly by the act's frames
    this.facing = outDir === 1 ? -1 : 1;

    return actPromise;
  }

  wallSlide() {
    if (this.busy) return;
    const side = this.wallSide || (this.pos.x < this.view.w / 2 ? 'left' : 'right');
    this.stopClimbing();
    this.setStance('wall_slide', { wallSide: side, dir: side === 'left' ? -1 : 1 });
    this.slideState = {
      wallSide: side,
      speed: 280,
      lastTime: performance.now(),
    };
  }

  updateWallSlide(now) {
    if (!this.slideState) {
      this.setStance('stand');
      return;
    }
    const dt = Math.min(0.04, (now - this.slideState.lastTime) / 1000);
    this.slideState.lastTime = now;
    if (dt <= 0) return;

    const s = this.scale;
    const { wallSide, speed } = this.slideState;
    const minX = 40 * s + 15;
    const maxX = this.view.w - (40 * s + 15);
    this.pos.x = wallSide === 'left' ? minX : maxX;

    this.pos.y += speed * dt;

    const landing = this.landing();
    if (this.pos.y >= landing.y) {
      this.pos.y = landing.y;
      this.slideState = null;
      this.settleLanded(landing.stance, landing.perch);
      return;
    }

    this.place();
  }

  // ---------- pointer ----------

  bindPointer() {
    let down = null;
    let pointerHistory = [];
    const onContextMenu = (e) => {
      e.preventDefault();
      if (this.hit(e.clientX, e.clientY)) this.onMenu?.(); // right-click: her menu
    };
    const onMouseDown = (e) => {
      if (e.button !== 0 || this.busy || !this.hit(e.clientX, e.clientY)) return;
      if (this.mode === 'sleep') this.wake();
      if (this.stance === 'fall' || this.stance === 'walk' || this.stance === 'climb' || this.stance === 'wall_hang' || this.stance === 'wall_slide') {
        this.vx = 0;
        this.vy = 0;
        this.vRot = 0;
        this.tilt = 0;
        this.flung = false;
        this.bounces = 0;
        this.edgeHits = 0;
        this.p.smear = [0, 0];
        this.p.echo = [0, 0];
        this.stopWalking();
        this.stopClimbing();
        this.endAct(false);
        this.setStance('stand');
      }
      down = { x: e.clientX, y: e.clientY, pos: { ...this.pos } };
      pointerHistory = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
    };
    this.canvas.addEventListener('contextmenu', onContextMenu);
    this.canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', (e) => {
      this.mouse = { x: e.clientX, y: e.clientY }; // a window she's in watches it
      if (down) {
        const now = performance.now();
        pointerHistory.push({ x: e.clientX, y: e.clientY, t: now });
        while (pointerHistory.length > 0 && now - pointerHistory[0].t > 120) {
          pointerHistory.shift();
        }

        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (!this.dragging && Math.hypot(dx, dy) > 5 && !this.busy) {
          this.dragging = true;
          if (this.upside) {
            // flip back upright under the pointer
            down.pos = { x: down.pos.x, y: down.y + (SPRITE.feet.y - SPRITE.head.y) * this.scale };
          }
          this.endAct(false);
          this.setStance('stand');
          this.p.glitch = 0.18;
          this.p.split = 2;
          this.onTeleport?.('start');
        }
        if (this.dragging) {
          this.pos = {
            x: clamp(down.pos.x + dx, 40, this.view.w - 40),
            y: clamp(down.pos.y + dy, SPRITE.height * this.scale * 0.5, this.floor),
          };
          this.p.glitchSeed = Math.random() * 100;

          // Drag dynamics: tilt opposite to drag movement (lagging momentum)
          if (pointerHistory.length >= 2) {
            const p0 = pointerHistory[0];
            const p1 = pointerHistory[pointerHistory.length - 1];
            const dt = (p1.t - p0.t) / 1000;
            if (dt > 0.01) {
              const dragVx = (p1.x - p0.x) / dt;
              this.tilt = clamp(-dragVx * 0.02, -22, 22);
              if (Math.abs(dragVx) > 100) {
                this.faceToward(this.pos.x + dragVx);
              }
            }
          }

          this.place();
        }
        return;
      }
      this.notice(e.clientX, e.clientY);
    });
    window.addEventListener('mouseup', () => {
      if (!down) return;
      const wasDragging = this.dragging;
      down = null;
      this.dragging = false;
      if (wasDragging) {
        tween(this.p, { glitch: 0, split: 0 }, 200, ease.out);
        this.onTeleport?.('end');

        // Compute throw velocity from recent pointer history
        let vx = 0;
        let vy = 0;
        const now = performance.now();
        const recent = pointerHistory.filter((p) => now - p.t <= 100);
        if (recent.length >= 2 && now - recent[recent.length - 1].t < 70) {
          const p0 = recent[0];
          const p1 = recent[recent.length - 1];
          const dt = (p1.t - p0.t) / 1000;
          if (dt > 0.012) {
            vx = (p1.x - p0.x) / dt;
            vy = (p1.y - p0.y) / dt;
          }
        }
        pointerHistory = [];

        // Apply throw physics
        const rawSpeed = Math.hypot(vx, vy);
        const maxSpeed = 3200;
        if (rawSpeed > maxSpeed) {
          vx = (vx / rawSpeed) * maxSpeed;
          vy = (vy / rawSpeed) * maxSpeed;
        } else {
          vx *= 1.15;
          vy *= 1.15;
        }

        this.drop(vx, vy);
      } else {
        pointerHistory = [];
        this.onClick?.();
      }
    });

    window.addEventListener('blur', () => {
      if (down) {
        const wasDragging = this.dragging;
        down = null;
        this.dragging = false;
        pointerHistory = [];
        if (wasDragging) {
          tween(this.p, { glitch: 0, split: 0 }, 200, ease.out);
          this.drop(0, 0);
        }
      }
    });
  }

  // Let go of her: onto a ledge if her hips are right at one, or flung with physics, or falls.
  drop(vx = 0, vy = 0) {
    const speed = Math.hypot(vx, vy);
    const THROW_THRESHOLD = 180;

    if (speed >= THROW_THRESHOLD) {
      this.fling(vx, vy);
      return;
    }

    const s = this.scale;
    const hip = this.pos.y - (SPRITE.feet.y - SPRITE.hip) * s;
    for (const win of this.windows.wins) {
      if (!this.canSit(win) || Math.abs(hip - win.y) > 26) continue;
      if (this.pos.x < win.x + 40 || this.pos.x > win.x + win.w - 40 || this.covered(win, this.pos.x)) continue;
      const dx = this.pos.x - win.x;
      this.pos = this.seat(win, dx);
      this.settleLanded('sit', { id: win.id, dx });
      return;
    }
    if (this.pos.y < this.floor - 4) {
      this.fall({ vx: vx * 0.4, vy: vy * 0.4, flung: false });
    } else {
      this.settleLanded('stand', null);
    }
  }

  // When the pointer comes close she turns around to face it and cocks her head;
  // if she's peeking, she's shy and ducks away.
  notice(x, y) {
    if (this.busy || this.hidden || this.stance === 'fall' || this.sky) return; // the satellite has all her attention
    const h = this.head();
    if (Math.hypot(x - h.x, y - h.y) > 230) return;
    const now = performance.now();
    if (this.mode === 'sleep') this.wake();
    if (now < this.nextNotice) return;
    this.nextNotice = now + 15000;
    if (this.stance === 'peek') {
      this.unpeek({ shy: true });
      return;
    }
    const wanted = x < this.pos.x ? 1 : -1;
    if (wanted !== this.facing && this.stance === 'stand') {
      this.perform('turn');
      return;
    }
    if (this.mode !== 'idle') return;
    // now and then she's a little menace about it
    if (Math.random() < 0.3 && this.zap(x, y)) return;
    this.perform('curious', x < h.x ? -1 : 1);
  }
}
