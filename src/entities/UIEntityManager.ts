import * as THREE from 'three';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { HudOverlay } from '../ui/HudOverlay';
import type { SoundName } from '../systems/SoundSystem';
import { UIPanel } from './UIPanel';
import type { PanelStyle } from './UIPanel';

export type UIKind = 'hp' | 'skills' | 'score';
export type UIPanelState = 'docked' | 'loose' | 'carried' | 'held';

export interface UICarrier {
  readonly carrierId: number;
  getCarrierPosition(): THREE.Vector3;
  onUICaptured(kind: UIKind): void;
  onUIReleased(kind: UIKind): void;
}

export interface RunStats {
  score: number;
  combo: number;
  multiplier: number;
  cycle: number;
  stage: number;
  stageText: string;
  isBoss: boolean;
  kills: number;
  maxCombo: number;
  reclaims: number;
  lost: number;
  comboRatio: number;
}

export interface LooseUIRef {
  kind: UIKind;
  position: THREE.Vector3;
  distance: number;
}

export interface PopupProjectile {
  panel: UIPanel;
  timer: number;
  radius: number;
  title: string;
  body: string;
}

export interface UIHooks {
  onPlayerDamage: (amount: number, source: string, hp: number) => void;
  onDefeat: () => void;
  onScoreBurst: (position: THREE.Vector3) => void;
  onScoreBonus: (amount: number) => void;
  onSkillDetonate: (position: THREE.Vector3) => void;
  onPopupDetonate: (position: THREE.Vector3) => void;
  onShake: (strength: number) => void;
  onGlitch: (strength: number, label?: string) => void;
  onSound: (name: SoundName) => void;
  onUILost: (kind: UIKind) => void;
  onUIRecall: (kind: UIKind) => void;
  onRecallComplete: (count: number) => void;
}

const KINDS: UIKind[] = ['hp', 'skills', 'score'];
const RECALL_KINDS: UIKind[] = ['skills', 'score'];

const HP_STYLE: PanelStyle = {
  width: 3.2,
  height: 0.88,
  depth: 0.18,
  canvasWidth: 640,
  canvasHeight: 176,
  accent: 0x39ffc0,
};

const SKILL_STYLE: PanelStyle = {
  width: 2.8,
  height: 1.5,
  depth: 0.2,
  canvasWidth: 560,
  canvasHeight: 300,
  accent: 0xffb347,
};

const SCORE_STYLE: PanelStyle = {
  width: 3.2,
  height: 1.2,
  depth: 0.18,
  canvasWidth: 640,
  canvasHeight: 240,
  accent: 0x63ecff,
};

const POPUP_STYLE: PanelStyle = {
  width: 3.0,
  height: 1.8,
  depth: 0.2,
  canvasWidth: 600,
  canvasHeight: 360,
  accent: 0xff3b5c,
};

/**
 * Owns every detachable HUD panel and its physical twin.
 * HP / skills / score can be docked, loose or carried by an enemy; system
 * popups can be weaponized into short-lived physical projectiles.
 */
export class UIEntityManager {
  readonly maxHpDefault = 100;

  maxHp = this.maxHpDefault;
  hp = this.maxHpDefault;
  shield = 0;

  private readonly overlay: HudOverlay;
  private readonly hooks: UIHooks;
  private readonly physics: PhysicsWorld;
  private readonly scene: THREE.Scene;

  private readonly panels: Record<UIKind, UIPanel>;
  private readonly states: Record<UIKind, UIPanelState> = {
    hp: 'docked',
    skills: 'docked',
    score: 'docked',
  };
  private readonly carriers: Record<UIKind, UICarrier | null> = {
    hp: null,
    skills: null,
    score: null,
  };

  private readonly popupProjectiles: PopupProjectile[] = [];
  private readonly heldWeapon: THREE.Group;
  private hpWeaponHeld = false;
  private stats: RunStats = {
    score: 0,
    combo: 0,
    multiplier: 1,
    cycle: 1,
    stage: 1,
    stageText: '第 1 循环 // 小关 1/5',
    isBoss: false,
    kills: 0,
    maxCombo: 0,
    reclaims: 0,
    lost: 0,
    comboRatio: 0,
  };

  private skillFuse = 0;
  private shieldTimer = 0;
  private critical = false;
  private damageGate: (() => boolean) | null = null;

