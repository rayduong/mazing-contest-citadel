import * as THREE from 'three';
import {
  CitadelCircuitryResult,
  computeCitadelCircuitry,
  computeFullMazePath,
  do2x2Overlap,
  isCellIn2x2,
  resolveSmart2x2Placement,
  SpireConduitLink,
  validateTowerPlacement,
} from '../shared/pathfinding.js';
import { evaluateMazeRunTime, OVERCHARGE_CDR } from '../shared/simulation.js';
import {
  ActiveBuildTool,
  GridPoint,
  MazeEvalResult,
  PathResult,
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

export type { ActiveBuildTool };

export type InspectedWorldFeature =
  | {
      kind: 'SPIRE';
      spireIndex: number;
      spireType: SpireType;
      x: number;
      y: number;
      overchargeTier: number;
      effectiveRange: number;
      effectiveCooldown: number;
      slowPercent: number;
      slowDuration: number;
      auraSlowPercent?: number;
      cdrPulseSeconds?: number;
      projectedOrLiveHits: number;
    }
  | {
      kind: 'KEEP';
      keepIndex: number;
      x: number;
      y: number;
      linked: boolean;
    }
  | {
      kind: 'RUNNER';
      playerId: string;
      archetype: RunnerArchetype;
      currentSpeed: number;
      baseSpeed: number;
      statusLabel?: string;
    }
  | {
      kind: 'GATE';
      gateType: 'SPAWN' | 'EXIT';
      x: number;
      y: number;
      parTimeSeconds: number;
    };

export interface HoverStatusInfo {
  cell: GridPoint | null;
  screenX: number;
  screenY: number;
  valid: boolean;
  snapped?: boolean;
  reason?: string;
  deltaTime?: number;
  deltaClaps?: number;
  deltaKeeps?: number;
  deltaOvercharge?: number;
  previewTime?: number;
  existingTower?: PlacedTower | null;
  inspectedFeature?: InspectedWorldFeature | null;
  isTouchPreview?: boolean;
  isLoupeDragging?: boolean;
  isGestureMoving?: boolean;
  placeNearTopEdge?: boolean;
  offscreen?: boolean;
}

const ISLAND_SPACING_X = 40;
const ISLAND_SPACING_Z = 44;
const SEA_LEVEL_Y = -1.42;

// ============================================================================
// STATIC GEOMETRY MERGER & PROCEDURAL SPRITE / CONTACT AO TEXTURES
// ============================================================================

/**
 * Merges static sub-geometries (position + normal) into a single draw-call BufferGeometry.
 */
function mergeSimpleGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const nonIndexed: THREE.BufferGeometry[] = [];
  let totalVerts = 0;

  for (const g of geos) {
    const ni = g.index ? g.toNonIndexed() : g.clone();
    if (!ni.getAttribute('normal')) {
      ni.computeVertexNormals();
    }
    totalVerts += ni.getAttribute('position').count;
    nonIndexed.push(ni);
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  let offset = 0;

  for (const ni of nonIndexed) {
    const pos = ni.getAttribute('position');
    const norm = ni.getAttribute('normal');
    for (let i = 0; i < pos.count; i++) {
      const base = (offset + i) * 3;
      positions[base] = pos.getX(i);
      positions[base + 1] = pos.getY(i);
      positions[base + 2] = pos.getZ(i);
      normals[base] = norm.getX(i);
      normals[base + 1] = norm.getY(i);
      normals[base + 2] = norm.getZ(i);
    }
    offset += pos.count;
    ni.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.computeBoundingSphere();
  return merged;
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const half = size * 0.5;
  const grad = ctx.createRadialGradient(half, half, 4, half, half, half - 2);
  grad.addColorStop(0.0, 'rgba(20, 38, 22, 0.34)');
  grad.addColorStop(0.58, 'rgba(20, 38, 22, 0.18)');
  grad.addColorStop(0.86, 'rgba(20, 38, 22, 0.04)');
  grad.addColorStop(1.0, 'rgba(20, 38, 22, 0.0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createSoftCircleSpriteTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const half = size * 0.5;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half - 1);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.45, 'rgba(255, 255, 255, 0.8)');
  grad.addColorStop(0.8, 'rgba(255, 255, 255, 0.18)');
  grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ============================================================================
// WORLD-CLASS DIORAMA GLSL SHADERS
// ============================================================================

/**
 * Serene Mediterranean Cerulean Sea Shader (`y = -1.42m`):
 * Smooth depth gradient + ultra-low-frequency swell + zero-seam horizon blend into `#d4ebf7`.
 */
function createTranquilSeaShader(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: false,
    toneMapped: true,
    uniforms: {
      uTime: { value: 0 },
      uArenaCenter: { value: new THREE.Vector2(10, 13) },
      uCoastalAqua: { value: new THREE.Color('#5cb8db') },
      uDeepCerulean: { value: new THREE.Color('#3b83a8') },
      uHorizonColor: { value: new THREE.Color('#d4ebf7') },
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
        float depthFactor = smoothstep(10.0, 115.0, distFromCenter);
        vec3 baseSea = mix(uCoastalAqua, uDeepCerulean, depthFactor);

        vec2 p = vWorldXZ * 0.13;
        float swell1 = sin(p.x + uTime * 0.24) * cos(p.y - uTime * 0.19);
        float swell2 = sin((p.x * 0.68 - p.y * 0.76) + uTime * 0.16);
        float swell = (swell1 * 0.6 + swell2 * 0.4) * 0.032;
        vec3 col = baseSea * (1.0 + swell);

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>

        float horizonMist = smoothstep(145.0, 325.0, distFromCenter);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uHorizonColor, horizonMist);

        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Rounded-Corner Shoreline Foam + Coastal Reef Shallows Halo Shader:
 * - Rounded SDF (`r = 0.95m`) eliminates harsh 90° box corners.
 * - Renders a luminous turquoise coastal reef halo around each individual island.
 * - Uses a smooth `sin(phase * PI)` envelope so outward ripples never pop every 5s.
 */
function createShorelineFoamShader(
  bankWidth: number,
  bankDepth: number,
  phaseOffset = 0
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: true,
    uniforms: {
      uTime: { value: 0 },
      uPhaseOffset: { value: phaseOffset },
      uFoamColor: { value: new THREE.Color('#f8fafc') },
      uShallowsColor: { value: new THREE.Color('#7dd3fc') },
      uHalfBank: {
        value: new THREE.Vector2(bankWidth * 0.5, bankDepth * 0.5),
      },
      uHalfPlane: {
        value: new THREE.Vector2(
          (bankWidth + 4.8) * 0.5,
          (bankDepth + 4.8) * 0.5
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
      uniform float uPhaseOffset;
      uniform vec3 uFoamColor;
      uniform vec3 uShallowsColor;
      uniform vec2 uHalfBank;
      uniform vec2 uHalfPlane;
      varying vec2 vUv;

      void main() {
        vec2 worldPos = abs(vUv) * uHalfPlane;
        float cornerR = 0.95;
        vec2 d = worldPos - (uHalfBank - vec2(cornerR));
        float boxDist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - cornerR;

        if (boxDist < -0.22 || boxDist > 2.25) discard;

        float gentleWave = sin(vUv.x * 5.5 + uTime * 0.58) * cos(vUv.y * 5.5 - uTime * 0.48) * 0.032;
        float dist = max(0.0, boxDist + gentleWave);

        // Coastal turquoise reef halo around every island
        float shallows = smoothstep(2.15, -0.05, boxDist) * 0.32;

        // Crisp cream shoreline contact band
        float contactBand = smoothstep(0.28, 0.02, dist) * 0.78;

        // Smooth bell-enveloped outward ripple (zero pop-in!)
        float phase = fract(uTime * 0.17 + uPhaseOffset);
        float env = sin(phase * 3.14159265) * (1.0 - phase * 0.42);
        float ripplePos = 0.16 + phase * 1.38;
        float ripple = smoothstep(0.08, 0.0, abs(dist - ripplePos)) * env * 0.42;

        float foamMask = clamp(contactBand + ripple, 0.0, 0.82);
        float totalAlpha = clamp(shallows + foamMask, 0.0, 0.84);
        if (totalAlpha < 0.004) discard;

        vec3 col = mix(uShallowsColor, uFoamColor, clamp(foamMask / max(totalAlpha, 0.001), 0.0, 1.0));
        gl_FragColor = vec4(col, totalAlpha);
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
  uCoarsePointer: { value: number };
  uAnchorBox: { value: THREE.Vector4 };
  uReticleMode: { value: number };
  uSageTurf: { value: THREE.Color };
  uSunlitMeadow: { value: THREE.Color };
  uWarmCream: { value: THREE.Color };
}

/**
 * Calm Sunlit Velvety Meadow Material (`MeshStandardMaterial` + `onBeforeCompile`):
 * - Eliminates the aliased 2x2 mowed checkerboard (`mowedBand`).
 * - Renders a serene diagonal sunlit turf gradient + gentle cloud dapple.
 * - Crisp derivative-AA `1x1` cream build grid (`0.14` desktop, `0.215` mobile touch in BUILD, `0.0` in RUN).
 * - `6.0m` orthogonal row/column alignment rails extending cleanly past a mobile player's thumb!
 */
function createGrasslandFloorMaterial(coarsePointer: boolean): {
  material: THREE.MeshStandardMaterial;
  uniforms: GrasslandFloorUniforms;
} {
  const uniforms: GrasslandFloorUniforms = {
    uTime: { value: 0 },
    uGridSize: { value: new THREE.Vector2(20, 26) },
    uCursorPos: { value: new THREE.Vector2(-99, -99) },
    uBuildAlpha: { value: 1.0 },
    uCoarsePointer: { value: coarsePointer ? 1.0 : 0.0 },
    uAnchorBox: { value: new THREE.Vector4(-99, -99, -97, -97) },
    uReticleMode: { value: 0.0 },
    uSageTurf: { value: new THREE.Color('#53983d') },
    uSunlitMeadow: { value: new THREE.Color('#66b04d') },
    uWarmCream: { value: new THREE.Color('#eef7dc') },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0,
  });
  material.userData.uniforms = uniforms;
  material.customProgramCacheKey = () => 'meadow-floor-tabletop-v3';

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
        uniform float uCoarsePointer;
        uniform vec4 uAnchorBox;
        uniform float uReticleMode;
        uniform vec3 uSageTurf;
        uniform vec3 uSunlitMeadow;
        uniform vec3 uWarmCream;
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
          // PlaneGeometry.rotateX(-PI/2) maps uv.y=1 to North (-Z) and uv.y=0 to South (+Z)
          vec2 floorUv = vec2(vFloorUv.x, 1.0 - vFloorUv.y);
          vec2 cellPos = floorUv * uGridSize;
          vec2 f = fract(cellPos);
          vec2 aa = max(fwidth(cellPos), vec2(0.006));

          // 1. Calm sunlit gradient + smooth cloud dapple (zero 2x2 checkerboard aliasing)
          float sunGrad = clamp(1.0 - (floorUv.x * 0.42 + floorUv.y * 0.58), 0.0, 1.0);
          vec3 grassCol = mix(uSageTurf, uSunlitMeadow, sunGrad);

          float cloudDapple = floorFbm(cellPos * 0.11 + vec2(uTime * 0.01, uTime * 0.007));
          grassCol *= 1.0 + (cloudDapple - 0.5) * 0.082;

          // 2. Crisp derivative-AA 1x1 tactile build grid + 6.0m thumb-clearing alignment rails
          if (uBuildAlpha > 0.002) {
            vec2 gridDist = min(f, 1.0 - f);
            float gx = 1.0 - smoothstep(0.0, aa.x * 1.32, gridDist.x);
            float gy = 1.0 - smoothstep(0.0, aa.y * 1.32, gridDist.y);
            float hairline = max(gx, gy);

            float vertexDot = (1.0 - smoothstep(0.0, aa.x * 2.1, gridDist.x)) *
                              (1.0 - smoothstep(0.0, aa.y * 2.1, gridDist.y));

            float baseAlpha = mix(0.14, 0.215, uCoarsePointer);
            float cursorProx = smoothstep(4.2, 0.45, length(cellPos - uCursorPos));
            float gridAlpha = (hairline * mix(baseAlpha, 0.32, cursorProx) + vertexDot * 0.13) * uBuildAlpha;
            grassCol = mix(grassCol, uWarmCream, clamp(gridAlpha, 0.0, 0.44));

            if (uReticleMode > 0.5) {
              vec2 boxCenter = 0.5 * (uAnchorBox.xy + uAnchorBox.zw);
              float outX = max(0.0, abs(cellPos.x - boxCenter.x) - 1.0);
              float outY = max(0.0, abs(cellPos.y - boxCenter.y) - 1.0);
              float insideBox = step(outX, 0.001) * step(outY, 0.001);

              float railLineX = max(
                1.0 - smoothstep(0.0, aa.x * 1.65, abs(cellPos.x - uAnchorBox.x)),
                1.0 - smoothstep(0.0, aa.x * 1.65, abs(cellPos.x - uAnchorBox.z))
              ) * smoothstep(6.0, 0.35, outY);

              float railLineY = max(
                1.0 - smoothstep(0.0, aa.y * 1.65, abs(cellPos.y - uAnchorBox.y)),
                1.0 - smoothstep(0.0, aa.y * 1.65, abs(cellPos.y - uAnchorBox.w))
              ) * smoothstep(6.0, 0.35, outX);

              float rails = max(railLineX, railLineY) * (1.0 - insideBox);

              vec3 railCol = uReticleMode < 1.5
                ? vec3(0.76, 0.99, 0.83)
                : (uReticleMode < 2.5 ? vec3(1.0, 0.72, 0.76) : vec3(1.0, 0.91, 0.52));

              grassCol = mix(grassCol, railCol, insideBox * 0.11 * uBuildAlpha);
              grassCol = mix(grassCol, railCol, clamp(rails * 0.46, 0.0, 0.65) * uBuildAlpha);
            }
          }

          // 3. Soft perimeter contact framing
          vec2 distToBorder = min(cellPos, uGridSize - cellPos);
          float minBorderDist = min(distToBorder.x, distToBorder.y);
          float edgeTone = smoothstep(0.0, 0.65, minBorderDist);
          grassCol *= 0.91 + 0.09 * edgeTone;

          diffuseColor.rgb *= grassCol;
        }`
      );
  };

  return { material, uniforms };
}

/**
 * Precision `2x2` Ground Reticle Shader (`2.16 x 2.16m` quad at `y = 0.036`):
 * - 4 razor-sharp L-shaped corner brackets + internal `1x1` crosshair sub-divider.
 * - Per-quadrant `uBlockedCells` mask lighting up exact colliding `1x1` sub-cells in coral.
 * - Diagonal prohibition slash when `uBlocksPath > 0.5`.
 * - Crisp amber-coral Remove frame when `uMode == 3.0` (with 3D ghost cylinder hidden!).
 */
function createReticlePadShader(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: true,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uMode: { value: 1.0 }, // 1=valid mint, 2=invalid coral, 3=remove amber, 4=circuit gold
      uBlockedCells: { value: new THREE.Vector4(0, 0, 0, 0) }, // (0,0), (1,0), (0,1), (1,1)
      uBlocksPath: { value: 0.0 },
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
      uniform float uMode;
      uniform vec4 uBlockedCells;
      uniform float uBlocksPath;
      varying vec2 vUv;

      void main() {
        // PlaneGeometry.rotateX(-PI/2) maps uv.y=1 to North (p.y=0) and uv.y=0 to South (p.y=2)
        vec2 p = vec2(vUv.x, 1.0 - vUv.y) * 2.16 - 0.08;
        vec2 aa = max(fwidth(p), vec2(0.008));
        float edgeAa = max(aa.x, aa.y);

        vec2 boxD = abs(p - vec2(1.0)) - vec2(1.0);
        float sdf = max(boxD.x, boxD.y);
        if (sdf > 0.07) discard;

        float inside = 1.0 - smoothstep(-edgeAa, edgeAa, sdf);

        // Thin full perimeter frame
        float thinFrame = (1.0 - smoothstep(0.0, edgeAa * 1.5, abs(sdf))) * 0.42;

        // 4 bold L-shaped corner brackets (0.46m arm length, 0.075m stroke)
        vec2 cornerDist = min(p, 2.0 - p);
        float bracketBand = (1.0 - smoothstep(0.0, edgeAa * 1.4, abs(sdf + 0.032) - 0.036)) * inside;
        float cornerMask = 1.0 - smoothstep(0.44, 0.48, min(
          cornerDist.x < 0.12 ? cornerDist.y : 9.0,
          cornerDist.y < 0.12 ? cornerDist.x : 9.0
        ));
        float brackets = bracketBand * cornerMask;

        // Internal 1x1 sub-cell crosshair
        float crossX = 1.0 - smoothstep(0.0, aa.x * 1.35, abs(p.x - 1.0));
        float crossY = 1.0 - smoothstep(0.0, aa.y * 1.35, abs(p.y - 1.0));
        float subCross = max(crossX, crossY) * inside * 0.28;

        // Per-cell 1x1 collision highlight
        float blockedMask = 0.0;
        if (inside > 0.01) {
          float qx = step(1.0, p.x);
          float qy = step(1.0, p.y);
          float c00 = (1.0 - qx) * (1.0 - qy) * uBlockedCells.x;
          float c10 = qx * (1.0 - qy) * uBlockedCells.y;
          float c01 = (1.0 - qx) * qy * uBlockedCells.z;
          float c11 = qx * qy * uBlockedCells.w;
          blockedMask = clamp(c00 + c10 + c01 + c11, 0.0, 1.0) * inside;
        }

        // Blocked-path centered prohibition slash when cells are clear but maze path seals
        float slashMask = 0.0;
        if (uBlocksPath > 0.5 && inside > 0.01) {
          float diagDist = abs((p.x - 1.0) + (p.y - 1.0)) * 0.7071;
          float inCircle = 1.0 - smoothstep(0.56, 0.62, length(p - vec2(1.0)));
          float ring = (1.0 - smoothstep(0.0, edgeAa * 1.6, abs(length(p - vec2(1.0)) - 0.56)));
          float slash = (1.0 - smoothstep(0.032, 0.032 + edgeAa, diagDist)) * inCircle;
          slashMask = clamp(ring + slash, 0.0, 1.0);
        }

        vec3 baseCol = uMode < 1.5
          ? vec3(0.52, 0.94, 0.67)
          : (uMode < 2.5
              ? vec3(0.98, 0.35, 0.45)
              : (uMode < 3.5 ? vec3(0.98, 0.68, 0.22) : vec3(0.99, 0.82, 0.22)));

        float pulse = 0.92 + 0.08 * sin(uTime * 5.0);
        vec3 col = baseCol;
        float alpha = clamp(brackets * 0.95 + thinFrame + subCross, 0.0, 0.96) * pulse;

        if (blockedMask > 0.01) {
          float stripe = 0.78 + 0.22 * step(0.5, fract((p.x + p.y) * 3.0));
          col = mix(col, vec3(0.96, 0.24, 0.37), 0.75);
          alpha = max(alpha, blockedMask * 0.42 * stripe);
        }

        if (slashMask > 0.01) {
          col = vec3(0.98, 0.32, 0.38);
          alpha = max(alpha, slashMask * 0.88);
        }

        if (alpha < 0.005) discard;
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Flush Ground Inlaid Gold Ley-Line Conduit Shader (`y = 0.024m`):
 * Connects Keep-powered wall chains (`dx^2 + dy^2 <= 13`) into Overcharged Elemental Spires,
 * including across 1-tile walkable Spire corridors without blocking Runner movement!
 */
function createLeyConduitShader(isPreview = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: true,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: isPreview ? 0.82 : 0.92 },
      uSlateColor: { value: new THREE.Color('#293544') },
      uGoldColor: { value: new THREE.Color('#fbbf24') },
      uHotColor: { value: new THREE.Color('#fef08a') },
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
      uniform float uOpacity;
      uniform vec3 uSlateColor;
      uniform vec3 uGoldColor;
      uniform vec3 uHotColor;
      varying vec2 vUv;

      void main() {
        float across = abs(vUv.y - 0.5) * 2.0; // 0 center .. 1 outer edge
        float endFade = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);

        float bezel = 1.0 - smoothstep(0.76, 0.98, across);
        float core = 1.0 - smoothstep(0.28, 0.54, across);

        // Gentle energy pulse flowing from Wall/Keep (vUv.x=0) into Spire (vUv.x=1)
        float flow = fract(vUv.x * 1.6 - uTime * 0.85);
        float pulse = smoothstep(0.0, 0.35, flow) * (1.0 - smoothstep(0.35, 0.85, flow));

        vec3 gold = mix(uGoldColor, uHotColor, pulse * 0.65);
        vec3 col = mix(uSlateColor, gold, core);
        float alpha = uOpacity * endFade * mix(bezel * 0.48, 0.94, core);
        if (alpha < 0.005) discard;

        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Calm Stationary Sandstone Flagstone Path Ribbon Shader:
 * - Zero constant marching-ants stone scrolling in BUILD!
 * - Crisp warm-olive outer edge stroke so sunlit cream flagstones pop cleanly on bright turf.
 * - Single gentle directional travel shimmer every ~4.0s.
 */
function createPathRibbonShader(
  colorHex = '#fefce8',
  initialOpacity = 0.66
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: true,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(colorHex) },
      uHighlightColor: { value: new THREE.Color('#fffef5') },
      uBorderColor: { value: new THREE.Color('#3b592c') },
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
      uniform vec3 uBorderColor;
      uniform float uOpacity;
      varying vec2 vUv;

      void main() {
        float across = abs(vUv.y - 0.5) * 2.0;
        float outerMask = 1.0 - smoothstep(0.82, 1.0, across);
        float innerMask = 1.0 - smoothstep(0.56, 0.76, across);

        // Stationary world-anchored flagstones (vUv.x in meters)
        float paver = fract(vUv.x * 1.35);
        float stone = smoothstep(0.08, 0.18, paver) * smoothstep(0.94, 0.84, paver);

        // Single calm directional shimmer wave every ~4.0s
        float wave = fract(vUv.x * 0.05 - uTime * 0.25);
        float shimmer = smoothstep(0.0, 0.14, wave) * (1.0 - smoothstep(0.14, 0.36, wave));

        vec3 stoneCol = mix(uColor * 0.90, mix(uColor, uHighlightColor, 0.5 + shimmer * 0.45), stone);
        vec3 col = mix(uBorderColor, stoneCol, innerMask);

        float alpha = uOpacity * outerMask * mix(0.42, 0.68 + 0.32 * stone, innerMask);
        if (alpha < 0.004) discard;

        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

function createFlatPathRibbonGeometry(
  points: GridPoint[],
  offsetX: number,
  offsetZ: number,
  yHeight: number,
  halfWidth = 0.155
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
 * Builds a tapered 3D ribbon strip between `start` and `end` (replaces hardware-clamped 1px THREE.Line!).
 */
function createTaperedArcRibbonGeometry(
  start: THREE.Vector3,
  end: THREE.Vector3,
  apexLift: number,
  jitterAmp: number,
  segments: number,
  startHalfWidth: number,
  endHalfWidth: number
): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = new THREE.Vector3().lerpVectors(start, end, t);
    p.y += Math.sin(t * Math.PI) * apexLift;
    if (jitterAmp > 0 && i > 0 && i < segments) {
      p.x += (Math.random() - 0.5) * jitterAmp;
      p.y += (Math.random() - 0.35) * jitterAmp * 0.85;
      p.z += (Math.random() - 0.5) * jitterAmp;
    }
    pts.push(p);
  }

  const vertCount = pts.length * 2;
  const positions = new Float32Array(vertCount * 3);
  const indices: number[] = [];

  for (let i = 0; i < pts.length; i++) {
    const t = i / (pts.length - 1);
    const hw = startHalfWidth + (endHalfWidth - startHalfWidth) * t;
    const curr = pts[i];
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];

    let dx = next.x - prev.x;
    let dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;

    // Horizontal cross-ribbon + slight vertical cant so it reads from both zenith and angled cameras
    const nx = -dz * hw;
    const nz = dx * hw;
    const ny = hw * 0.35;

    const vBase = i * 6;
    positions[vBase] = curr.x - nx;
    positions[vBase + 1] = curr.y - ny;
    positions[vBase + 2] = curr.z - nz;

    positions[vBase + 3] = curr.x + nx;
    positions[vBase + 4] = curr.y + ny;
    positions[vBase + 5] = curr.z + nz;

    if (i < pts.length - 1) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Dual-Contrast Spire Range Perimeter Shader:
 * Subtle dark-sage backing rim + ivory-lifted elemental hairline so Storm/Frost/Chrono rings
 * stay razor-legible over sunlit grass at low (`0.26`) alpha without filling the field with neon.
 */
function createSpireAoEShader(
  range: number,
  spireType: SpireType = 'THUNDERCLAP'
): THREE.ShaderMaterial {
  const baseColor =
    spireType === 'FROST_OBELISK'
      ? new THREE.Color('#38bdf8')
      : spireType === 'CHRONO_SPIRE'
      ? new THREE.Color('#c084fc')
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
      uShadowRim: { value: new THREE.Color('#1e3a24') },
      uRingAlpha: { value: 0.28 },
      uInnerFillAlpha: { value: spireType === 'FROST_OBELISK' ? 0.05 : 0.0 },
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
      uniform vec3 uShadowRim;
      uniform float uRingAlpha;
      uniform float uInnerFillAlpha;
      uniform float uOverchargeTier;
      varying vec2 vUv;

      void main() {
        float r = length(vUv);
        float aa = max(fwidth(r), 0.004);
        if (r > 1.0 + aa * 2.0) discard;

        float ringCenter = 1.0 - aa * 1.8;
        float coreLine = 1.0 - smoothstep(aa * 0.55, aa * 1.85, abs(r - ringCenter));
        float shadowBand = 1.0 - smoothstep(aa * 0.8, aa * 3.1, abs(r - ringCenter));
        float innerMask = 1.0 - smoothstep(ringCenter - aa, ringCenter + aa, r);

        vec3 tint = mix(uBaseColor, uOverchargeGold, clamp(uOverchargeTier * 0.16, 0.0, 0.42));
        vec3 brightLine = mix(tint, vec3(1.0, 0.99, 0.94), 0.26);
        vec3 ringCol = mix(uShadowRim, brightLine, clamp(coreLine * 1.15, 0.0, 1.0));

        float rimAlpha = (shadowBand * 0.36 + coreLine * 0.85) * uRingAlpha;
        float alpha = innerMask * uInnerFillAlpha + rimAlpha;
        if (alpha < 0.003) discard;

        vec3 finalCol = mix(tint, ringCol, clamp(rimAlpha / max(alpha, 0.001), 0.0, 1.0));
        gl_FragColor = vec4(finalCol, clamp(alpha, 0.0, 0.88));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Compact Radial Cooldown Ring (`r = 1.08m`) + Chrono CDR Flash Halo + Ground Overcharge Segments.
 */
function createSpireBaseCooldownShader(
  spireType: SpireType = 'THUNDERCLAP'
): THREE.ShaderMaterial {
  const accentColor =
    spireType === 'FROST_OBELISK'
      ? new THREE.Color('#38bdf8')
      : spireType === 'CHRONO_SPIRE'
      ? new THREE.Color('#c084fc')
      : new THREE.Color('#f59e0b');

  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: true,
    side: THREE.DoubleSide,
    uniforms: {
      uChargeProgress: { value: 1.0 },
      uCdrFlash: { value: 0.0 },
      uAccentColor: { value: accentColor },
      uTrackColor: { value: new THREE.Color('#1e293b') },
      uReadyTint: { value: new THREE.Color('#fffbeb') },
      uChronoFlashColor: { value: new THREE.Color('#e9d5ff') },
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
      uniform float uCdrFlash;
      uniform vec3 uAccentColor;
      uniform vec3 uTrackColor;
      uniform vec3 uReadyTint;
      uniform vec3 uChronoFlashColor;
      varying vec2 vUv;

      void main() {
        float r = length(vUv);
        float aa = max(fwidth(r), 0.008);
        float band = smoothstep(0.82 - aa, 0.82 + aa, r) * (1.0 - smoothstep(0.96 - aa, 0.96 + aa, r));
        if (band < 0.005) discard;

        // Clockwise progress starting from 12 o'clock North (-Z -> vUv.y > 0)
        float angle = atan(vUv.x, vUv.y);
        float normAngle = fract((angle + 6.2831853) / 6.2831853);
        float fillMask = 1.0 - smoothstep(uChargeProgress - 0.015, uChargeProgress + 0.015, normAngle);
        if (uChargeProgress >= 0.995) fillMask = 1.0;

        vec3 readyCol = mix(uAccentColor, uReadyTint, uChargeProgress >= 0.98 ? 0.38 : 0.0);
        vec3 col = mix(uTrackColor, readyCol, fillMask);
        col = mix(col, uChronoFlashColor, clamp(uCdrFlash, 0.0, 1.0) * 0.85);
        float alpha = band * mix(0.32, 0.9, max(fillMask, uCdrFlash));

        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * 6-Lobed Crystalline Snowflake Wavefront Shader for `FROST_OBELISK` Glacial Nova (zero lightning bolts!).
 */
function createFrostHexNovaShader(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: true,
    side: THREE.DoubleSide,
    uniforms: {
      uOpacity: { value: 0.85 },
      uCyan: { value: new THREE.Color('#38bdf8') },
      uIceWhite: { value: new THREE.Color('#e0f2fe') },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      uniform vec3 uCyan;
      uniform vec3 uIceWhite;
      varying vec2 vUv;

      void main() {
        float r = length(vUv);
        float ang = atan(vUv.y, vUv.x);
        float hexMod = 0.90 + 0.09 * cos(ang * 6.0);
        float dist = abs(r - hexMod);
        float ring = 1.0 - smoothstep(0.02, 0.11, dist);
        float spokes = (1.0 - smoothstep(0.0, 0.06, abs(sin(ang * 3.0)))) * smoothstep(0.35, 0.9, r) * step(r, hexMod);
        float mask = clamp(ring + spokes * 0.35, 0.0, 1.0);
        if (mask < 0.01) discard;

        vec3 col = mix(uCyan, uIceWhite, ring * 0.65);
        gl_FragColor = vec4(col, mask * uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Dual-Arc Runner Status Ring Shader:
 * Displays single status cleanly OR splits 50/50 when e.g. Slow + Frost stack simultaneously!
 */
function createRunnerStatusRingShader(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: true,
    side: THREE.DoubleSide,
    uniforms: {
      uColorA: { value: new THREE.Color('#f59e0b') },
      uColorB: { value: new THREE.Color('#38bdf8') },
      uDual: { value: 0.0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform float uDual;
      varying vec2 vUv;

      void main() {
        float r = length(vUv);
        float aa = max(fwidth(r), 0.02);
        float band = smoothstep(0.70 - aa, 0.70 + aa, r) * (1.0 - smoothstep(0.98 - aa, 0.98 + aa, r));
        if (band < 0.01) discard;

        vec3 col = uColorA;
        if (uDual > 0.5) {
          float split = smoothstep(-0.06, 0.06, vUv.x);
          col = mix(uColorA, uColorB, split);
          float gap = smoothstep(0.0, 0.08, abs(vUv.x));
          band *= 0.35 + 0.65 * gap;
        }

        gl_FragColor = vec4(col, band * 0.88);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

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
// INTERNAL VISUAL RIG INTERFACES
// ============================================================================

interface ShockwaveEffect {
  mesh: THREE.Mesh;
  arcMesh?: THREE.Mesh;
  age: number;
  maxAge: number;
  startRadius: number;
  maxRadius: number;
  isShaderMat: boolean;
}

interface RelayArcEffect {
  mesh: THREE.Mesh;
  age: number;
  maxAge: number;
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
  spireIndex: number;
  spireType: SpireType;
  baseRange: number;
  gridX: number;
  gridY: number;
  upperCore: THREE.Object3D;
  baseCoreY: number;
  collarRimMesh: THREE.Mesh;
  overchargePips: THREE.Mesh[];
  groundTierArcs: THREE.Mesh[];
  cooldownRingMesh: THREE.Mesh;
  cooldownRingMat: THREE.ShaderMaterial;
  aoeMesh: THREE.Mesh;
  aoeMat: THREE.ShaderMaterial;
  targetHoverBoost: number;
  recoil: number;
  cdrFlash: number;
}

interface RuinVisualRig {
  group: THREE.Group;
  keepIndex: number;
  lanternMesh: THREE.Mesh;
  corniceMesh: THREE.Mesh;
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
  leftWing: THREE.Mesh | null;
  rightWing: THREE.Mesh | null;
  pennantMesh: THREE.Mesh | null;
  accentMesh: THREE.Mesh | null;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  statusRing: THREE.Mesh;
  statusRingMat: THREE.ShaderMaterial;
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

interface IslandBadgeRefs {
  root: HTMLDivElement;
  dot: HTMLSpanElement;
  name: HTMLElement;
  meta: HTMLSpanElement;
  lastColor: string;
  lastName: string;
  lastMeta: string;
  visible: boolean;
}

interface RunnerBadgeRefs {
  root: HTMLDivElement;
  dot: HTMLSpanElement;
  tag: HTMLSpanElement;
  time: HTMLSpanElement;
  lastDotColor: string;
  lastTag: string;
  lastTime: string;
  visible: boolean;
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
  conduitMat: THREE.ShaderMaterial;
  fogVeilMesh: THREE.Mesh;
  trimMesh: THREE.Mesh;
  hitPlane: THREE.Mesh;
  padGroup: THREE.Group;
  towerGroup: THREE.Group;
  bridgeGroup: THREE.Group;
  conduitGroup: THREE.Group;
  bridgeEntries: BridgeVisualEntry[];
  clapMarkerGroup: THREE.Group;
  towerMeshes: Map<string, WallVisualEntry>;
  spireRigs: SpireVisualRig[];
  ruinRigs: RuinVisualRig[];
  pathMesh: THREE.Mesh | null;
  pathMat: THREE.ShaderMaterial;
  runner: RunnerRig;
  lastTowersSig: string;
  lastSimStatus: string;
  lastSimTimeText: string;
}

interface ActiveTouchPoint {
  x: number;
  y: number;
  startX: number;
  startY: number;
}

interface CachedHoverPreview {
  key: string;
  valid: boolean;
  snapped: boolean;
  reason?: string;
  reasonCode?: string;
  deltaTime: number;
  deltaClaps: number;
  deltaKeeps: number;
  deltaOvercharge: number;
  previewTime: number;
}

// ============================================================================
// ARENA 3D RENDERER (ELEVATED TABLETOP DIORAMA + SPLIT DESKTOP/TOUCH ENGINE)
// ============================================================================

export class Arena3DRenderer {
  private container: HTMLElement;
  private labelLayer: HTMLElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private sunLight!: THREE.DirectionalLight;
  private lastShadowFrustumD = 0;
  private currentShadowRes = 1024;
  private seaMesh!: THREE.Mesh;
  private voidSeaMat!: THREE.ShaderMaterial;

  private islands = new Map<string, IslandVisuals>();
  private shockwaves: ShockwaveEffect[] = [];
  private relayArcs: RelayArcEffect[] = [];
  private particleBursts: ParticleBurst[] = [];

  // Cached viewport rect & dynamic HUD safe insets (zero getBoundingClientRect in renderFrame!)
  private viewportLeft = 0;
  private viewportTop = 0;
  private viewportW = 1280;
  private viewportH = 720;
  private hudSafeTopPx = 56;
  private hudSafeBottomPx = 84;
  private hasCustomHudInsets = false;

  // Rolling FPS governor for sustained 60fps on mobile/high-DPI screens
  private fpsAccumDt = 0;
  private fpsFrameCount = 0;
  private dprScaleCap = 1.0;

  // Telephoto camera rig (`35°` FOV)
  private camTarget = new THREE.Vector3(10, 0, 13);
  private camGoalTarget = new THREE.Vector3(10, 0, 13);
  private camRadius = 52;
  private camGoalRadius = 52;
  private camPolar = 0.48;
  private camGoalPolar = 0.48;
  private camBasePolar = 0.48;
  private camAzimuth = 0;
  private camGoalAzimuth = 0;
  private cameraShake = 0;

  // Reusable scratch vectors (zero per-frame Vector3 allocations)
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly buildPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.02);
  private readonly _tmpProj = new THREE.Vector3();
  private readonly _tmpWorld = new THREE.Vector3();
  private readonly _tmpPinch = new THREE.Vector3();
  private keysDown = new Set<string>();

  // Desktop mouse state machine (deferred pointerup <=5px click/right-click + drag pan + Shift paint)
  private isMiddleOrAltDragging = false;
  private isLeftMouseDown = false;
  private leftMouseStart = { x: 0, y: 0 };
  private leftMousePanned = false;
  private isShiftPainting = false;
  private isSweepSelling = false;
  private lastPaintedCellKey = '';
  private isRightMouseDown = false;
  private rightMouseStart = { x: 0, y: 0 };
  private rightMousePanned = false;
  private dragStart = { x: 0, y: 0 };

  // Mobile multi-touch & `-54px` Loupe Ghost Drag state machine
  private activeTouches = new Map<number, ActiveTouchPoint>();
  private touchGestureMoved = false;
  private postPinchGuard = false;
  private isLoupeDragging = false;
  private canGrabExistingGhost = false;
  private loupeGrabInitOffset = { x: 0, y: 0 };
  private loupeCurrentOffset = { x: 0, y: -54 };
  private loupeHoldStartMs = 0;
  private loupeSavedBeforeGesture: GridPoint | null = null;
  private touchHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPinchDist = 0;
  private lastPinchMid = { x: 0, y: 0 };
  private pendingTouchCell: GridPoint | null = null;
  private pendingTouchTowerId: string | null = null;
  private activeTouchHoverInfo: HoverStatusInfo | null = null;
  private touchWorldAnchor = new THREE.Vector3();

  // Desktop hover, precision 2x2 reticle & live synergy preview state
  private raycaster = new THREE.Raycaster();
  private mouseNDC = new THREE.Vector2(-99, -99);
  private lastPointerScreen = { x: 0, y: 0 };
  private hoveredCell: GridPoint | null = null;
  private hoveredExistingTower: PlacedTower | null = null;
  private lastHoverValid = false;
  private cachedHoverPreview: CachedHoverPreview | null = null;

  private ghostGroup: THREE.Group;
  private ghostTurretGroup: THREE.Group;
  private ghostConnGroup: THREE.Group;
  private reticlePadMesh: THREE.Mesh;
  private reticlePadMat: THREE.ShaderMaterial;
  private ghostBodyMat: THREE.MeshStandardMaterial;
  private ghostCapMat: THREE.MeshStandardMaterial;
  private ghostGoldBodyMat: THREE.MeshStandardMaterial;
  private ghostGoldCapMat: THREE.MeshStandardMaterial;
  private previewPathMesh: THREE.Mesh | null = null;
  private previewPathMat: THREE.ShaderMaterial;
  private previewConduitGroup: THREE.Group;
  private previewConduitMat: THREE.ShaderMaterial;

  // Protected singleton textures, geometries & materials (never disposed on round rebuilds)
  private readonly protectedGeos = new Set<THREE.BufferGeometry>();
  private readonly protectedMats = new Set<THREE.Material>();
  private readonly contactShadowTex = createContactShadowTexture();
  private readonly softCircleSpriteTex = createSoftCircleSpriteTexture();

  private readonly sharedGeos = {
    aoQuad: (() => {
      const g = new THREE.PlaneGeometry(2.08, 2.08);
      g.rotateX(-Math.PI / 2);
      return g;
    })(),
    bridgeAoQuad: (() => {
      const g = new THREE.PlaneGeometry(1.12, 1.0);
      g.rotateX(-Math.PI / 2);
      return g;
    })(),
    conduitQuad: (() => {
      const g = new THREE.PlaneGeometry(1.0, 0.24);
      g.rotateX(-Math.PI / 2);
      // Orient UV.x along +Z (0..1 from origin to +1m Z) for easy rotation.y alignment
      const pos = g.getAttribute('position');
      const uv = g.getAttribute('uv');
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i); // [-0.5..0.5]
        const pz = pos.getZ(i); // [-0.12..0.12]
        pos.setXYZ(i, pz, 0, px + 0.5);
        uv.setXY(i, px + 0.5, pz / 0.24 + 0.5);
      }
      g.computeBoundingSphere();
      return g;
    })(),
    reticleQuad: (() => {
      const g = new THREE.PlaneGeometry(2.16, 2.16);
      g.rotateX(-Math.PI / 2);
      return g;
    })(),
    // 1. Player Stone Wall (`BLOCK`): Chamfered Square Ivory Turret (`1.66m` plinth, `h = 1.38m`)
    pillarPlinth: (() => {
      const g = new THREE.CylinderGeometry(1.12, 1.18, 0.22, 4);
      g.rotateY(Math.PI / 4);
      return g;
    })(),
    pillarShaft: (() => {
      const g = new THREE.CylinderGeometry(0.98, 1.03, 0.96, 4);
      g.rotateY(Math.PI / 4);
      return g;
    })(),
    pillarCapMerlons: (() => {
      const baseCap = new THREE.BoxGeometry(1.52, 0.14, 1.52);
      baseCap.translate(0, 1.25, 0);
      const parts: THREE.BufferGeometry[] = [baseCap];
      for (const sx of [-0.54, 0.54]) {
        for (const sz of [-0.54, 0.54]) {
          const merlon = new THREE.BoxGeometry(0.38, 0.09, 0.38);
          merlon.translate(sx, 1.355, sz);
          parts.push(merlon);
        }
      }
      const merged = mergeSimpleGeometries(parts);
      parts.forEach((p) => p.dispose());
      return merged;
    })(),
    pillarEmblem: new THREE.BoxGeometry(0.68, 0.06, 0.68),
    bridgeWallUnit: new THREE.BoxGeometry(0.72, 0.98, 1.0),
    bridgeCapUnit: new THREE.BoxGeometry(0.82, 0.14, 1.0),
    keystoneBody: new THREE.BoxGeometry(0.78, 1.02, 0.16),
    keystoneCap: new THREE.BoxGeometry(0.88, 0.16, 0.2),

    // 2. Pre-Placed Crimson Keep (`obstacle`): Buttressed Cruciform Basalt-Skirted Bastion (`h = 1.82m`)
    keepBasaltSkirt: (() => {
      const base = new THREE.CylinderGeometry(0.86, 0.96, 0.28, 8);
      base.rotateY(Math.PI / 8);
      base.translate(0, 0.14, 0);
      const spurX = new THREE.BoxGeometry(1.82, 0.54, 0.52);
      spurX.translate(0, 0.27, 0);
      const spurZ = new THREE.BoxGeometry(0.52, 0.54, 1.82);
      spurZ.translate(0, 0.27, 0);
      const merged = mergeSimpleGeometries([base, spurX, spurZ]);
      base.dispose();
      spurX.dispose();
      spurZ.dispose();
      return merged;
    })(),
    keepShaft: (() => {
      const g = new THREE.CylinderGeometry(0.72, 0.78, 1.04, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    keepCornice: (() => {
      const g = new THREE.CylinderGeometry(0.82, 0.76, 0.16, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    keepPitchedCap: (() => {
      const g = new THREE.CylinderGeometry(0.32, 0.8, 0.28, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    keepBrazierBowl: (() => {
      const g = new THREE.CylinderGeometry(0.32, 0.2, 0.12, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    keepBrazierFlame: (() => {
      const g = new THREE.OctahedronGeometry(0.26, 0);
      g.scale(1.0, 1.15, 1.0);
      g.computeVertexNormals();
      return g;
    })(),

    // 3. Freestanding Dark-Slate Circular Elemental Spires
    spirePlinth: new THREE.CylinderGeometry(0.86, 0.96, 0.26, 12),
    spirePedestal: new THREE.CylinderGeometry(0.72, 0.82, 0.72, 12),
    spireCollar: new THREE.CylinderGeometry(0.8, 0.75, 0.16, 12),
    spireCollarRim: new THREE.CylinderGeometry(0.85, 0.87, 0.07, 12),
    spirePipBezel: (() => {
      const g = new THREE.OctahedronGeometry(0.2, 0);
      g.scale(1.05, 0.42, 1.05);
      g.computeVertexNormals();
      return g;
    })(),
    spirePipGem: (() => {
      const g = new THREE.OctahedronGeometry(0.155, 0);
      g.scale(1.0, 0.62, 1.0);
      g.computeVertexNormals();
      return g;
    })(),
    spireGroundArc: (() => {
      const g = new THREE.RingGeometry(
        1.02,
        1.15,
        10,
        1,
        -Math.PI * 0.5 - 0.25,
        0.5
      );
      g.rotateX(-Math.PI / 2);
      return g;
    })(),
    stormObeliskBody: (() => {
      const g = new THREE.CylinderGeometry(0.28, 0.52, 0.96, 6);
      return g;
    })(),
    stormProng: new THREE.BoxGeometry(0.08, 0.56, 0.1),
    stormPrism: (() => {
      const g = new THREE.OctahedronGeometry(0.26, 0);
      g.scale(0.92, 1.38, 0.92);
      g.computeVertexNormals();
      return g;
    })(),
    frostCentralShaft: new THREE.CylinderGeometry(0.18, 0.42, 1.28, 6),
    frostTip: new THREE.ConeGeometry(0.18, 0.36, 6),
    frostStarBlade: (() => {
      const g = new THREE.ConeGeometry(0.18, 0.78, 4);
      g.scale(0.68, 1.0, 1.28);
      g.computeVertexNormals();
      return g;
    })(),
    chronoHorn: new THREE.CylinderGeometry(0.08, 0.15, 1.12, 8),
    chronoHalo: (() => {
      const g = new THREE.TorusGeometry(0.5, 0.036, 8, 24);
      g.rotateX(Math.PI / 2);
      return g;
    })(),
    chronoOrb: new THREE.SphereGeometry(0.34, 20, 16),
    spireCooldownPlane: (() => {
      const g = new THREE.PlaneGeometry(2.28, 2.28);
      g.rotateX(-Math.PI / 2);
      return g;
    })(),
    unitCirclePlane: (() => {
      const g = new THREE.PlaneGeometry(2.0, 2.0);
      g.rotateX(-Math.PI / 2);
      return g;
    })(),

    // Plateau Corner Bastion & Miniature Cypress Clusters (2 draw calls per cluster!)
    plateauCornerBastion: (() => {
      const g = new THREE.CylinderGeometry(0.88, 1.02, 1.32, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    cypressTrunks: (() => {
      const t1 = new THREE.CylinderGeometry(0.06, 0.09, 0.28, 6);
      t1.translate(0, 0.14, 0);
      const t2 = new THREE.CylinderGeometry(0.05, 0.08, 0.24, 6);
      t2.translate(0.38, 0.12, 0.24);
      const merged = mergeSimpleGeometries([t1, t2]);
      t1.dispose();
      t2.dispose();
      return merged;
    })(),
    cypressCones: (() => {
      const c1 = new THREE.ConeGeometry(0.34, 1.12, 7);
      c1.translate(0, 0.8, 0);
      const c2 = new THREE.ConeGeometry(0.26, 0.84, 7);
      c2.translate(0.38, 0.64, 0.24);
      const merged = mergeSimpleGeometries([c1, c2]);
      c1.dispose();
      c2.dispose();
      return merged;
    })(),

    // Gates, Clap Pips, Runner & Shockwave Shared Geometries
    gatePier: (() => {
      const g = new THREE.CylinderGeometry(0.38, 0.44, 1.62, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    gatePierCap: (() => {
      const g = new THREE.CylinderGeometry(0.46, 0.41, 0.16, 8);
      g.rotateY(Math.PI / 8);
      return g;
    })(),
    gateChevron: (() => {
      const g = new THREE.ConeGeometry(0.42, 0.56, 3);
      g.rotateX(Math.PI / 2);
      g.scale(1.1, 0.12, 0.85);
      g.computeVertexNormals();
      return g;
    })(),
    goalSealRing: (() => {
      const g = new THREE.RingGeometry(0.42, 0.68, 24);
      g.rotateX(-Math.PI / 2);
      return g;
    })(),
    clapPipHalo: (() => {
      const g = new THREE.RingGeometry(0.16, 0.23, 16);
      g.rotateX(-Math.PI / 2);
      return g;
    })(),
    clapPipOuter: (() => {
      const g = new THREE.CircleGeometry(0.145, 16);
      g.rotateX(-Math.PI / 2);
      return g;
    })(),
    clapPipInner: (() => {
      const g = new THREE.CircleGeometry(0.092, 16);
      g.rotateX(-Math.PI / 2);
      return g;
    })(),
    shockwaveRing: (() => {
      const g = new THREE.RingGeometry(0.86, 1.0, 48);
      g.rotateX(-Math.PI / 2);
      return g;
    })(),
    runnerTorso: new THREE.ConeGeometry(0.35, 0.82, 8),
    runnerCollar: (() => {
      const g = new THREE.CylinderGeometry(0.28, 0.34, 0.09, 8);
      return g;
    })(),
    runnerHelm: new THREE.DodecahedronGeometry(0.23, 0),
    runnerVisor: new THREE.BoxGeometry(0.21, 0.08, 0.1),
    runnerArm: new THREE.BoxGeometry(0.12, 0.38, 0.12),
    runnerLeg: new THREE.BoxGeometry(0.13, 0.36, 0.15),
    runnerPauldron: new THREE.DodecahedronGeometry(0.19, 0),
    runnerWing: new THREE.BoxGeometry(0.07, 0.54, 0.38),
    runnerHoodPeak: new THREE.ConeGeometry(0.17, 0.25, 6),
    runnerFeather: new THREE.ConeGeometry(0.065, 0.34, 5),
    runnerPlume: new THREE.ConeGeometry(0.12, 0.42, 6),
    runnerShieldPlate: new THREE.BoxGeometry(0.56, 0.62, 0.09),
    runnerShieldRim: new THREE.BoxGeometry(0.6, 0.11, 0.11),
    runnerShieldBoss: (() => {
      const g = new THREE.CylinderGeometry(0.12, 0.14, 0.08, 8);
      g.rotateX(Math.PI / 2);
      return g;
    })(),
    runnerWeaponShaft: new THREE.CylinderGeometry(0.032, 0.038, 0.9, 6),
    runnerSpearTip: new THREE.ConeGeometry(0.07, 0.26, 6),
    runnerPennantPole: new THREE.CylinderGeometry(0.024, 0.028, 1.18, 6),
    runnerPennantFlag: new THREE.BoxGeometry(0.03, 0.28, 0.44),
    runnerMaceHead: new THREE.DodecahedronGeometry(0.18, 0),
    runnerOrbGem: new THREE.OctahedronGeometry(0.14, 0),
  };

  // Protected Singleton Materials
  private readonly aoDiscMat = new THREE.MeshBasicMaterial({
    map: this.contactShadowTex,
    transparent: true,
    depthWrite: false,
    opacity: 0.92,
  });
  private readonly plinthSandstoneMat = new THREE.MeshStandardMaterial({
    color: '#dcd4c5',
    roughness: 0.84,
    metalness: 0.02,
  });
  private readonly ivoryShaftMat = new THREE.MeshStandardMaterial({
    color: '#f6f2e9',
    roughness: 0.76,
    metalness: 0.02,
  });
  private readonly bridgeWallMat = new THREE.MeshStandardMaterial({
    color: '#efe9dd',
    roughness: 0.78,
    metalness: 0.02,
  });
  private readonly creamCapMat = new THREE.MeshStandardMaterial({
    color: '#fcfaf5',
    roughness: 0.7,
    metalness: 0.02,
  });
  private readonly playerMedallionMats = new Map<string, THREE.MeshStandardMaterial>();
  private readonly playerTrimMats = new Map<string, THREE.MeshStandardMaterial>();

  // Crimson Keep Materials (Dark Basalt Skirt + Deep Crimson Masonry + Live Gold Brazier)
  private readonly darkBasaltMat = new THREE.MeshStandardMaterial({
    color: '#3f3f46',
    roughness: 0.82,
    metalness: 0.08,
  });
  private readonly crimsonKeepWallMat = new THREE.MeshStandardMaterial({
    color: '#a8382b',
    roughness: 0.76,
    metalness: 0.04,
  });
  private readonly crimsonKeepRoofMat = new THREE.MeshStandardMaterial({
    color: '#88291f',
    roughness: 0.74,
    metalness: 0.05,
  });
  private readonly creamStoneTrimMat = new THREE.MeshStandardMaterial({
    color: '#f3ede1',
    roughness: 0.74,
    metalness: 0.03,
  });
  private readonly goldBridgeTrimMat = new THREE.MeshStandardMaterial({
    color: '#fbbf24',
    emissive: '#d97706',
    emissiveIntensity: 0.32,
    roughness: 0.4,
    metalness: 0.24,
  });
  private readonly keepBrazierDormantMat = new THREE.MeshStandardMaterial({
    color: '#64748b',
    emissive: '#7f1d1d',
    emissiveIntensity: 0.12,
    roughness: 0.65,
    metalness: 0.18,
  });
  private readonly keepBrazierLinkedMat = new THREE.MeshStandardMaterial({
    color: '#fde047',
    emissive: '#f59e0b',
    emissiveIntensity: 0.88,
    roughness: 0.24,
    metalness: 0.22,
  });

  // Freestanding Elemental Spire Materials (Zero Ivory Camouflage!)
  private readonly spireSlatePlinthMat = new THREE.MeshStandardMaterial({
    color: '#334155',
    roughness: 0.78,
    metalness: 0.12,
  });
  private readonly spireSlatePedestalMat = new THREE.MeshStandardMaterial({
    color: '#475569',
    roughness: 0.72,
    metalness: 0.14,
  });
  private readonly collarRimInactiveMat = new THREE.MeshStandardMaterial({
    color: '#64748b',
    roughness: 0.68,
    metalness: 0.16,
  });
  private readonly collarRimGoldMat = new THREE.MeshStandardMaterial({
    color: '#fbbf24',
    emissive: '#f59e0b',
    emissiveIntensity: 0.42,
    roughness: 0.32,
    metalness: 0.3,
  });
  private readonly pipBezelDarkMat = new THREE.MeshStandardMaterial({
    color: '#1e293b',
    roughness: 0.75,
    metalness: 0.2,
  });
  private readonly pipInactiveMat = new THREE.MeshStandardMaterial({
    color: '#64748b',
    roughness: 0.75,
    metalness: 0.12,
  });
  private readonly pipActiveGoldMat = new THREE.MeshStandardMaterial({
    color: '#fde047',
    emissive: '#f59e0b',
    emissiveIntensity: 0.75,
    roughness: 0.25,
    metalness: 0.32,
  });
  private readonly groundArcInactiveMat = new THREE.MeshBasicMaterial({
    color: '#334155',
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  private readonly groundArcGoldMat = new THREE.MeshBasicMaterial({
    color: '#fbbf24',
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  private readonly stormBodyMat = new THREE.MeshStandardMaterial({
    color: '#3b4252',
    roughness: 0.62,
    metalness: 0.28,
  });
  private readonly stormBrassMat = new THREE.MeshStandardMaterial({
    color: '#f59e0b',
    emissive: '#d97706',
    emissiveIntensity: 0.34,
    roughness: 0.3,
    metalness: 0.56,
  });
  private readonly stormPrismMat = new THREE.MeshStandardMaterial({
    color: '#fef08a',
    emissive: '#f59e0b',
    emissiveIntensity: 0.68,
    roughness: 0.2,
    metalness: 0.2,
  });
  private readonly frostMainMat = new THREE.MeshStandardMaterial({
    color: '#38bdf8',
    emissive: '#0284c7',
    emissiveIntensity: 0.34,
    roughness: 0.22,
    metalness: 0.16,
  });
  private readonly frostBladeMat = new THREE.MeshStandardMaterial({
    color: '#bae6fd',
    emissive: '#38bdf8',
    emissiveIntensity: 0.24,
    roughness: 0.26,
    metalness: 0.12,
  });
  private readonly chronoHornMat = new THREE.MeshStandardMaterial({
    color: '#e2d9f3',
    roughness: 0.58,
    metalness: 0.14,
  });
  private readonly chronoOrbMat = new THREE.MeshStandardMaterial({
    color: '#d8b4fe',
    emissive: '#a855f7',
    emissiveIntensity: 0.58,
    roughness: 0.2,
    metalness: 0.18,
  });

  // Plateau, Gate, Cypress, Fog Veil & Clap Marker Materials
  private readonly plateauCurbMat = new THREE.MeshStandardMaterial({
    color: '#e8e0d2',
    roughness: 0.78,
    metalness: 0.02,
  });
  private readonly plateauShoulderTurfMat = new THREE.MeshStandardMaterial({
    color: '#61ab49',
    roughness: 0.88,
    metalness: 0.01,
  });
  private readonly cliffLimestoneMat = new THREE.MeshStandardMaterial({
    color: '#ded6c7',
    roughness: 0.82,
    metalness: 0.02,
  });
  private readonly cliffTalusMat = new THREE.MeshStandardMaterial({
    color: '#cabfa9',
    roughness: 0.88,
    metalness: 0.02,
  });
  private readonly cypressTrunkMat = new THREE.MeshStandardMaterial({
    color: '#78553a',
    roughness: 0.86,
    metalness: 0.02,
  });
  private readonly cypressFoliageMat = new THREE.MeshStandardMaterial({
    color: '#4e8f42',
    roughness: 0.82,
    metalness: 0.01,
  });
  private readonly northGateRoofMat = new THREE.MeshStandardMaterial({
    color: '#1e3a5f',
    roughness: 0.68,
    metalness: 0.12,
  });
  private readonly spawnAzureMat = new THREE.MeshBasicMaterial({
    color: '#38bdf8',
  });
  private readonly southShrineFlameMat = new THREE.MeshStandardMaterial({
    color: '#fb7185',
    emissive: '#f43f5e',
    emissiveIntensity: 0.52,
    roughness: 0.3,
  });
  private readonly exitCoralMat = new THREE.MeshBasicMaterial({
    color: '#fb7185',
  });
  private readonly fogVeilMat = new THREE.MeshBasicMaterial({
    color: '#e6eff6',
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  });
  private readonly clapPipRimMat = new THREE.MeshBasicMaterial({
    color: '#1e293b',
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
  });
  private readonly clapPipStormMat = new THREE.MeshBasicMaterial({
    color: '#f59e0b',
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  private readonly clapPipFrostMat = new THREE.MeshBasicMaterial({
    color: '#38bdf8',
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  private readonly clapPipChronoMat = new THREE.MeshBasicMaterial({
    color: '#c084fc',
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  private readonly clapPipGainHaloMat = new THREE.MeshBasicMaterial({
    color: '#22c55e',
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });

  // Shared Runner Materials (Zero per-reroll leaks)
  private readonly runnerCollarIvoryMat = new THREE.MeshStandardMaterial({
    color: '#fefce8',
    roughness: 0.55,
    metalness: 0.08,
  });
  private readonly runnerSteelBrightMat = new THREE.MeshStandardMaterial({
    color: '#cbd5e1',
    roughness: 0.32,
    metalness: 0.56,
  });
  private readonly runnerSteelDarkMat = new THREE.MeshStandardMaterial({
    color: '#334155',
    roughness: 0.42,
    metalness: 0.46,
  });
  private readonly runnerLegMat = new THREE.MeshStandardMaterial({
    color: '#334155',
    roughness: 0.65,
  });
  private readonly runnerGoldAccentMat = new THREE.MeshStandardMaterial({
    color: '#fbbf24',
    emissive: '#d97706',
    emissiveIntensity: 0.32,
    roughness: 0.38,
    metalness: 0.32,
  });

  // ==========================================================================
  // PUBLIC CONTRACT PROPERTIES & CALLBACKS (`tech_contracts.md §2.1`)
  // ==========================================================================

  private _activeTool: ActiveBuildTool = 'BLOCK';
  public get activeTool(): ActiveBuildTool {
    return this._activeTool;
  }
  public set activeTool(val: ActiveBuildTool) {
    if (this._activeTool !== val) {
      this._activeTool = val;
      this.cachedHoverPreview = null;
      if (val === 'PAN' || this.pendingTouchCell || this.pendingTouchTowerId) {
        this.cancelTouchGhost();
      } else {
        this.updateBuildHover(true);
      }
    }
  }

  private _modalOpen = false;
  public get modalOpen(): boolean {
    return this._modalOpen;
  }
  public set modalOpen(val: boolean) {
    if (this._modalOpen !== val) {
      this._modalOpen = val;
      if (val) {
        this.keysDown.clear();
        this.isLeftMouseDown = false;
        this.isRightMouseDown = false;
        this.isMiddleOrAltDragging = false;
        this.isShiftPainting = false;
        this.isSweepSelling = false;
        if (!this.pendingTouchCell && !this.pendingTouchTowerId) {
          this.hideDesktopHoverVisuals();
        }
      }
    }
  }

  public localPlayerId: string | null = null;
  public focusedPlayerId: string | null = null;
  public arenaOverviewMode = false;

  public onPlaceTower?: (x: number, y: number) => void;
  public onSellTower?: (towerId: string, x?: number, y?: number) => void;
  public onHoverStatusChange?: (info: HoverStatusInfo) => void;
  public onTouchSnapChange?: (cell: GridPoint, valid: boolean) => void;
  public dismissTransientUI?: () => boolean;
  public onFocusChange?: () => void;

  private currentRoomState: RoomState | null = null;
  private lastRoomPhase: string = '';
  private lastLayoutSignature = '';
  private lastLocalEvalSig = '';
  private cachedBaseEval: MazeEvalResult | null = null;
  private cachedLocalCircuitry: CitadelCircuitryResult | null = null;
  private latestSimStates = new Map<string, RunnerSimState>();

  private islandBadges = new Map<string, IslandBadgeRefs>();
  private runnerBadges = new Map<string, RunnerBadgeRefs>();

  constructor(container: HTMLElement, labelLayer: HTMLElement) {
    this.container = container;
    this.labelLayer = labelLayer;

    // Register protected geometries & materials so disposeSubtree never touches singletons
    for (const geo of Object.values(this.sharedGeos)) {
      this.protectedGeos.add(geo);
    }
    this.registerProtectedMaterials([
      this.aoDiscMat,
      this.plinthSandstoneMat,
      this.ivoryShaftMat,
      this.bridgeWallMat,
      this.creamCapMat,
      this.darkBasaltMat,
      this.crimsonKeepWallMat,
      this.crimsonKeepRoofMat,
      this.creamStoneTrimMat,
      this.goldBridgeTrimMat,
      this.keepBrazierDormantMat,
      this.keepBrazierLinkedMat,
      this.spireSlatePlinthMat,
      this.spireSlatePedestalMat,
      this.collarRimInactiveMat,
      this.collarRimGoldMat,
      this.pipBezelDarkMat,
      this.pipInactiveMat,
      this.pipActiveGoldMat,
      this.groundArcInactiveMat,
      this.groundArcGoldMat,
      this.stormBodyMat,
      this.stormBrassMat,
      this.stormPrismMat,
      this.frostMainMat,
      this.frostBladeMat,
      this.chronoHornMat,
      this.chronoOrbMat,
      this.plateauCurbMat,
      this.plateauShoulderTurfMat,
      this.cliffLimestoneMat,
      this.cliffTalusMat,
      this.cypressTrunkMat,
      this.cypressFoliageMat,
      this.northGateRoofMat,
      this.spawnAzureMat,
      this.southShrineFlameMat,
      this.exitCoralMat,
      this.fogVeilMat,
      this.clapPipRimMat,
      this.clapPipStormMat,
      this.clapPipFrostMat,
      this.clapPipChronoMat,
      this.clapPipGainHaloMat,
      this.runnerCollarIvoryMat,
      this.runnerSteelBrightMat,
      this.runnerSteelDarkMat,
      this.runnerLegMat,
      this.runnerGoldAccentMat,
    ]);

    // 1. Airy Mediterranean Sky Mist + Distance-Started Linear Horizon Fog (0% haze on islands!)
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#d4ebf7');
    this.scene.fog = new THREE.Fog('#d4ebf7', 150, 340);

    const initW = this.container.clientWidth || window.innerWidth;
    const initH = this.container.clientHeight || window.innerHeight;
    // Telephoto 35° Diorama Lens (cuts edge tower splay & mobile parallax by ~26%!)
    this.camera = new THREE.PerspectiveCamera(35, initW / initH, 1.0, 440);

    // Khronos PBR NeutralToneMapping + Hardware MSAA
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(initW, initH);
    this.renderer.setPixelRatio(this.computeAdaptivePixelRatio());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.domElement.style.touchAction = 'none';
    this.container.appendChild(this.renderer.domElement);

    this.updateViewportBounds();
    this.setupLightingAndEnvironment();

    // 2. Precision 2x2 Reticle + Square Ivory Turret Ghost + Persistent Preview Shaders
    this.ghostGroup = new THREE.Group();
    this.ghostGroup.visible = false;

    this.reticlePadMat = createReticlePadShader();
    this.protectedMats.add(this.reticlePadMat);
    this.reticlePadMesh = new THREE.Mesh(
      this.sharedGeos.reticleQuad,
      this.reticlePadMat
    );
    this.reticlePadMesh.position.y = 0.036;
    this.reticlePadMesh.renderOrder = 9;
    this.ghostGroup.add(this.reticlePadMesh);

    this.ghostTurretGroup = new THREE.Group();
    this.ghostGroup.add(this.ghostTurretGroup);

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
    this.ghostGoldBodyMat = new THREE.MeshStandardMaterial({
      color: '#fde047',
      emissive: '#f59e0b',
      emissiveIntensity: 0.36,
      roughness: 0.45,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
    });
    this.ghostGoldCapMat = new THREE.MeshStandardMaterial({
      color: '#fef9c3',
      emissive: '#fbbf24',
      emissiveIntensity: 0.42,
      roughness: 0.38,
      transparent: true,
      opacity: 0.76,
      depthWrite: false,
    });
    this.registerProtectedMaterials([
      this.ghostBodyMat,
      this.ghostCapMat,
      this.ghostGoldBodyMat,
      this.ghostGoldCapMat,
    ]);

    const ghostPlinth = new THREE.Mesh(
      this.sharedGeos.pillarPlinth,
      this.ghostBodyMat
    );
    ghostPlinth.position.y = 0.11;
    ghostPlinth.renderOrder = 10;
    this.ghostTurretGroup.add(ghostPlinth);

    const ghostShaft = new THREE.Mesh(
      this.sharedGeos.pillarShaft,
      this.ghostBodyMat
    );
    ghostShaft.position.y = 0.7;
    ghostShaft.renderOrder = 10;
    this.ghostTurretGroup.add(ghostShaft);

    const ghostCap = new THREE.Mesh(
      this.sharedGeos.pillarCapMerlons,
      this.ghostCapMat
    );
    ghostCap.renderOrder = 10;
    this.ghostTurretGroup.add(ghostCap);

    this.scene.add(this.ghostGroup);

    // Persistent Preview Path Shader & Preview Conduit Layer (zero per-hover shader leaks!)
    this.previewPathMat = createPathRibbonShader('#fef08a', 0.84);
    this.previewConduitMat = createLeyConduitShader(true);
    this.registerProtectedMaterials([this.previewPathMat, this.previewConduitMat]);

    this.previewConduitGroup = new THREE.Group();
    this.scene.add(this.previewConduitGroup);

    // Initial aspect-adaptive telephoto framing (`gw + 2.0, gh + 3.4`)
    const initFrame = this.computeIdealFraming(22.0, 29.4);
    this.camBasePolar = initFrame.polar;
    this.camPolar = initFrame.polar;
    this.camGoalPolar = initFrame.polar;
    this.camRadius = this.clampCameraRadius(initFrame.radius);
    this.camGoalRadius = this.camRadius;
    this.camTarget.set(10, 0, 13 + initFrame.zBias);
    this.camGoalTarget.copy(this.camTarget);

    this.bindEvents();
  }

  private registerProtectedMaterials(mats: THREE.Material[]) {
    for (const m of mats) this.protectedMats.add(m);
  }

  private disposeSubtree(root: THREE.Object3D) {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry && !this.protectedGeos.has(mesh.geometry)) {
        mesh.geometry.dispose();
      }
      if (mesh.material) {
        if (Array.isArray(mesh.material)) {
          for (const mat of mesh.material) {
            if (!this.protectedMats.has(mat)) mat.dispose();
          }
        } else if (!this.protectedMats.has(mesh.material)) {
          mesh.material.dispose();
        }
      }
    });
  }

  private isCoarseOrCompactDevice(): boolean {
    const coarse =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    const minDim = Math.min(
      window.innerWidth || 1024,
      window.innerHeight || 768
    );
    return coarse || minDim < 620;
  }

  private computeAdaptivePixelRatio(): number {
    const baseCap = this.isCoarseOrCompactDevice() ? 1.5 : 2.0;
    const raw = Math.min(window.devicePixelRatio || 1, baseCap);
    return Math.max(1.0, raw * this.dprScaleCap);
  }

  private updateViewportBounds() {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.viewportLeft = rect.left;
    this.viewportTop = rect.top;
    this.viewportW = Math.max(280, rect.width || window.innerWidth);
    this.viewportH = Math.max(240, rect.height || window.innerHeight);
  }

  private getPlayerMedallionMaterial(
    playerColor: string
  ): THREE.MeshStandardMaterial {
    let mat = this.playerMedallionMats.get(playerColor);
    if (!mat) {
      // Un-muddied true player heraldry color (no terracotta lerp!)
      mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(playerColor),
        roughness: 0.62,
        metalness: 0.06,
      });
      this.protectedMats.add(mat);
      this.playerMedallionMats.set(playerColor, mat);
    }
    return mat;
  }

  private getPlayerTrimMaterial(playerColor: string): THREE.MeshStandardMaterial {
    let mat = this.playerTrimMats.get(playerColor);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(playerColor),
        roughness: 0.64,
        metalness: 0.06,
      });
      this.protectedMats.add(mat);
      this.playerTrimMats.set(playerColor, mat);
    }
    return mat;
  }

  private setupLightingAndEnvironment() {
    // Calibrated r170 Daylight Rig: Warm Limestone Bounce + 58° Cross-Key Sun + Cerulean Shadow Fill
    const hemiLight = new THREE.HemisphereLight('#eef7ff', '#c8bfa8', 1.45);
    this.scene.add(hemiLight);

    this.sunLight = new THREE.DirectionalLight('#fff7e8', 2.85);
    this.sunLight.position.set(-28, 48, 18);
    this.sunLight.castShadow = true;
    this.currentShadowRes = this.isCoarseOrCompactDevice() ? 1024 : 2048;
    this.sunLight.shadow.mapSize.set(
      this.currentShadowRes,
      this.currentShadowRes
    );
    this.sunLight.shadow.camera.near = 4;
    this.sunLight.shadow.camera.far = 165;
    this.sunLight.shadow.bias = -0.00025;
    this.sunLight.shadow.normalBias = 0.018;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
    this.updateSunShadowFrustum(true);

    const fillLight = new THREE.DirectionalLight('#93c5fd', 0.85);
    fillLight.position.set(26, 34, -24);
    this.scene.add(fillLight);

    // Tranquil Cerulean Sea at y = -1.42m
    this.voidSeaMat = createTranquilSeaShader();
    this.protectedMats.add(this.voidSeaMat);
    const seaGeo = new THREE.PlaneGeometry(760, 760);
    seaGeo.rotateX(-Math.PI / 2);
    this.protectedGeos.add(seaGeo);
    this.seaMesh = new THREE.Mesh(seaGeo, this.voidSeaMat);
    this.seaMesh.position.set(10, SEA_LEVEL_Y, 13);
    this.scene.add(this.seaMesh);
  }

  private updateSunShadowFrustum(forceProjection = false) {
    const d = this.arenaOverviewMode ? 66 : 18;
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
    // 58° NW/SW cross-key raking crisp directional shadows across adjacent corridors!
    this.sunLight.position.set(snapX - 28, 48, snapZ + 18);
  }

  // ==========================================================================
  // CAMERA FRAMING, SAFE HUD APERTURE & PUBLIC CONTROLS
  // ==========================================================================

  public setHudSafeInsets(topPx: number, bottomPx: number): void {
    const clampedTop = Math.max(24, Math.min(240, topPx));
    const clampedBottom = Math.max(8, Math.min(280, bottomPx));
    const changed =
      Math.abs(clampedTop - this.hudSafeTopPx) > 2 ||
      Math.abs(clampedBottom - this.hudSafeBottomPx) > 2;
    this.hudSafeTopPx = clampedTop;
    this.hudSafeBottomPx = clampedBottom;
    this.hasCustomHudInsets = true;

    if (changed && this.currentRoomState && !this.isLoupeDragging) {
      if (this.arenaOverviewMode) {
        this.focusArenaOverview(false);
      } else {
        const pid = this.focusedPlayerId || this.localPlayerId;
        if (pid) {
          const island = this.islands.get(pid);
          const gw = this.currentRoomState.roundConfig.gridWidth;
          const gh = this.currentRoomState.roundConfig.gridHeight;
          if (island) {
            const distFromCenter = Math.hypot(
              this.camGoalTarget.x - (island.offsetX + gw * 0.5),
              this.camGoalTarget.z - (island.offsetZ + gh * 0.5)
            );
            // Smoothly recenter if player hasn't manually panned away
            if (distFromCenter < 4.5) {
              const frame = this.computeIdealFraming(gw + 2.0, gh + 3.4, 1.6);
              this.camGoalTarget.z = island.offsetZ + gh * 0.5 + frame.zBias;
              this.clampCameraTarget();
            }
          }
        }
      }
    }
  }

  private computeIdealFraming(
    spanW: number,
    spanH: number,
    reliefH = 1.6
  ): { radius: number; polar: number; zBias: number } {
    const w = Math.max(280, this.viewportW || window.innerWidth);
    const h = Math.max(240, this.viewportH || window.innerHeight);
    const aspect = w / h;
    const isPortrait = aspect < 0.95;
    const polar = isPortrait ? 0.36 : 0.48;

    const vFovRad = THREE.MathUtils.degToRad(this.camera.fov);
    const tanHalfV = Math.tan(vFovRad * 0.5);
    const hFovRad = 2 * Math.atan(tanHalfV * aspect);
    const tanHalfH = Math.tan(hFovRad * 0.5);

    const usableX = isPortrait ? 0.95 : 0.91;
    const nearZDepthOffset = spanH * 0.45 * Math.sin(polar);
    const distForWidth =
      (spanW * 0.5) / (usableX * tanHalfH) + nearZDepthOffset;

    const isRunPhase = this.currentRoomState?.phase === 'RUN';
    const topHudPx = this.hasCustomHudInsets
      ? this.hudSafeTopPx
      : w <= 768
      ? 58
      : 56;
    const bottomHudPx = this.hasCustomHudInsets
      ? this.hudSafeBottomPx
      : isRunPhase
      ? w <= 768
        ? 62
        : 18
      : 82;

    const clearFracY = Math.max(0.52, (h - topHudPx - bottomHudPx - 14) / h);
    const usableY = Math.min(isPortrait ? 0.8 : 0.85, clearFracY);

    const projectedHalfH =
      spanH * 0.5 * Math.cos(polar) + reliefH * Math.sin(polar);
    const distForHeight = projectedHalfH / (usableY * tanHalfV);

    const radius = Math.max(distForWidth, distForHeight);
    const hudAsymmetryPx = (topHudPx - bottomHudPx) * 0.5;
    const worldPerPxAtTarget = (2 * radius * tanHalfV) / h;
    const zBias =
      -(hudAsymmetryPx * worldPerPxAtTarget) / Math.max(0.6, Math.cos(polar));

    return { radius, polar, zBias };
  }

  private clampCameraRadius(r: number): number {
    const maxR = this.arenaOverviewMode
      ? Math.max(135, this.camGoalRadius, 195)
      : 128;
    const minR = 16;
    return Math.max(minR, Math.min(maxR, r));
  }

  private updateZoomCoupledPolar() {
    if (this.arenaOverviewMode) {
      this.camGoalPolar = this.camBasePolar;
      return;
    }
    // Zoom-coupled overhead pitch assist: smoothly flatten toward 0.26 rad when zooming close (<40m)
    const zoomFactor = THREE.MathUtils.clamp(
      (this.camGoalRadius - 18) / 24,
      0,
      1
    );
    const closePolar = Math.min(0.26, this.camBasePolar);
    this.camGoalPolar = closePolar + (this.camBasePolar - closePolar) * zoomFactor;
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
      ox - 3.0,
      Math.min(ox + gw + 3.0, this.camGoalTarget.x)
    );
    this.camGoalTarget.z = Math.max(
      oz - 3.0,
      Math.min(oz + gh + 4.0, this.camGoalTarget.z)
    );
  }

  private panCameraByScreenDelta(dxPx: number, dyPx: number) {
    const h = Math.max(240, this.viewportH);
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

  public focusOnPlayerIsland(playerId: string, snapImmediate = false): void {
    this.arenaOverviewMode = false;
    this.focusedPlayerId = playerId;
    if (
      playerId !== this.localPlayerId &&
      (this.pendingTouchCell || this.pendingTouchTowerId)
    ) {
      this.cancelTouchGhost();
    }
    const island = this.islands.get(playerId);
    if (!island || !this.currentRoomState) return;

    const gw = this.currentRoomState.roundConfig.gridWidth;
    const gh = this.currentRoomState.roundConfig.gridHeight;
    const frame = this.computeIdealFraming(gw + 2.0, gh + 3.4, 1.6);

    this.camBasePolar = frame.polar;
    this.camGoalTarget.set(
      island.offsetX + gw / 2,
      0,
      island.offsetZ + gh / 2 + frame.zBias
    );
    this.camGoalRadius = this.clampCameraRadius(frame.radius);
    this.camGoalPolar = frame.polar;
    this.camGoalAzimuth = 0;

    if (snapImmediate) {
      this.camTarget.copy(this.camGoalTarget);
      this.camPolar = this.camGoalPolar;
      this.camRadius = this.camGoalRadius;
      this.camAzimuth = 0;
    }
    this.updateSunShadowFrustum();
  }

  public focusArenaOverview(snapImmediate = false): void {
    this.arenaOverviewMode = true;
    if (this.pendingTouchCell || this.pendingTouchTowerId) {
      this.cancelTouchGhost();
    } else {
      this.hideDesktopHoverVisuals();
    }
    if (!this.currentRoomState) return;

    const count = Math.max(1, this.currentRoomState.players.length);
    const cols = Math.min(3, count);
    const rows = Math.ceil(count / 3);
    const gw = this.currentRoomState.roundConfig.gridWidth;
    const gh = this.currentRoomState.roundConfig.gridHeight;

    const centerX = ((cols - 1) * ISLAND_SPACING_X + gw) / 2;
    const centerZ = ((rows - 1) * ISLAND_SPACING_Z + gh) / 2;
    const totalW = (cols - 1) * ISLAND_SPACING_X + gw + 4.4;
    const totalH = (rows - 1) * ISLAND_SPACING_Z + gh + 5.6;

    const frame = this.computeIdealFraming(totalW, totalH, 2.2);
    this.camBasePolar = frame.polar;
    this.camGoalTarget.set(centerX, 0, centerZ + frame.zBias * 0.55);
    this.camGoalPolar = frame.polar;
    this.camGoalRadius = Math.max(30, Math.min(195, frame.radius));
    this.camGoalAzimuth = 0;

    if (snapImmediate) {
      this.camTarget.copy(this.camGoalTarget);
      this.camPolar = this.camGoalPolar;
      this.camRadius = this.camGoalRadius;
      this.camAzimuth = 0;
    }
    this.updateSunShadowFrustum();
  }

  public resetCameraView(): void {
    if (this.arenaOverviewMode) {
      this.focusArenaOverview();
    } else if (this.focusedPlayerId || this.localPlayerId) {
      this.focusOnPlayerIsland((this.focusedPlayerId || this.localPlayerId)!);
    }
  }

  public getLocalMazeEval(): MazeEvalResult | null {
    return this.cachedBaseEval;
  }

  // ==========================================================================
  // RAYCAST HELPERS & SPLIT INPUT ENGINE (TOUCH LOUPE + DESKTOP MOUSE)
  // ==========================================================================

  private screenToNDC(clientX: number, clientY: number, out: THREE.Vector2) {
    out.set(
      ((clientX - this.viewportLeft) / this.viewportW) * 2 - 1,
      -((clientY - this.viewportTop) / this.viewportH) * 2 + 1
    );
  }

  private raycastAnyIsland(
    clientX: number,
    clientY: number
  ): IslandVisuals | null {
    const ndc = new THREE.Vector2();
    this.screenToNDC(clientX, clientY, ndc);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);

    for (const isl of this.islands.values()) {
      if (!isl.root.visible) continue;
      if (this.raycaster.intersectObject(isl.hitPlane).length > 0) {
        return isl;
      }
    }

    if (this.raycaster.ray.intersectPlane(this.groundPlane, this._tmpWorld)) {
      const gw = this.currentRoomState?.roundConfig.gridWidth || 20;
      const gh = this.currentRoomState?.roundConfig.gridHeight || 26;
      for (const isl of this.islands.values()) {
        if (!isl.root.visible) continue;
        const rx = this._tmpWorld.x - isl.offsetX;
        const rz = this._tmpWorld.z - isl.offsetZ;
        if (rx >= -2.4 && rx <= gw + 2.4 && rz >= -2.4 && rz <= gh + 2.4) {
          return isl;
        }
      }
    }
    return null;
  }

  /**
   * 3D Mesh-First Raycast against existing player Stone Walls (`towerGroup.children`)
   * so clicking or tapping a `1.38m` wall cap never suffers perspective ground parallax!
   */
  private raycastExistingWallMesh(
    island: IslandVisuals,
    player: PlayerState
  ): PlacedTower | null {
    if (island.towerGroup.children.length === 0) return null;
    const hits = this.raycaster.intersectObjects(
      island.towerGroup.children,
      true
    );
    for (const hit of hits) {
      let curr: THREE.Object3D | null = hit.object;
      while (curr && curr !== island.towerGroup) {
        const tid = curr.userData?.towerId as string | undefined;
        if (tid) {
          const found = player.towers.find((t) => t.id === tid);
          if (found) return found;
        }
        curr = curr.parent;
      }
    }
    return null;
  }

  /**
   * Intersects mathematical `y = 0.02` build plane with a `+1.6m` apron around `[0..gw]x[0..gh]`
   * and clamps cleanly so border cells (`x = 0/18`, `y = 0/24`) never drop out!
   */
  private intersectClampedBuildPlane(
    island: IslandVisuals,
    round: RoundConfig,
    margin = 1.6
  ): { relX: number; relZ: number; rawRelX: number; rawRelZ: number } | null {
    if (!this.raycaster.ray.intersectPlane(this.buildPlane, this._tmpWorld)) {
      return null;
    }
    const rawRelX = this._tmpWorld.x - island.offsetX;
    const rawRelZ = this._tmpWorld.z - island.offsetZ;
    if (
      rawRelX < -margin ||
      rawRelX > round.gridWidth + margin ||
      rawRelZ < -margin ||
      rawRelZ > round.gridHeight + margin
    ) {
      return null;
    }
    const relX = Math.max(0, Math.min(round.gridWidth - 0.001, rawRelX));
    const relZ = Math.max(0, Math.min(round.gridHeight - 0.001, rawRelZ));
    return { relX, relZ, rawRelX, rawRelZ };
  }

  private bindEvents() {
    const dom = this.renderer.domElement;

    const handleResize = () => {
      const prevW = this.viewportW;
      const w = this.container.clientWidth || window.innerWidth;
      const h = this.container.clientHeight || window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setPixelRatio(this.computeAdaptivePixelRatio());
      this.renderer.setSize(w, h);
      this.updateViewportBounds();

      const desiredShadowRes = this.isCoarseOrCompactDevice() ? 1024 : 2048;
      if (desiredShadowRes !== this.currentShadowRes) {
        this.currentShadowRes = desiredShadowRes;
        this.sunLight.shadow.mapSize.set(desiredShadowRes, desiredShadowRes);
        this.sunLight.shadow.map?.dispose();
        this.sunLight.shadow.map = null;
      }

      const coarse = this.isCoarseOrCompactDevice() ? 1.0 : 0.0;
      for (const isl of this.islands.values()) {
        isl.floorUniforms.uCoarsePointer.value = coarse;
      }

      // Guard mobile virtual keyboard open/close (`widthDelta < 4` while an input is focused)
      const activeTag = document.activeElement?.tagName;
      const isInputFocused =
        activeTag === 'INPUT' || activeTag === 'TEXTAREA';
      if (isInputFocused && Math.abs(w - prevW) < 4) {
        return;
      }

      if (this.arenaOverviewMode) {
        this.focusArenaOverview(true);
      } else if (this.focusedPlayerId || this.localPlayerId) {
        this.focusOnPlayerIsland(
          (this.focusedPlayerId || this.localPlayerId)!,
          true
        );
      }
    };

    window.addEventListener('resize', handleResize);
    window.visualViewport?.addEventListener('resize', handleResize);
    window.addEventListener('blur', () => {
      this.keysDown.clear();
      this.isShiftPainting = false;
      this.isSweepSelling = false;
    });

    window.addEventListener('keydown', (e) => {
      if (this._modalOpen) return;
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
    // POINTER DOWN
    // ------------------------------------------------------------------------
    dom.addEventListener('pointerdown', (e) => {
      this.updateViewportBounds();

      if (e.pointerType === 'touch') {
        try {
          dom.setPointerCapture(e.pointerId);
        } catch {
          // Ignore synthetic pointer events without capture support
        }

        this.activeTouches.set(e.pointerId, {
          x: e.clientX,
          y: e.clientY,
          startX: e.clientX,
          startY: e.clientY,
        });

        if (this.activeTouches.size === 1) {
          this.touchGestureMoved = false;
          this.postPinchGuard = false;
          this.isLoupeDragging = false;
          this.canGrabExistingGhost = false;
          this.clearTouchHoldTimer();

          const isSpectatingOther =
            this.focusedPlayerId !== null &&
            this.focusedPlayerId !== this.localPlayerId;
          const canBuildTouch =
            !this._modalOpen &&
            !this.arenaOverviewMode &&
            !isSpectatingOther &&
            this.currentRoomState?.phase === 'BUILD' &&
            this._activeTool === 'BLOCK' &&
            this.localPlayerId !== null;

          if (canBuildTouch) {
            this.loupeSavedBeforeGesture = this.pendingTouchCell
              ? { ...this.pendingTouchCell }
              : null;

            // Check if pressing within <= 56px of an active ghost for instant Loupe Grab!
            if (this.pendingTouchCell && this.localPlayerId) {
              const localIsl = this.islands.get(this.localPlayerId);
              if (localIsl) {
                this._tmpWorld.set(
                  localIsl.offsetX + this.pendingTouchCell.x + 1.0,
                  0.65,
                  localIsl.offsetZ + this.pendingTouchCell.y + 1.0
                );
                const proj = this.projectWorldToScreen(this._tmpWorld);
                const distToGhost = Math.hypot(
                  e.clientX - proj.x,
                  e.clientY - proj.y
                );
                if (distToGhost <= 56) {
                  this.canGrabExistingGhost = true;
                  this.loupeGrabInitOffset = {
                    x: proj.x - e.clientX,
                    y: proj.y - e.clientY,
                  };
                  this.loupeCurrentOffset = { ...this.loupeGrabInitOffset };
                }
              }
            }

            // 155ms stationary hold on island enters Loupe Ghost Drag
            const holdStartX = e.clientX;
            const holdStartY = e.clientY;
            this.touchHoldTimer = setTimeout(() => {
              this.touchHoldTimer = null;
              if (
                this.activeTouches.size !== 1 ||
                this.touchGestureMoved ||
                this.postPinchGuard ||
                this._activeTool !== 'BLOCK'
              ) {
                return;
              }
              if (this.tryStartHoldLoupeDrag(holdStartX, holdStartY)) {
                this.isLoupeDragging = true;
                this.touchGestureMoved = true;
                this.loupeHoldStartMs = performance.now();
                this.loupeCurrentOffset = { x: 0, y: 0 };
                this.updateLoupeDragAtScreen(holdStartX, holdStartY, true);
              }
            }, 155);
          }
        } else if (this.activeTouches.size >= 2) {
          this.clearTouchHoldTimer();
          if (this.isLoupeDragging) {
            this.isLoupeDragging = false;
            if (this.loupeSavedBeforeGesture) {
              this.pendingTouchCell = { ...this.loupeSavedBeforeGesture };
              this.applyTouchSelectionVisuals();
            } else {
              this.cancelTouchGhost();
            }
          }
          this.touchGestureMoved = true;
          this.canGrabExistingGhost = false;
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
        return;
      }

      // Desktop mouse controls
      if (this._modalOpen) return;
      this.lastPointerScreen = { x: e.clientX, y: e.clientY };
      this.screenToNDC(e.clientX, e.clientY, this.mouseNDC);

      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        this.isMiddleOrAltDragging = true;
        this.dragStart = { x: e.clientX, y: e.clientY };
        return;
      }

      if (e.button === 2) {
        this.isRightMouseDown = true;
        this.rightMouseStart = { x: e.clientX, y: e.clientY };
        this.dragStart = { x: e.clientX, y: e.clientY };
        this.rightMousePanned = false;
        return;
      }

      if (e.button === 0) {
        if (this.dismissTransientUI?.()) return;
        if (this.pendingTouchCell || this.pendingTouchTowerId) {
          this.cancelTouchGhost();
        }

        const isSpectatingOther =
          this.focusedPlayerId !== null &&
          this.focusedPlayerId !== this.localPlayerId;
        const canEditLocal =
          !this.arenaOverviewMode &&
          !isSpectatingOther &&
          this.currentRoomState?.phase === 'BUILD' &&
          this._activeTool !== 'PAN';

        if (canEditLocal) {
          this.updateBuildHover();

          // Shift + Left-Drag line-paint in BLOCK mode
          if (e.shiftKey && this._activeTool === 'BLOCK') {
            this.isShiftPainting = true;
            this.lastPaintedCellKey = '';
            if (this.hoveredCell && this.lastHoverValid) {
              this.lastPaintedCellKey = `${this.hoveredCell.x},${this.hoveredCell.y}`;
              this.onPlaceTower?.(this.hoveredCell.x, this.hoveredCell.y);
            }
            return;
          }

          // Sweep-remove when pressing directly on an existing wall in SELL mode
          if (this._activeTool === 'SELL' && this.hoveredExistingTower) {
            this.isSweepSelling = true;
            const t = this.hoveredExistingTower;
            this.onSellTower?.(t.id, t.x, t.y);
            return;
          }
        }

        // Standard Left-Mouse: defer click build/focus to pointerup (<=5px) so Left-Drag (>5px) pans smoothly anywhere!
        this.isLeftMouseDown = true;
        this.leftMouseStart = { x: e.clientX, y: e.clientY };
        this.dragStart = { x: e.clientX, y: e.clientY };
        this.leftMousePanned = false;
      }
    });

    // ------------------------------------------------------------------------
    // POINTER MOVE
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
            const oldR = this.camGoalRadius;
            const newR = this.clampCameraRadius(
              oldR * (this.lastPinchDist / dist)
            );
            const ratio = newR / Math.max(1, oldR);
            this.camGoalRadius = newR;
            this.updateZoomCoupledPolar();

            // Focal-point anchored pinch-zoom around world point under finger midpoint!
            const pinchNdc = new THREE.Vector2();
            this.screenToNDC(this.lastPinchMid.x, this.lastPinchMid.y, pinchNdc);
            this.camera.updateMatrixWorld();
            this.raycaster.setFromCamera(pinchNdc, this.camera);
            if (
              this.raycaster.ray.intersectPlane(this.groundPlane, this._tmpPinch)
            ) {
              this.camGoalTarget.x +=
                (this._tmpPinch.x - this.camGoalTarget.x) * (1 - ratio);
              this.camGoalTarget.z +=
                (this._tmpPinch.z - this.camGoalTarget.z) * (1 - ratio);
            }
          }

          const midDx = mid.x - this.lastPinchMid.x;
          const midDy = mid.y - this.lastPinchMid.y;
          if (Math.abs(midDx) > 0.1 || Math.abs(midDy) > 0.1) {
            this.panCameraByScreenDelta(midDx, midDy);
          } else {
            this.clampCameraTarget();
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

          // Explicit PAN tool: 0px deadzone smooth 1-finger camera pan
          if (this._activeTool === 'PAN') {
            this.touchGestureMoved = true;
            this.panCameraByScreenDelta(tracked.x - prevX, tracked.y - prevY);
            return;
          }

          // Grabbed active ghost (<= 56px) -> smooth -54px Loupe Ghost Drag!
          if (!this.isLoupeDragging && this.canGrabExistingGhost && totalDist > 7) {
            this.clearTouchHoldTimer();
            this.isLoupeDragging = true;
            this.touchGestureMoved = true;
          }

          if (this.isLoupeDragging) {
            if (this.canGrabExistingGhost) {
              const ramp = Math.min(1, totalDist / 36);
              const targetY = Math.min(this.loupeGrabInitOffset.y, -54);
              this.loupeCurrentOffset.x =
                this.loupeGrabInitOffset.x * (1 - ramp);
              this.loupeCurrentOffset.y =
                this.loupeGrabInitOffset.y +
                (targetY - this.loupeGrabInitOffset.y) * ramp;
            } else {
              const elapsedMs = performance.now() - this.loupeHoldStartMs;
              const ramp = Math.min(1, elapsedMs / 110);
              this.loupeCurrentOffset.x = 0;
              this.loupeCurrentOffset.y = -54 * ramp;
            }
            this.updateLoupeDragAtScreen(tracked.x, tracked.y, false);
            return;
          }

          const panDeadzone = this.postPinchGuard ? 16 : 14;
          if (!this.touchGestureMoved && totalDist > panDeadzone) {
            this.clearTouchHoldTimer();
            this.touchGestureMoved = true;
            this.postPinchGuard = false;
          }
          if (this.touchGestureMoved && !this.postPinchGuard) {
            this.panCameraByScreenDelta(tracked.x - prevX, tracked.y - prevY);
          }
        }
        return;
      }

      // Desktop mouse move
      if (this._modalOpen) return;
      this.lastPointerScreen = { x: e.clientX, y: e.clientY };
      this.screenToNDC(e.clientX, e.clientY, this.mouseNDC);

      if (this.isMiddleOrAltDragging) {
        const dx = e.clientX - this.dragStart.x;
        const dy = e.clientY - this.dragStart.y;
        this.dragStart = { x: e.clientX, y: e.clientY };
        if (e.buttons === 4) {
          this.camGoalAzimuth -= dx * 0.006;
        } else {
          this.panCameraByScreenDelta(dx, dy);
        }
        return;
      }

      if (this.isRightMouseDown) {
        const distFromStart = Math.hypot(
          e.clientX - this.rightMouseStart.x,
          e.clientY - this.rightMouseStart.y
        );
        if (!this.rightMousePanned && distFromStart > 5) {
          this.rightMousePanned = true;
          this.dragStart = { x: e.clientX, y: e.clientY };
        }
        if (this.rightMousePanned) {
          const dx = e.clientX - this.dragStart.x;
          const dy = e.clientY - this.dragStart.y;
          this.dragStart = { x: e.clientX, y: e.clientY };
          if (e.shiftKey) {
            this.camGoalAzimuth -= dx * 0.006;
          } else {
            this.panCameraByScreenDelta(dx, dy);
          }
          return;
        }
      }

      if (this.isShiftPainting) {
        this.updateBuildHover();
        if (this.hoveredCell && this.lastHoverValid) {
          const key = `${this.hoveredCell.x},${this.hoveredCell.y}`;
          if (key !== this.lastPaintedCellKey) {
            this.lastPaintedCellKey = key;
            this.onPlaceTower?.(this.hoveredCell.x, this.hoveredCell.y);
          }
        }
        return;
      }

      if (this.isSweepSelling) {
        this.updateBuildHover();
        if (this.hoveredExistingTower) {
          const t = this.hoveredExistingTower;
          this.onSellTower?.(t.id, t.x, t.y);
        }
        return;
      }

      if (this.isLeftMouseDown) {
        const distFromStart = Math.hypot(
          e.clientX - this.leftMouseStart.x,
          e.clientY - this.leftMouseStart.y
        );
        if (!this.leftMousePanned && distFromStart > 5) {
          this.leftMousePanned = true;
          this.dragStart = { x: e.clientX, y: e.clientY };
          this.hideDesktopHoverVisuals();
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
    // POINTER UP / CANCEL
    // ------------------------------------------------------------------------
    const handlePointerEnd = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        const tracked = this.activeTouches.get(e.pointerId);
        this.activeTouches.delete(e.pointerId);
        this.clearTouchHoldTimer();

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

        // 2 -> 1 finger lift guard: re-anchor remaining touch so lift-off never jerks camera!
        if (this.activeTouches.size === 1) {
          const rem = Array.from(this.activeTouches.values())[0];
          rem.startX = rem.x;
          rem.startY = rem.y;
          this.postPinchGuard = true;
          this.touchGestureMoved = false;
          this.isLoupeDragging = false;
          return;
        }

        // All fingers lifted
        if (this.isLoupeDragging) {
          this.isLoupeDragging = false;
          this.canGrabExistingGhost = false;
          this.touchGestureMoved = false;
          this.postPinchGuard = false;
          this.applyTouchSelectionVisuals();
          return;
        }

        const wasCleanTap =
          e.type === 'pointerup' &&
          tracked !== undefined &&
          !this.touchGestureMoved &&
          !this.postPinchGuard &&
          this._activeTool !== 'PAN' &&
          Math.hypot(e.clientX - tracked.startX, e.clientY - tracked.startY) <=
            14;

        this.touchGestureMoved = false;
        this.postPinchGuard = false;
        this.canGrabExistingGhost = false;
        this.lastPinchDist = 0;

        if (wasCleanTap && !this._modalOpen) {
          if (this.dismissTransientUI?.()) return;
          this.handleTouchTap(e.clientX, e.clientY);
        }
        return;
      }

      // Desktop mouse up
      this.isMiddleOrAltDragging = false;
      this.isShiftPainting = false;
      this.isSweepSelling = false;

      if (this.isRightMouseDown) {
        const wasCleanRightClick =
          e.type === 'pointerup' &&
          e.button === 2 &&
          !this.rightMousePanned &&
          Math.hypot(
            e.clientX - this.rightMouseStart.x,
            e.clientY - this.rightMouseStart.y
          ) <= 5;
        this.isRightMouseDown = false;
        this.rightMousePanned = false;

        if (wasCleanRightClick && !this._modalOpen) {
          if (this.dismissTransientUI?.()) return;
          const isSpectatingOther =
            this.focusedPlayerId !== null &&
            this.focusedPlayerId !== this.localPlayerId;
          if (
            !this.arenaOverviewMode &&
            !isSpectatingOther &&
            this.currentRoomState?.phase === 'BUILD'
          ) {
            this.lastPointerScreen = { x: e.clientX, y: e.clientY };
            this.screenToNDC(e.clientX, e.clientY, this.mouseNDC);
            this.updateBuildHover();
            if (this.hoveredExistingTower) {
              const t = this.hoveredExistingTower;
              this.onSellTower?.(t.id, t.x, t.y);
            }
          }
        }
        return;
      }

      if (this.isLeftMouseDown) {
        const wasCleanLeftClick =
          e.type === 'pointerup' &&
          e.button === 0 &&
          !this.leftMousePanned &&
          Math.hypot(
            e.clientX - this.leftMouseStart.x,
            e.clientY - this.leftMouseStart.y
          ) <= 5;
        this.isLeftMouseDown = false;
        this.leftMousePanned = false;

        if (wasCleanLeftClick && !this._modalOpen) {
          if (this.arenaOverviewMode) {
            const hitIsland = this.raycastAnyIsland(e.clientX, e.clientY);
            if (hitIsland) {
              this.cancelTouchGhost();
              this.focusOnPlayerIsland(hitIsland.playerId);
              this.onFocusChange?.();
            }
            return;
          }

          const isSpectatingOther =
            this.focusedPlayerId !== null &&
            this.focusedPlayerId !== this.localPlayerId;
          if (
            !isSpectatingOther &&
            this.currentRoomState?.phase === 'BUILD' &&
            this._activeTool !== 'PAN'
          ) {
            this.lastPointerScreen = { x: e.clientX, y: e.clientY };
            this.screenToNDC(e.clientX, e.clientY, this.mouseNDC);
            this.updateBuildHover();
            if (this._activeTool === 'SELL') {
              if (this.hoveredExistingTower) {
                const t = this.hoveredExistingTower;
                this.onSellTower?.(t.id, t.x, t.y);
              }
            } else if (
              this._activeTool === 'BLOCK' &&
              this.hoveredCell &&
              this.lastHoverValid &&
              !this.hoveredExistingTower
            ) {
              this.onPlaceTower?.(this.hoveredCell.x, this.hoveredCell.y);
            }
          }
        }
      }
    };

    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);

    dom.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return;
      this.mouseNDC.set(-99, -99);
      if (!this.pendingTouchCell && !this.pendingTouchTowerId) {
        this.hideDesktopHoverVisuals();
      }
    });

    dom.addEventListener(
      'wheel',
      (e) => {
        if (this._modalOpen) return;
        e.preventDefault();
        this.camGoalRadius = this.clampCameraRadius(
          this.camGoalRadius + e.deltaY * 0.028
        );
        this.updateZoomCoupledPolar();
      },
      { passive: false }
    );
  }

  private clearTouchHoldTimer() {
    if (this.touchHoldTimer !== null) {
      clearTimeout(this.touchHoldTimer);
      this.touchHoldTimer = null;
    }
  }

  private tryStartHoldLoupeDrag(clientX: number, clientY: number): boolean {
    if (
      !this.currentRoomState ||
      this.currentRoomState.phase !== 'BUILD' ||
      !this.localPlayerId
    ) {
      return false;
    }
    const localIsland = this.islands.get(this.localPlayerId);
    const localPlayer = this.currentRoomState.players.find(
      (p) => p.id === this.localPlayerId
    );
    if (!localIsland || !localPlayer) return false;

    const ndc = new THREE.Vector2();
    this.screenToNDC(clientX, clientY, ndc);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);

    // If holding on an existing tower (unless grabbing active ghost), let clean tap handle Remove selection
    if (
      !this.canGrabExistingGhost &&
      this.raycastExistingWallMesh(localIsland, localPlayer)
    ) {
      return false;
    }

    return (
      this.intersectClampedBuildPlane(
        localIsland,
        this.currentRoomState.roundConfig,
        1.6
      ) !== null
    );
  }

  private updateLoupeDragAtScreen(
    fingerX: number,
    fingerY: number,
    forceEmit: boolean
  ) {
    if (
      !this.currentRoomState ||
      this.currentRoomState.phase !== 'BUILD' ||
      !this.localPlayerId
    ) {
      return;
    }
    const localIsland = this.islands.get(this.localPlayerId);
    const localPlayer = this.currentRoomState.players.find(
      (p) => p.id === this.localPlayerId
    );
    if (!localIsland || !localPlayer) return;

    const aimX = fingerX + this.loupeCurrentOffset.x;
    const aimY = fingerY + this.loupeCurrentOffset.y;
    const ndc = new THREE.Vector2();
    this.screenToNDC(aimX, aimY, ndc);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);

    const round = this.currentRoomState.roundConfig;
    const hit = this.intersectClampedBuildPlane(localIsland, round, 2.2);
    if (!hit) return;

    const smart = resolveSmart2x2Placement(
      round,
      localPlayer.towers,
      hit.relX,
      hit.relZ,
      { mode: 'touch', availableGold: localPlayer.gold }
    );

    const cellChanged =
      !this.pendingTouchCell ||
      this.pendingTouchCell.x !== smart.x ||
      this.pendingTouchCell.y !== smart.y;

    this.pendingTouchTowerId = null;
    this.pendingTouchCell = { x: smart.x, y: smart.y };

    if (cellChanged || forceEmit) {
      if (cellChanged) {
        this.onTouchSnapChange?.({ x: smart.x, y: smart.y }, smart.valid);
      }
      this.applyTouchSelectionVisuals(false, smart.snapped);
    }
  }

  // ==========================================================================
  // MOBILE TOUCH PRECISION PUBLIC CONTRACT METHODS (`tech_contracts.md §2.1`)
  // ==========================================================================

  public hasActiveTouchGhost(): boolean {
    return (
      this.pendingTouchCell !== null || this.pendingTouchTowerId !== null
    );
  }

  public nudgeTouchGhost(dx: number, dy: number): boolean {
    if (
      !this.currentRoomState ||
      this.currentRoomState.phase !== 'BUILD' ||
      !this.localPlayerId ||
      this.arenaOverviewMode
    ) {
      return false;
    }
    const localPlayer = this.currentRoomState.players.find(
      (p) => p.id === this.localPlayerId
    );
    if (!localPlayer) return false;

    const round = this.currentRoomState.roundConfig;
    let baseCell = this.pendingTouchCell;
    if (!baseCell && this.pendingTouchTowerId) {
      const existing = localPlayer.towers.find(
        (t) => t.id === this.pendingTouchTowerId
      );
      if (existing) baseCell = { x: existing.x, y: existing.y };
    }
    if (!baseCell) return false;

    const nx = Math.max(0, Math.min(round.gridWidth - 2, baseCell.x + dx));
    const ny = Math.max(0, Math.min(round.gridHeight - 2, baseCell.y + dy));
    if (
      this.pendingTouchCell &&
      nx === this.pendingTouchCell.x &&
      ny === this.pendingTouchCell.y
    ) {
      return false;
    }

    this.pendingTouchTowerId = null;
    this.pendingTouchCell = { x: nx, y: ny };
    this.applyTouchSelectionVisuals(true, false);

    const valid = this.activeTouchHoverInfo?.valid ?? false;
    this.onTouchSnapChange?.({ x: nx, y: ny }, valid);
    return true;
  }

  public confirmTouchGhost(): boolean {
    if (
      !this.currentRoomState ||
      this.currentRoomState.phase !== 'BUILD' ||
      !this.localPlayerId ||
      this.arenaOverviewMode
    ) {
      return false;
    }
    const localPlayer = this.currentRoomState.players.find(
      (p) => p.id === this.localPlayerId
    );
    if (!localPlayer) return false;

    if (this.pendingTouchTowerId) {
      const existing = localPlayer.towers.find(
        (t) => t.id === this.pendingTouchTowerId
      );
      this.cancelTouchGhost();
      if (existing) {
        this.onSellTower?.(existing.id, existing.x, existing.y);
        return true;
      }
      return false;
    }

    if (this.pendingTouchCell) {
      const { x, y } = this.pendingTouchCell;
      const hasGold = localPlayer.gold >= TOWER_SPECS.BLOCK.goldCost;
      const val = validateTowerPlacement(
        this.currentRoomState.roundConfig,
        localPlayer.towers,
        x,
        y
      );
      if (!hasGold || !val.valid) {
        return false;
      }
      this.cancelTouchGhost();
      this.onPlaceTower?.(x, y);
      return true;
    }

    return false;
  }

  public cancelTouchGhost(): void {
    this.clearTouchHoldTimer();
    this.pendingTouchCell = null;
    this.pendingTouchTowerId = null;
    this.activeTouchHoverInfo = null;
    this.isLoupeDragging = false;
    this.canGrabExistingGhost = false;
    this.hoveredCell = null;
    this.hoveredExistingTower = null;
    this.lastHoverValid = false;
    this.cachedHoverPreview = null;

    this.ghostGroup.visible = false;
    this.ghostTurretGroup.visible = true;
    this.ghostConnGroup.clear();
    this.clearPreviewConduits();
    this.hidePreviewPathMesh();

    if (this.localPlayerId) {
      const localIsland = this.islands.get(this.localPlayerId);
      if (localIsland) {
        localIsland.floorUniforms.uCursorPos.value.set(-99, -99);
        localIsland.floorUniforms.uReticleMode.value = 0;
        for (const sr of localIsland.spireRigs) {
          sr.targetHoverBoost = 0;
        }
        this.restoreIslandBaseSynergyVisuals(localIsland);
      }
    }

    this.onHoverStatusChange?.({
      cell: null,
      screenX: this.lastPointerScreen.x,
      screenY: this.lastPointerScreen.y,
      valid: false,
    });
  }

  public clearTouchPreview(): void {
    this.cancelTouchGhost();
  }

  /**
   * Clean 1-finger touch tap (`<= 14px`):
   * NEVER auto-commits on the 3D board (`tech_contracts.md §2.2`) — strictly aims `pendingTouchCell`
   * or selects `pendingTouchTowerId` for confirmation via `#touch-precision-tray`!
   */
  private handleTouchTap(clientX: number, clientY: number) {
    if (this.arenaOverviewMode) {
      this.cancelTouchGhost();
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
      this.cancelTouchGhost();
      return;
    }

    const localIsland = this.islands.get(this.localPlayerId);
    const localPlayer = this.currentRoomState.players.find(
      (p) => p.id === this.localPlayerId
    );
    if (!localIsland || !localPlayer) {
      this.cancelTouchGhost();
      return;
    }

    this.lastPointerScreen = { x: clientX, y: clientY };
    const ndc = new THREE.Vector2();
    this.screenToNDC(clientX, clientY, ndc);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);

    // 1. 3D Mesh-First Raycast against existing Stone Walls (zero cap parallax miss!)
    let existing = this.raycastExistingWallMesh(localIsland, localPlayer);

    const round = this.currentRoomState.roundConfig;
    const planeHit = this.intersectClampedBuildPlane(localIsland, round, 1.5);

    if (!existing && planeHit) {
      const cx = Math.floor(planeHit.relX);
      const cy = Math.floor(planeHit.relZ);
      existing =
        localPlayer.towers.find((t) => isCellIn2x2(cx, cy, t)) || null;
    }

    if (this._activeTool === 'SELL') {
      if (existing) {
        this.pendingTouchCell = null;
        this.pendingTouchTowerId = existing.id;
        this.applyTouchSelectionVisuals();
      } else {
        this.cancelTouchGhost();
      }
      return;
    }

    // Tapped an existing Stone Wall in BLOCK mode -> select it for Remove (+1) or Nudge
    if (existing) {
      this.pendingTouchCell = null;
      this.pendingTouchTowerId = existing.id;
      this.applyTouchSelectionVisuals();
      return;
    }

    if (!planeHit) {
      this.cancelTouchGhost();
      return;
    }

    // Smart 2x2 Obstacle-Aware Flush Snap (eliminates 0.5m 'Occupied' dead-moat!)
    const smart = resolveSmart2x2Placement(
      round,
      localPlayer.towers,
      planeHit.relX,
      planeHit.relZ,
      { mode: 'touch', availableGold: localPlayer.gold }
    );

    const changed =
      !this.pendingTouchCell ||
      this.pendingTouchCell.x !== smart.x ||
      this.pendingTouchCell.y !== smart.y;

    this.pendingTouchTowerId = null;
    this.pendingTouchCell = { x: smart.x, y: smart.y };
    this.applyTouchSelectionVisuals(false, smart.snapped);

    if (changed) {
      this.onTouchSnapChange?.({ x: smart.x, y: smart.y }, smart.valid);
    }
  }

  private projectWorldToScreen(worldPos: THREE.Vector3): {
    x: number;
    y: number;
    visible: boolean;
  } {
    this.camera.updateMatrixWorld();
    this._tmpProj.copy(worldPos).project(this.camera);
    return {
      x: this.viewportLeft + (this._tmpProj.x * 0.5 + 0.5) * this.viewportW,
      y: this.viewportTop + (-this._tmpProj.y * 0.5 + 0.5) * this.viewportH,
      visible: this._tmpProj.z <= 1,
    };
  }

  private isTouchProjectionOffscreen(proj: {
    x: number;
    y: number;
    visible: boolean;
  }): boolean {
    return (
      !proj.visible ||
      proj.x < 12 ||
      proj.x > this.viewportW - 12 ||
      proj.y < this.hudSafeTopPx + 8 ||
      proj.y > this.viewportH - this.hudSafeBottomPx - 8
    );
  }

  private applyTouchSelectionVisuals(isManualNudge = false, snapped = false) {
    if (
      !this.currentRoomState ||
      this.currentRoomState.phase !== 'BUILD' ||
      !this.localPlayerId ||
      this.arenaOverviewMode
    ) {
      this.cancelTouchGhost();
      return;
    }

    const localIsland = this.islands.get(this.localPlayerId);
    const localPlayer = this.currentRoomState.players.find(
      (p) => p.id === this.localPlayerId
    );
    if (!localIsland || !localPlayer) return;

    const round = this.currentRoomState.roundConfig;

    // Case A: Selected existing Stone Wall for Remove (+1)
    if (this.pendingTouchTowerId) {
      const existing = localPlayer.towers.find(
        (t) => t.id === this.pendingTouchTowerId
      );
      if (!existing) {
        this.cancelTouchGhost();
        return;
      }

      this.showRemoveBracketVisuals(localIsland, existing.x, existing.y);

      this.touchWorldAnchor.set(
        localIsland.offsetX + existing.x + 1.0,
        1.42,
        localIsland.offsetZ + existing.y + 1.0
      );
      const proj = this.projectWorldToScreen(this.touchWorldAnchor);
      const isGestureMoving =
        this.activeTouches.size > 0 &&
        this.touchGestureMoved &&
        !this.isLoupeDragging;
      const offscreen = this.isTouchProjectionOffscreen(proj);
      const placeNearTopEdge =
        proj.y < this.hudSafeTopPx + 108 || existing.y <= 3;

      const info: HoverStatusInfo = {
        cell: { x: existing.x, y: existing.y },
        screenX: proj.x,
        screenY: proj.y,
        valid: true,
        reason: 'Remove (+1)',
        existingTower: existing,
        isTouchPreview: true,
        isLoupeDragging: this.isLoupeDragging,
        isGestureMoving,
        placeNearTopEdge,
        offscreen,
      };
      this.activeTouchHoverInfo = info;
      this.onHoverStatusChange?.(info);
      return;
    }

    // Case B: 2x2 Stone Wall Placement Ghost Preview
    if (this.pendingTouchCell) {
      const { x: placeX, y: placeY } = this.pendingTouchCell;
      this.hoveredCell = { x: placeX, y: placeY };
      this.hoveredExistingTower = null;

      const preview = this.buildGhostAndPathPreview(
        localIsland,
        localPlayer,
        round,
        placeX,
        placeY,
        snapped && !isManualNudge
      );
      this.lastHoverValid = preview.valid;

      this.touchWorldAnchor.set(
        localIsland.offsetX + placeX + 1.0,
        1.42,
        localIsland.offsetZ + placeY + 1.0
      );
      const proj = this.projectWorldToScreen(this.touchWorldAnchor);
      const isGestureMoving =
        this.activeTouches.size > 0 &&
        this.touchGestureMoved &&
        !this.isLoupeDragging;
      const offscreen = this.isTouchProjectionOffscreen(proj);
      const placeNearTopEdge =
        proj.y < this.hudSafeTopPx + 108 || placeY <= 3;

      const info: HoverStatusInfo = {
        cell: { x: placeX, y: placeY },
        screenX: proj.x,
        screenY: proj.y,
        valid: preview.valid,
        snapped: preview.snapped,
        reason: preview.reason,
        deltaTime: preview.deltaTime,
        deltaClaps: preview.deltaClaps,
        deltaKeeps: preview.deltaKeeps,
        deltaOvercharge: preview.deltaOvercharge,
        previewTime: preview.previewTime,
        existingTower: null,
        isTouchPreview: true,
        isLoupeDragging: this.isLoupeDragging,
        isGestureMoving,
        placeNearTopEdge,
        offscreen,
      };
      this.activeTouchHoverInfo = info;
      this.onHoverStatusChange?.(info);
    }
  }

  // ==========================================================================
  // ELEVATED TABLETOP ISLAND, 3-SHAPE PROPS, SPIRES, GATES & RUNNERS
  // ==========================================================================

  private computeLayoutSignature(round: RoundConfig): string {
    const sStr = round.preplacedSpires
      .map((s) => `${s.x},${s.y},${s.spireType || 'THUNDERCLAP'}`)
      .join(';');
    const oStr = round.obstacles.map((o) => `${o.x},${o.y}`).join(';');
    return `${round.roundNumber}|${round.seed ?? 0}|${round.spawn.x},${round.spawn.y}|${round.exit.x},${round.exit.y}|${round.runnerType || 'SCOUT'}|${sStr}|${oStr}`;
  }

  public syncRoomState(state: RoomState, localPlayerId: string | null): void {
    const firstSync = !this.currentRoomState;
    const prevPhase = this.lastRoomPhase;
    this.lastRoomPhase = state.phase;

    const newSig = this.computeLayoutSignature(state.roundConfig);
    const layoutChanged = newSig !== this.lastLayoutSignature;
    this.lastLayoutSignature = newSig;

    this.currentRoomState = state;
    this.localPlayerId = localPlayerId;

    if (state.phase !== 'RUN') {
      this.latestSimStates.clear();
    }

    // Center sea around active multi-island grid
    const count = Math.max(1, state.players.length);
    const cols = Math.min(3, count);
    const rows = Math.ceil(count / 3);
    const arenaCenterX =
      ((cols - 1) * ISLAND_SPACING_X + state.roundConfig.gridWidth) * 0.5;
    const arenaCenterZ =
      ((rows - 1) * ISLAND_SPACING_Z + state.roundConfig.gridHeight) * 0.5;
    this.seaMesh.position.set(arenaCenterX, SEA_LEVEL_Y, arenaCenterZ);
    this.voidSeaMat.uniforms.uArenaCenter.value.set(arenaCenterX, arenaCenterZ);

    // Dispose & remove disconnected islands cleanly (zero VRAM leaks!)
    const activeIds = new Set(state.players.map((p) => p.id));
    for (const [pid, isl] of this.islands.entries()) {
      if (!activeIds.has(pid)) {
        this.disposeSubtree(isl.root);
        this.scene.remove(isl.root);
        this.islands.delete(pid);
        this.islandBadges.get(pid)?.root.remove();
        this.islandBadges.delete(pid);
        this.runnerBadges.get(pid)?.root.remove();
        this.runnerBadges.delete(pid);
      }
    }

    const localPlayer =
      state.players.find((p) => p.id === localPlayerId) || null;
    const newLocalEvalSig = localPlayer
      ? `${newSig}|${localPlayer.towers.map((t) => `${t.x},${t.y}`).join(';')}`
      : '';
    const localTowersChanged = newLocalEvalSig !== this.lastLocalEvalSig;

    if (localPlayer && (localTowersChanged || !this.cachedBaseEval)) {
      this.lastLocalEvalSig = newLocalEvalSig;
      const localPath = computeFullMazePath(
        state.roundConfig,
        localPlayer.towers
      );
      this.cachedBaseEval = evaluateMazeRunTime(
        state.roundConfig,
        localPlayer.towers,
        { precomputedPath: localPath, collectClapLocations: true }
      );
      this.cachedLocalCircuitry = computeCitadelCircuitry(
        state.roundConfig,
        localPlayer.towers
      );
      this.cachedHoverPreview = null;
    } else if (!localPlayer) {
      this.lastLocalEvalSig = '';
      this.cachedBaseEval = null;
      this.cachedLocalCircuitry = null;
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
          offsetZ,
          index
        );
        this.islands.set(player.id, island);
      } else {
        island.offsetX = offsetX;
        island.offsetZ = offsetZ;
        island.root.position.set(offsetX, 0, offsetZ);
        if (island.playerColor !== player.color) {
          island.playerColor = player.color;
          island.trimMesh.material = this.getPlayerTrimMaterial(player.color);
        }
        if (layoutChanged) {
          this.rebuildIslandPadsAndObstacles(island, state.roundConfig);
          island.lastTowersSig = '__force__';
        }
      }

      this.syncIslandTowersAndPath(
        island,
        player,
        state.roundConfig,
        firstSync || layoutChanged
      );
      this.updateIslandHeaderBadge(player, island);
    });

    if (firstSync && localPlayerId) {
      this.focusOnPlayerIsland(localPlayerId, true);
    } else if (
      prevPhase &&
      prevPhase !== state.phase &&
      !this.arenaOverviewMode
    ) {
      // Gently adjust HUD aperture zBias when bottom build dock hides/shows on BUILD <-> RUN
      const pid = this.focusedPlayerId || this.localPlayerId;
      const isl = pid ? this.islands.get(pid) : undefined;
      if (isl) {
        const gw = state.roundConfig.gridWidth;
        const gh = state.roundConfig.gridHeight;
        const frame = this.computeIdealFraming(gw + 2.0, gh + 3.4, 1.6);
        const distFromCenter = Math.hypot(
          this.camGoalTarget.x - (isl.offsetX + gw * 0.5),
          this.camGoalTarget.z - (isl.offsetZ + gh * 0.5)
        );
        if (distFromCenter < 5.0) {
          this.camGoalTarget.z = isl.offsetZ + gh * 0.5 + frame.zBias;
        }
      }
    }

    if (state.phase !== 'BUILD' || layoutChanged) {
      if (this.pendingTouchCell || this.pendingTouchTowerId) {
        this.cancelTouchGhost();
      } else {
        this.hideDesktopHoverVisuals();
      }
    } else if (this.pendingTouchCell || this.pendingTouchTowerId) {
      // Only re-run touch preview math on ROOM_STATE if local towers/gold actually changed!
      if (localTowersChanged) {
        this.applyTouchSelectionVisuals();
      }
    } else if (localTowersChanged) {
      this.updateBuildHover(true);
    }
  }

  private buildMiniatureCypressCluster(scale = 1.0): THREE.Group {
    const cluster = new THREE.Group();
    const trunks = new THREE.Mesh(
      this.sharedGeos.cypressTrunks,
      this.cypressTrunkMat
    );
    cluster.add(trunks);

    const cones = new THREE.Mesh(
      this.sharedGeos.cypressCones,
      this.cypressFoliageMat
    );
    cones.castShadow = true;
    cones.receiveShadow = true;
    cluster.add(cones);

    cluster.scale.setScalar(scale);
    return cluster;
  }

  /**
   * Builds the Elevated *Bad North* / *Townscaper* Sunlit Limestone Tabletop Plateau:
   * - Meadow sits at `y = 0.01m` on TOP of the mesa.
   * - Zero `1.34m` overhead trench walls blocking South rows `24–25` or Z-fighting at corners!
   * - Chamfered warm-limestone cliffs step DOWNWARD (`y = 0.00 -> -1.42m` sea) into a submerged reef shelf.
   */
  private createIslandVisuals(
    player: PlayerState,
    round: RoundConfig,
    offsetX: number,
    offsetZ: number,
    islandIndex: number
  ): IslandVisuals {
    const root = new THREE.Group();
    root.position.set(offsetX, 0, offsetZ);

    const gw = round.gridWidth;
    const gh = round.gridHeight;

    // 1. Submerged Coastal Reef Terrace & Lower Talus (`y = -1.58 .. -1.06`)
    const reefW = gw + 2.6;
    const reefD = gh + 2.6;
    const reefShelf = new THREE.Mesh(
      new THREE.BoxGeometry(reefW, 0.52, reefD),
      this.cliffTalusMat
    );
    reefShelf.position.set(gw / 2, -1.32, gh / 2);
    reefShelf.receiveShadow = true;
    root.add(reefShelf);

    // Rounded Shoreline Foam + Shallow Coastal Turquoise Halo at sea level (`y = -1.39`)
    const bankW = gw + 1.64;
    const bankD = gh + 1.64;
    const foamGeo = new THREE.PlaneGeometry(bankW + 4.8, bankD + 4.8);
    foamGeo.rotateX(-Math.PI / 2);
    const foamMat = createShorelineFoamShader(
      bankW,
      bankD,
      islandIndex * 0.27
    );
    const foamMesh = new THREE.Mesh(foamGeo, foamMat);
    foamMesh.position.set(gw / 2, SEA_LEVEL_Y + 0.03, gh / 2);
    foamMesh.renderOrder = 1;
    root.add(foamMesh);

    // 2. Player Heraldry Waterline Band (`y = -1.08 .. -0.94`)
    const trimMesh = new THREE.Mesh(
      new THREE.BoxGeometry(bankW + 0.12, 0.14, bankD + 0.12),
      this.getPlayerTrimMaterial(player.color)
    );
    trimMesh.position.set(gw / 2, -1.01, gh / 2);
    root.add(trimMesh);

    // 3. Upper Sunlit Limestone Escarpment (`y = -0.94 .. -0.08`) + 4 Chamfered Corner Bastion Buttresses
    const upperCliff = new THREE.Mesh(
      new THREE.BoxGeometry(gw + 1.48, 0.86, gh + 1.48),
      this.cliffLimestoneMat
    );
    upperCliff.position.set(gw / 2, -0.51, gh / 2);
    upperCliff.castShadow = true;
    upperCliff.receiveShadow = true;
    root.add(upperCliff);

    const cornerCoords = [
      { x: -0.36, z: -0.36 },
      { x: gw + 0.36, z: -0.36 },
      { x: -0.36, z: gh + 0.36 },
      { x: gw + 0.36, z: gh + 0.36 },
    ];
    for (const c of cornerCoords) {
      const bastion = new THREE.Mesh(
        this.sharedGeos.plateauCornerBastion,
        this.cliffLimestoneMat
      );
      bastion.position.set(c.x, -0.68, c.z);
      bastion.castShadow = true;
      bastion.receiveShadow = true;
      root.add(bastion);
    }

    // 4. Outer Grassy Plateau Shoulder (`y = -0.08 .. 0.00`)
    const turfShoulder = new THREE.Mesh(
      new THREE.BoxGeometry(gw + 1.62, 0.08, gh + 1.62),
      this.plateauShoulderTurfMat
    );
    turfShoulder.position.set(gw / 2, -0.04, gh / 2);
    turfShoulder.receiveShadow = true;
    root.add(turfShoulder);

    // 5. Low Flush West & East Limestone Coping Curbs (`y = 0.00..0.036`, strictly outside `[0..gw]`)
    const curbThick = 0.22;
    const westCurb = new THREE.Mesh(
      new THREE.BoxGeometry(curbThick, 0.038, gh + curbThick * 2),
      this.plateauCurbMat
    );
    westCurb.position.set(-curbThick * 0.5, 0.019, gh / 2);
    westCurb.receiveShadow = true;
    root.add(westCurb);

    const eastCurb = new THREE.Mesh(
      new THREE.BoxGeometry(curbThick, 0.038, gh + curbThick * 2),
      this.plateauCurbMat
    );
    eastCurb.position.set(gw + curbThick * 0.5, 0.019, gh / 2);
    eastCurb.receiveShadow = true;
    root.add(eastCurb);

    // 6. Grounded Miniature Cypress Clusters on the 4 Outer Plateau Shoulders (`y = 0.0`)
    const cornerClusters = [
      { x: -0.58, z: -0.56, s: 0.84, rot: 0.4 },
      { x: gw + 0.56, z: -0.58, s: 0.78, rot: 2.1 },
      { x: -0.56, z: gh + 0.54, s: 0.8, rot: 1.2 },
      { x: gw + 0.58, z: gh + 0.56, s: 0.86, rot: 3.6 },
    ];
    for (const cc of cornerClusters) {
      const cluster = this.buildMiniatureCypressCluster(cc.s);
      cluster.position.set(cc.x, 0.0, cc.z);
      cluster.rotation.y = cc.rot;
      root.add(cluster);
    }

    // 7. Lit Velvety Meadow Floor (`20x26` at `y = 0.01`)
    const floorGeo = new THREE.PlaneGeometry(gw, gh);
    floorGeo.rotateX(-Math.PI / 2);
    const { material: floorMat, uniforms: floorUniforms } =
      createGrasslandFloorMaterial(this.isCoarseOrCompactDevice());
    floorUniforms.uGridSize.value.set(gw, gh);
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.position.set(gw / 2, 0.01, gh / 2);
    floorMesh.receiveShadow = true;
    root.add(floorMesh);

    // Veiled Fog-of-War Mist Shroud for hidden rival islands
    const fogVeilGeo = new THREE.PlaneGeometry(gw - 0.3, gh - 0.3);
    fogVeilGeo.rotateX(-Math.PI / 2);
    const fogVeilMesh = new THREE.Mesh(fogVeilGeo, this.fogVeilMat);
    fogVeilMesh.position.set(gw / 2, 0.24, gh / 2);
    fogVeilMesh.renderOrder = 8;
    fogVeilMesh.visible = false;
    root.add(fogVeilMesh);

    // Padded Raycast Hit Plane (`gw + 1.2 x gh + 1.2`)
    const hitGeo = new THREE.PlaneGeometry(gw + 1.2, gh + 1.2);
    hitGeo.rotateX(-Math.PI / 2);
    const hitPlane = new THREE.Mesh(
      hitGeo,
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hitPlane.position.set(gw / 2, 0.02, gh / 2);
    root.add(hitPlane);

    const padGroup = new THREE.Group();
    root.add(padGroup);

    const conduitGroup = new THREE.Group();
    root.add(conduitGroup);

    const towerGroup = new THREE.Group();
    root.add(towerGroup);

    const bridgeGroup = new THREE.Group();
    root.add(bridgeGroup);

    const clapMarkerGroup = new THREE.Group();
    root.add(clapMarkerGroup);

    const pathMat = createPathRibbonShader('#fefce8', 0.66);
    const conduitMat = createLeyConduitShader(false);

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
      conduitMat,
      fogVeilMesh,
      trimMesh,
      hitPlane,
      padGroup,
      towerGroup,
      bridgeGroup,
      conduitGroup,
      bridgeEntries: [],
      clapMarkerGroup,
      towerMeshes: new Map(),
      spireRigs: [],
      ruinRigs: [],
      pathMesh: null,
      pathMat,
      runner,
      lastTowersSig: '',
      lastSimStatus: '',
      lastSimTimeText: '',
    };

    this.rebuildIslandPadsAndObstacles(visuals, round);
    this.createIslandDOMElements(player);

    return visuals;
  }

  /**
   * Heroic Top-Down Runner Archetypes (Zero Wall-Clipping, High Shadow Contrast):
   * - `SCOUT`: Azure cloak + sky-white feather + glowing cyan wayfarer lantern (`r = 0.14m`).
   * - `OUTRIDER`: Royal Cobalt (`#1d4ed8`) + White/Gold (decoupled from Crimson Keep red!),
   *   shortened `0.90m` non-clipping spear + tall back-mounted fluttering gold pennant (`y = 1.48m`).
   * - `JUGGERNAUT`: Gleaming Silver-Steel (`#cbd5e1`) pauldrons & greathelm + wide `0.56m` gilded Pavise + maul.
   * - `HERALD`: Viridian tunic + wide `0.68m` swept emerald V-wings that flare wide during Tailwind Haste!
   */
  private buildArticulatedRunnerRig(
    playerColor: string,
    runnerType: RunnerArchetype = 'SCOUT'
  ): RunnerRig {
    const root = new THREE.Group();
    if (runnerType === 'JUGGERNAUT') {
      root.scale.set(1.16, 1.12, 1.16);
    }

    const footShadow = new THREE.Mesh(this.sharedGeos.aoQuad, this.aoDiscMat);
    footShadow.scale.setScalar(0.54);
    footShadow.position.y = 0.016;
    footShadow.renderOrder = 2;
    root.add(footShadow);

    const statusRingMat = createRunnerStatusRingShader();
    const statusRing = new THREE.Mesh(
      this.sharedGeos.unitCirclePlane,
      statusRingMat
    );
    statusRing.scale.setScalar(0.52);
    statusRing.position.y = 0.028;
    statusRing.renderOrder = 7;
    statusRing.visible = false;
    root.add(statusRing);

    const pelvis = new THREE.Group();
    pelvis.position.y = 0.45;
    root.add(pelvis);

    const tunicColor =
      runnerType === 'OUTRIDER'
        ? '#1d4ed8'
        : runnerType === 'JUGGERNAUT'
        ? '#475569'
        : runnerType === 'HERALD'
        ? '#0d9488'
        : '#2563eb';

    const torsoMesh = new THREE.Mesh(
      this.sharedGeos.runnerTorso,
      new THREE.MeshStandardMaterial({
        color: tunicColor,
        emissive: playerColor,
        emissiveIntensity: 0.12,
        roughness: runnerType === 'JUGGERNAUT' ? 0.36 : 0.58,
        metalness: runnerType === 'JUGGERNAUT' ? 0.48 : 0.1,
      })
    );
    torsoMesh.position.y = 0.25;
    torsoMesh.castShadow = true;
    pelvis.add(torsoMesh);

    // High-contrast bright collar so runners never disappear inside directional shadows
    const collar = new THREE.Mesh(
      this.sharedGeos.runnerCollar,
      runnerType === 'JUGGERNAUT'
        ? this.runnerSteelBrightMat
        : this.runnerCollarIvoryMat
    );
    collar.position.y = 0.54;
    pelvis.add(collar);

    let leftWing: THREE.Mesh | null = null;
    let rightWing: THREE.Mesh | null = null;
    let pennantMesh: THREE.Mesh | null = null;

    if (runnerType === 'JUGGERNAUT') {
      for (const side of [-0.34, 0.34]) {
        const pauldron = new THREE.Mesh(
          this.sharedGeos.runnerPauldron,
          this.runnerSteelBrightMat
        );
        pauldron.position.set(side, 0.52, 0);
        pauldron.castShadow = true;
        pelvis.add(pauldron);
      }
    } else if (runnerType === 'HERALD') {
      const wingMat = new THREE.MeshStandardMaterial({
        color: '#6ee7b7',
        emissive: '#10b981',
        emissiveIntensity: 0.28,
        roughness: 0.36,
      });
      leftWing = new THREE.Mesh(this.sharedGeos.runnerWing, wingMat);
      leftWing.position.set(-0.26, 0.46, -0.22);
      leftWing.rotation.set(0.28, -0.42, -0.14);
      leftWing.castShadow = true;
      pelvis.add(leftWing);

      rightWing = new THREE.Mesh(this.sharedGeos.runnerWing, wingMat);
      rightWing.position.set(0.26, 0.46, -0.22);
      rightWing.rotation.set(0.28, 0.42, 0.14);
      rightWing.castShadow = true;
      pelvis.add(rightWing);
    } else if (runnerType === 'OUTRIDER') {
      // Tall back-mounted fluttering gold cavalry pennant visible above walls!
      const pole = new THREE.Mesh(
        this.sharedGeos.runnerPennantPole,
        this.cypressTrunkMat
      );
      pole.position.set(-0.14, 0.68, -0.18);
      pole.rotation.x = -0.12;
      pelvis.add(pole);

      pennantMesh = new THREE.Mesh(
        this.sharedGeos.runnerPennantFlag,
        this.runnerGoldAccentMat
      );
      pennantMesh.position.set(-0.14, 1.06, -0.4);
      pennantMesh.castShadow = true;
      pelvis.add(pennantMesh);
    }

    const headGroup = new THREE.Group();
    headGroup.position.y = 0.75;

    const helmMat =
      runnerType === 'JUGGERNAUT'
        ? this.runnerSteelBrightMat
        : new THREE.MeshStandardMaterial({
            color:
              runnerType === 'OUTRIDER'
                ? '#e2e8f0'
                : runnerType === 'HERALD'
                ? '#115e59'
                : '#1e40af',
            roughness: 0.45,
            metalness: runnerType === 'OUTRIDER' ? 0.42 : 0.12,
          });
    const helm = new THREE.Mesh(this.sharedGeos.runnerHelm, helmMat);
    helm.castShadow = true;
    headGroup.add(helm);

    if (runnerType === 'SCOUT') {
      const hoodPeak = new THREE.Mesh(
        this.sharedGeos.runnerHoodPeak,
        this.northGateRoofMat
      );
      hoodPeak.position.set(0, 0.16, -0.06);
      hoodPeak.rotation.x = -0.45;
      headGroup.add(hoodPeak);

      const feather = new THREE.Mesh(
        this.sharedGeos.runnerFeather,
        this.runnerCollarIvoryMat
      );
      feather.position.set(0.12, 0.25, -0.1);
      feather.rotation.set(-0.55, 0, -0.22);
      headGroup.add(feather);
    } else if (runnerType === 'OUTRIDER') {
      const plume = new THREE.Mesh(
        this.sharedGeos.runnerPlume,
        this.runnerGoldAccentMat
      );
      plume.position.set(0, 0.25, -0.1);
      plume.rotation.x = -0.58;
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
      this.sharedGeos.runnerVisor,
      new THREE.MeshBasicMaterial({ color: visorColor })
    );
    visor.position.set(0, 0.01, 0.18);
    headGroup.add(visor);
    pelvis.add(headGroup);

    const armMat =
      runnerType === 'JUGGERNAUT'
        ? this.runnerSteelBrightMat
        : this.ivoryShaftMat;

    const leftArm = new THREE.Group();
    leftArm.position.set(-0.28, 0.46, 0);
    const lArmMesh = new THREE.Mesh(this.sharedGeos.runnerArm, armMat);
    lArmMesh.position.y = -0.15;
    leftArm.add(lArmMesh);
    pelvis.add(leftArm);

    const rightArm = new THREE.Group();
    rightArm.position.set(0.28, 0.46, 0);
    const rArmMesh = new THREE.Mesh(this.sharedGeos.runnerArm, armMat);
    rArmMesh.position.y = -0.15;
    rightArm.add(rArmMesh);
    pelvis.add(rightArm);

    let accentMesh: THREE.Mesh | null = null;

    if (runnerType === 'JUGGERNAUT') {
      const shieldGroup = new THREE.Group();
      shieldGroup.position.set(-0.1, -0.1, 0.25);
      shieldGroup.rotation.set(-0.24, -0.34, 0.08);

      const shieldPlate = new THREE.Mesh(
        this.sharedGeos.runnerShieldPlate,
        this.runnerSteelDarkMat
      );
      shieldPlate.castShadow = true;
      shieldGroup.add(shieldPlate);

      const shieldRim = new THREE.Mesh(
        this.sharedGeos.runnerShieldRim,
        this.runnerSteelBrightMat
      );
      shieldRim.position.y = 0.27;
      shieldGroup.add(shieldRim);

      const shieldBoss = new THREE.Mesh(
        this.sharedGeos.runnerShieldBoss,
        this.runnerGoldAccentMat
      );
      shieldBoss.position.z = 0.05;
      shieldGroup.add(shieldBoss);
      leftArm.add(shieldGroup);
      leftArm.rotation.x = 0.28;

      const maceShaft = new THREE.Mesh(
        this.sharedGeos.runnerWeaponShaft,
        this.cypressTrunkMat
      );
      maceShaft.position.set(0.05, 0.04, 0.18);
      maceShaft.rotation.x = 0.45;
      rightArm.add(maceShaft);

      const maceHead = new THREE.Mesh(
        this.sharedGeos.runnerMaceHead,
        this.runnerSteelBrightMat
      );
      maceHead.position.set(0.05, 0.42, 0.36);
      maceHead.castShadow = true;
      rightArm.add(maceHead);
    } else if (runnerType === 'OUTRIDER') {
      // Compact 0.90m non-clipping cavalry spear
      const spearGroup = new THREE.Group();
      spearGroup.position.set(0.05, -0.12, 0.18);
      spearGroup.rotation.x = 1.05;

      const spearShaft = new THREE.Mesh(
        this.sharedGeos.runnerWeaponShaft,
        this.cypressTrunkMat
      );
      spearGroup.add(spearShaft);

      const spearTip = new THREE.Mesh(
        this.sharedGeos.runnerSpearTip,
        this.runnerSteelBrightMat
      );
      spearTip.position.y = 0.54;
      spearGroup.add(spearTip);
      rightArm.add(spearGroup);
    } else if (runnerType === 'HERALD') {
      const rodGroup = new THREE.Group();
      rodGroup.position.set(0.05, 0.04, 0.18);
      rodGroup.rotation.x = 0.28;

      const rodShaft = new THREE.Mesh(
        this.sharedGeos.runnerWeaponShaft,
        this.cypressTrunkMat
      );
      rodGroup.add(rodShaft);

      const galeGem = new THREE.Mesh(
        this.sharedGeos.runnerOrbGem,
        new THREE.MeshBasicMaterial({ color: '#34d399' })
      );
      galeGem.position.set(0, 0.54, 0);
      rodGroup.add(galeGem);
      accentMesh = galeGem;
      rightArm.add(rodGroup);
    } else {
      const staffGroup = new THREE.Group();
      staffGroup.position.set(0.06, 0.04, 0.18);
      staffGroup.rotation.x = 0.24;

      const staffShaft = new THREE.Mesh(
        this.sharedGeos.runnerWeaponShaft,
        this.cypressTrunkMat
      );
      staffGroup.add(staffShaft);

      const lanternGlow = new THREE.Mesh(
        this.sharedGeos.runnerOrbGem,
        new THREE.MeshBasicMaterial({ color: '#38bdf8' })
      );
      lanternGlow.position.set(0.04, 0.48, 0.1);
      staffGroup.add(lanternGlow);
      accentMesh = lanternGlow;
      rightArm.add(staffGroup);
    }

    const leftLeg = new THREE.Group();
    leftLeg.position.set(-0.12, -0.05, 0);
    const lLegMesh = new THREE.Mesh(this.sharedGeos.runnerLeg, this.runnerLegMat);
    lLegMesh.position.y = -0.15;
    leftLeg.add(lLegMesh);
    pelvis.add(leftLeg);

    const rightLeg = new THREE.Group();
    rightLeg.position.set(0.12, -0.05, 0);
    const rLegMesh = new THREE.Mesh(this.sharedGeos.runnerLeg, this.runnerLegMat);
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
      leftWing,
      rightWing,
      pennantMesh,
      accentMesh,
      leftLeg,
      rightLeg,
      statusRing,
      statusRingMat,
      walkPhase: 0,
      currentYaw: 0,
    };
  }

  /**
   * Rebuilds North Gatehouse, South Shrine, Flush North/South Coping Curbs,
   * Open-Crown Elemental Spires, and Buttressed Crimson Keeps (disposing prior dynamic resources).
   */
  private rebuildIslandPadsAndObstacles(
    island: IslandVisuals,
    round: RoundConfig
  ) {
    this.disposeSubtree(island.padGroup);
    island.padGroup.clear();
    island.spireRigs = [];
    island.ruinRigs = [];

    const gw = round.gridWidth;
    const gh = round.gridHeight;
    const curbThick = 0.22;
    const gateHalfGap = 1.45;

    const spawnCx = round.spawn.x + 1.0;
    const spawnBorderZ = round.spawn.y === 0 ? 0.0 : round.spawn.y + 1.0;
    const exitCx = round.exit.x + 1.0;
    const exitBorderZ =
      round.exit.y >= round.gridHeight - 2
        ? round.gridHeight
        : round.exit.y + 1.0;

    // 1. Low Flush North & South Coping Curbs notched cleanly at Spawn & Exit (zero cell occlusion!)
    const addCurbSpan = (x0: number, x1: number, cz: number) => {
      const spanW = x1 - x0;
      if (spanW <= 0.1) return;
      const curb = new THREE.Mesh(
        new THREE.BoxGeometry(spanW, 0.038, curbThick),
        this.plateauCurbMat
      );
      curb.position.set((x0 + x1) * 0.5, 0.019, cz);
      curb.receiveShadow = true;
      island.padGroup.add(curb);
    };

    addCurbSpan(0, spawnCx - gateHalfGap, -curbThick * 0.5);
    addCurbSpan(spawnCx + gateHalfGap, gw, -curbThick * 0.5);
    addCurbSpan(0, exitCx - gateHalfGap, gh + curbThick * 0.5);
    addCurbSpan(exitCx + gateHalfGap, gw, gh + curbThick * 0.5);

    // 2. Distinct North Gatehouse (`y = 0`, slate-blue steeped roof + south-pointing chevron apron)
    const spawnGate = new THREE.Group();
    spawnGate.position.set(spawnCx, 0, spawnBorderZ);

    const northApron = new THREE.Mesh(
      new THREE.BoxGeometry(2.8, 0.06, 1.5),
      this.plinthSandstoneMat
    );
    northApron.position.set(0, 0.01, -0.45);
    northApron.receiveShadow = true;
    spawnGate.add(northApron);

    for (const side of [-1.22, 1.22]) {
      const pier = new THREE.Mesh(this.sharedGeos.gatePier, this.ivoryShaftMat);
      pier.position.set(side, 0.81, -0.58);
      pier.castShadow = true;
      pier.receiveShadow = true;
      spawnGate.add(pier);

      const pierCap = new THREE.Mesh(
        this.sharedGeos.gatePierCap,
        this.creamCapMat
      );
      pierCap.position.set(side, 1.7, -0.58);
      spawnGate.add(pierCap);
    }

    const northRoof = new THREE.Mesh(
      new THREE.BoxGeometry(3.15, 0.34, 0.68),
      this.northGateRoofMat
    );
    northRoof.position.set(0, 1.82, -0.58);
    northRoof.castShadow = true;
    spawnGate.add(northRoof);

    const chevron = new THREE.Mesh(
      this.sharedGeos.gateChevron,
      this.spawnAzureMat
    );
    chevron.position.set(0, 0.03, 0.28);
    spawnGate.add(chevron);
    island.padGroup.add(spawnGate);

    // 3. Distinct South Triumphal Shrine (`y = 26`, tall obsidian/ivory piers + sacred coral-gold braziers + goal seal)
    const exitShrine = new THREE.Group();
    exitShrine.position.set(exitCx, 0, exitBorderZ);

    const southApron = new THREE.Mesh(
      new THREE.BoxGeometry(2.8, 0.06, 1.5),
      this.plinthSandstoneMat
    );
    southApron.position.set(0, 0.01, 0.45);
    southApron.receiveShadow = true;
    exitShrine.add(southApron);

    for (const side of [-1.22, 1.22]) {
      const ped = new THREE.Mesh(
        this.sharedGeos.gatePier,
        this.darkBasaltMat
      );
      ped.scale.set(0.96, 0.9, 0.96);
      ped.position.set(side, 0.73, 0.58);
      ped.castShadow = true;
      ped.receiveShadow = true;
      exitShrine.add(ped);

      const bowl = new THREE.Mesh(
        this.sharedGeos.keepBrazierBowl,
        this.goldBridgeTrimMat
      );
      bowl.position.set(side, 1.52, 0.58);
      exitShrine.add(bowl);

      const flame = new THREE.Mesh(
        this.sharedGeos.keepBrazierFlame,
        this.southShrineFlameMat
      );
      flame.scale.setScalar(0.82);
      flame.position.set(side, 1.74, 0.58);
      exitShrine.add(flame);
    }

    const goalSeal = new THREE.Mesh(
      this.sharedGeos.goalSealRing,
      this.exitCoralMat
    );
    goalSeal.position.set(0, 0.026, -0.32);
    exitShrine.add(goalSeal);
    island.padGroup.add(exitShrine);

    // 4. Pre-Placed Freestanding Open-Crown Elemental Spires
    round.preplacedSpires.forEach((spirePt, idx) => {
      const spireRig = this.buildArticulatedStormSpireRig(
        spirePt.spireType || 'THUNDERCLAP',
        spirePt.x,
        spirePt.y,
        idx
      );
      spireRig.group.position.set(spirePt.x + 1.0, 0, spirePt.y + 1.0);
      island.padGroup.add(spireRig.group);
      island.spireRigs.push(spireRig);
    });

    // 5. Pre-Placed Buttressed Cruciform Crimson Keeps
    round.obstacles.forEach((obs, idx) => {
      const ruinRig = this.buildPreplacedCrimsonKeepPillar(obs.x, obs.y, idx);
      ruinRig.group.position.set(obs.x + 1.0, 0, obs.y + 1.0);
      island.padGroup.add(ruinRig.group);
      island.ruinRigs.push(ruinRig);
    });

    // 6. Rebuild Runner Rig cleanly (disposing previous non-shared runner materials)
    this.disposeSubtree(island.runner.root);
    island.root.remove(island.runner.root);
    island.runner = this.buildArticulatedRunnerRig(
      island.playerColor,
      round.runnerType || 'SCOUT'
    );
    island.runner.root.position.set(spawnCx, 0, spawnBorderZ);
    island.root.add(island.runner.root);
  }

  /**
   * Builds Freestanding Dark-Slate Open-Crown Elemental Spires (100% distinct from top-down!):
   * - `THUNDERCLAP`: Bronze-slate obelisk + open 3-pronged brass fork & glowing amber prism.
   * - `FROST_OBELISK`: 4-pointed pale-cyan glacier star around a central ice monolith.
   * - `CHRONO_SPIRE`: Unroofed open crescent cradle + brass halo + unobstructed `r=0.34m` violet orb!
   * - High-contrast dark-bezel gold `◆–◆◆◆` sigils + ground collar tier segments.
   */
  private buildArticulatedStormSpireRig(
    spireType: SpireType = 'THUNDERCLAP',
    gridX = 0,
    gridY = 0,
    spireIndex = 0
  ): SpireVisualRig {
    const group = new THREE.Group();
    group.userData.spireIndex = spireIndex;
    const spec = TOWER_SPECS[spireType];

    const ao = new THREE.Mesh(this.sharedGeos.aoQuad, this.aoDiscMat);
    ao.scale.setScalar(1.1);
    ao.position.y = 0.015;
    ao.renderOrder = 2;
    group.add(ao);

    const plinth = new THREE.Mesh(
      this.sharedGeos.spirePlinth,
      this.spireSlatePlinthMat
    );
    plinth.position.y = 0.13;
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    group.add(plinth);

    const pedestal = new THREE.Mesh(
      this.sharedGeos.spirePedestal,
      this.spireSlatePedestalMat
    );
    pedestal.position.y = 0.62;
    pedestal.castShadow = true;
    pedestal.receiveShadow = true;
    group.add(pedestal);

    const collar = new THREE.Mesh(
      this.sharedGeos.spireCollar,
      this.spireSlatePlinthMat
    );
    collar.position.y = 1.06;
    collar.receiveShadow = true;
    group.add(collar);

    const collarRimMesh = new THREE.Mesh(
      this.sharedGeos.spireCollarRim,
      this.collarRimInactiveMat
    );
    collarRimMesh.position.y = 1.16;
    group.add(collarRimMesh);

    // 3 Bold Dark-Bezel Gold Diamond Sigils (`◆–◆◆◆`) + 3 Ground Collar Segments
    const overchargePips: THREE.Mesh[] = [];
    const groundTierArcs: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const ang = (i - 1) * 0.62;
      const pipHolder = new THREE.Group();
      pipHolder.position.set(Math.sin(ang) * 0.84, 1.15, Math.cos(ang) * 0.84);
      pipHolder.rotation.order = 'YXZ';
      pipHolder.rotation.y = ang;
      pipHolder.rotation.x = -0.74;

      const bezel = new THREE.Mesh(
        this.sharedGeos.spirePipBezel,
        this.pipBezelDarkMat
      );
      pipHolder.add(bezel);

      const gem = new THREE.Mesh(
        this.sharedGeos.spirePipGem,
        this.pipInactiveMat
      );
      gem.position.y = 0.03;
      pipHolder.add(gem);
      group.add(pipHolder);
      overchargePips.push(gem);

      const groundArc = new THREE.Mesh(
        this.sharedGeos.spireGroundArc,
        this.groundArcInactiveMat
      );
      groundArc.position.y = 0.032;
      groundArc.rotation.y = ang;
      groundArc.renderOrder = 4;
      group.add(groundArc);
      groundTierArcs.push(groundArc);
    }

    let upperCore: THREE.Object3D;
    let baseCoreY = 1.85;

    if (spireType === 'FROST_OBELISK') {
      // 4-Pointed Cyan Glacier Star + Central Hexagonal Monolith
      const frostGroup = new THREE.Group();
      const shaft = new THREE.Mesh(
        this.sharedGeos.frostCentralShaft,
        this.frostMainMat
      );
      shaft.position.y = 0.64;
      shaft.castShadow = true;
      frostGroup.add(shaft);

      const tip = new THREE.Mesh(this.sharedGeos.frostTip, this.frostBladeMat);
      tip.position.y = 1.46;
      frostGroup.add(tip);

      for (let s = 0; s < 4; s++) {
        const ang = (s * Math.PI) / 2;
        const blade = new THREE.Mesh(
          this.sharedGeos.frostStarBlade,
          this.frostBladeMat
        );
        blade.position.set(Math.sin(ang) * 0.44, 0.36, Math.cos(ang) * 0.44);
        blade.rotation.y = ang;
        blade.rotation.x = 0.38;
        blade.castShadow = true;
        frostGroup.add(blade);
      }

      baseCoreY = 1.14;
      frostGroup.position.y = baseCoreY;
      group.add(frostGroup);
      upperCore = frostGroup;
    } else if (spireType === 'CHRONO_SPIRE') {
      // UNROOFED Open Crescent Astrolabe Cradle + Unobstructed Violet-Gold Orb (`r = 0.34m`)!
      for (const sideX of [-1, 1]) {
        const horn = new THREE.Mesh(
          this.sharedGeos.chronoHorn,
          this.chronoHornMat
        );
        horn.position.set(sideX * 0.46, 1.66, 0);
        horn.rotation.z = -sideX * 0.24;
        horn.castShadow = true;
        group.add(horn);
      }

      const coreGroup = new THREE.Group();
      const halo = new THREE.Mesh(
        this.sharedGeos.chronoHalo,
        this.stormBrassMat
      );
      coreGroup.add(halo);

      const orb = new THREE.Mesh(
        this.sharedGeos.chronoOrb,
        this.chronoOrbMat
      );
      orb.castShadow = true;
      coreGroup.add(orb);

      baseCoreY = 1.88;
      coreGroup.position.y = baseCoreY;
      group.add(coreGroup);
      upperCore = coreGroup;
    } else {
      // THUNDERCLAP: Dark Bronze-Slate Obelisk + Open 3-Prong Brass Fork & Glowing Amber Prism
      const body = new THREE.Mesh(
        this.sharedGeos.stormObeliskBody,
        this.stormBodyMat
      );
      body.position.y = 1.62;
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);

      for (let p = 0; p < 3; p++) {
        const ang = (p * Math.PI * 2) / 3;
        const prong = new THREE.Mesh(
          this.sharedGeos.stormProng,
          this.stormBrassMat
        );
        prong.position.set(Math.sin(ang) * 0.36, 2.12, Math.cos(ang) * 0.36);
        prong.rotation.y = ang;
        prong.rotation.x = 0.26;
        group.add(prong);
      }

      const prism = new THREE.Mesh(
        this.sharedGeos.stormPrism,
        this.stormPrismMat
      );
      prism.castShadow = true;
      baseCoreY = 2.24;
      prism.position.y = baseCoreY;
      group.add(prism);
      upperCore = prism;
    }

    const cooldownRingMat = createSpireBaseCooldownShader(spireType);
    const cooldownRingMesh = new THREE.Mesh(
      this.sharedGeos.spireCooldownPlane,
      cooldownRingMat
    );
    cooldownRingMesh.position.y = 0.04;
    cooldownRingMesh.renderOrder = 8;
    cooldownRingMesh.visible = false;
    group.add(cooldownRingMesh);

    const baseRange = spec.range;
    const aoeMat = createSpireAoEShader(baseRange, spireType);
    const aoeMesh = new THREE.Mesh(this.sharedGeos.unitCirclePlane, aoeMat);
    aoeMesh.scale.set(baseRange, 1, baseRange);
    aoeMesh.position.y = 0.022;
    aoeMesh.renderOrder = 3;
    group.add(aoeMesh);

    return {
      group,
      spireIndex,
      spireType,
      baseRange,
      gridX,
      gridY,
      upperCore,
      baseCoreY,
      collarRimMesh,
      overchargePips,
      groundTierArcs,
      cooldownRingMesh,
      cooldownRingMat,
      aoeMesh,
      aoeMat,
      targetHoverBoost: 0,
      recoil: 0,
      cdrFlash: 0,
    };
  }

  /**
   * Pre-Placed Crimson Keep (`obstacle`):
   * Buttressed Cruciform Dark-Basalt Skirt + Deep Crimson Masonry + Large `r=0.28m` Crown Brazier!
   */
  private buildPreplacedCrimsonKeepPillar(
    gridX: number,
    gridY: number,
    keepIndex: number
  ): RuinVisualRig {
    const group = new THREE.Group();
    group.userData.keepIndex = keepIndex;

    const ao = new THREE.Mesh(this.sharedGeos.aoQuad, this.aoDiscMat);
    ao.scale.setScalar(1.06);
    ao.position.y = 0.015;
    ao.renderOrder = 2;
    group.add(ao);

    const skirt = new THREE.Mesh(
      this.sharedGeos.keepBasaltSkirt,
      this.darkBasaltMat
    );
    skirt.castShadow = true;
    skirt.receiveShadow = true;
    group.add(skirt);

    const shaft = new THREE.Mesh(
      this.sharedGeos.keepShaft,
      this.crimsonKeepWallMat
    );
    shaft.position.y = 0.78;
    shaft.castShadow = true;
    shaft.receiveShadow = true;
    group.add(shaft);

    const corniceMesh = new THREE.Mesh(
      this.sharedGeos.keepCornice,
      this.creamStoneTrimMat
    );
    corniceMesh.position.y = 1.36;
    corniceMesh.receiveShadow = true;
    group.add(corniceMesh);

    const pitchedCap = new THREE.Mesh(
      this.sharedGeos.keepPitchedCap,
      this.crimsonKeepRoofMat
    );
    pitchedCap.position.y = 1.56;
    pitchedCap.castShadow = true;
    group.add(pitchedCap);

    const bowl = new THREE.Mesh(
      this.sharedGeos.keepBrazierBowl,
      this.darkBasaltMat
    );
    bowl.position.y = 1.72;
    group.add(bowl);

    const lanternMesh = new THREE.Mesh(
      this.sharedGeos.keepBrazierFlame,
      this.keepBrazierDormantMat
    );
    lanternMesh.position.y = 1.88;
    group.add(lanternMesh);

    return { group, keepIndex, lanternMesh, corniceMesh, gridX, gridY };
  }

  /**
   * Player Stone Wall (`BLOCK`):
   * Chamfered Square Ivory Turret (`h = 1.38m`) + 4 Corner Merlons + True Player-Color Square Emblem!
   */
  private buildWall3DMesh(
    towerId: string,
    x: number,
    y: number,
    playerColor = '#38bdf8',
    bornTime = performance.now()
  ): WallVisualEntry {
    const group = new THREE.Group();
    group.userData.towerId = towerId;

    const ao = new THREE.Mesh(this.sharedGeos.aoQuad, this.aoDiscMat);
    ao.position.y = 0.015;
    ao.renderOrder = 2;
    group.add(ao);

    const plinth = new THREE.Mesh(
      this.sharedGeos.pillarPlinth,
      this.plinthSandstoneMat
    );
    plinth.position.y = 0.11;
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    group.add(plinth);

    const shaft = new THREE.Mesh(
      this.sharedGeos.pillarShaft,
      this.ivoryShaftMat
    );
    shaft.position.y = 0.7;
    shaft.castShadow = true;
    shaft.receiveShadow = true;
    group.add(shaft);

    const cap = new THREE.Mesh(
      this.sharedGeos.pillarCapMerlons,
      this.creamCapMat
    );
    cap.receiveShadow = true;
    group.add(cap);

    const emblem = new THREE.Mesh(
      this.sharedGeos.pillarEmblem,
      this.getPlayerMedallionMaterial(playerColor)
    );
    emblem.position.y = 1.34;
    emblem.receiveShadow = true;
    group.add(emblem);

    return { group, born: bornTime, x, y };
  }

  // ==========================================================================
  // PRUNED CURTAIN BRIDGES, GOLD LEY-LINE CONDUITS & SYNERGY PREVIEWS
  // ==========================================================================

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

    if (!isGhost) {
      const ao = new THREE.Mesh(this.sharedGeos.bridgeAoQuad, this.aoDiscMat);
      ao.scale.z = spanLen;
      ao.position.y = 0.014;
      ao.renderOrder = 2;
      bridge.add(ao);
    }

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
    parapet.receiveShadow = !isGhost;
    if (isGhost) parapet.renderOrder = 10;
    bridge.add(parapet);

    return bridge;
  }

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
    cap.receiveShadow = true;
    keystone.add(cap);

    return keystone;
  }

  /**
   * Gabriel-Graph Pruning Rule (`gfx-models Spec 3`):
   * Suppress diagonal `(+-2, +-2)` or knight `(+-2, +-1)` bridges whenever a third wall/keep node `C`
   * forms a `>= 90°` elbow (`distSq(A,C) + distSq(C,B) <= distSq(A,B)`).
   * Eliminates 100% of L-corner walkable-cell cuts and `2x2` X-clump Z-fighting!
   */
  private shouldPruneNonOrthogonalBridge(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    nodes: ReadonlyArray<{ x: number; y: number }>
  ): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const isOrtho =
      (Math.abs(dx) === 2 && dy === 0) || (dx === 0 && Math.abs(dy) === 2);
    if (isOrtho) return false;

    const abSq = dx * dx + dy * dy;
    for (let k = 0; k < nodes.length; k++) {
      const c = nodes[k];
      if ((c.x === ax && c.y === ay) || (c.x === bx && c.y === by)) continue;
      const dACx = c.x - ax;
      const dACy = c.y - ay;
      if (Math.abs(dACx) > 2 || Math.abs(dACy) > 2) continue;
      const dCBx = bx - c.x;
      const dCBy = by - c.y;
      if (Math.abs(dCBx) > 2 || Math.abs(dCBy) > 2) continue;

      const acSq = dACx * dACx + dACy * dACy;
      const cbSq = dCBx * dCBx + dCBy * dCBy;
      if (acSq + cbSq <= abSq) {
        return true;
      }
    }
    return false;
  }

  private createLeyConduitMesh(
    fromCx: number,
    fromCz: number,
    toCx: number,
    toCz: number,
    mat: THREE.ShaderMaterial
  ): THREE.Mesh | null {
    const dx = toCx - fromCx;
    const dz = toCz - fromCz;
    const fullDist = Math.hypot(dx, dz);
    // Start at edge of Wall/Keep plinth (~0.74m) and end at edge of Spire plinth (~0.84m)
    const startInset = Math.min(0.74, fullDist * 0.35);
    const endInset = Math.min(0.84, fullDist * 0.38);
    const spanLen = fullDist - startInset - endInset;
    if (spanLen <= 0.08) return null;

    const ux = dx / fullDist;
    const uz = dz / fullDist;
    const mesh = new THREE.Mesh(this.sharedGeos.conduitQuad, mat);
    mesh.position.set(
      fromCx + ux * startInset,
      0.024,
      fromCz + uz * startInset
    );
    mesh.rotation.y = Math.atan2(dx, dz);
    mesh.scale.z = spanLen;
    mesh.renderOrder = 3;
    return mesh;
  }

  private populateSpireConduits(
    targetGroup: THREE.Group,
    links: SpireConduitLink[],
    offsetX: number,
    offsetZ: number,
    mat: THREE.ShaderMaterial
  ) {
    targetGroup.clear();
    for (const link of links) {
      const m = this.createLeyConduitMesh(
        offsetX + link.fromX + 1.0,
        offsetZ + link.fromY + 1.0,
        offsetX + link.spireX + 1.0,
        offsetZ + link.spireY + 1.0,
        mat
      );
      if (m) targetGroup.add(m);
    }
  }

  private applyKeepLinkVisuals(
    island: IslandVisuals,
    linkedIndices: Set<number>
  ) {
    island.ruinRigs.forEach((ruin, idx) => {
      const isLinked = linkedIndices.has(idx);
      ruin.lanternMesh.material = isLinked
        ? this.keepBrazierLinkedMat
        : this.keepBrazierDormantMat;
      ruin.corniceMesh.material = isLinked
        ? this.goldBridgeTrimMat
        : this.creamStoneTrimMat;
    });
  }

  private applySpireOverchargeVisuals(
    island: IslandVisuals,
    tiers: number[]
  ) {
    island.spireRigs.forEach((spireRig, idx) => {
      const tier = tiers[idx] || 0;
      const effectiveRange = spireRig.baseRange + tier * 0.25;
      spireRig.aoeMesh.scale.set(effectiveRange, 1, effectiveRange);
      spireRig.aoeMat.uniforms.uOverchargeTier.value = tier;

      spireRig.collarRimMesh.material =
        tier >= 1 ? this.collarRimGoldMat : this.collarRimInactiveMat;

      spireRig.overchargePips.forEach((pip, pipIdx) => {
        const active = pipIdx < tier;
        pip.material = active ? this.pipActiveGoldMat : this.pipInactiveMat;
        pip.scale.setScalar(active ? 1.15 : 0.88);
      });

      spireRig.groundTierArcs.forEach((arc, arcIdx) => {
        arc.material =
          arcIdx < tier ? this.groundArcGoldMat : this.groundArcInactiveMat;
      });
    });
  }

  private restoreIslandBaseSynergyVisuals(island: IslandVisuals) {
    if (
      island.playerId === this.localPlayerId &&
      this.cachedBaseEval &&
      this.cachedLocalCircuitry &&
      this.currentRoomState
    ) {
      this.populateClapMarkers(
        island,
        this.currentRoomState.roundConfig,
        this.cachedBaseEval.clapLocations
      );
      this.applyKeepLinkVisuals(
        island,
        this.cachedLocalCircuitry.linkedKeepIndices
      );
      this.applySpireOverchargeVisuals(
        island,
        this.cachedBaseEval.spireOverchargeTiers
      );
    }
  }

  private computeFallbackConduitLinks(
    round: RoundConfig,
    wallNodes: Array<{ x: number; y: number }>,
    circuitry: CitadelCircuitryResult
  ): SpireConduitLink[] {
    if (circuitry.spireConduitLinks) {
      return circuitry.spireConduitLinks;
    }
    const links: SpireConduitLink[] = [];
    const poweredKeys = circuitry.poweredNodeKeys;
    round.preplacedSpires.forEach((spire, spireIndex) => {
      const tier = circuitry.spireOverchargeTiers[spireIndex] || 0;
      if (tier <= 0) return;
      let bestNode: { x: number; y: number } | null = null;
      let bestD2 = Infinity;
      for (const n of wallNodes) {
        if (poweredKeys && !poweredKeys.has(`${n.x},${n.y}`)) continue;
        const dx = n.x - spire.x;
        const dy = n.y - spire.y;
        const d2 = dx * dx + dy * dy;
        if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3 && d2 <= 13 && d2 < bestD2) {
          bestD2 = d2;
          bestNode = n;
        }
      }
      if (bestNode) {
        links.push({
          spireIndex,
          spireX: spire.x,
          spireY: spire.y,
          fromX: bestNode.x,
          fromY: bestNode.y,
          overchargeTier: tier,
        });
      }
    });
    return links;
  }

  private rebuildAllDirectionalConnections(
    island: IslandVisuals,
    player: PlayerState,
    round: RoundConfig
  ) {
    island.bridgeGroup.clear();
    island.bridgeEntries = [];
    island.conduitGroup.clear();

    const now = performance.now();
    const circuitry =
      player.id === this.localPlayerId && this.cachedLocalCircuitry
        ? this.cachedLocalCircuitry
        : computeCitadelCircuitry(round, player.towers);

    interface WallMasonryNode {
      x: number;
      y: number;
      cx: number;
      cz: number;
      kind: 'PLAYER' | 'RUIN';
      born: number;
      keepIdx?: number;
    }

    // Spires NEVER emit solid stone walls — only PLAYER & RUIN nodes connect via masonry!
    const masonryNodes: WallMasonryNode[] = [
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
    ];

    const addBridgeEntry = (grp: THREE.Group, born: number) => {
      const ageSec = (now - born) / 1000;
      if (ageSec >= 0 && ageSec < 0.26) {
        grp.scale.set(1, evalToyBoxSpringScaleY(ageSec / 0.26), 1);
      }
      island.bridgeGroup.add(grp);
      island.bridgeEntries.push({ group: grp, born });
    };

    const poweredSet = circuitry.poweredNodeKeys;

    for (let i = 0; i < masonryNodes.length; i++) {
      const a = masonryNodes[i];
      for (let j = i + 1; j < masonryNodes.length; j++) {
        const b = masonryNodes[j];
        const dxGrid = b.x - a.x;
        const dzGrid = b.y - a.y;
        if (Math.abs(dxGrid) > 2 || Math.abs(dzGrid) > 2) continue;
        if (dxGrid === 0 && dzGrid === 0) continue;
        if (do2x2Overlap(a.x, a.y, b.x, b.y)) continue;

        if (
          this.shouldPruneNonOrthogonalBridge(a.x, a.y, b.x, b.y, masonryNodes)
        ) {
          continue;
        }

        const pairBorn = Math.max(a.born, b.born);
        const bothPowered =
          poweredSet !== undefined &&
          poweredSet.has(`${a.x},${a.y}`) &&
          poweredSet.has(`${b.x},${b.y}`);

        if (a.kind === 'PLAYER' && b.kind === 'PLAYER') {
          const span = this.createBridgeSpanSegment(
            a.cx,
            a.cz,
            b.cx,
            b.cz,
            0.0,
            1.0,
            this.bridgeWallMat,
            bothPowered ? this.goldBridgeTrimMat : this.creamCapMat,
            false
          );
          addBridgeEntry(span, pairBorn);
        } else if (a.kind === 'RUIN' && b.kind === 'RUIN') {
          const isLinked =
            (a.keepIdx !== undefined &&
              circuitry.linkedKeepIndices.has(a.keepIdx)) ||
            (b.keepIdx !== undefined &&
              circuitry.linkedKeepIndices.has(b.keepIdx));
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
        } else {
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
        }
      }
    }

    // Render flush ground inlaid gold ley-line conduits (`dx^2 + dy^2 <= 13`) into Overcharged Spires!
    const links = this.computeFallbackConduitLinks(
      round,
      masonryNodes,
      circuitry
    );
    this.populateSpireConduits(
      island.conduitGroup,
      links,
      0,
      0,
      island.conduitMat
    );

    this.applyKeepLinkVisuals(island, circuitry.linkedKeepIndices);
    this.applySpireOverchargeVisuals(island, circuitry.spireOverchargeTiers);
  }

  /**
   * Syncs an island's placed Stone Walls & path ribbon with in-place `opt_* -> twr_*`
   * reconciliation and signature dirty-checking (eliminating 500ms bot-tick hitches!).
   */
  private syncIslandTowersAndPath(
    island: IslandVisuals,
    player: PlayerState,
    round: RoundConfig,
    skipPopAnim = false
  ) {
    const isFogged = Boolean(player.fogMasked);
    island.fogVeilMesh.visible = isFogged;
    island.towerGroup.visible = !isFogged;
    island.bridgeGroup.visible = !isFogged;
    island.conduitGroup.visible = !isFogged;

    if (isFogged) {
      if (island.pathMesh) island.pathMesh.visible = false;
      island.clapMarkerGroup.clear();
      return;
    }

    // 1. Reconcile optimistic `opt_*` meshes in-place when server assigns authoritative `twr_*` ID!
    const incomingIds = new Set(player.towers.map((t) => t.id));
    const unmatchedIncoming = player.towers.filter(
      (t) => !island.towerMeshes.has(t.id)
    );

    for (const [tid, entry] of Array.from(island.towerMeshes.entries())) {
      if (!incomingIds.has(tid)) {
        const matchIdx = unmatchedIncoming.findIndex(
          (t) => t.x === entry.x && t.y === entry.y
        );
        if (matchIdx !== -1) {
          const matched = unmatchedIncoming.splice(matchIdx, 1)[0];
          island.towerMeshes.delete(tid);
          entry.group.userData.towerId = matched.id;
          island.towerMeshes.set(matched.id, entry);
        }
      }
    }

    // Signature check: skip redundant path/bridge rebuilds if `(x, y)` coordinates are unchanged!
    const coordSig = `${this.lastLayoutSignature}|${player.towers
      .map((t) => `${t.x},${t.y}`)
      .join(';')}`;
    if (coordSig === island.lastTowersSig && !skipPopAnim) {
      if (island.pathMesh) island.pathMesh.visible = true;
      return;
    }
    island.lastTowersSig = coordSig;

    // 2. Remove sold/cleared walls
    for (const [tid, entry] of Array.from(island.towerMeshes.entries())) {
      if (!incomingIds.has(tid)) {
        if (!skipPopAnim && island.root.visible) {
          this.spawnPlacementDustPuffs(
            island.offsetX + entry.x + 1.0,
            island.offsetZ + entry.y + 1.0,
            '#fda4af',
            5
          );
        }
        island.towerGroup.remove(entry.group);
        island.towerMeshes.delete(tid);
      }
    }

    // 3. Add newly built walls
    const now = performance.now();
    for (const tower of player.towers) {
      if (!island.towerMeshes.has(tower.id)) {
        const born = skipPopAnim ? now - 1000 : now;
        const entry = this.buildWall3DMesh(
          tower.id,
          tower.x,
          tower.y,
          player.color,
          born
        );
        entry.group.position.set(tower.x + 1.0, 0, tower.y + 1.0);
        if (!skipPopAnim) {
          const sY = 0.2;
          const sXZ = 1 / Math.sqrt(sY);
          entry.group.scale.set(sXZ, sY, sXZ);
          if (island.root.visible) {
            this.spawnPlacementDustPuffs(
              island.offsetX + tower.x + 1.0,
              island.offsetZ + tower.y + 1.0,
              '#f5efe4',
              5
            );
          }
        }
        island.towerGroup.add(entry.group);
        island.towerMeshes.set(tower.id, entry);
      }
    }

    this.rebuildAllDirectionalConnections(island, player, round);

    // 4. Update persistent flagstone path ribbon (disposing old geometry, keeping `island.pathMat`)
    if (island.pathMesh) {
      island.root.remove(island.pathMesh);
      island.pathMesh.geometry.dispose();
      island.pathMesh = null;
    }

    const pathRes: PathResult = computeFullMazePath(round, player.towers);
    if (pathRes.valid && pathRes.allPoints.length > 1) {
      const ribbonGeo = createFlatPathRibbonGeometry(
        pathRes.allPoints,
        0,
        0,
        0.025,
        0.15
      );
      island.pathMat.uniforms.uOpacity.value =
        this.currentRoomState?.phase === 'BUILD' ? 0.66 : 0.24;
      island.pathMesh = new THREE.Mesh(ribbonGeo, island.pathMat);
      island.pathMesh.renderOrder = 4;
      island.root.add(island.pathMesh);
    }

    if (player.id === this.localPlayerId && this.cachedBaseEval) {
      this.populateClapMarkers(island, round, this.cachedBaseEval.clapLocations);
    } else {
      island.clapMarkerGroup.clear();
    }
  }

  /**
   * Populates Spire-archetype colored ground clap pips (`#f59e0b` Storm, `#38bdf8` Frost, `#c084fc` Chrono)
   * over a dark `#1e293b` bezel, adding a crisp emerald gain halo ONLY on newly gained claps!
   */
  private populateClapMarkers(
    island: IslandVisuals,
    round: RoundConfig,
    locations: GridPoint[],
    baseLocations?: GridPoint[]
  ) {
    island.clapMarkerGroup.clear();

    for (let i = 0; i < locations.length; i++) {
      const loc = locations[i];
      const pipGroup = new THREE.Group();
      pipGroup.position.set(loc.x, 0.032, loc.y);

      // Identify closest Spire to tint the clap pip by elemental archetype
      let spireType: SpireType = 'THUNDERCLAP';
      let bestDist = Infinity;
      for (const s of round.preplacedSpires) {
        const d = Math.hypot(s.x + 1.0 - loc.x, s.y + 1.0 - loc.y);
        if (d < bestDist) {
          bestDist = d;
          spireType = s.spireType || 'THUNDERCLAP';
        }
      }

      const innerMat =
        spireType === 'FROST_OBELISK'
          ? this.clapPipFrostMat
          : spireType === 'CHRONO_SPIRE'
          ? this.clapPipChronoMat
          : this.clapPipStormMat;

      let isNewClap = false;
      if (baseLocations) {
        const matchInBase = baseLocations.some(
          (b) => Math.hypot(b.x - loc.x, b.y - loc.y) < 0.45
        );
        if (!matchInBase && locations.length > baseLocations.length) {
          isNewClap = true;
        }
      }

      if (isNewClap) {
        const halo = new THREE.Mesh(
          this.sharedGeos.clapPipHalo,
          this.clapPipGainHaloMat
        );
        halo.renderOrder = 6;
        pipGroup.add(halo);
      }

      const outer = new THREE.Mesh(
        this.sharedGeos.clapPipOuter,
        this.clapPipRimMat
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

  // ==========================================================================
  // RETICLE, REMOVE BRACKET, LIVE GHOST PREVIEW & WORLD FEATURE INSPECTION
  // ==========================================================================

  private setGhostTint(valid: boolean) {
    if (valid) {
      this.ghostBodyMat.color.set('#86efac');
      this.ghostBodyMat.emissive.set('#22c55e');
      this.ghostCapMat.color.set('#dcfce7');
      this.ghostCapMat.emissive.set('#4ade80');
    } else {
      this.ghostBodyMat.color.set('#fda4af');
      this.ghostBodyMat.emissive.set('#fb7185');
      this.ghostCapMat.color.set('#ffe4e6');
      this.ghostCapMat.emissive.set('#f43f5e');
    }
  }

  private computeBlockedSubCells(
    round: RoundConfig,
    towers: PlacedTower[],
    placeX: number,
    placeY: number,
    out: THREE.Vector4
  ) {
    const isSubBlocked = (cx: number, cy: number): number => {
      if (cx < 0 || cy < 0 || cx >= round.gridWidth || cy >= round.gridHeight) {
        return 1;
      }
      // Protected 2x1 gate mouths
      if (
        cy === 0 &&
        round.spawn.y === 0 &&
        cx >= round.spawn.x &&
        cx <= round.spawn.x + 1
      ) {
        return 1;
      }
      if (
        cy === round.gridHeight - 1 &&
        round.exit.y >= round.gridHeight - 2 &&
        cx >= round.exit.x &&
        cx <= round.exit.x + 1
      ) {
        return 1;
      }
      if (round.obstacles.some((o) => isCellIn2x2(cx, cy, o))) return 1;
      if (round.preplacedSpires.some((s) => isCellIn2x2(cx, cy, s))) return 1;
      if (towers.some((t) => isCellIn2x2(cx, cy, t))) return 1;
      return 0;
    };

    out.set(
      isSubBlocked(placeX, placeY),
      isSubBlocked(placeX + 1, placeY),
      isSubBlocked(placeX, placeY + 1),
      isSubBlocked(placeX + 1, placeY + 1)
    );
  }

  private showRemoveBracketVisuals(
    localIsland: IslandVisuals,
    tx: number,
    ty: number
  ) {
    this.hidePreviewPathMesh();
    this.clearPreviewConduits();
    this.ghostConnGroup.clear();

    // Hide 3D translucent ghost turret so it NEVER Z-fights over the existing wall!
    this.ghostGroup.visible = true;
    this.ghostTurretGroup.visible = false;
    this.ghostGroup.scale.set(1, 1, 1);
    this.ghostGroup.position.set(
      localIsland.offsetX + tx + 1.0,
      0,
      localIsland.offsetZ + ty + 1.0
    );

    this.reticlePadMat.uniforms.uMode.value = 3.0;
    this.reticlePadMat.uniforms.uBlockedCells.value.set(0, 0, 0, 0);
    this.reticlePadMat.uniforms.uBlocksPath.value = 0.0;

    localIsland.floorUniforms.uCursorPos.value.set(tx + 1.0, ty + 1.0);
    localIsland.floorUniforms.uAnchorBox.value.set(tx, ty, tx + 2.0, ty + 2.0);
    localIsland.floorUniforms.uReticleMode.value = 3.0;

    for (const sr of localIsland.spireRigs) {
      sr.targetHoverBoost = 0;
    }
    this.restoreIslandBaseSynergyVisuals(localIsland);
  }

  private hidePreviewPathMesh() {
    if (this.previewPathMesh) {
      this.scene.remove(this.previewPathMesh);
      this.previewPathMesh.geometry.dispose();
      this.previewPathMesh = null;
    }
  }

  private clearPreviewConduits() {
    this.previewConduitGroup.clear();
  }

  private hideDesktopHoverVisuals() {
    this.hoveredCell = null;
    this.hoveredExistingTower = null;
    this.lastHoverValid = false;
    this.cachedHoverPreview = null;
    this.ghostGroup.visible = false;
    this.ghostTurretGroup.visible = true;
    this.ghostConnGroup.clear();
    this.clearPreviewConduits();
    this.hidePreviewPathMesh();

    if (this.localPlayerId) {
      const localIsland = this.islands.get(this.localPlayerId);
      if (localIsland) {
        localIsland.floorUniforms.uCursorPos.value.set(-99, -99);
        localIsland.floorUniforms.uReticleMode.value = 0;
        for (const sr of localIsland.spireRigs) {
          sr.targetHoverBoost = 0;
        }
        this.restoreIslandBaseSynergyVisuals(localIsland);
      }
    }

    this.onHoverStatusChange?.({
      cell: null,
      screenX: this.lastPointerScreen.x,
      screenY: this.lastPointerScreen.y,
      valid: false,
    });
  }

  private buildGhostAndPathPreview(
    localIsland: IslandVisuals,
    localPlayer: PlayerState,
    round: RoundConfig,
    placeX: number,
    placeY: number,
    snapped = false
  ): CachedHoverPreview {
    const cacheKey = `${this.lastLocalEvalSig}|${localPlayer.gold}|${placeX},${placeY}|${snapped ? 1 : 0}`;
    if (this.cachedHoverPreview && this.cachedHoverPreview.key === cacheKey) {
      return this.cachedHoverPreview;
    }

    const hasGold = localPlayer.gold >= TOWER_SPECS.BLOCK.goldCost;
    const validation = validateTowerPlacement(
      round,
      localPlayer.towers,
      placeX,
      placeY
    );

    const isValid = hasGold && validation.valid;
    const reason = !hasGold ? 'No walls left' : validation.reason;
    const reasonCode = !hasGold ? 'NO_PILLARS' : validation.reasonCode;

    this.ghostGroup.visible = true;
    this.ghostTurretGroup.visible = true;
    this.ghostGroup.scale.set(1, 1, 1);
    this.ghostGroup.position.set(
      localIsland.offsetX + placeX + 1.0,
      0,
      localIsland.offsetZ + placeY + 1.0
    );
    this.setGhostTint(isValid);

    const blockedVec = this.reticlePadMat.uniforms.uBlockedCells
      .value as THREE.Vector4;
    if (!isValid) {
      this.computeBlockedSubCells(
        round,
        localPlayer.towers,
        placeX,
        placeY,
        blockedVec
      );
    } else {
      blockedVec.set(0, 0, 0, 0);
    }

    const allCellsClear =
      blockedVec.x === 0 &&
      blockedVec.y === 0 &&
      blockedVec.z === 0 &&
      blockedVec.w === 0;
    this.reticlePadMat.uniforms.uBlocksPath.value =
      !isValid && allCellsClear && reasonCode === 'BLOCKS_PATH' ? 1.0 : 0.0;

    this.ghostConnGroup.clear();
    this.clearPreviewConduits();
    this.hidePreviewPathMesh();

    let deltaTime = 0;
    let deltaClaps = 0;
    let deltaKeeps = 0;
    let deltaOvercharge = 0;
    let previewTime = this.cachedBaseEval?.finishTimeSeconds || 0;
    let joinsCircuit = false;

    if (isValid && validation.pathResult) {
      const testTowers: PlacedTower[] = [
        ...localPlayer.towers,
        { id: '__preview__', type: 'BLOCK', x: placeX, y: placeY, createdAt: 0 },
      ];
      const previewEval = evaluateMazeRunTime(round, testTowers, {
        precomputedPath: validation.pathResult,
        collectClapLocations: true,
      });
      const previewCircuitry = computeCitadelCircuitry(round, testTowers);

      joinsCircuit = Boolean(
        previewCircuitry.poweredNodeKeys?.has(`${placeX},${placeY}`)
      );

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
          previewEval.overchargedSpires -
          this.cachedBaseEval.overchargedSpires;
      }

      // Pruned ghost bridges (tinted radiant Sun-Gold when joining a Crimson Keep circuit!)
      const previewMasonryNodes = [
        ...localPlayer.towers.map((t) => ({ x: t.x, y: t.y })),
        ...round.obstacles.map((o) => ({ x: o.x, y: o.y })),
        { x: placeX, y: placeY },
      ];

      const ghostWallMat = joinsCircuit
        ? this.ghostGoldBodyMat
        : this.ghostBodyMat;
      const ghostTrimMat = joinsCircuit
        ? this.ghostGoldCapMat
        : this.ghostCapMat;

      for (const nb of previewMasonryNodes) {
        const dx = nb.x - placeX;
        const dz = nb.y - placeY;
        if (dx === 0 && dz === 0) continue;
        if (Math.abs(dx) > 2 || Math.abs(dz) > 2) continue;
        if (do2x2Overlap(placeX, placeY, nb.x, nb.y)) continue;
        if (
          this.shouldPruneNonOrthogonalBridge(
            placeX,
            placeY,
            nb.x,
            nb.y,
            previewMasonryNodes
          )
        ) {
          continue;
        }

        const fullDist = Math.hypot(dx, dz);
        const insetT = Math.min(0.42, 0.72 / fullDist);
        const previewBridge = this.createBridgeSpanSegment(
          0,
          0,
          dx,
          dz,
          insetT,
          1.0 - insetT,
          ghostWallMat,
          ghostTrimMat,
          true
        );
        this.ghostConnGroup.add(previewBridge);
      }

      // Preview Flagstone Path Ribbon (`#fef08a` sunlit gold-cream)
      if (validation.pathResult.allPoints.length > 1) {
        const ribbonGeo = createFlatPathRibbonGeometry(
          validation.pathResult.allPoints,
          localIsland.offsetX,
          localIsland.offsetZ,
          0.03,
          0.155
        );
        this.previewPathMesh = new THREE.Mesh(ribbonGeo, this.previewPathMat);
        this.previewPathMesh.renderOrder = 5;
        this.scene.add(this.previewPathMesh);
      }

      // Live Synergy Preview: light up newly linked Keep braziers, Spire Overcharge & gold ley-lines!
      const previewLinks = this.computeFallbackConduitLinks(
        round,
        previewMasonryNodes,
        previewCircuitry
      );
      this.populateSpireConduits(
        this.previewConduitGroup,
        previewLinks,
        localIsland.offsetX,
        localIsland.offsetZ,
        this.previewConduitMat
      );

      this.populateClapMarkers(
        localIsland,
        round,
        previewEval.clapLocations,
        this.cachedBaseEval?.clapLocations
      );
      this.applyKeepLinkVisuals(localIsland, previewCircuitry.linkedKeepIndices);
      this.applySpireOverchargeVisuals(
        localIsland,
        previewEval.spireOverchargeTiers
      );

      localIsland.spireRigs.forEach((sr, idx) => {
        const dist = Math.hypot(sr.gridX - placeX, sr.gridY - placeY);
        const baseTier = this.cachedBaseEval?.spireOverchargeTiers[idx] || 0;
        const newTier = previewEval.spireOverchargeTiers[idx] || 0;
        sr.targetHoverBoost =
          dist <= sr.baseRange + 2.8 || newTier > baseTier ? 1.0 : 0.0;
      });
    } else {
      this.restoreIslandBaseSynergyVisuals(localIsland);
      localIsland.spireRigs.forEach((sr) => {
        const dist = Math.hypot(sr.gridX - placeX, sr.gridY - placeY);
        sr.targetHoverBoost = dist <= sr.baseRange + 2.2 ? 1.0 : 0.0;
      });
    }

    const modeVal = !isValid
      ? 2.0
      : joinsCircuit || deltaKeeps > 0 || deltaOvercharge > 0
      ? 4.0
      : 1.0;
    this.reticlePadMat.uniforms.uMode.value = modeVal;

    localIsland.floorUniforms.uCursorPos.value.set(placeX + 1.0, placeY + 1.0);
    localIsland.floorUniforms.uAnchorBox.value.set(
      placeX,
      placeY,
      placeX + 2.0,
      placeY + 2.0
    );
    localIsland.floorUniforms.uReticleMode.value =
      modeVal === 4.0 ? 3.0 : modeVal;

    const result: CachedHoverPreview = {
      key: cacheKey,
      valid: isValid,
      snapped,
      reason,
      reasonCode,
      deltaTime,
      deltaClaps,
      deltaKeeps,
      deltaOvercharge,
      previewTime,
    };
    this.cachedHoverPreview = result;
    return result;
  }

  /**
   * Detects hover over Spires, Crimson Keeps, North/South Gates, or Runners on the focused island
   * (active in BOTH `BUILD` and `RUN` so players can inspect world features with zero clutter!).
   */
  private detectInspectedWorldFeature(
    island: IslandVisuals,
    player: PlayerState,
    round: RoundConfig,
    rawRelX: number,
    rawRelZ: number
  ): InspectedWorldFeature | null {
    if (player.fogMasked) return null;

    // 1. Check Runner proximity (`r <= 0.78m` around runner position)
    const rx = island.runner.root.position.x;
    const rz = island.runner.root.position.z;
    if (Math.hypot(rawRelX - rx, rawRelZ - rz) <= 0.78) {
      const sim = this.latestSimStates.get(player.id);
      const archetype = round.runnerType || 'SCOUT';
      const baseSpeed = sim?.baseSpeed ?? (archetype === 'OUTRIDER' ? 3.85 : archetype === 'JUGGERNAUT' ? 3.25 : archetype === 'HERALD' ? 3.55 : 3.5);
      const currentSpeed = sim ? Number(sim.currentSpeed.toFixed(2)) : baseSpeed;
      let statusLabel: string | undefined;
      if (sim) {
        if (sim.finished) statusLabel = 'Finished';
        else if (sim.clapSlowRemaining > 0 && sim.inPermafrostAura)
          statusLabel = 'Slow + Frost';
        else if (sim.clapSlowRemaining > 0) statusLabel = 'Slowed';
        else if (sim.inPermafrostAura || sim.inFrostMire) statusLabel = 'Chilled';
        else if (sim.hasTailwindMomentum || sim.inHasteRift)
          statusLabel = 'Tailwind Haste';
      }
      return {
        kind: 'RUNNER',
        playerId: player.id,
        archetype,
        currentSpeed,
        baseSpeed,
        statusLabel,
      };
    }

    const cx = Math.floor(rawRelX);
    const cy = Math.floor(rawRelZ);

    // 2. Check Elemental Spires
    for (let idx = 0; idx < round.preplacedSpires.length; idx++) {
      const s = round.preplacedSpires[idx];
      if (isCellIn2x2(cx, cy, s)) {
        const spireType: SpireType = s.spireType || 'THUNDERCLAP';
        const spec = TOWER_SPECS[spireType];
        const sim = this.latestSimStates.get(player.id);
        const simTower = sim?.towers[`spire_${idx}`];

        let tier = 0;
        let projectedOrLiveHits = 0;
        if (simTower) {
          tier = simTower.overchargeTier;
          projectedOrLiveHits = simTower.triggeredCount;
        } else if (player.id === this.localPlayerId && this.cachedBaseEval) {
          tier = this.cachedBaseEval.spireOverchargeTiers[idx] || 0;
          projectedOrLiveHits =
            this.cachedBaseEval.perSpireClaps[`spire_${idx}`] || 0;
        } else {
          const circ = computeCitadelCircuitry(round, player.towers);
          tier = circ.spireOverchargeTiers[idx] || 0;
        }

        const safeTier = Math.max(0, Math.min(3, tier));
        const effectiveRange = Number((spec.range + safeTier * 0.25).toFixed(2));
        const effectiveCooldown = Number(
          (spec.cooldown * (1 - OVERCHARGE_CDR[safeTier])).toFixed(2)
        );
        const auraSlowPercent =
          spec.auraSlowPercent !== undefined
            ? Number((spec.auraSlowPercent + safeTier * 0.02).toFixed(2))
            : undefined;

        return {
          kind: 'SPIRE',
          spireIndex: idx,
          spireType,
          x: s.x,
          y: s.y,
          overchargeTier: safeTier,
          effectiveRange,
          effectiveCooldown,
          slowPercent: spec.slowPercent,
          slowDuration: Number(
            (spec.slowDuration + safeTier * 0.2).toFixed(2)
          ),
          auraSlowPercent,
          cdrPulseSeconds: spec.cdrPulseSeconds,
          projectedOrLiveHits,
        };
      }
    }

    // 3. Check Crimson Keeps
    for (let idx = 0; idx < round.obstacles.length; idx++) {
      const o = round.obstacles[idx];
      if (isCellIn2x2(cx, cy, o)) {
        const circ =
          player.id === this.localPlayerId && this.cachedLocalCircuitry
            ? this.cachedLocalCircuitry
            : computeCitadelCircuitry(round, player.towers);
        return {
          kind: 'KEEP',
          keepIndex: idx,
          x: o.x,
          y: o.y,
          linked: circ.linkedKeepIndices.has(idx),
        };
      }
    }

    // 4. Check North Gate & South Shrine Aprons
    if (
      rawRelZ >= -1.6 &&
      rawRelZ <= 0.75 &&
      rawRelX >= round.spawn.x - 0.3 &&
      rawRelX <= round.spawn.x + 2.3
    ) {
      return {
        kind: 'GATE',
        gateType: 'SPAWN',
        x: round.spawn.x,
        y: round.spawn.y,
        parTimeSeconds: round.parTimeSeconds,
      };
    }

    if (
      rawRelZ >= round.gridHeight - 0.75 &&
      rawRelZ <= round.gridHeight + 1.6 &&
      rawRelX >= round.exit.x - 0.3 &&
      rawRelX <= round.exit.x + 2.3
    ) {
      return {
        kind: 'GATE',
        gateType: 'EXIT',
        x: round.exit.x,
        y: round.exit.y,
        parTimeSeconds: round.parTimeSeconds,
      };
    }

    return null;
  }

  private updateBuildHover(forceRefresh = false) {
    if (
      !this.currentRoomState ||
      this._modalOpen ||
      this.arenaOverviewMode ||
      this.mouseNDC.x < -9
    ) {
      this.hideDesktopHoverVisuals();
      return;
    }

    const focusPid = this.focusedPlayerId || this.localPlayerId;
    if (!focusPid) {
      this.hideDesktopHoverVisuals();
      return;
    }

    const focusedIsland = this.islands.get(focusPid);
    const focusedPlayer = this.currentRoomState.players.find(
      (p) => p.id === focusPid
    );
    if (!focusedIsland || !focusedPlayer) {
      this.hideDesktopHoverVisuals();
      return;
    }

    if (forceRefresh) {
      this.cachedHoverPreview = null;
    }

    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.mouseNDC, this.camera);
    const round = this.currentRoomState.roundConfig;
    const planeHit = this.intersectClampedBuildPlane(focusedIsland, round, 1.8);

    const isBuildOnLocal =
      this.currentRoomState.phase === 'BUILD' &&
      focusPid === this.localPlayerId &&
      this._activeTool !== 'PAN';

    // Non-build phases (RUN, RESULTS) or Spectating or PAN mode -> Feature Inspection Only!
    if (!isBuildOnLocal) {
      this.ghostGroup.visible = false;
      this.ghostConnGroup.clear();
      this.clearPreviewConduits();
      this.hidePreviewPathMesh();
      this.hoveredCell = null;
      this.hoveredExistingTower = null;
      this.lastHoverValid = false;
      focusedIsland.floorUniforms.uReticleMode.value = 0;

      if (!planeHit) {
        for (const sr of focusedIsland.spireRigs) sr.targetHoverBoost = 0;
        this.onHoverStatusChange?.({
          cell: null,
          screenX: this.lastPointerScreen.x,
          screenY: this.lastPointerScreen.y,
          valid: false,
        });
        return;
      }

      const inspected = this.detectInspectedWorldFeature(
        focusedIsland,
        focusedPlayer,
        round,
        planeHit.rawRelX,
        planeHit.rawRelZ
      );
      focusedIsland.spireRigs.forEach((sr, idx) => {
        sr.targetHoverBoost =
          inspected?.kind === 'SPIRE' && inspected.spireIndex === idx
            ? 1.0
            : 0.0;
      });

      this.onHoverStatusChange?.({
        cell: null,
        screenX: this.lastPointerScreen.x,
        screenY: this.lastPointerScreen.y,
        valid: false,
        inspectedFeature: inspected,
      });
      return;
    }

    // Local Island in BUILD Phase:
    // 1. 3D Mesh-First Raycast for existing player Stone Walls (zero cap parallax miss!)
    let existing = this.raycastExistingWallMesh(focusedIsland, focusedPlayer);
    if (!existing && planeHit) {
      const cx = Math.floor(planeHit.relX);
      const cy = Math.floor(planeHit.relZ);
      existing =
        focusedPlayer.towers.find((t) => isCellIn2x2(cx, cy, t)) || null;
    }
    this.hoveredExistingTower = existing;

    if (existing) {
      this.hoveredCell = { x: existing.x, y: existing.y };
      this.lastHoverValid = false;
      this.showRemoveBracketVisuals(focusedIsland, existing.x, existing.y);
      this.onHoverStatusChange?.({
        cell: { x: existing.x, y: existing.y },
        screenX: this.lastPointerScreen.x,
        screenY: this.lastPointerScreen.y,
        valid: true,
        reason: 'Remove (+1)',
        existingTower: existing,
      });
      return;
    }

    if (!planeHit) {
      this.hideDesktopHoverVisuals();
      return;
    }

    // 2. Check if cursor is directly over a Spire, Keep, Gate, or Runner -> Inspect instead of flashing red 'Occupied'!
    const inspected = this.detectInspectedWorldFeature(
      focusedIsland,
      focusedPlayer,
      round,
      planeHit.rawRelX,
      planeHit.rawRelZ
    );
    if (inspected) {
      this.hoveredCell = null;
      this.lastHoverValid = false;
      this.ghostGroup.visible = false;
      this.ghostConnGroup.clear();
      this.clearPreviewConduits();
      this.hidePreviewPathMesh();
      focusedIsland.floorUniforms.uCursorPos.value.set(-99, -99);
      focusedIsland.floorUniforms.uReticleMode.value = 0;
      this.restoreIslandBaseSynergyVisuals(focusedIsland);

      focusedIsland.spireRigs.forEach((sr, idx) => {
        sr.targetHoverBoost =
          inspected.kind === 'SPIRE' && inspected.spireIndex === idx
            ? 1.0
            : 0.0;
      });

      this.onHoverStatusChange?.({
        cell: null,
        screenX: this.lastPointerScreen.x,
        screenY: this.lastPointerScreen.y,
        valid: false,
        inspectedFeature: inspected,
      });
      return;
    }

    if (this._activeTool === 'SELL') {
      this.ghostGroup.visible = false;
      this.ghostConnGroup.clear();
      this.clearPreviewConduits();
      this.hidePreviewPathMesh();
      focusedIsland.floorUniforms.uCursorPos.value.set(
        planeHit.relX,
        planeHit.relZ
      );
      focusedIsland.floorUniforms.uReticleMode.value = 0;
      for (const sr of focusedIsland.spireRigs) sr.targetHoverBoost = 0;
      this.onHoverStatusChange?.({
        cell: null,
        screenX: this.lastPointerScreen.x,
        screenY: this.lastPointerScreen.y,
        valid: false,
      });
      return;
    }

    // 3. Smart 2x2 Obstacle-Aware Flush Snap (`mode: 'mouse'`) + Cell-Memoized Preview!
    if (
      planeHit.rawRelX < -0.45 ||
      planeHit.rawRelX > round.gridWidth + 0.45 ||
      planeHit.rawRelZ < -0.45 ||
      planeHit.rawRelZ > round.gridHeight + 0.45
    ) {
      this.hideDesktopHoverVisuals();
      return;
    }

    const smart = resolveSmart2x2Placement(
      round,
      focusedPlayer.towers,
      planeHit.relX,
      planeHit.relZ,
      { mode: 'mouse', availableGold: focusedPlayer.gold }
    );

    this.hoveredCell = { x: smart.x, y: smart.y };
    const preview = this.buildGhostAndPathPreview(
      focusedIsland,
      focusedPlayer,
      round,
      smart.x,
      smart.y,
      smart.snapped
    );
    this.lastHoverValid = preview.valid;

    this.onHoverStatusChange?.({
      cell: this.hoveredCell,
      screenX: this.lastPointerScreen.x,
      screenY: this.lastPointerScreen.y,
      valid: preview.valid,
      snapped: preview.snapped,
      reason: preview.reason,
      deltaTime: preview.deltaTime,
      deltaClaps: preview.deltaClaps,
      deltaKeeps: preview.deltaKeeps,
      deltaOvercharge: preview.deltaOvercharge,
      previewTime: preview.previewTime,
      existingTower: null,
    });
  }

  // ==========================================================================
  // BESPOKE SPIRE COMBAT VFX, RUNNER KINEMATICS & ZERO-THRASH WORLD LABELS
  // ==========================================================================

  public updateRunners(
    states: Map<string, RunnerSimState>,
    events: SimEvent[]
  ): void {
    this.latestSimStates = states;

    for (const ev of events) {
      const island = this.islands.get(ev.playerId);
      if (!island || !island.root.visible) continue;

      const sim = states.get(ev.playerId);

      if (ev.type === 'CLAP') {
        const spireType = ev.spireType || 'THUNDERCLAP';
        const tier = ev.overchargeTier || 0;
        const simTower = ev.towerId ? sim?.towers[ev.towerId] : undefined;
        const effectiveRange =
          simTower?.effectiveRange ??
          TOWER_SPECS[spireType].range + tier * 0.25;

        const worldSpireX = island.offsetX + ev.x;
        const worldSpireZ = island.offsetZ + ev.y;
        const targetRunnerX =
          island.offsetX + (ev.targetX ?? island.runner.root.position.x);
        const targetRunnerZ =
          island.offsetZ + (ev.targetY ?? island.runner.root.position.z);

        const isFocused =
          !this.arenaOverviewMode &&
          ev.playerId === (this.focusedPlayerId || this.localPlayerId);

        if (spireType === 'FROST_OBELISK') {
          // 6-Lobed Crystalline Glacial Hex-Nova (ZERO lightning bolt!)
          this.spawnFrostHexNovaEffect(
            worldSpireX,
            worldSpireZ,
            effectiveRange
          );
          if (isFocused) {
            this.spawnParticleBurst(
              worldSpireX,
              1.35,
              worldSpireZ,
              '#bae6fd',
              6
            );
          }
        } else if (spireType === 'CHRONO_SPIRE') {
          // Violet Temporal Implosion-Expansion Wave + Golden-Violet CDR Relay to Sibling Spires!
          this.spawnShockwaveEffect(
            worldSpireX,
            worldSpireZ,
            effectiveRange,
            '#c084fc'
          );
          for (const sibling of island.spireRigs) {
            const dist = Math.hypot(
              sibling.group.position.x - ev.x,
              sibling.group.position.z - ev.y
            );
            if (dist > 0.6) {
              sibling.cdrFlash = 1.0;
              this.spawnChronoRelayArc(
                worldSpireX,
                1.95,
                worldSpireZ,
                island.offsetX + sibling.group.position.x,
                1.35,
                island.offsetZ + sibling.group.position.z
              );
            } else {
              sibling.recoil = 1.0;
            }
          }
          if (isFocused) {
            this.spawnParticleBurst(
              worldSpireX,
              1.55,
              worldSpireZ,
              '#e9d5ff',
              6
            );
          }
        } else {
          // THUNDERCLAP: Tapered Golden-Electric Ribbon Arc + Exact Effective-Range Shockwave!
          this.spawnShockwaveEffect(
            worldSpireX,
            worldSpireZ,
            effectiveRange,
            '#f59e0b',
            targetRunnerX,
            targetRunnerZ
          );
          if (isFocused) {
            this.spawnParticleBurst(
              worldSpireX,
              1.6,
              worldSpireZ,
              '#fde68a',
              6
            );
          }
        }

        // Recoil triggering Spire
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

        // Iron Juggernaut Armor Deflect vs Overcharge Armor-Pierce Burst!
        if (ev.armoredResisted) {
          this.spawnShockwaveEffect(
            targetRunnerX,
            targetRunnerZ,
            0.95,
            '#94a3b8'
          );
        } else if (
          tier >= 1 &&
          island.runner.archetype === 'JUGGERNAUT'
        ) {
          this.spawnShockwaveEffect(
            targetRunnerX,
            targetRunnerZ,
            1.15,
            '#fbbf24'
          );
        }
      } else if (ev.type === 'CHECKPOINT') {
        this.spawnShockwaveEffect(
          island.offsetX + ev.x,
          island.offsetZ + ev.y,
          2.0,
          '#10b981'
        );
      } else if (ev.type === 'WAYGATE') {
        this.spawnShockwaveEffect(
          island.offsetX + ev.x,
          island.offsetZ + ev.y,
          2.2,
          '#a855f7'
        );
      } else if (ev.type === 'FINISH') {
        this.spawnShockwaveEffect(
          island.offsetX + ev.x,
          island.offsetZ + ev.y,
          2.6,
          '#38bdf8'
        );
        if (
          !this.arenaOverviewMode &&
          ev.playerId === (this.focusedPlayerId || this.localPlayerId)
        ) {
          this.spawnParticleBurst(
            island.offsetX + ev.x,
            1.0,
            island.offsetZ + ev.y,
            '#7dd3fc',
            10
          );
        }
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

      if (!sim.finished) {
        let targetYaw = r.currentYaw;
        if (distMoved > 0.0005) {
          targetYaw = Math.atan2(moveDx, moveDz);
        }
        let diff = targetYaw - r.currentYaw;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        r.currentYaw += diff * 0.26;
        r.root.rotation.y = r.currentYaw;

        const bankAngle = Math.max(-0.3, Math.min(0.3, -diff * 1.5));
        r.pelvis.rotation.z = bankAngle;

        // Advance walk stride smoothly proportional to real spatial displacement
        r.walkPhase += Math.min(0.45, distMoved * 4.4);
        const swing = Math.sin(r.walkPhase) * 0.62;
        r.leftLeg.rotation.x = swing;
        r.rightLeg.rotation.x = -swing;

        if (r.archetype === 'JUGGERNAUT') {
          r.leftArm.rotation.x = 0.28 - swing * 0.16;
          r.rightArm.rotation.x = swing * 0.54;
        } else if (r.archetype === 'OUTRIDER') {
          r.leftArm.rotation.x = -swing * 0.7;
          r.rightArm.rotation.x = swing * 0.14;
          if (r.pennantMesh) {
            r.pennantMesh.rotation.y = Math.sin(r.walkPhase * 1.6) * 0.24;
          }
        } else {
          r.leftArm.rotation.x = -swing * 0.7;
          r.rightArm.rotation.x = swing * 0.46;
        }

        // Wind Herald dynamic wing flare during Tailwind Haste!
        if (r.leftWing && r.rightWing) {
          const haste = sim.hasTailwindMomentum;
          r.leftWing.rotation.y = haste ? -0.82 : -0.42;
          r.rightWing.rotation.y = haste ? 0.82 : 0.42;
          r.leftWing.scale.setScalar(haste ? 1.22 : 1.0);
          r.rightWing.scale.setScalar(haste ? 1.22 : 1.0);
          const wMat = r.leftWing.material as THREE.MeshStandardMaterial;
          wMat.emissiveIntensity = haste ? 0.75 : 0.28;
        }

        r.pelvis.position.y = 0.45 + Math.abs(Math.sin(r.walkPhase)) * 0.11;
        r.pelvis.rotation.x = sim.hasTailwindMomentum ? 0.22 : 0.12;
      } else {
        // Calm victorious idle pose facing camera (zero dizzying endless spin!)
        r.pelvis.position.y =
          0.54 + Math.sin(performance.now() * 0.005) * 0.05;
        r.pelvis.rotation.x = 0;
        r.pelvis.rotation.z = 0;
        r.leftLeg.rotation.x = 0;
        r.rightLeg.rotation.x = 0;
        r.currentYaw += (0 - r.currentYaw) * 0.15;
        r.root.rotation.y = r.currentYaw;
      }

      // Dual-Status Segmented Ground Ring (shows stacked Slow + Frost simultaneously!)
      const activeColors: string[] = [];
      if (sim.clapSlowRemaining > 0) activeColors.push('#f59e0b');
      if (sim.inPermafrostAura || sim.inFrostMire) activeColors.push('#38bdf8');
      if (sim.hasTailwindMomentum) activeColors.push('#34d399');
      if (sim.inHasteRift) activeColors.push('#fb7185');

      r.statusRing.visible = !sim.finished && activeColors.length > 0;
      if (activeColors.length > 0) {
        r.statusRingMat.uniforms.uColorA.value.set(activeColors[0]);
        r.statusRingMat.uniforms.uColorB.value.set(
          activeColors[1] || activeColors[0]
        );
        r.statusRingMat.uniforms.uDual.value =
          activeColors.length >= 2 ? 1.0 : 0.0;
      }

      if (r.accentMesh) {
        const accentMat = r.accentMesh.material as THREE.MeshBasicMaterial;
        accentMat.color.set(
          activeColors[0] ||
            (r.archetype === 'HERALD' ? '#34d399' : '#38bdf8')
        );
      }

      // Drive Spire base cooldown rings
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

      this.syncRunnerAndOverviewBadges(playerId, island, sim);
    }
  }

  private spawnPlacementDustPuffs(
    worldX: number,
    worldZ: number,
    colorHex: string,
    count = 5
  ) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const vels = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
      const startR = 0.68 + Math.random() * 0.14;
      pos[i * 3] = worldX + Math.cos(ang) * startR;
      pos[i * 3 + 1] = 0.12 + Math.random() * 0.06;
      pos[i * 3 + 2] = worldZ + Math.sin(ang) * startR;

      const outSpeed = 1.05 + Math.random() * 0.45;
      vels[i * 3] = Math.cos(ang) * outSpeed;
      vels[i * 3 + 1] = 0.65 + Math.random() * 0.35;
      vels[i * 3 + 2] = Math.sin(ang) * outSpeed;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: colorHex,
      map: this.softCircleSpriteTex,
      size: 0.42,
      transparent: true,
      opacity: 0.68,
      alphaTest: 0.01,
      depthWrite: false,
    });

    const points = new THREE.Points(geo, mat);
    points.renderOrder = 11;
    this.scene.add(points);
    this.particleBursts.push({
      points,
      velocities: vels,
      gravity: 1.5,
      baseOpacity: 0.68,
      age: 0,
      maxAge: 0.38,
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
      pos[i * 3] = worldX + (Math.random() - 0.5) * 0.3;
      pos[i * 3 + 1] = worldY + Math.random() * 0.2;
      pos[i * 3 + 2] = worldZ + (Math.random() - 0.5) * 0.3;

      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const speed = 1.2 + Math.random() * 2.0;
      vels[i * 3] = Math.cos(angle) * speed;
      vels[i * 3 + 1] = 1.5 + Math.random() * 1.6;
      vels[i * 3 + 2] = Math.sin(angle) * speed;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: colorHex,
      map: this.softCircleSpriteTex,
      size: 0.3,
      transparent: true,
      opacity: 0.88,
      alphaTest: 0.01,
      depthWrite: false,
    });

    const points = new THREE.Points(geo, mat);
    points.renderOrder = 11;
    this.scene.add(points);
    this.particleBursts.push({
      points,
      velocities: vels,
      gravity: 5.2,
      baseOpacity: 0.88,
      age: 0,
      maxAge: 0.48,
    });
  }

  private spawnShockwaveEffect(
    worldX: number,
    worldZ: number,
    maxRadius: number,
    colorHex: string,
    arcTargetX?: number,
    arcTargetZ?: number
  ) {
    const ringMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.sharedGeos.shockwaveRing, ringMat);
    mesh.position.set(worldX, 0.045, worldZ);
    mesh.renderOrder = 9;
    this.scene.add(mesh);

    let arcMesh: THREE.Mesh | undefined;
    if (arcTargetX !== undefined && arcTargetZ !== undefined) {
      const start = new THREE.Vector3(worldX, 2.18, worldZ);
      const end = new THREE.Vector3(arcTargetX, 0.88, arcTargetZ);
      const arcGeo = createTaperedArcRibbonGeometry(
        start,
        end,
        0.22,
        0.26,
        6,
        0.085,
        0.025
      );
      const arcMat = new THREE.MeshBasicMaterial({
        color: '#fef08a',
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      arcMesh = new THREE.Mesh(arcGeo, arcMat);
      arcMesh.renderOrder = 10;
      this.scene.add(arcMesh);
    }

    this.shockwaves.push({
      mesh,
      arcMesh,
      age: 0,
      maxAge: 0.46,
      startRadius: 0.42,
      maxRadius,
      isShaderMat: false,
    });
  }

  private spawnFrostHexNovaEffect(
    worldX: number,
    worldZ: number,
    maxRadius: number
  ) {
    const novaMat = createFrostHexNovaShader();
    const mesh = new THREE.Mesh(this.sharedGeos.unitCirclePlane, novaMat);
    mesh.position.set(worldX, 0.048, worldZ);
    mesh.renderOrder = 9;
    this.scene.add(mesh);

    this.shockwaves.push({
      mesh,
      age: 0,
      maxAge: 0.52,
      startRadius: 0.5,
      maxRadius,
      isShaderMat: true,
    });
  }

  private spawnChronoRelayArc(
    sx: number,
    sy: number,
    sz: number,
    tx: number,
    ty: number,
    tz: number
  ) {
    const start = new THREE.Vector3(sx, sy, sz);
    const end = new THREE.Vector3(tx, ty, tz);
    const geo = createTaperedArcRibbonGeometry(
      start,
      end,
      1.35,
      0.0,
      12,
      0.07,
      0.035
    );
    const mat = new THREE.MeshBasicMaterial({
      color: '#e9d5ff',
      transparent: true,
      opacity: 0.88,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 10;
    this.scene.add(mesh);
    this.relayArcs.push({ mesh, age: 0, maxAge: 0.38 });
  }

  // ==========================================================================
  // ZERO-THRASH PERSISTENT DOM BADGES (`#world-labels`)
  // ==========================================================================

  private createIslandDOMElements(player: PlayerState) {
    const header = document.createElement('div');
    header.className = 'island-3d-badge';
    header.style.setProperty('--player-color', player.color);
    header.style.pointerEvents = 'auto';
    header.style.cursor = 'pointer';
    header.style.display = 'none';

    const dot = document.createElement('span');
    dot.className = 'badge-dot';
    dot.style.background = player.color;

    const nameStrong = document.createElement('strong');
    nameStrong.textContent = player.name;

    const meta = document.createElement('span');
    meta.className = 'badge-meta';

    header.append(dot, nameStrong, meta);

    header.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    header.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.dismissTransientUI?.()) return;
      this.cancelTouchGhost();
      this.focusOnPlayerIsland(player.id);
      this.onFocusChange?.();
    });
    this.labelLayer.appendChild(header);
    this.islandBadges.set(player.id, {
      root: header,
      dot,
      name: nameStrong,
      meta,
      lastColor: player.color,
      lastName: player.name,
      lastMeta: '',
      visible: false,
    });

    const runnerRoot = document.createElement('div');
    runnerRoot.className = 'runner-3d-badge';
    runnerRoot.style.setProperty('--player-color', player.color);
    runnerRoot.style.display = 'none';

    const rDot = document.createElement('span');
    rDot.className = 'badge-dot';

    const rTag = document.createElement('span');
    rTag.style.marginRight = '4px';
    rTag.style.opacity = '0.92';

    const rTime = document.createElement('span');
    runnerRoot.append(rDot, rTag, rTime);

    this.labelLayer.appendChild(runnerRoot);
    this.runnerBadges.set(player.id, {
      root: runnerRoot,
      dot: rDot,
      tag: rTag,
      time: rTime,
      lastDotColor: '',
      lastTag: '',
      lastTime: '',
      visible: false,
    });
  }

  private updateIslandHeaderBadge(player: PlayerState, island: IslandVisuals) {
    const refs = this.islandBadges.get(player.id);
    if (!refs) return;

    if (refs.lastColor !== player.color) {
      refs.lastColor = player.color;
      refs.root.style.setProperty('--player-color', player.color);
      refs.dot.style.background = player.color;
    }

    const displayName = player.isBot ? `${player.name} · BOT` : player.name;
    if (refs.lastName !== displayName) {
      refs.lastName = displayName;
      refs.name.textContent = displayName;
    }

    let metaText: string;
    if (this.currentRoomState?.phase === 'RUN' && island.lastSimTimeText) {
      metaText = island.lastSimStatus
        ? `${island.lastSimTimeText} · ${island.lastSimStatus}`
        : island.lastSimTimeText;
    } else if (player.fogMasked) {
      metaText = player.ready ? 'Hidden · Ready' : 'Hidden';
    } else {
      const distStr = `${player.pathDistance.toFixed(0)}m`;
      metaText =
        this.currentRoomState?.phase === 'BUILD' && player.ready
          ? `${distStr} · Ready`
          : distStr;
    }

    if (refs.lastMeta !== metaText) {
      refs.lastMeta = metaText;
      refs.meta.textContent = metaText;
    }
  }

  /**
   * Dirty-checked Runner status tag (`0` innerHTML wipes, `0` floating `x4` confusion!).
   * In `arenaOverviewMode`, folds live runner status into `.island-3d-badge` so 12 pills never collide!
   */
  private syncRunnerAndOverviewBadges(
    playerId: string,
    island: IslandVisuals,
    sim: RunnerSimState
  ) {
    let statusText = '';
    let dotColor = '';
    if (sim.finished) {
      statusText = 'Done';
      dotColor = '#34d399';
    } else if (sim.clapSlowRemaining > 0 && sim.inPermafrostAura) {
      statusText = 'Slow + Frost';
      dotColor = '#38bdf8';
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

    const liveSec = sim.elapsedSeconds ?? sim.distanceTraveled / sim.baseSpeed;
    const timeVal = sim.finished
      ? `${sim.finishTimeSeconds.toFixed(2)}s`
      : `${liveSec.toFixed(1)}s`;

    island.lastSimStatus = statusText;
    island.lastSimTimeText = timeVal;

    const player = this.currentRoomState?.players.find(
      (p) => p.id === playerId
    );
    if (player && this.arenaOverviewMode) {
      this.updateIslandHeaderBadge(player, island);
    }

    const refs = this.runnerBadges.get(playerId);
    if (!refs) return;

    if (refs.lastTag !== statusText) {
      refs.lastTag = statusText;
      refs.tag.textContent = statusText;
      refs.dot.style.display = statusText ? 'inline-block' : 'none';
      refs.tag.style.display = statusText ? 'inline' : 'none';
    }
    if (dotColor && refs.lastDotColor !== dotColor) {
      refs.lastDotColor = dotColor;
      refs.dot.style.background = dotColor;
    }
    if (refs.lastTime !== timeVal) {
      refs.lastTime = timeVal;
      refs.time.textContent = timeVal;
    }
  }

  private setBadgeScreenTransform(
    worldX: number,
    worldY: number,
    worldZ: number,
    el: HTMLElement,
    wasVisible: boolean
  ): boolean {
    this._tmpProj.set(worldX, worldY, worldZ).project(this.camera);
    if (this._tmpProj.z > 1) {
      if (wasVisible) el.style.display = 'none';
      return false;
    }
    const x = this.viewportLeft + (this._tmpProj.x * 0.5 + 0.5) * this.viewportW;
    const y = this.viewportTop + (-this._tmpProj.y * 0.5 + 0.5) * this.viewportH;
    if (!wasVisible) el.style.display = 'flex';
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
    return true;
  }

  // ==========================================================================
  // 60FPS RENDER LOOP (ISLAND CULLING, ROLLING DPR GOVERNOR & EDGE AUTO-PAN)
  // ==========================================================================

  public renderFrame(dt: number): void {
    const safeDt = Math.min(0.1, Math.max(0.0001, dt));
    const now = performance.now();
    const uTimeVal = now * 0.001;
    const isBuildPhase = this.currentRoomState?.phase === 'BUILD';
    const isRunPhase = this.currentRoomState?.phase === 'RUN';

    // Rolling 90-frame FPS governor: step DPR down gracefully if sustained frame > 21ms
    this.fpsAccumDt += safeDt;
    this.fpsFrameCount++;
    if (this.fpsFrameCount >= 90) {
      const avgMs = (this.fpsAccumDt / this.fpsFrameCount) * 1000;
      if (avgMs > 21.5 && this.dprScaleCap > 0.72) {
        this.dprScaleCap = Math.max(0.7, this.dprScaleCap - 0.15);
        this.renderer.setPixelRatio(this.computeAdaptivePixelRatio());
      }
      this.fpsAccumDt = 0;
      this.fpsFrameCount = 0;
    }

    this.voidSeaMat.uniforms.uTime.value = uTimeVal;
    this.reticlePadMat.uniforms.uTime.value = uTimeVal;
    this.previewPathMat.uniforms.uTime.value = uTimeVal;
    this.previewConduitMat.uniforms.uTime.value = uTimeVal;

    // Keyboard camera panning (disabled cleanly when `modalOpen === true`)
    if (!this._modalOpen && this.keysDown.size > 0) {
      const moveForward =
        (this.keysDown.has('arrowup') || this.keysDown.has('w') ? 1 : 0) -
        (this.keysDown.has('arrowdown') || this.keysDown.has('s') ? 1 : 0);
      const moveRight =
        (this.keysDown.has('arrowright') || this.keysDown.has('d') ? 1 : 0) -
        (this.keysDown.has('arrowleft') || this.keysDown.has('a') ? 1 : 0);
      if (moveForward !== 0 || moveRight !== 0) {
        const panSpeed = 24 * safeDt;
        const sinAz = Math.sin(this.camAzimuth);
        const cosAz = Math.cos(this.camAzimuth);
        this.camGoalTarget.x +=
          (-sinAz * moveForward + cosAz * moveRight) * panSpeed;
        this.camGoalTarget.z +=
          (-cosAz * moveForward - sinAz * moveRight) * panSpeed;
        this.clampCameraTarget();
      }
    }

    // Viewport-Edge Auto-Pan during Mobile Loupe Ghost Drag!
    if (this.isLoupeDragging && this.activeTouches.size === 1) {
      const touch = Array.from(this.activeTouches.values())[0];
      const edgeZone = 44;
      let edgeVx = 0;
      let edgeVz = 0;
      if (touch.x < edgeZone) edgeVx = -1;
      else if (touch.x > this.viewportW - edgeZone) edgeVx = 1;

      const topEdge = this.hudSafeTopPx + 36;
      const botEdge = this.viewportH - this.hudSafeBottomPx - 42;
      if (touch.y < topEdge) edgeVz = -1;
      else if (touch.y > botEdge) edgeVz = 1;

      if ((edgeVx !== 0 || edgeVz !== 0) && this.camRadius < 74) {
        const speed = 10.5 * safeDt;
        this.camGoalTarget.x += edgeVx * speed;
        this.camGoalTarget.z += edgeVz * speed;
        this.clampCameraTarget();
        this.updateLoupeDragAtScreen(touch.x, touch.y, false);
      }
    }

    const lerpFactor = Math.min(1, safeDt * 9.5);
    this.camTarget.lerp(this.camGoalTarget, lerpFactor);
    this.camRadius += (this.camGoalRadius - this.camRadius) * lerpFactor;
    this.camPolar += (this.camGoalPolar - this.camPolar) * lerpFactor;
    this.camAzimuth += (this.camGoalAzimuth - this.camAzimuth) * lerpFactor;

    let shakeX = 0;
    let shakeY = 0;
    if (this.cameraShake > 0.001) {
      shakeX = (Math.random() - 0.5) * this.cameraShake;
      shakeY = (Math.random() - 0.5) * this.cameraShake;
      this.cameraShake = Math.max(0, this.cameraShake - safeDt * 0.9);
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
    this.camera.updateMatrixWorld();

    this.updateSunShadowFrustum();

    // Keep mobile touch micro-tag anchored smoothly above/below 3D ghost during pan/zoom
    if (this.activeTouchHoverInfo && isBuildPhase) {
      const proj = this.projectWorldToScreen(this.touchWorldAnchor);
      const isGestureMoving =
        this.activeTouches.size > 0 &&
        this.touchGestureMoved &&
        !this.isLoupeDragging;
      const offscreen = this.isTouchProjectionOffscreen(proj);
      const cellY = this.activeTouchHoverInfo.cell?.y ?? 10;
      const placeNearTopEdge =
        proj.y < this.hudSafeTopPx + 108 || cellY <= 3;

      if (
        Math.hypot(
          proj.x - this.activeTouchHoverInfo.screenX,
          proj.y - this.activeTouchHoverInfo.screenY
        ) > 1.2 ||
        this.activeTouchHoverInfo.isGestureMoving !== isGestureMoving ||
        this.activeTouchHoverInfo.isLoupeDragging !== this.isLoupeDragging ||
        this.activeTouchHoverInfo.offscreen !== offscreen ||
        this.activeTouchHoverInfo.placeNearTopEdge !== placeNearTopEdge
      ) {
        this.activeTouchHoverInfo.screenX = proj.x;
        this.activeTouchHoverInfo.screenY = proj.y;
        this.activeTouchHoverInfo.isGestureMoving = isGestureMoving;
        this.activeTouchHoverInfo.isLoupeDragging = this.isLoupeDragging;
        this.activeTouchHoverInfo.offscreen = offscreen;
        this.activeTouchHoverInfo.placeNearTopEdge = placeNearTopEdge;
        this.onHoverStatusChange?.(this.activeTouchHoverInfo);
      }
    }

    const gw = this.currentRoomState?.roundConfig.gridWidth || 20;
    const gh = this.currentRoomState?.roundConfig.gridHeight || 26;
    const focusedPid = this.focusedPlayerId || this.localPlayerId;

    for (const island of this.islands.values()) {
      // Off-screen rival island culling when focused (`!arenaOverviewMode`): cuts traversal & draw calls by ~80%!
      const islCenterX = island.offsetX + gw * 0.5;
      const islCenterZ = island.offsetZ + gh * 0.5;
      const distToCamTarget = Math.hypot(
        islCenterX - this.camTarget.x,
        islCenterZ - this.camTarget.z
      );
      const shouldBeVisible =
        this.arenaOverviewMode ||
        island.playerId === focusedPid ||
        distToCamTarget < 34;

      island.root.visible = shouldBeVisible;

      const iBadge = this.islandBadges.get(island.playerId);
      const rBadge = this.runnerBadges.get(island.playerId);

      if (!shouldBeVisible) {
        if (iBadge && iBadge.visible) {
          iBadge.root.style.display = 'none';
          iBadge.visible = false;
        }
        if (rBadge && rBadge.visible) {
          rBadge.root.style.display = 'none';
          rBadge.visible = false;
        }
        continue;
      }

      island.floorUniforms.uTime.value = uTimeVal;
      const isFogged = island.fogVeilMesh.visible;
      const goalBuildAlpha = isBuildPhase && !isFogged ? 1.0 : 0.0;
      const currBuildAlpha = island.floorUniforms.uBuildAlpha.value;
      island.floorUniforms.uBuildAlpha.value =
        currBuildAlpha +
        (goalBuildAlpha - currBuildAlpha) * Math.min(1, safeDt * 6.5);

      island.foamMat.uniforms.uTime.value = uTimeVal;
      island.conduitMat.uniforms.uTime.value = uTimeVal;

      if (island.pathMesh && !isFogged) {
        island.pathMat.uniforms.uTime.value = uTimeVal;
        const targetPathOpacity = isBuildPhase
          ? island.playerId === this.localPlayerId &&
            this.previewPathMesh !== null
            ? 0.14
            : 0.66
          : 0.24;
        const currOp = island.pathMat.uniforms.uOpacity.value;
        island.pathMat.uniforms.uOpacity.value =
          currOp + (targetPathOpacity - currOp) * Math.min(1, safeDt * 10.0);
      }

      island.clapMarkerGroup.visible = Boolean(isBuildPhase && !isFogged);

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

      for (const spireRig of island.spireRigs) {
        const targetRingAlpha = isBuildPhase
          ? 0.28 + spireRig.targetHoverBoost * 0.36
          : 0.16;
        const currRingAlpha = spireRig.aoeMat.uniforms.uRingAlpha.value;
        spireRig.aoeMat.uniforms.uRingAlpha.value =
          currRingAlpha +
          (targetRingAlpha - currRingAlpha) * Math.min(1, safeDt * 10.0);

        spireRig.cooldownRingMesh.visible = Boolean(isRunPhase);

        if (spireRig.recoil > 0) {
          spireRig.recoil = Math.max(0, spireRig.recoil - safeDt * 3.0);
        }
        if (spireRig.cdrFlash > 0) {
          spireRig.cdrFlash = Math.max(0, spireRig.cdrFlash - safeDt * 2.4);
          spireRig.cooldownRingMat.uniforms.uCdrFlash.value = spireRig.cdrFlash;
        }

        if (spireRig.spireType === 'CHRONO_SPIRE') {
          spireRig.upperCore.position.y =
            spireRig.baseCoreY +
            Math.sin(uTimeVal * 2.3) * 0.05 -
            spireRig.recoil * 0.16;
          spireRig.upperCore.rotation.y = uTimeVal * 0.45;
        } else {
          spireRig.upperCore.position.y =
            spireRig.baseCoreY - spireRig.recoil * 0.12;
        }
      }

      if (isBuildPhase) {
        island.runner.pelvis.position.y =
          0.45 + Math.sin(uTimeVal * 2.6) * 0.035;
        island.runner.statusRing.visible = false;
      }

      // Island Header Badge: hidden on focused island in BUILD/RUN to keep field clean; shown in Overview!
      if (iBadge) {
        const showIslandHeader =
          this.arenaOverviewMode || island.playerId !== focusedPid;
        if (!showIslandHeader) {
          if (iBadge.visible) {
            iBadge.root.style.display = 'none';
            iBadge.visible = false;
          }
        } else {
          iBadge.visible = this.setBadgeScreenTransform(
            islCenterX,
            2.15,
            island.offsetZ - 1.35,
            iBadge.root,
            iBadge.visible
          );
        }
      }

      // Runner Badge: shown ONLY on the focused island during RUN (Overview folds status into `.island-3d-badge`!)
      if (rBadge) {
        const showRunnerBadge =
          Boolean(isRunPhase) &&
          !this.arenaOverviewMode &&
          island.playerId === focusedPid &&
          Boolean(island.lastSimStatus || island.runner.statusRing.visible === false);
        const shouldShowCompact =
          showRunnerBadge &&
          (island.lastSimStatus !== '' ||
            this.latestSimStates.get(island.playerId)?.finished === true);

        if (!shouldShowCompact) {
          if (rBadge.visible) {
            rBadge.root.style.display = 'none';
            rBadge.visible = false;
          }
        } else {
          rBadge.visible = this.setBadgeScreenTransform(
            island.offsetX + island.runner.root.position.x,
            1.92,
            island.offsetZ + island.runner.root.position.z,
            rBadge.root,
            rBadge.visible
          );
        }
      }
    }

    // Update Ground Shockwaves, Frost Hex-Novas & Electric Arc Ribbons
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.age += safeDt;
      if (sw.age >= sw.maxAge) {
        this.scene.remove(sw.mesh);
        (sw.mesh.material as THREE.Material).dispose();
        if (sw.arcMesh) {
          this.scene.remove(sw.arcMesh);
          sw.arcMesh.geometry.dispose();
          (sw.arcMesh.material as THREE.Material).dispose();
        }
        this.shockwaves.splice(i, 1);
      } else {
        const t = sw.age / sw.maxAge;
        const ease = 1 - Math.pow(1 - t, 3);
        const rad = sw.startRadius + ease * (sw.maxRadius - sw.startRadius);
        sw.mesh.scale.set(rad, 1, rad);
        if (sw.isShaderMat) {
          (sw.mesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value =
            (1 - t) * 0.86;
        } else {
          (sw.mesh.material as THREE.MeshBasicMaterial).opacity =
            (1 - t) * 0.78;
        }
        if (sw.arcMesh) {
          (sw.arcMesh.material as THREE.MeshBasicMaterial).opacity = Math.max(
            0,
            1 - t * 2.2
          );
        }
      }
    }

    // Update Chrono Spire Sibling CDR Relay Arcs
    for (let i = this.relayArcs.length - 1; i >= 0; i--) {
      const ra = this.relayArcs[i];
      ra.age += safeDt;
      if (ra.age >= ra.maxAge) {
        this.scene.remove(ra.mesh);
        ra.mesh.geometry.dispose();
        (ra.mesh.material as THREE.Material).dispose();
        this.relayArcs.splice(i, 1);
      } else {
        const t = ra.age / ra.maxAge;
        (ra.mesh.material as THREE.MeshBasicMaterial).opacity =
          Math.sin(t * Math.PI) * 0.88;
      }
    }

    // Update Calm Circular Sprite Particle Bursts
    for (let i = this.particleBursts.length - 1; i >= 0; i--) {
      const pb = this.particleBursts[i];
      pb.age += safeDt;
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
          arr[j] += pb.velocities[j] * safeDt;
          arr[j + 1] += pb.velocities[j + 1] * safeDt;
          arr[j + 2] += pb.velocities[j + 2] * safeDt;
          pb.velocities[j + 1] -= pb.gravity * safeDt;
        }
        posAttr.needsUpdate = true;
        (pb.points.material as THREE.PointsMaterial).opacity =
          pb.baseOpacity * (1 - pb.age / pb.maxAge);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }
}
