#!/usr/bin/env node
import { createPairCode } from "./crypto.js";

const pairCode = createPairCode();
console.log("MeshHop pair code (treat this like a password):");
console.log(pairCode);
console.log("\nEnter this code on exactly one client and one consenting exit agent.");
