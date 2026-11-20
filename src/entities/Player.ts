import * as THREE from 'three';
import type * as RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../core/PhysicsWorld';

const MOVE_SPEED = 9;
const DASH_SPEED = 30;
const BULLET_SPEED = 52;
const BULLET_RADIUS = 0.11;
const BULLET_LIFETIME = 2.2;
// Player projectiles share a collision group and exclude that group from their
// own filter, so shotgun pellets cannot shoot each other at the muzzle.
const PLAYER_BULLET_GROUPS = (0x0002 << 16) | 0xfffd;

export interface BulletImpactInfo {
  damage: number;
  crit: boolean;
  direction: THREE.Vector3;
  impactPoint: THREE.Vector3;
  source: 'player' | 'burst' | 'health';
}

export interface PlayerConfig {
  fireInterval: number;
  damage: number;
  split: number;
  critChance: number;
  pellets?: number;
  pierce?: number;
  hpShots?: number;
  hpPierce?: number;
  twin?: number;
  radialEvery?: number;
  boomerang?: boolean;
  homing?: number;
}

interface Bullet {
  body: RAPIER.RigidBody;
  colliderHandle: number;
  mesh: THREE.Mesh;
  direction: THREE.Vector3;
  life: number;
  damage: number;
  crit: boolean;
  source: 'player' | 'burst' | 'health';
  pierceLeft: number;
  hitHandles: Set<number>;
  speed: number;
  homing: number;
  boomerang: boolean;
  boomerangTimer: number;
  returned: boolean;
}

/**
 * Player avatar: capsule visual, kinematic character controller, bullets and a
 * short invulnerable dash. Collision routing stays in main.ts.
 */
export class Player {
  readonly group: THREE.Group;

