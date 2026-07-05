import crypto from 'crypto';

// --- CÁC HÀM HỖ TRỢ ---
const isValid = (grid, row, col, num) => {
    for (let x = 0; x < 9; x++) {
        if (grid[row][x] === num || grid[x][col] === num) return false;
    }
    const startRow = row - (row % 3);
    const startCol = col - (col % 3);
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            if (grid[i + startRow][j + startCol] === num) return false;
        }
    }
    return true;
};

const shuffle = (array) => {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
};

const fillGrid = (grid) => {
    for (let row = 0; row < 9; row++) {
        for (let col = 0; col < 9; col++) {
            if (grid[row][col] === 0) {
                const numbers = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]);
                for (let num of numbers) {
                    if (isValid(grid, row, col, num)) {
                        grid[row][col] = num;
                        if (fillGrid(grid)) return true;
                        grid[row][col] = 0;
                    }
                }
                return false;
            }
        }
    }
    return true;
};

// --- HÀM CHÍNH ---
export const generateSudokuBoard = (baseMapConfig) => {
    // Note: 'seed' ở đây đóng vai trò như Board ID, không điều khiển Math.random
    const boardId = crypto.randomBytes(8).toString('hex');

    let grid = Array.from({ length: 9 }, () => Array(9).fill(0));
    fillGrid(grid);

    const solutionGrid = grid.flat().join('');

    // Đục lỗ: Clone mảng để không ảnh hưởng grid gốc, giữ nguyên kiểu Number
    let puzzleGridArray = [...grid.flat()];
    let emptyCells = baseMapConfig.emptyCellsCount || 30;

    let holesMade = 0;
    while (holesMade < emptyCells) {
        let randomIndex = Math.floor(Math.random() * 81);
        // Kiểm tra xem vị trí đó đã bị đục lỗ (số 0) chưa
        if (puzzleGridArray[randomIndex] !== 0) {
            puzzleGridArray[randomIndex] = 0;
            holesMade++;
        }
    }

    const puzzleGrid = puzzleGridArray.join('');

    return {
        seed: boardId, // Giữ key là seed để map với logic cũ của bạn
        solutionGrid: solutionGrid,
        puzzleGrid: puzzleGrid
    };
};