  constructor(
    physics: PhysicsWorld,
    scene: THREE.Scene,
    overlay: HudOverlay,
    hooks: UIHooks,
  ) {
    this.physics = physics;
    this.scene = scene;
    this.overlay = overlay;
    this.hooks = hooks;

    this.panels = {
      hp: new UIPanel(scene, physics, 'hp', HP_STYLE, (ctx, width, height) =>
        this.drawHp(ctx, width, height),
      ),
      skills: new UIPanel(scene, physics, 'skills', SKILL_STYLE, (ctx, width, height) =>
        this.drawSkills(ctx, width, height),
      ),
      score: new UIPanel(scene, physics, 'score', SCORE_STYLE, (ctx, width, height) =>
        this.drawScore(ctx, width, height),
      ),
    };

    this.panels.hp.redraw();
    this.panels.skills.redraw();
    this.panels.score.redraw();
    this.heldWeapon = this.buildHeldWeapon();
    this.refreshHud();
  }

  getHeldWeaponGroup(): THREE.Group {
    return this.heldWeapon;
  }

  isHpHeld(): boolean {
    return this.hpWeaponHeld;
  }

  toggleHpWeapon(): void {
    if (this.hp <= 0) return;
    if (this.hpWeaponHeld) {
      this.hpWeaponHeld = false;
      this.states.hp = 'docked';
      this.heldWeapon.visible = false;
      document.body.classList.remove('is-hp-weapon');
      this.overlay.setPanelState('hp', 'docked');
      this.hooks.onSound('uiRecall');
      this.overlay.toast('已收回生命条 // 恢复屏幕显示', 'info');
      return;
    }

    this.hpWeaponHeld = true;
    this.states.hp = 'held';
    this.heldWeapon.visible = true;
    document.body.classList.add('is-hp-weapon');
    this.overlay.setPanelState('hp', 'held');
    this.hooks.onSound('uiDetach');
    this.hooks.onGlitch(0.55, '生命条武器化');
    this.overlay.toast('生命条炮 // 每发消耗 4 生命，伤害极高', 'warn');
  }

  /** Spend the held HP bar as ammo, never dropping below 1 HP. */
  spendHp(amount: number): boolean {
    if (!this.hpWeaponHeld || this.hp <= 1) return false;
    this.hp = Math.max(1, this.hp - amount);
    this.critical = false;
    this.panels.hp.redraw();
    return true;
  }

  setDamageGate(gate: () => boolean): void {
    this.damageGate = gate;
  }

  setRunStats(stats: RunStats): void {
    this.stats = stats;
    if (this.states.score === 'loose') this.panels.score.redraw();
  }

  update(delta: number): void {
    if (this.shieldTimer > 0) {
      this.shieldTimer -= delta;
      if (this.shieldTimer <= 0) {
        this.shieldTimer = 0;
        this.shield = 0;
        this.panels.hp.redraw();
      }
    }

    if (this.states.skills === 'loose' && this.skillFuse > 0) {
      this.skillFuse -= delta;
      if (this.skillFuse <= 0) {
        this.skillFuse = 0;
        this.detonateSkill();
      }
    }

    for (let index = this.popupProjectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.popupProjectiles[index];
      projectile.timer -= delta;
      if (projectile.timer <= 0) {
        this.detonatePopup(projectile);
      }
    }
  }

  sync(): void {
    for (const kind of KINDS) {
      this.panels[kind].sync();
    }
    for (const projectile of this.popupProjectiles) {
      projectile.panel.sync();
    }
  }

  throwSkills(spawnPoint: THREE.Vector3, direction: THREE.Vector3): void {
    const state = this.states.skills;
    if (state === 'docked') {
      this.detachKind('skills', spawnPoint, {
        dropHeight: 1.1,
        linearVelocity: { x: direction.x * 9, y: 5, z: direction.z * 9 },
        angularVelocity: { x: 0.4, y: 1.1, z: 2.2 },
      });
      this.skillFuse = 6;
      this.hooks.onSound('uiDetach');
      this.hooks.onGlitch(0.7, '技能 UI 已投掷');
      this.overlay.toast('技能 UI // 磁力诱饵已启动', 'warn');
    } else if (state === 'loose') {
      this.skillFuse = 0;
      this.dockKind('skills');
      this.hooks.onUIRecall('skills');
      this.hooks.onRecallComplete(1);
      this.hooks.onSound('uiRecall');
      this.overlay.toast('技能 UI 已召回');
    } else {
      this.overlay.toast('技能 UI 被敌人夺走', 'error');
    }
  }

