import type { UIKind, UIPanelState } from '../entities/UIEntityManager';

export interface HudFrame {
  hp: number;
  maxHp: number;
  shield: number;
  score: number;
  combo: number;
  multiplier: number;
  comboRatio: number;
  stageText: string;
  kills: number;
  dashCooldown: number;
  dashMax: number;
  novaCooldown: number;
  novaMax: number;
  skillsUsable: boolean;
  skillState: string;
}

export interface UpgradeChoice {
  id: string;
  title: string;
  description: string;
  tag: string;
}

export interface ResultStats {
  score: number;
  kills: number;
  maxCombo: number;
  reclaims: number;
  lost: number;
  cycle: number;
  stage: number;
}

export interface PopupAction {
  x: number;
  y: number;
  dragged: boolean;
  title: string;
  body: string;
}

interface PopupCard {
  element: HTMLDivElement;
  timeout: number;
  cleanup?: () => void;
}

const POPUP_TITLES = [
  '警告：内存泄漏',
  '需要打补丁',
  '致命：界面失联',
  '系统溢出',
  '错误：0x00UI',
  '内核恐慌',
];

const POPUP_BODIES = [
  '一个野指针逃出了渲染循环。它看起来饿了。',
  '你的界面现在有 37% 不合法。继续？',
  '生命条已对你的瞄准提出投诉。',
  '现实缓冲区溢出。请减少维度数量。',
  '一个 UI 组件学会了咬人。保修不覆盖此项。',
  '正在修补玩家。补丁失败得很成功。',
];

function getElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少必需的 HUD 元素：#${id}`);
  return element as T;
}

/**
 * All DOM-side HUD work: docked panels, wave banners, boss bar, system popups,
 * upgrade cards, result screens, glitch overlays and the mute control.
 */
export class HudOverlay {
  onMuteToggle?: () => void;
  onPopupAction?: (action: PopupAction) => void;
  onUpgradePick?: (index: number) => void;
  onRestart?: () => void;

  private readonly healthPanel: HTMLElement;
  private readonly healthReadout: HTMLElement;
  private readonly healthFill: HTMLElement;
  private readonly healthState: HTMLElement;
  private readonly hpWeaponReadout: HTMLElement;
  private readonly hudSync: HTMLElement;
  private readonly shieldRow: HTMLElement;
  private readonly shieldValue: HTMLElement;

  private readonly scorePanel: HTMLElement;
  private readonly scoreValue: HTMLElement;
  private readonly comboValue: HTMLElement;
  private readonly comboMult: HTMLElement;
  private readonly comboFill: HTMLElement;
  private readonly scoreWave: HTMLElement;
  private readonly scoreKills: HTMLElement;

  private readonly skillPanel: HTMLElement;
  private readonly skillState: HTMLElement;
  private readonly skillDash: HTMLElement;
  private readonly skillNova: HTMLElement;
  private readonly dashCooldown: HTMLElement;
  private readonly novaCooldown: HTMLElement;
  private readonly dashProgress: HTMLElement;
  private readonly novaProgress: HTMLElement;

  private readonly bossPanel: HTMLElement;
  private readonly bossName: HTMLElement;
  private readonly bossFill: HTMLElement;
  private readonly bossHp: HTMLElement;

  private readonly waveBanner: HTMLElement;
  private readonly waveTitle: HTMLElement;
  private readonly waveSub: HTMLElement;
  private readonly detachedBadge: HTMLElement;
  private readonly detachedLabel: HTMLElement;
  private readonly muteButton: HTMLButtonElement;

  private readonly popupLayer: HTMLElement;
  private readonly toastLayer: HTMLElement;
  private readonly glitchOverlay: HTMLElement;
  private readonly glitchLabel: HTMLElement;
  private readonly damageVignette: HTMLElement;

  private readonly upgradeModal: HTMLElement;
  private readonly upgradeOptions: HTMLElement;
  private readonly resultModal: HTMLElement;
  private readonly resultTitle: HTMLElement;
  private readonly resultSub: HTMLElement;
  private readonly resultStats: HTMLElement;
  private readonly restartButton: HTMLButtonElement;
  private readonly panelWarningTimers = new Map<UIKind, number>();

