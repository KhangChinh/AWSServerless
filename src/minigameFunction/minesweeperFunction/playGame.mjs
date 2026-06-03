import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../database.mjs';
import { successResponse, errorResponse } from '../../response.mjs';
import { generateSeed, generateMinePositions, generateSolutionGrid } from './minesweeperService.mjs';

const TABLE_NAME = process.env.TABLE_NAME;

/**
 * Handler for POST /minigame/minesweeper/play
 * Create new game session
 */
export async function handler(event) {
  try {
    // Get userId from authorizer context
    const authorizer = event.requestContext?.authorizer;
    const userId = authorizer?.jwt?.claims?.sub || authorizer?.claims?.sub || authorizer?.principalId;
    
    const { levelId } = JSON.parse(event.body || '{}');

    if (!userId) {
      return errorResponse(401, 'Unauthorized');
    }

    if (!levelId) {
      return errorResponse(400, 'levelId required');
    }
    // Sai(kiệt note)

    const levelKey = levelId.startsWith('minesweeper#') ? levelId : `minesweeper#${levelId}`;

    // Get level config from minigame table
    const levelConfig = await getMinigameConfig(levelKey);
    if (!levelConfig) {
      return errorResponse(404, 'Level not found');
    }

    // Generate seed
    const now = Date.now();
    const seed = generateSeed(levelKey, now);

    // Generate mine positions
    const { gridSize, mineCount, safeStartRadius, baseMapConfig } = levelConfig;
    const mines = generateMinePositions(
      seed,
      baseMapConfig.gridSize,
      baseMapConfig.mineCount,
      baseMapConfig.safeStartRadius
    );

    // Generate solution grid for server-side validation
    const [rows, cols] = baseMapConfig.gridSize.split('x').map(Number);
    const solutionGrid = generateSolutionGrid(rows, cols, mines);

    // Create active game record
    const activeGameRecord = {
      PK: `usr_${userId}`,
      SK: 'active_game#minesweeper',
      currentLevel: levelKey,
      seed: seed,
      solutionGrid: solutionGrid,
      startTime: Math.floor(now / 1000),
      status: 'playing',
      createdAt: new Date().toISOString()
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: activeGameRecord
    }));

    // Response to client (seed + baseMapConfig)
    return successResponse({
      levelId: levelKey,
      seed,
      config: {
        gridSize: baseMapConfig.gridSize,
        mineCount: baseMapConfig.mineCount,
        safeStartRadius: baseMapConfig.safeStartRadius
      }
    });
  } catch (error) {
    console.error('Play game error:', error);
    return errorResponse(500, 'Internal server error');
  }
}

/**
 * Get minigame config from DynamoDB
 */
async function getMinigameConfig(levelKey) {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: 'minigame',
        SK: levelKey
      }
    }));

    return result.Item;
  } catch (error) {
    console.error('Get config error:', error);
    return null;
  }
}
