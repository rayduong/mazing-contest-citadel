import * as THREE from 'three';
import {
  computeCitadelCircuitry,
  computeFullMazePath,
  do2x2Overlap,
  validateTowerPlacement,
} from '../shared/pathfinding.js';
import { evaluateMazeRunTime } from '../shared/simulation.js';
import {
  GridPoint,
  MazeEvalResult,
  PlacedTower,
  PlayerState,
  RoomState,
  RoundConfig,
  RunnerArchetype,
  RunnerSimState,
  SimEvent,
  SpireType,
  TOWER_SPECS,
} from '../shared/types.js';

const ISLAND_SPACING_X = 36;
const ISLAND_SPACING_Z = 40;

// ============================================================================
// SOFT PROCEDURAL SPRITE & CONTACT AO TEXTURES (ZERO NOISY BUMP MAPS)
// ============================================================================

/**
 * Generates a smooth radial contact-shadow texture for grounding 2x2 Pillars,
 * Keeps, Spires, and Runners on the meadow floor (*Townscaper* / *Thronefall* style).
 */
function createContactShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const half = size * 0.5;
  const grad = ctx.createRadialGradient(half, half, 2, half, half, half - 2);
  grad.addColorStop(0.0, 'rgba(24, 42, 20, 0.36)');
  grad.addColorStop(0.55, 'rgba(24, 42, 20, 0.20)');
  grad.addColorStop(0.84, 'rgba(24, 42, 20, 0.05)');
  grad.addColorStop(1.0, 'rgba(24, 42, 20, 0.0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a soft circular sprite texture so dust puffs and spire motes
 * render as smooth anti-aliased circles rather than harsh square pixels.
 */
function createSoftCircleSpriteTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const half = size * 0.5;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half - 1);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.42, 'rgba(255, 255, 255, 0.78)');
  grad.addColorStop(0.78, 'rgba(255, 255, 255, 0.20)');
  grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ============================================================================
// DIORAMA GLSL SHADERS (TRANQUIL SEA, SHORELINE FOAM, VELVET MEADOW, HAIRLINES)
// ============================================================================

/**
 * Serene, zero-shimmer Tranquil Cerulean Sea Shader:
 * Coastal aqua (`#64b5d6`) blending gently to deep cerulean (`#438fae`)
 * with broad low-frequency swells (`worldXZ * 0.15`, max 4% luminance shift)
 * and a zero-seam blend into `uHorizonColor` (`#cde8f6`).
 */
