import RAPIER from '@dimforge/rapier3d-compat';

export interface CollisionPair {
  a: number;
  b: number;
}

export interface PhysicsHandle {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

export interface DynamicOptions {
  density?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
  ccd?: boolean;
  collisionEvents?: boolean;
  gravityScale?: number;
  sensor?: boolean;
  collisionGroups?: number;
}

/**
 * Thin wrapper around Rapier3D.
 * Owns the WASM initialisation, the fixed-step loop and body/collider factories.
 */
export class PhysicsWorld {
  world!: RAPIER.World;
  private eventQueue!: RAPIER.EventQueue;
  private initialized = false;
  private accumulator = 0;
  private readonly fixedStep = 1 / 60;
  private readonly maxFrameDelta = 0.1;
  private readonly pairs: CollisionPair[] = [];

  get isReady(): boolean {
    return this.initialized;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // The -compat build embeds its WASM as base64; this resolves without extra
    // asset requests or MIME-type surprises from the dev server / static hosting.
    await RAPIER.init();

    this.world = new RAPIER.World({ x: 0, y: -24, z: 0 });
    this.world.timestep = this.fixedStep;
    this.eventQueue = new RAPIER.EventQueue(true);
    this.initialized = true;
  }

  /**
   * Advances the simulation with a fixed timestep and returns the collision
   * pairs that *started* during this frame. Pairs are processed by the caller
   * after the step, never inside Rapier's drain callback.
   *
   * `onFixedUpdate` runs immediately before each internal physics step, so
   * gameplay code (movement, aim, lifetimes) advances in lockstep with Rapier
   * instead of once per render frame.
   */
  step(deltaSeconds: number, onFixedUpdate?: (fixedDelta: number) => void): CollisionPair[] {
    this.requireWorld();
    this.pairs.length = 0;

    this.accumulator = Math.min(this.accumulator + Math.max(0, deltaSeconds), this.maxFrameDelta);

    let substeps = 0;
    while (this.accumulator >= this.fixedStep && substeps < 5) {
      onFixedUpdate?.(this.fixedStep);
      this.world.step(this.eventQueue);
      this.eventQueue.drainCollisionEvents((handleA, handleB, started) => {
        if (started) this.pairs.push({ a: handleA, b: handleB });
      });
      this.accumulator -= this.fixedStep;
      substeps += 1;
    }

    // Drop any remaining backlog so a stalled tab cannot trigger a spiral of death.
    if (substeps === 5) this.accumulator = 0;

    return this.pairs;
  }

  createStaticBox(
    halfWidth: number,
    halfHeight: number,
    halfDepth: number,
    position: { x: number; y: number; z: number },
    friction = 0.9,
  ): PhysicsHandle {
    this.requireWorld();
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfWidth, halfHeight, halfDepth).setFriction(friction),
      body,
    );
    return { body, collider };
  }

  createKinematicCapsule(
    radius: number,
    halfHeight: number,
    position: { x: number; y: number; z: number },
  ): PhysicsHandle {
    this.requireWorld();
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        position.x,
        position.y,
        position.z,
      ),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(halfHeight, radius).setFriction(0.35),
      body,
    );
    return { body, collider };
  }

  createKinematicBall(
    radius: number,
    position: { x: number; y: number; z: number },
    collisionEvents = false,
  ): PhysicsHandle {
    this.requireWorld();
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        position.x,
        position.y,
        position.z,
      ),
    );
    const desc = RAPIER.ColliderDesc.ball(radius).setFriction(0.35);
    if (collisionEvents) desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = this.world.createCollider(desc, body);
    return { body, collider };
  }

  createDynamicBox(
    halfWidth: number,
    halfHeight: number,
    halfDepth: number,
    position: { x: number; y: number; z: number },
    options: DynamicOptions = {},
  ): PhysicsHandle {
    this.requireWorld();
    const body = this.world.createRigidBody(
      this.dynamicBodyDesc(position, options).setRotation({
        x: 0,
        y: Math.sin(Math.random() * Math.PI),
        z: 0,
        w: Math.cos(Math.random() * Math.PI),
      }),
    );
    const collider = this.world.createCollider(
      this.dynamicColliderDesc(
        RAPIER.ColliderDesc.cuboid(halfWidth, halfHeight, halfDepth),
        options,
      ),
      body,
    );
    return { body, collider };
  }

  createDynamicBall(
    radius: number,
    position: { x: number; y: number; z: number },
    options: DynamicOptions = {},
  ): PhysicsHandle {
    this.requireWorld();
    const body = this.world.createRigidBody(this.dynamicBodyDesc(position, options));
    const collider = this.world.createCollider(
      this.dynamicColliderDesc(RAPIER.ColliderDesc.ball(radius), options),
      body,
    );
    return { body, collider };
  }

  removeBody(body: RAPIER.RigidBody | null | undefined): void {
    if (!body || !this.initialized) return;
    this.world.removeRigidBody(body);
  }

  private dynamicBodyDesc(
    position: { x: number; y: number; z: number },
    options: DynamicOptions,
  ): RAPIER.RigidBodyDesc {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setLinearDamping(options.linearDamping ?? 0.08)
      .setAngularDamping(options.angularDamping ?? 0.15)
      .setGravityScale(options.gravityScale ?? 1);

    if (options.ccd) desc.setCcdEnabled(true);
    return desc;
  }

  private dynamicColliderDesc(
    desc: RAPIER.ColliderDesc,
    options: DynamicOptions,
  ): RAPIER.ColliderDesc {
    desc
      .setDensity(options.density ?? 1)
      .setFriction(options.friction ?? 0.6)
      .setRestitution(options.restitution ?? 0.1)
      .setSensor(options.sensor ?? false)
      .setCollisionGroups(options.collisionGroups ?? 0xffffffff);

    if (options.collisionEvents) {
      desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    }
    return desc;
  }

  private requireWorld(): void {
    if (!this.initialized) {
      throw new Error('PhysicsWorld.init() must be awaited before using the world.');
    }
  }
}
