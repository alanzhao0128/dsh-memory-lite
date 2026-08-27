import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldExtractWindow, shouldExtractTurn, shouldExtractIdle } from '../src/extract/triggers.js'

test('window trigger fires at or above the threshold', () => {
  assert.equal(shouldExtractWindow(0, 20), false)
  assert.equal(shouldExtractWindow(19, 20), false)
  assert.equal(shouldExtractWindow(20, 20), true)
  assert.equal(shouldExtractWindow(25, 20), true)
})

test('turn trigger requires the message threshold and debounce', () => {
  // below minTurnExtract -> no
  assert.equal(shouldExtractTurn(4, 1_000, null, 5, 30_000), false)
  // at threshold, never extracted -> yes
  assert.equal(shouldExtractTurn(5, 1_000, null, 5, 30_000), true)
  // within debounce -> no
  assert.equal(shouldExtractTurn(8, 1_000, 990_000, 5, 30_000), false)
  // exactly at debounce boundary -> yes
  assert.equal(shouldExtractTurn(8, 1_030_000, 1_000_000, 5, 30_000), true)
  // after debounce -> yes
  assert.equal(shouldExtractTurn(8, 2_000_000, 1_000_000, 5, 30_000), true)
})

test('idle trigger fires when anything is pending', () => {
  assert.equal(shouldExtractIdle(0), false)
  assert.equal(shouldExtractIdle(1), true)
  assert.equal(shouldExtractIdle(50), true)
})
