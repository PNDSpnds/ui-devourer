import * as THREE from 'three';
import type { EnemyType } from '../entities/Enemy';
import type { SoundName } from './SoundSystem';

export type WavePhase = 'idle' | 'playing' | 'upgrade' | 'defeat';
export type Rarity = 'common' | 'rare' | 'epic';

export interface RunModifiers {
  fireInterval: number;
  bulletDamage: number;
  split: number;
  pellets: number;
  bulletPierce: number;
  critChance: number;
  gatling: boolean;
  twin: number;
  radialEvery: number;
  boomerang: boolean;
  homing: number;
  chain: number;
  hpDamage: number;
  hpCost: number;
  hpPierce: number;
  hpShots: number;
  hpExplode: boolean;
  hpLifesteal: number;
  dashCooldown: number;
  dashDamage: number;
  dashKillReset: boolean;
  dashTrail: boolean;
  novaCooldown: number;
  novaDamage: number;
  novaRadius: number;
  novaStun: number;
  novaDouble: boolean;
  uiImpact: number;
  recallNova: boolean;
  recallShield: number;
  scoreBurstBonus: number;
  maxHpBonus: number;
  comboDecay: number;
  comboCap: number;
  orbRadius: number;
  orbValueBonus: number;
  killHeal: number;
}

