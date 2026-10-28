'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Helper to load ES modules in Node
function moduleUrl(file, overrides = {}) {
  let source = fs.readFileSync(file, 'utf8');
  if (overrides[path.basename(file)]) {
    source = overrides[path.basename(file)];
  }
  source = source.replace(/from '(\.\/[^']+)'/g,
    (_, relative) => `from '${moduleUrl(path.resolve(path.dirname(file), relative), overrides)}'`);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

test('Acting: walk, climb, wall_hang, wall_slide, and wall_leap acts are properly configured', async () => {
  const { ACTS, Player } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/acting.js')));

  // 1. Walk act
  assert.ok(ACTS.walk, 'ACTS.walk must exist');
  assert.equal(ACTS.walk.loop, true);
  assert.equal(ACTS.walk.fps, 24);
  assert.equal(ACTS.walk.directional, true);
  assert.equal(ACTS.walk.keys.length, 8, 'walk should have 8 keyframes in cycle');
  const stepCues = ACTS.walk.keys.filter(([, , cue]) => cue === 'step');
  assert.equal(stepCues.length, 2, 'walk cycle must have 2 step cues (one for each foot contact)');

  // 2. Climb act
  assert.ok(ACTS.climb, 'ACTS.climb must exist');
  assert.equal(ACTS.climb.loop, true);
  assert.equal(ACTS.climb.fps, 24);
  assert.equal(ACTS.climb.directional, true);
  const gripCues = ACTS.climb.keys.filter(([, , cue]) => cue === 'grip');
  assert.equal(gripCues.length, 2, 'climb cycle must have 2 grip cues for alternating hands');

  // 3. Wall hang act
  assert.ok(ACTS.wall_hang, 'ACTS.wall_hang must exist');
  assert.equal(ACTS.wall_hang.loop, true);
  assert.equal(ACTS.wall_hang.directional, true);

  // 4. Wall slide act
  assert.ok(ACTS.wall_slide, 'ACTS.wall_slide must exist');
  assert.equal(ACTS.wall_slide.loop, true);
  assert.equal(ACTS.wall_slide.directional, true);
  const slideCues = ACTS.wall_slide.keys.filter(([, , cue]) => cue === 'slide_spark');
  assert.ok(slideCues.length >= 1, 'wall_slide must have slide_spark cue');

  // 5. Wall leap act and variations
  assert.ok(ACTS.wall_leap, 'ACTS.wall_leap must exist');
  assert.equal(ACTS.wall_leap.priority, 3);
  assert.equal(ACTS.wall_leap.fps, 24);
  assert.equal(ACTS.wall_leap.directional, true);
  const coilCue = ACTS.wall_leap.keys.find(([, , cue]) => cue === 'coil');
  const launchCue = ACTS.wall_leap.keys.find(([, , cue]) => cue === 'launch');
  assert.ok(coilCue, 'wall_leap must have coil cue');
  assert.ok(launchCue, 'wall_leap must have launch cue');

  assert.ok(ACTS.wall_leap_flip, 'ACTS.wall_leap_flip must exist');
  assert.ok(ACTS.wall_leap_spin, 'ACTS.wall_leap_spin must exist');
  assert.ok(ACTS.wall_leap_dive, 'ACTS.wall_leap_dive must exist');

  // Trip / slip act
  assert.ok(ACTS.trip, 'ACTS.trip must exist');
  assert.equal(ACTS.trip.priority, 3);
  assert.equal(ACTS.trip.directional, true);
  const slipCue = ACTS.trip.keys.find(([, , cue]) => cue === 'trip_slip');
  const impactCue = ACTS.trip.keys.find(([, , cue]) => cue === 'trip_impact');
  assert.ok(slipCue, 'trip must have trip_slip cue');
  assert.ok(impactCue, 'trip must have trip_impact cue');

  // 6. Player.resolve: directional mirroring of limbs
  const walkPlayerRight = new Player('walk', { dir: 1 });
  const poseRight = walkPlayerRight.resolve(ACTS.walk.keys[0][1], -1); // facing -1 (right), dir 1 => lean = -1 (mirrored)
  const poseLeft = walkPlayerRight.resolve(ACTS.walk.keys[0][1], 1);   // facing 1 (left), dir 1 => lean = 1 (unmirrored)

  // When mirrored (lean < 0), armL and armR should be swapped from original pose
  const origPose = ACTS.walk.keys[0][1];
  assert.equal(poseLeft.armL, origPose.armL);
  assert.equal(poseLeft.armR, origPose.armR);
  assert.equal(poseRight.armL, origPose.armR);
  assert.equal(poseRight.armR, origPose.armL);
  assert.equal(poseRight.kickL, origPose.kickR);
  assert.equal(poseRight.kickR, origPose.kickL);
});

