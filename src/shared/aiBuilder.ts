import { computeFullMazePath, validateTowerPlacement } from './pathfinding.js';
import { evaluateMazeRunTime } from './simulation.js';
import {
  PathResult,
  PlacedTower,
  RoundConfig,
  TOWER_SPECS,
} from './types.js';

/**
 * Scores a path by combining raw distance with Elemental Spire AoE coverage
 * (weighting Frost Obelisk Permafrost Aura and Chrono/Storm Spire radii).
 */
function scorePathWithMapFeatures(round: RoundConfig, path: PathResult): number {
  let score = path.totalDistance;

  for (const pt of path.allPoints) {
    for (const spire of round.preplacedSpires) {
      const sType = spire.spireType || 'THUNDERCLAP';
      const spireRange = TOWER_SPECS[sType].range;
      const dist = Math.hypot(pt.x - (spire.x + 1.0), pt.y - (spire.y + 1.0));
      if (dist <= spireRange) {
        score += sType === 'FROST_OBELISK' ? 1.45 : sType === 'CHRONO_SPIRE' ? 1.25 : 1.05;
      }
    }
  }
  return score;
}

/**
 * Generates a Castle-Pillar-only Mazing Contest layout across the 20x26 grassland field,
 * using both multi-directional diagonal chains and wide switchbacks around Red Keep Pillars & Storm Spires.
 */
