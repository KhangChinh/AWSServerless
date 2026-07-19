import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
// Khóa bí mật 32 bytes (Giấu trên môi trường AWS Lambda)
const secretKeyString = process.env.GAME_SECRET_KEY
const SECRET_KEY = Buffer.from(secretKeyString.padEnd(32, '0').substring(0, 32), 'utf-8');

export const encryptState = (stateObj) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, iv);
    let encrypted = cipher.update(JSON.stringify(stateObj), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}.${encrypted}.${authTag}`;
};

export const decryptState = (token) => {
    const [ivHex, encryptedHex, authTagHex] = token.split('.');
    const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
};
export const runFloodFill = (solutionGridStr, rows, cols, startRow, startCol, alreadyRevealedMap) => {
    const newlyRevealed = [];
    const queue = [{ r: startRow, c: startCol }];
    const visited = new Set();

    // Helper lấy index 1 chiều
    const getIdx = (r, c) => r * cols + c;
    const isValid = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols;

    while (queue.length > 0) {
        const { r, c } = queue.shift();
        const idx = getIdx(r, c);
        const cellKey = `${r}-${c}`;

        if (visited.has(cellKey) || alreadyRevealedMap[cellKey]) continue;

        visited.add(cellKey);
        const val = solutionGridStr[idx];

        newlyRevealed.push({ r, c, val });
        alreadyRevealedMap[cellKey] = true;

        // Nếu ô này là ô trống (số 0), tiếp tục loang ra 8 hướng
        if (val === '0') {
            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    if (isValid(r + dr, c + dc)) {
                        queue.push({ r: r + dr, c: c + dc });
                    }
                }
            }
        }
    }
    return newlyRevealed;
};