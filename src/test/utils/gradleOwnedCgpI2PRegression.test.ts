import {vi} from 'vitest';
// Run the entire committed I2 runtime fault suite against the optimized experiment; do not weaken its gates.
vi.mock('../fixtures/gradleOwnedCgpI2.js',async importOriginal=>{const original=await importOriginal<typeof import('../fixtures/gradleOwnedCgpI2.js')>(),{i2pCase}=await import('../fixtures/gradleOwnedCgpI2P.js');return {...original,i2Case:(mode:Parameters<typeof i2pCase>[0],options:Parameters<typeof i2pCase>[1])=>i2pCase(mode,{...options,strategy:'max-first'})};});
import './gradleOwnedCgpI2.test.js';
