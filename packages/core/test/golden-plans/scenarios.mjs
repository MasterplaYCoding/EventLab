/**
 * The inputs behind every golden plan, as a function of the library.
 *
 * Plain JavaScript that receives the EventLab module as an argument, so the
 * generator can hand it a *released* package from npm and the test can hand it
 * this build's source - and both run exactly the same inputs. Change nothing
 * here without regenerating every golden file: they are only comparable
 * because these inputs are fixed.
 *
 * Between them the scenarios exercise every transform, both orders of the
 * ones whose order matters, several seeds, a concurrency limit, and phases
 * with barriers and a checkpoint.
 */
export function scenarios({ createPlan, duplicate, shuffle, delay, burst }) {
  const payments = [
    { id: "evt_payment_1", body: { eventId: "evt_payment_1", orderId: "ord_1001", amount: 4999 } },
    { id: "evt_payment_2", body: { eventId: "evt_payment_2", orderId: "ord_1002", amount: 12500 } },
    { id: "evt_charge_1", body: { eventId: "evt_charge_1", orderId: "ord_1001", amount: 4999 } },
  ];
  const many = Array.from({ length: 12 }, (_, index) => ({
    id: `evt_${index}`,
    body: { eventId: `evt_${index}`, n: index, nested: { list: [index, index * 2], flag: index % 2 === 0 } },
  }));

  return [
    {
      name: "readme-duplicate-shuffle-burst",
      plan: createPlan({
        scenario: "payments delivered three times",
        events: payments,
        seed: 20260908,
        concurrency: 4,
        transforms: [duplicate({ copies: 3 }), shuffle(), burst()],
      }),
    },
    {
      name: "delay-then-shuffle",
      plan: createPlan({
        scenario: "delayed and reordered",
        events: many,
        seed: 7,
        transforms: [duplicate({ copies: 2 }), delay({ minMs: 0, maxMs: 250 }), shuffle()],
      }),
    },
    {
      name: "shuffle-then-delay",
      plan: createPlan({
        scenario: "reordered and delayed",
        events: many,
        seed: 7,
        transforms: [shuffle(), delay({ minMs: 10, maxMs: 90 })],
      }),
    },
    {
      name: "large-seed",
      plan: createPlan({
        scenario: "a seed near the top of the range",
        events: many,
        seed: 2147483646,
        concurrency: 3,
        transforms: [duplicate({ copies: 4 }), shuffle(), delay({ minMs: 1, maxMs: 1000 })],
      }),
    },
    {
      name: "phases-and-barrier",
      plan: createPlan({
        scenario: "refund after settlement",
        events: payments,
        seed: 20260910,
        phases: [
          { deliver: ["evt_payment_1", "evt_charge_1"], transforms: [duplicate({ copies: 2 }), shuffle()] },
          { barrier: "settled", checkpoint: "settle" },
          { deliver: ["evt_payment_2"], transforms: [delay({ minMs: 5, maxMs: 50 })] },
        ],
      }),
    },
  ];
}
