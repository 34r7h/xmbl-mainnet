// XCL — the XMBL Contract Layer: binds compiled contracts to the running chain.
// Execution is delegated to @xmbl/storage-compute, state to @xmbl/state-machine, and
// signature/identity to @xmbl/identity; XCL owns only placement, the slot↔Verkle mapping,
// and the read-set/write-set staging (see contract-host.js).
export { ContractHost } from './contract-host.js';
export { InMemoryState } from './in-memory-state.js';
export { contractId, contractCoordinates } from './placement.js';
export { HOST_ABI_SOURCE, HOST_IMPORT_KEYS, slotKey } from './abi.js';
