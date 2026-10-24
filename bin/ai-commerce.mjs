#!/usr/bin/env node
import {main} from '../cli/app.mjs';
process.exitCode=await main();