export interface WaveStats {
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

export interface FinalStats {
  score: number;
  kills: number;
  maxCombo: number;
  reclaims: number;
  lost: number;
  cycle: number;
  stage: number;
}

export interface UpgradeDef {
  id: string;
  title: string;
  description: string;
  tag: string;
  rarity: Rarity;
  unique?: boolean;
  heal?: number;
  apply: (mods: RunModifiers) => void;
}

export interface WaveHooks {
  onSpawnChaser: (position: THREE.Vector3, power: number) => void;
  onSpawnBoss: (type: EnemyType, position: THREE.Vector3, power: number) => void;
  onStageStart: (cycle: number, stage: number, title: string, isBoss: boolean) => void;
  onStageCleared: (cycle: number, stage: number, isBoss: boolean) => void;
  onUpgradeChoices: (choices: UpgradeDef[], isBoss: boolean) => void;
  onUpgradeApplied: (upgrade: UpgradeDef, mods: RunModifiers) => void;
  onDefeat: (stats: FinalStats) => void;
  onSound: (name: SoundName) => void;
}

const SMALL_STAGES = 5;
const BOSS_STAGE = 6;
const COMBO_WINDOW = 3.6;
const STAGE_TITLES = ['握手协议', '内存泄漏', '内核恐慌', '界面撕裂', '最终写入'];

function createDefaultModifiers(): RunModifiers {
  return {
    fireInterval: 0.15,
    bulletDamage: 30,
    split: 0,
    pellets: 0,
    bulletPierce: 0,
    critChance: 0.05,
    gatling: false,
    twin: 0,
    radialEvery: 0,
    boomerang: false,
    homing: 0,
    chain: 0,
    hpDamage: 100,
    hpCost: 4,
    hpPierce: 3,
    hpShots: 1,
    hpExplode: false,
    hpLifesteal: 0,
    dashCooldown: 2.5,
    dashDamage: 55,
    dashKillReset: false,
    dashTrail: false,
    novaCooldown: 6.5,
    novaDamage: 75,
    novaRadius: 5.5,
    novaStun: 1.2,
    novaDouble: false,
    uiImpact: 1,
    recallNova: false,
    recallShield: 8,
    scoreBurstBonus: 300,
    maxHpBonus: 0,
    comboDecay: 1,
    comboCap: 5,
    orbRadius: 1.3,
    orbValueBonus: 0,
    killHeal: 0,
  };
}

const UPGRADE_POOL: UpgradeDef[] = [
  {
    id: 'ui_overload',
    title: 'UI 过载',
    description: '脱落的 UI 碰撞伤害 +60%。把技能栏和计分牌当武器砸出去。',
    tag: '物理 UI',
    rarity: 'common',
    apply: (mods) => {
      mods.uiImpact += 0.6;
    },
  },
  {
    id: 'magnet_recall',
    title: '磁力召回',
    description: '按 E 召回 UI 时，在玩家周围引发范围击飞与伤害。',
    tag: '物理 UI',
    rarity: 'rare',
    unique: true,
    apply: (mods) => {
      mods.recallNova = true;
    },
  },
  {
    id: 'high_frequency',
    title: '高频写入',
    description: '射击间隔 -22%，每次射击额外 +1 枚分裂弹。',
    tag: '射击',
    rarity: 'rare',
    apply: (mods) => {
      mods.fireInterval = Math.max(0.06, mods.fireInterval * 0.78);
      mods.split += 1;
    },
  },
  {
    id: 'shield_protocol',
    title: '护盾协议',
    description: '生命上限 +20，立即回复 35 生命。',
    tag: '生存',
    rarity: 'common',
    heal: 35,
    apply: (mods) => {
      mods.maxHpBonus += 20;
    },
  },
  {
    id: 'overclock_dash',
    title: '过载冲刺',
    description: '冲刺冷却 -35%，冲刺撞击伤害 +50%。',
    tag: '冲刺',
    rarity: 'common',
    apply: (mods) => {
      mods.dashCooldown *= 0.65;
      mods.dashDamage *= 1.5;
    },
  },
  {
    id: 'static_nova',
    title: '界面静电',
    description: '震荡波半径与伤害 +25%，眩晕时间 +0.4 秒。',
    tag: '技能',
    rarity: 'common',
    apply: (mods) => {
      mods.novaRadius *= 1.25;
      mods.novaDamage *= 1.25;
      mods.novaStun += 0.4;
    },
  },
  {
    id: 'crit_write',
    title: '暴击写入',
    description: '子弹暴击率 +20%。暴击造成双倍伤害。',
    tag: '射击',
    rarity: 'common',
    apply: (mods) => {
      mods.critChance = Math.min(0.85, mods.critChance + 0.2);
    },
  },
  {
    id: 'combo_cache',
    title: '连击缓存',
    description: '连击衰减速度 -30%，连击倍率上限 +1.0。',
    tag: '经济',
    rarity: 'rare',
    apply: (mods) => {
      mods.comboDecay *= 0.7;
      mods.comboCap += 1;
    },
  },
  {
    id: 'repair_protocol',
    title: '修复协议',
    description: '立即回复 40 生命。低血量时的紧急写入。',
    tag: '生存',
    rarity: 'common',
    heal: 40,
    apply: () => {
      // Heal is applied by the run callback.
    },
  },
  {
    id: 'gatling_protocol',
    title: '加特林协议',
    description: '按住左键持续射击；射速随按住时间逐渐提升。史诗武器形态。',
    tag: '武器',
    rarity: 'epic',
    unique: true,
    apply: (mods) => {
      mods.gatling = true;
      mods.fireInterval = Math.min(mods.fireInterval, 0.12);
    },
  },
  {
    id: 'shotgun_protocol',
    title: '霰弹写入',
    description: '每次射击额外发射 4 枚扇形弹丸，单发伤害略降但近距离爆发极高。',
    tag: '武器',
    rarity: 'rare',
    apply: (mods) => {
      mods.pellets += 4;
      mods.bulletDamage *= 1.15;
      mods.fireInterval *= 1.12;
    },
  },
  {
    id: 'railgun_protocol',
    title: '磁轨穿透',
    description: '普通子弹获得穿透 +2，单发伤害 +35%，射速略降。',
    tag: '武器',
    rarity: 'epic',
    apply: (mods) => {
      mods.bulletPierce += 2;
      mods.bulletDamage *= 1.35;
      mods.fireInterval *= 1.15;
    },
  },
  {
    id: 'hp_overload',
    title: '血条过载',
    description: '血条炮单发伤害 +50。消耗生命换来更夸张的爆发。',
    tag: '血条炮',
    rarity: 'epic',
    apply: (mods) => {
      mods.hpDamage += 50;
    },
  },
  {
    id: 'hp_pierce',
    title: '血条穿透',
    description: '血条炮额外穿透 2 个目标。',
    tag: '血条炮',
    rarity: 'rare',
    apply: (mods) => {
      mods.hpPierce += 2;
    },
  },
  {
    id: 'hp_efficiency',
    title: '血条高效',
    description: '血条炮每发少消耗 1 点生命。',
    tag: '血条炮',
    rarity: 'rare',
    unique: true,
    apply: (mods) => {
      mods.hpCost = Math.max(1, mods.hpCost - 1);
    },
  },
  {
    id: 'hp_explosive',
    title: '血条爆裂',
    description: '血条炮命中时引发一次小范围爆炸，对周围敌人造成伤害。',
    tag: '血条炮',
    rarity: 'epic',
    unique: true,
    apply: (mods) => {
      mods.hpExplode = true;
    },
  },
  {
    id: 'hp_twin',
    title: '双持血条',
    description: '每次血条炮额外发射一条并排弹道。',
    tag: '血条炮',
    rarity: 'rare',
    apply: (mods) => {
      mods.hpShots += 1;
    },
  },
  {
    id: 'hp_lifesteal',
    title: '生命虹吸',
    description: '血条炮每命中一个敌人回复 2 点生命。',
    tag: '血条炮',
    rarity: 'rare',
    apply: (mods) => {
      mods.hpLifesteal += 2;
    },
  },
  {
    id: 'hp_reserve',
    title: '生命储备',
    description: '生命上限 +30，立即回复 30 生命。',
    tag: '生存',
    rarity: 'common',
    heal: 30,
    apply: (mods) => {
      mods.maxHpBonus += 30;
    },
  },
  {
    id: 'dash_charge',
    title: '冲刺充能',
    description: '冲刺撞死敌人时立刻重置冲刺冷却。',
    tag: '冲刺',
    rarity: 'rare',
    unique: true,
    apply: (mods) => {
      mods.dashKillReset = true;
    },
  },
  {
    id: 'dash_echo',
    title: '冲刺残影',
    description: '冲刺开始时在起点释放一次小型冲击波。',
    tag: '冲刺',
    rarity: 'rare',
    unique: true,
    apply: (mods) => {
      mods.dashTrail = true;
    },
  },
  {
    id: 'nova_chain',
    title: '震荡连锁',
    description: '震荡波在 0.45 秒后释放第二段，半径略小。',
    tag: '技能',
    rarity: 'epic',
    unique: true,
    apply: (mods) => {
      mods.novaDouble = true;
    },
  },
  {
    id: 'dominator',
    title: '界面磁暴',
    description: '震荡波半径 +20%，眩晕时间 +0.3 秒。',
    tag: '技能',
    rarity: 'rare',
    apply: (mods) => {
      mods.novaRadius *= 1.2;
      mods.novaStun += 0.3;
      mods.novaDamage *= 1.1;
    },
  },
  {
    id: 'score_gambler',
    title: '计分赌徒',
    description: '击碎计分牌时额外获得 200 分。',
    tag: '经济',
    rarity: 'rare',
    apply: (mods) => {
      mods.scoreBurstBonus += 200;
    },
  },
  {
    id: 'recall_barrier',
    title: '回收屏障',
    description: '召回 UI 时获得的护盾 +8。',
    tag: '物理 UI',
    rarity: 'common',
    apply: (mods) => {
      mods.recallShield += 8;
    },
  },
  {
    id: 'orb_magnet',
    title: '能量磁铁',
    description: '能量球拾取范围 +1.2，回复量 +4。',
    tag: '经济',
    rarity: 'common',
    apply: (mods) => {
      mods.orbRadius += 1.2;
      mods.orbValueBonus += 4;
    },
  },
  {
    id: 'vampire_rounds',
    title: '吸血写入',
    description: '每次击杀回复 2 点生命。',
    tag: '生存',
    rarity: 'rare',
    apply: (mods) => {
      mods.killHeal += 2;
    },
  },
  {
    id: 'glass_cannon',
    title: '玻璃大炮',
    description: '子弹伤害 +60%，但生命上限 -15。',
    tag: '武器',
    rarity: 'epic',
    apply: (mods) => {
      mods.bulletDamage *= 1.6;
      mods.maxHpBonus -= 15;
    },
  },
  {
    id: 'overclock_fire',
    title: '超频枪管',
    description: '射击间隔 -15%，子弹伤害 +20%。',
    tag: '射击',
    rarity: 'rare',
    apply: (mods) => {
      mods.fireInterval *= 0.85;
      mods.bulletDamage *= 1.2;
    },
  },
  {
    id: 'execution',
    title: '处决协议',
    description: '暴击率 +15%。配合高射速武器可以打出密集暴击。',
    tag: '射击',
    rarity: 'rare',
    apply: (mods) => {
      mods.critChance = Math.min(0.9, mods.critChance + 0.15);
    },
  },
  {
    id: 'twin_write',
    title: '双管写入',
    description: '每次射击变成两道并排弹道，弹道数量 +1。',
    tag: '射击',
    rarity: 'rare',
    apply: (mods) => {
      mods.twin += 1;
    },
  },
  {
    id: 'radial_protocol',
    title: '环切协议',
    description: '每第 6 次射击额外释放一圈 10 发环形弹幕。',
    tag: '射击',
    rarity: 'epic',
    unique: true,
    apply: (mods) => {
      mods.radialEvery = 6;
    },
  },
  {
    id: 'boomerang_protocol',
    title: '回旋写入',
    description: '子弹飞行 0.45 秒后掉头返回，回程可以再次命中敌人。',
    tag: '射击',
    rarity: 'rare',
    unique: true,
    apply: (mods) => {
      mods.boomerang = true;
    },
  },
  {
    id: 'homing_protocol',
    title: '追踪写入',
    description: '子弹会缓慢追踪最近的敌人。',
    tag: '射击',
    rarity: 'epic',
    unique: true,
    apply: (mods) => {
      mods.homing = Math.max(mods.homing, 1.3);
    },
  },
  {
    id: 'chain_protocol',
    title: '连锁电弧',
    description: '子弹命中时向附近最多 2 个敌人传导 35% 伤害。',
    tag: '射击',
    rarity: 'epic',
    apply: (mods) => {
      mods.chain += 2;
    },
  },
];

/**
 * Infinite run state: five small stages followed by a boss stage, repeating.
 * Every stage grants a 3-choice upgrade; boss stages guarantee rare/epic cards.
 */
export class WaveSystem {
  phase: WavePhase = 'idle';
  cycle = 1;
  stage = 1;

