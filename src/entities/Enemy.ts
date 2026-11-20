import * as THREE from 'three';
import type * as RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { Player } from './Player';
import type { UICarrier, UIEntityManager, UIKind } from './UIEntityManager';
import type { EffectsSystem } from '../systems/EffectsSystem';
import type { SoundSystem } from '../systems/SoundSystem';

export type EnemyType = 'chaser' | 'node' | 'prime';

export interface EnemyContext {
  scene: THREE.Scene;
  physics: PhysicsWorld;
  player: Player;
  ui: UIEntityManager;
  effects: EffectsSystem;
  sound: SoundSystem;
  onPlayerHit: (damage: number, source: string) => void;
  onDeath: (enemy: Enemy) => void;
}

interface EnemyProjectile {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  damage: number;
}

const ARENA_LIMIT = 10.7;
const BOSS_NODE = 'node' as const;
const BOSS_PRIME = 'prime' as const;

/**
 * Chaser: hunts loose UI, otherwise the player; shoots and bites.
 * Node / Prime: slow bosses that fire radial bursts and tear docked UI into
 * the arena, pulling it back to devour it. Both implement UICarrier.
 */
export class Enemy implements UICarrier {
  private static nextId = 1;

  readonly id = Enemy.nextId++;
  readonly type: EnemyType;
  readonly isBoss: boolean;
  readonly carrierId: number;
  readonly radius: number;

  private readonly context: EnemyContext;
  private readonly body: RAPIER.RigidBody;
  private readonly colliderHandle: number;
  private readonly group: THREE.Group;
  private readonly coreMaterial: THREE.MeshStandardMaterial;
  private readonly coreMesh: THREE.Mesh;
  private readonly ringA: THREE.Mesh;
  private readonly ringB: THREE.Mesh;
  private readonly aura: THREE.Mesh;
  private readonly stunRing: THREE.Mesh;
  private readonly healthCanvas: HTMLCanvasElement | null;
  private readonly healthContext: CanvasRenderingContext2D | null;
  private readonly healthTexture: THREE.CanvasTexture | null;

  private hp: number;
  private readonly maxHp: number;
  private readonly baseSpeed: number;
  private speed: number;
  private readonly baseDamage: number;
  private damage: number;
  private alive = true;
  private stunTimer = 0;
  private flashTimer = 0;
  private shootTimer = 1.5;
  private bossPatternTimer = 1.5;
  private spiralTimer = 0;
  private spiralFireTimer = 0;
  private spiralAngle = 0;
  private tearTimer = 7;
  private contactTimer = 0;
  private facing = 0;
  private carriedKind: UIKind | null = null;
  private tearKind: UIKind | null = null;
  private tearBeam: THREE.Line | null = null;
  private readonly projectiles: EnemyProjectile[] = [];
  private readonly lastPosition = new THREE.Vector3();
  private readonly projectileGeometry = new THREE.SphereGeometry(0.17, 8, 6);
  private projectileMaterial: THREE.MeshBasicMaterial;

  constructor(type: EnemyType, wave: number, position: THREE.Vector3, context: EnemyContext) {
    this.type = type;
    this.context = context;
    this.isBoss = type === BOSS_NODE || type === BOSS_PRIME;
    this.carrierId = this.id;

    if (type === 'chaser') {
      this.maxHp = 80 + wave * 18;
      this.baseSpeed = 2.7 + wave * 0.08;
      this.baseDamage = 6 + wave * 0.7;
      this.radius = 0.72;
      this.projectileMaterial = new THREE.MeshBasicMaterial({
        color: 0xff6a82,
        toneMapped: false,
      });
    } else if (type === BOSS_NODE) {
      this.maxHp = 1300 + wave * 260;
      this.baseSpeed = 1.35;
      this.baseDamage = 14 + wave * 1.2;
      this.radius = 1.55;
      this.projectileMaterial = new THREE.MeshBasicMaterial({
        color: 0xffb347,
        toneMapped: false,
      });
    } else {
      this.maxHp = 2200 + wave * 360;
      this.baseSpeed = 1.55;
      this.baseDamage = 18 + wave * 1.5;
      this.radius = 2.05;
      this.projectileMaterial = new THREE.MeshBasicMaterial({
        color: 0xff3b5c,
        toneMapped: false,
      });
    }

    this.hp = this.maxHp;
    this.speed = this.baseSpeed;
    this.damage = this.baseDamage;

    const spawnY = this.radius + 0.15;
    this.lastPosition.set(position.x, spawnY, position.z);
    const handle = context.physics.createKinematicBall(
      this.radius,
      { x: position.x, y: spawnY, z: position.z },
      true,
    );
    this.body = handle.body;
    this.colliderHandle = handle.collider.handle;

    this.group = new THREE.Group();
    const visual = this.buildVisual(type);
    this.coreMaterial = visual.coreMaterial;
    this.coreMesh = visual.coreMesh;
    this.ringA = visual.ringA;
    this.ringB = visual.ringB;
    this.aura = visual.aura;
    this.stunRing = visual.stunRing;
    this.healthCanvas = visual.healthCanvas;
    this.healthContext = visual.healthContext;
    this.healthTexture = visual.healthTexture;
    this.group.position.set(position.x, spawnY, position.z);
    this.group.add(visual.group);
    context.scene.add(this.group);

    this.updateHealthSprite();
  }