  detachScore(spawnPoint: THREE.Vector3): void {
    if (this.states.score !== 'docked') return;
    this.detachKind('score', spawnPoint, {
      dropHeight: 3.4,
      angularVelocity: { x: 0.5, y: 0.8, z: 2.1 },
    });
    this.hooks.onSound('uiDetach');
    this.hooks.onGlitch(0.4, '计分缓存脱落');
    this.overlay.toast('计分牌脱落 // 射击或冲刺撞击', 'warn');
  }

  recallAll(): number {
    let count = 0;
    for (const kind of RECALL_KINDS) {
      if (this.states[kind] !== 'loose') continue;
      this.dockKind(kind);
      this.hooks.onUIRecall(kind);
      count += 1;
    }
    if (count > 0) {
      this.hooks.onSound('uiRecall');
      this.hooks.onGlitch(0.35, 'UI 磁力召回');
      this.overlay.toast(`已召回 ${count} 个 UI 实体`);
      this.hooks.onRecallComplete(count);
    } else {
      const locked = RECALL_KINDS.some((kind) => this.states[kind] === 'carried');
      this.overlay.toast(
        locked ? '没有可召回的 UI // 击杀携带者以释放' : '没有可召回的 UI',
        locked ? 'error' : 'info',
      );
    }
    return count;
  }

  captureByEnemy(kind: UIKind, carrier: UICarrier): boolean {
    if (kind === 'hp') return false;
    if (this.states[kind] !== 'loose') return false;
    if (kind === 'skills' && this.skillFuse > 0) {
      this.detonateSkill();
      return false;
    }

    const panel = this.panels[kind];
    panel.despawn();
    panel.state = 'carried';
    this.states[kind] = 'carried';
    this.carriers[kind] = carrier;
    carrier.onUICaptured(kind);
    this.hooks.onUILost(kind);
    this.hooks.onSound('uiDevour');
    this.hooks.onGlitch(0.8, `UI 被吞噬 // ${kind === 'skills' ? '技能栏' : '计分牌'}`);
    this.overlay.warnPanel(kind);
    this.overlay.toast(`UI 失守 // ${kind === 'skills' ? '技能栏' : '计分牌'} 被吞噬`, 'error');
    this.refreshHud();
    return true;
  }

  releaseFromCarrier(carrier: UICarrier): void {
    for (const kind of RECALL_KINDS) {
      if (this.carriers[kind] !== carrier) continue;
      const base = carrier.getCarrierPosition();
      const position = new THREE.Vector3(
        THREE.MathUtils.clamp(base.x + (Math.random() - 0.5) * 1.4, -10.8, 10.8),
        0.6,
        THREE.MathUtils.clamp(base.z + (Math.random() - 0.5) * 1.4, -10.8, 10.8),
      );
      this.states[kind] = 'loose';
      this.panels[kind].state = 'loose';
      this.panels[kind].spawn(position, {
        dropHeight: 1.4,
        angularVelocity: { x: 0.6, y: 0.9, z: 2.4 },
      });
      this.carriers[kind] = null;
      carrier.onUIReleased(kind);
      this.hooks.onSound('uiDetach');
      this.hooks.onGlitch(0.35, `UI 已释放 // ${kind === 'skills' ? '技能栏' : '计分牌'}`);
      this.overlay.toast(`UI 已释放 // 按 [E] 召回${kind === 'skills' ? '技能栏' : '计分牌'}`, 'warn');
      this.refreshHud();
    }
  }

  tearOut(kind: UIKind, position: THREE.Vector3, velocity: THREE.Vector3): boolean {
    if (kind === 'hp') return false;
    if (this.states[kind] !== 'docked') return false;
    this.states[kind] = 'loose';
    this.panels[kind].state = 'loose';
    this.panels[kind].spawn(position, {
      linearVelocity: { x: velocity.x, y: velocity.y, z: velocity.z },
      angularVelocity: { x: 0.5, y: 1.2, z: 2.7 },
    });
    this.carriers[kind] = null;
    this.hooks.onSound('uiDetach');
    this.hooks.onGlitch(1.0, '界面撕裂');
    this.overlay.toast(`首领撕裂 // ${kind === 'skills' ? '技能栏' : '计分牌'} 已落入场地`, 'error');
    this.refreshHud();
    return true;
  }

  pullPanel(kind: UIKind, target: THREE.Vector3): number {
    const panel = this.panels[kind];
    if (this.states[kind] !== 'loose') return 0;
    const body = panel.getBody();
    if (!body) return 0;

    const current = panel.getPosition();
    const direction = target
      .clone()
      .set(target.x, target.y + 1.2, target.z)
      .sub(current);
    const distance = direction.length();
    if (distance < 0.001) return 0;
    direction.normalize().multiplyScalar(7.5);
    body.setLinvel({ x: direction.x, y: direction.y, z: direction.z }, true);
    return distance;
  }