function createTranquilSeaShader(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: false,
    toneMapped: true,
    uniforms: {
      uTime: { value: 0 },
      uArenaCenter: { value: new THREE.Vector2(10, 13) },
      uCoastalAqua: { value: new THREE.Color('#64b5d6') },
      uDeepCerulean: { value: new THREE.Color('#438fae') },
      uHorizonColor: { value: new THREE.Color('#cde8f6') },
    },
    vertexShader: `
      varying vec2 vWorldXZ;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldXZ = worldPos.xz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec2 uArenaCenter;
      uniform vec3 uCoastalAqua;
      uniform vec3 uDeepCerulean;
      uniform vec3 uHorizonColor;
      varying vec2 vWorldXZ;

      void main() {
        float distFromCenter = length(vWorldXZ - uArenaCenter);
        float depthFactor = smoothstep(8.0, 92.0, distFromCenter);

        vec3 baseSea = mix(uCoastalAqua, uDeepCerulean, depthFactor);

        // Broad low-frequency swell (worldXZ * 0.15, max 4% luminance shift, zero moire)
        vec2 p = vWorldXZ * 0.15;
        float swell1 = sin(p.x + uTime * 0.28) * cos(p.y - uTime * 0.22);
        float swell2 = sin((p.x * 0.7 - p.y * 0.8) + uTime * 0.19);
        float swell = (swell1 * 0.6 + swell2 * 0.4) * 0.04;
        vec3 col = baseSea * (1.0 + swell);

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>

        // Seamless horizon mist into scene.background (#cde8f6)
        float horizonMist = smoothstep(95.0, 230.0, distFromCenter);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uHorizonColor, horizonMist);

        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Crisp cream-white shoreline contact band (`#f8fafc`, `0.72` alpha)
 * plus one slow, gentle cartoon-clean ripple (`uTime * 0.20`).
 */
function createShorelineFoamShader(
  bankWidth: number,
  bankDepth: number
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: true,
    uniforms: {
      uTime: { value: 0 },
      uFoamColor: { value: new THREE.Color('#f8fafc') },
      uHalfBank: {
        value: new THREE.Vector2(bankWidth * 0.5, bankDepth * 0.5),
      },
      uHalfPlane: {
        value: new THREE.Vector2(
          (bankWidth + 3.4) * 0.5,
          (bankDepth + 3.4) * 0.5
        ),
      },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uFoamColor;
      uniform vec2 uHalfBank;
      uniform vec2 uHalfPlane;
      varying vec2 vUv;

      void main() {
        vec2 worldPos = abs(vUv) * uHalfPlane;
        vec2 d = worldPos - uHalfBank;
        float boxDist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);

        if (boxDist < -0.12 || boxDist > 1.65) discard;

        float gentleWave = sin(vUv.x * 6.0 + uTime * 0.65) * cos(vUv.y * 6.0 - uTime * 0.55) * 0.035;
        float dist = max(0.0, boxDist + gentleWave);

        // Crisp shoreline contact band
        float contactBand = smoothstep(0.28, 0.03, dist) * 0.72;

        // Single slow, cartoon-clean outward ripple
        float phase = fract(uTime * 0.20);
        float ripplePos = 0.20 + phase * 1.18;
        float ripple = smoothstep(0.075, 0.0, abs(dist - ripplePos)) * (1.0 - phase) * 0.38;

        float alpha = clamp(contactBand + ripple, 0.0, 0.76);
        if (alpha < 0.005) discard;

        gl_FragColor = vec4(uFoamColor, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

interface GrasslandFloorUniforms {
  uTime: { value: number };
  uGridSize: { value: THREE.Vector2 };
  uCursorPos: { value: THREE.Vector2 };
  uBuildAlpha: { value: number };
  uSageTurf: { value: THREE.Color };
  uSunlitMeadow: { value: THREE.Color };
  uOliveGrid: { value: THREE.Color };
  uWarmCream: { value: THREE.Color };
  uCurbStone: { value: THREE.Color };
}

/**
 * Shadow-Receiving Serene Velvety Meadow Floor Material (`MeshStandardMaterial` + `onBeforeCompile`):
 * - Receives real directional sunlight & crisp `PCFSoftShadowMap` shadows from Pillars, Bridges, Keeps, Spires & Runners!
 * - Gentle 2x2 mowed lawn bands (`#5ca343` <-> `#66ae4b`, reading as sunlit `#6eb452`–`#7ac05c` under golden-hour sun)
 * - Single smooth cloud-dapple octave, derivative-AA `1x1` whisper grid (`uBuildAlpha`), soft cliff AO & `0.12` warm limestone curb.
 */
function createGrasslandFloorMaterial(): {
  material: THREE.MeshStandardMaterial;
  uniforms: GrasslandFloorUniforms;
} {
  const uniforms: GrasslandFloorUniforms = {
    uTime: { value: 0 },
    uGridSize: { value: new THREE.Vector2(20, 26) },
    uCursorPos: { value: new THREE.Vector2(-99, -99) },
    uBuildAlpha: { value: 1.0 },
    uSageTurf: { value: new THREE.Color('#5ca343') },
    uSunlitMeadow: { value: new THREE.Color('#66ae4b') },
    uOliveGrid: { value: new THREE.Color('#4d8837') },
    uWarmCream: { value: new THREE.Color('#ecfccb') },
    uCurbStone: { value: new THREE.Color('#e6dfd3') },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
  });
  material.userData.uniforms = uniforms;
  material.customProgramCacheKey = () => 'meadow-floor-standard-v2';

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vFloorUv;`
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        vFloorUv = uv;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform vec2 uGridSize;
        uniform vec2 uCursorPos;
        uniform float uBuildAlpha;
        uniform vec3 uSageTurf;
        uniform vec3 uSunlitMeadow;
        uniform vec3 uOliveGrid;
        uniform vec3 uWarmCream;
        uniform vec3 uCurbStone;
        varying vec2 vFloorUv;

        float floorHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float floorVNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(floorHash(i + vec2(0.0, 0.0)), floorHash(i + vec2(1.0, 0.0)), u.x),
            mix(floorHash(i + vec2(0.0, 1.0)), floorHash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }

        float floorFbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 2; i++) {
            v += a * floorVNoise(p);
            p = p * 2.03 + vec2(9.2, 5.7);
            a *= 0.5;
          }
          return v;
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec2 cellPos = vFloorUv * uGridSize;
          vec2 blockId = floor(cellPos * 0.5);
          vec2 f = fract(cellPos);

          // 1. Gentle 2x2 mowed lawn bands (#5ca343 <-> #66ae4b) + single smooth cloud-dapple octave
          float mowedBand = mod(blockId.x + blockId.y, 2.0);
          vec3 grassCol = mix(uSageTurf, uSunlitMeadow, mowedBand);

          float cloudDapple = floorFbm(cellPos * 0.12 + vec2(uTime * 0.012, uTime * 0.008));
          grassCol *= 1.0 + (cloudDapple - 0.5) * 0.11;

          // 2. Phase-aware derivative-antialiased 1x1 whisper grid (0.0 in RUN, soft in BUILD)
          if (uBuildAlpha > 0.002) {
            vec2 gridDist = min(f, 1.0 - f);
            vec2 aa = max(fwidth(cellPos), vec2(0.007));
            float gx = 1.0 - smoothstep(0.0, aa.x * 1.35, gridDist.x);
            float gy = 1.0 - smoothstep(0.0, aa.y * 1.35, gridDist.y);
            float hairline = max(gx, gy);

            float cursorDist = length(cellPos - uCursorPos);
            float cursorProximity = smoothstep(4.0, 0.35, cursorDist);

            vec3 lineCol = mix(uOliveGrid, uWarmCream, cursorProximity);
            float lineAlpha = mix(0.085, 0.28, cursorProximity) * uBuildAlpha;

            grassCol = mix(grassCol, lineCol, hairline * lineAlpha);
            grassCol = mix(grassCol, uWarmCream, cursorProximity * 0.055 * uBuildAlpha);
          }

          // 3. Soft cliff contact AO & clean 0.12-wide warm limestone curb (#e6dfd3)
          vec2 distToBorder = min(cellPos, uGridSize - cellPos);
          float minBorderDist = min(distToBorder.x, distToBorder.y);
          float cliffAO = smoothstep(0.0, 0.95, minBorderDist);
          grassCol *= 0.84 + 0.16 * cliffAO;

          float curbAa = max(min(fwidth(cellPos.x), fwidth(cellPos.y)), 0.008);
          float curbMask = 1.0 - smoothstep(0.12 - curbAa, 0.12 + curbAa, minBorderDist);
          grassCol = mix(grassCol, uCurbStone, curbMask);

          diffuseColor.rgb *= grassCol;
        }`
      );
  };

  return { material, uniforms };
}

/**
 * Low-profile warm cream stepping-stone path ribbon shader (`#fefce8`).
 */
function createPathRibbonShader(
  colorHex = '#fefce8',
  initialOpacity = 0.58
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: true,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(colorHex) },
      uHighlightColor: { value: new THREE.Color('#fffef2') },
      uOpacity: { value: initialOpacity },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uColor;
      uniform vec3 uHighlightColor;
      uniform float uOpacity;
      varying vec2 vUv;

      void main() {
        float edgeMask = smoothstep(0.0, 0.20, vUv.y) * smoothstep(1.0, 0.80, vUv.y);
        // Subtle stepping-stone paver cadence in world-space meters (vUv.x)
        float paver = fract(vUv.x * 1.45 - uTime * 0.48);
        float stone = smoothstep(0.10, 0.24, paver) * smoothstep(0.92, 0.78, paver);

        vec3 baseCream = uColor * 0.92;
        vec3 brightCream = mix(uColor, uHighlightColor, 0.45);
        vec3 col = mix(baseCream, brightCream, stone);

        float alpha = uOpacity * edgeMask * (0.72 + 0.28 * stone);
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Builds a flat low-profile horizontal ribbon geometry along a Catmull-Rom path curve
 * with arc-length meters stored in `uv.x` for uniform stepping-stone pacing.
 */
function createFlatPathRibbonGeometry(
  points: GridPoint[],
  offsetX: number,
  offsetZ: number,
  yHeight: number,
  halfWidth = 0.145
): THREE.BufferGeometry {
  const pts3D = points.map(
    (p) => new THREE.Vector3(offsetX + p.x, yHeight, offsetZ + p.y)
  );
  const curve = new THREE.CatmullRomCurve3(pts3D, false, 'catmullrom', 0.16);
  const segCount = Math.min(360, Math.max(24, pts3D.length * 5));
  const sampled = curve.getSpacedPoints(segCount);

  const vertCount = sampled.length * 2;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices: number[] = [];

  let cumDist = 0;
  for (let i = 0; i < sampled.length; i++) {
    const curr = sampled[i];
    if (i > 0) {
      cumDist += curr.distanceTo(sampled[i - 1]);
    }

    const prev = sampled[Math.max(0, i - 1)];
    const next = sampled[Math.min(sampled.length - 1, i + 1)];
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;

    const nx = -tz * halfWidth;
    const nz = tx * halfWidth;

    const vBase = i * 6;
    positions[vBase] = curr.x - nx;
    positions[vBase + 1] = yHeight;
    positions[vBase + 2] = curr.z - nz;

    positions[vBase + 3] = curr.x + nx;
    positions[vBase + 4] = yHeight;
    positions[vBase + 5] = curr.z + nz;

    const uvBase = i * 4;
    uvs[uvBase] = cumDist;
    uvs[uvBase + 1] = 0;
    uvs[uvBase + 2] = cumDist;
    uvs[uvBase + 3] = 1;

    if (i < sampled.length - 1) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Clean single-hairline Spire Range Shader (eliminates concentric ring soup):
 * - Single crisp derivative-AA perimeter hairline (`0.24` in BUILD, `0.58` near hover/ghost, `0.13` in RUN)
 * - Subtle `0.045` frost tint inside `FROST_OBELISK` only
 */
function createSpireAoEShader(
  range: number,
  spireType: SpireType = 'THUNDERCLAP'
): THREE.ShaderMaterial {
  const baseColor =
    spireType === 'FROST_OBELISK'
      ? new THREE.Color('#38bdf8')
      : spireType === 'CHRONO_SPIRE'
      ? new THREE.Color('#a855f7')
      : new THREE.Color('#f59e0b');

  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: true,
    side: THREE.DoubleSide,
    uniforms: {
      uRange: { value: range },
      uBaseColor: { value: baseColor },
      uOverchargeGold: { value: new THREE.Color('#fbbf24') },
      uRingAlpha: { value: 0.24 },
      uInnerFillAlpha: { value: spireType === 'FROST_OBELISK' ? 0.045 : 0.0 },
      uOverchargeTier: { value: 0.0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uBaseColor;
      uniform vec3 uOverchargeGold;
      uniform float uRingAlpha;
      uniform float uInnerFillAlpha;
      uniform float uOverchargeTier;
      varying vec2 vUv;

      void main() {
        float r = length(vUv);
        float aa = max(fwidth(r), 0.0035);
        if (r > 1.0 + aa) discard;

        float ringCenter = 1.0 - aa * 1.4;
        float hairline = 1.0 - smoothstep(aa * 0.65, aa * 2.1, abs(r - ringCenter));
        float innerMask = 1.0 - smoothstep(ringCenter - aa, ringCenter + aa, r);

        vec3 col = mix(uBaseColor, uOverchargeGold, clamp(uOverchargeTier * 0.16, 0.0, 0.42));

        float alpha = innerMask * uInnerFillAlpha + hairline * uRingAlpha;
        if (alpha < 0.003) discard;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.85));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Compact radial cooldown ring (`r = 1.08m`) hugging the Spire's stone base plinth during RUN.
 */
function createSpireBaseCooldownShader(
  spireType: SpireType = 'THUNDERCLAP'
): THREE.ShaderMaterial {
  const accentColor =
    spireType === 'FROST_OBELISK'
      ? new THREE.Color('#38bdf8')
      : spireType === 'CHRONO_SPIRE'
      ? new THREE.Color('#a855f7')
      : new THREE.Color('#f59e0b');

  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: true,
    side: THREE.DoubleSide,
    uniforms: {
      uChargeProgress: { value: 1.0 },
      uAccentColor: { value: accentColor },
      uTrackColor: { value: new THREE.Color('#28362c') },
      uReadyTint: { value: new THREE.Color('#fff5cc') },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uChargeProgress;
      uniform vec3 uAccentColor;
      uniform vec3 uTrackColor;
      uniform vec3 uReadyTint;
      varying vec2 vUv;

      void main() {
        float r = length(vUv);
        float aa = max(fwidth(r), 0.008);
        float band = smoothstep(0.84 - aa, 0.84 + aa, r) * (1.0 - smoothstep(0.96 - aa, 0.96 + aa, r));
        if (band < 0.005) discard;

        // Clockwise progress starting from North (-Z -> vUv.y < 0)
        float angle = atan(vUv.x, -vUv.y);
        float normAngle = fract((angle + 6.2831853) / 6.2831853);
        float fillMask = 1.0 - smoothstep(uChargeProgress - 0.015, uChargeProgress + 0.015, normAngle);
        if (uChargeProgress >= 0.995) fillMask = 1.0;

        vec3 readyCol = mix(uAccentColor, uReadyTint, uChargeProgress >= 0.98 ? 0.35 : 0.0);
        vec3 col = mix(uTrackColor, readyCol, fillMask);
        float alpha = band * mix(0.24, 0.86, fillMask);

        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Piecewise smooth toy-box spring squash-and-stretch curve over `0..1`:
 * `scaleY: 0.20 -> 1.09 -> 0.97 -> 1.00`
 */
function evalToyBoxSpringScaleY(tNorm: number): number {
  const t = Math.max(0, Math.min(1, tNorm));
  if (t < 0.46) {
    const u = t / 0.46;
    const easeOut = 1 - Math.pow(1 - u, 3);
    return 0.2 + (1.09 - 0.2) * easeOut;
  }
  if (t < 0.76) {
    const u = (t - 0.46) / 0.3;
    const smooth = 0.5 - 0.5 * Math.cos(u * Math.PI);
    return 1.09 + (0.97 - 1.09) * smooth;
  }
  const u = (t - 0.76) / 0.24;
  const smooth = 0.5 - 0.5 * Math.cos(u * Math.PI);
  return 0.97 + (1.0 - 0.97) * smooth;
}

// ============================================================================
// INTERFACES
// ============================================================================

export interface HoverStatusInfo {
  cell: GridPoint | null;
  screenX: number;
  screenY: number;
  valid: boolean;
  reason?: string;
  deltaTime?: number;
  deltaClaps?: number;
  deltaKeeps?: number;
  deltaOvercharge?: number;
  previewTime?: number;
  existingTower?: PlacedTower | null;
  isTouchPreview?: boolean;
  isGestureMoving?: boolean;
  offscreen?: boolean;
  onConfirmTouchAction?: () => void;
  onCancelTouchAction?: () => void;
}

interface ShockwaveEffect {
  mesh: THREE.Mesh;
  bolt?: THREE.Line;
  age: number;
  maxAge: number;
  maxRadius: number;
}

interface ParticleBurst {
  points: THREE.Points;
  velocities: Float32Array;
  gravity: number;
  baseOpacity: number;
  age: number;
  maxAge: number;
}

interface SpireVisualRig {
  group: THREE.Group;
  spireType: SpireType;
  baseRange: number;
  gridX: number;
  gridY: number;
  upperCore: THREE.Object3D;
  baseCoreY: number;
  collarRimMesh: THREE.Mesh;
  overchargePips: THREE.Mesh[];
  cooldownRingMesh: THREE.Mesh;
  cooldownRingMat: THREE.ShaderMaterial;
  aoeMesh: THREE.Mesh;
  aoeMat: THREE.ShaderMaterial;
  targetHoverBoost: number;
  recoil: number;
}

interface RuinVisualRig {
  group: THREE.Group;
  lanternMesh: THREE.Mesh;
  gridX: number;
  gridY: number;
}

interface RunnerRig {
  archetype: RunnerArchetype;
  root: THREE.Group;
  pelvis: THREE.Group;
  headGroup: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  accentMesh: THREE.Mesh | null;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  statusRing: THREE.Mesh;
  walkPhase: number;
  currentYaw: number;
}

interface WallVisualEntry {
  group: THREE.Group;
  born: number;
  x: number;
  y: number;
}

interface BridgeVisualEntry {
  group: THREE.Group;
  born: number;
}

interface IslandVisuals {
  playerId: string;
  playerColor: string;
  root: THREE.Group;
  offsetX: number;
  offsetZ: number;
  floorMat: THREE.MeshStandardMaterial;
  floorUniforms: GrasslandFloorUniforms;
  foamMat: THREE.ShaderMaterial;
  trimMesh: THREE.Mesh;
  hitPlane: THREE.Mesh;
  padGroup: THREE.Group;
  towerGroup: THREE.Group;
  bridgeGroup: THREE.Group;
  bridgeEntries: BridgeVisualEntry[];
  clapMarkerGroup: THREE.Group;
  towerMeshes: Map<string, WallVisualEntry>;
  spireRigs: SpireVisualRig[];
  ruinRigs: RuinVisualRig[];
  pathMesh: THREE.Mesh | null;
  pathMat: THREE.ShaderMaterial | null;
  runner: RunnerRig;
  checkpointRings: THREE.Mesh[];
}

interface ActiveTouchPoint {
  x: number;
  y: number;
  startX: number;
  startY: number;
}

// ============================================================================
// ARENA 3D RENDERER (SUNLIT LIMESTONE & SAGE MEADOW DIORAMA + MULTI-TOUCH)
// ============================================================================

export class Arena3DRenderer {
  private container: HTMLElement;
  private labelLayer: HTMLElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private sunLight!: THREE.DirectionalLight;
  private lastShadowFrustumD = 0;
  private seaMesh!: THREE.Mesh;
  private voidSeaMat!: THREE.ShaderMaterial;

  private islands = new Map<string, IslandVisuals>();
  private shockwaves: ShockwaveEffect[] = [];
  private particleBursts: ParticleBurst[] = [];

  // Aspect-adaptive camera rig
  private camTarget = new THREE.Vector3(10, 0, 14);
  private camGoalTarget = new THREE.Vector3(10, 0, 14);
  private camRadius = 42;
  private camGoalRadius = 42;
  private camPolar = 0.5;
  private camGoalPolar = 0.5;
  private camAzimuth = 0;
  private camGoalAzimuth = 0;
  private cameraShake = 0;

  private isDraggingCamera = false;
  private dragStart = { x: 0, y: 0 };
  private isLeftMouseDown = false;
  private leftMouseStart = { x: 0, y: 0 };
  private leftMousePanned = false;
  private leftMouseCanPan = false;
  private mouseOverLocalGrass = false;
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private keysDown = new Set<string>();

  // Multi-touch gesture state machine
  private activeTouches = new Map<number, ActiveTouchPoint>();
  private touchGestureMoved = false;
  private lastPinchDist = 0;
  private lastPinchMid = { x: 0, y: 0 };
  private pendingTouchCell: { x: number; y: number } | null = null;
  private pendingTouchTowerId: string | null = null;
  private activeTouchHoverInfo: HoverStatusInfo | null = null;
  private touchWorldAnchor = new THREE.Vector3();

  // Desktop hover & clean miniature limestone ghost state
  private raycaster = new THREE.Raycaster();
  private mouseNDC = new THREE.Vector2(-99, -99);
  private lastPointerScreen = { x: 0, y: 0 };
  private hoveredCell: { x: number; y: number } | null = null;
  private hoveredExistingTower: PlacedTower | null = null;
  private ghostGroup: THREE.Group;
  private ghostConnGroup: THREE.Group;
  private ghostBodyMat: THREE.MeshStandardMaterial;
  private ghostCapMat: THREE.MeshStandardMaterial;
  private previewPathMesh: THREE.Mesh | null = null;
  private previewPathMat: THREE.ShaderMaterial | null = null;

  // Singleton Procedural Sprite & AO Textures
  private contactShadowTex = createContactShadowTexture();
  private softCircleSpriteTex = createSoftCircleSpriteTexture();

  // Singleton Shared Geometries (Zero per-pillar/per-bridge GPU buffer churn!)
  private readonly sharedGeos = {
    aoQuad: (() => {
      const g = new THREE.PlaneGeometry(2.04, 2.04);
      g.rotateX(-Math.PI / 2);
      return g;
    })(),
    pillarPlinth: (() => {
      const g = new THREE.CylinderGeometry(0.76, 0.84, 0.22, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    pillarShaft: (() => {
      const g = new THREE.CylinderGeometry(0.68, 0.72, 1.02, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    pillarCap: (() => {
      const g = new THREE.CylinderGeometry(0.76, 0.74, 0.2, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    pillarMedallion: (() => {
      const g = new THREE.CylinderGeometry(0.4, 0.4, 0.04, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    bridgeWallUnit: new THREE.BoxGeometry(0.68, 0.98, 1.0),
    bridgeCapUnit: new THREE.BoxGeometry(0.78, 0.14, 1.0),
    keystoneBody: new THREE.BoxGeometry(0.74, 1.02, 0.14),
    keystoneCap: new THREE.BoxGeometry(0.84, 0.16, 0.18),
    keepPlinth: (() => {
      const g = new THREE.CylinderGeometry(0.78, 0.86, 0.22, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    keepShaft: (() => {
      const g = new THREE.CylinderGeometry(0.7, 0.75, 0.96, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    keepCornice: (() => {
      const g = new THREE.CylinderGeometry(0.78, 0.73, 0.16, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    keepPitchedCap: (() => {
      const g = new THREE.CylinderGeometry(0.24, 0.76, 0.18, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    keepLantern: (() => {
      const g = new THREE.CylinderGeometry(0.16, 0.13, 0.16, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    spirePlinth: (() => {
      const g = new THREE.CylinderGeometry(0.84, 0.92, 0.24, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    spirePedestal: (() => {
      const g = new THREE.CylinderGeometry(0.72, 0.8, 0.76, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    spireCollar: (() => {
      const g = new THREE.CylinderGeometry(0.78, 0.74, 0.16, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    spireCollarRim: (() => {
      const g = new THREE.CylinderGeometry(0.83, 0.85, 0.06, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    spirePip: (() => {
      const g = new THREE.OctahedronGeometry(0.14, 0);
      g.scale(1, 0.55, 1);
      g.computeVertexNormals();
      return g;
    })(),
    clapPipOuter: (() => {
      const g = new THREE.CircleGeometry(0.14, 16);
      g.rotateX(-Math.PI / 2);
      return g;
    })(),
    clapPipInner: (() => {
      const g = new THREE.CircleGeometry(0.085, 16);
      g.rotateX(-Math.PI / 2);
      return g;
    })(),
    shockwaveRing: (() => {
      const g = new THREE.RingGeometry(0.86, 1.0, 48);
      g.rotateX(-Math.PI / 2);
      return g;
    })(),
  };

  // Singleton Matte/Satin Stylized Materials (*Townscaper* / *Bad North* palette)
  private readonly aoDiscMat = new THREE.MeshBasicMaterial({
    map: this.contactShadowTex,
    transparent: true,
    depthWrite: false,
  });
  private readonly plinthSandstoneMat = new THREE.MeshStandardMaterial({
    color: '#ddd5c7',
    roughness: 0.84,
    metalness: 0.02,
  });
  private readonly ivoryShaftMat = new THREE.MeshStandardMaterial({
    color: '#f5f0e6',
    roughness: 0.78,
    metalness: 0.02,
  });
  private readonly bridgeWallMat = new THREE.MeshStandardMaterial({
    color: '#efe9de',
    roughness: 0.78,
    metalness: 0.02,
  });
  private readonly creamCapMat = new THREE.MeshStandardMaterial({
    color: '#fcfaf5',
    roughness: 0.72,
    metalness: 0.02,
  });
  private readonly playerMedallionMats = new Map<
    string,
    THREE.MeshStandardMaterial
  >();

  // Crimson Keep Singleton Materials
  private readonly crimsonKeepWallMat = new THREE.MeshStandardMaterial({
    color: '#b84a39',
    roughness: 0.78,
    metalness: 0.04,
  });
  private readonly crimsonKeepRoofMat = new THREE.MeshStandardMaterial({
    color: '#9f3a2b',
    roughness: 0.76,
    metalness: 0.04,
  });
  private readonly creamStoneTrimMat = new THREE.MeshStandardMaterial({
    color: '#f5f0e6',
    roughness: 0.74,
    metalness: 0.03,
  });
  private readonly goldBridgeTrimMat = new THREE.MeshStandardMaterial({
    color: '#fbbf24',
    emissive: '#d97706',
    emissiveIntensity: 0.26,
    roughness: 0.46,
    metalness: 0.18,
  });
  private readonly keepLanternUnlinkedMat = new THREE.MeshStandardMaterial({
    color: '#c96a55',
    emissive: '#7f1d1d',
    emissiveIntensity: 0.1,
    roughness: 0.68,
    metalness: 0.08,
  });
  private readonly keepLanternLinkedMat = new THREE.MeshStandardMaterial({
    color: '#fbbf24',
    emissive: '#f59e0b',
    emissiveIntensity: 0.72,
    roughness: 0.32,
    metalness: 0.22,
  });

  // Spire Collar Rim, Pip & Island Basin Materials
  private readonly collarRimInactiveMat = new THREE.MeshStandardMaterial({
    color: '#e5dec9',
    roughness: 0.76,
    metalness: 0.04,
  });
  private readonly collarRimGoldMat = new THREE.MeshStandardMaterial({
    color: '#fbbf24',
    emissive: '#f59e0b',
    emissiveIntensity: 0.35,
    roughness: 0.36,
    metalness: 0.28,
  });
  private readonly pipInactiveMat = new THREE.MeshStandardMaterial({
    color: '#cfc7b8',
    roughness: 0.82,
    metalness: 0.04,
  });
  private readonly pipActiveGoldMat = new THREE.MeshStandardMaterial({
    color: '#fbbf24',
    emissive: '#f59e0b',
    emissiveIntensity: 0.55,
    roughness: 0.3,
    metalness: 0.35,
  });
  private readonly cliffTalusMat = new THREE.MeshStandardMaterial({
    color: '#cfc6b6',
    roughness: 0.86,
    metalness: 0.02,
  });
  private readonly cliffLimestoneMat = new THREE.MeshStandardMaterial({
    color: '#e2dbd0',
    roughness: 0.82,
    metalness: 0.02,
  });
  private readonly cliffMeadowRimMat = new THREE.MeshStandardMaterial({
    color: '#76b957',
    roughness: 0.84,
    metalness: 0.01,
  });
  private readonly cypressTrunkMat = new THREE.MeshStandardMaterial({
    color: '#7c583c',
    roughness: 0.86,
    metalness: 0.02,
  });
  private readonly cypressFoliageMats = [
    new THREE.MeshStandardMaterial({ color: '#4d8c42', roughness: 0.82 }),
    new THREE.MeshStandardMaterial({ color: '#5b9e4d', roughness: 0.8 }),
  ];
  private readonly clapPipCreamMat = new THREE.MeshBasicMaterial({
    color: '#fefce8',
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  private readonly clapPipGoldMat = new THREE.MeshBasicMaterial({
    color: '#f59e0b',
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  private readonly clapPipGainMat = new THREE.MeshBasicMaterial({
    color: '#22c55e',
    transparent: true,
    opacity: 0.94,
    depthWrite: false,
  });

  private _activeTool: 'BLOCK' | 'SELL' = 'BLOCK';
  public get activeTool(): 'BLOCK' | 'SELL' {
    return this._activeTool;
  }
  public set activeTool(val: 'BLOCK' | 'SELL') {
    if (this._activeTool !== val) {
      this._activeTool = val;
      if (this.pendingTouchCell || this.pendingTouchTowerId) {
        this.doClearTouchPreview();
      } else {
        this.updateBuildHover();
      }
    }
  }

  public localPlayerId: string | null = null;
  public focusedPlayerId: string | null = null;
  public arenaOverviewMode = false;
  private currentRoomState: RoomState | null = null;
  private lastLayoutSignature = '';
  private cachedBaseEval: MazeEvalResult | null = null;

  public onPlaceTower?: (x: number, y: number) => void;
  public onSellTower?: (towerId: string) => void;
  public onHoverStatusChange?: (info: HoverStatusInfo) => void;
  public dismissTransientUI?: () => boolean;
  public onFocusChange?: () => void;

  private labelElements = new Map<string, HTMLElement>();
  private runnerLabels = new Map<string, HTMLElement>();

  constructor(container: HTMLElement, labelLayer: HTMLElement) {
    this.container = container;
    this.labelLayer = labelLayer;

    // 1. Sunlit Limestone & Sage Meadow Sky Mist
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#cde8f6');
    this.scene.fog = new THREE.FogExp2('#cde8f6', 0.0018);

    const initW = this.container.clientWidth || window.innerWidth;
    const initH = this.container.clientHeight || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(46, initW / initH, 0.5, 360);

    // Hardware MSAA direct WebGL render pipeline + r170 sRGB Color Management
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(initW, initH);
    this.renderer.setPixelRatio(this.computeAdaptivePixelRatio());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;
    this.renderer.domElement.style.touchAction = 'none';
    this.container.appendChild(this.renderer.domElement);

    this.setupLightingAndEnvironment();

    // Clean Semi-Transparent Miniature Limestone Pillar + Bridge Ghost (renderOrder = 10)
    this.ghostGroup = new THREE.Group();
    this.ghostGroup.visible = false;

    this.ghostConnGroup = new THREE.Group();
    this.ghostGroup.add(this.ghostConnGroup);

    this.ghostBodyMat = new THREE.MeshStandardMaterial({
      color: '#86efac',
      emissive: '#22c55e',
      emissiveIntensity: 0.22,
      roughness: 0.68,
      transparent: true,
      opacity: 0.56,
      depthWrite: false,
    });
    this.ghostCapMat = new THREE.MeshStandardMaterial({
      color: '#dcfce7',
      emissive: '#4ade80',
      emissiveIntensity: 0.24,
      roughness: 0.62,
      transparent: true,
      opacity: 0.64,
      depthWrite: false,
    });

    const ghostPlinth = new THREE.Mesh(
      this.sharedGeos.pillarPlinth,
      this.ghostBodyMat
    );
    ghostPlinth.position.y = 0.11;
    ghostPlinth.renderOrder = 10;
    this.ghostGroup.add(ghostPlinth);

    const ghostShaft = new THREE.Mesh(
      this.sharedGeos.pillarShaft,
      this.ghostBodyMat
    );
    ghostShaft.position.y = 0.73;
    ghostShaft.renderOrder = 10;
    this.ghostGroup.add(ghostShaft);

    const ghostCap = new THREE.Mesh(
      this.sharedGeos.pillarCap,
      this.ghostCapMat
    );
    ghostCap.position.y = 1.34;
    ghostCap.renderOrder = 10;
    this.ghostGroup.add(ghostCap);

    this.scene.add(this.ghostGroup);

    // Apply initial aspect-adaptive camera framing for 20x26 island
    const initFrame = this.computeIdealFraming(24.8, 32.0);
    this.camPolar = initFrame.polar;
    this.camGoalPolar = initFrame.polar;
    this.camRadius = Math.max(14, Math.min(96, initFrame.radius));
    this.camGoalRadius = this.camRadius;
    this.camTarget.set(10, 0, 13 + initFrame.zBias);
    this.camGoalTarget.copy(this.camTarget);

    this.bindEvents();
  }

  private computeAdaptivePixelRatio(): number {
    const w = window.innerWidth;
    return Math.min(window.devicePixelRatio || 1, w < 820 ? 1.75 : 2.0);
  }

  private getPlayerMedallionMaterial(
    playerColor: string
  ): THREE.MeshStandardMaterial {
    let mat = this.playerMedallionMats.get(playerColor);
    if (!mat) {
      const blended = new THREE.Color(playerColor).lerp(
        new THREE.Color('#c8644b'),
        0.24
      );
      mat = new THREE.MeshStandardMaterial({
        color: blended,
        roughness: 0.76,
        metalness: 0.04,
      });
      this.playerMedallionMats.set(playerColor, mat);
    }
    return mat;
  }

  private setupLightingAndEnvironment() {
    // Golden-Hour Sun + Sky/Meadow Hemisphere Bounce + Pastel Shadow Fill
    const hemiLight = new THREE.HemisphereLight('#f0f9ff', '#68a852', 1.05);
    this.scene.add(hemiLight);

    this.sunLight = new THREE.DirectionalLight('#fff5e4', 1.85);
    this.sunLight.position.set(36, 52, 41);
    this.sunLight.castShadow = true;
    const shadowRes = window.innerWidth < 820 ? 1024 : 2048;
    this.sunLight.shadow.mapSize.set(shadowRes, shadowRes);
    this.sunLight.shadow.camera.near = 4;
    this.sunLight.shadow.camera.far = 155;
    this.sunLight.shadow.bias = -0.00035;
    this.sunLight.shadow.normalBias = 0.02;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
    this.updateSunShadowFrustum(true);

    const fillLight = new THREE.DirectionalLight('#bae6fd', 0.35);
    fillLight.position.set(-28, 36, -32);
    this.scene.add(fillLight);

    // Tranquil Cerulean Sea surrounding all islands (640x640 seamless horizon)
    this.voidSeaMat = createTranquilSeaShader();
    const seaGeo = new THREE.PlaneGeometry(640, 640);
    seaGeo.rotateX(-Math.PI / 2);
    this.seaMesh = new THREE.Mesh(seaGeo, this.voidSeaMat);
    this.seaMesh.position.set(10, -0.65, 13);
    this.scene.add(this.seaMesh);
  }

  /**
   * Dynamically focuses the Sun's orthographic shadow frustum on `this.camTarget`
   * (`d = 21` for focused island, `d = 62` for arena overview) with texel-snapping
   * so pillar & runner shadows are 3x crisper with zero edge swimming.
   */
  private updateSunShadowFrustum(forceProjection = false) {
    const d = this.arenaOverviewMode ? 62 : 21;
    if (forceProjection || d !== this.lastShadowFrustumD) {
      this.lastShadowFrustumD = d;
      const cam = this.sunLight.shadow.camera;
      cam.left = -d;
      cam.right = d;
      cam.top = d;
      cam.bottom = -d;
      cam.updateProjectionMatrix();
    }

    const mapW = this.sunLight.shadow.mapSize.width || 1024;
    const texelWorld = (d * 2) / mapW;
    const snapX = Math.round(this.camTarget.x / texelWorld) * texelWorld;
    const snapZ = Math.round(this.camTarget.z / texelWorld) * texelWorld;

    this.sunLight.target.position.set(snapX, 0, snapZ);
    this.sunLight.target.updateMatrixWorld();
    this.sunLight.position.set(snapX + 26, 52, snapZ + 28);
  }

  /**
   * Computes aspect-adaptive camera distance & polar angle using BOTH vertical FOV
   * and horizontal FOV (`2 * atan(tan(vFov / 2) * aspect)`) plus symmetric HUD insets
   * (`topHudPx = w <= 980 ? 114 : 62`, `bottomHudPx = isRunPhase ? 16 : 76`) so the full
   * 20x26 island, gates, and cliffs fit 100% cleanly on `360x800`, `390x844`, and desktop.
   */
  private computeIdealFraming(
    spanW: number,
    spanH: number,
    reliefH = 2.0
  ): { radius: number; polar: number; zBias: number } {
    const w = Math.max(280, this.container.clientWidth || window.innerWidth);
    const h = Math.max(320, this.container.clientHeight || window.innerHeight);
    const aspect = w / h;
    const isPortrait = aspect < 0.95;
    const polar = isPortrait ? 0.36 : 0.5;

    const vFovRad = THREE.MathUtils.degToRad(this.camera.fov);
    const tanHalfV = Math.tan(vFovRad * 0.5);
    const hFovRad = 2 * Math.atan(tanHalfV * aspect);
    const tanHalfH = Math.tan(hFovRad * 0.5);

    // Account for perspective foreshortening at the near (+Z) edge of the island
    const usableX = isPortrait ? 0.93 : 0.9;
    const nearZDepthOffset = spanH * 0.45 * Math.sin(polar);
    const distForWidth =
      (spanW * 0.5) / (usableX * tanHalfH) + nearZDepthOffset;

    // Symmetric HUD inset accounting for 2-row mobile top bar vs bottom build dock
    const isRunPhase = this.currentRoomState?.phase === 'RUN';
    const topHudPx = w <= 980 ? 114 : 62;
    const bottomHudPx = isRunPhase ? 16 : 76;
    const clearFracY = Math.max(0.54, (h - topHudPx - bottomHudPx - 16) / h);
    const usableY = Math.min(isPortrait ? 0.72 : 0.82, clearFracY);

    const projectedHalfH =
      spanH * 0.5 * Math.cos(polar) + reliefH * Math.sin(polar);
    const distForHeight = projectedHalfH / (usableY * tanHalfV);

    const radius = Math.max(distForWidth, distForHeight);
    // Camera sits at +Z looking -Z: negative zBias shifts the island gently downward away from the 2-row mobile top HUD!
    const zBias = w <= 980 ? -0.65 : 0.75;
    return { radius, polar, zBias };
  }

  private clampCameraRadius(r: number): number {
    const maxR = this.arenaOverviewMode
      ? Math.max(96, this.camGoalRadius, 135)
      : 96;
    return Math.max(14, Math.min(maxR, r));
  }

  private clampCameraTarget() {
    if (!this.currentRoomState) return;
    const gw = this.currentRoomState.roundConfig.gridWidth;
    const gh = this.currentRoomState.roundConfig.gridHeight;

    if (this.arenaOverviewMode) {
      const count = Math.max(1, this.currentRoomState.players.length);
      const cols = Math.min(3, count);
      const rows = Math.ceil(count / 3);
      const maxX = (cols - 1) * ISLAND_SPACING_X + gw + 4;
      const maxZ = (rows - 1) * ISLAND_SPACING_Z + gh + 5;
      this.camGoalTarget.x = Math.max(-4, Math.min(maxX, this.camGoalTarget.x));
      this.camGoalTarget.z = Math.max(-4, Math.min(maxZ, this.camGoalTarget.z));
      return;
    }

    const targetPid = this.focusedPlayerId || this.localPlayerId;
    const island = targetPid ? this.islands.get(targetPid) : undefined;
    const ox = island ? island.offsetX : 0;
    const oz = island ? island.offsetZ : 0;

    this.camGoalTarget.x = Math.max(
      ox - 3.5,
      Math.min(ox + gw + 3.5, this.camGoalTarget.x)
    );
    this.camGoalTarget.z = Math.max(
      oz - 3.5,
      Math.min(oz + gh + 4.5, this.camGoalTarget.z)
    );
  }

  private panCameraByScreenDelta(dxPx: number, dyPx: number) {
    const h = Math.max(
      320,
      this.renderer.domElement.clientHeight || window.innerHeight
    );
    const vFovRad = THREE.MathUtils.degToRad(this.camera.fov);
    const worldPerPx = (2 * this.camRadius * Math.tan(vFovRad * 0.5)) / h;

    const cosA = Math.cos(this.camAzimuth);
    const sinA = Math.sin(this.camAzimuth);
    const zTiltComp = 1 / Math.max(0.55, Math.cos(this.camPolar));

    const rightDelta = dxPx * worldPerPx;
    const forwardDelta = dyPx * worldPerPx * zTiltComp;

    this.camGoalTarget.x -= rightDelta * cosA + forwardDelta * sinA;
    this.camGoalTarget.z -= -rightDelta * sinA + forwardDelta * cosA;
    this.clampCameraTarget();
  }

  /**
   * Raycasts screen coordinates against all islands in Arena Overview mode,
   * matching either `hitPlane` or the island's sculpted rim footprint.
   */
  private raycastAnyIsland(
    clientX: number,
    clientY: number
  ): IslandVisuals | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);

    for (const isl of this.islands.values()) {
      if (this.raycaster.intersectObject(isl.hitPlane).length > 0) {
        return isl;
      }
    }

    const groundPt = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.groundPlane, groundPt)) {
      const gw = this.currentRoomState?.roundConfig.gridWidth || 20;
      const gh = this.currentRoomState?.roundConfig.gridHeight || 26;
      for (const isl of this.islands.values()) {
        const rx = groundPt.x - isl.offsetX;
        const rz = groundPt.z - isl.offsetZ;
        if (rx >= -2.6 && rx <= gw + 2.6 && rz >= -2.6 && rz <= gh + 2.6) {
          return isl;
        }
      }
    }

    return null;
  }

  private bindEvents() {
    const dom = this.renderer.domElement;

    window.addEventListener('resize', () => {
      const w = this.container.clientWidth || window.innerWidth;
      const h = this.container.clientHeight || window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setPixelRatio(this.computeAdaptivePixelRatio());
      this.renderer.setSize(w, h);

      if (this.arenaOverviewMode) {
        this.focusArenaOverview(true);
      } else if (this.focusedPlayerId || this.localPlayerId) {
        this.focusOnPlayerIsland(
          (this.focusedPlayerId || this.localPlayerId)!,
          true
        );
      } else {
        const frame = this.computeIdealFraming(24.8, 32.0);
        this.camGoalPolar = frame.polar;
        this.camPolar = frame.polar;
        this.camGoalRadius = Math.min(96, frame.radius);
        this.camRadius = this.camGoalRadius;
      }
    });

    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.ctrlKey || e.metaKey) return;
      this.keysDown.add(e.key.toLowerCase());
    });

    window.addEventListener('keyup', (e) => {
      this.keysDown.delete(e.key.toLowerCase());
    });

    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    // ------------------------------------------------------------------------
    // POINTER DOWN (Touch State Machine vs Desktop Mouse)
    // ------------------------------------------------------------------------
    dom.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        this.activeTouches.set(e.pointerId, {
          x: e.clientX,
          y: e.clientY,
          startX: e.clientX,
          startY: e.clientY,
        });

        if (this.activeTouches.size === 1) {
          this.touchGestureMoved = false;
        } else if (this.activeTouches.size >= 2) {
          // 2-finger pinch/pan immediately cancels any tap placement!
          this.touchGestureMoved = true;
          const pts = Array.from(this.activeTouches.values());
          this.lastPinchDist = Math.hypot(
            pts[1].x - pts[0].x,
            pts[1].y - pts[0].y
          );
          this.lastPinchMid = {
            x: (pts[0].x + pts[1].x) * 0.5,
            y: (pts[0].y + pts[1].y) * 0.5,
          };
        }
        // NEVER place or sell on pointerdown for touch!
        return;
      }

      // Desktop mouse controls
      const rect = dom.getBoundingClientRect();
      this.lastPointerScreen = { x: e.clientX, y: e.clientY };
      this.mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        this.isDraggingCamera = true;
        this.dragStart = { x: e.clientX, y: e.clientY };
        return;
      }

      if (e.button === 2) {
        if (this.dismissTransientUI?.()) return;
        if (
          !this.arenaOverviewMode &&
          this.currentRoomState?.phase === 'BUILD' &&
          (!this.focusedPlayerId || this.focusedPlayerId === this.localPlayerId)
        ) {
          this.updateBuildHover();
          if (this.hoveredExistingTower) {
            this.onSellTower?.(this.hoveredExistingTower.id);
            return;
          }
        }
        this.isDraggingCamera = true;
        this.dragStart = { x: e.clientX, y: e.clientY };
        return;
      }

      if (e.button === 0) {
        if (this.dismissTransientUI?.()) return;
        if (this.pendingTouchCell || this.pendingTouchTowerId) {
          this.doClearTouchPreview();
        }

        const isSpectatingOther =
          this.focusedPlayerId !== null &&
          this.focusedPlayerId !== this.localPlayerId;

        if (
          this.arenaOverviewMode ||
          isSpectatingOther ||
          this.currentRoomState?.phase !== 'BUILD'
        ) {
          this.isLeftMouseDown = true;
          this.leftMouseStart = { x: e.clientX, y: e.clientY };
          this.dragStart = { x: e.clientX, y: e.clientY };
          this.leftMousePanned = false;
          this.leftMouseCanPan = true;
          return;
        }

        this.updateBuildHover();

        // Starting outside buildable grass during BUILD allows smooth left-mouse drag panning!
        if (!this.mouseOverLocalGrass) {
          this.isLeftMouseDown = true;
          this.leftMouseStart = { x: e.clientX, y: e.clientY };
          this.dragStart = { x: e.clientX, y: e.clientY };
          this.leftMousePanned = false;
          this.leftMouseCanPan = true;
          return;
        }

        if (this.activeTool === 'SELL') {
          if (this.hoveredExistingTower) {
            this.onSellTower?.(this.hoveredExistingTower.id);
          }
          return;
        }

        if (this.hoveredCell) {
          this.onPlaceTower?.(this.hoveredCell.x, this.hoveredCell.y);
        }
      }
    });

    // ------------------------------------------------------------------------
    // POINTER MOVE (2-Finger Pinch/Pan, 1-Finger Pan, or Desktop Hover/Drag)
    // ------------------------------------------------------------------------
    dom.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') {
        const tracked = this.activeTouches.get(e.pointerId);
        if (!tracked) return;

        const prevX = tracked.x;
        const prevY = tracked.y;
        tracked.x = e.clientX;
        tracked.y = e.clientY;

        if (this.activeTouches.size >= 2) {
          this.touchGestureMoved = true;
          const pts = Array.from(this.activeTouches.values());
          const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
          const mid = {
            x: (pts[0].x + pts[1].x) * 0.5,
            y: (pts[0].y + pts[1].y) * 0.5,
          };

          if (this.lastPinchDist > 8 && dist > 8) {
            const pinchScale = this.lastPinchDist / dist;
            this.camGoalRadius = this.clampCameraRadius(
              this.camGoalRadius * pinchScale
            );
          }

          const midDx = mid.x - this.lastPinchMid.x;
          const midDy = mid.y - this.lastPinchMid.y;
          if (Math.abs(midDx) > 0.1 || Math.abs(midDy) > 0.1) {
            this.panCameraByScreenDelta(midDx, midDy);
          }

          this.lastPinchDist = dist;
          this.lastPinchMid = mid;
          return;
        }

        if (this.activeTouches.size === 1) {
          const totalDist = Math.hypot(
            tracked.x - tracked.startX,
            tracked.y - tracked.startY
          );
          if (!this.touchGestureMoved && totalDist > 9) {
            this.touchGestureMoved = true;
          }
          if (this.touchGestureMoved) {
            this.panCameraByScreenDelta(tracked.x - prevX, tracked.y - prevY);
          }
        }
        return;
      }

      // Desktop mouse move
      const rect = dom.getBoundingClientRect();
      this.lastPointerScreen = { x: e.clientX, y: e.clientY };
      this.mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      if (this.isDraggingCamera) {
        const dx = e.clientX - this.dragStart.x;
        const dy = e.clientY - this.dragStart.y;
        this.dragStart = { x: e.clientX, y: e.clientY };

        if (e.buttons === 4 || (e.buttons === 2 && e.shiftKey)) {
          this.camGoalAzimuth -= dx * 0.006;
        } else {
          this.panCameraByScreenDelta(dx, dy);
        }
        return;
      }

      if (this.isLeftMouseDown && this.leftMouseCanPan) {
        const distFromStart = Math.hypot(
          e.clientX - this.leftMouseStart.x,
          e.clientY - this.leftMouseStart.y
        );
        if (!this.leftMousePanned && distFromStart > 6) {
          this.leftMousePanned = true;
          this.dragStart = { x: e.clientX, y: e.clientY };
        }
        if (this.leftMousePanned) {
          const dx = e.clientX - this.dragStart.x;
          const dy = e.clientY - this.dragStart.y;
          this.dragStart = { x: e.clientX, y: e.clientY };
          this.panCameraByScreenDelta(dx, dy);
          return;
        }
      }

      if (!this.pendingTouchCell && !this.pendingTouchTowerId) {
        this.updateBuildHover();
      }
    });

    // ------------------------------------------------------------------------
    // POINTER UP / CANCEL (Commit 1-Finger Touch Tap <= 9px or Overview Click <= 6px)
    // ------------------------------------------------------------------------
    const handlePointerEnd = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        const tracked = this.activeTouches.get(e.pointerId);
        this.activeTouches.delete(e.pointerId);

        if (this.activeTouches.size >= 2) {
          const pts = Array.from(this.activeTouches.values());
          this.lastPinchDist = Math.hypot(
            pts[1].x - pts[0].x,
            pts[1].y - pts[0].y
          );
          this.lastPinchMid = {
            x: (pts[0].x + pts[1].x) * 0.5,
            y: (pts[0].y + pts[1].y) * 0.5,
          };
          return;
        }

        if (this.activeTouches.size === 1) {
          return;
        }

        // All fingers lifted
        const wasCleanTap =
          e.type === 'pointerup' &&
          tracked !== undefined &&
          !this.touchGestureMoved &&
          Math.hypot(e.clientX - tracked.startX, e.clientY - tracked.startY) <=
            9;

        this.touchGestureMoved = false;
        this.lastPinchDist = 0;

        if (wasCleanTap) {
          if (this.dismissTransientUI?.()) return;
          this.handleTouchTap(e.clientX, e.clientY);
        }
        return;
      }

      if (this.isLeftMouseDown) {
        const wasCleanClick =
          e.type === 'pointerup' &&
          !this.leftMousePanned &&
          Math.hypot(
            e.clientX - this.leftMouseStart.x,
            e.clientY - this.leftMouseStart.y
          ) <= 6;
        this.isLeftMouseDown = false;
        this.leftMouseCanPan = false;
        this.leftMousePanned = false;

        if (wasCleanClick && this.arenaOverviewMode) {
          const hitIsland = this.raycastAnyIsland(e.clientX, e.clientY);
          if (hitIsland) {
            this.doClearTouchPreview();
            this.focusOnPlayerIsland(hitIsland.playerId);
            this.onFocusChange?.();
          }
        }
      }

      this.isDraggingCamera = false;
    };

    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);

    dom.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return;
      this.mouseNDC.set(-99, -99);
      if (!this.pendingTouchCell && !this.pendingTouchTowerId) {
        this.updateBuildHover();
      }
    });

    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.camGoalRadius = this.clampCameraRadius(
          this.camGoalRadius + e.deltaY * 0.022
        );
      },
      { passive: false }
    );
  }

  /**
   * Projects a 3D world position to viewport pixel coordinates.
   */
  private projectWorldToScreen(worldPos: THREE.Vector3): {
    x: number;
    y: number;
    visible: boolean;
  } {
    this.camera.updateMatrixWorld();
    const projected = worldPos.clone().project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    const w = rect.width || window.innerWidth;
    const h = rect.height || window.innerHeight;
    return {
      x: rect.left + (projected.x * 0.5 + 0.5) * w,
      y: rect.top + (-projected.y * 0.5 + 0.5) * h,
      visible: projected.z <= 1,
    };
  }

  private isTouchProjectionOffscreen(proj: {
    x: number;
    y: number;
    visible: boolean;
  }): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const w = rect.width || window.innerWidth;
    const h = rect.height || window.innerHeight;
    return (
      !proj.visible ||
      proj.x < 12 ||
      proj.x > w - 12 ||
      proj.y < 84 ||
      proj.y > h - 52
    );
  }

  /**
   * Clears any active mobile touch ghost preview or selected pillar state.
   */
  public clearTouchPreview?: () => void = () => {
    this.doClearTouchPreview();
  };

  private doClearTouchPreview(): void {
    this.pendingTouchCell = null;
    this.pendingTouchTowerId = null;
    this.activeTouchHoverInfo = null;
    this.hoveredCell = null;
    this.hoveredExistingTower = null;

    this.ghostGroup.visible = false;
    this.ghostGroup.scale.set(1, 1, 1);
    this.ghostConnGroup.clear();
    this.clearPreviewPathMesh();

    if (this.localPlayerId) {
      const localIsland = this.islands.get(this.localPlayerId);
      if (localIsland) {
        localIsland.floorUniforms.uCursorPos.value.set(-99, -99);
        for (const sr of localIsland.spireRigs) {
          sr.targetHoverBoost = 0;
        }
        if (this.cachedBaseEval) {
          this.populateClapMarkers(
            localIsland,
            this.cachedBaseEval.clapLocations,
            false
          );
          this.applySpireOverchargeVisuals(
            localIsland,
            this.cachedBaseEval.spireOverchargeTiers
          );
        }
      }
    }

    this.onHoverStatusChange?.({
      cell: null,
      screenX: this.lastPointerScreen.x,
      screenY: this.lastPointerScreen.y,
      valid: false,
    });
  }

  /**
   * Resets camera target, zoom radius, and azimuth to clean aspect-adaptive framing.
   */
  public resetCameraView?: () => void = () => {
    this.doResetCameraView();
  };

  private doResetCameraView(): void {
    if (this.arenaOverviewMode) {
      this.focusArenaOverview();
    } else if (this.focusedPlayerId || this.localPlayerId) {
      this.focusOnPlayerIsland((this.focusedPlayerId || this.localPlayerId)!);
    }
  }

  /**
   * Handles a clean 1-finger touch tap (`<= 9px` movement) with Arena Overview Focus
   * and Two-Stage Touch Preview & Reclaim.
   */
  private handleTouchTap(clientX: number, clientY: number) {
    if (this.arenaOverviewMode) {
      this.doClearTouchPreview();
      const hitIsland = this.raycastAnyIsland(clientX, clientY);
      if (hitIsland) {
        this.focusOnPlayerIsland(hitIsland.playerId);
        this.onFocusChange?.();
      }
      return;
    }

    const isSpectatingOther =
      this.focusedPlayerId !== null &&
      this.focusedPlayerId !== this.localPlayerId;

    if (
      !this.currentRoomState ||
      this.currentRoomState.phase !== 'BUILD' ||
      !this.localPlayerId ||
      isSpectatingOther
    ) {
      this.doClearTouchPreview();
      return;
    }

    const localIsland = this.islands.get(this.localPlayerId);
    const localPlayer = this.currentRoomState.players.find(
      (p) => p.id === this.localPlayerId
    );
    if (!localIsland || !localPlayer) {
      this.doClearTouchPreview();
      return;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.lastPointerScreen = { x: clientX, y: clientY };

    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(localIsland.hitPlane);
    if (hits.length === 0) {
      this.doClearTouchPreview();
      return;
    }

    const hitPt = hits[0].point;
    const relX = hitPt.x - localIsland.offsetX;
    const relZ = hitPt.z - localIsland.offsetZ;
    const round = this.currentRoomState.roundConfig;
    const cellX = Math.floor(relX);
    const cellY = Math.floor(relZ);

    const existing =
      localPlayer.towers.find(
        (t) =>
          cellX >= t.x &&
          cellX < t.x + 2 &&
          cellY >= t.y &&
          cellY < t.y + 2
      ) || null;

    // 1. Direct SELL tool tap
    if (this.activeTool === 'SELL') {
      this.doClearTouchPreview();
      if (existing) {
        this.onSellTower?.(existing.id);
      }
      return;
    }

    // 2. Tapped an existing player Castle Pillar -> Two-stage Touch Reclaim
    if (existing) {
      if (this.pendingTouchTowerId === existing.id) {
        this.doClearTouchPreview();
        this.onSellTower?.(existing.id);
        return;
      }

      this.pendingTouchCell = null;
      this.pendingTouchTowerId = existing.id;
      this.applyTouchSelectionVisuals();
      return;
    }

    // 3. Tapped buildable grass (`activeTool === 'BLOCK'`) -> Two-stage Touch Ghost Preview
    const placeX = Math.max(
      0,
      Math.min(round.gridWidth - 2, Math.round(relX - 1))
    );
    const placeY = Math.max(
      0,
      Math.min(round.gridHeight - 2, Math.round(relZ - 1))
    );

    const validation = validateTowerPlacement(
      round,
      localPlayer.towers,
      placeX,
      placeY
    );

    if (
      this.pendingTouchCell &&
      this.pendingTouchCell.x === placeX &&
      this.pendingTouchCell.y === placeY
    ) {
      this.doClearTouchPreview();
      if (validation.valid) {
        this.onPlaceTower?.(placeX, placeY);
      }
      return;
    }

    this.pendingTouchTowerId = null;
    this.pendingTouchCell = { x: placeX, y: placeY };
    this.applyTouchSelectionVisuals();
  }

  /**
   * Renders 3D ghost / reclaim highlight for active mobile touch preview and emits
   * `onHoverStatusChange` with `isTouchPreview: true` and confirm/cancel callbacks.
   */
  private applyTouchSelectionVisuals() {
    if (
      !this.currentRoomState ||
      this.currentRoomState.phase !== 'BUILD' ||
      !this.localPlayerId ||
      this.arenaOverviewMode
    ) {
      this.doClearTouchPreview();
      return;
    }

    const localIsland = this.islands.get(this.localPlayerId);
    const localPlayer = this.currentRoomState.players.find(
      (p) => p.id === this.localPlayerId
    );
    if (!localIsland || !localPlayer) return;

    const round = this.currentRoomState.roundConfig;

    // Case A: Reclaim existing player pillar preview
    if (this.pendingTouchTowerId) {
      const existing = localPlayer.towers.find(
        (t) => t.id === this.pendingTouchTowerId
      );
      if (!existing) {
        this.doClearTouchPreview();
        return;
      }

      this.clearPreviewPathMesh();
      this.ghostConnGroup.clear();
      localIsland.floorUniforms.uCursorPos.value.set(
        existing.x + 1.0,
        existing.y + 1.0
      );

      this.ghostGroup.visible = true;
      this.ghostGroup.scale.set(1.05, 1.03, 1.05);
      this.ghostGroup.position.set(
        localIsland.offsetX + existing.x + 1.0,
        0,
        localIsland.offsetZ + existing.y + 1.0
      );
      this.setGhostTint(false);

      if (this.cachedBaseEval) {
        this.populateClapMarkers(
          localIsland,
          this.cachedBaseEval.clapLocations,
          false
        );
        this.applySpireOverchargeVisuals(
          localIsland,
          this.cachedBaseEval.spireOverchargeTiers
        );
      }

      this.touchWorldAnchor.set(
        localIsland.offsetX + existing.x + 1.0,
        1.48,
        localIsland.offsetZ + existing.y + 1.0
      );
      const proj = this.projectWorldToScreen(this.touchWorldAnchor);
      const isGestureMoving =
        this.activeTouches.size > 0 && this.touchGestureMoved;
      const offscreen = this.isTouchProjectionOffscreen(proj);

      const towerId = existing.id;
      const info: HoverStatusInfo = {
        cell: { x: existing.x, y: existing.y },
        screenX: proj.x,
        screenY: proj.y,
        valid: true,
        reason: 'Refund Pillar',
        existingTower: existing,
        isTouchPreview: true,
        isGestureMoving,
        offscreen,
        onConfirmTouchAction: () => {
          this.doClearTouchPreview();
          this.onSellTower?.(towerId);
        },
        onCancelTouchAction: () => {
          this.doClearTouchPreview();
        },
      };
      this.activeTouchHoverInfo = info;
      this.onHoverStatusChange?.(info);
      return;
    }

    // Case B: New 2x2 Pillar Placement Ghost Preview
    if (this.pendingTouchCell) {
      const { x: placeX, y: placeY } = this.pendingTouchCell;
      this.hoveredCell = { x: placeX, y: placeY };
      this.hoveredExistingTower = null;

      localIsland.floorUniforms.uCursorPos.value.set(
        placeX + 1.0,
        placeY + 1.0
      );

      const preview = this.buildGhostAndPathPreview(
        localIsland,
        localPlayer,
        round,
        placeX,
        placeY
      );

      this.touchWorldAnchor.set(
        localIsland.offsetX + placeX + 1.0,
        1.48,
        localIsland.offsetZ + placeY + 1.0
      );
      const proj = this.projectWorldToScreen(this.touchWorldAnchor);
      const isGestureMoving =
        this.activeTouches.size > 0 && this.touchGestureMoved;
      const offscreen = this.isTouchProjectionOffscreen(proj);
      const isValid = preview.valid;

      const info: HoverStatusInfo = {
        cell: { x: placeX, y: placeY },
        screenX: proj.x,
        screenY: proj.y,
        valid: isValid,
        reason: preview.reason,
        deltaTime: preview.deltaTime,
        deltaClaps: preview.deltaClaps,
        deltaKeeps: preview.deltaKeeps,
        deltaOvercharge: preview.deltaOvercharge,
        previewTime: preview.previewTime,
        existingTower: null,
        isTouchPreview: true,
        isGestureMoving,
        offscreen,
        onConfirmTouchAction: () => {
          if (isValid) {
            this.doClearTouchPreview();
            this.onPlaceTower?.(placeX, placeY);
          }
        },
        onCancelTouchAction: () => {
          this.doClearTouchPreview();
        },
      };
      this.activeTouchHoverInfo = info;
      this.onHoverStatusChange?.(info);
    }
  }

  public focusOnPlayerIsland(playerId: string, snapImmediate = false) {
    this.arenaOverviewMode = false;
    this.focusedPlayerId = playerId;
    if (
      playerId !== this.localPlayerId &&
      (this.pendingTouchCell || this.pendingTouchTowerId)
    ) {
      this.doClearTouchPreview();
    }
    const island = this.islands.get(playerId);
    if (!island || !this.currentRoomState) return;

    const gw = this.currentRoomState.roundConfig.gridWidth;
    const gh = this.currentRoomState.roundConfig.gridHeight;
    const frame = this.computeIdealFraming(gw + 4.8, gh + 6.0);

    this.camGoalTarget.set(
      island.offsetX + gw / 2,
      0,
      island.offsetZ + gh / 2 + frame.zBias
    );
    this.camGoalPolar = frame.polar;
    this.camGoalRadius = Math.max(14, Math.min(96, frame.radius));
    this.camGoalAzimuth = 0;

    if (snapImmediate) {
      this.camTarget.copy(this.camGoalTarget);
      this.camPolar = this.camGoalPolar;
      this.camRadius = this.camGoalRadius;
      this.camAzimuth = 0;
    }
    this.updateSunShadowFrustum();
  }

  public focusArenaOverview(snapImmediate = false) {
    this.arenaOverviewMode = true;
    if (this.pendingTouchCell || this.pendingTouchTowerId) {
      this.doClearTouchPreview();
    } else {
      this.ghostGroup.visible = false;
      this.ghostConnGroup.clear();
      this.clearPreviewPathMesh();
    }
    if (!this.currentRoomState) return;

    const count = Math.max(1, this.currentRoomState.players.length);
    const cols = Math.min(3, count);
    const rows = Math.ceil(count / 3);
    const gw = this.currentRoomState.roundConfig.gridWidth;
    const gh = this.currentRoomState.roundConfig.gridHeight;

    const centerX = ((cols - 1) * ISLAND_SPACING_X + gw) / 2;
    const centerZ = ((rows - 1) * ISLAND_SPACING_Z + gh) / 2;
    const totalW = (cols - 1) * ISLAND_SPACING_X + gw + 5.6;
    const totalH = (rows - 1) * ISLAND_SPACING_Z + gh + 7.2;

    const frame = this.computeIdealFraming(totalW, totalH, 2.5);
    this.camGoalTarget.set(centerX, 0, centerZ + frame.zBias * 0.6);
    this.camGoalPolar = frame.polar;
    this.camGoalRadius = Math.max(24, Math.min(135, frame.radius));
    this.camGoalAzimuth = 0;

    if (snapImmediate) {
      this.camTarget.copy(this.camGoalTarget);
      this.camPolar = this.camGoalPolar;
      this.camRadius = this.camGoalRadius;
      this.camAzimuth = 0;
    }
    this.updateSunShadowFrustum();
  }

  private computeLayoutSignature(round: RoundConfig): string {
    const sStr = round.preplacedSpires
      .map((s) => `${s.x},${s.y},${s.spireType || 'THUNDERCLAP'}`)
      .join(';');
    const oStr = round.obstacles.map((o) => `${o.x},${o.y}`).join(';');
    return `${round.roundNumber}|${round.spawn.x},${round.spawn.y}|${round.exit.x},${round.exit.y}|${round.runnerType || 'SCOUT'}|${sStr}|${oStr}`;
  }

  public syncRoomState(state: RoomState, localPlayerId: string | null) {
    const firstSync = !this.currentRoomState;
    const newSig = this.computeLayoutSignature(state.roundConfig);
    const layoutChanged = newSig !== this.lastLayoutSignature;
    this.lastLayoutSignature = newSig;

    this.currentRoomState = state;
    this.localPlayerId = localPlayerId;

    // Dynamically center Tranquil Cerulean Sea on the active multi-island arena bounds
    const count = Math.max(1, state.players.length);
    const cols = Math.min(3, count);
    const rows = Math.ceil(count / 3);
    const arenaCenterX =
      ((cols - 1) * ISLAND_SPACING_X + state.roundConfig.gridWidth) * 0.5;
    const arenaCenterZ =
      ((rows - 1) * ISLAND_SPACING_Z + state.roundConfig.gridHeight) * 0.5;
    this.seaMesh.position.set(arenaCenterX, -0.65, arenaCenterZ);
    this.voidSeaMat.uniforms.uArenaCenter.value.set(arenaCenterX, arenaCenterZ);

    const activeIds = new Set(state.players.map((p) => p.id));
    for (const [pid, isl] of this.islands.entries()) {
      if (!activeIds.has(pid)) {
        if (isl.pathMesh) isl.pathMesh.geometry.dispose();
        this.scene.remove(isl.root);
        this.islands.delete(pid);
        this.labelElements.get(pid)?.remove();
        this.labelElements.delete(pid);
        this.runnerLabels.get(pid)?.remove();
        this.runnerLabels.delete(pid);
      }
    }

    state.players.forEach((player, index) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      const offsetX = col * ISLAND_SPACING_X;
      const offsetZ = row * ISLAND_SPACING_Z;

      let island = this.islands.get(player.id);
      if (!island) {
        island = this.createIslandVisuals(
          player,
          state.roundConfig,
          offsetX,
          offsetZ
        );
        this.islands.set(player.id, island);
      } else {
        island.offsetX = offsetX;
        island.offsetZ = offsetZ;
        island.root.position.set(offsetX, 0, offsetZ);
        if (layoutChanged) {
          this.rebuildIslandPadsAndObstacles(island, state.roundConfig);
        }
      }

      this.syncIslandTowersAndPath(
        island,
        player,
        state.roundConfig,
        firstSync || layoutChanged
      );
      this.updateIslandHeaderBadge(player);
    });

    const localPlayer = state.players.find((p) => p.id === localPlayerId);
    if (localPlayer) {
      this.cachedBaseEval = evaluateMazeRunTime(
        state.roundConfig,
        localPlayer.towers
      );
    }

    if (firstSync && localPlayerId) {
      this.focusOnPlayerIsland(localPlayerId, true);
    }

    if (state.phase !== 'BUILD' || layoutChanged) {
      if (this.pendingTouchCell || this.pendingTouchTowerId) {
        this.doClearTouchPreview();
      } else {
        this.updateBuildHover();
      }
    } else if (this.pendingTouchCell || this.pendingTouchTowerId) {
      // Preserve active mobile touch preview across bot/multiplayer ROOM_STATE ticks!
      this.applyTouchSelectionVisuals();
    } else {
      this.updateBuildHover();
    }
  }

  /**
   * Builds a clean, smooth-shaded miniature Cypress/Pine cluster for outer corner scale charm.
   */
  private buildMiniatureCypressCluster(scale = 1.0): THREE.Group {
    const cluster = new THREE.Group();

    const specs = [
      { dx: 0, dz: 0, h: 1.15, r: 0.34, matIdx: 0 },
      { dx: 0.38, dz: 0.24, h: 0.86, r: 0.27, matIdx: 1 },
    ];

    for (const s of specs) {
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.09, 0.28, 6),
        this.cypressTrunkMat
      );
      trunk.position.set(s.dx, 0.14, s.dz);
      cluster.add(trunk);

      const foliage = new THREE.Mesh(
        new THREE.ConeGeometry(s.r, s.h, 7),
        this.cypressFoliageMats[s.matIdx]
      );
      foliage.position.set(s.dx, 0.24 + s.h * 0.5, s.dz);
      foliage.castShadow = true;
      foliage.receiveShadow = true;
      cluster.add(foliage);
    }

    cluster.scale.setScalar(scale);
    return cluster;
  }

  /**
   * Builds a clean sculpted warm-limestone cliff segment with smooth sage turf rim
   * (zero noisy bump maps, zero perimeter clutter).
   */
  private createSculptedCliffSegment(
    cx: number,
    cz: number,
    w: number,
    d: number
  ): THREE.Group {
    const seg = new THREE.Group();
    if (w <= 0.2 || d <= 0.2) return seg;

    const talus = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.24, 0.42, d + 0.24),
      this.cliffTalusMat
    );
    talus.position.set(cx, 0.21, cz);
    talus.receiveShadow = true;
    seg.add(talus);

    const cliffBody = new THREE.Mesh(
      new THREE.BoxGeometry(w, 1.16, d),
      this.cliffLimestoneMat
    );
    cliffBody.position.set(cx, 0.58, cz);
    cliffBody.castShadow = true;
    cliffBody.receiveShadow = true;
    seg.add(cliffBody);

    const meadowRim = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.14, 0.18, d + 0.14),
      this.cliffMeadowRimMat
    );
    meadowRim.position.set(cx, 1.25, cz);
    meadowRim.receiveShadow = true;
    seg.add(meadowRim);

    return seg;
  }

  /**
   * Builds the Sunlit Limestone & Sage Meadow Island Basin.
   * Eliminates the 4 giant blue-roofed corner bastions and 80%+ of cliff clutter,
   * tucking only 3-4 clean miniature cypress clusters outside the outer corners.
   */
  private createIslandVisuals(
    player: PlayerState,
    round: RoundConfig,
    offsetX: number,
    offsetZ: number
  ): IslandVisuals {
    const root = new THREE.Group();
    root.position.set(offsetX, 0, offsetZ);

    const gw = round.gridWidth;
    const gh = round.gridHeight;

    // 1. Warm Limestone Island Plinth & Crisp Cream-White Shoreline Foam
    const bankW = gw + 5.2;
    const bankD = gh + 5.2;
    const bank = new THREE.Mesh(
      new THREE.BoxGeometry(bankW, 1.05, bankD),
      this.cliffTalusMat
    );
    bank.position.set(gw / 2, -0.54, gh / 2);
    bank.receiveShadow = true;
    root.add(bank);

    const foamGeo = new THREE.PlaneGeometry(bankW + 3.4, bankD + 3.4);
    foamGeo.rotateX(-Math.PI / 2);
    const foamMat = createShorelineFoamShader(bankW, bankD);
    const foamMesh = new THREE.Mesh(foamGeo, foamMat);
    foamMesh.position.set(gw / 2, -0.62, gh / 2);
    foamMesh.renderOrder = 1;
    root.add(foamMesh);

    // Subtle satin player-colored waterline band
    const trimMat = new THREE.MeshStandardMaterial({
      color: player.color,
      roughness: 0.62,
      metalness: 0.05,
    });
    const trimMesh = new THREE.Mesh(
      new THREE.BoxGeometry(bankW + 0.16, 0.14, bankD + 0.16),
      trimMat
    );
    trimMesh.position.set(gw / 2, -0.1, gh / 2);
    root.add(trimMesh);

    // 2. Lit Velvety Meadow Floor (20x26, receives real directional cast shadows!)
    const floorGeo = new THREE.PlaneGeometry(gw, gh);
    floorGeo.rotateX(-Math.PI / 2);
    const { material: floorMat, uniforms: floorUniforms } =
      createGrasslandFloorMaterial();
    floorUniforms.uGridSize.value.set(gw, gh);
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.position.set(gw / 2, 0.01, gh / 2);
    floorMesh.receiveShadow = true;
    root.add(floorMesh);

    // 3. Clean West & East Sculpted Limestone Cliff Walls
    const rimThick = 2.0;
    root.add(this.createSculptedCliffSegment(-rimThick / 2, gh / 2, rimThick, gh));
    root.add(
      this.createSculptedCliffSegment(gw + rimThick / 2, gh / 2, rimThick, gh)
    );

    // Only 3-4 clean miniature cypress clusters tucked outside outer corners for scale charm
    const cornerClusters = [
      { x: -1.25, z: -1.15, s: 0.92, rot: 0.4 },
      { x: gw + 1.15, z: -1.2, s: 0.85, rot: 2.1 },
      { x: -1.2, z: gh + 1.1, s: 0.88, rot: 1.2 },
      { x: gw + 1.2, z: gh + 1.15, s: 0.95, rot: 3.6 },
    ];
    for (const cc of cornerClusters) {
      const cluster = this.buildMiniatureCypressCluster(cc.s);
      cluster.position.set(cc.x, 1.34, cc.z);
      cluster.rotation.y = cc.rot;
      root.add(cluster);
    }

    // Invisible Raycast Hit Plane covering the exact 20x26 buildable meadow
    const hitGeo = new THREE.PlaneGeometry(gw, gh);
    hitGeo.rotateX(-Math.PI / 2);
    const hitPlane = new THREE.Mesh(
      hitGeo,
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hitPlane.position.set(gw / 2, 0.02, gh / 2);
    root.add(hitPlane);

    const padGroup = new THREE.Group();
    root.add(padGroup);

    const towerGroup = new THREE.Group();
    root.add(towerGroup);

    const bridgeGroup = new THREE.Group();
    root.add(bridgeGroup);

    const clapMarkerGroup = new THREE.Group();
    root.add(clapMarkerGroup);

    // Toy-Box Runner standing right at the North border entrance (y = 0)
    const runner = this.buildArticulatedRunnerRig(
      player.color,
      round.runnerType || 'SCOUT'
    );
    runner.root.position.set(
      round.spawn.x + 1,
      0,
      round.spawn.y === 0 ? 0 : round.spawn.y + 1
    );
    root.add(runner.root);

    this.scene.add(root);

    const visuals: IslandVisuals = {
      playerId: player.id,
      playerColor: player.color,
      root,
      offsetX,
      offsetZ,
      floorMat,
      floorUniforms,
      foamMat,
      trimMesh,
      hitPlane,
      padGroup,
      towerGroup,
      bridgeGroup,
      bridgeEntries: [],
      clapMarkerGroup,
      towerMeshes: new Map(),
      spireRigs: [],
      ruinRigs: [],
      pathMesh: null,
      pathMat: null,
      runner,
      checkpointRings: [],
    };

    this.rebuildIslandPadsAndObstacles(visuals, round);
    this.createIslandDOMElements(player);

    return visuals;
  }

  /**
   * Builds unmistakable *Bad North* Toy-Box Runner rigs with distinct archetype silhouettes & props:
   * - `SCOUT`: Azure tunic, feathered wayfarer hood + compact glowing lantern-staff
   * - `OUTRIDER`: Terracotta-crimson tunic, sweeping gold plume + forward-couched cavalry lance & gold pennant
   * - `JUGGERNAUT`: Heavy slate-iron plate, broad steel pauldrons + wide Heater/Tower Shield (left) & iron warhammer (right)
   * - `HERALD`: Viridian-teal tunic, twin swept-back emerald wind-wings + forked gale rod
   */
  private buildArticulatedRunnerRig(
    playerColor: string,
    runnerType: RunnerArchetype = 'SCOUT'
  ): RunnerRig {
    const root = new THREE.Group();
    if (runnerType === 'JUGGERNAUT') {
      root.scale.set(1.16, 1.12, 1.16);
    }

    // Soft ground contact shadow under feet
    const footShadow = new THREE.Mesh(this.sharedGeos.aoQuad, this.aoDiscMat);
    footShadow.scale.setScalar(0.52);
    footShadow.position.y = 0.016;
    footShadow.renderOrder = 2;
    root.add(footShadow);

    // Flat status ring under Runner's feet (Slow / Frost / Haste)
    const statusRingGeo = new THREE.RingGeometry(0.35, 0.49, 28);
    statusRingGeo.rotateX(-Math.PI / 2);
    const statusRingMat = new THREE.MeshBasicMaterial({
      color: '#f59e0b',
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const statusRing = new THREE.Mesh(statusRingGeo, statusRingMat);
    statusRing.position.y = 0.028;
    statusRing.renderOrder = 7;
    statusRing.visible = false;
    root.add(statusRing);

    const pelvis = new THREE.Group();
    pelvis.position.y = 0.45;
    root.add(pelvis);

    const tunicColor =
      runnerType === 'OUTRIDER'
        ? '#c84b31'
        : runnerType === 'JUGGERNAUT'
        ? '#475569'
        : runnerType === 'HERALD'
        ? '#0d9488'
        : '#2563eb';

    const torsoMesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.33, 0.8, 8),
      new THREE.MeshStandardMaterial({
        color: tunicColor,
        emissive: playerColor,
        emissiveIntensity: 0.14,
        roughness: runnerType === 'JUGGERNAUT' ? 0.38 : 0.62,
        metalness: runnerType === 'JUGGERNAUT' ? 0.45 : 0.12,
      })
    );
    torsoMesh.position.y = 0.25;
    torsoMesh.castShadow = true;
    pelvis.add(torsoMesh);

    if (runnerType === 'JUGGERNAUT') {
      const pauldronMat = new THREE.MeshStandardMaterial({
        color: '#94a3b8',
        roughness: 0.35,
        metalness: 0.55,
      });
      for (const side of [-0.32, 0.32]) {
        const pauldron = new THREE.Mesh(
          new THREE.DodecahedronGeometry(0.18, 0),
          pauldronMat
        );
        pauldron.position.set(side, 0.5, 0);
        pauldron.castShadow = true;
        pelvis.add(pauldron);
      }
    } else if (runnerType === 'HERALD') {
      const wingMat = new THREE.MeshStandardMaterial({
        color: '#6ee7b7',
        emissive: '#10b981',
        emissiveIntensity: 0.3,
        roughness: 0.4,
      });
      for (const side of [-0.23, 0.23]) {
        const wing = new THREE.Mesh(
          new THREE.BoxGeometry(0.06, 0.48, 0.3),
          wingMat
        );
        wing.position.set(side, 0.43, -0.21);
        wing.rotation.y = side > 0 ? 0.38 : -0.38;
        wing.rotation.x = 0.28;
        wing.castShadow = true;
        pelvis.add(wing);
      }
    }

    const headGroup = new THREE.Group();
    headGroup.position.y = 0.73;

    const helmColor =
      runnerType === 'SCOUT'
        ? '#1d4ed8'
        : runnerType === 'HERALD'
        ? '#115e59'
        : '#334155';
    const helm = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.22, 0),
      new THREE.MeshStandardMaterial({
        color: helmColor,
        roughness: runnerType === 'SCOUT' ? 0.65 : 0.45,
        metalness: runnerType === 'SCOUT' ? 0.08 : 0.35,
      })
    );
    helm.castShadow = true;
    headGroup.add(helm);

    if (runnerType === 'SCOUT') {
      // Feathered wayfarer hood crest
      const hoodPeak = new THREE.Mesh(
        new THREE.ConeGeometry(0.16, 0.24, 6),
        new THREE.MeshStandardMaterial({
          color: '#1e40af',
          roughness: 0.7,
        })
      );
      hoodPeak.position.set(0, 0.16, -0.06);
      hoodPeak.rotation.x = -0.45;
      headGroup.add(hoodPeak);

      const feather = new THREE.Mesh(
        new THREE.ConeGeometry(0.055, 0.32, 5),
        new THREE.MeshStandardMaterial({
          color: '#38bdf8',
          emissive: '#0284c7',
          emissiveIntensity: 0.25,
          roughness: 0.45,
        })
      );
      feather.position.set(0.12, 0.24, -0.1);
      feather.rotation.set(-0.55, 0, -0.22);
      headGroup.add(feather);
    } else if (runnerType === 'OUTRIDER') {
      // Sweeping golden cavalry helm plume
      const plume = new THREE.Mesh(
        new THREE.ConeGeometry(0.11, 0.42, 6),
        new THREE.MeshStandardMaterial({
          color: '#fbbf24',
          emissive: '#d97706',
          emissiveIntensity: 0.2,
          roughness: 0.45,
        })
      );
      plume.position.set(0, 0.25, -0.11);
      plume.rotation.x = -0.62;
      plume.castShadow = true;
      headGroup.add(plume);
    }

    const visorColor =
      runnerType === 'OUTRIDER'
        ? '#fbbf24'
        : runnerType === 'JUGGERNAUT'
        ? '#f59e0b'
        : runnerType === 'HERALD'
        ? '#34d399'
        : '#38bdf8';
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.08, 0.1),
      new THREE.MeshBasicMaterial({ color: visorColor })
    );
    visor.position.set(0, 0.01, 0.17);
    headGroup.add(visor);
    pelvis.add(headGroup);

    const armGeo = new THREE.BoxGeometry(0.11, 0.38, 0.11);
    const armMat = new THREE.MeshStandardMaterial({
      color: runnerType === 'JUGGERNAUT' ? '#64748b' : '#f5f0e6',
      roughness: runnerType === 'JUGGERNAUT' ? 0.45 : 0.65,
      metalness: runnerType === 'JUGGERNAUT' ? 0.35 : 0.05,
    });

    const leftArm = new THREE.Group();
    leftArm.position.set(-0.27, 0.46, 0);
    const lArmMesh = new THREE.Mesh(armGeo, armMat);
    lArmMesh.position.y = -0.15;
    leftArm.add(lArmMesh);
    pelvis.add(leftArm);

    const rightArm = new THREE.Group();
    rightArm.position.set(0.27, 0.46, 0);
    const rArmMesh = new THREE.Mesh(armGeo, armMat);
    rArmMesh.position.y = -0.15;
    rightArm.add(rArmMesh);
    pelvis.add(rightArm);

    let accentMesh: THREE.Mesh | null = null;

    if (runnerType === 'JUGGERNAUT') {
      // Chunky wide Heater/Tower Shield on leftArm (angled forward-left so it reads from top-down!)
      const shieldGroup = new THREE.Group();
      shieldGroup.position.set(-0.08, -0.12, 0.24);
      shieldGroup.rotation.set(-0.22, -0.32, 0.08);

      const shieldPlate = new THREE.Mesh(
        new THREE.BoxGeometry(0.46, 0.58, 0.09),
        new THREE.MeshStandardMaterial({
          color: '#334155',
          roughness: 0.38,
          metalness: 0.52,
        })
      );
      shieldPlate.castShadow = true;
      shieldPlate.receiveShadow = true;
      shieldGroup.add(shieldPlate);

      const shieldRim = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.1, 0.11),
        new THREE.MeshStandardMaterial({
          color: '#cbd5e1',
          roughness: 0.32,
          metalness: 0.6,
        })
      );
      shieldRim.position.y = 0.25;
      shieldGroup.add(shieldRim);

      const shieldBoss = new THREE.Mesh(
        new THREE.CylinderGeometry(0.11, 0.13, 0.08, 8),
        new THREE.MeshStandardMaterial({
          color: '#fbbf24',
          emissive: '#d97706',
          emissiveIntensity: 0.28,
          roughness: 0.3,
          metalness: 0.5,
        })
      );
      shieldBoss.rotation.x = Math.PI / 2;
      shieldBoss.position.z = 0.05;
      shieldGroup.add(shieldBoss);
      leftArm.add(shieldGroup);
      leftArm.rotation.x = 0.28;

      // Heavy iron warhammer/mace on rightArm
      const maceShaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.035, 0.86, 6),
        this.cypressTrunkMat
      );
      maceShaft.position.set(0.05, 0.02, 0.18);
      maceShaft.rotation.x = 0.45;
      rightArm.add(maceShaft);

      const maceHead = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.17, 0),
        new THREE.MeshStandardMaterial({
          color: '#64748b',
          roughness: 0.34,
          metalness: 0.62,
        })
      );
      maceHead.position.set(0.05, 0.39, 0.36);
      maceHead.castShadow = true;
      rightArm.add(maceHead);
    } else if (runnerType === 'OUTRIDER') {
      // Forward-couched Cavalry Lance + Gold Pennant on rightArm
      const lanceGroup = new THREE.Group();
      lanceGroup.position.set(0.05, -0.14, 0.34);
      lanceGroup.rotation.x = 1.18; // Couched forward along travel direction!

      const lanceShaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.042, 1.62, 6),
        this.cypressTrunkMat
      );
      lanceShaft.castShadow = true;
      lanceGroup.add(lanceShaft);

      const vamplate = new THREE.Mesh(
        new THREE.ConeGeometry(0.12, 0.18, 8),
        new THREE.MeshStandardMaterial({
          color: '#cbd5e1',
          roughness: 0.32,
          metalness: 0.58,
        })
      );
      vamplate.position.y = -0.22;
      lanceGroup.add(vamplate);

      const lanceTip = new THREE.Mesh(
        new THREE.ConeGeometry(0.055, 0.28, 6),
        new THREE.MeshStandardMaterial({
          color: '#e2e8f0',
          roughness: 0.28,
          metalness: 0.68,
        })
      );
      lanceTip.position.y = 0.92;
      lanceGroup.add(lanceTip);

      const pennant = new THREE.Mesh(
        new THREE.BoxGeometry(0.025, 0.24, 0.34),
        new THREE.MeshStandardMaterial({
          color: '#fbbf24',
          emissive: '#d97706',
          emissiveIntensity: 0.3,
          roughness: 0.45,
        })
      );
      pennant.position.set(0, 0.58, -0.18);
      lanceGroup.add(pennant);
      rightArm.add(lanceGroup);
    } else if (runnerType === 'HERALD') {
      // Forked Gale Rod + Emerald Wind Crystal on rightArm
      const rodGroup = new THREE.Group();
      rodGroup.position.set(0.04, 0.06, 0.18);
      rodGroup.rotation.x = 0.26;

      const rodShaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.024, 0.028, 1.12, 6),
        this.cypressTrunkMat
      );
      rodGroup.add(rodShaft);

      const prongMat = new THREE.MeshStandardMaterial({
        color: '#99f6e4',
        roughness: 0.35,
        metalness: 0.3,
      });
      for (const side of [-1, 1]) {
        const prong = new THREE.Mesh(
          new THREE.BoxGeometry(0.04, 0.28, 0.04),
          prongMat
        );
        prong.position.set(side * 0.085, 0.64, 0);
        prong.rotation.z = -side * 0.28;
        rodGroup.add(prong);
      }

      const galeGem = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.11, 0),
        new THREE.MeshBasicMaterial({ color: '#34d399' })
      );
      galeGem.position.set(0, 0.68, 0);
      rodGroup.add(galeGem);
      accentMesh = galeGem;
      rightArm.add(rodGroup);
    } else {
      // SCOUT: Compact Wayfarer Lantern-Staff on rightArm
      const staffGroup = new THREE.Group();
      staffGroup.position.set(0.04, 0.04, 0.18);
      staffGroup.rotation.x = 0.22;

      const staffShaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.024, 0.028, 1.02, 6),
        this.cypressTrunkMat
      );
      staffGroup.add(staffShaft);

      const crookBar = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.04, 0.18),
        this.cypressTrunkMat
      );
      crookBar.position.set(0, 0.52, 0.07);
      staffGroup.add(crookBar);

      const lanternCap = new THREE.Mesh(
        new THREE.ConeGeometry(0.11, 0.08, 6),
        new THREE.MeshStandardMaterial({
          color: '#334155',
          roughness: 0.5,
          metalness: 0.4,
        })
      );
      lanternCap.position.set(0, 0.47, 0.14);
      staffGroup.add(lanternCap);

      const lanternGlow = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.11, 0),
        new THREE.MeshBasicMaterial({ color: '#38bdf8' })
      );
      lanternGlow.position.set(0, 0.36, 0.14);
      staffGroup.add(lanternGlow);
      accentMesh = lanternGlow;
      rightArm.add(staffGroup);
    }

    const legGeo = new THREE.BoxGeometry(0.12, 0.36, 0.14);
    const legMat = new THREE.MeshStandardMaterial({
      color: '#334155',
      roughness: 0.65,
    });
    const leftLeg = new THREE.Group();
    leftLeg.position.set(-0.12, -0.05, 0);
    const lLegMesh = new THREE.Mesh(legGeo, legMat);
    lLegMesh.position.y = -0.15;
    leftLeg.add(lLegMesh);
    pelvis.add(leftLeg);

    const rightLeg = new THREE.Group();
    rightLeg.position.set(0.12, -0.05, 0);
    const rLegMesh = new THREE.Mesh(legGeo, legMat);
    rLegMesh.position.y = -0.15;
    rightLeg.add(rLegMesh);
    pelvis.add(rightLeg);

    return {
      archetype: runnerType,
      root,
      pelvis,
      headGroup,
      leftArm,
      rightArm,
      accentMesh,
      leftLeg,
      rightLeg,
      statusRing,
      walkPhase: 0,
      currentYaw: 0,
    };
  }

  /**
   * Rebuilds North Gatehouse (`z < 0`, flush at `y = 0`), South Shrine (`z > 26`, flush at `y = 26`),
   * Pre-Placed Elemental Spires, and Pre-Placed Crimson Keep Pillars.
   */
  private rebuildIslandPadsAndObstacles(
    island: IslandVisuals,
    round: RoundConfig
  ) {
    island.padGroup.clear();
    island.checkpointRings = [];
    island.spireRigs = [];
    island.ruinRigs = [];

    const gw = round.gridWidth;
    const gh = round.gridHeight;
    const rimThick = 2.0;
    const gateHalfGap = 1.95;

    const spawnCx = round.spawn.x + 1.0;
    const spawnBorderZ = round.spawn.y === 0 ? 0.0 : round.spawn.y + 1.0;
    const exitCx = round.exit.x + 1.0;
    const exitBorderZ =
      round.exit.y >= round.gridHeight - 2
        ? round.gridHeight
        : round.exit.y + 1.0;

    // 1. Sculpted North & South Cliff Walls notched cleanly at spawnCx & exitCx
    const leftNorthW = spawnCx - gateHalfGap + rimThick;
    island.padGroup.add(
      this.createSculptedCliffSegment(
        -rimThick + leftNorthW / 2,
        -rimThick / 2,
        leftNorthW,
        rimThick
      )
    );
    const rightNorthW = gw - (spawnCx + gateHalfGap) + rimThick;
    island.padGroup.add(
      this.createSculptedCliffSegment(
        spawnCx + gateHalfGap + rightNorthW / 2,
        -rimThick / 2,
        rightNorthW,
        rimThick
      )
    );

    const leftSouthW = exitCx - gateHalfGap + rimThick;
    island.padGroup.add(
      this.createSculptedCliffSegment(
        -rimThick + leftSouthW / 2,
        gh + rimThick / 2,
        leftSouthW,
        rimThick
      )
    );
    const rightSouthW = gw - (exitCx + gateHalfGap) + rimThick;
    island.padGroup.add(
      this.createSculptedCliffSegment(
        exitCx + gateHalfGap + rightSouthW / 2,
        gh + rimThick / 2,
        rightSouthW,
        rimThick
      )
    );

    // 2. Clean Warm-Limestone North Gatehouse (z < 0, flush at y = 0 with sky-azure threshold #38bdf8)
    const spawnGate = new THREE.Group();
    spawnGate.position.set(spawnCx, 0, spawnBorderZ);

    const northStep = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 0.12, 1.85),
      this.plinthSandstoneMat
    );
    northStep.position.set(0, 0.06, -0.96);
    northStep.receiveShadow = true;
    spawnGate.add(northStep);

    for (const side of [-1.25, 1.25]) {
      const pier = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.45, 1.65, 8),
        this.ivoryShaftMat
      );
      pier.rotation.y = Math.PI / 8;
      pier.position.set(side, 0.84, -0.72);
      pier.castShadow = true;
      pier.receiveShadow = true;
      spawnGate.add(pier);

      const pierCap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.47, 0.42, 0.18, 8),
        this.creamCapMat
      );
      pierCap.rotation.y = Math.PI / 8;
      pierCap.position.set(side, 1.74, -0.72);
      spawnGate.add(pierCap);
    }

    const archLintel = new THREE.Mesh(
      new THREE.BoxGeometry(3.15, 0.32, 0.62),
      this.ivoryShaftMat
    );
    archLintel.position.set(0, 1.68, -0.72);
    archLintel.castShadow = true;
    spawnGate.add(archLintel);

    const archCornice = new THREE.Mesh(
      new THREE.BoxGeometry(3.32, 0.14, 0.72),
      this.creamCapMat
    );
    archCornice.position.set(0, 1.9, -0.72);
    spawnGate.add(archCornice);

    const spawnThreshold = new THREE.Mesh(
      new THREE.BoxGeometry(2.04, 0.05, 0.14),
      new THREE.MeshBasicMaterial({ color: '#38bdf8' })
    );
    spawnThreshold.position.set(0, 0.028, -0.07);
    spawnGate.add(spawnThreshold);
    island.padGroup.add(spawnGate);

    // 3. Clean Warm-Limestone South Shrine (z > 26, flush at y = 26 with coral-rose threshold #fb7185)
    const exitShrine = new THREE.Group();
    exitShrine.position.set(exitCx, 0, exitBorderZ);

    const southStep = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 0.12, 1.85),
      this.plinthSandstoneMat
    );
    southStep.position.set(0, 0.06, 0.96);
    southStep.receiveShadow = true;
    exitShrine.add(southStep);

    const coralLanternMat = new THREE.MeshStandardMaterial({
      color: '#fb7185',
      emissive: '#f43f5e',
      emissiveIntensity: 0.35,
      roughness: 0.38,
    });

    for (const side of [-1.25, 1.25]) {
      const ped = new THREE.Mesh(
        new THREE.CylinderGeometry(0.38, 0.44, 1.12, 8),
        this.ivoryShaftMat
      );
      ped.rotation.y = Math.PI / 8;
      ped.position.set(side, 0.58, 0.72);
      ped.castShadow = true;
      ped.receiveShadow = true;
      exitShrine.add(ped);

      const pedCap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.46, 0.4, 0.16, 8),
        this.creamCapMat
      );
      pedCap.rotation.y = Math.PI / 8;
      pedCap.position.set(side, 1.22, 0.72);
      exitShrine.add(pedCap);

      const lantern = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.18, 0),
        coralLanternMat
      );
      lantern.position.set(side, 1.46, 0.72);
      exitShrine.add(lantern);
    }

    const exitThreshold = new THREE.Mesh(
      new THREE.BoxGeometry(2.04, 0.05, 0.14),
      new THREE.MeshBasicMaterial({ color: '#fb7185' })
    );
    exitThreshold.position.set(0, 0.028, 0.07);
    exitShrine.add(exitThreshold);
    island.padGroup.add(exitShrine);

    // 4. Pre-Placed 2x2 Elemental Spires
    for (const spirePt of round.preplacedSpires) {
      const spireRig = this.buildArticulatedStormSpireRig(
        spirePt.spireType || 'THUNDERCLAP',
        spirePt.x,
        spirePt.y
      );
      spireRig.group.position.set(spirePt.x + 1.0, 0, spirePt.y + 1.0);
      island.padGroup.add(spireRig.group);
      island.spireRigs.push(spireRig);
    }

    // 5. Pre-Placed 2x2 Crimson Keep Pillars
    for (const obs of round.obstacles) {
      const ruinRig = this.buildPreplacedCrimsonKeepPillar(obs.x, obs.y);
      ruinRig.group.position.set(obs.x + 1.0, 0, obs.y + 1.0);
      island.padGroup.add(ruinRig.group);
      island.ruinRigs.push(ruinRig);
    }

    // 6. Rebuild Runner for Round Archetype at North Border Entrance
    island.root.remove(island.runner.root);
    island.runner = this.buildArticulatedRunnerRig(
      island.playerColor,
      round.runnerType || 'SCOUT'
    );
    island.runner.root.position.set(spawnCx, 0, spawnBorderZ);
    island.root.add(island.runner.root);
  }

  /**
   * Builds clean architectural Elemental Spires (zero spinning torus gyroscopes!):
   * - `THUNDERCLAP`: Sleek ivory obelisk + warm amber brass finial (`#f59e0b`)
   * - `FROST_OBELISK`: Faceted pale-glacier monolith (`#38bdf8`)
   * - `CHRONO_SPIRE`: Twin-pillared limestone arch + calm lavender orb (`#a855f7`)
   * Includes a Golden Collar Rim Ring + 3 upward-tilted diamond Overcharge plaques readable from top-down!
   */
  private buildArticulatedStormSpireRig(
    spireType: SpireType = 'THUNDERCLAP',
    gridX = 0,
    gridY = 0
  ): SpireVisualRig {
    const group = new THREE.Group();
    const spec = TOWER_SPECS[spireType];

    // Soft Ground Contact AO Disc
    const ao = new THREE.Mesh(this.sharedGeos.aoQuad, this.aoDiscMat);
    ao.scale.setScalar(1.08);
    ao.position.y = 0.015;
    ao.renderOrder = 2;
    group.add(ao);

    // Chamfered Sandstone Plinth + Ivory Limestone Pedestal + Cream Collar
    const plinth = new THREE.Mesh(
      this.sharedGeos.spirePlinth,
      this.plinthSandstoneMat
    );
    plinth.position.y = 0.12;
    plinth.receiveShadow = true;
    group.add(plinth);

    const pedestal = new THREE.Mesh(
      this.sharedGeos.spirePedestal,
      this.ivoryShaftMat
    );
    pedestal.position.y = 0.62;
    pedestal.castShadow = true;
    pedestal.receiveShadow = true;
    group.add(pedestal);

    const collar = new THREE.Mesh(
      this.sharedGeos.spireCollar,
      this.creamCapMat
    );
    collar.position.y = 1.08;
    collar.castShadow = true;
    collar.receiveShadow = true;
    group.add(collar);

    // Sculpted Collar Rim Ring (illuminates Sun-Gold when Overcharged >= 1!)
    const collarRimMesh = new THREE.Mesh(
      this.sharedGeos.spireCollarRim,
      this.collarRimInactiveMat
    );
    collarRimMesh.position.y = 1.17;
    collarRimMesh.castShadow = true;
    collarRimMesh.receiveShadow = true;
    group.add(collarRimMesh);

    // 3 Upward-Tilted Diamond Overcharge Plaques on South-facing collar rim (readable from top-down!)
    const overchargePips: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const ang = (i - 1) * 0.52;
      const pip = new THREE.Mesh(this.sharedGeos.spirePip, this.pipInactiveMat);
      pip.position.set(Math.sin(ang) * 0.84, 1.14, Math.cos(ang) * 0.84);
      pip.rotation.order = 'YXZ';
      pip.rotation.y = ang;
      pip.rotation.x = -0.65;
      pip.scale.setScalar(0.86);
      pip.castShadow = true;
      group.add(pip);
      overchargePips.push(pip);
    }

    let upperCore: THREE.Object3D;
    let baseCoreY = 1.85;

    if (spireType === 'FROST_OBELISK') {
      // Faceted Pale-Glacier Monolith (#38bdf8)
      const frostGroup = new THREE.Group();
      const glacierMainMat = new THREE.MeshStandardMaterial({
        color: '#7dd3fc',
        emissive: '#38bdf8',
        emissiveIntensity: 0.26,
        roughness: 0.24,
        metalness: 0.18,
      });
      const glacierShardMat = new THREE.MeshStandardMaterial({
        color: '#bae6fd',
        emissive: '#38bdf8',
        emissiveIntensity: 0.18,
        roughness: 0.28,
        metalness: 0.12,
      });

      const monolithShaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.44, 1.24, 6),
        glacierMainMat
      );
      monolithShaft.position.y = 0.62;
      monolithShaft.castShadow = true;
      frostGroup.add(monolithShaft);

      const monolithTip = new THREE.Mesh(
        new THREE.ConeGeometry(0.18, 0.34, 6),
        glacierShardMat
      );
      monolithTip.position.y = 1.41;
      monolithTip.castShadow = true;
      frostGroup.add(monolithTip);

      for (let s = 0; s < 3; s++) {
        const ang = (s / 3) * Math.PI * 2 + 0.5;
        const shard = new THREE.Mesh(
          new THREE.ConeGeometry(0.14, 0.56, 5),
          glacierShardMat
        );
        shard.position.set(Math.cos(ang) * 0.38, 0.28, Math.sin(ang) * 0.38);
        shard.rotation.z = -Math.cos(ang) * 0.18;
        shard.rotation.x = Math.sin(ang) * 0.18;
        shard.castShadow = true;
        frostGroup.add(shard);
      }

      baseCoreY = 1.15;
      frostGroup.position.y = baseCoreY;
      group.add(frostGroup);
      upperCore = frostGroup;
    } else if (spireType === 'CHRONO_SPIRE') {
      // Twin-Pillared Limestone Arch + Calm Lavender Orb (#a855f7)
      for (const sideX of [-0.38, 0.38]) {
        const col = new THREE.Mesh(
          new THREE.CylinderGeometry(0.13, 0.15, 1.04, 8),
          this.ivoryShaftMat
        );
        col.position.set(sideX, 1.68, 0);
        col.castShadow = true;
        col.receiveShadow = true;
        group.add(col);
      }

      const archLintel = new THREE.Mesh(
        new THREE.BoxGeometry(1.06, 0.18, 0.38),
        this.creamCapMat
      );
      archLintel.position.y = 2.28;
      archLintel.castShadow = true;
      group.add(archLintel);

      const archCap = new THREE.Mesh(
        new THREE.BoxGeometry(0.68, 0.12, 0.3),
        this.plinthSandstoneMat
      );
      archCap.position.y = 2.43;
      group.add(archCap);

      const orb = new THREE.Mesh(
        new THREE.SphereGeometry(0.27, 20, 16),
        new THREE.MeshStandardMaterial({
          color: '#c084fc',
          emissive: '#a855f7',
          emissiveIntensity: 0.42,
          roughness: 0.25,
          metalness: 0.15,
        })
      );
      baseCoreY = 1.72;
      orb.position.y = baseCoreY;
      orb.castShadow = true;
      group.add(orb);
      upperCore = orb;
    } else {
      // THUNDERCLAP: Ivory Limestone Obelisk + Warm Amber Brass Finial (#f59e0b)
      const obeliskBody = new THREE.Mesh(
        new THREE.CylinderGeometry(0.23, 0.5, 1.06, 4),
        this.ivoryShaftMat
      );
      obeliskBody.rotation.y = Math.PI / 4;
      obeliskBody.position.y = 1.69;
      obeliskBody.castShadow = true;
      obeliskBody.receiveShadow = true;
      group.add(obeliskBody);

      const obeliskNeck = new THREE.Mesh(
        new THREE.BoxGeometry(0.46, 0.1, 0.46),
        this.creamCapMat
      );
      obeliskNeck.position.y = 2.26;
      group.add(obeliskNeck);

      const brassMat = new THREE.MeshStandardMaterial({
        color: '#f59e0b',
        emissive: '#d97706',
        emissiveIntensity: 0.32,
        roughness: 0.28,
        metalness: 0.58,
      });
      const finialGroup = new THREE.Group();
      const finialStem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.14, 0.12, 8),
        brassMat
      );
      finialGroup.add(finialStem);

      const finialDiamond = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.24, 0),
        brassMat
      );
      finialDiamond.scale.set(0.9, 1.35, 0.9);
      finialDiamond.position.y = 0.26;
      finialDiamond.castShadow = true;
      finialGroup.add(finialDiamond);

      baseCoreY = 2.34;
      finialGroup.position.y = baseCoreY;
      group.add(finialGroup);
      upperCore = finialGroup;
    }

    // Compact Radial Cooldown Ring hugging Spire base plinth (r = 1.08m, visible during RUN)
    const cdGeo = new THREE.PlaneGeometry(2.25, 2.25);
    cdGeo.rotateX(-Math.PI / 2);
    const cooldownRingMat = createSpireBaseCooldownShader(spireType);
    const cooldownRingMesh = new THREE.Mesh(cdGeo, cooldownRingMat);
    cooldownRingMesh.position.y = 0.04;
    cooldownRingMesh.renderOrder = 8;
    cooldownRingMesh.visible = false;
    group.add(cooldownRingMesh);

    // Single Crisp Perimeter Range Hairline
    const baseRange = spec.range;
    const aoeGeo = new THREE.PlaneGeometry(baseRange * 2, baseRange * 2);
    aoeGeo.rotateX(-Math.PI / 2);
    const aoeMat = createSpireAoEShader(baseRange, spireType);
    const aoeMesh = new THREE.Mesh(aoeGeo, aoeMat);
    aoeMesh.position.y = 0.022;
    aoeMesh.renderOrder = 3;
    group.add(aoeMesh);

    return {
      group,
      spireType,
      baseRange,
      gridX,
      gridY,
      upperCore,
      baseCoreY,
      collarRimMesh,
      overchargePips,
      cooldownRingMesh,
      cooldownRingMat,
      aoeMesh,
      aoeMat,
      targetHoverBoost: 0,
      recoil: 0,
    };
  }

  /**
   * Builds a Pre-Placed 2x2 Crimson Keep Pillar (`obstacles`):
   * Warm Terracotta-Crimson Masonry (`#b84a39`), cream stone trim (`#f5f0e6`),
   * taller (`h = 1.50`) pitched keep cap, and Sun-Gold (`#fbbf24`) crown lantern when linked!
   */
  private buildPreplacedCrimsonKeepPillar(
    gridX: number,
    gridY: number
  ): RuinVisualRig {
    const group = new THREE.Group();

    const ao = new THREE.Mesh(this.sharedGeos.aoQuad, this.aoDiscMat);
    ao.scale.setScalar(1.03);
    ao.position.y = 0.015;
    ao.renderOrder = 2;
    group.add(ao);

    const plinth = new THREE.Mesh(
      this.sharedGeos.keepPlinth,
      this.plinthSandstoneMat
    );
    plinth.position.y = 0.11;
    plinth.receiveShadow = true;
    group.add(plinth);

    const shaft = new THREE.Mesh(
      this.sharedGeos.keepShaft,
      this.crimsonKeepWallMat
    );
    shaft.position.y = 0.7;
    shaft.castShadow = true;
    shaft.receiveShadow = true;
    group.add(shaft);

    const cornice = new THREE.Mesh(
      this.sharedGeos.keepCornice,
      this.creamStoneTrimMat
    );
    cornice.position.y = 1.26;
    cornice.castShadow = true;
    cornice.receiveShadow = true;
    group.add(cornice);

    const pitchedCap = new THREE.Mesh(
      this.sharedGeos.keepPitchedCap,
      this.crimsonKeepRoofMat
    );
    pitchedCap.position.y = 1.43; // reaches ~1.52m
    pitchedCap.castShadow = true;
    group.add(pitchedCap);

    const lanternMesh = new THREE.Mesh(
      this.sharedGeos.keepLantern,
      this.keepLanternUnlinkedMat
    );
    lanternMesh.position.y = 1.59;
    group.add(lanternMesh);

    return { group, lanternMesh, gridX, gridY };
  }

  /**
   * Builds the Clean 4-Part Tactile *Townscaper* / *Thronefall* 2x2 Limestone Pillar:
   * 1. Soft Ground Contact AO Disc (`r = 1.02`, `y = 0.015`)
   * 2. Chamfered Sandstone Plinth (`#ddd5c7`)
   * 3. Smooth Octagonal Ivory Limestone Shaft (`#f5f0e6`)
   * 4. Crisp Sunlit Cream Cap (`#fcfaf5`) + flat matte player-colored/terracotta medallion
   */
  private buildWall3DMesh(
    x: number,
    y: number,
    playerColor = '#38bdf8',
    bornTime = performance.now()
  ): WallVisualEntry {
    const group = new THREE.Group();

    // 1. Soft Ground Contact AO Disc
    const ao = new THREE.Mesh(this.sharedGeos.aoQuad, this.aoDiscMat);
    ao.position.y = 0.015;
    ao.renderOrder = 2;
    group.add(ao);

    // 2. Chamfered Sandstone Plinth
    const plinth = new THREE.Mesh(
      this.sharedGeos.pillarPlinth,
      this.plinthSandstoneMat
    );
    plinth.position.y = 0.11;
    plinth.receiveShadow = true;
    group.add(plinth);

    // 3. Smooth Octagonal Ivory Limestone Shaft
    const shaft = new THREE.Mesh(
      this.sharedGeos.pillarShaft,
      this.ivoryShaftMat
    );
    shaft.position.y = 0.73;
    shaft.castShadow = true;
    shaft.receiveShadow = true;
    group.add(shaft);

    // 4. Crisp Sunlit Cream Cap + Flat Matte Medallion
    const cap = new THREE.Mesh(this.sharedGeos.pillarCap, this.creamCapMat);
    cap.position.y = 1.34;
    cap.castShadow = true;
    cap.receiveShadow = true;
    group.add(cap);

    const medallion = new THREE.Mesh(
      this.sharedGeos.pillarMedallion,
      this.getPlayerMedallionMaterial(playerColor)
    );
    medallion.position.y = 1.435;
    medallion.receiveShadow = true;
    group.add(medallion);

    return {
      group,
      born: bornTime,
      x,
      y,
    };
  }

  /**
   * Builds a single non-overlapping Curtain Bridge span `[tStart, tEnd]` between `(ax, az)` and `(bx, bz)`
   * using shared unit geometries (zero coplanar Z-fighting!).
   */
  private createBridgeSpanSegment(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    tStart: number,
    tEnd: number,
    wallMat: THREE.Material,
    trimMat: THREE.Material,
    isGhost = false
  ): THREE.Group {
    const bridge = new THREE.Group();
    const dx = bx - ax;
    const dz = bz - az;
    const fullDist = Math.hypot(dx, dz);
    const spanLen = Math.max(0.05, fullDist * (tEnd - tStart));
    const midT = (tStart + tEnd) * 0.5;
    const angle = Math.atan2(dx, dz);

    bridge.position.set(ax + dx * midT, 0, az + dz * midT);
    bridge.rotation.y = angle;

    const wallSeg = new THREE.Mesh(this.sharedGeos.bridgeWallUnit, wallMat);
    wallSeg.scale.z = spanLen;
    wallSeg.position.y = 0.49;
    wallSeg.castShadow = !isGhost;
    wallSeg.receiveShadow = !isGhost;
    if (isGhost) wallSeg.renderOrder = 10;
    bridge.add(wallSeg);

    const parapet = new THREE.Mesh(this.sharedGeos.bridgeCapUnit, trimMat);
    parapet.scale.z = spanLen;
    parapet.position.y = 1.05;
    parapet.castShadow = !isGhost;
    parapet.receiveShadow = !isGhost;
    if (isGhost) parapet.renderOrder = 10;
    bridge.add(parapet);

    return bridge;
  }

  /**
   * Builds a sculpted Keystone Collar right at the `0.50` midpoint of a `PLAYER <-> RUIN` bridge
   * so the ivory-to-crimson masonry transition looks intentionally crafted rather than Z-fighting.
   */
  private createBridgeKeystoneCollar(
    mx: number,
    mz: number,
    angle: number,
    capMat: THREE.Material
  ): THREE.Group {
    const keystone = new THREE.Group();
    keystone.position.set(mx, 0, mz);
    keystone.rotation.y = angle;

    const body = new THREE.Mesh(
      this.sharedGeos.keystoneBody,
      this.creamStoneTrimMat
    );
    body.position.y = 0.51;
    body.castShadow = true;
    body.receiveShadow = true;
    keystone.add(body);

    const cap = new THREE.Mesh(this.sharedGeos.keystoneCap, capMat);
    cap.position.y = 1.06;
    cap.castShadow = true;
    cap.receiveShadow = true;
    keystone.add(cap);

    return keystone;
  }

  /**
   * Updates Spire Overcharge range hairlines, Golden Collar Rim Ring, and 3 upward-tilted diamond plaques.
   */
  private applySpireOverchargeVisuals(
    island: IslandVisuals,
    tiers: number[]
  ) {
    island.spireRigs.forEach((spireRig, idx) => {
      const tier = tiers[idx] || 0;
      const effectiveRange = spireRig.baseRange + tier * 0.25;
      const scaleFactor = effectiveRange / spireRig.baseRange;
      spireRig.aoeMesh.scale.set(scaleFactor, 1, scaleFactor);
      spireRig.aoeMat.uniforms.uOverchargeTier.value = tier;

      spireRig.collarRimMesh.material =
        tier >= 1 ? this.collarRimGoldMat : this.collarRimInactiveMat;

      spireRig.overchargePips.forEach((pip, pipIdx) => {
        const active = pipIdx < tier;
        pip.material = active ? this.pipActiveGoldMat : this.pipInactiveMat;
        pip.scale.setScalar(active ? 1.12 : 0.86);
      });
    });
  }

  /**
   * Rebuilds deduplicated all-directional (`90°`, `45°`, and `(2,1)`/`(1,2)` angled) curtain bridges
   * across each unique unordered pair `(i < j)` of touching `2x2` structures:
   * - `PLAYER <-> PLAYER`: 1 full-span bridge (`0.0..1.0`)
   * - `RUIN <-> RUIN`: 1 full-span bridge (`0.0..1.0`)
   * - `PLAYER <-> SPIRE` / `RUIN <-> SPIRE`: 1 single bridge (`0.0..0.62`) from Pillar/Keep toward Spire
   * - `PLAYER <-> RUIN`: Cleanly butted `0.00..0.50` ivory + `0.50..1.00` crimson halves + sculpted Keystone Collar!
   */
  private rebuildAllDirectionalConnections(
    island: IslandVisuals,
    player: PlayerState,
    round: RoundConfig
  ) {
    island.bridgeGroup.clear();
    island.bridgeEntries = [];

    const now = performance.now();
    const circuitry = computeCitadelCircuitry(round, player.towers);

    // Identify which Player/Keep nodes belong to an active Citadel Circuitry component (Player + Keep)
    const wallNodes = [
      ...player.towers.map((t) => ({ x: t.x, y: t.y, isPlayer: true, isKeep: false })),
      ...round.obstacles.map((o) => ({ x: o.x, y: o.y, isPlayer: false, isKeep: true })),
    ];
    const visited = new Uint8Array(wallNodes.length);
    const circuitNodeSet = new Set<string>();
    for (let i = 0; i < wallNodes.length; i++) {
      if (visited[i]) continue;
      const comp: number[] = [];
      const queue: number[] = [i];
      visited[i] = 1;
      while (queue.length > 0) {
        const curr = queue.pop()!;
        comp.push(curr);
        const cn = wallNodes[curr];
        for (let j = 0; j < wallNodes.length; j++) {
          if (visited[j]) continue;
          const nn = wallNodes[j];
          if (Math.abs(cn.x - nn.x) <= 2 && Math.abs(cn.y - nn.y) <= 2) {
            visited[j] = 1;
            queue.push(j);
          }
        }
      }
      const hasPlayer = comp.some((idx) => wallNodes[idx].isPlayer);
      const hasKeep = comp.some((idx) => wallNodes[idx].isKeep);
      if (hasPlayer && hasKeep) {
        for (const idx of comp) {
          circuitNodeSet.add(`${wallNodes[idx].x},${wallNodes[idx].y}`);
        }
      }
    }

    interface PillarNode {
      x: number;
      y: number;
      cx: number;
      cz: number;
      kind: 'PLAYER' | 'RUIN' | 'SPIRE';
      born: number;
      keepIdx?: number;
      spireIdx?: number;
    }

    const allPillars: PillarNode[] = [
      ...player.towers.map((t) => {
        const entry = island.towerMeshes.get(t.id);
        return {
          x: t.x,
          y: t.y,
          cx: t.x + 1.0,
          cz: t.y + 1.0,
          kind: 'PLAYER' as const,
          born: entry ? entry.born : now - 10000,
        };
      }),
      ...round.obstacles.map((o, idx) => ({
        x: o.x,
        y: o.y,
        cx: o.x + 1.0,
        cz: o.y + 1.0,
        kind: 'RUIN' as const,
        born: now - 10000,
        keepIdx: idx,
      })),
      ...round.preplacedSpires.map((s, idx) => ({
        x: s.x,
        y: s.y,
        cx: s.x + 1.0,
        cz: s.y + 1.0,
        kind: 'SPIRE' as const,
        born: now - 10000,
        spireIdx: idx,
      })),
    ];

    const addBridgeEntry = (grp: THREE.Group, born: number) => {
      const ageSec = (now - born) / 1000;
      if (ageSec >= 0 && ageSec < 0.26) {
        grp.scale.set(1, evalToyBoxSpringScaleY(ageSec / 0.26), 1);
      }
      island.bridgeGroup.add(grp);
      island.bridgeEntries.push({ group: grp, born });
    };

    for (let i = 0; i < allPillars.length; i++) {
      const a = allPillars[i];
      for (let j = i + 1; j < allPillars.length; j++) {
        const b = allPillars[j];
        const dxGrid = b.x - a.x;
        const dzGrid = b.y - a.y;
        if (Math.abs(dxGrid) > 2 || Math.abs(dzGrid) > 2) continue;
        if (dxGrid === 0 && dzGrid === 0) continue;

        const pairBorn = Math.max(a.born, b.born);

        if (a.kind === 'PLAYER' && b.kind === 'PLAYER') {
          // ONE single full-span ivory limestone bridge (0.0..1.0)
          const span = this.createBridgeSpanSegment(
            a.cx,
            a.cz,
            b.cx,
            b.cz,
            0.0,
            1.0,
            this.bridgeWallMat,
            this.creamCapMat,
            false
          );
          addBridgeEntry(span, pairBorn);
        } else if (a.kind === 'RUIN' && b.kind === 'RUIN') {
          // ONE single full-span crimson masonry bridge (0.0..1.0)
          const isLinked =
            (a.keepIdx !== undefined && circuitry.linkedKeepIndices.has(a.keepIdx)) ||
            (b.keepIdx !== undefined && circuitry.linkedKeepIndices.has(b.keepIdx));
          const span = this.createBridgeSpanSegment(
            a.cx,
            a.cz,
            b.cx,
            b.cz,
            0.0,
            1.0,
            this.crimsonKeepWallMat,
            isLinked ? this.goldBridgeTrimMat : this.creamStoneTrimMat,
            false
          );
          addBridgeEntry(span, pairBorn);
        } else if (
          (a.kind === 'PLAYER' && b.kind === 'RUIN') ||
          (a.kind === 'RUIN' && b.kind === 'PLAYER')
        ) {
          // Cleanly butt ivory half (0.0..0.5) & crimson half (0.5..1.0) + sculpted Keystone Collar!
          const pNode = a.kind === 'PLAYER' ? a : b;
          const rNode = a.kind === 'RUIN' ? a : b;
          const isLinked =
            rNode.keepIdx !== undefined
              ? circuitry.linkedKeepIndices.has(rNode.keepIdx)
              : true;
          const capMat = isLinked
            ? this.goldBridgeTrimMat
            : this.creamStoneTrimMat;

          const pairGroup = new THREE.Group();
          pairGroup.add(
            this.createBridgeSpanSegment(
              pNode.cx,
              pNode.cz,
              rNode.cx,
              rNode.cz,
              0.0,
              0.5,
              this.bridgeWallMat,
              capMat,
              false
            )
          );
          pairGroup.add(
            this.createBridgeSpanSegment(
              pNode.cx,
              pNode.cz,
              rNode.cx,
              rNode.cz,
              0.5,
              1.0,
              this.crimsonKeepWallMat,
              capMat,
              false
            )
          );
          const angle = Math.atan2(rNode.cx - pNode.cx, rNode.cz - pNode.cz);
          pairGroup.add(
            this.createBridgeKeystoneCollar(
              (pNode.cx + rNode.cx) * 0.5,
              (pNode.cz + rNode.cz) * 0.5,
              angle,
              capMat
            )
          );
          addBridgeEntry(pairGroup, pairBorn);
        } else if (
          (a.kind === 'SPIRE' && (b.kind === 'PLAYER' || b.kind === 'RUIN')) ||
          (b.kind === 'SPIRE' && (a.kind === 'PLAYER' || a.kind === 'RUIN'))
        ) {
          // ONE single bridge (0.0..0.62) from Pillar/Keep toward Spire (Spire never emits reverse bridge)
          const sNode = a.kind === 'SPIRE' ? a : b;
          const wNode = a.kind === 'SPIRE' ? b : a;
          const spireTier =
            sNode.spireIdx !== undefined
              ? circuitry.spireOverchargeTiers[sNode.spireIdx] || 0
              : 0;
          const inCircuit = circuitNodeSet.has(`${wNode.x},${wNode.y}`);
          const wallMat =
            wNode.kind === 'RUIN' ? this.crimsonKeepWallMat : this.bridgeWallMat;
          const trimMat =
            spireTier > 0 && inCircuit
              ? this.goldBridgeTrimMat
              : wNode.kind === 'RUIN'
              ? this.creamStoneTrimMat
              : this.creamCapMat;

          const span = this.createBridgeSpanSegment(
            wNode.cx,
            wNode.cz,
            sNode.cx,
            sNode.cz,
            0.0,
            0.62,
            wallMat,
            trimMat,
            false
          );
          addBridgeEntry(span, pairBorn);
        }
      }
    }

    // Activate Sun-Gold crown lantern on linked Crimson Keeps
    island.ruinRigs.forEach((ruin, idx) => {
      const isLinked = circuitry.linkedKeepIndices.has(idx);
      ruin.lanternMesh.material = isLinked
        ? this.keepLanternLinkedMat
        : this.keepLanternUnlinkedMat;
    });

    // Update Spire Overcharge range hairlines, golden collar rim, & tilted diamond plaques
    this.applySpireOverchargeVisuals(island, circuitry.spireOverchargeTiers);
  }

  private syncIslandTowersAndPath(
    island: IslandVisuals,
    player: PlayerState,
    round: RoundConfig,
    skipPopAnim = false
  ) {
    const incomingIds = new Set(player.towers.map((t) => t.id));

    for (const [tid, entry] of island.towerMeshes.entries()) {
      if (!incomingIds.has(tid)) {
        if (!skipPopAnim) {
          this.spawnPlacementDustPuffs(
            island.offsetX + entry.x + 1.0,
            island.offsetZ + entry.y + 1.0,
            '#fda4af',
            6
          );
        }
        island.towerGroup.remove(entry.group);
        island.towerMeshes.delete(tid);
      }
    }

    const now = performance.now();
    for (const tower of player.towers) {
      if (!island.towerMeshes.has(tower.id)) {
        const born = skipPopAnim ? now - 1000 : now;
        const entry = this.buildWall3DMesh(tower.x, tower.y, player.color, born);
        entry.group.position.set(tower.x + 1.0, 0, tower.y + 1.0);
        if (!skipPopAnim) {
          const sY = 0.2;
          const sXZ = 1 / Math.sqrt(sY);
          entry.group.scale.set(sXZ, sY, sXZ);
          // 6 soft circular dust puffs & ZERO cameraShake on pillar placement!
          this.spawnPlacementDustPuffs(
            island.offsetX + tower.x + 1.0,
            island.offsetZ + tower.y + 1.0,
            '#f5efe4',
            6
          );
        }
        island.towerGroup.add(entry.group);
        island.towerMeshes.set(tower.id, entry);
      }
    }

    this.rebuildAllDirectionalConnections(island, player, round);

    if (island.pathMesh) {
      island.root.remove(island.pathMesh);
      island.pathMesh.geometry.dispose();
      island.pathMesh = null;
      island.pathMat = null;
    }

    const pathRes = computeFullMazePath(round, player.towers);
    if (pathRes.valid && pathRes.allPoints.length > 1) {
      const ribbonGeo = createFlatPathRibbonGeometry(
        pathRes.allPoints,
        0,
        0,
        0.025,
        0.14
      );
      const initOpacity =
        this.currentRoomState?.phase === 'BUILD' ? 0.58 : 0.22;
      const pathMat = createPathRibbonShader('#fefce8', initOpacity);
      island.pathMesh = new THREE.Mesh(ribbonGeo, pathMat);
      island.pathMesh.renderOrder = 4;
      island.pathMat = pathMat;
      island.root.add(island.pathMesh);
    }

    if (player.id === this.localPlayerId) {
      const evalRes = evaluateMazeRunTime(round, player.towers);
      this.populateClapMarkers(island, evalRes.clapLocations, false);
    } else {
      island.clapMarkerGroup.clear();
    }
  }

  /**
   * Populates subtle flat golden ground pips (`CircleGeometry(0.14, 16)` at `y = 0.032`)
   * instead of floating spinning octahedrons.
   */
  private populateClapMarkers(
    island: IslandVisuals,
    locations: GridPoint[],
    isBonusPreview = false
  ) {
    island.clapMarkerGroup.clear();
    const innerMat = isBonusPreview
      ? this.clapPipGainMat
      : this.clapPipGoldMat;

    for (const loc of locations) {
      const pipGroup = new THREE.Group();
      pipGroup.position.set(loc.x, 0.032, loc.y);

      const outer = new THREE.Mesh(
        this.sharedGeos.clapPipOuter,
        this.clapPipCreamMat
      );
      outer.renderOrder = 6;
      pipGroup.add(outer);

      const inner = new THREE.Mesh(this.sharedGeos.clapPipInner, innerMat);
      inner.position.y = 0.002;
      inner.renderOrder = 6;
      pipGroup.add(inner);

      island.clapMarkerGroup.add(pipGroup);
    }
  }

  private setGhostTint(valid: boolean) {
    if (valid) {
      // Soft mint #86efac
      this.ghostBodyMat.color.set('#86efac');
      this.ghostBodyMat.emissive.set('#22c55e');
      this.ghostCapMat.color.set('#dcfce7');
      this.ghostCapMat.emissive.set('#4ade80');
    } else {
      // Soft coral #fda4af
      this.ghostBodyMat.color.set('#fda4af');
      this.ghostBodyMat.emissive.set('#fb7185');
      this.ghostCapMat.color.set('#ffe4e6');
      this.ghostCapMat.emissive.set('#f43f5e');
    }
  }

  /**
   * Shared builder for 3D Ghost Pillar + Trimmed Bridge Connections + Preview Path + Spire Hover Hairlines
   * (used by both desktop pointer hover and mobile 2-stage touch preview).
   */
  private buildGhostAndPathPreview(
    localIsland: IslandVisuals,
    localPlayer: PlayerState,
    round: RoundConfig,
    placeX: number,
    placeY: number
  ): {
    valid: boolean;
    reason?: string;
    deltaTime: number;
    deltaClaps: number;
    deltaKeeps: number;
    deltaOvercharge: number;
    previewTime: number;
  } {
    const validation = validateTowerPlacement(
      round,
      localPlayer.towers,
      placeX,
      placeY
    );

    this.ghostGroup.visible = true;
    this.ghostGroup.scale.set(1, 1, 1);
    this.ghostGroup.position.set(
      localIsland.offsetX + placeX + 1.0,
      0,
      localIsland.offsetZ + placeY + 1.0
    );
    this.setGhostTint(validation.valid);

    this.ghostConnGroup.clear();
    if (validation.valid) {
      const neighbors: GridPoint[] = [
        ...localPlayer.towers,
        ...round.obstacles,
        ...round.preplacedSpires,
      ];
      for (const nb of neighbors) {
        const dx = nb.x - placeX;
        const dz = nb.y - placeY;
        if (
          (dx !== 0 || dz !== 0) &&
          Math.abs(dx) <= 2 &&
          Math.abs(dz) <= 2 &&
          !do2x2Overlap(placeX, placeY, nb.x, nb.y)
        ) {
          // Span strictly between the outer faces of the two octagonal shafts (~0.68..fullDist-0.68)
          // so translucent ghost bridges never poke inside opaque neighbor pillars!
          const fullDist = Math.hypot(dx, dz);
          const insetT = Math.min(0.42, 0.68 / fullDist);
          const previewBridge = this.createBridgeSpanSegment(
            0,
            0,
            dx,
            dz,
            insetT,
            1.0 - insetT,
            this.ghostBodyMat,
            this.ghostCapMat,
            true
          );
          this.ghostConnGroup.add(previewBridge);
        }
      }
    }

    this.clearPreviewPathMesh();

    let deltaTime = 0;
    let deltaClaps = 0;
    let deltaKeeps = 0;
    let deltaOvercharge = 0;
    let previewTime = this.cachedBaseEval?.finishTimeSeconds || 0;

    if (validation.valid && validation.pathResult) {
      if (validation.pathResult.allPoints.length > 1) {
        const ribbonGeo = createFlatPathRibbonGeometry(
          validation.pathResult.allPoints,
          localIsland.offsetX,
          localIsland.offsetZ,
          0.03,
          0.15
        );
        this.previewPathMat = createPathRibbonShader('#ecfccb', 0.72);
        this.previewPathMesh = new THREE.Mesh(ribbonGeo, this.previewPathMat);
        this.previewPathMesh.renderOrder = 5;
        this.scene.add(this.previewPathMesh);
      }

      const testTowers: PlacedTower[] = [
        ...localPlayer.towers,
        { id: '__preview__', type: 'BLOCK', x: placeX, y: placeY, createdAt: 0 },
      ];
      const previewEval = evaluateMazeRunTime(round, testTowers);
      previewTime = previewEval.finishTimeSeconds;
      if (this.cachedBaseEval) {
        deltaTime = Number(
          (
            previewEval.finishTimeSeconds -
            this.cachedBaseEval.finishTimeSeconds
          ).toFixed(1)
        );
        deltaClaps = previewEval.clapsTaken - this.cachedBaseEval.clapsTaken;
        deltaKeeps = previewEval.linkedKeeps - this.cachedBaseEval.linkedKeeps;
        deltaOvercharge =
          previewEval.overchargedSpires - this.cachedBaseEval.overchargedSpires;
      }

      this.populateClapMarkers(
        localIsland,
        previewEval.clapLocations,
        deltaClaps > 0
      );
      this.applySpireOverchargeVisuals(
        localIsland,
        previewEval.spireOverchargeTiers
      );

      // Brighten Spire range hairline (0.24 -> 0.58) when hovering/ghosting near a Spire or boosting its Overcharge
      localIsland.spireRigs.forEach((sr, idx) => {
        const dist = Math.hypot(sr.gridX - placeX, sr.gridY - placeY);
        const baseTier = this.cachedBaseEval?.spireOverchargeTiers[idx] || 0;
        const newTier = previewEval.spireOverchargeTiers[idx] || 0;
        sr.targetHoverBoost =
          dist <= sr.baseRange + 2.6 || newTier > baseTier ? 1.0 : 0.0;
      });
    } else {
      if (this.cachedBaseEval) {
        this.populateClapMarkers(
          localIsland,
          this.cachedBaseEval.clapLocations,
          false
        );
        this.applySpireOverchargeVisuals(
          localIsland,
          this.cachedBaseEval.spireOverchargeTiers
        );
      }
      localIsland.spireRigs.forEach((sr) => {
        const dist = Math.hypot(sr.gridX - placeX, sr.gridY - placeY);
        sr.targetHoverBoost = dist <= sr.baseRange + 2.2 ? 1.0 : 0.0;
      });
    }

    return {
      valid: validation.valid,
      reason: validation.reason,
      deltaTime,
      deltaClaps,
      deltaKeeps,
      deltaOvercharge,
      previewTime,
    };
  }

  private updateBuildHover() {
    if (
      !this.currentRoomState ||
      this.currentRoomState.phase !== 'BUILD' ||
      !this.localPlayerId
    ) {
      this.mouseOverLocalGrass = false;
      this.ghostGroup.visible = false;
      this.ghostGroup.scale.set(1, 1, 1);
      this.ghostConnGroup.clear();
      this.clearPreviewPathMesh();
      this.onHoverStatusChange?.({
        cell: null,
        screenX: this.lastPointerScreen.x,
        screenY: this.lastPointerScreen.y,
        valid: false,
      });
      return;
    }

    const localIsland = this.islands.get(this.localPlayerId);
    const localPlayer = this.currentRoomState.players.find(
      (p) => p.id === this.localPlayerId
    );
    if (!localIsland || !localPlayer) {
      this.mouseOverLocalGrass = false;
      this.ghostGroup.visible = false;
      return;
    }

    // Suppress build ghost while viewing Arena Overview or spectating a rival island
    if (
      this.arenaOverviewMode ||
      (this.focusedPlayerId && this.focusedPlayerId !== this.localPlayerId)
    ) {
      this.mouseOverLocalGrass = false;
      this.ghostGroup.visible = false;
      this.ghostGroup.scale.set(1, 1, 1);
      this.ghostConnGroup.clear();
      this.hoveredCell = null;
      this.hoveredExistingTower = null;
      localIsland.floorUniforms.uCursorPos.value.set(-99, -99);
      for (const sr of localIsland.spireRigs) {
        sr.targetHoverBoost = 0;
      }
      this.clearPreviewPathMesh();
      if (this.cachedBaseEval) {
        this.populateClapMarkers(
          localIsland,
          this.cachedBaseEval.clapLocations,
          false
        );
        this.applySpireOverchargeVisuals(
          localIsland,
          this.cachedBaseEval.spireOverchargeTiers
        );
      }
      this.onHoverStatusChange?.({
        cell: null,
        screenX: this.lastPointerScreen.x,
        screenY: this.lastPointerScreen.y,
        valid: false,
      });
      return;
    }

    this.raycaster.setFromCamera(this.mouseNDC, this.camera);
    const hits = this.raycaster.intersectObject(localIsland.hitPlane);
    if (hits.length === 0) {
      this.mouseOverLocalGrass = false;
      this.ghostGroup.visible = false;
      this.ghostGroup.scale.set(1, 1, 1);
      this.ghostConnGroup.clear();
      this.hoveredCell = null;
      this.hoveredExistingTower = null;
      localIsland.floorUniforms.uCursorPos.value.set(-99, -99);
      for (const sr of localIsland.spireRigs) {
        sr.targetHoverBoost = 0;
      }
      this.clearPreviewPathMesh();
      if (this.cachedBaseEval) {
        this.populateClapMarkers(
          localIsland,
          this.cachedBaseEval.clapLocations,
          false
        );
        this.applySpireOverchargeVisuals(
          localIsland,
          this.cachedBaseEval.spireOverchargeTiers
        );
      }
      this.onHoverStatusChange?.({
        cell: null,
        screenX: this.lastPointerScreen.x,
        screenY: this.lastPointerScreen.y,
        valid: false,
      });
      return;
    }

    this.mouseOverLocalGrass = true;
    const localPt = hits[0].point;
    const relX = localPt.x - localIsland.offsetX;
    const relZ = localPt.z - localIsland.offsetZ;
    localIsland.floorUniforms.uCursorPos.value.set(relX, relZ);

    const round = this.currentRoomState.roundConfig;
    const cellX = Math.floor(relX);
    const cellY = Math.floor(relZ);

    this.hoveredExistingTower =
      localPlayer.towers.find(
        (t) =>
          cellX >= t.x &&
          cellX < t.x + 2 &&
          cellY >= t.y &&
          cellY < t.y + 2
      ) || null;

    if (this.activeTool === 'SELL') {
      this.ghostConnGroup.clear();
      this.clearPreviewPathMesh();
      for (const sr of localIsland.spireRigs) {
        sr.targetHoverBoost = 0;
      }
      if (this.hoveredExistingTower) {
        this.ghostGroup.visible = true;
        this.ghostGroup.scale.set(1.05, 1.03, 1.05);
        this.ghostGroup.position.set(
          localIsland.offsetX + this.hoveredExistingTower.x + 1.0,
          0,
          localIsland.offsetZ + this.hoveredExistingTower.y + 1.0
        );
        this.setGhostTint(false);
        this.onHoverStatusChange?.({
          cell: { x: cellX, y: cellY },
          screenX: this.lastPointerScreen.x,
          screenY: this.lastPointerScreen.y,
          valid: true,
          reason: 'Refund Pillar',
          existingTower: this.hoveredExistingTower,
        });
      } else {
        this.ghostGroup.visible = false;
        this.onHoverStatusChange?.({
          cell: null,
          screenX: this.lastPointerScreen.x,
          screenY: this.lastPointerScreen.y,
          valid: false,
        });
      }
      return;
    }

    const placeX = Math.max(
      0,
      Math.min(round.gridWidth - 2, Math.round(relX - 1))
    );
    const placeY = Math.max(
      0,
      Math.min(round.gridHeight - 2, Math.round(relZ - 1))
    );
    this.hoveredCell = { x: placeX, y: placeY };

    const preview = this.buildGhostAndPathPreview(
      localIsland,
      localPlayer,
      round,
      placeX,
      placeY
    );

    this.onHoverStatusChange?.({
      cell: this.hoveredCell,
      screenX: this.lastPointerScreen.x,
      screenY: this.lastPointerScreen.y,
      valid: preview.valid,
      reason: preview.reason,
      deltaTime: preview.deltaTime,
      deltaClaps: preview.deltaClaps,
      deltaKeeps: preview.deltaKeeps,
      deltaOvercharge: preview.deltaOvercharge,
      previewTime: preview.previewTime,
      existingTower: this.hoveredExistingTower,
    });
  }

  private clearPreviewPathMesh() {
    if (this.previewPathMesh) {
      this.scene.remove(this.previewPathMesh);
      this.previewPathMesh.geometry.dispose();
      this.previewPathMesh = null;
      this.previewPathMat = null;
    }
  }

  public updateRunners(
    states: Map<string, RunnerSimState>,
    events: SimEvent[]
  ) {
    for (const ev of events) {
      const island = this.islands.get(ev.playerId);
      if (!island) continue;

      if (ev.type === 'CLAP') {
        const spireType = ev.spireType || 'THUNDERCLAP';
        const shockColor =
          spireType === 'FROST_OBELISK'
            ? '#38bdf8'
            : spireType === 'CHRONO_SPIRE'
            ? '#a855f7'
            : '#f59e0b';
        const burstColor =
          spireType === 'FROST_OBELISK'
            ? '#bae6fd'
            : spireType === 'CHRONO_SPIRE'
            ? '#e9d5ff'
            : '#fde68a';
        this.spawnShockwaveEffect(
          island.offsetX + ev.x,
          island.offsetZ + ev.y,
          TOWER_SPECS[spireType].range,
          shockColor,
          island.offsetX + island.runner.root.position.x,
          island.offsetZ + island.runner.root.position.z
        );
        this.spawnParticleBurst(
          island.offsetX + ev.x,
          1.4,
          island.offsetZ + ev.y,
          burstColor,
          14
        );
        for (const spireRig of island.spireRigs) {
          if (
            Math.hypot(
              spireRig.group.position.x - ev.x,
              spireRig.group.position.z - ev.y
            ) < 0.5
          ) {
            spireRig.recoil = 1.0;
          }
        }
      } else if (ev.type === 'CHECKPOINT') {
        this.spawnShockwaveEffect(
          island.offsetX + ev.x,
          island.offsetZ + ev.y,
          2.0,
          '#10b981'
        );
        this.spawnParticleBurst(
          island.offsetX + ev.x,
          0.9,
          island.offsetZ + ev.y,
          '#6ee7b7',
          14
        );
      } else if (ev.type === 'WAYGATE') {
        this.spawnShockwaveEffect(
          island.offsetX + ev.x,
          island.offsetZ + ev.y,
          2.2,
          '#a855f7'
        );
        this.spawnParticleBurst(
          island.offsetX + ev.x,
          0.9,
          island.offsetZ + ev.y,
          '#e9d5ff',
          16
        );
      } else if (ev.type === 'FINISH') {
        this.spawnShockwaveEffect(
          island.offsetX + ev.x,
          island.offsetZ + ev.y,
          2.8,
          '#38bdf8'
        );
        this.spawnParticleBurst(
          island.offsetX + ev.x,
          1.0,
          island.offsetZ + ev.y,
          '#7dd3fc',
          20
        );
      }
    }

    for (const [playerId, sim] of states.entries()) {
      const island = this.islands.get(playerId);
      if (!island) continue;

      const r = island.runner;
      const prevX = r.root.position.x;
      const prevZ = r.root.position.z;

      r.root.position.set(sim.x, 0, sim.y);

      const moveDx = sim.x - prevX;
      const moveDz = sim.y - prevZ;
      const distMoved = Math.hypot(moveDx, moveDz);

      let targetYaw = r.currentYaw;
      if (distMoved > 0.001) {
        targetYaw = Math.atan2(moveDx, moveDz);
      }
      let diff = targetYaw - r.currentYaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      r.currentYaw += diff * 0.25;
      r.root.rotation.y = r.currentYaw;

      const bankAngle = Math.max(-0.32, Math.min(0.32, -diff * 1.6));
      r.pelvis.rotation.z = bankAngle;

      if (!sim.finished) {
        r.walkPhase += 0.016 * sim.currentSpeed * 4.5;
        const swing = Math.sin(r.walkPhase) * 0.62;
        r.leftLeg.rotation.x = swing;
        r.rightLeg.rotation.x = -swing;
        if (r.archetype === 'JUGGERNAUT') {
          r.leftArm.rotation.x = 0.28 - swing * 0.16;
          r.rightArm.rotation.x = swing * 0.56;
        } else if (r.archetype === 'OUTRIDER') {
          r.leftArm.rotation.x = -swing * 0.72;
          r.rightArm.rotation.x = swing * 0.14;
        } else {
          r.leftArm.rotation.x = -swing * 0.72;
          r.rightArm.rotation.x = swing * 0.46;
        }
        r.pelvis.position.y = 0.45 + Math.abs(Math.sin(r.walkPhase)) * 0.12;
        r.pelvis.rotation.x = 0.12;
      } else {
        r.pelvis.position.y = 0.6;
        r.pelvis.rotation.x = 0;
        r.pelvis.rotation.z = 0;
        r.root.rotation.y += 0.04;
      }

      // Flat status ring under Runner's feet (replaces spinning wireframe snareCage!)
      const hasModifier =
        sim.clapSlowRemaining > 0 ||
        sim.inPermafrostAura ||
        sim.hasTailwindMomentum ||
        sim.inFrostMire ||
        sim.inHasteRift;
      r.statusRing.visible = !sim.finished && hasModifier;

      const ringMat = r.statusRing.material as THREE.MeshBasicMaterial;
      const accentMat = r.accentMesh
        ? (r.accentMesh.material as THREE.MeshBasicMaterial)
        : null;
      if (sim.clapSlowRemaining > 0) {
        ringMat.color.set('#f59e0b');
        accentMat?.color.set('#fbbf24');
      } else if (sim.inPermafrostAura || sim.inFrostMire) {
        ringMat.color.set('#38bdf8');
        accentMat?.color.set('#38bdf8');
      } else if (sim.hasTailwindMomentum) {
        ringMat.color.set('#34d399');
        accentMat?.color.set('#34d399');
      } else if (sim.inHasteRift) {
        ringMat.color.set('#fb7185');
        accentMat?.color.set('#fb7185');
      } else if (accentMat) {
        accentMat.color.set(
          r.archetype === 'HERALD' ? '#34d399' : '#38bdf8'
        );
      }

      // Drive compact radial base cooldown ring on each Spire
      island.spireRigs.forEach((spireRig, idx) => {
        const tState = sim.towers[`spire_${idx}`];
        if (tState) {
          const cdTotal =
            tState.effectiveCooldown || TOWER_SPECS[spireRig.spireType].cooldown;
          const charge =
            1.0 - Math.min(1.0, tState.cooldownRemaining / cdTotal);
          spireRig.cooldownRingMat.uniforms.uChargeProgress.value = charge;
        }
      });

      this.updateRunnerDOMBadge(playerId, sim);
    }
  }

  /**
   * Spawns 6 soft circular dust puffs around a placed/reclaimed pillar plinth.
   */
  private spawnPlacementDustPuffs(
    worldX: number,
    worldZ: number,
    colorHex: string,
    count = 6
  ) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const vels = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
      const startR = 0.65 + Math.random() * 0.16;
      pos[i * 3] = worldX + Math.cos(ang) * startR;
      pos[i * 3 + 1] = 0.12 + Math.random() * 0.08;
      pos[i * 3 + 2] = worldZ + Math.sin(ang) * startR;

      const outSpeed = 1.15 + Math.random() * 0.55;
      vels[i * 3] = Math.cos(ang) * outSpeed;
      vels[i * 3 + 1] = 0.75 + Math.random() * 0.45;
      vels[i * 3 + 2] = Math.sin(ang) * outSpeed;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: colorHex,
      map: this.softCircleSpriteTex,
      size: 0.44,
      transparent: true,
      opacity: 0.72,
      alphaTest: 0.01,
      depthWrite: false,
    });

    const points = new THREE.Points(geo, mat);
    points.renderOrder = 11;
    this.scene.add(points);
    this.particleBursts.push({
      points,
      velocities: vels,
      gravity: 1.6,
      baseOpacity: 0.72,
      age: 0,
      maxAge: 0.42,
    });
  }

  private spawnParticleBurst(
    worldX: number,
    worldY: number,
    worldZ: number,
    colorHex: string,
    count: number
  ) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const vels = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      pos[i * 3] = worldX + (Math.random() - 0.5) * 0.35;
      pos[i * 3 + 1] = worldY + Math.random() * 0.25;
      pos[i * 3 + 2] = worldZ + (Math.random() - 0.5) * 0.35;

      const angle = Math.random() * Math.PI * 2;
      const speed = 1.4 + Math.random() * 2.8;
      vels[i * 3] = Math.cos(angle) * speed;
      vels[i * 3 + 1] = 1.8 + Math.random() * 2.4;
      vels[i * 3 + 2] = Math.sin(angle) * speed;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: colorHex,
      map: this.softCircleSpriteTex,
      size: 0.32,
      transparent: true,
      opacity: 0.9,
      alphaTest: 0.01,
      depthWrite: false,
    });

    const points = new THREE.Points(geo, mat);
    points.renderOrder = 11;
    this.scene.add(points);
    this.particleBursts.push({
      points,
      velocities: vels,
      gravity: 6.8,
      baseOpacity: 0.9,
      age: 0,
      maxAge: 0.55,
    });
  }

  /**
   * Spawns a clean flat ground ripple ring (zero wireframe shockwave domes!).
   */
  private spawnShockwaveEffect(
    worldX: number,
    worldZ: number,
    maxRadius: number,
    colorHex: string,
    boltTargetX?: number,
    boltTargetZ?: number
  ) {
    const ringMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.78,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.sharedGeos.shockwaveRing, ringMat);
    mesh.position.set(worldX, 0.045, worldZ);
    mesh.renderOrder = 9;
    this.scene.add(mesh);

    let bolt: THREE.Line | undefined;
    if (boltTargetX !== undefined && boltTargetZ !== undefined) {
      const start = new THREE.Vector3(worldX, 2.15, worldZ);
      const end = new THREE.Vector3(boltTargetX, 0.85, boltTargetZ);
      const pts: THREE.Vector3[] = [start];
      for (let s = 1; s <= 3; s++) {
        const p = start.clone().lerp(end, s / 4);
        p.x += (Math.random() - 0.5) * 0.32;
        p.y += (Math.random() - 0.2) * 0.28;
        p.z += (Math.random() - 0.5) * 0.32;
        pts.push(p);
      }
      pts.push(end);

      const boltGeo = new THREE.BufferGeometry().setFromPoints(pts);
      const boltMat = new THREE.LineBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.85,
      });
      bolt = new THREE.Line(boltGeo, boltMat);
      bolt.renderOrder = 9;
      this.scene.add(bolt);
    }

    this.shockwaves.push({
      mesh,
      bolt,
      age: 0,
      maxAge: 0.48,
      maxRadius,
    });
  }

  private createIslandDOMElements(player: PlayerState) {
    const header = document.createElement('div');
    header.className = 'island-3d-badge';
    header.style.setProperty('--player-color', player.color);
    header.style.pointerEvents = 'auto';
    header.style.cursor = 'pointer';
    header.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    header.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.dismissTransientUI?.()) return;
      this.doClearTouchPreview();
      this.focusOnPlayerIsland(player.id);
      this.onFocusChange?.();
    });
    this.labelLayer.appendChild(header);
    this.labelElements.set(player.id, header);

    const runnerBadge = document.createElement('div');
    runnerBadge.className = 'runner-3d-badge';
    runnerBadge.style.setProperty('--player-color', player.color);
    this.labelLayer.appendChild(runnerBadge);
    this.runnerLabels.set(player.id, runnerBadge);
  }

  /**
   * Clean emoji-free `.island-3d-badge` DOM badge.
   */
  private updateIslandHeaderBadge(player: PlayerState) {
    const el = this.labelElements.get(player.id);
    if (!el) return;
    el.innerHTML = '';

    const dot = document.createElement('span');
    dot.className = 'badge-dot';
    dot.style.background = player.color;

    const nameStrong = document.createElement('strong');
    nameStrong.textContent = player.name;

    const meta = document.createElement('span');
    meta.className = 'badge-meta';
    meta.textContent = `${player.pathDistance.toFixed(0)}m`;

    el.append(dot, nameStrong, meta);
  }

  /**
   * Clean emoji-free `.runner-3d-badge` DOM badge (`6.4s`, `Slow`, `Frost`, `Haste`)
   * driven by real `sim.elapsedSeconds` so Slow/Frost/Haste modifiers reflect accurately!
   */
  private updateRunnerDOMBadge(playerId: string, sim: RunnerSimState) {
    const el = this.runnerLabels.get(playerId);
    if (!el || !this.currentRoomState) return;
    if (this.currentRoomState.phase !== 'RUN') {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'flex';

    let statusText = '';
    let dotColor = '';
    if (sim.finished) {
      statusText = 'Done';
      dotColor = '#34d399';
    } else if (sim.clapSlowRemaining > 0) {
      statusText = 'Slow';
      dotColor = '#f59e0b';
    } else if (sim.inPermafrostAura || sim.inFrostMire) {
      statusText = 'Frost';
      dotColor = '#38bdf8';
    } else if (sim.hasTailwindMomentum || sim.inHasteRift) {
      statusText = 'Haste';
      dotColor = '#34d399';
    }

    const stackSuffix = sim.exposureStacks > 1 ? ` x${sim.exposureStacks}` : '';
    const liveSec = sim.elapsedSeconds ?? sim.distanceTraveled / sim.baseSpeed;
    const timeVal = sim.finished
      ? `${sim.finishTimeSeconds.toFixed(2)}s`
      : `${liveSec.toFixed(1)}s${stackSuffix}`;

    el.innerHTML = '';
    if (statusText) {
      const dot = document.createElement('span');
      dot.className = 'badge-dot';
      dot.style.background = dotColor;
      const tag = document.createElement('span');
      tag.textContent = statusText;
      tag.style.marginRight = '4px';
      tag.style.opacity = '0.9';
      el.append(dot, tag);
    }
    const timeSpan = document.createElement('span');
    timeSpan.textContent = timeVal;
    el.appendChild(timeSpan);
  }

  public renderFrame(dt: number) {
    const now = performance.now();
    const uTimeVal = now * 0.001;
    const isBuildPhase = this.currentRoomState?.phase === 'BUILD';
    const isRunPhase = this.currentRoomState?.phase === 'RUN';

    this.voidSeaMat.uniforms.uTime.value = uTimeVal;

    // Keyboard camera panning: WASD + Arrow keys (oriented cleanly with camAzimuth)
    const moveForward =
      (this.keysDown.has('arrowup') || this.keysDown.has('w') ? 1 : 0) -
      (this.keysDown.has('arrowdown') || this.keysDown.has('s') ? 1 : 0);
    const moveRight =
      (this.keysDown.has('arrowright') || this.keysDown.has('d') ? 1 : 0) -
      (this.keysDown.has('arrowleft') || this.keysDown.has('a') ? 1 : 0);
    if (moveForward !== 0 || moveRight !== 0) {
      const panSpeed = 24 * dt;
      const sinAz = Math.sin(this.camAzimuth);
      const cosAz = Math.cos(this.camAzimuth);
      this.camGoalTarget.x +=
        (-sinAz * moveForward + cosAz * moveRight) * panSpeed;
      this.camGoalTarget.z +=
        (-cosAz * moveForward - sinAz * moveRight) * panSpeed;
      this.clampCameraTarget();
    }

    const lerpFactor = Math.min(1, dt * 9.5);
    this.camTarget.lerp(this.camGoalTarget, lerpFactor);
    this.camRadius += (this.camGoalRadius - this.camRadius) * lerpFactor;
    this.camPolar += (this.camGoalPolar - this.camPolar) * lerpFactor;
    this.camAzimuth += (this.camGoalAzimuth - this.camAzimuth) * lerpFactor;

    let shakeX = 0;
    let shakeY = 0;
    if (this.cameraShake > 0.001) {
      shakeX = (Math.random() - 0.5) * this.cameraShake;
      shakeY = (Math.random() - 0.5) * this.cameraShake;
      this.cameraShake = Math.max(0, this.cameraShake - dt * 0.9);
    }

    const camX =
      this.camTarget.x +
      this.camRadius * Math.sin(this.camPolar) * Math.sin(this.camAzimuth) +
      shakeX;
    const camY = this.camRadius * Math.cos(this.camPolar) + shakeY;
    const camZ =
      this.camTarget.z +
      this.camRadius * Math.sin(this.camPolar) * Math.cos(this.camAzimuth);

    this.camera.position.set(camX, camY, camZ);
    this.camera.lookAt(this.camTarget);

    // Dynamically keep Sun shadow frustum tight & sharp around camTarget
    this.updateSunShadowFrustum();

    // Keep touch preview tooltip anchored smoothly above 3D ghost during pan/zoom & track offscreen/gesture state
    if (this.activeTouchHoverInfo && isBuildPhase) {
      const proj = this.projectWorldToScreen(this.touchWorldAnchor);
      const isGestureMoving =
        this.activeTouches.size > 0 && this.touchGestureMoved;
      const offscreen = this.isTouchProjectionOffscreen(proj);
      if (
        Math.hypot(
          proj.x - this.activeTouchHoverInfo.screenX,
          proj.y - this.activeTouchHoverInfo.screenY
        ) > 1.5 ||
        this.activeTouchHoverInfo.isGestureMoving !== isGestureMoving ||
        this.activeTouchHoverInfo.offscreen !== offscreen
      ) {
        this.activeTouchHoverInfo.screenX = proj.x;
        this.activeTouchHoverInfo.screenY = proj.y;
        this.activeTouchHoverInfo.isGestureMoving = isGestureMoving;
        this.activeTouchHoverInfo.offscreen = offscreen;
        this.onHoverStatusChange?.(this.activeTouchHoverInfo);
      }
    }

    if (this.previewPathMat) {
      this.previewPathMat.uniforms.uTime.value = uTimeVal;
    }

    const goalBuildAlpha = isBuildPhase ? 1.0 : 0.0;

    for (const island of this.islands.values()) {
      island.floorUniforms.uTime.value = uTimeVal;
      const currBuildAlpha = island.floorUniforms.uBuildAlpha.value;
      island.floorUniforms.uBuildAlpha.value =
        currBuildAlpha +
        (goalBuildAlpha - currBuildAlpha) * Math.min(1, dt * 6.5);

      island.foamMat.uniforms.uTime.value = uTimeVal;

      // Stepping-stone path opacity: 0.58 in BUILD (dimmed to 0.12 when previewPathMesh is active!), 0.22 in RUN
      if (island.pathMat) {
        island.pathMat.uniforms.uTime.value = uTimeVal;
        const targetPathOpacity = isBuildPhase
          ? island.playerId === this.localPlayerId &&
            this.previewPathMesh !== null
            ? 0.12
            : 0.58
          : 0.22;
        const currOp = island.pathMat.uniforms.uOpacity.value;
        island.pathMat.uniforms.uOpacity.value =
          currOp + (targetPathOpacity - currOp) * Math.min(1, dt * 10.0);
      }

      island.clapMarkerGroup.visible = isBuildPhase;

      // Toy-Box Spring Pop Animation (0.26s elastic squash-and-stretch) on newly placed Castle Pillars & Curtain Bridges
      for (const entry of island.towerMeshes.values()) {
        const ageSec = (now - entry.born) / 1000;
        if (ageSec < 0.26) {
          const scaleY = evalToyBoxSpringScaleY(ageSec / 0.26);
          const scaleXZ = 1 / Math.sqrt(scaleY);
          entry.group.scale.set(scaleXZ, scaleY, scaleXZ);
        } else if (entry.group.scale.y !== 1) {
          entry.group.scale.set(1, 1, 1);
        }
      }

      for (const bEntry of island.bridgeEntries) {
        const ageSec = (now - bEntry.born) / 1000;
        if (ageSec < 0.26) {
          bEntry.group.scale.y = evalToyBoxSpringScaleY(ageSec / 0.26);
        } else if (bEntry.group.scale.y !== 1) {
          bEntry.group.scale.y = 1;
        }
      }

      // Elemental Spires: crisp hairline alpha & compact base cooldown ring
      for (const spireRig of island.spireRigs) {
        const targetRingAlpha = isBuildPhase
          ? 0.24 + spireRig.targetHoverBoost * 0.34 // 0.24 -> 0.58 near hover/ghost
          : 0.13;
        const currRingAlpha = spireRig.aoeMat.uniforms.uRingAlpha.value;
        spireRig.aoeMat.uniforms.uRingAlpha.value =
          currRingAlpha + (targetRingAlpha - currRingAlpha) * Math.min(1, dt * 10.0);

        spireRig.cooldownRingMesh.visible = isRunPhase;

        if (spireRig.recoil > 0) {
          spireRig.recoil = Math.max(0, spireRig.recoil - dt * 3.0);
        }
        if (spireRig.spireType === 'CHRONO_SPIRE') {
          spireRig.upperCore.position.y =
            spireRig.baseCoreY +
            Math.sin(uTimeVal * 2.4) * 0.045 -
            spireRig.recoil * 0.16;
        } else {
          spireRig.upperCore.position.y =
            spireRig.baseCoreY - spireRig.recoil * 0.12;
        }
      }

      // Subtle idle breathing for Runner at North Gate during BUILD
      if (isBuildPhase) {
        island.runner.pelvis.position.y =
          0.45 + Math.sin(uTimeVal * 2.8) * 0.04;
        island.runner.statusRing.visible = false;
      }

      // Hide island 3D badge on focused island during BUILD to prevent HUD clutter
      const headerEl = this.labelElements.get(island.playerId);
      if (headerEl) {
        const isFocusedBuild =
          !this.arenaOverviewMode &&
          isBuildPhase &&
          island.playerId === (this.focusedPlayerId || this.localPlayerId);
        if (isFocusedBuild) {
          headerEl.style.display = 'none';
        } else {
          const gw = this.currentRoomState?.roundConfig.gridWidth || 20;
          const worldPos = new THREE.Vector3(
            island.offsetX + gw / 2,
            2.1,
            island.offsetZ - 1.2
          );
          this.projectToDOM(worldPos, headerEl);
        }
      }

      const runnerEl = this.runnerLabels.get(island.playerId);
      if (runnerEl && isRunPhase) {
        const rPos = new THREE.Vector3(
          island.offsetX + island.runner.root.position.x,
          1.82,
          island.offsetZ + island.runner.root.position.z
        );
        this.projectToDOM(rPos, runnerEl);
      } else if (runnerEl) {
        runnerEl.style.display = 'none';
      }
    }

    // Update Clean Ground Shockwaves
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.age += dt;
      if (sw.age >= sw.maxAge) {
        this.scene.remove(sw.mesh);
        (sw.mesh.material as THREE.Material).dispose();
        if (sw.bolt) {
          this.scene.remove(sw.bolt);
          sw.bolt.geometry.dispose();
          (sw.bolt.material as THREE.Material).dispose();
        }
        this.shockwaves.splice(i, 1);
      } else {
        const t = sw.age / sw.maxAge;
        const ease = 1 - Math.pow(1 - t, 3);
        const rad = 0.45 + ease * (sw.maxRadius - 0.45);
        sw.mesh.scale.set(rad, 1, rad);
        (sw.mesh.material as THREE.MeshBasicMaterial).opacity =
          (1 - t) * 0.76;
        if (sw.bolt) {
          (sw.bolt.material as THREE.LineBasicMaterial).opacity = Math.max(
            0,
            1 - t * 2.4
          );
        }
      }
    }

    // Update Soft Circular Sprite Particle Bursts
    for (let i = this.particleBursts.length - 1; i >= 0; i--) {
      const pb = this.particleBursts[i];
      pb.age += dt;
      if (pb.age >= pb.maxAge) {
        this.scene.remove(pb.points);
        pb.points.geometry.dispose();
        (pb.points.material as THREE.Material).dispose();
        this.particleBursts.splice(i, 1);
      } else {
        const posAttr = pb.points.geometry.getAttribute(
          'position'
        ) as THREE.BufferAttribute;
        const arr = posAttr.array as Float32Array;
        for (let j = 0; j < arr.length; j += 3) {
          arr[j] += pb.velocities[j] * dt;
          arr[j + 1] += pb.velocities[j + 1] * dt;
          arr[j + 2] += pb.velocities[j + 2] * dt;
          pb.velocities[j + 1] -= pb.gravity * dt;
        }
        posAttr.needsUpdate = true;
        (pb.points.material as THREE.PointsMaterial).opacity =
          pb.baseOpacity * (1 - pb.age / pb.maxAge);
      }
    }

    // Hardware MSAA direct render!
    this.renderer.render(this.scene, this.camera);
  }

  private projectToDOM(worldVec: THREE.Vector3, el: HTMLElement) {
    const projected = worldVec.clone().project(this.camera);
    if (projected.z > 1) {
      el.style.display = 'none';
      return;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    const w = rect.width || window.innerWidth;
    const h = rect.height || window.innerHeight;
    const x = rect.left + (projected.x * 0.5 + 0.5) * w;
    const y = rect.top + (-projected.y * 0.5 + 0.5) * h;
    el.style.display = 'flex';
    el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
  }
}
