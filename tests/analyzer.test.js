'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    CONFIG,
    parseManualValues,
    normalizeValues,
    quantile,
    wilsonInterval,
    empiricalRate,
    makeDistribution,
    summarize,
    longestSuffixPrefixOverlap,
    mergeNewestFirst
} = require('../betway-aviator-round-analyzer.user.js');

test('manual parser accepts x-suffixed and strict bare multiplier lists', () => {
    assert.deepEqual(parseManualValues('2.45x\n1.20x'), [2.45, 1.2]);
    assert.deepEqual(parseManualValues('2.45, 1.20 3x'), [2.45, 1.2, 3]);
    assert.deepEqual(parseManualValues('2.45\n1.20'), [2.45, 1.2]);
    assert.deepEqual(parseManualValues('Round 42: multiplier 2.45x'), [2.45]);
    assert.deepEqual(parseManualValues('Round 42: 2.45'), []);
});

test('manual parser rejects invalid values and preserves legitimate duplicate rounds', () => {
    assert.deepEqual(parseManualValues('0.99x\n1x\n1.25x\n1.25x\n1000001x\nNaNx'), [1, 1.25, 1.25]);
    assert.deepEqual(parseManualValues('1.5× | 2.1×'), [1.5, 2.1]);
});

test('normalization accepts legacy numbers and round records but filters invalid entries', () => {
    assert.deepEqual(normalizeValues([1, '2.5', { value: 3 }, 0.5, Infinity, 'oops']), [1, 2.5, 3]);
});

test('quantile uses linear interpolation without mutating the input', () => {
    const values = [4, 1, 3, 2];
    assert.equal(quantile(values, 0.5), 2.5);
    assert.equal(quantile(values, 0.9), 3.7);
    assert.equal(quantile(values, 0), 1);
    assert.equal(quantile(values, 1), 4);
    assert.equal(quantile([], 0.5), null);
    assert.deepEqual(values, [4, 1, 3, 2]);
});

test('Wilson interval is defined for zero and all successes and widens for small samples', () => {
    const none = wilsonInterval(0, 10);
    const all = wilsonInterval(10, 10);
    const small = wilsonInterval(1, 2);
    assert.ok(none.lower === 0 && none.upper > 0);
    assert.ok(all.lower < 1 && all.upper === 1);
    assert.ok(small.lower < 0.5 && small.upper > 0.5);
    assert.equal(wilsonInterval(0, 0), null);
});

test('empirical rates and summaries count thresholds from recorded values only', () => {
    const values = [1.1, 2.9, 3, 5, 1.2];
    const rate3 = empiricalRate(values, 3);
    assert.equal(rate3.successes, 2);
    assert.equal(rate3.total, 5);
    assert.equal(rate3.rate, 0.4);
    assert.ok(rate3.interval.lower < rate3.rate && rate3.interval.upper > rate3.rate);

    const summary = summarize(values, 3);
    assert.equal(summary.storedCount, 5);
    assert.equal(summary.recentCount, 3);
    assert.equal(summary.recentMedian, 2.9);
    assert.equal(summary.recentP90, 2.98);
    assert.equal(summary.recentRate3.successes, 1);
});

test('distribution buckets have exclusive upper bounds and include boundary values once', () => {
    const rows = makeDistribution([1, 1.5, 2, 3, 5, 10]);
    assert.deepEqual(rows.map(row => row.count), [1, 1, 1, 1, 1, 1]);
    assert.equal(rows.reduce((total, row) => total + row.count, 0), 6);
});

test('newest-first merge skips only the longest suffix-to-prefix overlap', () => {
    assert.equal(longestSuffixPrefixOverlap([4, 3, 2, 1], [3, 2, 1]), 3);
    assert.deepEqual(mergeNewestFirst([4, 3, 2, 1], [3, 2, 1]), {
        overlap: 3,
        added: [4],
        merged: [4, 3, 2, 1]
    });
    assert.deepEqual(mergeNewestFirst([2, 2, 1], [2, 1]).added, [2]);
    assert.deepEqual(mergeNewestFirst([8, 7], [3, 2]).added, [8, 7]);
    assert.deepEqual(mergeNewestFirst([3, 2, 1], [3, 2, 1]).added, []);
});

test('history is capped to avoid unbounded storage growth', () => {
    const input = Array(CONFIG.MAX_HISTORY + 1).fill(1.25);
    assert.equal(parseManualValues(input.join('\n')).length, CONFIG.MAX_HISTORY);
    assert.equal(mergeNewestFirst(input, []).merged.length, CONFIG.MAX_HISTORY);
});
