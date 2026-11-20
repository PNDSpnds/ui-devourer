import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { UIKind } from './UIEntityManager';

export type UIPanelKind = UIKind | 'popup';
export type PanelDraw = (ctx: CanvasRenderingContext2D, width: number, height: number) => void;

export interface PanelStyle {
  width: number;
  height: number;
  depth: number;
  canvasWidth: number;
  canvasHeight: number;
  accent: number;
}

export interface PanelSpawnOptions {
  dropHeight?: number;
  yaw?: number;
  linearVelocity?: { x: number; y: number; z: number };
  angularVelocity?: { x: number; y: number; z: number };
  density?: number;
}

/**
 * A world-space HUD panel: two mirrored canvases, one CanvasTexture each, a
 * dynamic Rapier box and an edge glow. It survives docking; only the physics
 * body and mesh are created/destroyed as it moves between HUD and arena.
 */
export class UIPanel {
  readonly kind: UIPanelKind;
  readonly style: PanelStyle;
  state: 'docked' | 'loose' | 'carried' = 'docked';

  private readonly scene: THREE.Scene;
  private readonly physics: PhysicsWorld;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly backCanvas: HTMLCanvasElement;
  private readonly backCtx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly backTexture: THREE.CanvasTexture;
  private draw: PanelDraw;

  private mesh: THREE.Mesh | null = null;
  private body: RAPIER.RigidBody | null = null;
  private colliderHandle: number | null = null;
  private geometry: THREE.BoxGeometry | null = null;
  private edgeGeometry: THREE.EdgesGeometry | null = null;
  private edgeMaterial: THREE.LineBasicMaterial | null = null;
  private materials: THREE.Material[] = [];
  private readonly lastPosition = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    physics: PhysicsWorld,
    kind: UIPanelKind,
    style: PanelStyle,
    draw: PanelDraw,
  ) {
    this.scene = scene;
    this.physics = physics;
    this.kind = kind;
    this.style = style;
    this.draw = draw;

    this.canvas = document.createElement('canvas');
    this.canvas.width = style.canvasWidth;
    this.canvas.height = style.canvasHeight;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error(`无法为 ${kind} UI 创建画布。`);
    this.ctx = context;

    this.backCanvas = document.createElement('canvas');
    this.backCanvas.width = style.canvasWidth;
    this.backCanvas.height = style.canvasHeight;
    const backContext = this.backCanvas.getContext('2d');
    if (!backContext) throw new Error(`无法为 ${kind} UI 创建背面画布。`);
    this.backCtx = backContext;

    this.texture = this.makeTexture(this.canvas);
    this.backTexture = this.makeTexture(this.backCanvas);
    this.redraw();
  }

  setDraw(draw: PanelDraw): void {
    this.draw = draw;
    this.redraw();
  }

  redraw(): void {
    this.ctx.clearRect(0, 0, this.style.canvasWidth, this.style.canvasHeight);
    this.draw(this.ctx, this.style.canvasWidth, this.style.canvasHeight);
    this.backCtx.clearRect(0, 0, this.style.canvasWidth, this.style.canvasHeight);
    this.backCtx.save();
    this.backCtx.translate(this.style.canvasWidth, 0);
    this.backCtx.scale(-1, 1);
    this.backCtx.drawImage(this.canvas, 0, 0);
    this.backCtx.restore();
    this.texture.needsUpdate = true;
    this.backTexture.needsUpdate = true;
  }

  spawn(position: THREE.Vector3, options: PanelSpawnOptions = {}): void {
    if (this.body) return;

    this.redraw();
    const width = this.style.width;
    const height = this.style.height;
    const depth = this.style.depth;

    const geometry = new THREE.BoxGeometry(width, height, depth);
    const faceMaterial = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false });
    const backMaterial = new THREE.MeshBasicMaterial({ map: this.backTexture, toneMapped: false });
    const caseMaterial = new THREE.MeshStandardMaterial({
      color: 0x04151b,
      emissive: 0x0a4652,
      emissiveIntensity: 0.65,
      roughness: 0.32,
      metalness: 0.7,
    });
    const materials: THREE.Material[] = [
      caseMaterial,
      caseMaterial,
      caseMaterial,
      caseMaterial,
      faceMaterial,
      backMaterial,
    ];
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const edgeGeometry = new THREE.EdgesGeometry(geometry);
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: this.style.accent,
      transparent: true,
      opacity: 0.85,
    });
    mesh.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));

    const yaw = options.yaw ?? Math.random() * Math.PI * 2;
    const dropHeight = options.dropHeight ?? 0;
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y + dropHeight, position.z)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .setLinearDamping(0.18)
        .setAngularDamping(0.3)
        .setCcdEnabled(true),
    );
    const collider = this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2)
        .setDensity(options.density ?? 4.2)
        .setFriction(0.78)
        .setRestitution(0.12)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body,
    );

    if (options.linearVelocity) body.setLinvel(options.linearVelocity, true);
    if (options.angularVelocity) body.setAngvel(options.angularVelocity, true);

    const translation = body.translation();
    mesh.position.set(translation.x, translation.y, translation.z);
    mesh.quaternion.set(
      body.rotation().x,
      body.rotation().y,
      body.rotation().z,
      body.rotation().w,
    );
    this.scene.add(mesh);

    this.geometry = geometry;
    this.edgeGeometry = edgeGeometry;
    this.edgeMaterial = edgeMaterial;
    this.materials = materials;
    this.mesh = mesh;
    this.body = body;
    this.colliderHandle = collider.handle;
    this.state = 'loose';
    this.lastPosition.copy(mesh.position);
  }

  despawn(): void {
    if (this.body) {
      this.scene.remove(this.mesh as THREE.Mesh);
      this.physics.removeBody(this.body);
    }
    if (this.mesh) {
      this.mesh.removeFromParent();
    }
    this.geometry?.dispose();
    this.edgeGeometry?.dispose();
    this.edgeMaterial?.dispose();
    const unique = new Set(this.materials);
    for (const material of unique) material.dispose();

    this.mesh = null;
    this.body = null;
    this.colliderHandle = null;
    this.geometry = null;
    this.edgeGeometry = null;
    this.edgeMaterial = null;
    this.materials = [];
    this.state = 'docked';
  }

  dispose(): void {
    this.despawn();
    this.texture.dispose();
    this.backTexture.dispose();
  }

  sync(): void {
    if (!this.body || !this.mesh) return;
    const position = this.body.translation();
    const rotation = this.body.rotation();
    this.mesh.position.set(position.x, position.y, position.z);
    this.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    this.lastPosition.copy(this.mesh.position);
  }

  getPosition(): THREE.Vector3 {
    if (!this.body) return this.lastPosition.clone();
    const position = this.body.translation();
    return new THREE.Vector3(position.x, position.y, position.z);
  }

  getVelocity(): THREE.Vector3 {
    if (!this.body) return new THREE.Vector3();
    const velocity = this.body.linvel();
    return new THREE.Vector3(velocity.x, velocity.y, velocity.z);
  }

  getMesh(): THREE.Mesh | null {
    return this.mesh;
  }

  getTexture(): THREE.CanvasTexture {
    return this.texture;
  }

  getBackTexture(): THREE.CanvasTexture {
    return this.backTexture;
  }

  getBody(): RAPIER.RigidBody | null {
    return this.body;
  }

  getColliderHandle(): number | null {
    return this.colliderHandle;
  }

  setState(state: 'docked' | 'loose' | 'carried'): void {
    this.state = state;
  }

  private makeTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    return texture;
  }
}