  onBulletImpact?: (otherColliderHandle: number, info: BulletImpactInfo) => void;

  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly bullets: Bullet[] = [];
  private readonly bulletsByCollider = new Map<number, Bullet>();
  private readonly bulletGeometry: THREE.SphereGeometry;
  private readonly bulletMaterial: THREE.MeshBasicMaterial;
  private readonly burstMaterial: THREE.MeshBasicMaterial;
  private readonly healthGeometry: THREE.BoxGeometry;
  private readonly healthMaterial: THREE.MeshBasicMaterial;
  private facing = 0;
  private fireCooldown = 0;
  private fireInterval = 0.15;
  private bulletDamage = 30;
  private split = 0;
  private pellets = 0;
  private bulletPierce = 0;
  private critChance = 0.05;
  private hpShots = 1;
  private hpPierce = 3;
  private twin = 0;
  private radialEvery = 0;
  private boomerang = false;
  private homing = 0;
  private shotCount = 0;
  private homingTargets: THREE.Vector3[] = [];
  private dashTimer = 0;
  private invulnerableTimer = 0;
  private readonly dashDirection = new THREE.Vector3(0, 0, -1);

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly scene: THREE.Scene,
  ) {
    const spawn = { x: 0, y: 1.05, z: 0 };
    const handle = physics.createKinematicCapsule(0.45, 0.55, spawn);
    this.body = handle.body;
    this.collider = handle.collider;

    this.controller = physics.world.createCharacterController(0.02);
    this.controller.enableAutostep(0.4, 0.2, true);
    // Snap-to-ground is deliberately off: in Rapier 0.21 it slowly pulls the
    // capsule through the floor when combined with a constant downward push.
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(80);
    this.controller.setMaxSlopeClimbAngle((58 * Math.PI) / 180);

    this.group = new THREE.Group();
    this.group.position.set(spawn.x, spawn.y, spawn.z);
    this.group.add(this.buildBody());
    scene.add(this.group);

    this.bulletGeometry = new THREE.SphereGeometry(BULLET_RADIUS, 8, 6);
    this.bulletMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.burstMaterial = new THREE.MeshBasicMaterial({ color: 0xffd48a, toneMapped: false });
    this.healthGeometry = new THREE.BoxGeometry(2.25, 0.3, 0.14);
    this.healthMaterial = new THREE.MeshBasicMaterial({ color: 0x7bffd8, toneMapped: false });
  }

  configure(config: PlayerConfig): void {
    this.fireInterval = Math.max(0.045, config.fireInterval);
    this.bulletDamage = Math.max(1, config.damage);
    this.split = Math.max(0, Math.floor(config.split));
    this.pellets = Math.max(0, Math.floor(config.pellets ?? 0));
    this.bulletPierce = Math.max(0, Math.floor(config.pierce ?? 0));
    this.critChance = Math.max(0, Math.min(1, config.critChance));
    this.hpShots = Math.max(1, Math.floor(config.hpShots ?? 1));
    this.hpPierce = Math.max(1, Math.floor(config.hpPierce ?? 3));
    this.twin = Math.max(0, Math.floor(config.twin ?? 0));
    this.radialEvery = Math.max(0, Math.floor(config.radialEvery ?? 0));
    this.boomerang = config.boomerang ?? false;
    this.homing = Math.max(0, config.homing ?? 0);
  }

  setHomingTargets(targets: THREE.Vector3[]): void {
    this.homingTargets = targets;
  }

  setFireInterval(interval: number): void {
    this.fireInterval = Math.max(0.045, interval);
  }

  update(delta: number, moveX: number, moveZ: number, aimPoint: THREE.Vector3): void {
    this.fireCooldown = Math.max(0, this.fireCooldown - delta);
    this.invulnerableTimer = Math.max(0, this.invulnerableTimer - delta);

    let inputX = moveX;
    let inputZ = moveZ;
    const inputLength = Math.hypot(inputX, inputZ);
    if (inputLength > 1) {
      inputX /= inputLength;
      inputZ /= inputLength;
    }

    const dashing = this.dashTimer > 0;
    this.dashTimer = Math.max(0, this.dashTimer - delta);

    const directionX = dashing ? this.dashDirection.x : inputX;
    const directionZ = dashing ? this.dashDirection.z : inputZ;
    const travel = (dashing ? DASH_SPEED : MOVE_SPEED) * delta;

    const desired = {
      x: directionX * travel,
      y: -0.6 * delta,
      z: directionZ * travel,
    };

    this.controller.computeColliderMovement(this.collider, desired);
    const movement = this.controller.computedMovement();
    const current = this.body.translation();
    this.body.setNextKinematicTranslation({
      x: current.x + movement.x,
      y: current.y + movement.y,
      z: current.z + movement.z,
    });

    this.aimAt(aimPoint, delta);
    this.updateBullets(delta);
  }

  startDash(direction: THREE.Vector3): boolean {
    if (this.dashTimer > 0) return false;
    this.dashDirection.copy(direction);
    this.dashDirection.y = 0;
    if (this.dashDirection.lengthSq() < 0.01) {
      this.dashDirection.copy(this.getForward());
    }
    this.dashDirection.normalize();
    this.dashTimer = 0.18;
    this.invulnerableTimer = 0.3;
    return true;
  }

  isDashing(): boolean {
    return this.dashTimer > 0;
  }

  isInvulnerable(): boolean {
    return this.invulnerableTimer > 0;
  }

  shoot(aimPoint: THREE.Vector3): boolean {
    if (this.fireCooldown > 0) return false;

    const current = this.body.translation();
    const chest = new THREE.Vector3(current.x, current.y + 0.15, current.z);
    const baseDirection = new THREE.Vector3(
      aimPoint.x - chest.x,
      aimPoint.y - chest.y,
      aimPoint.z - chest.z,
    );
    if (baseDirection.lengthSq() < 0.01) return false;
    baseDirection.normalize();

    const shots = 1 + this.split + this.pellets;
    const streams = 1 + this.twin;
    const spreadStep = this.pellets > 0 ? 0.075 : 0.055;
    const damage = this.bulletDamage * (this.pellets > 0 ? 0.68 : 1);
    const side = new THREE.Vector3(Math.cos(this.facing), 0, -Math.sin(this.facing));
    for (let stream = 0; stream < streams; stream += 1) {
      const streamOffset = streams === 1 ? 0 : (stream - (streams - 1) / 2) * 0.3;
      for (let index = 0; index < shots; index += 1) {
        const spread = shots === 1 ? 0 : (index - (shots - 1) / 2) * spreadStep;
        const direction = baseDirection
          .clone()
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), spread);
        const start = chest.clone().addScaledVector(direction, 0.85);
        start.addScaledVector(side, streamOffset);
        start.y = Math.max(start.y, 0.35);
        this.spawnBullet(
          start,
          direction,
          damage,
          Math.random() < this.critChance,
          'player',
          this.boomerang ? BULLET_SPEED * 0.5 : BULLET_SPEED,
          this.bulletPierce,
          this.boomerang,
          this.homing,
        );
      }
    }

    this.shotCount += 1;
    if (this.radialEvery > 0 && this.shotCount % this.radialEvery === 0) {
      this.fireRadialRing();
    }

    this.fireCooldown = this.fireInterval;
    return true;
  }

  private fireRadialRing(): void {
    const current = this.body.translation();
    const center = new THREE.Vector3(current.x, current.y + 0.3, current.z);
    const count = 10;
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2;
      const direction = new THREE.Vector3(Math.cos(angle), 0.04, Math.sin(angle)).normalize();
      const start = center.clone().addScaledVector(direction, 0.75);
      start.y = Math.max(0.45, start.y);
      this.spawnBullet(
        start,
        direction,
        this.bulletDamage * 0.55,
        false,
        'player',
        38,
        0,
        false,
        0,
      );
    }
  }

  /** High-damage, piercing HP-bar projectile. Main handles the HP cost/cooldown. */
  fireHealthProjectile(aimPoint: THREE.Vector3, damage: number, pierce: number): boolean {
    const totalPierce = Math.max(this.hpPierce, pierce);
    const current = this.body.translation();
    const chest = new THREE.Vector3(current.x, current.y + 0.15, current.z);
    const baseDirection = new THREE.Vector3(
      aimPoint.x - chest.x,
      aimPoint.y - chest.y,
      aimPoint.z - chest.z,
    );
    if (baseDirection.lengthSq() < 0.01) return false;
    baseDirection.normalize();

    for (let index = 0; index < this.hpShots; index += 1) {
      const offset = this.hpShots === 1 ? 0 : (index - (this.hpShots - 1) / 2) * 0.11;
      const direction = baseDirection
        .clone()
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), offset);
      const start = chest.clone().addScaledVector(direction, 1.0);
      start.y = Math.max(0.45, start.y);

      const handle = this.physics.createDynamicBall(0.34, start, {
        density: 1,
        friction: 0,
        restitution: 0,
        linearDamping: 0,
        angularDamping: 0,
        ccd: true,
        gravityScale: 0,
        collisionEvents: true,
        sensor: true,
        collisionGroups: PLAYER_BULLET_GROUPS,
      });
      handle.body.setLinvel(
        {
          x: direction.x * 48,
          y: direction.y * 48,
          z: direction.z * 48,
        },
        true,
      );

      const mesh = new THREE.Mesh(this.healthGeometry, this.healthMaterial);
      mesh.position.copy(start);
      mesh.rotation.y = Math.atan2(direction.x, direction.z) + Math.PI / 2;
      this.scene.add(mesh);

      const bullet: Bullet = {
        body: handle.body,
        colliderHandle: handle.collider.handle,
        mesh,
        direction: direction.clone(),
        life: 1.9,
        damage: damage,
        crit: false,
        source: 'health',
        pierceLeft: Math.max(1, totalPierce),
        hitHandles: new Set(),
        speed: 48,
        homing: 0,
        boomerang: false,
        boomerangTimer: 0,
        returned: false,
      };
      this.bullets.push(bullet);
      this.bulletsByCollider.set(bullet.colliderHandle, bullet);
    }
    return true;
  }

  /** Radial high-energy burst, used by the score cache. */
  fireBurst(origin: THREE.Vector3, count = 14, speed = 27): void {
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2;
      const direction = new THREE.Vector3(Math.cos(angle), 0.06, Math.sin(angle)).normalize();
      const start = origin.clone().addScaledVector(direction, 0.45);
      start.y = Math.max(start.y, 0.4);
      this.spawnBullet(start, direction, this.bulletDamage * 1.15, true, 'burst', speed);
    }
  }

  handleCollision(handleA: number, handleB: number): void {
    const bullet =
      this.bulletsByCollider.get(handleA) ?? this.bulletsByCollider.get(handleB);
    if (!bullet) return;

    const otherHandle = this.bulletsByCollider.has(handleA) ? handleB : handleA;
    if (bullet.hitHandles.has(otherHandle)) return;
    bullet.hitHandles.add(otherHandle);

    const otherCollider = this.physics.world.getCollider(otherHandle);
    const otherBody = otherCollider?.parent() ?? null;

    if (otherBody?.isDynamic() && bullet.source !== 'health') {
      const direction = bullet.direction;
      const impact = bullet.body.translation();
      otherBody.applyImpulseAtPoint(
        {
          x: direction.x * 18,
          y: 8,
          z: direction.z * 18,
        },
        { x: impact.x, y: impact.y, z: impact.z },
        true,
      );
    }

    const impact = bullet.body.translation();
    this.onBulletImpact?.(otherHandle, {
      damage: bullet.damage,
      crit: bullet.crit,
      direction: bullet.direction.clone(),
      impactPoint: new THREE.Vector3(impact.x, impact.y, impact.z),
      source: bullet.source,
    });

    if (bullet.boomerang) {
      if (!bullet.returned) return;
      this.removeBullet(bullet);
      return;
    }

    if (bullet.source === 'health' || bullet.pierceLeft > 0) {
      bullet.pierceLeft -= 1;
      if (bullet.pierceLeft <= 0) this.removeBullet(bullet);
      return;
    }

    this.removeBullet(bullet);
  }

  sync(): void {
    const position = this.body.translation();
    this.group.position.set(position.x, position.y, position.z);
    this.group.rotation.y = this.facing;

    for (const bullet of this.bullets) {
      const bulletPosition = bullet.body.translation();
      bullet.mesh.position.set(bulletPosition.x, bulletPosition.y, bulletPosition.z);
    }
  }

  getPosition(): THREE.Vector3 {
    const position = this.body.translation();
    return new THREE.Vector3(position.x, position.y, position.z);
  }

  getForward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
  }

  private spawnBullet(
    start: THREE.Vector3,
    direction: THREE.Vector3,
    damage: number,
    crit: boolean,
    source: 'player' | 'burst',
    speed = BULLET_SPEED,
    pierce = 0,
    boomerang = false,
    homing = 0,
  ): void {
    const sensor = pierce > 0 || boomerang;
    const bulletHandle = this.physics.createDynamicBall(BULLET_RADIUS, start, {
      density: 1.4,
      friction: 0.05,
      restitution: 0.08,
      linearDamping: 0,
      angularDamping: 0,
      ccd: true,
      gravityScale: 0,
      collisionEvents: true,
      sensor,
      collisionGroups: PLAYER_BULLET_GROUPS,
    });
    bulletHandle.body.setLinvel(
      {
        x: direction.x * speed,
        y: direction.y * speed,
        z: direction.z * speed,
      },
      true,
    );

    const mesh = new THREE.Mesh(
      this.bulletGeometry,
      source === 'burst' ? this.burstMaterial : this.bulletMaterial,
    );
    mesh.position.copy(start);
    this.scene.add(mesh);

    const bullet: Bullet = {
      body: bulletHandle.body,
      colliderHandle: bulletHandle.collider.handle,
      mesh,
      direction: direction.clone(),
      life: source === 'burst' ? 1.8 : BULLET_LIFETIME,
      damage,
      crit,
      source,
      pierceLeft: Math.max(0, pierce),
      hitHandles: new Set(),
      speed,
      homing,
      boomerang,
      boomerangTimer: 0.45,
      returned: false,
    };
    this.bullets.push(bullet);
    this.bulletsByCollider.set(bullet.colliderHandle, bullet);
  }

  private aimAt(point: THREE.Vector3, delta: number): void {
    const current = this.body.translation();
    const dx = point.x - current.x;
    const dz = point.z - current.z;
    if (dx * dx + dz * dz < 0.04) return;

    const targetAngle = Math.atan2(dx, dz);
    let difference = targetAngle - this.facing;
    difference = Math.atan2(Math.sin(difference), Math.cos(difference));
    this.facing += difference * Math.min(1, delta * 18);
  }

  private updateBullets(delta: number): void {
    for (let index = this.bullets.length - 1; index >= 0; index -= 1) {
      const bullet = this.bullets[index];
      bullet.life -= delta;

      const position = bullet.body.translation();
      if (bullet.homing > 0 && this.homingTargets.length > 0) {
        let nearest: THREE.Vector3 | null = null;
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const target of this.homingTargets) {
          const distance = target.distanceToSquared(
            new THREE.Vector3(position.x, position.y, position.z),
          );
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = target;
          }
        }
        if (nearest && nearestDistance < 400) {
          const desired = nearest
            .clone()
            .sub(new THREE.Vector3(position.x, position.y, position.z))
            .normalize();
          bullet.direction.lerp(desired, Math.min(1, bullet.homing * delta)).normalize();
          bullet.body.setLinvel(
            {
              x: bullet.direction.x * bullet.speed,
              y: bullet.direction.y * bullet.speed,
              z: bullet.direction.z * bullet.speed,
            },
            true,
          );
        }
      }

      if (bullet.boomerang && !bullet.returned) {
        bullet.boomerangTimer -= delta;
        if (bullet.boomerangTimer <= 0) {
          bullet.returned = true;
          bullet.direction.negate();
          bullet.hitHandles.clear();
          bullet.body.setLinvel(
            {
              x: bullet.direction.x * bullet.speed,
              y: bullet.direction.y * bullet.speed,
              z: bullet.direction.z * bullet.speed,
            },
            true,
          );
        }
      }

      const current = bullet.body.translation();
      const outside =
        Math.abs(current.x) > 13 ||
        Math.abs(current.z) > 13 ||
        current.y < -4 ||
        current.y > 14;

      if (bullet.life <= 0 || outside) {
        this.removeBullet(bullet);
      }
    }
  }

  private removeBullet(bullet: Bullet): void {
    this.physics.removeBody(bullet.body);
    this.scene.remove(bullet.mesh);
    this.bulletsByCollider.delete(bullet.colliderHandle);

    const index = this.bullets.indexOf(bullet);
    if (index >= 0) this.bullets.splice(index, 1);
  }

  private buildBody(): THREE.Group {
    const visual = new THREE.Group();

    const shellMaterial = new THREE.MeshStandardMaterial({
      color: 0x0a2a33,
      emissive: 0x00c8e8,
      emissiveIntensity: 1.0,
      roughness: 0.22,
      metalness: 0.68,
    });
    const shell = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.45, 1.1, 8, 20),
      shellMaterial,
    );
    shell.castShadow = true;
    shell.receiveShadow = true;
    visual.add(shell);

    const visor = new THREE.Mesh(
      new THREE.ConeGeometry(0.17, 0.44, 4),
      new THREE.MeshBasicMaterial({ color: 0xe8ffff, toneMapped: false }),
    );
    visor.rotation.x = Math.PI / 2;
    visor.position.set(0, 0.28, 0.38);
    visual.add(visor);

    const belt = new THREE.Mesh(
      new THREE.TorusGeometry(0.47, 0.024, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0x6ffcff, toneMapped: false }),
    );
    belt.rotation.x = Math.PI / 2;
    belt.position.y = -0.16;
    visual.add(belt);

    const halo = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.73, 32),
      new THREE.MeshBasicMaterial({
        color: 0x1fe7ff,
        transparent: true,
        opacity: 0.26,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -0.98;
    visual.add(halo);

    const chevronGeometry = new THREE.BufferGeometry();
    chevronGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [-0.32, 0, 0.95, 0.32, 0, 0.95, 0, 0, 1.9],
        3,
      ),
    );
    chevronGeometry.computeVertexNormals();
    const chevron = new THREE.Mesh(
      chevronGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x9bfff4,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    chevron.position.y = -0.96;
    visual.add(chevron);

    const glow = new THREE.PointLight(0x1fe7ff, 9, 8, 2);
    glow.position.set(0, 0.2, 0);
    visual.add(glow);

    return visual;
  }
}