  private upgradeChoices: UpgradeChoice[] = [];
  private upgradePicked = false;
  private popups: PopupCard[] = [];
  private waveBannerTimer = 0;
  private glitchTimer = 0;
  private damageTimer = 0;
  private scoreShakeTimer = 0;
  private muted = false;

  constructor() {
    this.healthPanel = getElement('health-panel');
    this.healthReadout = getElement('health-readout');
    this.healthFill = getElement('health-fill');
    this.healthState = getElement('health-state');
    this.hpWeaponReadout = getElement('hp-weapon-readout');
    this.hudSync = getElement('hud-sync');
    this.shieldRow = getElement('shield-row');
    this.shieldValue = getElement('shield-value');

    this.scorePanel = getElement('score-panel');
    this.scoreValue = getElement('score-value');
    this.comboValue = getElement('combo-value');
    this.comboMult = getElement('combo-mult');
    this.comboFill = getElement('combo-fill');
    this.scoreWave = getElement('score-wave');
    this.scoreKills = getElement('score-kills');

    this.skillPanel = getElement('skill-panel');
    this.skillState = getElement('skill-state');
    this.skillDash = getElement('skill-dash');
    this.skillNova = getElement('skill-nova');
    this.dashCooldown = getElement('dash-cd');
    this.novaCooldown = getElement('nova-cd');
    this.dashProgress = getElement('dash-progress');
    this.novaProgress = getElement('nova-progress');

    this.bossPanel = getElement('boss-panel');
    this.bossName = getElement('boss-name');
    this.bossFill = getElement('boss-fill');
    this.bossHp = getElement('boss-hp');

    this.waveBanner = getElement('wave-banner');
    this.waveTitle = getElement('wave-title');
    this.waveSub = getElement('wave-sub');
    this.detachedBadge = getElement('detached-badge');
    this.detachedLabel = getElement('detached-label');
    this.muteButton = getElement<HTMLButtonElement>('mute-button');

    this.popupLayer = getElement('popup-layer');
    this.toastLayer = getElement('toast-layer');
    this.glitchOverlay = getElement('glitch-overlay');
    this.glitchLabel = getElement('glitch-label');
    this.damageVignette = getElement('damage-vignette');

    this.upgradeModal = getElement('upgrade-modal');
    this.upgradeOptions = getElement('upgrade-options');
    this.resultModal = getElement('result-modal');
    this.resultTitle = getElement('result-title');
    this.resultSub = getElement('result-sub');
    this.resultStats = getElement('result-stats');
    this.restartButton = getElement<HTMLButtonElement>('restart-button');

    this.muteButton.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.muteButton.addEventListener('contextmenu', (event) => event.preventDefault());
    this.muteButton.addEventListener('click', () => this.onMuteToggle?.());

    this.restartButton.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.restartButton.addEventListener('click', () => this.onRestart?.());

    this.upgradeModal.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.resultModal.addEventListener('pointerdown', (event) => event.stopPropagation());
  }

  update(frame: HudFrame): void {
    const ratio = Math.max(0, Math.min(1, frame.hp / frame.maxHp));
    const dead = frame.hp <= 0;
    this.healthReadout.textContent = dead
      ? '生命信号中断'
      : `生命：${Math.ceil(frame.hp)} / ${frame.maxHp}`;
    this.healthFill.style.width = `${(ratio * 100).toFixed(1)}%`;
    this.healthPanel.classList.toggle('critical', dead);
    this.healthState.textContent = dead ? '生命信号中断' : frame.hp <= 30 ? '不稳定' : '稳定';
    this.hpWeaponReadout.textContent = `生命：${Math.ceil(frame.hp)} / ${frame.maxHp}`;
    this.hudSync.textContent = `同步 ${Math.round(ratio * 100)
      .toString()
      .padStart(3, '0')}%`;

    if (frame.shield > 0.5) {
      this.shieldRow.classList.add('is-visible');
      this.shieldValue.textContent = `护盾 ${Math.ceil(frame.shield)}`;
    } else {
      this.shieldRow.classList.remove('is-visible');
    }

    this.scoreValue.textContent = Math.floor(frame.score)
      .toString()
      .padStart(6, '0');
    this.comboValue.textContent = `连击 x${frame.combo}`;
    this.comboMult.textContent = `x${frame.multiplier.toFixed(1)}`;
    this.comboFill.style.width = `${Math.max(0, Math.min(1, frame.comboRatio)) * 100}%`;
    this.scoreWave.textContent = frame.stageText;
    this.scoreKills.textContent = `${frame.kills} 击杀`;

    this.skillState.textContent = frame.skillState;
    this.skillPanel.classList.toggle('is-disabled', !frame.skillsUsable);
    this.updateSkillSlot(
      this.skillDash,
      this.dashCooldown,
      this.dashProgress,
      frame.dashCooldown,
      frame.dashMax,
    );
    this.updateSkillSlot(
      this.skillNova,
      this.novaCooldown,
      this.novaProgress,
      frame.novaCooldown,
      frame.novaMax,
    );
  }