test('Capri: walking and wall climbing state machine and physics', async () => {
  // Set up mock DOM environment
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.innerWidth = 1920;
  globalThis.innerHeight = 1080;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({
        drawImage: () => {},
        getImageData: () => ({ data: new Uint8Array(240 * 420 * 4) }),
      }),
    }),
  };
  globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {} });

  const realSpriteCode = fs.readFileSync(path.join(__dirname, '../src/renderer/js/sprite.js'), 'utf8');
  const mockSpriteCode = realSpriteCode.replace(/export class SpriteRenderer \{[\s\S]*?\n\}/, `export class SpriteRenderer {
  constructor(canvas, image) {}
  resize(scale) {}
  draw(p) {}
}`);

  const { Capri } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/capri.js'), {
    'sprite.js': mockSpriteCode,
  }));

  const mockRoot = { style: {} };
  const mockCanvas = {
    style: {},
    addEventListener: () => {},
  };
  const mockImage = { width: 240, height: 420 };
  const mockFx = {
    burst: () => {},
    streak: () => {},
    beam: () => {},
    slices: () => {},
    vortex: () => {},
    slit: () => {},
  };
  const mockVoice = { play: () => {} };

  let capri;
  try {
    capri = new Capri({
      root: mockRoot,
      canvas: mockCanvas,
      image: mockImage,
      fx: mockFx,
      voice: mockVoice,
    });
    capri.setView(1920, 1080, 1040);
    capri.pos = { x: 500, y: capri.floor };
  } catch (err) {
    console.error('CONSTRUCTOR ERROR:', err);
    throw err;
  }

  try {
    const walked = capri.walkTo(800, { speed: 200 });
    assert.equal(walked, true);
    assert.equal(capri.stance, 'walk');
    assert.ok(capri.walkState);
    assert.equal(capri.walkState.targetX, 800);
  } catch (err) {
    console.error('WALK TO ERROR:', err);
    throw err;
  }

  // 2. updateWalk advances position
  let t = performance.now();
  const startX = capri.pos.x;
  t += 100;
  capri.updateWalk(t);
  assert.ok(capri.pos.x > startX, 'capri position should advance towards targetX');

  // Advance walk to completion
  capri.pos.x = 799;
  t += 100;
  capri.updateWalk(t);
  assert.equal(capri.pos.x, 800, 'capri reaches target destination');
  assert.equal(capri.stance, 'stand', 'capri settles into stand after walk');
  assert.equal(capri.walkState, null);

  // 3. Test startClimb and hangOnWall
  const climbed = capri.startClimb('left', { targetY: 300, speed: 100 });
  assert.equal(climbed, true);
  assert.equal(capri.stance, 'climb');
  assert.equal(capri.wallSide, 'left');
  assert.ok(capri.climbState);

  // Advance climb upward
  const startY = capri.pos.y;
  t += 100;
  capri.updateClimb(t);
  assert.ok(capri.pos.y < startY, 'capri position Y should climb upward');

  // Complete climb to target
  capri.pos.y = 302;
  t += 100;
  capri.updateClimb(t);
  assert.equal(capri.stance, 'wall_hang', 'capri perches on wall in wall_hang stance');
  assert.equal(capri.climbState, null);

  // 4. Test wall leap pushes off with fling physics
  let flingCalled = false;
  capri.perform = () => Promise.resolve();
  capri.fling = (vx, vy) => {
    flingCalled = true;
    assert.ok(vx > 0, 'leaping off left wall must propel to the right (positive vx)');
    assert.ok(vy < 0, 'leaping off wall must propel upward (negative vy)');
  };
  await capri.wallLeap();
  assert.ok(flingCalled, 'wallLeap should launch with fling physics');

  // Test wallLeap styles
  let performedAct = null;
  capri.perform = (act) => {
    performedAct = act;
    return Promise.resolve();
  };
  await capri.wallLeap('flip');
  assert.equal(performedAct, 'wall_leap_flip');
  await capri.wallLeap('spin');
  assert.equal(performedAct, 'wall_leap_spin');
  await capri.wallLeap('dive');
  assert.equal(performedAct, 'wall_leap_dive');

  // Test trip / slip fall
  let tripDone = false;
  capri.perform = (act) => {
    if (act === 'trip') tripDone = true;
    return Promise.resolve();
  };
  await capri.trip();
  assert.ok(tripDone, 'capri.trip should trigger trip act');

  // 5. Test stopWalking and stopClimbing clean up properly
  capri.walkTo(600);
  assert.ok(capri.walkState);
  capri.stopWalking();
  assert.equal(capri.walkState, null);

  capri.startClimb('right');
  assert.ok(capri.climbState);
  capri.stopClimbing();
  assert.equal(capri.climbState, null);

  capri.hidden = true;
});