  update(delta: number): void {
    if (!this.alive) return;

    this.flashTimer = Math.max(0, this.flashTimer - delta);
    this.stunTimer = Math.max(0, this.stunTimer - delta);
    this.contactTimer = Math.max(0, this.contactTimer - delta);
    this.shootTimer = Math.max(0, this.shootTimer - delta);

    this.updateProjectiles(delta);
    this.updateVisuals(delta);

    if (this.stunTimer > 0) {
      return;
    }

    if (this.isBoss) {
      this.updateBoss(delta);
    } else {
      this.updateChaser(delta);
    }
  }

  sync(): void {
    if (!this.alive) return;
    const position = this.body.translation();
    this.group.position.set(position.x, position.y, position.z);
    this.group.rotation.y = this.facing;
    this.lastPosition.set(position.x, position.y, position.z);
  }

  takeDamage(amount: number, direction: THREE.Vector3, crit: boolean): void {
    if (!this.alive) return;
    const appliedDamage = crit ? amount * 2 : amount;
    this.hp = Math.max(0, this.hp - appliedDamage);
    this.flashTimer = 0.12;
    this.updateHealthSprite();

    const position = this.getPosition();
    this.context.effects.burst(
      position.clone().add(new THREE.Vector3(0, 0.4, 0)),
      crit ? 0xfff0a0 : 0xff5c75,
      crit ? 18 : 9,
      crit ? 8 : 5,
      0.35,
    );
    this.context.effects.addShake(crit ? 0.24 : 0.09);
    this.context.sound.play(crit ? 'crit' : 'hit');

    if (this.hp <= 0) {
      this.die();
    } else {
      const away = direction.clone();
      away.y = 0;
      if (away.lengthSq() < 0.01) {
        away.copy(this.getPosition()).sub(this.context.player.getPosition());
        away.y = 0;
      }
      if (away.lengthSq() > 0.01) {
        away.normalize();
        const current = this.body.translation();
        this.body.setNextKinematicTranslation({
          x: THREE.MathUtils.clamp(current.x + away.x * 0.18, -ARENA_LIMIT, ARENA_LIMIT),
          y: current.y,
          z: THREE.MathUtils.clamp(current.z + away.z * 0.18, -ARENA_LIMIT, ARENA_LIMIT),
        });
      }
    }
  }

  stun(duration: number): void {
    if (!this.alive) return;
    this.stunTimer = Math.max(this.stunTimer, duration);
    this.stunRing.visible = true;
  }

  nudge(dx: number, dz: number): void {
    if (!this.alive) return;
    const current = this.body.translation();
    this.body.setNextKinematicTranslation({
      x: THREE.MathUtils.clamp(current.x + dx, -ARENA_LIMIT, ARENA_LIMIT),
      y: current.y,
      z: THREE.MathUtils.clamp(current.z + dz, -ARENA_LIMIT, ARENA_LIMIT),
    });
  }

  getPosition(): THREE.Vector3 {
    if (!this.alive) return this.lastPosition.clone();
    const position = this.body.translation();
    return new THREE.Vector3(position.x, position.y, position.z);
  }

  getColliderHandle(): number {
    return this.colliderHandle;
  }

  getHp(): number {
    return this.hp;
  }

