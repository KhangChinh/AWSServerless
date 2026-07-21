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

const fillGrid = (grid, size, blockRows, blockCols) => {
    // Tạo mảng số động dựa trên size (VD size = 6 -> [1,2,3,4,5,6])
    const numList = Array.from({ length: size }, (_, i) => i + 1);

    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            if (grid[row][col] === 0) {
                const numbers = shuffle([...numList]);
                for (let num of numbers) {
                    if (isValid(grid, row, col, num, size, blockRows, blockCols)) {
                        grid[row][col] = num;
                        if (fillGrid(grid, size, blockRows, blockCols)) return true;
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
    // Phân tích baseMapConfig để lấy cấu hình động, fallback về 9x9 nếu không có
    const size = baseMapConfig.size || 9; // vd: 6 hoặc 9

    // Setup kích thước block tùy theo loại Sudoku
    let blockRows = 3, blockCols = 3;
    if (size === 6) {
        blockRows = 2; // 6x6 có block là 2 hàng x 3 cột
        blockCols = 3;
    } else if (size === 9) {
        blockRows = 3;
        blockCols = 3;
    }

    // Khởi tạo grid động theo size
    let grid = Array.from({ length: size }, () => Array(size).fill(0));
    // Điền số
    fillGrid(grid, size, blockRows, blockCols);

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