  setPanelState(kind: UIKind, state: UIPanelState): void {
    const element = this.panelFor(kind);
    element.classList.toggle('is-hidden', state === 'loose' || state === 'held');
    element.classList.toggle('is-stolen', state === 'carried');
  }

  setDetachedCount(count: number): void {
    this.detachedBadge.classList.toggle('is-visible', count > 0);
    this.detachedLabel.textContent =
      count > 1 ? `UI 实体 // ${count} 个脱落` : 'UI 实体 // 已脱落';
  }

  setWaveBanner(title: string, subtitle: string): void {
    this.waveTitle.textContent = title;
    this.waveSub.textContent = subtitle;
    this.waveBanner.classList.add('is-visible');
    window.clearTimeout(this.waveBannerTimer);
    this.waveBannerTimer = window.setTimeout(() => {
      this.waveBanner.classList.remove('is-visible');
    }, 2400);
  }

  showBoss(name: string, hp: number, maxHp: number): void {
    this.bossName.textContent = name;
    this.bossPanel.classList.add('is-visible');
    this.updateBoss(hp, maxHp);
  }

  updateBoss(hp: number, maxHp: number): void {
    const ratio = Math.max(0, Math.min(1, hp / maxHp));
    this.bossFill.style.width = `${(ratio * 100).toFixed(1)}%`;
    this.bossHp.textContent = `${Math.ceil(hp)} / ${maxHp}`;
  }

  hideBoss(): void {
    this.bossPanel.classList.remove('is-visible');
  }

  showUpgrade(choices: UpgradeChoice[], onPick: (index: number) => void): void {
    this.upgradeChoices = choices;
    this.upgradePicked = false;
    this.onUpgradePick = onPick;
    this.upgradeOptions.replaceChildren();

    choices.forEach((choice, index) => {
      const card = document.createElement('button');
      card.className = 'upgrade-choice';
      card.type = 'button';
      card.dataset.index = String(index);
      card.setAttribute('data-ui-interactive', 'true');

      const tag = document.createElement('span');
      tag.className = 'upgrade-tag';
      tag.textContent = choice.tag;

      const title = document.createElement('span');
      title.className = 'upgrade-title';
      title.textContent = choice.title;

      const description = document.createElement('span');
      description.className = 'upgrade-desc';
      description.textContent = choice.description;

      const key = document.createElement('span');
      key.className = 'upgrade-key';
      key.textContent = `[${index + 1}]`;

      card.append(tag, title, description, key);
      card.addEventListener('pointerdown', (event) => event.stopPropagation());
      card.addEventListener('click', () => this.pickUpgrade(index));
      this.upgradeOptions.append(card);
    });

    this.upgradeModal.classList.add('is-visible');
  }

  pickUpgrade(index: number): void {
    if (this.upgradePicked) return;
    if (index < 0 || index >= this.upgradeChoices.length) return;
    this.upgradePicked = true;

    const cards = this.upgradeOptions.querySelectorAll<HTMLElement>('.upgrade-choice');
    cards.forEach((card, cardIndex) => {
      card.classList.toggle('is-picked', cardIndex === index);
      card.classList.add('is-locked');
    });

    this.onUpgradePick?.(index);
  }

  hideUpgrade(): void {
    this.upgradeModal.classList.remove('is-visible');
    this.upgradeChoices = [];
    this.upgradePicked = false;
  }

