#!/usr/bin/env node
/**
 * Builds public/assets/js/pulsely.min.js: STOMP.js and pulsely.js concatenated
 * and minified into one file, so integrators can add a single <script> tag
 * instead of loading STOMP.js and pulsely.js separately.
 *
 * Plain concatenation, not an esbuild bundle: both source files are already
 * global-scope scripts (STOMP.js's UMD build assigns window.StompJs, and
 * pulsely.js explicitly assigns window.Pulsely itself, since a top-level
 * `class` declaration does not do that on its own), so there is no module
 * graph to resolve. Bundling would wrap the output in an IIFE and stop
 * `Pulsely` and `StompJs` from landing on `window`, which the two-tag setup
 * in the guide - and any page already using it - depends on.
 *
 * Run: node scripts/build-pulsely-min.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';

const root = path.dirname( path.dirname( fileURLToPath( import.meta.url ) ) );
const jsDir = path.join( root, 'public', 'assets', 'js' );

const stompSrc   = readFileSync( path.join( jsDir, 'vendor', 'stomp.umd.min.js' ), 'utf8' );
const pulselySrc = readFileSync( path.join( jsDir, 'pulsely.js' ), 'utf8' );

const combined = `${stompSrc}\n;${pulselySrc}`;

const result = await esbuild.transform( combined, {
	minify: true,
	target: 'es2019',
	loader: 'js',
} );

const banner =
`/*!
 * pulsely.min.js - Pulsely client SDK, bundled with STOMP.js (Apache-2.0).
 * STOMP.js license: https://pulsely.dev/assets/js/vendor/stomp.LICENSE
 * Source: https://pulsely.dev/assets/js/pulsely.js
 */
`;

writeFileSync( path.join( jsDir, 'pulsely.min.js' ), banner + result.code );

console.log( `wrote public/assets/js/pulsely.min.js (${ result.code.length } bytes minified)` );
