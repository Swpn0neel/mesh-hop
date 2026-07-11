import assert from "node:assert/strict";
import test from "node:test";
import { booleanEnv, integerEnv } from "../src/env.js";

test("integerEnv falls back, validates, and honors a custom minimum", () => {
  delete process.env.MESHHOP_TEST_INT;
  assert.equal(integerEnv("MESHHOP_TEST_INT", 42), 42);

  process.env.MESHHOP_TEST_INT = "7";
  assert.equal(integerEnv("MESHHOP_TEST_INT", 42), 7);

  process.env.MESHHOP_TEST_INT = "0";
  assert.throws(() => integerEnv("MESHHOP_TEST_INT", 42), /at least 1/);
  assert.equal(integerEnv("MESHHOP_TEST_INT", 42, { minimum: 0 }), 0);

  process.env.MESHHOP_TEST_INT = "notanumber";
  assert.throws(() => integerEnv("MESHHOP_TEST_INT", 42), /integer/);
  delete process.env.MESHHOP_TEST_INT;
});

test("booleanEnv accepts common truthy and falsy spellings", () => {
  delete process.env.MESHHOP_TEST_BOOL;
  assert.equal(booleanEnv("MESHHOP_TEST_BOOL", true), true);
  assert.equal(booleanEnv("MESHHOP_TEST_BOOL", false), false);

  for (const value of ["1", "true", "YES", "on"]) {
    process.env.MESHHOP_TEST_BOOL = value;
    assert.equal(booleanEnv("MESHHOP_TEST_BOOL", false), true, value);
  }
  for (const value of ["0", "false", "No", "off"]) {
    process.env.MESHHOP_TEST_BOOL = value;
    assert.equal(booleanEnv("MESHHOP_TEST_BOOL", true), false, value);
  }
  process.env.MESHHOP_TEST_BOOL = "maybe";
  assert.throws(() => booleanEnv("MESHHOP_TEST_BOOL", true), /true or false/);
  delete process.env.MESHHOP_TEST_BOOL;
});