  showResult(victory: boolean, stats: ResultStats): void {
    this.resultModal.classList.toggle('is-victory', victory);
    this.resultModal.classList.toggle('is-defeat', !victory);
    this.resultTitle.textContent = victory ? '系统覆写 // 清场' : '生命信号中断';
    this.resultSub.textContent = victory
      ? '你吞掉了最后一个界面。竞技场暂时安静。'
      : '界面反噬了你。所有界面均已离线。';

    const rows = [
      ['总分', Math.floor(stats.score).toLocaleString('zh-CN')],
      ['击杀数', String(stats.kills)],
      ['最高连击', `x${stats.maxCombo}`],
      ['UI 夺回', String(stats.reclaims)],
      ['UI 失守', String(stats.lost)],
      ['最深循环', `${stats.cycle}`],
      ['到达小关', stats.stage >= 6 ? '首领关' : `${stats.stage}/5`],
    ];

    this.resultStats.replaceChildren();
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      row.className = 'result-row';
      const key = document.createElement('span');
      key.textContent = label;
      const val = document.createElement('strong');
      val.textContent = value;
      row.append(key, val);
      this.resultStats.append(row);
    }

    this.resultModal.classList.add('is-visible');
    this.hideUpgrade();
    this.clearPopups();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.muteButton.textContent = muted ? '[ 声音：关 ]' : '[ 声音：开 ]';
    this.muteButton.classList.toggle('is-muted', muted);
  }

  toast(text: string, tone: 'info' | 'warn' | 'error' = 'info'): void {
    const item = document.createElement('div');
    item.className = `toast toast-${tone}`;
    item.textContent = text;
    this.toastLayer.append(item);
    while (this.toastLayer.childElementCount > 5) {
      this.toastLayer.firstElementChild?.remove();
    }
    window.setTimeout(() => item.remove(), 2600);
  }

  glitch(strength = 1, label = '信号损坏'): void {
    this.glitchOverlay.style.setProperty('--glitch-strength', String(Math.min(2, strength)));
    this.glitchLabel.textContent = label;
    this.glitchOverlay.classList.add('is-active');
    window.clearTimeout(this.glitchTimer);
    this.glitchTimer = window.setTimeout(() => {
      this.glitchOverlay.classList.remove('is-active');
    }, 260 + strength * 180);
  }

  damageFlash(strength = 1): void {
    this.damageVignette.style.setProperty('--hit-strength', String(Math.min(1.5, strength)));
    this.damageVignette.classList.add('is-hit');
    window.clearTimeout(this.damageTimer);
    this.damageTimer = window.setTimeout(() => {
      this.damageVignette.classList.remove('is-hit');
    }, 220);
  }

  shakeScore(): void {
    this.scorePanel.classList.remove('is-shaking');
    void this.scorePanel.offsetWidth;
    this.scorePanel.classList.add('is-shaking');
    window.clearTimeout(this.scoreShakeTimer);
    this.scoreShakeTimer = window.setTimeout(() => {
      this.scorePanel.classList.remove('is-shaking');
    }, 380);
  }

  warnPanel(kind: UIKind): void {
    const element = this.panelFor(kind);
    const previous = this.panelWarningTimers.get(kind);
    if (previous) window.clearTimeout(previous);
    element.classList.add('is-warning');
    const timer = window.setTimeout(() => {
      element.classList.remove('is-warning');
      this.panelWarningTimers.delete(kind);
    }, 650);
    this.panelWarningTimers.set(kind, timer);
  }

  showPopup(title?: string, body?: string): void {
    if (this.popups.length >= 2) return;

    const card = document.createElement('div');
    card.className = 'system-popup';
    card.setAttribute('data-ui-interactive', 'true');
    const popupTitle = title ?? POPUP_TITLES[Math.floor(Math.random() * POPUP_TITLES.length)];
    const popupBody = body ?? POPUP_BODIES[Math.floor(Math.random() * POPUP_BODIES.length)];

    const top = document.createElement('div');
    top.className = 'popup-top';
    const tag = document.createElement('span');
    tag.textContent = '系统 // UI 故障';
    const close = document.createElement('button');
    close.className = 'popup-close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('data-ui-interactive', 'true');
    top.append(tag, close);

    const titleEl = document.createElement('div');
    titleEl.className = 'popup-title';
    titleEl.textContent = popupTitle;
    const bodyEl = document.createElement('div');
    bodyEl.className = 'popup-body';
    bodyEl.textContent = popupBody;
    const foot = document.createElement('div');
    foot.className = 'popup-foot';
    foot.textContent = '拖拽投掷 // 点击击碎';

    card.append(top, titleEl, bodyEl, foot);
    this.popupLayer.append(card);

    const cardWidth = 350;
    const cardHeight = 180;
    const maxLeft = Math.max(12, window.innerWidth - cardWidth - 12);
    const maxTop = Math.max(12, window.innerHeight - cardHeight - 12);
    card.style.left = `${24 + Math.random() * Math.max(0, maxLeft - 48)}px`;
    card.style.top = `${90 + Math.random() * Math.max(0, maxTop - 120)}px`;

    const popup: PopupCard = { element: card, timeout: 0 };
    this.popups.push(popup);

    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let moved = 0;
    let dragging = false;

    const remove = (action?: PopupAction): void => {
      popup.cleanup?.();
      if (!this.popups.includes(popup)) return;
      window.clearTimeout(popup.timeout);
      card.remove();
      this.popups = this.popups.filter((entry) => entry !== popup);
      if (action) this.onPopupAction?.(action);
    };

    const onMove = (event: PointerEvent): void => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      moved = Math.max(moved, Math.hypot(dx, dy));
      const nextLeft = Math.min(maxLeft, Math.max(12, originLeft + dx));
      const nextTop = Math.min(maxTop, Math.max(12, originTop + dy));
      card.style.left = `${nextLeft}px`;
      card.style.top = `${nextTop}px`;
    };

    const onUp = (event: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      card.classList.remove('is-dragging');
      const rect = card.getBoundingClientRect();
      const x = event.clientX || rect.left + rect.width / 2;
      const y = event.clientY || rect.top + rect.height / 2;
      remove({
        x,
        y,
        dragged: moved > 30,
        title: popupTitle,
        body: popupBody,
      });
    };

    popup.cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    card.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      event.preventDefault();
      if ((event.target as HTMLElement).closest('.popup-close')) {
        remove();
        return;
      }
      dragging = true;
      moved = 0;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = card.offsetLeft;
      originTop = card.offsetTop;
      card.classList.add('is-dragging');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    close.addEventListener('click', (event) => {
      event.stopPropagation();
      remove();
    });

    card.addEventListener('contextmenu', (event) => event.preventDefault());

    popup.timeout = window.setTimeout(() => remove(), 12000);
    this.glitch(0.35, popupTitle);
  }

  clearPopups(): void {
    for (const popup of this.popups) {
      popup.cleanup?.();
      window.clearTimeout(popup.timeout);
      popup.element.remove();
    }
    this.popups = [];
  }

  getPopupCount(): number {
    return this.popups.length;
  }

  isPointerOverSkillPanel(x: number, y: number): boolean {
    if (this.skillPanel.classList.contains('is-hidden')) return false;
    const rect = this.skillPanel.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  isPointerOverInteractive(x: number, y: number): boolean {
    if (this.upgradeModal.classList.contains('is-visible')) return true;
    if (this.resultModal.classList.contains('is-visible')) return true;
    const element = document.elementFromPoint(x, y);
    return Boolean(element?.closest('[data-ui-interactive]'));
  }

  isMuted(): boolean {
    return this.muted;
  }

  private updateSkillSlot(
    slot: HTMLElement,
    label: HTMLElement,
    progress: HTMLElement,
    cooldown: number,
    max: number,
  ): void {
    const safeMax = Math.max(0.001, max);
    const ready = cooldown <= 0.001;
    slot.classList.toggle('is-cooling', !ready);
    label.textContent = ready ? '就绪' : `${cooldown.toFixed(1)} 秒`;
    progress.style.width = `${Math.max(0, Math.min(1, 1 - cooldown / safeMax)) * 100}%`;
  }

  private panelFor(kind: UIKind): HTMLElement {
    if (kind === 'hp') return this.healthPanel;
    if (kind === 'score') return this.scorePanel;
    return this.skillPanel;
  }
}