  private readonly hooks: WaveHooks;
  private readonly mods: RunModifiers = createDefaultModifiers();
  private readonly stats = {
    score: 0,
    kills: 0,
    maxCombo: 0,
    reclaims: 0,
    lost: 0,
  };

  private combo = 0;
  private comboTime = 0;
  private comboTimerMax = COMBO_WINDOW;
  private spawnTimer = 0;
  private bossTimer = 0;
  private guardTimer = 0;
  private chasersSpawned = 0;
  private chaserTarget = 0;
  private guardsSpawned = 0;
  private guardTarget = 0;
  private bossSpawned = false;
  private upgradeChoices: UpgradeDef[] = [];
  private chosenUpgrades: string[] = [];

  constructor(hooks: WaveHooks) {
    this.hooks = hooks;
  }

  start(): void {
    Object.assign(this.mods, createDefaultModifiers());
    this.cycle = 1;
    this.stage = 1;
    this.phase = 'playing';
    this.stats.score = 0;
    this.stats.kills = 0;
    this.stats.maxCombo = 0;
    this.stats.reclaims = 0;
    this.stats.lost = 0;
    this.combo = 0;
    this.comboTime = 0;
    this.upgradeChoices = [];
    this.chosenUpgrades = [];
    this.beginStage();
  }