  pushLoosePanels(origin: THREE.Vector3, radius: number, force: number): void {
    for (const kind of RECALL_KINDS) {
      if (this.states[kind] !== 'loose') continue;
      const panel = this.panels[kind];
      const body = panel.getBody();
      if (!body) continue;
      const position = panel.getPosition();
      const direction = position.clone().sub(origin);
      direction.y = 0;
      const distance = direction.length();
      if (distance > radius || distance < 0.001) continue;
      direction.normalize();
      body.applyImpulse(
        {
          x: direction.x * force,
          y: 4,
          z: direction.z * force,
        },
        true,
      );
    }
  }

  onBulletHit(
    kind: UIKind,
    _impactPoint: THREE.Vector3,
    _direction: THREE.Vector3,
    _source: 'player' | 'burst' | 'dash' | 'health',
  ): void {
    if (kind === 'hp') return;

    if (kind === 'score') {
      if (this.states.score !== 'loose') return;
      const position = this.panels.score.getPosition();
      this.hooks.onScoreBurst(position);
      this.hooks.onScoreBonus(300);
      this.hooks.onUIRecall('score');
      this.hooks.onSound('score');
      this.hooks.onShake(0.4);
      this.hooks.onGlitch(0.4, '计分缓存引爆');
      this.dockKind('score');
      this.overlay.toast('计分缓存爆发 // 分数已写入', 'warn');
      return;
    }

    if (this.states.skills !== 'loose') return;
    this.detonateSkill();
  }

