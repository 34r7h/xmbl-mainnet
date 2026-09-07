export { Ledger } from './src/ledger.js';
export { Block } from './src/block.js';
export { Face } from './src/face.js';
export { Cube } from './src/cube.js';
export { SuperCube } from './src/super-cube.js';
export { calculateDigitalRoot } from './src/digital-root.js';
export { getBlockPosition, getFaceIndex } from './src/placement.js';
export { validateTransaction, getTransactionType } from './src/transaction-validator.js';
export {
  positionToLocalCoords,
  faceIndexToZ,
  calculateBlockCoords,
  calculateCubeCoords,
  calculateAbsoluteCoords,
  calculateVector,
  calculateFractalAddress,
  getOrigin
} from './src/geometry.js';
export {
  extractCube,
  extractFromLedger,
  serializeExtraction
} from './src/cube-extraction.js';

// Cube sync — exported from the package root because xclt's package.json exports only "." , so a deep
// `xclt/src/...` import fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
export { CubeSyncManager } from './src/cube-sync-manager.js';
export { verifyCube, planAdoption, diffWanted, setDigest, TOPIC_DIGEST, TOPIC_LIST, TOPIC_CUBE } from './src/cube-sync.js';
