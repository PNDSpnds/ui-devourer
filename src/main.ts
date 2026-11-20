import * as THREE from 'three';
import './style.css';
import { PhysicsWorld } from './core/PhysicsWorld';
import { Player } from './entities/Player';
import type { BulletImpactInfo } from './entities/Player';
import { Enemy } from './entities/Enemy';
import type { EnemyType } from './entities/Enemy';
import { UIEntityManager } from './entities/UIEntityManager';
import type { UIHooks } from './entities/UIEntityManager';
import { HudOverlay } from './ui/HudOverlay';
import type { PopupAction, UpgradeChoice } from './ui/HudOverlay';
import { SoundSystem } from './systems/SoundSystem';
import { EffectsSystem } from './systems/EffectsSystem';
import { WaveSystem } from './systems/WaveSystem';
import type { WaveHooks } from './systems/WaveSystem';

const ARENA_SIZE = 24;
const ARENA_HALF = ARENA_SIZE / 2;
const CAMERA_FOV = 55;
const CAMERA_OFFSET = new THREE.Vector3(0, 13.6, 9.5);

interface Orb {
  mesh: THREE.Mesh;
  baseY: number;
  life: number;
  value: number;
  phase: number;
}

function getElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required DOM element: #${id}`);
  return element as T;
}

