// Deliberately buggy sample program for exercising the Debug MCP Bridge.
//
// Run it normally and the total comes out wrong:
//   node sample/orders.js
//
// Use it to practice the debug loop: set a breakpoint in computeTotal or
// applyDiscount, inspect `total`/`item`, and evaluate expressions to find the
// two bugs marked BUG below.

/** @typedef {{ name: string, price: number, qty: number }} Item */

/**
 * Sum the line totals for a cart.
 * @param {Item[]} items
 */
function computeTotal(items) {
  let total = 0;
  // BUG #1: off-by-one — `<=` reads items[items.length] which is undefined,
  // and reading .price on undefined throws. Change to `<`.
  for (let i = 0; i <= items.length; i++) {
    const item = items[i];
    total += item.
    price * item.qty;
  }
  return total;
}

/**
 * Apply a percentage discount to a subtotal.
 * @param {number} subtotal
 * @param {number} percent e.g. 10 for 10%
 */
function applyDiscount(subtotal, percent) {
  // BUG #2: subtracts `percent` as an absolute amount instead of a percentage.
  // Should be: subtotal * (1 - percent / 100)
  return subtotal - percent;
}

function main() {
  /** @type {Item[]} */
  const cart = [
    { name: "Keyboard", price: 45, qty: 1 },
    { name: "Cable", price: 8, qty: 3 },
    { name: "Mouse", price: 25, qty: 2 },
  ];

  const subtotal = computeTotal(cart);
  const total = applyDiscount(subtotal, 10);

  console.log(`Subtotal: ${subtotal}`);
  console.log(`Total after 10% discount: ${total}`);
  // Expected with both bugs fixed: subtotal 119, total 107.1
}

main();
