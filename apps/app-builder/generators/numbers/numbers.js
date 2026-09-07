let numl = [2] // number list
let primel = [1, 2] // prime list
let cnum = 2 // current number
function checkp() {
  const isp = numl.find((x) => cnum % x === 0) // is prime: modulo inside a find function.
  !isp && primel.push(cnum)
  numl.push(cnum)
  cnum++
}
function findroot(num) {
  let numa = (num + '').split('') // number to string, then to an array
  let dr = numa.map((x) => x).reduce((a, b) => +a + +b) // digital root through map/reduce arithmetic (js note for eric, adding a '+' before a value tries to make it a number)
  return (dr + '').length > 1 ? findroot(dr) : +dr // recurse of dr isn't a single digit
}
;(function init(limit) {
  while (cnum <= limit) checkp() // generate number list and prime list
  primel.map((x, xi) => {
    console.log({ o: xi, 'o.r': findroot(xi) }) // print results
    console.log({ p: x, 'd.r': findroot(x) }) // print results
    console.log({ sq: x * x, 'sq.r': findroot(x * x) }) // print results
    console.log({ ex: BigInt(x ** x), 'ex.r': findroot(BigInt(x ** x)) }, '\n') // print results
  })
})(110) // 7777 is the real number limit```const isp = numl.find((x) => cnum % x === 0)