export function generateMazeLayout(
  round: RoundConfig,
  difficulty: 'NOVICE' | 'ARCHITECT' | 'GRANDMASTER' = 'GRANDMASTER',
  style: 'SWITCHBACK' | 'SPIRAL' | 'CLAP_CHAIN' = 'SWITCHBACK'
): PlacedTower[] {
  let gold = round.startingGold;
  const wallCost = TOWER_SPECS.BLOCK.goldCost;
  const towers: PlacedTower[] = [];
  let idCounter = 1;

  const tryAddWall = (x: number, y: number): boolean => {
    if (gold < wallCost) return false;
    const check = validateTowerPlacement(round, towers, x, y);
    if (!check.valid) return false;

    towers.push({
      id: `ai_${idCounter++}_${Date.now()}`,
      type: 'BLOCK',
      x,
      y,
      createdAt: Date.now(),
    });
    gold -= wallCost;
    return true;
  };

  const maxWalls =
    difficulty === 'NOVICE'
      ? Math.floor((round.startingGold / wallCost) * 0.55)
      : difficulty === 'ARCHITECT'
      ? Math.floor((round.startingGold / wallCost) * 0.82)
      : 999;

  // Phase 1: Scaffold multi-directional diagonals, spirals, or wide 6-row switchbacks across the 20x26 arena
  const candidateCoords: Array<{ x: number; y: number }> = [];
  const gw = round.gridWidth;
  const gh = round.gridHeight;

  if (style === 'SPIRAL') {
    // Multi-directional diamond & octagonal ring scaffold
    const cx = Math.floor(gw / 2) - 1;
    const cy = Math.floor(gh / 2) - 1;
    const radii = [7, 4];
    for (const rad of radii) {
      for (let step = -rad; step <= rad; step += 2) {
        // Diagonal diamond edges (45-degree connected pillars!)
        const d1x = cx + step;
        const d1y = cy - (rad - Math.abs(step));
        const d2x = cx + step;
        const d2y = cy + (rad - Math.abs(step));
        if (step !== 0) {
          candidateCoords.push({ x: d1x, y: d1y });
          candidateCoords.push({ x: d2x, y: d2y });
        }
      }
    }
  } else {
    const spireRows = round.preplacedSpires
      .map((s) => s.y)
      .sort((a, b) => a - b);
    const defaultRows = [3, 7, 11, 15, 19, 22].filter((r) => r <= gh - 4);
    const rows =
      style === 'CLAP_CHAIN' && spireRows.length >= 2
        ? spireRows
        : defaultRows;

    rows.forEach((ry, idx) => {
      const openLeft = idx % 2 === 0;
      if (openLeft) {
        for (let x = gw - 2; x >= 4; x -= 2) {
          // Slight angled wave on alternate rows to create diagonal & half-tile connections
          const yOff = idx % 3 === 1 && x % 4 === 0 ? 1 : 0;
          candidateCoords.push({ x, y: ry + yOff });
        }
      } else {
        for (let x = 0; x <= gw - 6; x += 2) {
          const yOff = idx % 3 === 2 && x % 4 === 2 ? -1 : 0;
          candidateCoords.push({ x, y: ry + yOff });
        }
      }
    });
  }

  const scaffoldLimit = Math.min(
    maxWalls,
    Math.floor((round.startingGold / wallCost) * 0.55)
  );
  for (const pt of candidateCoords) {
    if (towers.length >= scaffoldLimit || gold < wallCost) break;
    tryAddWall(pt.x, pt.y);
  }

  // Phase 2: True Simulation-Aware Spire-Wrapping, Mire-Routing & Haste-Avoidance Optimizer
  let iterations = 0;
  while (gold >= wallCost && towers.length < maxWalls && iterations < 55) {
    iterations++;
    const currentPath = computeFullMazePath(round, towers);
    if (!currentPath.valid) break;
    const currentGeoScore = scorePathWithMapFeatures(round, currentPath);
    const currentSimEval = evaluateMazeRunTime(round, towers);
    const currentComposite =
      currentSimEval.finishTimeSeconds * 3.5 +
      currentGeoScore * 0.35 +
      currentSimEval.clapsTaken * 1.2 +
      currentSimEval.linkedKeeps * 1.4 +
      currentSimEval.overchargedSpires * 2.2;

    const geoCandidates: Array<{ x: number; y: number; geoScore: number }> = [];
    const tested = new Set<string>();

    for (let i = 1; i < currentPath.allPoints.length - 1; i++) {
      const wp = currentPath.allPoints[i];
      const baseCellX = Math.floor(wp.x);
      const baseCellY = Math.floor(wp.y);

      for (let ox = -1; ox <= 0; ox++) {
        for (let oy = -1; oy <= 0; oy++) {
          const tx = baseCellX + ox;
          const ty = baseCellY + oy;
          const key = `${tx},${ty}`;
          if (tested.has(key)) continue;
          tested.add(key);

          const check = validateTowerPlacement(round, towers, tx, ty);
          if (check.valid && check.pathResult) {
            const geoScore = scorePathWithMapFeatures(round, check.pathResult);
            if (geoScore > currentGeoScore + 0.1) {
              geoCandidates.push({ x: tx, y: ty, geoScore });
            }
          }
        }
      }
    }

    // Evaluate top geometric candidates with full deterministic simulation
    geoCandidates.sort((a, b) => b.geoScore - a.geoScore);
    const topSlice = geoCandidates.slice(0, 6);

    let bestCandidate: { x: number; y: number; score: number } | null = null;
    for (const cand of topSlice) {
      const simEval = evaluateMazeRunTime(round, [
        ...towers,
        { id: '__cand__', type: 'BLOCK', x: cand.x, y: cand.y, createdAt: 0 },
      ]);
      const composite =
        simEval.finishTimeSeconds * 3.5 +
        cand.geoScore * 0.35 +
        simEval.clapsTaken * 1.2 +
        simEval.linkedKeeps * 1.4 +
        simEval.overchargedSpires * 2.2;
      if (
        composite > currentComposite + 0.25 &&
        (!bestCandidate || composite > bestCandidate.score)
      ) {
        bestCandidate = { x: cand.x, y: cand.y, score: composite };
      }
    }

    if (bestCandidate) {
      tryAddWall(bestCandidate.x, bestCandidate.y);
    } else {
      break;
    }
  }

  return towers;
}