  getMaxHp(): number {
    return this.maxHp;
  }

  isAlive(): boolean {
    return this.alive;
  }

  getAimMesh(): THREE.Mesh {
    return this.coreMesh;
  }

  getCarriedKind(): UIKind | null {
    return this.carriedKind;
  }

  getCarrierPosition(): THREE.Vector3 {
    return this.getPosition().add(new THREE.Vector3(0, 1.4, 0));
  }

  onUICaptured(kind: UIKind): void {
    this.carriedKind = kind;
    this.aura.visible = true;
    this.speed = this.baseSpeed * 1.18;
    this.damage = this.baseDamage * 1.25;
    this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.08);
    this.updateHealthSprite();
  }

  onUIReleased(_kind: UIKind): void {
    this.carriedKind = null;
    this.aura.visible = false;
    this.speed = this.baseSpeed;
    this.damage = this.baseDamage;
  }

  private updateChaser(delta: number): void {
    const playerPosition = this.context.player.getPosition();
    let target = playerPosition;
    let targetKind: UIKind | null = null;

    if (!this.carriedKind) {
      const loose = this.context.ui.getNearestLoosePanel(this.getPosition(), 12);
      if (loose) {
        target = loose.position;
        targetKind = loose.kind;
      }
    }

    const current = this.getPosition();
    const toTarget = target.clone().sub(current);
    toTarget.y = 0;
    const distance = toTarget.length();

    if (targetKind) {
      if (distance < 1.55) {
        const captured = this.context.ui.captureByEnemy(targetKind, this);
        if (captured) {
          this.context.sound.play('uiDevour');
        }
        target = playerPosition;
      }
    }

    const toPlayer = playerPosition.clone().sub(current);
    toPlayer.y = 0;
    const playerDistance = toPlayer.length();

    if (targetKind && distance >= 1.55) {
      this.moveToward(target, this.speed, delta);
    } else {
      if (playerDistance > 4.2) {
        this.moveToward(playerPosition, this.speed, delta);
      } else if (playerDistance < 3.0) {
        const away = current.clone().sub(playerPosition);
        away.y = 0;
        this.moveToward(current.clone().add(away.normalize()), this.speed * 0.8, delta);
      } else {
        const strafe = new THREE.Vector3(-toPlayer.z, 0, toPlayer.x).normalize();
        this.moveToward(
          current.clone().addScaledVector(strafe, 1.4),
          this.speed * 0.5,
          delta,
        );
      }

      if (playerDistance < 1.55 && this.contactTimer <= 0) {
        this.contactTimer = 1.5;
        this.context.onPlayerHit(this.damage, 'chaser-contact');
        this.context.effects.burst(playerPosition, 0xff3b5c, 12, 6, 0.4);
      }
    }

    if (
      !targetKind &&
      playerDistance < 15 &&
      this.shootTimer <= 0 &&
      this.stunTimer <= 0
    ) {
      this.shootAtPlayer();
      this.shootTimer = 2.4 + Math.random() * 0.7;
    }
  }

  private updateBoss(delta: number): void {
    const playerPosition = this.context.player.getPosition();
    const current = this.getPosition();
    const toPlayer = playerPosition.clone().sub(current);
    toPlayer.y = 0;
    const distance = toPlayer.length();

    if (distance > 7.2) {
      this.moveToward(playerPosition, this.speed, delta);
    } else if (distance < 5.2) {
      const away = current.clone().sub(playerPosition);
      away.y = 0;
      this.moveToward(current.clone().add(away.normalize()), this.speed * 0.8, delta);
    } else {
      const strafe = new THREE.Vector3(-toPlayer.z, 0, toPlayer.x).normalize();
      this.moveToward(
        current.clone().addScaledVector(strafe, 1.2),
        this.speed * 0.45,
        delta,
      );
    }

    this.updateBossPatterns(delta);

    if (distance < this.radius + 1.2 && this.contactTimer <= 0) {
      this.contactTimer = 1.3;
      this.context.onPlayerHit(this.damage, 'boss-contact');
      this.context.effects.burst(playerPosition, 0xff3b5c, 22, 8, 0.6);
    }

    this.tearTimer = Math.max(0, this.tearTimer - delta);
    if (!this.tearKind && this.tearTimer <= 0) {
      this.beginTear();
    }

    if (this.tearKind) {
      const state = this.context.ui.getState(this.tearKind);
      if (state !== 'loose') {
        this.clearTear();
      } else {
        const panelDistance = this.context.ui.pullPanel(this.tearKind, this.getPosition());
        this.updateBeam();
        if (panelDistance > 0 && panelDistance < 2.7) {
          const kind = this.tearKind;
          if (this.context.ui.captureByEnemy(kind, this)) {
            this.context.sound.play('uiDevour');
            this.clearTear();
          }
        }
      }
    }
  }

  private beginTear(): void {
    if (this.carriedKind) {
      this.tearTimer = 3;
      return;
    }
    const docked = this.context.ui.getDockedKinds();
    if (docked.length === 0) {
      this.tearTimer = 3;
      return;
    }
    const kind = docked[Math.floor(Math.random() * docked.length)];
    const current = this.getPosition();
    const position = new THREE.Vector3(
      THREE.MathUtils.clamp(current.x + (Math.random() - 0.5) * 6, -9.5, 9.5),
      2.4 + Math.random() * 1.6,
      THREE.MathUtils.clamp(current.z + (Math.random() - 0.5) * 6, -9.5, 9.5),
    );
    const velocity = current.clone().sub(position).normalize().multiplyScalar(2.5);
    if (!this.context.ui.tearOut(kind, position, velocity)) {
      this.tearTimer = 2;
      return;
    }
    this.tearKind = kind;
    this.tearTimer = 11;
    this.createBeam();
    this.context.effects.addShake(0.5);
    this.context.sound.play('boss');
  }

  private updateBossPatterns(delta: number): void {
    const phase = this.hp / this.maxHp > 0.6 ? 1 : this.hp / this.maxHp > 0.3 ? 2 : 3;

    if (this.spiralTimer > 0) {
      this.spiralTimer -= delta;
      this.spiralAngle += delta * (2.2 + phase * 0.45);
      this.spiralFireTimer -= delta;
      if (this.spiralFireTimer <= 0) {
        this.spiralFireTimer = phase === 3 ? 0.07 : 0.09;
        const origin = this.getPosition().add(new THREE.Vector3(0, 0.45, 0));
        const arms = phase === 3 ? 3 : 2;
        for (let arm = 0; arm < arms; arm += 1) {
          const angle = this.spiralAngle + (arm / arms) * Math.PI * 2;
          const direction = new THREE.Vector3(Math.cos(angle), 0.02, Math.sin(angle)).normalize();
          this.spawnProjectile(origin, direction, phase === 3 ? 6.8 : 6.2, this.bossBulletDamage(0.18));
        }
      }
      return;
    }

    this.bossPatternTimer -= delta;
    if (this.bossPatternTimer > 0) return;

    const roll = Math.random();
    if (phase === 1) {
      if (roll < 0.55) this.fireFan(phase);
      else this.fireRing(phase);
      return;
    }
    if (phase === 2) {
      if (roll < 0.4) this.startSpiral(phase);
      else if (roll < 0.75) this.fireRing(phase);
      else this.fireFan(phase);
      return;
    }
    if (roll < 0.5) this.startSpiral(phase);
    else if (roll < 0.8) this.fireRing(phase);
    else this.fireFan(phase);
  }

  private startSpiral(phase: number): void {
    this.spiralTimer = phase === 3 ? 3.0 : 2.4;
    this.spiralFireTimer = 0;
    this.spiralAngle = Math.random() * Math.PI * 2;
    this.bossPatternTimer = 0.9;
    const position = this.getPosition();
    this.context.effects.shockwave(position, 0xff3b5c, 2.8, 0.4);
    this.context.effects.addShake(0.35);
    this.context.sound.play('boss');
  }

  private fireRing(phase: number): void {
    const position = this.getPosition().add(new THREE.Vector3(0, 0.4, 0));
    const count = phase === 3 ? 32 : phase === 2 ? 28 : 24;
    const gap = phase === 3 ? 6 : 5;
    const startAngle = Math.random() * Math.PI * 2;
    for (let index = gap; index < count; index += 1) {
      const angle = startAngle + (index / count) * Math.PI * 2;
      const direction = new THREE.Vector3(Math.cos(angle), 0.02, Math.sin(angle)).normalize();
      this.spawnProjectile(position, direction, 6.4, this.bossBulletDamage(0.22));
    }
    this.context.effects.shockwave(position, 0xff3b5c, 4.2, 0.45);
    this.context.sound.play('popup');
    this.bossPatternTimer = phase === 3 ? 0.9 : phase === 2 ? 1.2 : 1.5;
  }

  private fireFan(phase: number): void {
    const origin = this.getPosition().add(new THREE.Vector3(0, 0.4, 0));
    const target = this.context.player.getPosition().add(new THREE.Vector3(0, 0.8, 0));
    const direction = target.sub(origin);
    const baseAngle = Math.atan2(direction.x, direction.z);
    const count = phase === 3 ? 13 : phase === 2 ? 11 : 9;
    const spread = phase === 3 ? 0.12 : phase === 2 ? 0.11 : 0.1;
    for (let index = 0; index < count; index += 1) {
      const angle = baseAngle + (index - (count - 1) / 2) * spread;
      const shot = new THREE.Vector3(Math.sin(angle), 0.02, Math.cos(angle)).normalize();
      this.spawnProjectile(origin, shot, 7.5, this.bossBulletDamage(0.2));
    }
    this.context.effects.burst(origin, 0xffb347, 18, 6, 0.3);
    this.bossPatternTimer = phase === 3 ? 0.8 : phase === 2 ? 1.1 : 1.3;
  }

  private bossBulletDamage(multiplier: number): number {
    return THREE.MathUtils.clamp(this.damage * multiplier, 1.5, 3.5);
  }

  private shootAtPlayer(): void {
    const origin = this.getPosition().add(new THREE.Vector3(0, 0.35, 0));
    const target = this.context.player.getPosition().add(new THREE.Vector3(0, 0.8, 0));
    const direction = target.sub(origin).normalize();
    this.spawnProjectile(origin, direction, 8.5, this.damage);
    this.context.effects.burst(origin, 0xff6a82, 4, 2.5, 0.2);
  }

  private spawnProjectile(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    speed: number,
    damage: number,
  ): void {
    if (this.projectiles.length >= 220) return;
    const mesh = new THREE.Mesh(this.projectileGeometry, this.projectileMaterial);
    mesh.position.copy(origin);
    this.context.scene.add(mesh);
    this.projectiles.push({
      mesh,
      velocity: direction.clone().multiplyScalar(speed),
      life: 3.4,
      damage,
    });
  }

  private updateProjectiles(delta: number): void {
    const playerPosition = this.context.player.getPosition().add(new THREE.Vector3(0, 0.9, 0));
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      projectile.life -= delta;
      projectile.mesh.position.addScaledVector(projectile.velocity, delta);
      const position = projectile.mesh.position;

      const hitPlayer =
        this.context.player.isInvulnerable() === false &&
        position.distanceTo(playerPosition) < 0.7;
      const outside =
        Math.abs(position.x) > 13.2 ||
        Math.abs(position.z) > 13.2 ||
        position.y < -2 ||
        position.y > 12;

      if (hitPlayer) {
        this.context.onPlayerHit(projectile.damage, 'enemy-bullet');
        this.context.effects.burst(position, 0xff3b5c, 12, 5, 0.3);
        this.context.sound.play('hit');
      }

      if (hitPlayer || projectile.life <= 0 || outside) {
        this.context.scene.remove(projectile.mesh);
        this.projectiles.splice(index, 1);
      }
    }
  }

  private updateVisuals(delta: number): void {
    const time = performance.now() * 0.001;
    this.ringA.rotation.z += delta * 1.4;
    this.ringA.rotation.x += delta * 0.6;
    this.ringB.rotation.y += delta * 1.1;
    this.ringB.rotation.z -= delta * 0.7;
    this.aura.rotation.z += delta * 2.2;
    this.aura.rotation.x = Math.PI / 2;

    this.stunRing.rotation.z += delta * 2.4;
    this.stunRing.visible = this.stunTimer > 0;

    if (this.flashTimer > 0) {
      this.coreMaterial.emissiveIntensity = 2.8;
      this.coreMesh.scale.setScalar(1.06 + Math.sin(time * 40) * 0.02);
    } else {
      this.coreMaterial.emissiveIntensity = this.isBoss ? 1.35 : 1.1;
      this.coreMesh.scale.setScalar(1);
    }

    if (this.carriedKind) {
      this.aura.visible = true;
      this.aura.scale.setScalar(1 + Math.sin(time * 4) * 0.06);
    }
  }

  private moveToward(target: THREE.Vector3, speed: number, delta: number): void {
    const current = this.body.translation();
    const dx = target.x - current.x;
    const dz = target.z - current.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.05) return;

    const travel = Math.min(distance, speed * delta);
    const nx = THREE.MathUtils.clamp(current.x + (dx / distance) * travel, -ARENA_LIMIT, ARENA_LIMIT);
    const nz = THREE.MathUtils.clamp(current.z + (dz / distance) * travel, -ARENA_LIMIT, ARENA_LIMIT);
    this.facing = Math.atan2(dx, dz);
    this.body.setNextKinematicTranslation({ x: nx, y: current.y, z: nz });
  }

  private die(): void {
    if (!this.alive) return;
    const deathPosition = this.getPosition();
    this.alive = false;
    this.lastPosition.copy(deathPosition);
    for (const projectile of this.projectiles) {
      this.context.scene.remove(projectile.mesh);
    }
    this.projectiles.length = 0;
    this.clearTear();
    this.context.physics.removeBody(this.body);
    this.context.scene.remove(this.group);

    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) {
        material.forEach((entry) => entry.dispose());
      } else {
        material?.dispose();
      }
    });
    this.healthTexture?.dispose();
    this.projectileGeometry.dispose();
    this.projectileMaterial.dispose();

    this.context.onDeath(this);
  }

  private updateHealthSprite(): void {
    if (!this.healthCanvas || !this.healthContext || !this.healthTexture) return;
    const width = this.healthCanvas.width;
    const height = this.healthCanvas.height;
    const ctx = this.healthContext;
    const ratio = Math.max(0, Math.min(1, this.hp / this.maxHp));
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(2, 8, 12, 0.85)';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255, 120, 140, 0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
    const fill = ctx.createLinearGradient(0, 0, width, 0);
    fill.addColorStop(0, '#ff1744');
    fill.addColorStop(1, '#ff8a5c');
    ctx.fillStyle = fill;
    ctx.fillRect(2, 2, (width - 4) * ratio, height - 4);
    this.healthTexture.needsUpdate = true;
  }

  private createBeam(): void {
    this.removeBeam();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3),
    );
    const material = new THREE.LineBasicMaterial({
      color: 0xff3b5c,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.tearBeam = new THREE.Line(geometry, material);
    this.tearBeam.frustumCulled = false;
    this.context.scene.add(this.tearBeam);
    this.updateBeam();
  }

  private updateBeam(): void {
    if (!this.tearBeam || !this.tearKind) return;
    const positions = this.tearBeam.geometry.getAttribute('position') as THREE.BufferAttribute;
    const start = this.getPosition().add(new THREE.Vector3(0, 1.2, 0));
    const end = this.context.ui.getPanel(this.tearKind).getPosition();
    positions.setXYZ(0, start.x, start.y, start.z);
    positions.setXYZ(1, end.x, end.y, end.z);
    positions.needsUpdate = true;
  }

  private clearTear(): void {
    this.tearKind = null;
    this.tearTimer = 9;
    this.removeBeam();
  }

  private removeBeam(): void {
    if (!this.tearBeam) return;
    this.context.scene.remove(this.tearBeam);
    this.tearBeam.geometry.dispose();
    (this.tearBeam.material as THREE.Material).dispose();
    this.tearBeam = null;
  }

  private buildVisual(type: EnemyType): {
    group: THREE.Group;
    coreMaterial: THREE.MeshStandardMaterial;
    coreMesh: THREE.Mesh;
    ringA: THREE.Mesh;
    ringB: THREE.Mesh;
    aura: THREE.Mesh;
    stunRing: THREE.Mesh;
    healthSprite: THREE.Sprite | null;
    healthCanvas: HTMLCanvasElement | null;
    healthContext: CanvasRenderingContext2D | null;
    healthTexture: THREE.CanvasTexture | null;
  } {
    const group = new THREE.Group();
    const boss = type !== 'chaser';

    const coreGeometry = boss
      ? new THREE.DodecahedronGeometry(type === BOSS_PRIME ? 1.85 : 1.35, 0)
      : new THREE.IcosahedronGeometry(0.68, 0);
    const coreMaterial = new THREE.MeshStandardMaterial({
      color: 0x1a0509,
      emissive: type === 'chaser' ? 0xff2244 : type === BOSS_NODE ? 0xff5c2e : 0xff1744,
      emissiveIntensity: 1.1,
      roughness: 0.35,
      metalness: 0.6,
    });
    const coreMesh = new THREE.Mesh(coreGeometry, coreMaterial);
    coreMesh.castShadow = true;
    coreMesh.receiveShadow = true;
    group.add(coreMesh);

    const ringGeometry = boss
      ? new THREE.TorusGeometry(type === BOSS_PRIME ? 2.25 : 1.75, 0.035, 8, 48)
      : new THREE.TorusGeometry(0.96, 0.028, 8, 40);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: type === BOSS_NODE ? 0xffb347 : 0xff3b5c,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const ringA = new THREE.Mesh(ringGeometry, ringMaterial);
    ringA.rotation.x = Math.PI / 2.4;
    group.add(ringA);
    const ringB = new THREE.Mesh(ringGeometry, ringMaterial);
    ringB.rotation.y = Math.PI / 2.2;
    group.add(ringB);

    if (boss) {
      const spikeMaterial = new THREE.MeshStandardMaterial({
        color: 0x22070c,
        emissive: 0xff1744,
        emissiveIntensity: 0.7,
        roughness: 0.4,
        metalness: 0.5,
      });
      const spikeGeometry = new THREE.ConeGeometry(0.22, 1.5, 4);
      for (let index = 0; index < 6; index += 1) {
        const spike = new THREE.Mesh(spikeGeometry, spikeMaterial);
        const angle = (index / 6) * Math.PI * 2;
        spike.position.set(Math.cos(angle) * 1.7, 0.2, Math.sin(angle) * 1.7);
        spike.rotation.z = Math.PI / 2;
        spike.rotation.y = -angle;
        group.add(spike);
      }
    }

    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(boss ? 0.22 : 0.13, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffe8ec, toneMapped: false }),
    );
    eye.position.set(0, 0.05, boss ? 1.5 : 0.6);
    group.add(eye);

    const aura = new THREE.Mesh(
      new THREE.TorusGeometry(boss ? 2.5 : 1.15, 0.05, 8, 45),
      new THREE.MeshBasicMaterial({
        color: 0xffd48a,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    aura.rotation.x = Math.PI / 2;
    aura.visible = false;
    group.add(aura);

    const stunRing = new THREE.Mesh(
      new THREE.TorusGeometry(boss ? 2.1 : 0.9, 0.06, 8, 36),
      new THREE.MeshBasicMaterial({
        color: 0x8afff0,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    stunRing.rotation.x = Math.PI / 2;
    stunRing.visible = false;
    group.add(stunRing);

    const glow = new THREE.PointLight(
      type === BOSS_PRIME ? 0xff1744 : 0xff6a82,
      boss ? 22 : 6,
      boss ? 12 : 6,
      2,
    );
    group.add(glow);

    let healthSprite: THREE.Sprite | null = null;
    let healthCanvas: HTMLCanvasElement | null = null;
    let healthContext: CanvasRenderingContext2D | null = null;
    let healthTexture: THREE.CanvasTexture | null = null;
    if (!boss) {
      healthCanvas = document.createElement('canvas');
      healthCanvas.width = 128;
      healthCanvas.height = 14;
      healthContext = healthCanvas.getContext('2d');
      if (healthContext) {
        healthTexture = new THREE.CanvasTexture(healthCanvas);
        healthTexture.colorSpace = THREE.SRGBColorSpace;
        const material = new THREE.SpriteMaterial({
          map: healthTexture,
          transparent: true,
          depthTest: false,
          depthWrite: false,
        });
        healthSprite = new THREE.Sprite(material);
        healthSprite.scale.set(1.5, 0.16, 1);
        healthSprite.position.set(0, 1.25, 0);
        healthSprite.renderOrder = 10;
        group.add(healthSprite);
      }
    }

    return {
      group,
      coreMaterial,
      coreMesh,
      ringA,
      ringB,
      aura,
      stunRing,
      healthSprite,
      healthCanvas,
      healthContext,
      healthTexture,
    };
  }
}
