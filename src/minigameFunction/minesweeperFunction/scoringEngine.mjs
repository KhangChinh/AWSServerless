/**
 * Calculate time penalty based on completion time
 * Faster = less penalty
 */
function calculateTimePenalty(totalSeconds, mineCount) {
  // Base: 1 mine per second acceptable
  const expectedTime = mineCount * 1;
  const excess = Math.max(0, totalSeconds - expectedTime);

  // 1 point penalty per 2 seconds excess
  return Math.floor(excess / 2);
}

/**
 * Calculate mistake penalty from action logs
 * Track wrong flags, false revelations, etc.
 */
function calculateMistakePenalty(actionLogs, solutionGrid) {
  let mistakeCount = 0;

  actionLogs.forEach(action => {
    const [r, c] = action.cell;
    const cellValue = solutionGrid[r][c];

    // Flagging a non-mine cell
    if (action.value === 'flag' && cellValue !== -1) {
      mistakeCount++;
    }

    // Revealing a mine (should not happen in win packet, but check anyway)
    if (action.value === 'reveal' && cellValue === -1) {
      mistakeCount++;
    }
  });

  // 5 points per mistake
  return mistakeCount * 5;
}

/**
 * Main scoring function
 * baseScore - timePenalty - mistakePenalty
 */
export function calculateScore(config, actionLogs, solutionGrid, startTime, endTime) {
  const baseScore = config.maxScoreCap || 1000;
  
  // Calculate durations
  const totalSeconds = endTime - startTime;
  const timePenalty = calculateTimePenalty(totalSeconds, config.mineCount);
  const mistakePenalty = calculateMistakePenalty(actionLogs, solutionGrid);

  const finalScore = Math.max(0, baseScore - timePenalty - mistakePenalty);

  return {
    baseScore,
    timePenalty,
    mistakePenalty,
    finalScore,
    completionTimeSeconds: totalSeconds
  };
}

/**
 * Calculate reward coins
 */
export function calculateRewardCoins(finalScore, config) {
  // Base reward from config
  const baseReward = config.rewardStones || 10;
  
  // Bonus for high score (every 100 points = 1 coin)
  const scoreBonus = Math.floor(finalScore / 100);

  return baseReward + scoreBonus;
}

/**
 * Determine if record was beaten
 */
export function isNewRecord(finalScore, previousBest) {
  if (!previousBest) return true;
  return finalScore > previousBest;
}
