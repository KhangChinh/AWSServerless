import crypto from 'crypto';

export const generateMinesweeperBoard = (baseMapConfig) => {
    // Note: 'seed' dùng làm ID bản đồ
    const boardId = crypto.randomBytes(8).toString('hex');

    // Parse cấu hình (mặc định 9x9, 10 mìn)
    const [rows, cols] = (baseMapConfig.gridSize || "9x9").split('x').map(Number);
    const mineCount = baseMapConfig.mineCount || 10;
    const safeRadius = baseMapConfig.safeStartRadius || 1;
    const totalCells = rows * cols;

    // Xác định tâm bản đồ để làm vùng an toàn (safeStartRadius)
    const centerRow = Math.floor(rows / 2);
    const centerCol = Math.floor(cols / 2);

    // 1. Khởi tạo mảng 1D
    let boardArr = Array(totalCells).fill(0);
    let minesPlaced = 0;

    // 2. Rải mìn ngẫu nhiên (tránh vùng an toàn ở giữa)
    while (minesPlaced < mineCount) {
        let randIndex = Math.floor(Math.random() * totalCells);
        let r = Math.floor(randIndex / cols);
        let c = randIndex % cols;

        // Kiểm tra xem ô random có nằm trong vùng an toàn không
        let isSafeZone = Math.abs(r - centerRow) <= safeRadius && Math.abs(c - centerCol) <= safeRadius;

        if (boardArr[randIndex] !== '*' && !isSafeZone) {
            boardArr[randIndex] = '*';
            minesPlaced++;
        }
    }

    // 3. Tính toán số lượng mìn xung quanh cho các ô không phải là mìn
    const getIndex = (r, c) => r * cols + c;
    const isValid = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols;

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (boardArr[getIndex(r, c)] === '*') continue;

            let count = 0;
            // Quét 8 ô xung quanh
            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    if (isValid(r + dr, c + dc) && boardArr[getIndex(r + dr, c + dc)] === '*') {
                        count++;
                    }
                }
            }
            boardArr[getIndex(r, c)] = count; // Lưu số từ 0 đến 8
        }
    }

    // solutionGrid là đáp án hoàn chỉnh
    const solutionGrid = boardArr.join('');

    // puzzleGrid gửi xuống Client ban đầu sẽ toàn là H (Hidden)
    const puzzleGrid = 'H'.repeat(totalCells);

    return {
        seed: boardId,
        solutionGrid: solutionGrid,
        puzzleGrid: puzzleGrid
    };
};