  update(delta: number, aliveCount: number, bossAlive: boolean): void {
    if (this.phase !== 'playing') return;

    if (this.comboTime > 0) {
      this.comboTime = Math.max(0, this.comboTime - delta);
      if (this.comboTime <= 0) this.combo = 0;
    }

    if (this.stage === BOSS_STAGE) {
      this.updateBossStage(delta, aliveCount, bossAlive);
    } else {
      this.updateSmallStage(delta, aliveCount);
    }
  }

  registerKill(type: EnemyType): void {
    this.combo += 1;
    this.stats.maxCombo = Math.max(this.stats.maxCombo, this.combo);
    this.comboTime = this.comboTimerMax;
    this.stats.kills += 1;

    const multiplier = this.getMultiplier();
    const base = type === 'chaser' ? 120 : type === 'node' ? 1000 : 1700;
    const depth = 1 + (this.cycle - 1) * 0.18 + (this.stage - 1) * 0.04;
    this.stats.score += Math.round(base * multiplier * depth);
  }

  registerReclaim(count = 1): void {
    this.stats.reclaims += count;
  }

  registerLost(count = 1): void {
    this.stats.lost += count;
  }

  addScore(amount: number): void {
    this.stats.score += Math.max(0, Math.round(amount));
  }

  breakCombo(): void {
    this.combo = 0;
    this.comboTime = 0;
  }

