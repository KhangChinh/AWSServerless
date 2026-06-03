import crypto from 'crypto';

/**
 * Generate deterministic seed from level + timestamp
 */
export function generateSeed(levelId, timestamp) {
  const data = `${levelId}_${timestamp}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Generate mine positions based on seed + config
 * Uses seed as RNG to generate deterministic positions
 */
export function generateMinePositions(seed, gridSize, mineCount, safeStartRadius = 1) {
  const [rows, cols] = gridSize.split('x').map(Number);
  const safeZone = getSafeZone(rows, cols, safeStartRadius);
  const mines = new Set();

  // Use seed as RNG seed
  let seededRandom = createSeededRandom(seed);

  while (mines.size < mineCount) {
    const idx = Math.floor(seededRandom() * (rows * cols));
    const row = Math.floor(idx / cols);
    const col = idx % cols;

    if (!safeZone.has(`${row},${col}`) && !mines.has(`${row},${col}`)) {
      mines.add(`${row},${col}`);
    }
  }

  return Array.from(mines).map(pos => {
    const [r, c] = pos.split(',').map(Number);
    return [r, c];
  });
}

/**
 * Get safe zone coordinates (center area where player can safely click first)
 */
function getSafeZone(rows, cols, radius) {
  const zone = new Set();
  const centerRow = Math.floor(rows / 2);
  const centerCol = Math.floor(cols / 2);

  for (let r = centerRow - radius; r <= centerRow + radius; r++) {
    for (let c = centerCol - radius; c <= centerCol + radius; c++) {
      if (r >= 0 && r < rows && c >= 0 && c < cols) {
        zone.add(`${r},${c}`);
      }
    }
  }
  return zone;
}

/**
 * Seeded random number generator (simple LCG)
 */
function createSeededRandom(seed) {
  let state = 0;
  for (let i = 0; i < seed.length; i++) {
    state = ((state << 5) - state + seed.charCodeAt(i)) | 0;
  }

  return function() {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/**
 * Generate solution grid (for validation on server)
 */
export function generateSolutionGrid(rows, cols, mines) {
  const grid = Array(rows).fill(null).map(() => Array(cols).fill(0));
  const mineSet = new Set(mines.map(([r, c]) => `${r},${c}`));

  mines.forEach(([r, c]) => {
    grid[r][c] = -1; // -1 = mine
  });

  // Count adjacent mines
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== -1) {
        let count = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && mineSet.has(`${nr},${nc}`)) {
              count++;
            }
          }
        }
        grid[r][c] = count;
      }
    }
  }

  return grid;
}

/**
 * Validate final grid against solution
 */
export function validateBoard(finalGrid, solutionGrid) {
  if (!finalGrid || !solutionGrid) return false;

  const rows = solutionGrid.length;
  const cols = solutionGrid[0].length;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (finalGrid[r][c] !== solutionGrid[r][c]) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Check if win packet is valid
 */
export function validateWinPacket(packet, config, startTime) {
  const { actionLogs, finalGrid } = packet;

  // Check actionLogs timestamps
  if (!Array.isArray(actionLogs) || actionLogs.length === 0) {
    return { valid: false, reason: 'empty_action_logs' };
  }

  const firstTs = actionLogs[0].timestamp;
  const lastTs = actionLogs[actionLogs.length - 1].timestamp;
  const isSeconds = firstTs < 1e12;
  const toMs = (t) => (isSeconds ? t * 1000 : t);

  // Verify timestamps are sequential and not too fast
  for (let i = 1; i < actionLogs.length; i++) {
    const timeDiffMs = toMs(actionLogs[i].timestamp) - toMs(actionLogs[i - 1].timestamp);
    if (timeDiffMs < 100) { // At least 100ms between actions
      return { valid: false, reason: 'actions_too_fast' };
    }
  }

  // Ensure action logs are not before session start time
  const startMs = startTime * 1000;
  if (toMs(firstTs) < startMs) {
    return { valid: false, reason: 'action_before_start' };
  }

  // Verify total time not suspiciously fast
  const totalSeconds = (toMs(lastTs) - toMs(firstTs)) / 1000;
  const minPossibleTime = config.mineCount * 0.5; // Minimum 0.5s per mine

  if (totalSeconds < minPossibleTime) {
    return { valid: false, reason: 'completed_too_fast' };
  }

  return { valid: true };
}
