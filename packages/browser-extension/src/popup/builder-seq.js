// A module-level counter for unique <datalist> ids across every OperandInput instance mounted in
// the popup (element ids are document-global, so each operand box needs its own). One counter,
// monotonically increasing for the life of the page.
let _seq = 0
export function nextOperandId () { return _seq++ }
