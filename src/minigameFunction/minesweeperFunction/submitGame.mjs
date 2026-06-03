import { GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../database.mjs';
import { successResponse, errorResponse } from '../../response.mjs';
import { generateMinePositions, generateSolutionGrid, validateWinPacket, validateBoard } from './minesweeperService.mjs';
import { calculateScore, calculateRewardCoins, isNewRecord } from './scoringEngine.mjs';

const TABLE_NAME = process.env.TABLE_NAME;

/**
 * Handler for POST /minigame/minesweeper/submit
 * Validate and score completed game
 */
export async function handler(event) {
  try {
    // Get userId from authorizer context
    const authorizer = event.requestContext?.authorizer;
    const userId = authorizer?.jwt?.claims?.sub || authorizer?.claims?.sub || authorizer?.principalId;
    
    const { levelId, finalGrid, actionLogs } = JSON.parse(event.body || '{}');

    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    if (!levelId || !finalGrid || !actionLogs) {
      return errorResponse(400, 'Missing required fields');
    }

    const levelKey = levelId.startsWith('minesweeper#') ? levelId : `minesweeper#${levelId}`;
    const levelSlug = levelKey.split('#').slice(1).join('#');

    // Get active game record
    const activeGame = await getActiveGame(userId);
    if (!activeGame || activeGame.currentLevel !== levelKey) {
      return errorResponse(400, 'No active game found');
    }

    // Get level config for validation
    const levelConfig = await getMinigameConfig(levelKey);
    if (!levelConfig) {
      return errorResponse(404, 'Level config not found');
    }

    if (!activeGame.seed) {
      return errorResponse(400, 'Active game seed missing');
    }

    // Validate win packet
    const validation = validateWinPacket(
      { actionLogs, finalGrid },
      levelConfig.baseMapConfig,
      activeGame.startTime
    );
    if (!validation.valid) {
      return errorResponse(400, `Validation failed: ${validation.reason}`);
    }

    // Validate board against server's solution
    const mines = generateMinePositions(
      activeGame.seed,
      levelConfig.baseMapConfig.gridSize,
      levelConfig.baseMapConfig.mineCount,
      levelConfig.baseMapConfig.safeStartRadius
    );
    const [rows, cols] = levelConfig.baseMapConfig.gridSize.split('x').map(Number);
    const solutionGrid = generateSolutionGrid(rows, cols, mines);

    const boardValid = validateBoard(finalGrid, solutionGrid);
    if (!boardValid) {
      return errorResponse(400, 'Board validation failed - grid mismatch');
    }

    // Calculate score
    const endTime = Math.floor(Date.now() / 1000);
    const scoreData = calculateScore(
      levelConfig.baseMapConfig,
      actionLogs,
      solutionGrid,
      activeGame.startTime,
      endTime
    );

    // Calculate coins reward
    const reward = calculateRewardCoins(scoreData.finalScore, levelConfig);

    // Check if new record
    const existingScore = await getPersonalBest(userId, levelSlug);
    const isRecord = isNewRecord(scoreData.finalScore, existingScore?.personalBest);

    // Update score record
    if (isRecord || !existingScore) {
      await updateScoreRecord(userId, levelSlug, scoreData.finalScore);
    }

    // Update inventory with minesweeper history
    await updateInventory(userId, levelSlug, scoreData.finalScore, isRecord);

    // Add coins to user wallet (simplified - adjust based on your user schema)
    await addRewardCoins(userId, reward);

    // Delete active game record
    await deleteActiveGame(userId);

    return successResponse({
      score: scoreData.finalScore,
      reward: reward,
      isNewRecord: isRecord,
      breakdown: {
        baseScore: scoreData.baseScore,
        timePenalty: scoreData.timePenalty,
        mistakePenalty: scoreData.mistakePenalty,
        completionTime: scoreData.completionTimeSeconds
      }
    });
  } catch (error) {
    console.error('Submit game error:', error);
    return errorResponse(500, 'Internal server error');
  }
}

/**
 * Get active game record
 */
async function getActiveGame(userId) {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `usr_${userId}`,
        SK: 'active_game#minesweeper'
      }
    }));
    return result.Item;
  } catch (error) {
    console.error('Get active game error:', error);
    return null;
  }
}

/**
 * Get minigame config
 */
async function getMinigameConfig(levelId) {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: 'minigame',
        SK: `minesweeper#${levelId}`
      }
    }));
    return result.Item;
  } catch (error) {
    console.error('Get config error:', error);
    return null;
  }
}

/**
 * Get personal best score
 */
async function getPersonalBest(userId, levelId) {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `usr_${userId}`,
        SK: `score#minesweeper#${levelId}`
      }
    }));
    return result.Item;
  } catch (error) {
    console.error('Get score error:', error);
    return null;
  }
}

/**
 * Update score record
 */
async function updateScoreRecord(userId, levelId, score) {
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `usr_${userId}`,
        SK: `score#minesweeper#${levelId}`,
        personalBest: score,
        achievedAt: new Date().toISOString(),
        levelId: levelId,
        gameType: 'minesweeper'
      }
    }));
  } catch (error) {
    console.error('Update score error:', error);
  }
}

/**
 * Update inventory with minesweeper history
 */
async function updateInventory(userId, levelId, score, isRecord) {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `usr_${userId}`,
        SK: 'inventory'
      }
    }));

    let minesweeperHistory = result.Item?.minesweeper || [];

    // Check if level already exists
    const levelIdx = minesweeperHistory.findIndex(h => h.levelId === levelId);
    if (levelIdx !== -1 && isRecord) {
      // Update existing record
      minesweeperHistory[levelIdx] = {
        levelId,
        personalBest: score,
        achievedAt: new Date().toISOString()
      };
    } else if (levelIdx === -1) {
      // Add new record
      minesweeperHistory.push({
        levelId,
        personalBest: score,
        achievedAt: new Date().toISOString()
      });
    }

    // Update inventory
    const updatedInventory = {
      ...result.Item,
      minesweeper: minesweeperHistory,
      updatedAt: new Date().toISOString()
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedInventory
    }));
  } catch (error) {
    console.error('Update inventory error:', error);
  }
}

/**
 * Add reward coins to user
 */
async function addRewardCoins(userId, coins) {
  try {
    // Simplified: assume user has a wallet record
    // Adjust based on your actual user schema
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `usr_${userId}`,
        SK: 'profile'
      }
    }));

    if (result.Item) {
      result.Item.entertainCoins = (result.Item.entertainCoins || 0) + coins;
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: result.Item
      }));
    }
  } catch (error) {
    console.error('Add reward error:', error);
  }
}

/**
 * Delete active game record
 */
async function deleteActiveGame(userId) {
  try {
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `usr_${userId}`,
        SK: 'active_game#minesweeper'
      }
    }));
  } catch (error) {
    console.error('Delete active game error:', error);
  }
}
