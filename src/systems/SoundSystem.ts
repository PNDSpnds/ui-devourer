export type SoundName =
  | 'shoot'
  | 'hit'
  | 'crit'
  | 'enemyDeath'
  | 'uiDetach'
  | 'uiRecall'
  | 'uiDevour'
  | 'popup'
  | 'dash'
  | 'nova'
  | 'wave'
  | 'upgrade'
  | 'victory'
  | 'defeat'
  | 'boss'
  | 'bossDown'
  | 'pickup'
  | 'shield'
  | 'score'
  | 'healthShot';

/**
 * Tiny procedural sound engine. Everything is synthesized with Web Audio;
 * there are no audio files in the project.
 */
export class SoundSystem {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;

  unlock(): void {
    if (!this.context) {
      if (typeof window.AudioContext === 'undefined') return;
      this.context = new window.AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.context.destination);
      this.noiseBuffer = this.createNoiseBuffer();
    }
    if (this.context.state === 'suspended') {
      void this.context.resume();
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.5, this.context.currentTime, 0.01);
    }
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  play(name: SoundName): void {
    if (!this.context || !this.master) return;
    if (this.muted) return;

    switch (name) {
      case 'shoot':
        this.tone(940, 280, 0.055, 'square', 0.025);
        this.noise(0.025, 0.012, 'highpass', 1500);
        break;
      case 'hit':
        this.tone(260, 90, 0.075, 'sawtooth', 0.03);
        this.noise(0.045, 0.024, 'bandpass', 900);
        break;
      case 'crit':
        this.tone(1180, 1760, 0.09, 'sine', 0.045);
        this.tone(620, 1180, 0.08, 'triangle', 0.025, 0.012);
        break;
      case 'enemyDeath':
        this.noise(0.18, 0.045, 'lowpass', 700);
        this.tone(150, 42, 0.2, 'sawtooth', 0.035);
        break;
      case 'uiDetach':
        this.tone(720, 170, 0.14, 'sawtooth', 0.032);
        this.noise(0.055, 0.018, 'highpass', 700);
        break;
      case 'uiRecall':
        this.tone(280, 920, 0.13, 'sine', 0.04);
        this.tone(560, 1400, 0.09, 'triangle', 0.018, 0.035);
        break;
      case 'uiDevour':
        this.tone(190, 58, 0.38, 'sawtooth', 0.045);
        this.noise(0.25, 0.04, 'lowpass', 500);
        break;
      case 'popup':
        this.noise(0.13, 0.05, 'bandpass', 480);
        this.tone(100, 48, 0.16, 'square', 0.03);
        break;
      case 'dash':
        this.noise(0.17, 0.04, 'highpass', 900);
        this.tone(260, 760, 0.11, 'sine', 0.018);
        break;
      case 'nova':
        this.tone(72, 32, 0.4, 'sine', 0.08);
        this.noise(0.3, 0.05, 'lowpass', 420);
        this.tone(320, 60, 0.2, 'triangle', 0.025);
        break;
      case 'wave':
        this.tone(440, 440, 0.14, 'triangle', 0.028);
        this.tone(660, 660, 0.14, 'triangle', 0.028, 0.16);
        this.tone(880, 880, 0.2, 'triangle', 0.02, 0.32);
        break;
      case 'upgrade':
        this.tone(523, 523, 0.11, 'sine', 0.03);
        this.tone(659, 659, 0.11, 'sine', 0.03, 0.09);
        this.tone(784, 784, 0.16, 'sine', 0.035, 0.18);
        break;
      case 'victory':
        this.tone(523, 523, 0.16, 'triangle', 0.04);
        this.tone(659, 659, 0.16, 'triangle', 0.04, 0.14);
        this.tone(784, 784, 0.16, 'triangle', 0.04, 0.28);
        this.tone(1046, 1046, 0.4, 'sine', 0.05, 0.42);
        break;
      case 'defeat':
        this.tone(220, 220, 0.2, 'sawtooth', 0.04);
        this.tone(164, 164, 0.24, 'sawtooth', 0.04, 0.2);
        this.tone(110, 55, 0.5, 'sine', 0.05, 0.44);
        break;
      case 'boss':
        this.tone(58, 36, 0.8, 'sawtooth', 0.055);
        this.noise(0.5, 0.04, 'lowpass', 220);
        break;
      case 'bossDown':
        this.noise(0.45, 0.06, 'lowpass', 500);
        this.tone(220, 34, 0.7, 'sawtooth', 0.05);
        break;
      case 'pickup':
        this.tone(880, 1320, 0.09, 'sine', 0.03);
        break;
      case 'shield':
        this.tone(320, 660, 0.14, 'triangle', 0.024);
        break;
      case 'score':
        this.tone(980, 1480, 0.09, 'sine', 0.03);
        this.tone(1960, 1960, 0.08, 'sine', 0.014, 0.08);
        break;
      case 'healthShot':
        this.tone(180, 70, 0.22, 'sawtooth', 0.055);
        this.tone(920, 180, 0.12, 'square', 0.02);
        this.noise(0.08, 0.025, 'lowpass', 800);
        break;
    }
  }

  private tone(
    frequency: number,
    endFrequency: number,
    duration: number,
    type: OscillatorType,
    volume: number,
    delay = 0,
  ): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;

    const start = context.currentTime + delay;
    const end = start + Math.max(0.02, duration);
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(Math.max(20, frequency), start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), end);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(start);
    oscillator.stop(end + 0.02);
  }

  private noise(
    duration: number,
    volume: number,
    filterType: BiquadFilterType,
    filterFrequency: number,
    delay = 0,
  ): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master || !this.noiseBuffer) return;

    const start = context.currentTime + delay;
    const end = start + Math.max(0.02, duration);
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();

    source.buffer = this.noiseBuffer;
    filter.type = filterType;
    filter.frequency.value = filterFrequency;

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(start);
    source.stop(end + 0.02);
  }

  private createNoiseBuffer(): AudioBuffer {
    const context = this.context;
    if (!context) throw new Error('AudioContext is not initialized.');
    const length = Math.floor(context.sampleRate * 1.5);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) {
      data[index] = Math.random() * 2 - 1;
    }
    return buffer;
  }
}
