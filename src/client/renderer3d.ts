import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
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
// PROCEDURAL PBR TEXTURE & BUMP-MAP GENERATOR SUITE (2026 AAA DIORAMA STANDARD)
// ============================================================================

function configureRepeatingTexture(
  canvas: HTMLCanvasElement,
  repeatX: number,
  repeatY: number,
  isColor = true
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  if (isColor) {
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates dressed medieval Ashlar Stone Masonry color + bump textures
 * with staggered courses, mortar grooves, bevel highlights, and granite grain.
 */
function createAshlarStoneTextures(
  basePalette: string[],
  mortarColor: string,
  repeatX = 2,
  repeatY = 2
): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
  const size = 256;
  const colCanvas = document.createElement('canvas');
  colCanvas.width = size;
  colCanvas.height = size;
  const ctx = colCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = size;
  bumpCanvas.height = size;
  const bCtx = bumpCanvas.getContext('2d')!;

  ctx.fillStyle = mortarColor;
  ctx.fillRect(0, 0, size, size);
  bCtx.fillStyle = '#1e1e1e';
  bCtx.fillRect(0, 0, size, size);

  const rows = 8;
  const cols = 4;
  const rowH = size / rows;
  const colW = size / cols;

  let seed = 1337;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  for (let r = 0; r < rows; r++) {
    const stagger = (r % 2) * (colW * 0.5);
    for (let c = -1; c <= cols; c++) {
      const x = c * colW + stagger;
      const y = r * rowH;
      const pad = 2.2;
      const bx = x + pad;
      const by = y + pad;
      const bw = colW - pad * 2;
      const bh = rowH - pad * 2;

      ctx.fillStyle = basePalette[Math.floor(rand() * basePalette.length)];
      ctx.fillRect(bx, by, bw, bh);

      // Top/Left sun bevel highlight & Bottom/Right shadow on each stone block
      ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.fillRect(bx, by, bw, 2.5);
      ctx.fillRect(bx, by, 2.5, bh);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.fillRect(bx, by + bh - 2.5, bw, 2.5);

      const bVal = Math.floor(175 + rand() * 55);
      bCtx.fillStyle = `rgb(${bVal},${bVal},${bVal})`;
      bCtx.fillRect(bx, by, bw, bh);
    }
  }

  // Fine stone grain & weathered pitting
  for (let i = 0; i < 2200; i++) {
    const gx = rand() * size;
    const gy = rand() * size;
    const dark = rand() > 0.5;
    ctx.fillStyle = dark ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.07)';
    ctx.fillRect(gx, gy, 2, 2);
    bCtx.fillStyle = dark ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.15)';
    bCtx.fillRect(gx, gy, 2, 2);
  }

  return {
    map: configureRepeatingTexture(colCanvas, repeatX, repeatY, true),
    bumpMap: configureRepeatingTexture(bumpCanvas, repeatX, repeatY, false),
  };
}

/**
 * Generates interlocking rounded Cobblestone + Mossy Mortar color & bump textures.
 */
function createCobblestoneTextures(
  repeatX = 2,
  repeatY = 2
): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
  const size = 256;
  const colCanvas = document.createElement('canvas');
  colCanvas.width = size;
  colCanvas.height = size;
  const ctx = colCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = size;
  bumpCanvas.height = size;
  const bCtx = bumpCanvas.getContext('2d')!;

  // Mossy dark slate mortar bed
  ctx.fillStyle = '#2d3a2e';
  ctx.fillRect(0, 0, size, size);
  bCtx.fillStyle = '#141414';
  bCtx.fillRect(0, 0, size, size);

  const stoneColors = ['#64748b', '#78716c', '#57534e', '#94a3b8', '#6b7280'];
  let seed = 4242;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  const grid = 8;
  const step = size / grid;
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const cx = (gx + 0.5 + (gy % 2) * 0.25) * step;
      const cy = (gy + 0.5) * step;
      const rx = step * (0.37 + rand() * 0.08);
      const ry = step * (0.35 + rand() * 0.08);
      const col = stoneColors[Math.floor(rand() * stoneColors.length)];

      for (const ox of [-size, 0, size]) {
        for (const oy of [-size, 0, size]) {
          ctx.beginPath();
          ctx.ellipse(cx + ox, cy + oy, rx, ry, rand() * 0.5, 0, Math.PI * 2);
          ctx.fillStyle = col;
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = 'rgba(255,255,255,0.16)';
          ctx.stroke();

          const grad = bCtx.createRadialGradient(
            cx + ox - 2,
            cy + oy - 2,
            1,
            cx + ox,
            cy + oy,
            Math.max(rx, ry)
          );
          grad.addColorStop(0, '#ffffff');
          grad.addColorStop(0.75, '#a8a8a8');
          grad.addColorStop(1, '#202020');
          bCtx.beginPath();
          bCtx.ellipse(cx + ox, cy + oy, rx, ry, 0, 0, Math.PI * 2);
          bCtx.fillStyle = grad;
          bCtx.fill();
        }
      }
    }
  }

  return {
    map: configureRepeatingTexture(colCanvas, repeatX, repeatY, true),
    bumpMap: configureRepeatingTexture(bumpCanvas, repeatX, repeatY, false),
  };
}

/**
 * Generates Stratified Limestone Cliff Rock color & craggy bump textures
 * with sedimentary layers, vertical fissures, and mossy top veins.
 */
function createStratifiedCliffTextures(
  repeatX = 4,
  repeatY = 1.5
): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
  const size = 256;
  const colCanvas = document.createElement('canvas');
  colCanvas.width = size;
  colCanvas.height = size;
  const ctx = colCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = size;
  bumpCanvas.height = size;
  const bCtx = bumpCanvas.getContext('2d')!;

  const strataCols = [
    '#d6d3d1',
    '#a8a29e',
    '#c7c2be',
    '#8c857b',
    '#b8b2ac',
    '#78716c',
  ];
  let seed = 9001;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  let y = 0;
  while (y < size) {
    const h = 10 + rand() * 22;
    ctx.fillStyle = strataCols[Math.floor(rand() * strataCols.length)];
    ctx.fillRect(0, y, size, h + 1);
    ctx.fillStyle = 'rgba(40, 35, 30, 0.35)';
    ctx.fillRect(0, y, size, 2.5);

    const bVal = Math.floor(110 + rand() * 130);
    bCtx.fillStyle = `rgb(${bVal},${bVal},${bVal})`;
    bCtx.fillRect(0, y, size, h + 1);
    bCtx.fillStyle = '#181818';
    bCtx.fillRect(0, y, size, 3);
    y += h;
  }

  // Vertical rock fissures & crags
  for (let f = 0; f < 26; f++) {
    let fx = rand() * size;
    let fy = rand() * size;
    const len = 35 + rand() * 90;
    ctx.strokeStyle = 'rgba(35, 30, 26, 0.38)';
    ctx.lineWidth = 1.5 + rand() * 2;
    bCtx.strokeStyle = '#121212';
    bCtx.lineWidth = 2.5;

    ctx.beginPath();
    bCtx.beginPath();
    ctx.moveTo(fx, fy);
    bCtx.moveTo(fx, fy);
    for (let s = 0; s < 6; s++) {
      fx += (rand() - 0.5) * 14;
      fy += len / 6;
      ctx.lineTo(fx, fy);
      bCtx.lineTo(fx, fy);
    }
    ctx.stroke();
    bCtx.stroke();
  }

  // Lush moss pockets near the top cliff edge
  for (let m = 0; m < 120; m++) {
    const mx = rand() * size;
    const my = rand() * 48;
    ctx.fillStyle = rand() > 0.4 ? 'rgba(34, 139, 34, 0.35)' : 'rgba(22, 101, 52, 0.3)';
    ctx.beginPath();
    ctx.arc(mx, my, 3 + rand() * 7, 0, Math.PI * 2);
    ctx.fill();
  }

  return {
    map: configureRepeatingTexture(colCanvas, repeatX, repeatY, true),
    bumpMap: configureRepeatingTexture(bumpCanvas, repeatX, repeatY, false),
  };
}

/**
 * Generates organic Upper Meadow Grass & Wildflower texture for the cliff plateau rim.
 */
function createMeadowPlateauTextures(
  repeatX = 5,
  repeatY = 5
): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
  const size = 256;
  const colCanvas = document.createElement('canvas');
  colCanvas.width = size;
  colCanvas.height = size;
  const ctx = colCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = size;
  bumpCanvas.height = size;
  const bCtx = bumpCanvas.getContext('2d')!;

  ctx.fillStyle = '#247528';
  ctx.fillRect(0, 0, size, size);
  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, size, size);

  let seed = 7777;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  // Clover & lush meadow patches
  for (let i = 0; i < 180; i++) {
    ctx.fillStyle =
      rand() > 0.5 ? 'rgba(54, 158, 45, 0.35)' : 'rgba(22, 92, 26, 0.32)';
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, 8 + rand() * 18, 0, Math.PI * 2);
    ctx.fill();
  }

  // Grass blade strokes
  for (let i = 0; i < 2400; i++) {
    const gx = rand() * size;
    const gy = rand() * size;
    ctx.fillStyle = rand() > 0.45 ? '#3ca336' : '#1b5e20';
    ctx.fillRect(gx, gy, 1.5, 5);
    bCtx.fillStyle = rand() > 0.5 ? '#c8c8c8' : '#404040';
    bCtx.fillRect(gx, gy, 1.5, 5);
  }

  // Wildflower speckles (golden buttercups & white daisies)
  for (let f = 0; f < 55; f++) {
    ctx.fillStyle = rand() > 0.45 ? '#fde047' : '#f8fafc';
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  return {
    map: configureRepeatingTexture(colCanvas, repeatX, repeatY, true),
    bumpMap: configureRepeatingTexture(bumpCanvas, repeatX, repeatY, false),
  };
}

/**
 * Generates procedural dark-oak timber plank albedo + bump textures
 * with wood grain streaks, plank seams, and iron nail heads for tower roof decks.
 */
function createTimberPlankTextures(
  repeatX = 2,
  repeatY = 2
): { map: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
  const size = 256;
  const colCanvas = document.createElement('canvas');
  colCanvas.width = size;
  colCanvas.height = size;
  const ctx = colCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = size;
  bumpCanvas.height = size;
  const bCtx = bumpCanvas.getContext('2d')!;

  ctx.fillStyle = '#5c2d0c';
  ctx.fillRect(0, 0, size, size);
  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, size, size);

  let seed = 9137;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  const planks = 6;
  const plankH = size / planks;
  const shades = ['#6b3410', '#542609', '#78350f', '#451a03'];

  for (let p = 0; p < planks; p++) {
    const py = p * plankH;
    ctx.fillStyle = shades[p % shades.length];
    ctx.fillRect(0, py + 2, size, plankH - 4);

    bCtx.fillStyle = '#b8b8b8';
    bCtx.fillRect(0, py + 2, size, plankH - 4);

    // Wood grain streaks
    for (let g = 0; g < 18; g++) {
      const gy = py + 4 + rand() * (plankH - 8);
      ctx.fillStyle =
        rand() > 0.5 ? 'rgba(0,0,0,0.18)' : 'rgba(255,220,180,0.08)';
      ctx.fillRect(0, gy, size, 1.5);
      bCtx.fillStyle = rand() > 0.5 ? '#707070' : '#d0d0d0';
      bCtx.fillRect(0, gy, size, 1.5);
    }

    // Recessed plank seam
    ctx.fillStyle = '#271003';
    ctx.fillRect(0, py, size, 2.5);
    bCtx.fillStyle = '#181818';
    bCtx.fillRect(0, py, size, 2.5);

    // Iron nail heads near plank joints
    const jointX = ((p * 97 + 40) % (size - 40)) + 20;
    ctx.fillStyle = '#271003';
    ctx.fillRect(jointX, py, 2.5, plankH);
    bCtx.fillStyle = '#181818';
    bCtx.fillRect(jointX, py, 2.5, plankH);

    for (const dy of [plankH * 0.3, plankH * 0.7]) {
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.arc(jointX - 6, py + dy, 2.2, 0, Math.PI * 2);
      ctx.arc(jointX + 8, py + dy, 2.2, 0, Math.PI * 2);
      ctx.fill();
      bCtx.fillStyle = '#ffffff';
      bCtx.beginPath();
      bCtx.arc(jointX - 6, py + dy, 2.2, 0, Math.PI * 2);
      bCtx.arc(jointX + 8, py + dy, 2.2, 0, Math.PI * 2);
      bCtx.fill();
    }
  }

  return {
    map: configureRepeatingTexture(colCanvas, repeatX, repeatY, true),
    bumpMap: configureRepeatingTexture(bumpCanvas, repeatX, repeatY, false),
  };
}