  fail(): void {
    if (this.phase === 'defeat') return;
    this.phase = 'defeat';
    this.hooks.onDefeat(this.getFinalStats());
  }

  chooseUpgrade(index: number): UpgradeDef | null {
    if (this.phase !== 'upgrade') return null;
    const choice = this.upgradeChoices[index];
    if (!choice) return null;

    choice.apply(this.mods);
    this.chosenUpgrades.push(choice.id);
    this.upgradeChoices = [];
    this.hooks.onUpgradeApplied(choice, this.mods);

    if (this.stage >= BOSS_STAGE) {
      this.cycle += 1;
      this.stage = 1;
    } else {
      this.stage += 1;
    }
    this.beginStage();
    return choice;
  }

  getStats(): WaveStats {
    return {
      ...this.stats,
      combo: this.combo,
      multiplier: this.getMultiplier(),
      cycle: this.cycle,
      stage: this.stage,
      stageText: this.getStageText(),
      isBoss: this.stage === BOSS_STAGE,
      comboRatio: this.comboTimerMax > 0 ? this.comboTime / this.comboTimerMax : 0,
    };
  }

  getFinalStats(): FinalStats {
    return {
      score: this.stats.score,
      kills: this.stats.kills,
      maxCombo: this.stats.maxCombo,
      reclaims: this.stats.reclaims,
      lost: this.stats.lost,
      cycle: this.cycle,
      stage: this.stage,
    };
  }

  getModifiers(): RunModifiers {
    return this.mods;
  }

  getUpgradeChoices(): UpgradeDef[] {
    return this.upgradeChoices;
  }

  getChosenUpgrades(): string[] {
    return this.chosenUpgrades;
  }

  isPlaying(): boolean {
    return this.phase === 'playing';
  }

  private beginStage(): void {
    this.phase = 'playing';
    this.chasersSpawned = 0;
    this.guardsSpawned = 0;
    this.bossSpawned = false;
    this.spawnTimer = 2.2;
    this.bossTimer = 1.2;
    this.guardTimer = 2.2;
    this.combo = 0;
    this.comboTime = 0;
    this.comboTimerMax = COMBO_WINDOW * this.mods.comboDecay;

    if (this.stage === BOSS_STAGE) {
      this.chaserTarget = 0;
      this.guardTarget = 2 + Math.min(2, this.cycle - 1);
    } else {
      this.chaserTarget = 2 + this.stage + Math.min(4, this.cycle - 1);
      this.guardTarget = 0;
    }

    const title =
      this.stage === BOSS_STAGE
        ? `吞噬者首领 // 第 ${this.cycle} 循环`
        : STAGE_TITLES[this.stage - 1];
    this.hooks.onStageStart(this.cycle, this.stage, title, this.stage === BOSS_STAGE);
    this.hooks.onSound('wave');
  }