async function bootstrap(): Promise<void> {
  if (typeof WebGLRenderingContext === 'undefined') {
    throw new Error('当前浏览器不支持 WebGL。');
  }

  const bootOverlay = getElement('boot-overlay');
  const bootStatus = getElement('boot-status');

  const physics = new PhysicsWorld();
  await physics.init();
  bootStatus.textContent = '物理引擎在线 // 构建竞技场';

  const canvas = getElement<HTMLCanvasElement>('game-canvas');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04070d);
  scene.fog = new THREE.FogExp2(0x04070d, 0.019);

  const camera = new THREE.PerspectiveCamera(
    CAMERA_FOV,
    window.innerWidth / window.innerHeight,
    0.1,
    200,
  );

  addLighting(scene);
  buildArena(scene, physics);

  const overlay = new HudOverlay();
  const sound = new SoundSystem();
  const effects = new EffectsSystem(scene);
  const player = new Player(physics, scene);

  let ui!: UIEntityManager;
  let wave!: WaveSystem;
  let boss: Enemy | null = null;

  const enemies: Enemy[] = [];
  const enemyByCollider = new Map<number, Enemy>();
  const orbs: Orb[] = [];
  const orbGeometry = new THREE.IcosahedronGeometry(0.22, 0);
  const orbMaterial = new THREE.MeshBasicMaterial({ color: 0x4dffb8, toneMapped: false });

  let ready = false;
  let leftHeld = false;
  let dashCooldown = 0;
  let novaCooldown = 0;
  let playerHitCooldown = 0;
  let hpWeaponCooldown = 0;
  let gatlingCharge = 0;
  let novaEchoTimer = 0;
  let novaEchoPosition = new THREE.Vector3();
  let popupTimer = 6;
  let scoreHitCounter = 0;
  let lastStatsSignature = '';
  let lastScoreRedraw = 0;
  let dashPanelHit = false;
  const dashHitSet = new Set<number>();
  const uiImpactCooldowns = new Map<string, number>();

  const mouseNdc = new THREE.Vector2(0, 0);
  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const aimPoint = new THREE.Vector3(0, 0, -6);
  const aimables: THREE.Object3D[] = [];
  const crosshair = getElement('crosshair');
  const moveInput = { x: 0, z: 0 };
  const keys = new Set<string>();
  let shootQueued = false;

  const uiHooks: UIHooks = {
    onPlayerDamage: (amount, source) => {
      if (amount <= 0) {
        overlay.damageFlash(0.55);
        overlay.glitch(0.2, '护盾吸收');
        sound.play('shield');
        effects.addShake(0.12);
        return;
      }

      const comboBefore = wave.getStats().combo;
      wave.breakCombo();
      scoreHitCounter += 1;

      if (
        ui.getState('score') === 'docked' &&
        (scoreHitCounter % 3 === 0 || comboBefore >= 6)
      ) {
        ui.detachScore(dropPointFor('score'));
      }

      overlay.damageFlash(1);
      overlay.shakeScore();
      overlay.glitch(0.8, source === 'hud-bar' ? '自我伤害' : '生命值破裂');
      overlay.warnPanel('hp');
      effects.addShake(0.4);
      effects.requestHitstop(0.03);
      sound.play('hit');
    },
    onDefeat: () => {
      wave.fail();
      overlay.glitch(1.25, '生命信号中断');
      effects.addShake(0.9);
    },
    onScoreBurst: (position) => {
      player.fireBurst(position, 16, 30);
      effects.shockwave(position, 0xffb347, 5, 0.5);
      effects.burst(position, 0xffd48a, 30, 10, 0.55);
      effects.addShake(0.35);
      sound.play('score');
    },
    onScoreBonus: () => {
      wave.addScore(wave.getModifiers().scoreBurstBonus);
    },
    onSkillDetonate: (position) => {
      const mods = wave.getModifiers();
      damageEnemiesInRadius(position, 6, 65 + mods.novaDamage * 0.6, 1.9, 0xffb347);
      effects.shockwave(position, 0xffb347, 6, 0.65);
      ui.pushLoosePanels(position, 6, 13);
      overlay.toast('技能诱饵 // 范围眩晕', 'warn');
    },
    onPopupDetonate: (position) => {
      damageEnemiesInRadius(position, 4.6, 80, 2.0, 0xff3b5c);
      effects.shockwave(position, 0xff3b5c, 4.6, 0.55);
      overlay.toast('弹窗撞击 // 范围眩晕', 'error');
    },
    onShake: (strength) => effects.addShake(strength),
    onGlitch: (strength, label) => overlay.glitch(strength, label),
    onSound: (name) => sound.play(name),
    onUILost: () => {
      wave.registerLost();
    },
    onUIRecall: () => {
      wave.registerReclaim();
    },
    onRecallComplete: (count) => {
      const mods = wave.getModifiers();
      ui.grantShield(mods.recallShield * count);
      if (mods.recallNova) {
        damageEnemiesInRadius(player.getPosition(), 5.8, 55, 1.2, 0x38f6ff);
        effects.shockwave(player.getPosition(), 0x38f6ff, 5.8, 0.55);
        overlay.toast('磁力召回 // 冲击波', 'warn');
        sound.play('nova');
      }
    },
  };

  ui = new UIEntityManager(physics, scene, overlay, uiHooks);
  player.group.add(ui.getHeldWeaponGroup());

  const waveHooks: WaveHooks = {
    onSpawnChaser: (position, power) => spawnEnemy('chaser', position, power),
    onSpawnBoss: (type, position, power) => spawnEnemy(type, position, power),
    onStageStart: (cycle, stage, title, isBoss) => {
      const stageLabel = isBoss ? '首领关' : `小关 ${stage}/5`;
      overlay.setWaveBanner(`第 ${cycle} 循环 // ${stageLabel}`, title);
      popupTimer = 5;
      shootQueued = false;
    },
    onStageCleared: (cycle, stage, isBoss) => {
      const heal = isBoss ? 30 : 15;
      if (ui.getLoosePanels().length > 0) ui.recallAll();
      ui.heal(heal);
      overlay.toast(
        isBoss
          ? `首领击破 // 第 ${cycle} 循环完成 // 生命 +${heal}`
          : `第 ${cycle} 循环 · 小关 ${stage}/5 清场 // 生命 +${heal}`,
        'info',
      );
      effects.shockwave(player.getPosition(), 0x38f6ff, 5, 0.7);
      if (isBoss) sound.play('bossDown');
    },
    onUpgradeChoices: (choices, isBoss) => {
      const rarityLabel = { common: '普通', rare: '稀有', epic: '史诗' } as const;
      const cards: UpgradeChoice[] = choices.map((choice) => ({
        id: choice.id,
        title: choice.title,
        description: choice.description,
        tag: `${rarityLabel[choice.rarity]} · ${choice.tag}${isBoss ? ' · 首领奖励' : ''}`,
      }));
      overlay.showUpgrade(cards, (index) => {
        wave.chooseUpgrade(index);
      });
    },
    onUpgradeApplied: (upgrade) => {
      overlay.hideUpgrade();
      applyModifiers();
      if (upgrade.heal) ui.heal(upgrade.heal);
      sound.play('upgrade');
      overlay.toast(`${upgrade.title} // 已写入`, 'info');
    },
    onDefeat: (stats) => {
      overlay.showResult(false, stats);
      overlay.hideBoss();
      overlay.glitch(1.25, '生命信号中断');
      sound.play('defeat');
      effects.addShake(0.9);
    },
    onSound: (name) => sound.play(name),
  };

  wave = new WaveSystem(waveHooks);
  ui.setDamageGate(
    () => player.isInvulnerable() || playerHitCooldown > 0 || wave.phase !== 'playing',
  );

  function applyModifiers(): void {
    const mods = wave.getModifiers();
    player.configure({
      fireInterval: mods.fireInterval,
      damage: mods.bulletDamage,
      split: mods.split,
      pellets: mods.pellets,
      pierce: mods.bulletPierce,
      critChance: mods.critChance,
      hpShots: mods.hpShots,
      hpPierce: mods.hpPierce,
      twin: mods.twin,
      radialEvery: mods.radialEvery,
      boomerang: mods.boomerang,
      homing: mods.homing,
    });
    ui.setMaxHp(Math.max(40, 100 + mods.maxHpBonus));
  }

  function spawnEnemy(type: EnemyType, position: THREE.Vector3, power: number): void {
    const enemy = new Enemy(type, power, position, {
      scene,
      physics,
      player,
      ui,
      effects,
      sound,
      onPlayerHit: (damage, source) => applyPlayerDamage(damage, source),
      onDeath: (dead) => handleEnemyDeath(dead),
    });
    enemies.push(enemy);
    enemyByCollider.set(enemy.getColliderHandle(), enemy);

    if (enemy.isBoss) {
      boss = enemy;
      overlay.showBoss(
        enemy.type === 'prime' ? '吞噬者首领 // 核心-03' : '吞噬者节点 // 异常-02',
        enemy.getHp(),
        enemy.getMaxHp(),
      );
      effects.portal(enemy.getPosition(), 0xff3b5c);
      effects.addShake(0.55);
      overlay.glitch(0.9, '检测到首领信号');
      sound.play('boss');
    } else {
      effects.portal(enemy.getPosition(), 0xff6a82);
    }
  }

  function handleEnemyDeath(enemy: Enemy): void {
    const index = enemies.indexOf(enemy);
    if (index >= 0) enemies.splice(index, 1);
    enemyByCollider.delete(enemy.getColliderHandle());

    const position = enemy.getPosition();
    wave.registerKill(enemy.type);
    ui.releaseFromCarrier(enemy);
    if (wave.getModifiers().killHeal > 0) ui.heal(wave.getModifiers().killHeal);

    const orbCount = enemy.isBoss ? 5 : 1;
    for (let index = 0; index < orbCount; index += 1) {
      spawnOrb(
        new THREE.Vector3(
          position.x + (Math.random() - 0.5) * (enemy.isBoss ? 3 : 0.8),
          0.9,
          position.z + (Math.random() - 0.5) * (enemy.isBoss ? 3 : 0.8),
        ),
        (enemy.isBoss ? 18 : 8) + wave.getModifiers().orbValueBonus,
      );
    }

    effects.burst(
      position,
      enemy.isBoss ? 0xff3b5c : 0xff6a82,
      enemy.isBoss ? 80 : 30,
      enemy.isBoss ? 15 : 9,
      0.8,
    );
    effects.shockwave(
      position,
      enemy.isBoss ? 0xff3b5c : 0xff6a82,
      enemy.isBoss ? 8 : 2.6,
      enemy.isBoss ? 0.85 : 0.35,
    );
    effects.addShake(enemy.isBoss ? 0.95 : 0.2);
    effects.requestHitstop(enemy.isBoss ? 0.09 : 0.03);
    sound.play('enemyDeath');

    if (enemy.isBoss) {
      boss = null;
      overlay.hideBoss();
      overlay.glitch(1.2, '首领核心破裂');
      overlay.toast('首领已击破 // UI 已释放', 'warn');
      sound.play('bossDown');
    }
  }

  function spawnOrb(position: THREE.Vector3, value: number): void {
    const mesh = new THREE.Mesh(orbGeometry, orbMaterial);
    mesh.position.copy(position);
    scene.add(mesh);
    orbs.push({
      mesh,
      baseY: Math.max(0.7, position.y),
      life: 14,
      value,
      phase: Math.random() * Math.PI * 2,
    });
  }

  function updateOrbs(delta: number): void {
    const time = performance.now() * 0.001;
    const playerPosition = player.getPosition();
    const pickupRadius = wave.getModifiers().orbRadius;
    for (let index = orbs.length - 1; index >= 0; index -= 1) {
      const orb = orbs[index];
      orb.life -= delta;
      orb.mesh.rotation.y += delta * 2.4;
      orb.mesh.rotation.x += delta * 1.4;
      orb.mesh.position.y = orb.baseY + Math.sin(time * 3 + orb.phase) * 0.13;

      if (orb.mesh.position.distanceTo(playerPosition) < pickupRadius) {
        ui.heal(orb.value);
        wave.addScore(25);
        overlay.toast(`能量球 // 生命 +${orb.value}`, 'info');
        effects.burst(orb.mesh.position, 0x4dffb8, 12, 5, 0.3);
        sound.play('pickup');
        scene.remove(orb.mesh);
        orbs.splice(index, 1);
        continue;
      }

      if (orb.life <= 0) {
        scene.remove(orb.mesh);
        orbs.splice(index, 1);
      }
    }
  }

  function applyPlayerDamage(amount: number, source: string): void {
    if (wave.phase !== 'playing') return;
    if (player.isInvulnerable() || playerHitCooldown > 0) return;
    ui.damagePlayer(amount, source);
    playerHitCooldown = 0.65;
  }

  function chainDamage(
    source: Enemy,
    position: THREE.Vector3,
    damage: number,
    maxTargets: number,
  ): void {
    if (maxTargets <= 0) return;
    const targets = enemies
      .filter((enemy) => enemy !== source && enemy.isAlive())
      .map((enemy) => ({ enemy, distance: enemy.getPosition().distanceTo(position) }))
      .filter((entry) => entry.distance < 6.5)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, maxTargets);

    for (const target of targets) {
      const direction = target.enemy.getPosition().sub(position);
      if (direction.lengthSq() < 0.001) direction.set(0, 0, 1);
      target.enemy.takeDamage(damage, direction.normalize(), false);
      if (target.enemy.isAlive()) target.enemy.stun(0.12);
      effects.spark(target.enemy.getPosition(), 0x8afff0);
    }
  }

  function separateEnemies(): void {
    if (enemies.length < 2) return;
    const offsets = new Map<Enemy, { x: number; z: number }>();
    for (let i = 0; i < enemies.length; i += 1) {
      const a = enemies[i];
      if (!a.isAlive()) continue;
      const pa = a.getPosition();
      for (let j = i + 1; j < enemies.length; j += 1) {
        const b = enemies[j];
        if (!b.isAlive()) continue;
        const pb = b.getPosition();
        let dx = pa.x - pb.x;
        let dz = pa.z - pb.z;
        let distance = Math.hypot(dx, dz);
        if (distance >= a.radius + b.radius + 0.45) continue;
        if (distance < 0.01) {
          const angle = Math.random() * Math.PI * 2;
          dx = Math.cos(angle);
          dz = Math.sin(angle);
          distance = 1;
        }
        const push = (a.radius + b.radius + 0.45 - distance) * 0.5;
        const nx = (dx / distance) * push;
        const nz = (dz / distance) * push;
        const oa = offsets.get(a) ?? { x: 0, z: 0 };
        oa.x += nx;
        oa.z += nz;
        offsets.set(a, oa);
        const ob = offsets.get(b) ?? { x: 0, z: 0 };
        ob.x -= nx;
        ob.z -= nz;
        offsets.set(b, ob);
      }
    }
    for (const [enemy, offset] of offsets) enemy.nudge(offset.x, offset.z);
  }

  function damageEnemiesInRadius(
    position: THREE.Vector3,
    radius: number,
    damage: number,
    stun: number,
    color: number,
  ): void {
    for (const enemy of [...enemies]) {
      if (!enemy.isAlive()) continue;
      const distance = enemy.getPosition().distanceTo(position);
      if (distance > radius + enemy.radius * 0.5) continue;
      const direction = enemy.getPosition().sub(position);
      if (direction.lengthSq() < 0.001) direction.set(0, 0, 1);
      enemy.takeDamage(damage, direction.normalize(), false);
      if (enemy.isAlive()) enemy.stun(stun);
    }
    effects.burst(position, color, 28, 9, 0.45);
    effects.addShake(0.4);
  }

  function updateAimables(): void {
    aimables.length = 0;
    for (const enemy of enemies) {
      if (enemy.isAlive()) aimables.push(enemy.getAimMesh());
    }
    for (const mesh of ui.getAimMeshes()) aimables.push(mesh);
  }

  function resolveAim(ndc: THREE.Vector2, target: THREE.Vector3): void {
    camera.updateMatrixWorld();
    updateAimables();
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(aimables, false);
    if (hits.length > 0) {
      target.copy(hits[0].point);
      return;
    }
    const groundHit = raycaster.ray.intersectPlane(groundPlane, target);
    if (groundHit) return;

    const origin = player.getPosition();
    const forward = player.getForward();
    target.set(origin.x + forward.x * 8, 0, origin.z + forward.z * 8);
  }

  function updateAim(): void {
    resolveAim(mouseNdc, aimPoint);
  }

  function aimPointForScreen(x: number, y: number): THREE.Vector3 {
    const ndc = new THREE.Vector2(
      (x / window.innerWidth) * 2 - 1,
      -(y / window.innerHeight) * 2 + 1,
    );
    const target = new THREE.Vector3();
    resolveAim(ndc, target);
    return target;
  }

  function hudAnchorGroundPoint(): THREE.Vector3 {
    const panel = getElement('health-panel').getBoundingClientRect();
    const anchorNdc = new THREE.Vector2(
      ((panel.left + 26) / window.innerWidth) * 2 - 1,
      -((panel.top + 26) / window.innerHeight) * 2 + 1,
    );

    camera.updateMatrixWorld();
    raycaster.setFromCamera(anchorNdc, camera);
    const hit = raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());

    const origin = player.getPosition();
    const forward = player.getForward();
    const fallback = new THREE.Vector3(
      origin.x + forward.x * 3.6,
      0,
      origin.z + forward.z * 3.6,
    );

    if (!hit) return fallback;

    hit.y = 0;
    hit.x = THREE.MathUtils.clamp(hit.x, -ARENA_HALF + 2.2, ARENA_HALF - 2.2);
    hit.z = THREE.MathUtils.clamp(hit.z, -ARENA_HALF + 2.2, ARENA_HALF - 2.2);

    const flatPlayer = new THREE.Vector3(origin.x, 0, origin.z);
    const distance = hit.distanceTo(flatPlayer);
    if (distance < 1.8 || distance > 7.5) return fallback;
    return hit;
  }

  function dropPointFor(kind: 'hp' | 'skills' | 'score'): THREE.Vector3 {
    if (kind === 'hp') return hudAnchorGroundPoint();

    const origin = player.getPosition();
    const forward = player.getForward();
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    const point = origin.clone();
    point.y = 0;
    point.addScaledVector(forward, kind === 'score' ? 2.5 : 3.1);
    if (kind === 'score') point.addScaledVector(right, 2.2);
    point.x = THREE.MathUtils.clamp(point.x, -ARENA_HALF + 2.2, ARENA_HALF - 2.2);
    point.z = THREE.MathUtils.clamp(point.z, -ARENA_HALF + 2.2, ARENA_HALF - 2.2);
    return point;
  }

  // ------------------------------------------------------------------ input

  function refreshMoveInput(): void {
    let x = 0;
    let z = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) z -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) z += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
    moveInput.x = x;
    moveInput.z = z;
  }

  function tryDash(): void {
    if (wave.phase !== 'playing' || !ui.isSkillsUsable() || dashCooldown > 0) return;
    const dashDirection = new THREE.Vector3(moveInput.x, 0, moveInput.z);
    if (dashDirection.lengthSq() < 0.01) dashDirection.copy(player.getForward());
    if (!player.startDash(dashDirection)) return;
    dashCooldown = wave.getModifiers().dashCooldown;
    dashHitSet.clear();
    dashPanelHit = false;
    sound.play('dash');
    effects.burst(player.getPosition(), 0x38f6ff, 18, 6.5, 0.45);
    effects.addShake(0.15);
    overlay.glitch(0.22, '冲刺启动');
    if (wave.getModifiers().dashTrail) {
      damageEnemiesInRadius(player.getPosition(), 2.8, 35, 0.35, 0x38f6ff);
      effects.shockwave(player.getPosition(), 0x38f6ff, 2.8, 0.4);
    }
  }

  function castNova(): void {
    if (wave.phase !== 'playing' || !ui.isSkillsUsable() || novaCooldown > 0) return;
    const mods = wave.getModifiers();
    const position = player.getPosition();
    damageEnemiesInRadius(
      position,
      mods.novaRadius,
      mods.novaDamage,
      mods.novaStun,
      0x38f6ff,
    );
    ui.pushLoosePanels(position, mods.novaRadius, 12);
    effects.shockwave(position, 0x38f6ff, mods.novaRadius, 0.65);
    effects.addShake(0.55);
    overlay.glitch(0.55, '震荡波释放');
    sound.play('nova');
    novaCooldown = mods.novaCooldown;
    if (mods.novaDouble) {
      novaEchoTimer = 0.45;
      novaEchoPosition.copy(position);
    }
  }

  function tryFireHpWeapon(): void {
    if (!ui.isHpHeld() || wave.phase !== 'playing' || hpWeaponCooldown > 0) return;
    const mods = wave.getModifiers();
    if (ui.getHp() <= mods.hpCost) {
      hpWeaponCooldown = 0.8;
      overlay.toast('生命值不足，无法发射血条炮', 'error');
      return;
    }
    updateAim();
    if (!player.fireHealthProjectile(aimPoint, mods.hpDamage, mods.hpPierce)) return;
    if (!ui.spendHp(mods.hpCost)) return;

    hpWeaponCooldown = 0.42;
    sound.play('healthShot');
    effects.addShake(0.22);
    effects.burst(player.getPosition(), 0x7bffd8, 10, 4, 0.3);
    overlay.glitch(0.25, '血条炮发射');
  }

  function throwSkills(): void {
    if (wave.phase !== 'playing') return;
    ui.throwSkills(dropPointFor('skills'), player.getForward());
    if (ui.getState('skills') === 'loose') {
      effects.addShake(0.2);
      overlay.glitch(0.35, '技能 UI 已投掷');
    }
  }

  function recallAllUI(): void {
    if (wave.phase !== 'playing') return;
    ui.recallAll();
  }

  function toggleMute(): void {
    sound.unlock();
    const muted = sound.toggleMuted();
    overlay.setMuted(muted);
  }

  function handlePopupAction(action: PopupAction): void {
    const target = action.dragged ? aimPointForScreen(action.x, action.y) : aimPoint.clone();
    ui.launchPopup(target, player.getPosition(), action.title, action.body);
    overlay.glitch(0.45, action.dragged ? '弹窗已投掷' : '弹窗已击碎');
  }

  // --------------------------------------------------------------- collisions

  function handleBulletImpact(handle: number, info: BulletImpactInfo): void {
    const uiKind = ui.getPanelByCollider(handle);
    if (uiKind) {
      ui.onBulletHit(uiKind, info.impactPoint, info.direction, info.source);
      return;
    }

    const enemy = enemyByCollider.get(handle);
    if (enemy) {
      enemy.takeDamage(info.damage, info.direction, info.crit);
      if (enemy.isAlive()) enemy.stun(info.source === 'health' ? 0.5 : 0.08);
      const chainCount = wave.getModifiers().chain;
      if (chainCount > 0 && info.source !== 'health') {
        chainDamage(enemy, info.impactPoint, info.damage * 0.35, chainCount);
      }
      if (info.source === 'health') {
        const mods = wave.getModifiers();
        if (mods.hpLifesteal > 0) ui.heal(mods.hpLifesteal);
        if (mods.hpExplode) {
          damageEnemiesInRadius(info.impactPoint, 3.2, 45, 0.55, 0x7bffd8);
          effects.shockwave(info.impactPoint, 0x7bffd8, 3.2, 0.4);
        }
        effects.requestHitstop(0.06);
        effects.addShake(0.3);
        sound.play('crit');
      } else {
        effects.requestHitstop(info.crit ? 0.07 : 0.032);
        effects.addShake(info.crit ? 0.25 : 0.08);
      }
      return;
    }

    const popup = ui.getPopupByCollider(handle);
    if (popup) {
      ui.detonatePopup(popup);
      return;
    }

    effects.spark(info.impactPoint, info.crit ? 0xfff0a0 : 0x8afff0);
  }

  function handleLooseUIImpacts(): void {
    const mods = wave.getModifiers();
    const now = performance.now();
    for (const panel of ui.getLoosePanels()) {
      if (panel.kind === 'skills') continue;
      const velocity = panel.getVelocity();
      const speed = velocity.length();
      if (speed < 2.4) continue;
      const position = panel.getPosition();

      for (const enemy of [...enemies]) {
        if (!enemy.isAlive()) continue;
        const distance = enemy.getPosition().distanceTo(position);
        if (distance > 1.6 + enemy.radius * 0.5) continue;

        const key = `${panel.kind}:${enemy.id}`;
        if ((uiImpactCooldowns.get(key) ?? 0) > now) continue;
        uiImpactCooldowns.set(key, now + 360);

        const direction = enemy.getPosition().sub(position).normalize();
        enemy.takeDamage(18 * mods.uiImpact, direction, false);
        if (enemy.isAlive()) enemy.stun(0.3);
        effects.burst(enemy.getPosition(), 0xffd48a, 10, 5, 0.3);
        effects.addShake(0.1);
        sound.play('hit');
      }
    }
  }

  function handleDashContacts(): void {
    if (!player.isDashing()) return;
    const mods = wave.getModifiers();
    const position = player.getPosition();
    const direction = player.getForward();

    for (const enemy of [...enemies]) {
      if (!enemy.isAlive() || dashHitSet.has(enemy.id)) continue;
      if (enemy.getPosition().distanceTo(position) > 1.5 + enemy.radius * 0.5) continue;
      dashHitSet.add(enemy.id);
      enemy.takeDamage(mods.dashDamage, direction, false);
      if (enemy.isAlive()) {
        enemy.stun(0.55);
      } else if (mods.dashKillReset) {
        dashCooldown = 0;
      }
      effects.burst(enemy.getPosition(), 0x38f6ff, 14, 7, 0.4);
      effects.requestHitstop(0.035);
      effects.addShake(0.2);
      sound.play('hit');
    }

    if (!dashPanelHit && ui.getState('score') === 'loose') {
      const panelPosition = ui.getPanel('score').getPosition();
      if (panelPosition.distanceTo(position) < 2.1) {
        dashPanelHit = true;
        ui.onBulletHit('score', panelPosition, direction, 'dash');
      }
    }

    if (!dashPanelHit && ui.getState('skills') === 'loose') {
      const panelPosition = ui.getPanel('skills').getPosition();
      if (panelPosition.distanceTo(position) < 2.1) {
        dashPanelHit = true;
        ui.onBulletHit('skills', panelPosition, direction, 'dash');
      }
    }

    for (const projectile of [...ui.getPopupProjectiles()]) {
      if (projectile.panel.getPosition().distanceTo(position) < 2.2) {
        ui.detonatePopup(projectile);
      }
    }
  }

  function handlePopupProximity(): void {
    for (const projectile of [...ui.getPopupProjectiles()]) {
      const popupPosition = projectile.panel.getPosition();
      let detonate = false;
      for (const enemy of enemies) {
        if (!enemy.isAlive()) continue;
        if (enemy.getPosition().distanceTo(popupPosition) < 2.25 + enemy.radius * 0.35) {
          detonate = true;
          break;
        }
      }
      if (detonate) ui.detonatePopup(projectile);
    }
  }

  // ------------------------------------------------------------- presentation

  const desiredCameraPosition = new THREE.Vector3();

  function updateCamera(delta: number): void {
    const position = player.getPosition();
    const desired = desiredCameraPosition.copy(position).add(CAMERA_OFFSET);
    const alpha = 1 - Math.exp(-9 * delta);
    camera.position.lerp(desired, alpha);
    camera.lookAt(position.x, position.y + 0.55, position.z);

    const shake = effects.getShake();
    if (shake > 0.0005) {
      camera.position.x += (Math.random() - 0.5) * shake;
      camera.position.y += (Math.random() - 0.5) * shake * 0.65;
      camera.position.z += (Math.random() - 0.5) * shake;
      camera.rotation.z += (Math.random() - 0.5) * shake * 0.055;
    }
  }

  function updateHudFrame(): void {
    const stats = wave.getStats();
    const mods = wave.getModifiers();

    overlay.update({
      hp: ui.getHp(),
      maxHp: ui.getMaxHp(),
      shield: ui.getShield(),
      score: stats.score,
      combo: stats.combo,
      multiplier: stats.multiplier,
      comboRatio: stats.comboRatio,
      stageText: stats.stageText,
      kills: stats.kills,
      dashCooldown,
      dashMax: mods.dashCooldown,
      novaCooldown,
      novaMax: mods.novaCooldown,
      skillsUsable: ui.isSkillsUsable(),
      skillState: ui.getSkillStateLabel(),
    });

    if (boss && boss.isAlive()) {
      overlay.updateBoss(boss.getHp(), boss.getMaxHp());
    }

    const signature = `${stats.score}|${stats.combo}|${stats.kills}|${stats.cycle}|${stats.stage}`;
    const now = performance.now();
    const scoreLoose = ui.getState('score') === 'loose';
    if (
      signature !== lastStatsSignature ||
      (scoreLoose && now - lastScoreRedraw > 110)
    ) {
      ui.setRunStats(stats);
      lastStatsSignature = signature;
      lastScoreRedraw = now;
    }
  }

  // ------------------------------------------------------------------ events

  window.addEventListener('keydown', (event) => {
    sound.unlock();

    if (
      event.code === 'KeyW' ||
      event.code === 'KeyA' ||
      event.code === 'KeyS' ||
      event.code === 'KeyD' ||
      event.code.startsWith('Arrow')
    ) {
      if (wave.phase === 'playing') {
        event.preventDefault();
        keys.add(event.code);
        refreshMoveInput();
      }
      return;
    }

    if (event.repeat) return;

    if (event.code === 'Space') {
      event.preventDefault();
      tryDash();
      return;
    }

    if (event.code === 'KeyQ') {
      event.preventDefault();
      castNova();
      return;
    }

    if (event.code === 'KeyF') {
      event.preventDefault();
      throwSkills();
      return;
    }

    if (event.code === 'KeyE') {
      event.preventDefault();
      recallAllUI();
      return;
    }

    if (event.code === 'KeyM') {
      event.preventDefault();
      toggleMute();
      return;
    }

    if (wave.phase === 'upgrade' && event.code.startsWith('Digit')) {
      event.preventDefault();
      const index = Number(event.code.slice(5)) - 1;
      if (index >= 0 && index <= 2) overlay.pickUpgrade(index);
    }
  });

  window.addEventListener('keyup', (event) => {
    keys.delete(event.code);
    refreshMoveInput();
  });

  window.addEventListener('blur', () => {
    keys.clear();
    leftHeld = false;
    refreshMoveInput();
  });

  window.addEventListener('pointermove', (event) => {
    mouseNdc.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouseNdc.y = -(event.clientY / window.innerHeight) * 2 + 1;
    crosshair.style.left = `${event.clientX}px`;
    crosshair.style.top = `${event.clientY}px`;
  });

  window.addEventListener('pointerdown', (event) => {
    sound.unlock();
    if (!ready) return;
    if (wave.phase !== 'playing') return;
    if (overlay.isPointerOverInteractive(event.clientX, event.clientY)) return;

    if (event.button === 2) {
      event.preventDefault();
      if (
        overlay.isPointerOverSkillPanel(event.clientX, event.clientY) &&
        ui.getState('skills') !== 'carried'
      ) {
        throwSkills();
      } else {
        ui.toggleHpWeapon();
      }
      return;
    }

    if (event.button === 0) {
      leftHeld = true;
      updateAim();
      if (ui.isHpHeld()) {
        tryFireHpWeapon();
      } else {
        shootQueued = true;
      }
    }
  });

  window.addEventListener('pointerup', (event) => {
    if (event.button === 0) leftHeld = false;
  });

  window.addEventListener('pointercancel', () => {
    leftHeld = false;
  });

  window.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  overlay.onMuteToggle = () => toggleMute();
  overlay.onPopupAction = (action) => handlePopupAction(action);
  overlay.onRestart = () => window.location.reload();
  overlay.setMuted(sound.isMuted());

  player.onBulletImpact = (handle, info) => handleBulletImpact(handle, info);

  const playerStart = player.getPosition();
  camera.position.copy(playerStart).add(CAMERA_OFFSET);
  camera.lookAt(playerStart.x, playerStart.y + 0.5, playerStart.z);
  camera.updateMatrixWorld();

  applyModifiers();
  ui.setRunStats(wave.getStats());
  updateAim();
  updateHudFrame();
  wave.start();

  // -------------------------------------------------------------- game loop

  let lastTime = performance.now();

  function animate(now: number): void {
    requestAnimationFrame(animate);

    const rawDelta = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    effects.updateRealTime(rawDelta);

    const playing = wave.phase === 'playing';
    if (ready && playing && !effects.isHitstopped()) {
      updateAim();

      const pairs = physics.step(rawDelta, (fixedDelta) => {
        if (wave.getModifiers().homing > 0) {
          player.setHomingTargets(
            enemies.filter((enemy) => enemy.isAlive()).map((enemy) => enemy.getPosition()),
          );
        }
        player.update(fixedDelta, moveInput.x, moveInput.z, aimPoint);

        if (shootQueued) {
          shootQueued = false;
          if (!ui.isHpHeld() && player.shoot(aimPoint)) sound.play('shoot');
        }

        if (leftHeld && ui.isHpHeld()) {
          tryFireHpWeapon();
        } else if (leftHeld && !ui.isHpHeld() && wave.getModifiers().gatling) {
          gatlingCharge = Math.min(1.3, gatlingCharge + fixedDelta);
          player.setFireInterval(
            Math.max(0.045, wave.getModifiers().fireInterval - gatlingCharge * 0.045),
          );
          if (player.shoot(aimPoint)) sound.play('shoot');
        } else {
          gatlingCharge = 0;
          if (!ui.isHpHeld()) player.setFireInterval(wave.getModifiers().fireInterval);
        }

        for (const enemy of [...enemies]) enemy.update(fixedDelta);
        separateEnemies();
        ui.update(fixedDelta);
        updateOrbs(fixedDelta);

        dashCooldown = Math.max(0, dashCooldown - fixedDelta);
        novaCooldown = Math.max(0, novaCooldown - fixedDelta);
        playerHitCooldown = Math.max(0, playerHitCooldown - fixedDelta);
        hpWeaponCooldown = Math.max(0, hpWeaponCooldown - fixedDelta);

        if (novaEchoTimer > 0) {
          novaEchoTimer -= fixedDelta;
          if (novaEchoTimer <= 0) {
            const mods = wave.getModifiers();
            damageEnemiesInRadius(
              novaEchoPosition,
              mods.novaRadius * 0.78,
              mods.novaDamage * 0.6,
              mods.novaStun,
              0x38f6ff,
            );
            effects.shockwave(novaEchoPosition, 0x38f6ff, mods.novaRadius * 0.78, 0.5);
            sound.play('nova');
          }
        }

        popupTimer -= fixedDelta;
        if (popupTimer <= 0) {
          ui.spawnSystemPopup();
          popupTimer = 8 + Math.random() * 5;
        }

        wave.update(
          fixedDelta,
          enemies.filter((enemy) => enemy.isAlive()).length,
          boss !== null && boss.isAlive(),
        );
      });

      for (const pair of pairs) {
        player.handleCollision(pair.a, pair.b);
      }

      player.sync();
      ui.sync();
      for (const enemy of enemies) enemy.sync();
      effects.update(rawDelta);

      handleDashContacts();
      handleLooseUIImpacts();
      handlePopupProximity();
    } else {
      player.sync();
      ui.sync();
      for (const enemy of enemies) enemy.sync();
    }

    updateHudFrame();
    updateCamera(rawDelta);
    renderer.render(scene, camera);
  }

  if (import.meta.env.DEV) {
    Object.assign(window, {
      __UI_DEVOURER__: {
        player,
        ui,
        wave,
        enemies,
        effects,
        sound,
        overlay,
        camera,
        getBoss: () => boss,
        getWeaponDebug: () => ({
          hpCooldown: hpWeaponCooldown,
          leftHeld,
          gatlingCharge,
        }),
      },
    });
  }

  ready = true;
  document.body.classList.add('is-ready');
  bootStatus.textContent = '系统在线';
  bootOverlay.classList.add('is-hidden');
  window.setTimeout(() => bootOverlay.remove(), 500);

  lastTime = performance.now();
  requestAnimationFrame(animate);
}