/**
 * Custom GLSL Shoreline Water-Foam Skirt Shader that renders animated
 * concentric white water-foam ripples lapping against each island's stone bank.
 */
function createShorelineFoamShader(
  bankWidth: number,
  bankDepth: number
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uHalfBank: {
        value: new THREE.Vector2(bankWidth * 0.5, bankDepth * 0.5),
      },
      uHalfPlane: {
        value: new THREE.Vector2(
          (bankWidth + 3.8) * 0.5,
          (bankDepth + 3.8) * 0.5
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
      uniform vec2 uHalfBank;
      uniform vec2 uHalfPlane;
      varying vec2 vUv;

      void main() {
        vec2 worldPos = abs(vUv) * uHalfPlane;
        vec2 d = worldPos - uHalfBank;
        float boxDist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);

        if (boxDist < -0.15 || boxDist > 1.85) discard;

        float angleWave = sin(vUv.x * 18.0 + uTime * 2.2) * cos(vUv.y * 18.0 - uTime * 1.9) * 0.08;
        float dist = max(0.0, boxDist + angleWave);

        float primaryFoam = smoothstep(0.32, 0.02, dist);
        float ripple1 = smoothstep(0.09, 0.0, abs(dist - fract(uTime * 0.45) * 1.45)) * (1.0 - dist / 1.65);
        float ripple2 = smoothstep(0.08, 0.0, abs(dist - fract(uTime * 0.45 + 0.5) * 1.45)) * (1.0 - dist / 1.65);

        float alpha = clamp(primaryFoam * 0.78 + (ripple1 + ripple2) * 0.52, 0.0, 0.88);
        vec3 foamCol = mix(vec3(0.55, 0.92, 0.98), vec3(0.96, 0.99, 1.0), primaryFoam + ripple1 * 0.5);
        gl_FragColor = vec4(foamCol, alpha);
      }
    `,
  });
}

// ============================================================================
// CUSTOM GLSL SHADERS (MULTI-OCTAVE FBM GRASSLAND, CAUSTIC MOAT, PATH & AOE)
// ============================================================================

function createGrasslandFloorShader(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uGridSize: { value: new THREE.Vector2(20, 26) },
      uCursorPos: { value: new THREE.Vector2(-99, -99) },
      uAccentColor: { value: new THREE.Color('#38bdf8') },
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
      uniform vec2 uGridSize;
      uniform vec2 uCursorPos;
      uniform vec3 uAccentColor;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }

      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 3; i++) {
          v += a * vnoise(p);
          p = p * 2.07 + vec2(13.4, 7.1);
          a *= 0.5;
        }
        return v;
      }

      void main() {
        vec2 cellPos = vUv * uGridSize;
        vec2 cellId = floor(cellPos);
        vec2 blockId = floor(cellPos * 0.5);
        vec2 f = fract(cellPos);

        // 1. Mowed Royal Citadel turf checkerboard + 3-octave organic FBM meadow variation
        float checker1 = mod(cellId.x + cellId.y, 2.0);
        float checker2 = mod(blockId.x + blockId.y, 2.0);
        float macroNoise = fbm(cellPos * 0.55);
        float microClover = vnoise(cellPos * 3.8);

        vec3 emeraldTurf = vec3(0.18, 0.52, 0.14);
        vec3 sunlitMeadow = vec3(0.26, 0.63, 0.19);
        vec3 warmSoilLoam = vec3(0.28, 0.42, 0.15);

        vec3 baseGrass = mix(emeraldTurf, sunlitMeadow, checker2 * 0.62 + checker1 * 0.38);
        baseGrass = mix(baseGrass, warmSoilLoam, smoothstep(0.62, 0.88, macroNoise) * 0.35);
        baseGrass += (microClover - 0.5) * 0.055;

        // 2. Anisotropic wind-swayed grass blade micro-strokes
        float breeze = sin(cellPos.x * 0.42 + cellPos.y * 0.32 - uTime * 1.8);
        vec2 bladeCoord = cellPos * vec2(26.0, 8.5) + vec2(breeze * 0.35, 0.0);
        float bladeStroke = hash(floor(bladeCoord));
        baseGrass += (bladeStroke - 0.48) * 0.065;
        baseGrass = mix(baseGrass, vec3(0.35, 0.72, 0.23), (0.5 + 0.5 * breeze) * 0.09);

        // 3. Subtle wildflower / clover micro-speckles
        float flowerHash = hash(floor(cellPos * 9.0));
        if (flowerHash > 0.986) {
          baseGrass = mix(baseGrass, vec3(0.98, 0.90, 0.32), 0.55);
        } else if (flowerHash < 0.012) {
          baseGrass = mix(baseGrass, vec3(0.94, 0.97, 0.98), 0.45);
        }

        // 4. Recessed mossy turf seams (1x1 sub-grid and 2x2 major grid) + 2x2 stone cornerpins
        vec2 d1 = min(f, 1.0 - f);
        float line1 = 1.0 - smoothstep(0.0, 0.042, min(d1.x, d1.y));

        vec2 f2 = fract(cellPos * 0.5);
        vec2 d2 = min(f2, 1.0 - f2);
        float line2 = 1.0 - smoothstep(0.0, 0.036, min(d2.x, d2.y));
        float cornerPin = 1.0 - smoothstep(0.0, 0.09, length(d2));

        vec3 col = baseGrass;
        col = mix(col, vec3(0.10, 0.32, 0.08), line1 * 0.34);
        col = mix(col, vec3(0.07, 0.24, 0.06), line2 * 0.48);
        col = mix(col, vec3(0.68, 0.66, 0.62), cornerPin * 0.42);

        // 5. Tactical sunlit cursor proximity highlight
        float cursorDist = length(cellPos - uCursorPos);
        float cursorGlow = smoothstep(4.2, 0.0, cursorDist);
        col += vec3(0.95, 0.88, 0.35) * cursorGlow * (0.14 + line1 * 0.40);

        // 6. Soft cliff contact ambient-occlusion & chiseled stone border curb
        vec2 distToBorder = min(cellPos, uGridSize - cellPos);
        float minBorderDist = min(distToBorder.x, distToBorder.y);
        float cliffAO = smoothstep(0.0, 1.15, minBorderDist);
        col *= 0.76 + 0.24 * cliffAO;

        float borderLine = 1.0 - smoothstep(0.0, 0.16, minBorderDist);
        col = mix(col, mix(vec3(0.96, 0.90, 0.58), uAccentColor, 0.32), borderLine * 0.88);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

function createCastleMoatShader(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
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
      varying vec2 vUv;

      void main() {
        vec2 p = vUv * 62.0;
        float w1 = sin(p.x * 1.4 + uTime * 1.3) * cos(p.y * 1.4 - uTime * 0.95);
        float w2 = sin((p.x + p.y) * 1.15 - uTime * 1.6);
        float w3 = cos((p.x * 0.8 - p.y * 1.3) + uTime * 1.1);
        float caustic = smoothstep(0.22, 0.90, (w1 + w2 + w3 * 0.5) * 0.4 + 0.5);
        float glint = pow(max(0.0, (w1 * w2)), 3.0);

        vec3 deepMoat = vec3(0.03, 0.42, 0.64);
        vec3 shallowTurquoise = vec3(0.11, 0.70, 0.84);
        vec3 sparkle = vec3(0.82, 0.98, 1.0);

        float dist = length(vUv - 0.5) * 2.0;
        vec3 col = mix(shallowTurquoise, deepMoat, clamp(dist * 0.85, 0.0, 1.0));
        col = mix(col, sparkle, caustic * 0.30 + glint * 0.35);

        float alpha = smoothstep(1.0, 0.15, dist);
        gl_FragColor = vec4(col, alpha * 0.96);
      }
    `,
  });
}