  damagePlayer(amount: number, source: string): void {
    if (this.damageGate?.()) return;
    if (amount <= 0) return;

    let remaining = amount;
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, remaining);
      this.shield -= absorbed;
      remaining -= absorbed;
      if (this.shield <= 0.001) {
        this.shield = 0;
        this.shieldTimer = 0;
      }
      this.panels.hp.redraw();
      this.hooks.onSound('shield');
    }

    if (remaining > 0) {
      this.hp = Math.max(0, this.hp - remaining);
      this.critical = this.hp <= 0;
      this.panels.hp.redraw();
      this.hooks.onPlayerDamage(remaining, source, this.hp);
      if (this.hp <= 0) {
        this.hooks.onDefeat();
        return;
      }
      if (this.hp <= 30) this.overlay.warnPanel('hp');
    } else {
      this.hooks.onPlayerDamage(0, source, this.hp);
    }
  }

  heal(amount: number): void {
    if (this.hp <= 0) return;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    this.critical = false;
    this.panels.hp.redraw();
  }

  setMaxHp(maxHp: number): void {
    this.maxHp = Math.max(1, maxHp);
    this.hp = Math.min(this.hp, this.maxHp);
    this.panels.hp.redraw();
  }

  grantShield(amount: number): void {
    this.shield = Math.min(80, this.shield + amount);
    this.shieldTimer = 6;
    this.panels.hp.redraw();
    this.hooks.onSound('shield');
    this.overlay.toast(`护盾 +${Math.round(amount)}`, 'info');
  }

  getStats(): RunStats {
    return this.stats;
  }

  getHp(): number {
    return this.hp;
  }

  getMaxHp(): number {
    return this.maxHp;
  }

  getShield(): number {
    return this.shield;
  }

  isCritical(): boolean {
    return this.critical;
  }

  isSkillsUsable(): boolean {
    return this.states.skills === 'docked' && this.hp > 0;
  }

  getSkillStateLabel(): string {
    if (this.states.skills === 'carried') return '被夺';
    if (this.states.skills === 'loose') return '已投掷';
    return '就绪';
  }

  getState(kind: UIKind): UIPanelState {
    return this.states[kind];
  }

  getPanel(kind: UIKind): UIPanel {
    return this.panels[kind];
  }

  getDockedKinds(): UIKind[] {
    return RECALL_KINDS.filter((kind) => this.states[kind] === 'docked');
  }

  getLoosePanels(): UIPanel[] {
    return RECALL_KINDS.filter((kind) => this.states[kind] === 'loose').map(
      (kind) => this.panels[kind],
    );
  }

  getNearestLoosePanel(position: THREE.Vector3, maxDistance: number): LooseUIRef | null {
    let best: LooseUIRef | null = null;
    for (const kind of RECALL_KINDS) {
      if (this.states[kind] !== 'loose') continue;
      const panelPosition = this.panels[kind].getPosition();
      const distance = panelPosition.distanceTo(position);
      if (distance > maxDistance) continue;
      if (!best || distance < best.distance) {
        best = { kind, position: panelPosition, distance };
      }
    }
    return best;
  }

  getPanelByCollider(handle: number): UIKind | null {
    for (const kind of RECALL_KINDS) {
      if (this.panels[kind].getColliderHandle() === handle) return kind;
    }
    return null;
  }

  getPopupByCollider(handle: number): PopupProjectile | null {
    return (
      this.popupProjectiles.find(
        (projectile) => projectile.panel.getColliderHandle() === handle,
      ) ?? null
    );
  }

  getAimMeshes(): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const kind of RECALL_KINDS) {
      if (this.states[kind] !== 'loose') continue;
      const mesh = this.panels[kind].getMesh();
      if (mesh) meshes.push(mesh);
    }
    for (const projectile of this.popupProjectiles) {
      const mesh = projectile.panel.getMesh();
      if (mesh) meshes.push(mesh);
    }
    return meshes;
  }

  spawnSystemPopup(): void {
    this.overlay.showPopup();
  }

  launchPopup(
    target: THREE.Vector3,
    playerPosition: THREE.Vector3,
    title: string,
    body: string,
  ): void {
    if (this.popupProjectiles.length >= 2) return;
    const panel = new UIPanel(
      this.scene,
      this.physics,
      'popup',
      POPUP_STYLE,
      (ctx, width, height) => this.drawPopup(ctx, width, height, title, body),
    );

    const origin = playerPosition.clone();
    origin.y += 1.5;
    const direction = target.clone().sub(origin);
    if (direction.lengthSq() < 0.01) direction.set(0, 0, -1);
    direction.normalize();
    origin.addScaledVector(direction, 1.5);
    origin.y = Math.max(1.2, origin.y);

    panel.spawn(origin, {
      linearVelocity: {
        x: direction.x * 17,
        y: direction.y * 17 + 2.5,
        z: direction.z * 17,
      },
      angularVelocity: { x: 0.8, y: 1.4, z: 2.2 },
    });
    this.popupProjectiles.push({
      panel,
      timer: 3,
      radius: 4.6,
      title,
      body,
    });
    this.hooks.onSound('popup');
    this.hooks.onGlitch(0.45, '弹窗武器化');
    this.overlay.toast('系统弹窗 // 已投掷', 'warn');
  }

  getPopupProjectiles(): PopupProjectile[] {
    return this.popupProjectiles;
  }

  detonatePopup(projectile: PopupProjectile): void {
    const index = this.popupProjectiles.indexOf(projectile);
    if (index < 0) return;
    const position = projectile.panel.getPosition();
    this.hooks.onPopupDetonate(position);
    this.hooks.onShake(0.55);
    this.hooks.onGlitch(0.85, '弹窗撞击');
    this.hooks.onSound('popup');
    projectile.panel.dispose();
    this.popupProjectiles.splice(index, 1);
  }

  dispose(): void {
    for (const kind of KINDS) this.panels[kind].dispose();
    for (const projectile of this.popupProjectiles) projectile.panel.dispose();
    this.popupProjectiles.length = 0;
  }

  private detachKind(
    kind: UIKind,
    spawnPoint: THREE.Vector3,
    options: {
      dropHeight?: number;
      linearVelocity?: { x: number; y: number; z: number };
      angularVelocity?: { x: number; y: number; z: number };
    },
  ): void {
    const panel = this.panels[kind];
    // Set the state before spawning: UIPanel.redraw() reads it for the decoy
    // and "cache ejected" variants of the canvas texture.
    this.states[kind] = 'loose';
    panel.state = 'loose';
    panel.spawn(spawnPoint, options);
    this.refreshHud();
  }

  private dockKind(kind: UIKind): void {
    const panel = this.panels[kind];
    panel.despawn();
    panel.state = 'docked';
    this.states[kind] = 'docked';
    this.carriers[kind] = null;
    if (kind === 'skills') this.skillFuse = 0;
    this.refreshHud();
  }

  private detonateSkill(): void {
    if (this.states.skills !== 'loose') return;
    const position = this.panels.skills.getPosition();
    this.hooks.onUIRecall('skills');
    this.dockKind('skills');
    this.hooks.onSkillDetonate(position);
    this.hooks.onShake(0.65);
    this.hooks.onGlitch(0.9, '技能诱饵引爆');
    this.hooks.onSound('nova');
    this.overlay.toast('技能诱饵引爆 // 范围眩晕', 'warn');
  }

  private refreshHud(): void {
    let detached = 0;
    for (const kind of KINDS) {
      this.overlay.setPanelState(kind, this.states[kind]);
      if (this.states[kind] === 'loose') detached += 1;
    }
    this.overlay.setDetachedCount(detached);
  }

  private buildHeldWeapon(): THREE.Group {
    const group = new THREE.Group();
    const width = 3.0;
    const height = 0.82;
    const depth = 0.17;
    const geometry = new THREE.BoxGeometry(width, height, depth);
    const face = new THREE.MeshBasicMaterial({
      map: this.panels.hp.getTexture(),
      toneMapped: false,
    });
    const back = new THREE.MeshBasicMaterial({
      map: this.panels.hp.getBackTexture(),
      toneMapped: false,
    });
    const casing = new THREE.MeshStandardMaterial({
      color: 0x04151b,
      emissive: 0x0a4652,
      emissiveIntensity: 0.8,
      roughness: 0.3,
      metalness: 0.7,
    });
    const mesh = new THREE.Mesh(geometry, [casing, casing, casing, casing, face, back]);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({
        color: 0x54ffd2,
        transparent: true,
        opacity: 0.9,
      }),
    );
    mesh.add(edges);
    group.add(mesh);
    group.position.set(1.35, 0.4, 0.65);
    group.rotation.set(0.08, -0.12, 0.1);
    group.visible = false;
    return group;
  }

  // ---------------------------------------------------------------- drawing

  private drawHp(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const ratio = Math.max(0, Math.min(1, this.hp / this.maxHp));
    const accent = this.critical ? '#ff3b5c' : '#39ffc0';
    this.drawBase(ctx, width, height, accent, '#071d24', '#02090d');

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '700 19px "Microsoft YaHei", "Consolas", "Courier New", monospace';
    ctx.fillStyle = '#63ecff';
    ctx.fillText('生命值 // UI 实体', 25, 32);
    ctx.textAlign = 'right';
    ctx.fillStyle = this.critical ? '#ff9aab' : 'rgba(99, 236, 255, 0.82)';
    ctx.fillText(this.critical ? '生命信号中断' : '连接稳定', width - 25, 32);

    ctx.textAlign = 'left';
    if (this.critical) {
      ctx.save();
      ctx.font = '700 44px "Microsoft YaHei", "Consolas", "Courier New", monospace';
      ctx.shadowColor = '#ff1744';
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#ff5c75';
      ctx.fillText('生命信号中断', 25, 86);
      ctx.restore();
      ctx.font = '700 18px "Microsoft YaHei", "Consolas", "Courier New", monospace';
      ctx.fillStyle = '#ff9aab';
      ctx.fillText('界面离线 // 运行终止', 25, 108);
    } else {
      ctx.save();
      ctx.font = '700 44px "Microsoft YaHei", "Consolas", "Courier New", monospace';
      ctx.shadowColor = 'rgba(90, 255, 200, 0.55)';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#eafff8';
      ctx.fillText(`生命：${Math.ceil(this.hp)} / ${this.maxHp}`, 25, 86);
      ctx.restore();
      if (this.shield > 0) {
        ctx.font = '700 17px "Microsoft YaHei", "Consolas", "Courier New", monospace';
        ctx.fillStyle = '#7fefff';
        ctx.fillText(`护盾 ${Math.ceil(this.shield)}`, 25, 110);
      }
    }

    const barX = 25;
    const barY = 118;
    const barWidth = width - 50;
    const barHeight = 30;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(barX, barY, barWidth, barHeight);
    ctx.strokeStyle = this.critical
      ? 'rgba(255, 90, 120, 0.8)'
      : 'rgba(90, 255, 215, 0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(barX + 1, barY + 1, barWidth - 2, barHeight - 2);

    const fillWidth = Math.max(0, (barWidth - 6) * ratio);
    if (fillWidth > 0) {
      const fill = ctx.createLinearGradient(barX, 0, barX + barWidth, 0);
      if (this.critical) {
        fill.addColorStop(0, '#ff1744');
        fill.addColorStop(1, '#ff7a8d');
      } else {
        fill.addColorStop(0, '#0bff9c');
        fill.addColorStop(0.6, '#3affc6');
        fill.addColorStop(1, '#8afff0');
      }
      ctx.fillStyle = fill;
      ctx.fillRect(barX + 3, barY + 3, fillWidth, barHeight - 6);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.32)';
      ctx.fillRect(barX + 3, barY + 3, fillWidth, 3);
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(2, 14, 18, 0.9)';
    ctx.lineWidth = 2;
    for (let segment = 1; segment < 10; segment += 1) {
      const x = barX + (barWidth / 10) * segment;
      ctx.beginPath();
      ctx.moveTo(x, barY + 3);
      ctx.lineTo(x, barY + barHeight - 3);
      ctx.stroke();
    }
    ctx.restore();

    this.drawFooter(ctx, width, height, '生命体征 // v1.1', '碰撞同步在线');
  }

  private drawSkills(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    this.drawBase(ctx, width, height, '#ffb347', '#14231f', '#060c10');

    ctx.textAlign = 'left';
    ctx.font = '700 20px "Microsoft YaHei", "Consolas", "Courier New", monospace';
    ctx.fillStyle = '#63ecff';
    ctx.fillText('技能执行', 24, 34);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffc46b';
    ctx.fillText(this.states.skills === 'loose' ? '诱饵' : '已连接', width - 24, 34);

    if (this.states.skills === 'loose') {
      ctx.textAlign = 'left';
      ctx.font = '700 42px "Microsoft YaHei", "Consolas", "Courier New", monospace';
      ctx.shadowColor = '#ff7a18';
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#ffd08a';
      ctx.fillText('磁力诱饵', 24, 118);
      ctx.shadowBlur = 0;
      ctx.font = '700 26px "Microsoft YaHei", "Consolas", "Courier New", monospace';
      ctx.fillStyle = '#ff8a5c';
      ctx.fillText(`引爆 ${Math.max(0, this.skillFuse).toFixed(1)} 秒`, 24, 162);
      ctx.font = '600 16px "Microsoft YaHei", "Consolas", "Courier New", monospace';
      ctx.fillStyle = 'rgba(255, 220, 180, 0.7)';
      ctx.fillText('敌人会被它吸引', 24, 198);
      ctx.fillText('射击 / 接触引爆', 24, 222);
      this.drawFooter(ctx, width, height, '技能 UI // 可投掷', '范围眩晕就绪');
      return;
    }

    const cards = [
      { key: 'SPACE', name: '冲刺', color: '#38f6ff' },
      { key: 'Q', name: '震荡波', color: '#ffb347' },
    ];
    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      const x = 24 + index * 256;
      const y = 78;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fillRect(x, y, 232, 118);
      ctx.strokeStyle = `${card.color}88`;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, 230, 116);
      ctx.font = '600 16px "Microsoft YaHei", "Consolas", "Courier New", monospace';
      ctx.fillStyle = card.color;
      ctx.fillText(card.key, x + 16, y + 28);
      ctx.font = '700 38px "Microsoft YaHei", "Consolas", "Courier New", monospace';
      ctx.fillStyle = '#eafff8';
      ctx.fillText(card.name, x + 16, y + 72);
      ctx.font = '600 14px "Microsoft YaHei", "Consolas", "Courier New", monospace';
      ctx.fillStyle = 'rgba(180, 240, 250, 0.62)';
      ctx.fillText('就绪', x + 16, y + 101);
    }
    this.drawFooter(ctx, width, height, '[F] 投掷 / [E] 召回', '脱落时技能锁定');
  }

  private drawScore(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    this.drawBase(ctx, width, height, '#ffb347', '#231607', '#080502');

    ctx.textAlign = 'left';
    ctx.font = '700 20px "Microsoft YaHei", "Consolas", "Courier New", monospace';
    ctx.fillStyle = '#ffc46b';
    ctx.fillText('分数 // 连击', 24, 32);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255, 210, 140, 0.75)';
    ctx.fillText(this.stats.stageText, width - 24, 32);

    ctx.textAlign = 'left';
    ctx.font = '700 48px "Microsoft YaHei", "Consolas", "Courier New", monospace';
    ctx.shadowColor = 'rgba(255, 160, 40, 0.55)';
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#fff2d6';
    ctx.fillText(Math.floor(this.stats.score).toString().padStart(6, '0'), 24, 94);
    ctx.shadowBlur = 0;

    ctx.font = '700 24px "Microsoft YaHei", "Consolas", "Courier New", monospace';
    ctx.fillStyle = '#ffd48a';
    ctx.fillText(`连击 x${this.stats.combo}   |   x${this.stats.multiplier.toFixed(1)}`, 24, 138);

    const barX = 24;
    const barY = 158;
    const barWidth = width - 48;
    ctx.fillStyle = 'rgba(255, 179, 71, 0.12)';
    ctx.fillRect(barX, barY, barWidth, 9);
    ctx.fillStyle = '#ffb347';
    ctx.fillRect(
      barX,
      barY,
      barWidth * Math.max(0, Math.min(1, this.stats.comboRatio)),
      9,
    );

    ctx.font = '600 14px "Microsoft YaHei", "Consolas", "Courier New", monospace';
    ctx.fillStyle = 'rgba(255, 216, 170, 0.6)';
    ctx.fillText(this.states.score === 'loose' ? '射击 / 冲刺 // 分数爆发' : '战斗记录', 24, height - 20);
    ctx.textAlign = 'right';
    ctx.fillText(`${this.stats.kills} 击杀`, width - 24, height - 20);

    if (this.states.score === 'loose') {
      ctx.textAlign = 'center';
      ctx.font = '700 16px "Microsoft YaHei", "Consolas", "Courier New", monospace';
      ctx.fillStyle = '#ff8a5c';
      ctx.fillText('高能缓存 // 免费开火', width / 2, 190);
    }
  }

  private drawPopup(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    title: string,
    body: string,
  ): void {
    this.drawBase(ctx, width, height, '#ff3b5c', '#23050c', '#0a0205');

    ctx.textAlign = 'left';
    ctx.font = '700 16px "Microsoft YaHei", "Consolas", "Courier New", monospace';
    ctx.fillStyle = '#ff8fa2';
    ctx.fillText('系统 // UI 故障', 24, 30);
    ctx.textAlign = 'right';
    ctx.fillText('0x00UI', width - 24, 30);

    ctx.textAlign = 'left';
    ctx.font = '700 34px "Microsoft YaHei", "Consolas", "Courier New", monospace';
    ctx.shadowColor = '#ff1744';
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#ff5c75';
    ctx.fillText(title, 24, 92);
    ctx.shadowBlur = 0;

    ctx.font = '600 17px "Microsoft YaHei", "Consolas", "Courier New", monospace';
    ctx.fillStyle = 'rgba(255, 205, 215, 0.8)';
    this.wrapText(ctx, body, 24, 132, width - 48, 26, 4);

    ctx.fillStyle = 'rgba(255, 80, 110, 0.22)';
    ctx.fillRect(24, height - 74, width - 48, 1);
    ctx.font = '700 15px "Microsoft YaHei", "Consolas", "Courier New", monospace';
    ctx.fillStyle = '#ff9aab';
    ctx.fillText('拖拽或射击 // 武器化', 24, height - 36);
  }

  private drawBase(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    accent: string,
    backgroundA: string,
    backgroundB: string,
  ): void {
    const background = ctx.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, backgroundA);
    background.addColorStop(0.65, '#04121a');
    background.addColorStop(1, backgroundB);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.strokeStyle = 'rgba(70, 235, 255, 0.07)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = accent;
    ctx.lineWidth = 5;
    ctx.strokeRect(3, 3, width - 6, height - 6);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(230, 255, 250, 0.55)';
    const bracket = 17;
    const inset = 11;
    ctx.beginPath();
    ctx.moveTo(inset, inset + bracket);
    ctx.lineTo(inset, inset);
    ctx.lineTo(inset + bracket, inset);
    ctx.moveTo(width - inset - bracket, inset);
    ctx.lineTo(width - inset, inset);
    ctx.lineTo(width - inset, inset + bracket);
    ctx.moveTo(width - inset, height - inset - bracket);
    ctx.lineTo(width - inset, height - inset);
    ctx.lineTo(width - inset - bracket, height - inset);
    ctx.moveTo(inset + bracket, height - inset);
    ctx.lineTo(inset, height - inset);
    ctx.lineTo(inset, height - inset - bracket);
    ctx.stroke();
  }

  private drawFooter(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    left: string,
    right: string,
  ): void {
    ctx.font = '600 14px "Microsoft YaHei", "Consolas", "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(110, 210, 225, 0.58)';
    ctx.fillText(left, 24, height - 12);
    ctx.textAlign = 'right';
    ctx.fillText(right, width - 24, height - 12);
  }

  private wrapText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number,
    maxLines: number,
  ): void {
    const words = text.split(' ');
    let line = '';
    let lineIndex = 0;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, y + lineIndex * lineHeight);
        line = word;
        lineIndex += 1;
        if (lineIndex >= maxLines) return;
      } else {
        line = test;
      }
    }
    if (line && lineIndex < maxLines) {
      ctx.fillText(line, x, y + lineIndex * lineHeight);
    }
  }
}