  private updateSmallStage(delta: number, aliveCount: number): void {
    const maxAlive = Math.min(6, 2 + this.stage + Math.floor(this.cycle / 2));
    let spawnedThisFrame = false;
    if (this.chasersSpawned < this.chaserTarget && aliveCount < maxAlive) {
      this.spawnTimer -= delta;
      if (this.spawnTimer <= 0) {
        this.hooks.onSpawnChaser(this.randomSpawnPoint(), this.getPower());
        this.chasersSpawned += 1;
        spawnedThisFrame = true;
        this.spawnTimer = Math.max(0.8, 1.8 - this.stage * 0.08 - this.cycle * 0.03);
      }
    }

    if (spawnedThisFrame) return;
    if (this.chasersSpawned < this.chaserTarget || aliveCount > 0) return;
    this.clearStage();
  }

  private updateBossStage(delta: number, aliveCount: number, bossAlive: boolean): void {
    if (!this.bossSpawned) {
      this.bossTimer -= delta;
      if (this.bossTimer <= 0) {
        this.bossSpawned = true;
        const type: EnemyType = this.cycle === 1 ? 'node' : 'prime';
        const position = new THREE.Vector3(
          (Math.random() - 0.5) * 6,
          0,
          -5 + (Math.random() - 0.5) * 2,
        );
        this.hooks.onSpawnBoss(type, position, this.getPower() + 1);
      }
      return;
    }

    let spawnedGuard = false;
    if (this.guardsSpawned < this.guardTarget && aliveCount < 4) {
      this.guardTimer -= delta;
      if (this.guardTimer <= 0) {
        this.hooks.onSpawnChaser(this.randomSpawnPoint(), this.getPower());
        this.guardsSpawned += 1;
        this.guardTimer = 2.6;
        spawnedGuard = true;
      }
    }

    if (spawnedGuard) return;
    if (this.guardsSpawned < this.guardTarget) return;
    if (bossAlive || aliveCount > 0) return;
    this.clearStage();
  }

  private clearStage(): void {
    this.phase = 'upgrade';
    this.hooks.onStageCleared(this.cycle, this.stage, this.stage === BOSS_STAGE);
    this.offerUpgrades();
  }

  private offerUpgrades(): void {
    const boss = this.stage === BOSS_STAGE;
    const owned = new Set(this.chosenUpgrades);
    let pool = UPGRADE_POOL.filter((card) => !(card.unique && owned.has(card.id)));
    if (this.mods.critChance >= 0.9) {
      pool = pool.filter((card) => card.id !== 'crit_write' && card.id !== 'execution');
    }
    if (pool.length < 3) pool = [...UPGRADE_POOL];
    if (boss) {
      const highTier = pool.filter((card) => card.rarity !== 'common');
      if (highTier.length >= 3) pool = highTier;
    }

    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [pool[index], pool[swap]] = [pool[swap], pool[index]];
    }

    this.upgradeChoices = pool.slice(0, 3);
    this.hooks.onUpgradeChoices(this.upgradeChoices, boss);
  }

  private getMultiplier(): number {
    const raw = 1 + Math.floor(this.combo / 5) * 0.5;
    return Math.min(this.mods.comboCap, raw);
  }

  private getPower(): number {
    return this.cycle + (this.stage - 1) * 0.15;
  }

  private getStageText(): string {
    if (this.stage === BOSS_STAGE) return `第 ${this.cycle} 循环 // 首领关`;
    return `第 ${this.cycle} 循环 // 小关 ${this.stage}/${SMALL_STAGES}`;
  }

  private randomSpawnPoint(): THREE.Vector3 {
    const side = Math.floor(Math.random() * 4);
    const lateral = (Math.random() * 2 - 1) * 8.5;
    const edge = 10.4;
    if (side === 0) return new THREE.Vector3(-edge, 0, lateral);
    if (side === 1) return new THREE.Vector3(edge, 0, lateral);
    if (side === 2) return new THREE.Vector3(lateral, 0, -edge);
    return new THREE.Vector3(lateral, 0, edge);
  }
}
