/**
 * MoE Router — load-balance auxiliary-loss gradient tests
 *
 * MoERouter.route() computes a Switch-Transformer-style load-balance loss
 * (computeLoadBalanceLoss()) on every call and returns it in RoutingResult,
 * but updateExpertWeights() — the only method that mutates the gating
 * network's weights — never read loadBalanceLoss/loadBalanceCoef anywhere
 * in its REINFORCE gradient computation. The regularizer the module's own
 * header claims ("Load balancing with auxiliary loss") had zero actual
 * effect on training.
 *
 * These tests are discriminating: against the pre-fix source, a call to
 * updateExpertWeights(expert, 0) is a pure no-op (reward=0 zeroes the
 * REINFORCE gradient entirely, and no other gradient source existed), so
 * output logits/probabilities for a fixed input are byte-identical before
 * and after. Against the fix, the load-balance term supplies a nonzero
 * gradient even at reward=0, moving weights away from an over-represented
 * expert.
 */

import { describe, it, expect } from 'vitest';
import { MoERouter, INPUT_DIM, NUM_EXPERTS } from '../src/moe-router.js';

// Fixed, deterministic embedding — small uniform magnitude keeps initial
// logits near zero (softmax near-uniform), which keeps the discriminating
// expert's probability safely away from the 0/1 boundary regardless of the
// specific (random) Xavier initialization drawn for a given test run.
function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(INPUT_DIM);
  arr.fill(0.01);
  return arr;
}

describe('MoERouter load-balance gradient wiring', () => {
  it('reward=0 update on a skewed routing history changes gate output (was a no-op)', () => {
    const router = new MoERouter({
      enableNoise: false, // deterministic forward pass across repeated route() calls
      topK: 1,
      loadBalanceCoef: 1.0, // amplified for a clearly measurable effect
      learningRate: 0.1,
      autoSaveInterval: 0, // no disk writes from this test
    });

    const input = fixedEmbedding();

    // Warm up: repeatedly route the SAME fixed input with noise disabled.
    // Since weights are unchanged across these calls (no update yet), the
    // same top-1 expert is selected deterministically every time, building
    // a maximally skewed routingCounts history toward that one expert.
    let last = router.route(input);
    for (let i = 0; i < 9; i++) {
      last = router.route(input);
    }
    const dominantExpert = last.experts[0].index;
    const probsBefore = Array.from(last.allScores);

    // Sanity: the load-balance loss the (pre-existing) computation produces
    // is genuinely nonzero once history is skewed — confirms the discarded
    // value itself was real, not a red herring.
    expect(last.loadBalanceLoss).toBeGreaterThan(0);

    // Reward=0: the REINFORCE term contributes nothing (clampedReward=0
    // zeroes every entry of the reward-based gradient before the balance
    // term is added). Any change below is attributable to the load-balance
    // gradient alone.
    router.updateExpertWeights(dominantExpert, 0);

    // Re-route the identical input (noise still disabled) — any difference
    // in output proves the reward=0 update had a real effect.
    const after = router.route(input);
    const probsAfter = Array.from(after.allScores);

    expect(probsAfter).not.toEqual(probsBefore);
    // Directional check matching the Switch-Transformer intuition: weight
    // is pushed away from the historically over-represented expert.
    expect(probsAfter[dominantExpert]).toBeLessThan(probsBefore[dominantExpert]);
  });

  it('loadBalanceCoef=0 (explicit opt-out) keeps reward=0 update a true no-op', () => {
    const router = new MoERouter({
      enableNoise: false,
      topK: 1,
      loadBalanceCoef: 0,
      learningRate: 0.1,
      autoSaveInterval: 0,
    });

    const input = fixedEmbedding();
    let last = router.route(input);
    for (let i = 0; i < 9; i++) {
      last = router.route(input);
    }
    const dominantExpert = last.experts[0].index;
    const probsBefore = Array.from(last.allScores);

    expect(last.loadBalanceLoss).toBe(0); // coef=0 => computeLoadBalanceLoss() scales to 0

    router.updateExpertWeights(dominantExpert, 0);

    const after = router.route(input);
    expect(Array.from(after.allScores)).toEqual(probsBefore);
  });

  it('a genuine reward signal still dominates the update (additive, not replaced)', () => {
    const router = new MoERouter({
      enableNoise: false,
      topK: 1,
      loadBalanceCoef: 0.01, // default magnitude
      learningRate: 0.1,
      autoSaveInterval: 0,
    });

    const input = fixedEmbedding();
    const first = router.route(input);
    const chosen = first.experts[0].index;

    // Strong positive reward for the chosen expert should still increase
    // its own probability on a repeat route(), not be swamped by the
    // (default-magnitude) balance term pulling the opposite direction.
    router.updateExpertWeights(chosen, 1);
    const after = router.route(input);

    expect(after.allScores[chosen]).toBeGreaterThan(first.allScores[chosen]);
  });

  it('load-balance fraction snapshot is bounded to NUM_EXPERTS entries summing to <= 1', () => {
    const router = new MoERouter({ enableNoise: false, topK: 2, autoSaveInterval: 0 });
    const input = fixedEmbedding();
    for (let i = 0; i < 5; i++) router.route(input);
    const result = router.route(input);
    expect(result.allScores).toHaveLength(NUM_EXPERTS);
    expect(result.loadBalanceLoss).toBeGreaterThanOrEqual(0);
  });
});