function createPathFlowShader(colorHex: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(colorHex) },
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
      varying vec2 vUv;

      void main() {
        float flow = fract(vUv.x * 18.0 - abs(vUv.y - 0.5) * 1.6 - uTime * 2.5);
        float pulse = smoothstep(0.0, 0.25, flow) * smoothstep(0.85, 0.25, flow);
        vec3 col = mix(uColor * 0.85, vec3(1.0, 0.98, 0.85), pulse * 0.7);
        float alpha = 0.62 + pulse * 0.36;
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}

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
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uChargeProgress: { value: 1.0 },
      uOverchargeTier: { value: 0.0 },
      uRange: { value: range },
      uBaseColor: { value: baseColor },
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
      uniform float uChargeProgress;
      uniform float uOverchargeTier;
      uniform vec3 uBaseColor;
      varying vec2 vUv;

      void main() {
        float r = length(vUv);
        if (r > 1.0) discard;

        float angle = atan(vUv.y, vUv.x);
        float normAngle = (angle + 3.14159265) / 6.2831853;

        float dash = step(0.32, fract(normAngle * 24.0 + uTime * (0.25 + uOverchargeTier * 0.12)));
        float outerRing = smoothstep(0.91, 0.96, r) * smoothstep(1.0, 0.96, r);
        float innerRuneRing = smoothstep(0.76, 0.79, r) * smoothstep(0.82, 0.79, r);

        float chargeArc = smoothstep(0.83, 0.87, r) * smoothstep(0.91, 0.87, r);
        float isChargedAngle = step(normAngle, uChargeProgress);

        float sonar = fract(r * 2.2 - uTime * (0.7 + uChargeProgress * 0.7));
        float sonarBand = smoothstep(0.0, 0.12, sonar) * smoothstep(0.28, 0.12, sonar) * (1.0 - r);

        vec3 overchargeTint = mix(uBaseColor, vec3(1.0, 0.95, 0.45), clamp(uOverchargeTier * 0.25, 0.0, 0.65));
        vec3 readyGlow = mix(overchargeTint, vec3(1.0, 0.98, 0.82), 0.35);
        vec3 ringCol = uChargeProgress >= 0.99 ? readyGlow : overchargeTint;

        float alpha = (0.06 + uOverchargeTier * 0.02) * (1.0 - r * 0.45);
        alpha += outerRing * (0.48 + 0.52 * dash);
        alpha += innerRuneRing * (1.0 - dash) * 0.48;
        alpha += chargeArc * isChargedAngle * 0.78;
        alpha += sonarBand * 0.14;

        gl_FragColor = vec4(ringCol, clamp(alpha, 0.0, 0.92));
      }
    `,
  });
}

// ============================================================================
// INTERFACES
// ============================================================================

interface ShockwaveEffect {
  mesh: THREE.Mesh;
  dome: THREE.Mesh;
  bolt?: THREE.Line;
  age: number;
  maxAge: number;
  maxRadius: number;
}

interface ParticleBurst {
  points: THREE.Points;
  velocities: Float32Array;
  age: number;
  maxAge: number;
}

interface SpireVisualRig {
  group: THREE.Group;
  spireType: SpireType;
  baseRange: number;
  upperCore: THREE.Mesh;
  innerRing: THREE.Mesh;
  outerRing: THREE.Mesh;
  aoeMesh: THREE.Mesh;
  aoeMat: THREE.ShaderMaterial;
  recoil: number;
}

interface RuinVisualRig {
  group: THREE.Group;
  connGroup: THREE.Group;
  crystalMat: THREE.MeshStandardMaterial;
  gridX: number;
  gridY: number;
}

interface RunnerRig {
  root: THREE.Group;
  pelvis: THREE.Group;
  headGroup: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  staffCrystal: THREE.Mesh;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  snareCage: THREE.Mesh;
  walkPhase: number;
  currentYaw: number;
}

interface WallVisualEntry {
  group: THREE.Group;
  connGroup: THREE.Group;
  born: number;
  x: number;
  y: number;
  capCrystal: THREE.Mesh;
}

interface IslandVisuals {
  playerId: string;
  playerColor: string;
  root: THREE.Group;
  offsetX: number;
  offsetZ: number;
  floorMat: THREE.ShaderMaterial;
  foamMat: THREE.ShaderMaterial;
  trimMesh: THREE.Mesh;
  hitPlane: THREE.Mesh;
  padGroup: THREE.Group;
  towerGroup: THREE.Group;
  clapMarkerGroup: THREE.Group;
  towerMeshes: Map<string, WallVisualEntry>;
  spireRigs: SpireVisualRig[];
  ruinRigs: RuinVisualRig[];
  pathMesh: THREE.Mesh | null;
  pathMat: THREE.ShaderMaterial | null;
  runner: RunnerRig;
  trailPoints: THREE.Vector3[];
  trailLine: THREE.Line;
  checkpointRings: THREE.Mesh[];
}

export class Arena3DRenderer {
  private container: HTMLElement;
  private labelLayer: HTMLElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private voidSeaMat!: THREE.ShaderMaterial;

  private islands = new Map<string, IslandVisuals>();
  private shockwaves: ShockwaveEffect[] = [];
  private particleBursts: ParticleBurst[] = [];

  // Camera rig & trauma state (framed for spacious 20x26 grassland field)
  private camTarget = new THREE.Vector3(10, 0, 13);
  private camGoalTarget = new THREE.Vector3(10, 0, 13);
  private camRadius = 30.5;
  private camGoalRadius = 30.5;
  private camPolar = 0.52;
  private camAzimuth = 0;
  private camGoalAzimuth = 0;
  private cameraShake = 0;

  private isDraggingCamera = false;
  private dragStart = { x: 0, y: 0 };
  private keysDown = new Set<string>();

  // Build hover & holographic ghost state (with live omni-directional bridge preview)
  private raycaster = new THREE.Raycaster();
  private mouseNDC = new THREE.Vector2(-99, -99);
  private lastPointerScreen = { x: 0, y: 0 };
  private hoveredCell: { x: number; y: number } | null = null;
  private hoveredExistingTower: PlacedTower | null = null;
  private ghostGroup: THREE.Group;
  private ghostConnGroup: THREE.Group;
  private ghostCore: THREE.Mesh;
  private ghostWire: THREE.LineSegments;
  private previewPathMesh: THREE.Mesh | null;
  private previewPathMat: THREE.ShaderMaterial | null;

  // Textured PBR Materials (Ashlar Limestone, Crimson Keep Brick, Cobblestone, Stratified Cliff, Meadow Turf, Dark-Oak Timber)
  private ashlarTex = createAshlarStoneTextures(
    ['#e7e5e4', '#d6d3d1', '#f5f5f4', '#cbd5e1'],
    '#57534e',
    2,
    2
  );
  private crimsonBrickTex = createAshlarStoneTextures(
    ['#b91c1c', '#991b1b', '#dc2626', '#7f1d1d'],
    '#450a0a',
    2,
    2
  );
  private cobbleTex = createCobblestoneTextures(2, 2);
  private cliffTex = createStratifiedCliffTextures(4, 1.5);
  private meadowTex = createMeadowPlateauTextures(5, 5);
  private timberTex = createTimberPlankTextures(2, 2);

  private playerStoneMat = new THREE.MeshStandardMaterial({
    color: '#f8fafc',
    map: this.ashlarTex.map,
    bumpMap: this.ashlarTex.bumpMap,
    bumpScale: 0.045,
    roughness: 0.52,
    metalness: 0.12,
  });
  private playerTrimMat = new THREE.MeshStandardMaterial({
    color: '#cbd5e1',
    map: this.ashlarTex.map,
    bumpMap: this.ashlarTex.bumpMap,
    bumpScale: 0.035,
    roughness: 0.6,
    metalness: 0.15,
  });
  private cobbleFoundationMat = new THREE.MeshStandardMaterial({
    color: '#cbd5e1',
    map: this.cobbleTex.map,
    bumpMap: this.cobbleTex.bumpMap,
    bumpScale: 0.06,
    roughness: 0.78,
    metalness: 0.08,
  });
  private crimsonStoneMat = new THREE.MeshStandardMaterial({
    color: '#fca5a5',
    map: this.crimsonBrickTex.map,
    bumpMap: this.crimsonBrickTex.bumpMap,
    bumpScale: 0.045,
    roughness: 0.52,
    metalness: 0.16,
  });
  private crimsonTrimMat = new THREE.MeshStandardMaterial({
    color: '#fecaca',
    map: this.crimsonBrickTex.map,
    bumpMap: this.crimsonBrickTex.bumpMap,
    bumpScale: 0.035,
    roughness: 0.6,
    metalness: 0.15,
  });
  private cliffRockMat = new THREE.MeshStandardMaterial({
    color: '#e7e5e4',
    map: this.cliffTex.map,
    bumpMap: this.cliffTex.bumpMap,
    bumpScale: 0.08,
    roughness: 0.74,
    metalness: 0.08,
  });
  private upperMeadowMat = new THREE.MeshStandardMaterial({
    color: '#bbf7d0',
    map: this.meadowTex.map,
    bumpMap: this.meadowTex.bumpMap,
    bumpScale: 0.035,
    roughness: 0.68,
    metalness: 0.05,
  });
  private timberRoofMat = new THREE.MeshStandardMaterial({
    color: '#d6d3d1',
    map: this.timberTex.map,
    bumpMap: this.timberTex.bumpMap,
    bumpScale: 0.04,
    roughness: 0.78,
    metalness: 0.08,
  });

  public activeTool: 'BLOCK' | 'SELL' = 'BLOCK';
  public localPlayerId: string | null = null;
  public focusedPlayerId: string | null = null;
  public arenaOverviewMode = false;
  private currentRoomState: RoomState | null = null;
  private lastLayoutSignature = '';
  private cachedBaseEval: MazeEvalResult | null = null;

  public onPlaceTower?: (x: number, y: number) => void;
  public onSellTower?: (towerId: string) => void;
  public onHoverStatusChange?: (info: {
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
  }) => void;

  private labelElements = new Map<string, HTMLElement>();
  private runnerLabels = new Map<string, HTMLElement>();

  constructor(container: HTMLElement, labelLayer: HTMLElement) {
    this.container = container;
    this.labelLayer = labelLayer;
    this.previewPathMesh = null;
    this.previewPathMat = null;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0c4a6e');
    this.scene.fog = new THREE.FogExp2('#0c4a6e', 0.0045);

    this.camera = new THREE.PerspectiveCamera(
      44,
      window.innerWidth / window.innerHeight,
      0.5,
      320
    );

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.container.appendChild(this.renderer.domElement);

    this.composer = new EffectComposer(this.renderer);
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.28,
      0.3,
      0.85
    );
    this.composer.addPass(bloomPass);

    this.setupLightingAndEnvironment();

    // Holographic 2x2 Castle Pillar Ghost Preview + Live Omni-Directional Bridge Preview
    this.ghostGroup = new THREE.Group();
    this.ghostGroup.visible = false;

    this.ghostConnGroup = new THREE.Group();
    this.ghostGroup.add(this.ghostConnGroup);

    const coreGeo = new THREE.CylinderGeometry(0.66, 0.76, 1.42, 8);
    coreGeo.rotateY(Math.PI / 8);
    const coreMat = new THREE.MeshStandardMaterial({
      color: '#22c55e',
      emissive: '#22c55e',
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0.48,
    });
    this.ghostCore = new THREE.Mesh(coreGeo, coreMat);
    this.ghostCore.position.y = 0.71;
    this.ghostGroup.add(this.ghostCore);

    const wireGeo = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(1.94, 1.45, 1.94)
    );
    const wireMat = new THREE.LineBasicMaterial({
      color: '#4ade80',
      transparent: true,
      opacity: 0.9,
    });
    this.ghostWire = new THREE.LineSegments(wireGeo, wireMat);
    this.ghostWire.position.y = 0.72;
    this.ghostGroup.add(this.ghostWire);

    this.scene.add(this.ghostGroup);

    this.bindEvents();
  }

  private setupLightingAndEnvironment() {
    // Warm sunlit diorama lighting with sky-blue and lush-grass bounce light
    const hemiLight = new THREE.HemisphereLight('#e0f2fe', '#22c55e', 1.15);
    this.scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight('#fffbeb', 2.1);
    dirLight.position.set(34, 64, 38);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 5;
    dirLight.shadow.camera.far = 180;
    const d = 68;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    dirLight.shadow.bias = -0.0005;
    this.scene.add(dirLight);

    // Sunlit Turquoise Castle Moat Plane surrounding the islands
    this.voidSeaMat = createCastleMoatShader();
    const seaGeo = new THREE.PlaneGeometry(320, 320);
    seaGeo.rotateX(-Math.PI / 2);
    const seaMesh = new THREE.Mesh(seaGeo, this.voidSeaMat);
    seaMesh.position.set(28, -0.65, 26);
    this.scene.add(seaMesh);
  }

  private bindEvents() {
    const dom = this.renderer.domElement;

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.composer.setSize(window.innerWidth, window.innerHeight);
    });

    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keysDown.add(e.key.toLowerCase());
    });

    window.addEventListener('keyup', (e) => {
      this.keysDown.delete(e.key.toLowerCase());
    });

    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    dom.addEventListener('pointermove', (e) => {
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
          const panScale = this.camRadius * 0.0016;
          const cosA = Math.cos(this.camAzimuth);
          const sinA = Math.sin(this.camAzimuth);
          this.camGoalTarget.x -= (dx * cosA + dy * sinA) * panScale;
          this.camGoalTarget.z -= (-dx * sinA + dy * cosA) * panScale;
        }
        return;
      }

      this.updateBuildHover();
    });

    dom.addEventListener('pointerleave', () => {
      this.mouseNDC.set(-99, -99);
      this.updateBuildHover();
    });

    dom.addEventListener('pointerdown', (e) => {
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        this.isDraggingCamera = true;
        this.dragStart = { x: e.clientX, y: e.clientY };
        return;
      }

      if (e.button === 2) {
        this.updateBuildHover();
        if (
          this.hoveredExistingTower &&
          this.currentRoomState?.phase === 'BUILD'
        ) {
          this.onSellTower?.(this.hoveredExistingTower.id);
          return;
        }
        this.isDraggingCamera = true;
        this.dragStart = { x: e.clientX, y: e.clientY };
        return;
      }

      if (e.button === 0) {
        this.updateBuildHover();
        if (this.currentRoomState?.phase !== 'BUILD') return;

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

    window.addEventListener('pointerup', () => {
      this.isDraggingCamera = false;
    });

    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.camGoalRadius = Math.max(
          14,
          Math.min(68, this.camGoalRadius + e.deltaY * 0.02)
        );
      },
      { passive: false }
    );
  }

  public focusOnPlayerIsland(playerId: string) {
    this.arenaOverviewMode = false;
    this.focusedPlayerId = playerId;
    const island = this.islands.get(playerId);
    if (!island || !this.currentRoomState) return;

    const gw = this.currentRoomState.roundConfig.gridWidth;
    const gh = this.currentRoomState.roundConfig.gridHeight;
    this.camGoalTarget.set(
      island.offsetX + gw / 2,
      0,
      island.offsetZ + gh / 2 + 0.5
    );
    this.camGoalRadius = 30.5;
    this.camGoalAzimuth = 0;
  }

  public focusArenaOverview() {
    this.arenaOverviewMode = true;
    if (!this.currentRoomState) return;
    const count = this.currentRoomState.players.length;
    const cols = Math.min(3, Math.max(1, count));
    const rows = Math.ceil(count / 3);
    const gw = this.currentRoomState.roundConfig.gridWidth;
    const gh = this.currentRoomState.roundConfig.gridHeight;
    const centerX = ((cols - 1) * ISLAND_SPACING_X + gw) / 2;
    const centerZ = ((rows - 1) * ISLAND_SPACING_Z + gh) / 2;
    this.camGoalTarget.set(centerX, 0, centerZ);
    this.camGoalRadius = rows > 1 ? 62 : 48;
    this.camGoalAzimuth = 0;
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

    const activeIds = new Set(state.players.map((p) => p.id));
    for (const [pid, isl] of this.islands.entries()) {
      if (!activeIds.has(pid)) {
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

      this.syncIslandTowersAndPath(island, player, state.roundConfig);
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
      this.focusOnPlayerIsland(localPlayerId);
    }

    this.updateBuildHover();
  }

  /**
   * Builds a stylized miniature Pine Tree for the upper grassland cliff rim (Design C).
   */
  private buildDioramaPineTree(scale = 1.0): THREE.Group {
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.18, 0.55, 6),
      this.timberRoofMat
    );
    trunk.position.y = 0.27;
    trunk.castShadow = true;
    tree.add(trunk);

    const needleCols = ['#15803d', '#16a34a', '#22c55e'];
    for (let tier = 0; tier < 3; tier++) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.62 - tier * 0.14, 0.78 - tier * 0.1, 7),
        new THREE.MeshStandardMaterial({
          color: needleCols[tier],
          bumpMap: this.meadowTex.bumpMap,
          bumpScale: 0.025,
          roughness: 0.65,
        })
      );
      cone.position.y = 0.68 + tier * 0.42;
      cone.castShadow = true;
      cone.receiveShadow = true;
      tree.add(cone);
    }
    tree.scale.setScalar(scale);
    return tree;
  }

  /**
   * Builds a corner Castle Bastion Watchtower for the 4 outer corners of the cliff basin.
   */
  private buildCornerBastionWatchtower(playerColor: string): THREE.Group {
    const bastion = new THREE.Group();

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.18, 1.38, 2.35, 8),
      this.playerStoneMat
    );
    base.rotation.y = Math.PI / 8;
    base.position.y = 1.18;
    base.castShadow = true;
    base.receiveShadow = true;
    bastion.add(base);

    const corbel = new THREE.Mesh(
      new THREE.CylinderGeometry(1.32, 1.18, 0.28, 8),
      this.playerTrimMat
    );
    corbel.rotation.y = Math.PI / 8;
    corbel.position.y = 2.42;
    bastion.add(corbel);

    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(1.42, 1.35, 8),
      new THREE.MeshStandardMaterial({
        color: '#1e3a8a',
        emissive: playerColor,
        emissiveIntensity: 0.18,
        bumpMap: this.ashlarTex.bumpMap,
        bumpScale: 0.04,
        roughness: 0.45,
        metalness: 0.2,
      })
    );
    roof.rotation.y = Math.PI / 8;
    roof.position.y = 3.2;
    roof.castShadow = true;
    bastion.add(roof);

    const spireFinial = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.18, 0),
      new THREE.MeshBasicMaterial({ color: '#fde047' })
    );
    spireFinial.position.y = 3.95;
    bastion.add(spireFinial);

    return bastion;
  }

  /**
   * Builds a textured Stratified Cliff Segment with lower talus ledge, inner stone retaining buttresses,
   * overhanging meadow turf cornice, pine trees, and faceted limestone boulders.
   */
  private createTexturedCliffSegment(
    cx: number,
    cz: number,
    w: number,
    d: number,
    addProps = true
  ): THREE.Group {
    const seg = new THREE.Group();
    if (w <= 0.2 || d <= 0.2) return seg;

    // Lower stepped talus rock ledge
    const talus = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.28, 0.55, d + 0.28),
      this.cliffRockMat
    );
    talus.position.set(cx, 0.27, cz);
    talus.receiveShadow = true;
    seg.add(talus);

    // Main stratified limestone cliff body
    const rock = new THREE.Mesh(
      new THREE.BoxGeometry(w, 1.48, d),
      this.cliffRockMat
    );
    rock.position.set(cx, 0.74, cz);
    rock.castShadow = true;
    rock.receiveShadow = true;
    seg.add(rock);

    // Overhanging textured meadow turf cornice
    const grassTop = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.22, 0.26, d + 0.22),
      this.upperMeadowMat
    );
    grassTop.position.set(cx, 1.56, cz);
    grassTop.receiveShadow = true;
    seg.add(grassTop);

    // Scatter pine trees and faceted limestone boulders along the upper cliff plateau
    if (addProps) {
      const span = Math.max(w, d);
      const count = Math.max(1, Math.floor(span / 3.6));
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count - 0.5;
        const tx = w >= d ? cx + t * (w - 1.5) : cx + ((i % 2) - 0.5) * 0.65;
        const tz = d > w ? cz + t * (d - 1.5) : cz + ((i % 2) - 0.5) * 0.65;
        const tree = this.buildDioramaPineTree(0.85 + (i % 3) * 0.16);
        tree.position.set(tx, 1.68, tz);
        seg.add(tree);

        if (i % 2 === 0) {
          const boulder = new THREE.Mesh(
            new THREE.DodecahedronGeometry(0.28 + (i % 3) * 0.08, 0),
            this.cliffRockMat
          );
          boulder.position.set(tx + 0.55, 1.72, tz + 0.35);
          boulder.rotation.set(i * 0.7, i * 1.1, 0);
          boulder.castShadow = true;
          seg.add(boulder);
        }
      }
    }

    return seg;
  }

  /**
   * Builds the Sunken Grassland Island with Textured Limestone Cliff Basin,
   * Animated Shoreline Water-Foam Skirt, 4 Corner Bastion Watchtowers,
   * Upper Meadow Rim, Pine Trees, and Border Gates.
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

    // 1. Sunken Grassland Foundation Slab & Textured Shoreline Bank
    const bankW = gw + 6.4;
    const bankD = gh + 6.4;
    const bankGeo = new THREE.BoxGeometry(bankW, 1.1, bankD);
    const bank = new THREE.Mesh(bankGeo, this.cliffRockMat);
    bank.position.set(gw / 2, -0.56, gh / 2);
    bank.receiveShadow = true;
    root.add(bank);

    // Animated Shoreline Water-Foam Skirt lapping around the island's stone bank
    const foamGeo = new THREE.PlaneGeometry(bankW + 3.8, bankD + 3.8);
    foamGeo.rotateX(-Math.PI / 2);
    const foamMat = createShorelineFoamShader(bankW, bankD);
    const foamMesh = new THREE.Mesh(foamGeo, foamMat);
    foamMesh.position.set(gw / 2, -0.62, gh / 2);
    root.add(foamMesh);

    // Custom GLSL Multi-Octave FBM Mowed Grassland Turf Floor
    const floorGeo = new THREE.PlaneGeometry(gw, gh);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = createGrasslandFloorShader();
    floorMat.uniforms.uGridSize.value.set(gw, gh);
    floorMat.uniforms.uAccentColor.value.set(player.color);
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.position.set(gw / 2, 0.01, gh / 2);
    floorMesh.receiveShadow = true;
    root.add(floorMesh);

    // 2. West & East Stratified Cliff Walls + Stone Retaining Buttresses
    const rimThick = 2.4;
    root.add(this.createTexturedCliffSegment(-rimThick / 2, gh / 2, rimThick, gh));
    root.add(
      this.createTexturedCliffSegment(gw + rimThick / 2, gh / 2, rimThick, gh)
    );

    // Inner stone retaining buttresses along West & East walls
    for (let bz = 3; bz <= gh - 3; bz += 4) {
      for (const sideX of [-0.12, gw + 0.12]) {
        const buttress = new THREE.Mesh(
          new THREE.BoxGeometry(0.32, 1.42, 0.48),
          this.playerTrimMat
        );
        buttress.position.set(sideX, 0.71, bz);
        buttress.castShadow = true;
        root.add(buttress);
      }
    }

    // 3. Four Ornate Corner Castle Bastion Watchtowers framing the arena
    const cornerCoords = [
      [-rimThick * 0.65, -rimThick * 0.65],
      [gw + rimThick * 0.65, -rimThick * 0.65],
      [-rimThick * 0.65, gh + rimThick * 0.65],
      [gw + rimThick * 0.65, gh + rimThick * 0.65],
    ];
    for (const [bx, bz] of cornerCoords) {
      const watchtower = this.buildCornerBastionWatchtower(player.color);
      watchtower.position.set(bx, 0, bz);
      root.add(watchtower);
    }

    // Player-colored shoreline trim band
    const trimGeo = new THREE.BoxGeometry(gw + 6.6, 0.18, gh + 6.6);
    const trimMat = new THREE.MeshStandardMaterial({
      color: player.color,
      emissive: player.color,
      emissiveIntensity: 0.45,
      roughness: 0.35,
    });
    const trimMesh = new THREE.Mesh(trimGeo, trimMat);
    trimMesh.position.set(gw / 2, -0.08, gh / 2);
    root.add(trimMesh);

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

    const clapMarkerGroup = new THREE.Group();
    root.add(clapMarkerGroup);

    // Articulated Multi-Part 3D Runner standing right at the North border
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

    const trailGeo = new THREE.BufferGeometry();
    const trailMat = new THREE.LineBasicMaterial({
      color: player.color,
      transparent: true,
      opacity: 0.85,
    });
    const trailLine = new THREE.Line(trailGeo, trailMat);
    root.add(trailLine);

    this.scene.add(root);

    const visuals: IslandVisuals = {
      playerId: player.id,
      playerColor: player.color,
      root,
      offsetX,
      offsetZ,
      floorMat,
      foamMat,
      trimMesh,
      hitPlane,
      padGroup,
      towerGroup,
      clapMarkerGroup,
      towerMeshes: new Map(),
      spireRigs: [],
      ruinRigs: [],
      pathMesh: null,
      pathMat: null,
      runner,
      trailPoints: [],
      trailLine,
      checkpointRings: [],
    };

    this.rebuildIslandPadsAndObstacles(visuals, round);
    this.createIslandDOMElements(player);

    return visuals;
  }

  /**
   * Builds an articulated multi-part 3D Runner rig with distinct silhouettes and armor
   * for `SCOUT`, `OUTRIDER` (cavalry plume), `JUGGERNAUT` (heavy iron pauldrons), and `HERALD` (wind wings).
   */
  private buildArticulatedRunnerRig(
    playerColor: string,
    runnerType: RunnerArchetype = 'SCOUT'
  ): RunnerRig {
    const root = new THREE.Group();
    if (runnerType === 'JUGGERNAUT') {
      root.scale.set(1.18, 1.14, 1.18);
    }

    const pelvis = new THREE.Group();
    pelvis.position.y = 0.45;
    root.add(pelvis);

    const tunicColor =
      runnerType === 'OUTRIDER'
        ? '#991b1b'
        : runnerType === 'JUGGERNAUT'
        ? '#475569'
        : runnerType === 'HERALD'
        ? '#065f46'
        : '#1e3a8a';

    // Heraldic Tunic / Armor Cuirass
    const torsoGeo = new THREE.ConeGeometry(0.34, 0.82, 8);
    const torsoMat = new THREE.MeshStandardMaterial({
      color: tunicColor,
      emissive: playerColor,
      emissiveIntensity: 0.28,
      bumpMap: this.ashlarTex.bumpMap,
      bumpScale: 0.02,
      roughness: runnerType === 'JUGGERNAUT' ? 0.25 : 0.35,
      metalness: runnerType === 'JUGGERNAUT' ? 0.72 : 0.3,
    });
    const torsoMesh = new THREE.Mesh(torsoGeo, torsoMat);
    torsoMesh.position.y = 0.25;
    torsoMesh.castShadow = true;
    pelvis.add(torsoMesh);

    // Archetype-specific 3D Silhouette Attachments
    if (runnerType === 'JUGGERNAUT') {
      const pauldronMat = new THREE.MeshStandardMaterial({
        color: '#64748b',
        roughness: 0.25,
        metalness: 0.8,
      });
      for (const side of [-0.32, 0.32]) {
        const pauldron = new THREE.Mesh(
          new THREE.DodecahedronGeometry(0.18, 0),
          pauldronMat
        );
        pauldron.position.set(side, 0.52, 0);
        pauldron.castShadow = true;
        pelvis.add(pauldron);
      }
    } else if (runnerType === 'HERALD') {
      const wingMat = new THREE.MeshStandardMaterial({
        color: '#34d399',
        emissive: '#10b981',
        emissiveIntensity: 0.85,
        roughness: 0.2,
      });
      for (const side of [-0.22, 0.22]) {
        const wing = new THREE.Mesh(
          new THREE.BoxGeometry(0.05, 0.48, 0.32),
          wingMat
        );
        wing.position.set(side, 0.42, -0.22);
        wing.rotation.y = side > 0 ? 0.35 : -0.35;
        wing.rotation.x = 0.28;
        pelvis.add(wing);
      }
    }

    // Hooded Ranger Helm & Visor
    const headGroup = new THREE.Group();
    headGroup.position.y = 0.74;
    const helmGeo = new THREE.DodecahedronGeometry(0.23, 0);
    const helmMat = new THREE.MeshStandardMaterial({
      color: '#1e293b',
      roughness: 0.3,
      metalness: 0.65,
    });
    const helm = new THREE.Mesh(helmGeo, helmMat);
    headGroup.add(helm);

    if (runnerType === 'OUTRIDER') {
      const plume = new THREE.Mesh(
        new THREE.ConeGeometry(0.11, 0.42, 6),
        new THREE.MeshStandardMaterial({
          color: '#fde047',
          emissive: '#f59e0b',
          emissiveIntensity: 0.45,
        })
      );
      plume.position.set(0, 0.26, -0.12);
      plume.rotation.x = -0.65;
      headGroup.add(plume);
    }

    const visorColor =
      runnerType === 'OUTRIDER'
        ? '#fde047'
        : runnerType === 'JUGGERNAUT'
        ? '#f59e0b'
        : runnerType === 'HERALD'
        ? '#34d399'
        : '#38bdf8';
    const visorGeo = new THREE.OctahedronGeometry(0.14, 0);
    const visorMat = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      emissive: visorColor,
      emissiveIntensity: 1.5,
    });
    const visor = new THREE.Mesh(visorGeo, visorMat);
    visor.position.set(0, 0.02, 0.14);
    headGroup.add(visor);
    pelvis.add(headGroup);

    // Left Arm
    const leftArm = new THREE.Group();
    leftArm.position.set(-0.28, 0.48, 0);
    const armGeo = new THREE.BoxGeometry(0.12, 0.42, 0.12);
    const armMat = new THREE.MeshStandardMaterial({
      color: '#e2e8f0',
      roughness: 0.4,
    });
    const lArmMesh = new THREE.Mesh(armGeo, armMat);
    lArmMesh.position.y = -0.16;
    leftArm.add(lArmMesh);
    pelvis.add(leftArm);

    // Right Arm + Royal Banner Staff
    const rightArm = new THREE.Group();
    rightArm.position.set(0.28, 0.48, 0);
    const rArmMesh = new THREE.Mesh(armGeo, armMat);
    rArmMesh.position.y = -0.16;
    rightArm.add(rArmMesh);

    const staffShaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.03, 1.38, 8),
      this.timberRoofMat
    );
    staffShaft.position.set(0.04, 0.1, 0.22);
    staffShaft.rotation.x = 0.22;
    rightArm.add(staffShaft);

    const staffCrystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.16, 0),
      new THREE.MeshBasicMaterial({
        color: '#67e8f9',
      })
    );
    staffCrystal.position.set(0.04, 0.8, 0.36);
    rightArm.add(staffCrystal);
    pelvis.add(rightArm);

    // Articulated Legs
    const legGeo = new THREE.BoxGeometry(0.13, 0.38, 0.15);
    const legMat = new THREE.MeshStandardMaterial({
      color: '#334155',
      roughness: 0.5,
    });
    const leftLeg = new THREE.Group();
    leftLeg.position.set(-0.13, -0.05, 0);
    const lLegMesh = new THREE.Mesh(legGeo, legMat);
    lLegMesh.position.y = -0.16;
    leftLeg.add(lLegMesh);
    pelvis.add(leftLeg);

    const rightLeg = new THREE.Group();
    rightLeg.position.set(0.13, -0.05, 0);
    const rLegMesh = new THREE.Mesh(legGeo, legMat);
    rLegMesh.position.y = -0.16;
    rightLeg.add(rLegMesh);
    pelvis.add(rightLeg);

    // Electric Slow Snare Cage (visible when Thunderclapped / Permafrost / Tailwind)
    const cageGeo = new THREE.OctahedronGeometry(0.64, 1);
    const cageMat = new THREE.MeshBasicMaterial({
      color: '#fde047',
      wireframe: true,
      transparent: true,
      opacity: 0.78,
    });
    const snareCage = new THREE.Mesh(cageGeo, cageMat);
    snareCage.position.y = 0.3;
    snareCage.visible = false;
    pelvis.add(snareCage);

    return {
      root,
      pelvis,
      headGroup,
      leftArm,
      rightArm,
      staffCrystal,
      leftLeg,
      rightLeg,
      snareCage,
      walkPhase: 0,
      currentYaw: 0,
    };
  }

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
    const rimThick = 2.4;
    const gateHalfGap = 2.1;

    const spawnCx = round.spawn.x + 1.0;
    const spawnBorderZ = round.spawn.y === 0 ? 0.0 : round.spawn.y + 1.0;
    const exitCx = round.exit.x + 1.0;
    const exitBorderZ =
      round.exit.y >= round.gridHeight - 2
        ? round.gridHeight
        : round.exit.y + 1.0;

    // 0. Dynamic North & South Stratified Cliff Walls split at exact spawnCx / exitCx notches!
    const leftNorthW = spawnCx - gateHalfGap + rimThick;
    island.padGroup.add(
      this.createTexturedCliffSegment(
        -rimThick + leftNorthW / 2,
        -rimThick / 2,
        leftNorthW,
        rimThick
      )
    );
    const rightNorthW = gw - (spawnCx + gateHalfGap) + rimThick;
    island.padGroup.add(
      this.createTexturedCliffSegment(
        spawnCx + gateHalfGap + rightNorthW / 2,
        -rimThick / 2,
        rightNorthW,
        rimThick
      )
    );

    const leftSouthW = exitCx - gateHalfGap + rimThick;
    island.padGroup.add(
      this.createTexturedCliffSegment(
        -rimThick + leftSouthW / 2,
        gh + rimThick / 2,
        leftSouthW,
        rimThick
      )
    );
    const rightSouthW = gw - (exitCx + gateHalfGap) + rimThick;
    island.padGroup.add(
      this.createTexturedCliffSegment(
        exitCx + gateHalfGap + rightSouthW / 2,
        gh + rimThick / 2,
        rightSouthW,
        rimThick
      )
    );

    // 1. Fortified North Border Castle Gatehouse (flush with top border z = 0, outside buildable grass!)
    const spawnGate = new THREE.Group();
    spawnGate.position.set(spawnCx, 0, spawnBorderZ);

    const cobblePad = new THREE.Mesh(
      new THREE.BoxGeometry(3.4, 0.1, 2.35),
      this.cobbleFoundationMat
    );
    cobblePad.position.set(0, 0.05, -1.18);
    spawnGate.add(cobblePad);

    for (const side of [-1.32, 1.32]) {
      const col = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.48, 1.92, 8),
        this.playerStoneMat
      );
      col.rotation.y = Math.PI / 8;
      col.position.set(side, 0.96, -0.68);
      col.castShadow = true;
      spawnGate.add(col);

      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.44, 0.24, 8),
        this.playerTrimMat
      );
      cap.rotation.y = Math.PI / 8;
      cap.position.set(side, 1.98, -0.68);
      spawnGate.add(cap);
    }

    const lintel = new THREE.Mesh(
      new THREE.BoxGeometry(3.3, 0.42, 0.68),
      this.playerStoneMat
    );
    lintel.position.set(0, 1.88, -0.68);
    lintel.castShadow = true;
    spawnGate.add(lintel);

    // Crenellated Gatehouse Parapet Merlons
    for (let mx = -1.2; mx <= 1.2; mx += 0.6) {
      const merlon = new THREE.Mesh(
        new THREE.BoxGeometry(0.32, 0.24, 0.36),
        this.playerTrimMat
      );
      merlon.position.set(mx, 2.2, -0.68);
      spawnGate.add(merlon);
    }

    const spawnThreshold = new THREE.Mesh(
      new THREE.BoxGeometry(2.15, 0.09, 0.18),
      new THREE.MeshBasicMaterial({ color: '#38bdf8' })
    );
    spawnThreshold.position.set(0, 0.05, 0.0);
    spawnGate.add(spawnThreshold);
    island.padGroup.add(spawnGate);

    // 2. South Border Royal Exit Shrine & Fluted Pedestals (flush with bottom border z = gridHeight)
    const exitGroup = new THREE.Group();
    exitGroup.position.set(exitCx, 0, exitBorderZ);

    const exitCobble = new THREE.Mesh(
      new THREE.BoxGeometry(3.4, 0.1, 2.35),
      this.cobbleFoundationMat
    );
    exitCobble.position.set(0, 0.05, 1.18);
    exitGroup.add(exitCobble);

    for (const side of [-1.35, 1.35]) {
      const ped = new THREE.Mesh(
        new THREE.BoxGeometry(0.92, 1.18, 0.92),
        this.playerStoneMat
      );
      ped.position.set(side, 0.59, 0.68);
      ped.castShadow = true;
      exitGroup.add(ped);

      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(1.06, 0.18, 1.06),
        this.playerTrimMat
      );
      cap.position.set(side, 1.24, 0.68);
      exitGroup.add(cap);

      const beacon = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.22, 0),
        new THREE.MeshBasicMaterial({ color: '#f43f5e' })
      );
      beacon.position.set(side, 1.56, 0.68);
      exitGroup.add(beacon);
    }

    const exitThreshold = new THREE.Mesh(
      new THREE.BoxGeometry(2.15, 0.09, 0.18),
      new THREE.MeshBasicMaterial({ color: '#f43f5e' })
    );
    exitThreshold.position.set(0, 0.05, 0.0);
    exitGroup.add(exitThreshold);
    island.padGroup.add(exitGroup);

    // 3. Pre-Placed 2x2 Elemental Map Spires (Storm Spire, Frost Obelisk, Chrono Spire)
    for (const spirePt of round.preplacedSpires) {
      const spireRig = this.buildArticulatedStormSpireRig(
        spirePt.spireType || 'THUNDERCLAP'
      );
      spireRig.group.position.set(spirePt.x + 1.0, 0, spirePt.y + 1.0);
      island.padGroup.add(spireRig.group);
      island.spireRigs.push(spireRig);
    }

    // 4. Pre-Placed 2x2 Crimson Keep Pillars
    for (const obs of round.obstacles) {
      const ruinRig = this.buildPreplacedCrimsonKeepPillar(obs.x, obs.y);
      ruinRig.group.position.set(obs.x + 1.0, 0, obs.y + 1.0);
      island.padGroup.add(ruinRig.group);
      island.ruinRigs.push(ruinRig);
    }

    // 5. Rebuild Articulated Runner for the round's RunnerArchetype and reset to Top Border Entrance
    island.root.remove(island.runner.root);
    island.runner = this.buildArticulatedRunnerRig(
      island.playerColor,
      round.runnerType || 'SCOUT'
    );
    island.runner.root.position.set(spawnCx, 0, spawnBorderZ);
    island.root.add(island.runner.root);
    island.trailPoints = [];
    island.trailLine.geometry.setFromPoints([]);
  }

  /**
   * Builds a 2x2 Elemental Map Spire (`THUNDERCLAP` Storm Spire, `FROST_OBELISK` Frost Obelisk,
   * or `CHRONO_SPIRE` Chrono Spire) with distinct 3D geometry and AoE shader ring.
   */
  private buildArticulatedStormSpireRig(
    spireType: SpireType = 'THUNDERCLAP'
  ): SpireVisualRig {
    const group = new THREE.Group();
    const spec = TOWER_SPECS[spireType];

    // Square 2x2 Textured Cobblestone Foundation Pad
    const cobble = new THREE.Mesh(
      new THREE.BoxGeometry(1.94, 0.16, 1.94),
      this.cobbleFoundationMat
    );
    cobble.position.y = 0.08;
    cobble.receiveShadow = true;
    group.add(cobble);

    // Octagonal Textured Stone Pedestal
    const pedestalGeo = new THREE.CylinderGeometry(0.68, 0.82, 1.15, 8);
    pedestalGeo.rotateY(Math.PI / 8);
    const pedestal = new THREE.Mesh(pedestalGeo, this.playerStoneMat);
    pedestal.position.y = 0.65;
    pedestal.castShadow = true;
    pedestal.receiveShadow = true;
    group.add(pedestal);

    const accentHex =
      spireType === 'FROST_OBELISK'
        ? '#38bdf8'
        : spireType === 'CHRONO_SPIRE'
        ? '#c084fc'
        : '#f59e0b';
    const emissiveHex =
      spireType === 'FROST_OBELISK'
        ? '#0284c7'
        : spireType === 'CHRONO_SPIRE'
        ? '#9333ea'
        : '#d97706';
    const coreHex =
      spireType === 'FROST_OBELISK'
        ? '#bae6fd'
        : spireType === 'CHRONO_SPIRE'
        ? '#e9d5ff'
        : '#fde047';

    // 4 Elemental Buttresses
    const finMat = new THREE.MeshStandardMaterial({
      color: accentHex,
      emissive: emissiveHex,
      emissiveIntensity: 0.45,
      roughness: 0.25,
      metalness: 0.75,
    });
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const fin = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 1.25, 0.32),
        finMat
      );
      fin.position.set(Math.cos(ang) * 0.66, 0.68, Math.sin(ang) * 0.66);
      fin.rotation.y = -ang;
      fin.castShadow = true;
      group.add(fin);
    }

    // Levitating Elemental Crystal Crown
    const spireGeo =
      spireType === 'FROST_OBELISK'
        ? new THREE.ConeGeometry(0.42, 1.15, 6)
        : spireType === 'CHRONO_SPIRE'
        ? new THREE.IcosahedronGeometry(0.46, 0)
        : new THREE.OctahedronGeometry(0.46, 0);
    const spireMat = new THREE.MeshStandardMaterial({
      color: coreHex,
      emissive: accentHex,
      emissiveIntensity: 1.25,
      roughness: 0.15,
      metalness: 0.8,
    });
    const upperCore = new THREE.Mesh(spireGeo, spireMat);
    upperCore.position.y = 1.92;
    if (spireType === 'THUNDERCLAP') {
      upperCore.scale.set(1, 1.45, 1);
    }
    upperCore.castShadow = true;
    group.add(upperCore);

    // Dual Orthogonal Astrolabe Rings
    const innerRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.64, 0.045, 10, 32),
      new THREE.MeshBasicMaterial({ color: coreHex })
    );
    innerRing.position.y = 1.85;
    innerRing.rotation.x = Math.PI / 2.3;
    group.add(innerRing);

    const outerRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.8, 0.038, 10, 32),
      new THREE.MeshBasicMaterial({ color: accentHex })
    );
    outerRing.position.y = 1.85;
    outerRing.rotation.y = Math.PI / 3;
    group.add(outerRing);

    // Elemental Runic AoE Ring on the Grassland Floor
    const baseRange = spec.range;
    const aoeGeo = new THREE.PlaneGeometry(baseRange * 2, baseRange * 2);
    aoeGeo.rotateX(-Math.PI / 2);
    const aoeMat = createSpireAoEShader(baseRange, spireType);
    const aoeMesh = new THREE.Mesh(aoeGeo, aoeMat);
    aoeMesh.position.y = 0.035;
    group.add(aoeMesh);

    return {
      group,
      spireType,
      baseRange,
      upperCore,
      innerRing,
      outerRing,
      aoeMesh,
      aoeMat,
      recoil: 0,
    };
  }

  /**
   * Builds a 2x2 Pre-Placed Crimson Keep Pillar with textured crimson brick masonry,
   * iron-bound arrow slits, crenellated crown, and Overcharge-linking brazier jewel.
   */
  private buildPreplacedCrimsonKeepPillar(
    gridX: number,
    gridY: number
  ): RuinVisualRig {
    const group = new THREE.Group();
    const connGroup = new THREE.Group();
    group.add(connGroup);

    // 2x2 Square Textured Cobblestone Foundation Base
    const cobble = new THREE.Mesh(
      new THREE.BoxGeometry(1.92, 0.16, 1.92),
      this.cobbleFoundationMat
    );
    cobble.position.y = 0.08;
    cobble.receiveShadow = true;
    group.add(cobble);

    // Octagonal Textured Crimson Castle Turret Shaft
    const shaftGeo = new THREE.CylinderGeometry(0.62, 0.74, 1.32, 8);
    shaftGeo.rotateY(Math.PI / 8);
    const shaft = new THREE.Mesh(shaftGeo, this.crimsonStoneMat);
    shaft.position.y = 0.74;
    shaft.castShadow = true;
    shaft.receiveShadow = true;
    group.add(shaft);

    // 4 Iron-Bound Arrow Slits on Cardinal Faces
    const slitMat = new THREE.MeshStandardMaterial({
      color: '#1e1b18',
      roughness: 0.9,
    });
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      const slit = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.42, 0.08),
        slitMat
      );
      slit.position.set(Math.cos(ang) * 0.65, 0.82, Math.sin(ang) * 0.65);
      slit.rotation.y = -ang + Math.PI / 2;
      group.add(slit);
    }

    // Recessed Dark Timber Roof Platform inside Crown
    const roofFloor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.54, 0.54, 0.08, 8),
      this.timberRoofMat
    );
    roofFloor.rotation.y = Math.PI / 8;
    roofFloor.position.y = 1.42;
    group.add(roofFloor);

    // Crenellated Crown Rim + 8 Merlons
    const crownRim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 0.64, 0.22, 8),
      this.crimsonTrimMat
    );
    crownRim.rotation.y = Math.PI / 8;
    crownRim.position.y = 1.38;
    crownRim.castShadow = true;
    group.add(crownRim);

    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const merlon = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.22, 0.16),
        this.crimsonStoneMat
      );
      merlon.position.set(Math.cos(ang) * 0.58, 1.56, Math.sin(ang) * 0.58);
      merlon.rotation.y = -ang + Math.PI / 2;
      merlon.castShadow = true;
      group.add(merlon);
    }

    // Crest Jewel (ignites golden-amber when linked into a player Castle Pillar circuit!)
    const crystalMat = new THREE.MeshStandardMaterial({
      color: '#ef4444',
      emissive: '#dc2626',
      emissiveIntensity: 0.4,
      roughness: 0.3,
    });
    const crest = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.22, 0),
      crystalMat
    );
    crest.position.set(0, 1.66, 0);
    group.add(crest);

    return { group, connGroup, crystalMat, gridX, gridY };
  }

  /**
   * Builds a Player-Placed 2x2 Dressed Ashlar Limestone Castle Pillar
   * with arrow slits, crenellated crown, and omni-directional `connGroup`.
   */
  private buildWall3DMesh(
    x: number,
    y: number,
    playerColor = '#38bdf8'
  ): WallVisualEntry {
    const group = new THREE.Group();
    const connGroup = new THREE.Group();
    group.add(connGroup);

    // 1. Square 2x2 Textured Cobblestone Foundation Base
    const cobble = new THREE.Mesh(
      new THREE.BoxGeometry(1.92, 0.16, 1.92),
      this.cobbleFoundationMat
    );
    cobble.position.y = 0.08;
    cobble.receiveShadow = true;
    group.add(cobble);

    // 2. Tapered Octagonal Ashlar-Stone Castle Pillar Shaft
    const shaftGeo = new THREE.CylinderGeometry(0.62, 0.74, 1.34, 8);
    shaftGeo.rotateY(Math.PI / 8);
    const shaft = new THREE.Mesh(shaftGeo, this.playerStoneMat);
    shaft.position.y = 0.75;
    shaft.castShadow = true;
    shaft.receiveShadow = true;
    group.add(shaft);

    // Recessed Medieval Arrow Slits on Cardinal Faces
    const slitMat = new THREE.MeshStandardMaterial({
      color: '#1e293b',
      roughness: 0.9,
    });
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      const slit = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.42, 0.08),
        slitMat
      );
      slit.position.set(Math.cos(ang) * 0.65, 0.82, Math.sin(ang) * 0.65);
      slit.rotation.y = -ang + Math.PI / 2;
      group.add(slit);
    }

    // 3. Recessed Dark-Oak Timber Roof Platform inside Crown
    const timberTop = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.55, 0.08, 8),
      this.timberRoofMat
    );
    timberTop.rotation.y = Math.PI / 8;
    timberTop.position.y = 1.43;
    group.add(timberTop);

    // 4. Flared Crenellated Crown Rim & 8 Battlement Merlons
    const crownRim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.71, 0.64, 0.22, 8),
      this.playerTrimMat
    );
    crownRim.rotation.y = Math.PI / 8;
    crownRim.position.y = 1.38;
    crownRim.castShadow = true;
    group.add(crownRim);

    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const merlon = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.22, 0.16),
        this.playerStoneMat
      );
      merlon.position.set(Math.cos(ang) * 0.58, 1.56, Math.sin(ang) * 0.58);
      merlon.rotation.y = -ang + Math.PI / 2;
      merlon.castShadow = true;
      group.add(merlon);
    }

    // 5. Team-Colored Pennant Flag on Flagpole
    const flagGroup = new THREE.Group();
    flagGroup.position.set(0, 1.62, 0);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.03, 0.52, 6),
      new THREE.MeshStandardMaterial({ color: '#475569', metalness: 0.7 })
    );
    pole.position.y = 0.12;
    flagGroup.add(pole);

    const pennant = new THREE.Mesh(
      new THREE.ConeGeometry(0.14, 0.38, 3),
      new THREE.MeshStandardMaterial({
        color: playerColor,
        emissive: playerColor,
        emissiveIntensity: 0.35,
      })
    );
    pennant.rotation.z = -Math.PI / 2;
    pennant.position.set(0.18, 0.28, 0);
    flagGroup.add(pennant);

    const capCrystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.08, 0),
      new THREE.MeshBasicMaterial({ color: playerColor })
    );
    capCrystal.position.y = 1.65;
    capCrystal.add(flagGroup);
    group.add(capCrystal);

    return {
      group,
      connGroup,
      born: performance.now(),
      x,
      y,
      capCrystal,
    };
  }

  /**
   * Builds an angled Stone Curtain-Wall & Cobblestone Foundation Bridge from origin (0,0,0)
   * toward relative offset (dx, dz) along exact angle `Math.atan2(dx, dz)`.
   * Includes crenellated parapet merlons along the top of the wall bridge!
   */
  private createAngledWallBridge(
    dx: number,
    dz: number,
    fraction: number,
    wallMat: THREE.Material,
    trimMat: THREE.Material,
    isGhost = false
  ): THREE.Group {
    const bridge = new THREE.Group();
    const fullDist = Math.hypot(dx, dz);
    const spanLen = fullDist * fraction;
    const midDist = spanLen * 0.5;
    const angle = Math.atan2(dx, dz);

    bridge.position.set(
      (dx / fullDist) * midDist,
      0,
      (dz / fullDist) * midDist
    );
    bridge.rotation.y = angle;

    if (!isGhost) {
      const apron = new THREE.Mesh(
        new THREE.BoxGeometry(1.08, 0.15, spanLen + 0.1),
        this.cobbleFoundationMat
      );
      apron.position.y = 0.075;
      apron.receiveShadow = true;
      bridge.add(apron);
    }

    // Textured Stone Curtain Wall Segment
    const wallSeg = new THREE.Mesh(
      new THREE.BoxGeometry(0.56, 1.04, spanLen),
      wallMat
    );
    wallSeg.position.y = 0.56;
    wallSeg.castShadow = !isGhost;
    wallSeg.receiveShadow = !isGhost;
    bridge.add(wallSeg);

    // Parapet Walkway Ledge & Crenellated Merlon Cap
    const parapet = new THREE.Mesh(
      new THREE.BoxGeometry(0.68, 0.14, spanLen),
      trimMat
    );
    parapet.position.y = 1.12;
    bridge.add(parapet);

    if (!isGhost) {
      const merlon = new THREE.Mesh(
        new THREE.BoxGeometry(0.24, 0.18, Math.min(0.36, spanLen * 0.45)),
        wallMat
      );
      merlon.position.set(0, 1.26, 0);
      merlon.castShadow = true;
      bridge.add(merlon);
    }

    return bridge;
  }

  /**
   * Updates Spire Overcharge AoE Ring radius & glow shader uniform (used both for
   * committed towers and live cursor hover previews!).
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
    });
  }

  /**
   * Rebuilds all-directional (360° / 16-neighbor) stone wall bridges AND updates
   * Citadel Circuitry Keep Resonance & Spire Overcharge visuals!
   */
  private rebuildAllDirectionalConnections(
    island: IslandVisuals,
    player: PlayerState,
    round: RoundConfig
  ) {
    const allPillars: Array<{ x: number; y: number; kind: 'PLAYER' | 'RUIN' | 'SPIRE' }> = [
      ...player.towers.map((t) => ({ x: t.x, y: t.y, kind: 'PLAYER' as const })),
      ...round.obstacles.map((o) => ({ x: o.x, y: o.y, kind: 'RUIN' as const })),
      ...round.preplacedSpires.map((s) => ({ x: s.x, y: s.y, kind: 'SPIRE' as const })),
    ];

    // 1. Connect Player Castle Pillars in ALL touching directions (|dx| <= 2 && |dy| <= 2)
    for (const entry of island.towerMeshes.values()) {
      entry.connGroup.clear();
      for (const other of allPillars) {
        if (other.x === entry.x && other.y === entry.y) continue;
        const dx = other.x - entry.x;
        const dz = other.y - entry.y;
        if (Math.abs(dx) <= 2 && Math.abs(dz) <= 2) {
          const frac = other.kind === 'SPIRE' ? 0.62 : 0.52;
          const bridge = this.createAngledWallBridge(
            dx,
            dz,
            frac,
            this.playerStoneMat,
            this.playerTrimMat,
            false
          );
          entry.connGroup.add(bridge);
        }
      }
    }

    // 2. Compute full Citadel Circuitry (Keep Resonance + Spire Overcharge Tiers)
    const circuitry = computeCitadelCircuitry(round, player.towers);

    // 3. Connect Pre-Placed Crimson Keep Pillars & illuminate linked Keeps
    island.ruinRigs.forEach((ruin, idx) => {
      ruin.connGroup.clear();
      for (const other of allPillars) {
        if (other.x === ruin.gridX && other.y === ruin.gridY) continue;
        const dx = other.x - ruin.gridX;
        const dz = other.y - ruin.gridY;
        if (Math.abs(dx) <= 2 && Math.abs(dz) <= 2) {
          if (other.kind === 'PLAYER' || other.kind === 'RUIN') {
            const bridge = this.createAngledWallBridge(
              dx,
              dz,
              0.52,
              this.crimsonStoneMat,
              this.crimsonTrimMat,
              false
            );
            ruin.connGroup.add(bridge);
          }
        }
      }

      if (circuitry.linkedKeepIndices.has(idx)) {
        ruin.crystalMat.color.set('#fde047');
        ruin.crystalMat.emissive.set('#f59e0b');
        ruin.crystalMat.emissiveIntensity = 1.35;
      } else {
        ruin.crystalMat.color.set('#ef4444');
        ruin.crystalMat.emissive.set('#dc2626');
        ruin.crystalMat.emissiveIntensity = 0.4;
      }
    });

    // 4. Update Spire Overcharge AoE Ring radius & glow shader uniform
    this.applySpireOverchargeVisuals(island, circuitry.spireOverchargeTiers);
  }

  private syncIslandTowersAndPath(
    island: IslandVisuals,
    player: PlayerState,
    round: RoundConfig
  ) {
    const incomingIds = new Set(player.towers.map((t) => t.id));

    for (const [tid, entry] of island.towerMeshes.entries()) {
      if (!incomingIds.has(tid)) {
        this.spawnParticleBurst(
          island.offsetX + entry.x + 1.0,
          0.7,
          island.offsetZ + entry.y + 1.0,
          '#f43f5e',
          18
        );
        island.towerGroup.remove(entry.group);
        island.towerMeshes.delete(tid);
      }
    }

    for (const tower of player.towers) {
      if (!island.towerMeshes.has(tower.id)) {
        const entry = this.buildWall3DMesh(tower.x, tower.y, player.color);
        entry.group.position.set(tower.x + 1.0, 0, tower.y + 1.0);
        entry.group.scale.set(1, 0.05, 1);
        island.towerGroup.add(entry.group);
        island.towerMeshes.set(tower.id, entry);

        this.spawnParticleBurst(
          island.offsetX + tower.x + 1.0,
          0.35,
          island.offsetZ + tower.y + 1.0,
          '#fef08a',
          22
        );
        if (player.id === this.localPlayerId) {
          this.cameraShake = Math.max(this.cameraShake, 0.05);
        }
      }
    }

    this.rebuildAllDirectionalConnections(island, player, round);

    if (island.pathMesh) {
      island.root.remove(island.pathMesh);
      island.pathMesh.geometry.dispose();
      island.pathMesh = null;
    }

    const pathRes = computeFullMazePath(round, player.towers);
    if (pathRes.valid && pathRes.allPoints.length > 1) {
      const pts3D = pathRes.allPoints.map(
        (pt) => new THREE.Vector3(pt.x, 0.11, pt.y)
      );
      const curve = new THREE.CatmullRomCurve3(pts3D, false, 'catmullrom', 0.15);
      const tubeGeo = new THREE.TubeGeometry(
        curve,
        Math.min(340, pts3D.length * 4),
        0.08,
        6,
        false
      );
      const pathMat = createPathFlowShader(player.color);
      island.pathMesh = new THREE.Mesh(tubeGeo, pathMat);
      island.pathMat = pathMat;
      island.root.add(island.pathMesh);
    }

    if (player.id === this.localPlayerId) {
      const evalRes = evaluateMazeRunTime(round, player.towers);
      this.populateClapMarkers(island, evalRes.clapLocations, '#fde047');
    } else {
      island.clapMarkerGroup.clear();
    }
  }

  private populateClapMarkers(
    island: IslandVisuals,
    locations: GridPoint[],
    colorHex = '#fde047'
  ) {
    island.clapMarkerGroup.clear();
    const markerGeo = new THREE.OctahedronGeometry(0.21, 0);
    const markerMat = new THREE.MeshBasicMaterial({ color: colorHex });
    for (const loc of locations) {
      const m = new THREE.Mesh(markerGeo, markerMat);
      m.position.set(loc.x, 0.3, loc.y);
      island.clapMarkerGroup.add(m);
    }
  }

  private updateBuildHover() {
    if (
      !this.currentRoomState ||
      this.currentRoomState.phase !== 'BUILD' ||
      !this.localPlayerId
    ) {
      this.ghostGroup.visible = false;
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
      this.ghostGroup.visible = false;
      return;
    }

    this.raycaster.setFromCamera(this.mouseNDC, this.camera);
    const hits = this.raycaster.intersectObject(localIsland.hitPlane);
    if (hits.length === 0) {
      this.ghostGroup.visible = false;
      this.ghostConnGroup.clear();
      this.hoveredCell = null;
      this.hoveredExistingTower = null;
      localIsland.floorMat.uniforms.uCursorPos.value.set(-99, -99);
      this.clearPreviewPathMesh();
      if (this.cachedBaseEval) {
        this.populateClapMarkers(
          localIsland,
          this.cachedBaseEval.clapLocations,
          '#fde047'
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

    const localPt = hits[0].point;
    const relX = localPt.x - localIsland.offsetX;
    const relZ = localPt.z - localIsland.offsetZ;
    localIsland.floorMat.uniforms.uCursorPos.value.set(relX, relZ);

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
      if (this.hoveredExistingTower) {
        this.ghostGroup.visible = true;
        this.ghostGroup.position.set(
          localIsland.offsetX + this.hoveredExistingTower.x + 1.0,
          0,
          localIsland.offsetZ + this.hoveredExistingTower.y + 1.0
        );
        (this.ghostCore.material as THREE.MeshStandardMaterial).color.set('#f43f5e');
        (this.ghostCore.material as THREE.MeshStandardMaterial).emissive.set('#f43f5e');
        (this.ghostWire.material as THREE.LineBasicMaterial).color.set('#f43f5e');
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

    const validation = validateTowerPlacement(
      round,
      localPlayer.towers,
      placeX,
      placeY
    );

    this.ghostGroup.visible = true;
    this.ghostGroup.position.set(
      localIsland.offsetX + placeX + 1.0,
      0,
      localIsland.offsetZ + placeY + 1.0
    );

    const coreMat = this.ghostCore.material as THREE.MeshStandardMaterial;
    const wireMat = this.ghostWire.material as THREE.LineBasicMaterial;
    if (validation.valid) {
      coreMat.color.set('#22c55e');
      coreMat.emissive.set('#22c55e');
      wireMat.color.set('#4ade80');
    } else {
      coreMat.color.set('#ef4444');
      coreMat.emissive.set('#ef4444');
      wireMat.color.set('#f87171');
    }

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
          const previewBridge = this.createAngledWallBridge(
            dx,
            dz,
            0.92,
            coreMat,
            coreMat,
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
      const pts = validation.pathResult.allPoints.map(
        (p) =>
          new THREE.Vector3(
            localIsland.offsetX + p.x,
            0.16,
            localIsland.offsetZ + p.y
          )
      );
      if (pts.length > 1) {
        const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.15);
        const tubeGeo = new THREE.TubeGeometry(
          curve,
          Math.min(280, pts.length * 3),
          0.065,
          5,
          false
        );
        this.previewPathMat = createPathFlowShader('#fde047');
        this.previewPathMesh = new THREE.Mesh(tubeGeo, this.previewPathMat);
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
        deltaClaps > 0 ? '#4ade80' : '#fde047'
      );
      this.applySpireOverchargeVisuals(
        localIsland,
        previewEval.spireOverchargeTiers
      );
    } else if (this.cachedBaseEval) {
      this.populateClapMarkers(
        localIsland,
        this.cachedBaseEval.clapLocations,
        '#fde047'
      );
      this.applySpireOverchargeVisuals(
        localIsland,
        this.cachedBaseEval.spireOverchargeTiers
      );
    }

    this.onHoverStatusChange?.({
      cell: this.hoveredCell,
      screenX: this.lastPointerScreen.x,
      screenY: this.lastPointerScreen.y,
      valid: validation.valid,
      reason: validation.reason,
      deltaTime,
      deltaClaps,
      deltaKeeps,
      deltaOvercharge,
      previewTime,
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
            ? '#c084fc'
            : '#f59e0b';
        const burstColor =
          spireType === 'FROST_OBELISK'
            ? '#bae6fd'
            : spireType === 'CHRONO_SPIRE'
            ? '#e9d5ff'
            : '#fde047';
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
          28
        );
        if (
          ev.playerId === (this.focusedPlayerId || this.localPlayerId) ||
          this.arenaOverviewMode
        ) {
          this.cameraShake = Math.max(this.cameraShake, 0.22);
        }
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
          2.2,
          '#10b981'
        );
        this.spawnParticleBurst(
          island.offsetX + ev.x,
          0.9,
          island.offsetZ + ev.y,
          '#34d399',
          24
        );
      } else if (ev.type === 'WAYGATE') {
        this.spawnShockwaveEffect(
          island.offsetX + ev.x,
          island.offsetZ + ev.y,
          2.4,
          '#c084fc'
        );
        this.spawnParticleBurst(
          island.offsetX + ev.x,
          0.9,
          island.offsetZ + ev.y,
          '#e879f9',
          26
        );
      } else if (ev.type === 'FINISH') {
        this.spawnShockwaveEffect(
          island.offsetX + ev.x,
          island.offsetZ + ev.y,
          3.2,
          '#38bdf8'
        );
        this.spawnParticleBurst(
          island.offsetX + ev.x,
          1.1,
          island.offsetZ + ev.y,
          '#38bdf8',
          36
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

      const bankAngle = Math.max(-0.35, Math.min(0.35, -diff * 1.8));
      r.pelvis.rotation.z = bankAngle;

      if (!sim.finished) {
        r.walkPhase += 0.016 * sim.currentSpeed * 4.5;
        const swing = Math.sin(r.walkPhase) * 0.65;
        r.leftLeg.rotation.x = swing;
        r.rightLeg.rotation.x = -swing;
        r.leftArm.rotation.x = -swing * 0.8;
        r.rightArm.rotation.x = swing * 0.5;
        r.pelvis.position.y = 0.45 + Math.abs(Math.sin(r.walkPhase)) * 0.14;
        r.pelvis.rotation.x = 0.14;
      } else {
        r.pelvis.position.y = 0.65;
        r.pelvis.rotation.x = 0;
        r.pelvis.rotation.z = 0;
        r.root.rotation.y += 0.05;
      }

      // Show electric Slow Snare Cage & tint staff crystal based on active Spire/Aura/Tailwind modifiers
      r.snareCage.visible =
        sim.clapSlowRemaining > 0 ||
        sim.inPermafrostAura ||
        sim.hasTailwindMomentum ||
        sim.inFrostMire ||
        sim.inHasteRift;
      const cageMat = r.snareCage.material as THREE.MeshBasicMaterial;
      const staffMat = r.staffCrystal.material as THREE.MeshBasicMaterial;
      if (sim.clapSlowRemaining > 0) {
        cageMat.color.set('#fde047');
        staffMat.color.set('#fde047');
      } else if (sim.inPermafrostAura || sim.inFrostMire) {
        cageMat.color.set('#38bdf8');
        staffMat.color.set('#38bdf8');
      } else if (sim.hasTailwindMomentum) {
        cageMat.color.set('#34d399');
        staffMat.color.set('#34d399');
      } else if (sim.inHasteRift) {
        cageMat.color.set('#f43f5e');
        staffMat.color.set('#f43f5e');
      } else {
        staffMat.color.set('#67e8f9');
      }
      if (r.snareCage.visible) {
        r.snareCage.rotation.y += 0.08;
        r.snareCage.rotation.x += 0.05;
      }

      // Drive live Elemental Spire radial cooldown shader & gyroscope speeds from sim.towers
      island.spireRigs.forEach((spireRig, idx) => {
        const tState = sim.towers[`spire_${idx}`];
        if (tState) {
          const spec = TOWER_SPECS[spireRig.spireType];
          const charge =
            1.0 -
            Math.min(
              1.0,
              tState.cooldownRemaining / spec.cooldown
            );
          spireRig.aoeMat.uniforms.uChargeProgress.value = charge;
        }
      });

      // Append to energy ribbon trail
      const currentPt = new THREE.Vector3(sim.x, 0.25, sim.y);
      const lastPt = island.trailPoints[island.trailPoints.length - 1];
      if (!lastPt || lastPt.distanceTo(currentPt) > 0.18) {
        island.trailPoints.push(currentPt);
        if (island.trailPoints.length > 55) {
          island.trailPoints.shift();
        }
        island.trailLine.geometry.setFromPoints(island.trailPoints);
      }

      this.updateRunnerDOMBadge(playerId, sim);
    }
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
      pos[i * 3] = worldX + (Math.random() - 0.5) * 0.4;
      pos[i * 3 + 1] = worldY + Math.random() * 0.3;
      pos[i * 3 + 2] = worldZ + (Math.random() - 0.5) * 0.4;

      const angle = Math.random() * Math.PI * 2;
      const speed = 1.5 + Math.random() * 3.8;
      vels[i * 3] = Math.cos(angle) * speed;
      vels[i * 3 + 1] = 2.0 + Math.random() * 3.5;
      vels[i * 3 + 2] = Math.sin(angle) * speed;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: colorHex,
      size: 0.24,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.particleBursts.push({
      points,
      velocities: vels,
      age: 0,
      maxAge: 0.65,
    });
  }

  private spawnShockwaveEffect(
    worldX: number,
    worldZ: number,
    maxRadius: number,
    colorHex: string,
    boltTargetX?: number,
    boltTargetZ?: number
  ) {
    const ringGeo = new THREE.RingGeometry(0.72, 1.0, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(ringGeo, ringMat);
    mesh.position.set(worldX, 0.14, worldZ);
    this.scene.add(mesh);

    const domeGeo = new THREE.SphereGeometry(
      1.0,
      24,
      16,
      0,
      Math.PI * 2,
      0,
      Math.PI / 2
    );
    const domeMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.38,
      wireframe: true,
    });
    const dome = new THREE.Mesh(domeGeo, domeMat);
    dome.position.set(worldX, 0.05, worldZ);
    this.scene.add(dome);

    let bolt: THREE.Line | undefined;
    if (boltTargetX !== undefined && boltTargetZ !== undefined) {
      const start = new THREE.Vector3(worldX, 2.1, worldZ);
      const end = new THREE.Vector3(boltTargetX, 0.9, boltTargetZ);
      const pts: THREE.Vector3[] = [start];
      for (let s = 1; s <= 4; s++) {
        const p = start.clone().lerp(end, s / 5);
        p.x += (Math.random() - 0.5) * 0.55;
        p.y += (Math.random() - 0.2) * 0.5;
        p.z += (Math.random() - 0.5) * 0.55;
        pts.push(p);
      }
      pts.push(end);

      const boltGeo = new THREE.BufferGeometry().setFromPoints(pts);
      const boltMat = new THREE.LineBasicMaterial({
        color: '#fef08a',
        transparent: true,
        opacity: 1.0,
      });
      bolt = new THREE.Line(boltGeo, boltMat);
      this.scene.add(bolt);
    }

    this.shockwaves.push({
      mesh,
      dome,
      bolt,
      age: 0,
      maxAge: 0.55,
      maxRadius,
    });
  }

  private createIslandDOMElements(player: PlayerState) {
    const header = document.createElement('div');
    header.className = 'island-3d-badge';
    header.style.setProperty('--player-color', player.color);
    this.labelLayer.appendChild(header);
    this.labelElements.set(player.id, header);

    const runnerBadge = document.createElement('div');
    runnerBadge.className = 'runner-3d-badge';
    runnerBadge.style.setProperty('--player-color', player.color);
    this.labelLayer.appendChild(runnerBadge);
    this.runnerLabels.set(player.id, runnerBadge);
  }

  private updateIslandHeaderBadge(player: PlayerState) {
    const el = this.labelElements.get(player.id);
    if (!el) return;
    el.innerHTML = `
      <span class="badge-dot" style="background:${player.color}"></span>
      <strong>${player.name}</strong>
      <span class="badge-meta">${player.pathDistance.toFixed(0)}m</span>
    `;
  }

  private updateRunnerDOMBadge(playerId: string, sim: RunnerSimState) {
    const el = this.runnerLabels.get(playerId);
    if (!el || !this.currentRoomState) return;
    if (this.currentRoomState.phase !== 'RUN') {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'flex';
    const icon =
      sim.clapSlowRemaining > 0
        ? '⚡ '
        : sim.inPermafrostAura || sim.inFrostMire
        ? '❄️ '
        : sim.hasTailwindMomentum
        ? '💨 '
        : sim.inHasteRift
        ? '🔥 '
        : '';
    const stackSuffix =
      sim.exposureStacks > 1 ? ` ×${sim.exposureStacks}` : '';
    const timeVal = sim.finished
      ? `🏁 ${sim.finishTimeSeconds.toFixed(2)}s`
      : `${icon}${(sim.distanceTraveled / sim.baseSpeed).toFixed(1)}s${stackSuffix}`;
    el.textContent = timeVal;
  }

  public renderFrame(dt: number) {
    const now = performance.now();
    const uTimeVal = now * 0.001;

    this.voidSeaMat.uniforms.uTime.value = uTimeVal;

    const panSpeed = 22 * dt;
    if (this.keysDown.has('arrowup')) this.camGoalTarget.z -= panSpeed;
    if (this.keysDown.has('arrowdown')) this.camGoalTarget.z += panSpeed;
    if (this.keysDown.has('arrowleft')) this.camGoalTarget.x -= panSpeed;
    if (this.keysDown.has('arrowright')) this.camGoalTarget.x += panSpeed;

    const lerpFactor = Math.min(1, dt * 8.5);
    this.camTarget.lerp(this.camGoalTarget, lerpFactor);
    this.camRadius += (this.camGoalRadius - this.camRadius) * lerpFactor;
    this.camAzimuth += (this.camGoalAzimuth - this.camAzimuth) * lerpFactor;

    let shakeX = 0;
    let shakeY = 0;
    if (this.cameraShake > 0.001) {
      shakeX = (Math.random() - 0.5) * this.cameraShake;
      shakeY = (Math.random() - 0.5) * this.cameraShake;
      this.cameraShake = Math.max(0, this.cameraShake - dt * 0.85);
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

    if (this.previewPathMat) {
      this.previewPathMat.uniforms.uTime.value = uTimeVal;
    }

    for (const island of this.islands.values()) {
      island.floorMat.uniforms.uTime.value = uTimeVal;
      island.foamMat.uniforms.uTime.value = uTimeVal;
      if (island.pathMat) {
        island.pathMat.uniforms.uTime.value = uTimeVal;
      }

      // Phase-gate and animate predicted clap detonation markers during BUILD phase
      island.clapMarkerGroup.visible =
        this.currentRoomState?.phase === 'BUILD';
      if (island.clapMarkerGroup.visible) {
        island.clapMarkerGroup.children.forEach((child, idx) => {
          child.rotation.y = uTimeVal * 2.5 + idx * 0.5;
          child.position.y = 0.3 + Math.sin(uTimeVal * 4.0 + idx) * 0.05;
        });
      }

      // Animate player-built Castle Pillars rising & pennant flags fluttering
      for (const entry of island.towerMeshes.values()) {
        const ageSec = (now - entry.born) / 1000;
        if (ageSec < 0.25) {
          const t = Math.min(1, ageSec / 0.22);
          const easeOut = 1 - Math.pow(1 - t, 3);
          entry.group.scale.y = Math.max(0.05, easeOut);
        } else {
          entry.group.scale.y = 1.0;
        }
        entry.capCrystal.rotation.y =
          Math.sin(uTimeVal * 3.5 + entry.x * 0.7 + entry.y * 0.5) * 0.28;
      }

      // Animate Storm Spires
      for (const spireRig of island.spireRigs) {
        spireRig.aoeMat.uniforms.uTime.value = uTimeVal;
        if (this.currentRoomState?.phase === 'BUILD') {
          spireRig.aoeMat.uniforms.uChargeProgress.value = 1.0;
        }
        const charge = spireRig.aoeMat.uniforms.uChargeProgress.value;
        const speed = 1.2 + charge * 3.2;
        spireRig.innerRing.rotation.z += dt * speed;
        spireRig.outerRing.rotation.x += dt * speed * 0.8;

        if (spireRig.recoil > 0) {
          spireRig.recoil = Math.max(0, spireRig.recoil - dt * 2.8);
        }
        spireRig.upperCore.rotation.y = uTimeVal * 1.6;
        spireRig.upperCore.position.y =
          1.9 + Math.sin(uTimeVal * 3.5) * 0.07 - spireRig.recoil * 0.32;
      }

      // Idle breathing for Runner during BUILD phase
      if (this.currentRoomState?.phase === 'BUILD') {
        island.runner.pelvis.position.y =
          0.45 + Math.sin(uTimeVal * 3.2) * 0.06;
        island.runner.staffCrystal.rotation.y = uTimeVal * 2.5;
      }

      // Hide island 3D badge on the currently focused island during BUILD to prevent HUD clutter
      const headerEl = this.labelElements.get(island.playerId);
      if (headerEl) {
        const isFocusedBuild =
          !this.arenaOverviewMode &&
          this.currentRoomState?.phase === 'BUILD' &&
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
      if (runnerEl && this.currentRoomState?.phase === 'RUN') {
        const rPos = new THREE.Vector3(
          island.offsetX + island.runner.root.position.x,
          1.85,
          island.offsetZ + island.runner.root.position.z
        );
        this.projectToDOM(rPos, runnerEl);
      } else if (runnerEl) {
        runnerEl.style.display = 'none';
      }
    }

    // Update Shockwaves
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.age += dt;
      if (sw.age >= sw.maxAge) {
        this.scene.remove(sw.mesh);
        this.scene.remove(sw.dome);
        if (sw.bolt) this.scene.remove(sw.bolt);
        sw.mesh.geometry.dispose();
        sw.dome.geometry.dispose();
        this.shockwaves.splice(i, 1);
      } else {
        const t = sw.age / sw.maxAge;
        const ease = 1 - Math.pow(1 - t, 3);
        const rad = 0.4 + ease * sw.maxRadius;
        sw.mesh.scale.set(rad, rad, 1);
        (sw.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.9;
        sw.dome.scale.set(rad, rad * 0.65, rad);
        (sw.dome.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.35;
        if (sw.bolt) {
          (sw.bolt.material as THREE.LineBasicMaterial).opacity = Math.max(
            0,
            1 - t * 2.2
          );
        }
      }
    }

    // Update GPU Particle Bursts
    for (let i = this.particleBursts.length - 1; i >= 0; i--) {
      const pb = this.particleBursts[i];
      pb.age += dt;
      if (pb.age >= pb.maxAge) {
        this.scene.remove(pb.points);
        pb.points.geometry.dispose();
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
          pb.velocities[j + 1] -= 9.8 * dt;
        }
        posAttr.needsUpdate = true;
        (pb.points.material as THREE.PointsMaterial).opacity =
          1 - pb.age / pb.maxAge;
      }
    }

    this.composer.render();
  }

  private projectToDOM(worldVec: THREE.Vector3, el: HTMLElement) {
    const projected = worldVec.clone().project(this.camera);
    if (projected.z > 1) {
      el.style.display = 'none';
      return;
    }
    const x = (projected.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-projected.y * 0.5 + 0.5) * window.innerHeight;
    el.style.display = 'flex';
    el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
  }
}