function addLighting(scene: THREE.Scene): void {
  const hemisphere = new THREE.HemisphereLight(0x4aa8ff, 0x050a10, 1.15);
  scene.add(hemisphere);

  const keyLight = new THREE.DirectionalLight(0xbdefff, 2.6);
  keyLight.position.set(9, 19, 10);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.left = -18;
  keyLight.shadow.camera.right = 18;
  keyLight.shadow.camera.top = 18;
  keyLight.shadow.camera.bottom = -18;
  keyLight.shadow.camera.near = 1;
  keyLight.shadow.camera.far = 60;
  keyLight.shadow.bias = -0.0006;
  scene.add(keyLight);

  const rimLight = new THREE.PointLight(0xff2bd6, 140, 42, 2);
  rimLight.position.set(-11, 7, -11);
  scene.add(rimLight);

  const fillLight = new THREE.PointLight(0x1c8dff, 90, 38, 2);
  fillLight.position.set(11, 5, 10);
  scene.add(fillLight);
}

function buildArena(scene: THREE.Scene, physics: PhysicsWorld): void {
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x071018,
    roughness: 0.6,
    metalness: 0.45,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(ARENA_SIZE, 24, 0x35f2ff, 0x0c4452);
  grid.position.y = 0.012;
  grid.material.transparent = true;
  grid.material.opacity = 0.58;
  scene.add(grid);

  const railMaterial = new THREE.MeshBasicMaterial({ color: 0x2ef2ff, toneMapped: false });
  const railLongGeometry = new THREE.BoxGeometry(ARENA_SIZE + 0.1, 0.05, 0.075);
  const railShortGeometry = new THREE.BoxGeometry(0.075, 0.05, ARENA_SIZE + 0.1);
  for (const z of [-ARENA_HALF, ARENA_HALF]) {
    const rail = new THREE.Mesh(railLongGeometry, railMaterial);
    rail.position.set(0, 0.04, z);
    scene.add(rail);
  }
  for (const x of [-ARENA_HALF, ARENA_HALF]) {
    const rail = new THREE.Mesh(railShortGeometry, railMaterial);
    rail.position.set(x, 0.04, 0);
    scene.add(rail);
  }

  const wallMaterial = new THREE.MeshBasicMaterial({
    color: 0x0a5b72,
    transparent: true,
    opacity: 0.055,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const wallGeometry = new THREE.PlaneGeometry(ARENA_SIZE, 3.4);
  const wallLayouts = [
    { x: 0, z: -ARENA_HALF + 0.015, rotation: 0 },
    { x: 0, z: ARENA_HALF - 0.015, rotation: Math.PI },
    { x: -ARENA_HALF + 0.015, z: 0, rotation: Math.PI / 2 },
    { x: ARENA_HALF - 0.015, z: 0, rotation: -Math.PI / 2 },
  ];
  for (const layout of wallLayouts) {
    const wall = new THREE.Mesh(wallGeometry, wallMaterial);
    wall.position.set(layout.x, 1.7, layout.z);
    wall.rotation.y = layout.rotation;
    scene.add(wall);
  }

  const pylonGeometry = new THREE.BoxGeometry(0.16, 2.4, 0.16);
  const pylonMaterial = new THREE.MeshStandardMaterial({
    color: 0x07303a,
    emissive: 0x17d7f2,
    emissiveIntensity: 1.05,
    roughness: 0.3,
    metalness: 0.5,
  });
  for (const x of [-ARENA_HALF + 0.1, ARENA_HALF - 0.1]) {
    for (const z of [-ARENA_HALF + 0.1, ARENA_HALF - 0.1]) {
      const pylon = new THREE.Mesh(pylonGeometry, pylonMaterial);
      pylon.position.set(x, 1.2, z);
      scene.add(pylon);
    }
  }

  const centerRing = new THREE.Mesh(
    new THREE.RingGeometry(2.4, 2.5, 64),
    new THREE.MeshBasicMaterial({
      color: 0x1d85a0,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  centerRing.rotation.x = -Math.PI / 2;
  centerRing.position.y = 0.018;
  scene.add(centerRing);

  physics.createStaticBox(ARENA_HALF, 0.5, ARENA_HALF, { x: 0, y: -0.5, z: 0 }, 0.95);

  const wallThickness = 0.5;
  const wallHalfHeight = 4;
  physics.createStaticBox(
    wallThickness,
    wallHalfHeight,
    ARENA_HALF + wallThickness,
    { x: ARENA_HALF + wallThickness, y: wallHalfHeight, z: 0 },
  );
  physics.createStaticBox(
    wallThickness,
    wallHalfHeight,
    ARENA_HALF + wallThickness,
    { x: -ARENA_HALF - wallThickness, y: wallHalfHeight, z: 0 },
  );
  physics.createStaticBox(
    ARENA_HALF + wallThickness,
    wallHalfHeight,
    wallThickness,
    { x: 0, y: wallHalfHeight, z: ARENA_HALF + wallThickness },
  );
  physics.createStaticBox(
    ARENA_HALF + wallThickness,
    wallHalfHeight,
    wallThickness,
    { x: 0, y: wallHalfHeight, z: -ARENA_HALF - wallThickness },
  );
}

bootstrap().catch((error: unknown) => {
  console.error('[UI 吞噬者] 启动失败：', error);

  const status = document.getElementById('boot-status');
  if (status) {
    status.textContent = `启动失败 // ${
      error instanceof Error ? error.message : String(error)
    }`;
    status.classList.add('error');
  }
});
