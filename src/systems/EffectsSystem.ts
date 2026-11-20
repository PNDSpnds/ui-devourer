import * as THREE from 'three';

const MAX_PARTICLES = 700;

interface Particle {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  color: THREE.Color;
  life: number;
  maxLife: number;
}

interface Shockwave {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  maxRadius: number;
}

/**
 * CPU particle bursts, floor shockwaves, hitstop and camera trauma.
 * Deliberately post-processing-free so the M0 renderer stays unchanged.
 */
export class EffectsSystem {
  private readonly particles: Particle[] = [];
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly positionAttribute: THREE.BufferAttribute;
  private readonly colorAttribute: THREE.BufferAttribute;
  private readonly points: THREE.Points;
  private readonly particleTexture: THREE.CanvasTexture;
  private readonly shockwaves: Shockwave[] = [];
  private readonly ringGeometry: THREE.RingGeometry;
  private readonly tmpColor = new THREE.Color();
  private readonly tmpVector = new THREE.Vector3();

  private trauma = 0;
  private hitstopTimer = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.geometry = new THREE.BufferGeometry();
    this.positionAttribute = new THREE.BufferAttribute(this.positions, 3);
    this.colorAttribute = new THREE.BufferAttribute(this.colors, 3);
    this.geometry.setAttribute('position', this.positionAttribute);
    this.geometry.setAttribute('color', this.colorAttribute);
    this.geometry.setDrawRange(0, 0);

    this.particleTexture = this.createParticleTexture();
    const material = new THREE.PointsMaterial({
      size: 0.26,
      map: this.particleTexture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      alphaTest: 0.02,
    });
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    this.ringGeometry = new THREE.RingGeometry(0.86, 1, 52);
  }

  update(delta: number): void {
    for (let index = this.particles.length - 1; index >= 0; index -= 1) {
      const particle = this.particles[index];
      particle.life -= delta;
      if (particle.life <= 0) {
        const last = this.particles.pop();
        if (last && index < this.particles.length) {
          this.particles[index] = last;
        }
        continue;
      }

      particle.position.addScaledVector(particle.velocity, delta);
      particle.velocity.multiplyScalar(Math.exp(-1.8 * delta));
      particle.velocity.y -= 7.5 * delta;
    }

    const activeCount = this.particles.length;
    for (let index = 0; index < activeCount; index += 1) {
      const particle = this.particles[index];
      const alpha = Math.max(0, particle.life / particle.maxLife);
      this.positionAttribute.setXYZ(index, particle.position.x, particle.position.y, particle.position.z);
      this.tmpColor.copy(particle.color).multiplyScalar(alpha);
      this.colorAttribute.setXYZ(index, this.tmpColor.r, this.tmpColor.g, this.tmpColor.b);
    }
    this.geometry.setDrawRange(0, activeCount);
    this.positionAttribute.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;

    for (let index = this.shockwaves.length - 1; index >= 0; index -= 1) {
      const wave = this.shockwaves[index];
      wave.life -= delta;
      const progress = 1 - Math.max(0, wave.life / wave.maxLife);
      const scale = 0.55 + progress * wave.maxRadius;
      wave.mesh.scale.setScalar(scale);
      wave.material.opacity = Math.max(0, (1 - progress) * 0.75);
      if (wave.life <= 0) {
        this.scene.remove(wave.mesh);
        wave.material.dispose();
        this.shockwaves.splice(index, 1);
      }
    }
  }

  updateRealTime(delta: number): void {
    if (this.hitstopTimer > 0) {
      this.hitstopTimer = Math.max(0, this.hitstopTimer - delta);
    }
    this.trauma = Math.max(0, this.trauma * Math.exp(-3.6 * delta));
    if (this.trauma < 0.001) this.trauma = 0;
  }

  requestHitstop(seconds: number): void {
    this.hitstopTimer = Math.max(this.hitstopTimer, seconds);
  }

  isHitstopped(): boolean {
    return this.hitstopTimer > 0;
  }

  addShake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  getShake(): number {
    return Math.pow(this.trauma, 1.4) * 0.9;
  }

  burst(
    position: THREE.Vector3,
    color: number,
    count = 18,
    speed = 7,
    spread = 0.4,
  ): void {
    const baseColor = new THREE.Color(color);
    const amount = Math.min(count, MAX_PARTICLES - this.particles.length);
    for (let index = 0; index < amount; index += 1) {
      const direction = this.randomDirection();
      const velocity = direction.multiplyScalar(speed * (0.35 + Math.random() * 0.9));
      velocity.y += speed * 0.25;
      velocity.x += (Math.random() - 0.5) * spread * speed;
      velocity.z += (Math.random() - 0.5) * spread * speed;

      this.particles.push({
        position: position.clone().add(
          this.tmpVector.set(
            (Math.random() - 0.5) * 0.35,
            (Math.random() - 0.5) * 0.35,
            (Math.random() - 0.5) * 0.35,
          ),
        ),
        velocity,
        color: baseColor.clone().offsetHSL((Math.random() - 0.5) * 0.04, 0, (Math.random() - 0.5) * 0.15),
        life: 0.35 + Math.random() * 0.75,
        maxLife: 1,
      });
      const particle = this.particles[this.particles.length - 1];
      particle.maxLife = particle.life;
    }
  }

  spark(position: THREE.Vector3, color = 0xffffff): void {
    this.burst(position, color, 5, 3.3, 0.25);
  }

  shockwave(position: THREE.Vector3, color: number, maxRadius = 4, duration = 0.4): void {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(this.ringGeometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(position.x, Math.max(0.14, position.y + 0.05), position.z);
    mesh.scale.setScalar(0.55);
    this.scene.add(mesh);
    this.shockwaves.push({ mesh, material, life: duration, maxLife: duration, maxRadius });
  }

  portal(position: THREE.Vector3, color = 0xff3b5c): void {
    this.shockwave(position, color, 2.6, 0.5);
    this.burst(position, color, 20, 4.5, 0.6);
  }

  clear(): void {
    this.particles.length = 0;
    this.geometry.setDrawRange(0, 0);
    for (const wave of this.shockwaves) {
      this.scene.remove(wave.mesh);
      wave.material.dispose();
    }
    this.shockwaves.length = 0;
    this.trauma = 0;
    this.hitstopTimer = 0;
  }

  private randomDirection(): THREE.Vector3 {
    const theta = Math.random() * Math.PI * 2;
    const y = Math.random() * 2 - 0.25;
    const horizontal = Math.sqrt(Math.max(0, 1 - y * y));
    return new THREE.Vector3(Math.cos(theta) * horizontal, y, Math.sin(theta) * horizontal).normalize();
  }

  private createParticleTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Unable to create particle texture.');
    const gradient = context.createRadialGradient(32, 32, 1, 32, 32, 31);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.8)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
}
