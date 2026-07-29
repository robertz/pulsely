/**
 * Runs the publish example exactly as printed on the marketing page.
 *
 * Documentation that does not work is worse than none, so this is a verbatim copy
 * of the "Publish" tab. If the signing scheme ever changes, this fails and the
 * page is caught lying.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const BASE_URL = process.env.HOST || 'http://127.0.0.1:8085';
const APP_ID = '22222222222222222222222222222222';
const APP_SECRET = 'devsecret456';

/* ---- begin verbatim copy of the page's "Publish" tab -------------------- */

const body = JSON.stringify( {
	channel: "orders",
	event: "created",
	data: { id: 42, total: 1999 }
} );

const ts = String( Math.floor( Date.now() / 1000 ) );
const path = `/apps/${APP_ID}/events`;
const hash = crypto.createHash( "sha256" )
	.update( body ).digest( "hex" );

const signature = crypto
	.createHmac( "sha256", APP_SECRET )
	.update( `POST\n${path}\n${ts}\n${hash}` )
	.digest( "hex" );

const res = await fetch( BASE_URL + path, {
	method: "POST",
	headers: {
		"Content-Type": "application/json",
		"X-Pulsely-Timestamp": ts,
		"X-Pulsely-Signature": signature
	},
	body
} );

/* ---- end verbatim copy -------------------------------------------------- */

const results = [];
const check = ( label, pass, detail ) => {
	results.push( pass );
	console.log( `${pass ? 'PASS' : 'FAIL'}  ${label}  (${detail})` );
};

check( 'documented publish example is accepted', res.status === 200, 'HTTP ' + res.status );

// The page claims the signature is bound to the path and to the body.
const swappedPath = `/apps/55555555555555555555555555555555/events`;
const wrongPath = await fetch( BASE_URL + swappedPath, {
	method: 'POST',
	headers: {
		'Content-Type': 'application/json',
		'X-Pulsely-Timestamp': ts,
		'X-Pulsely-Signature': signature
	},
	body
} );
check( 'signature will not replay against another app', wrongPath.status !== 200, 'HTTP ' + wrongPath.status );

const tamperedBody = JSON.stringify( { channel: "orders", event: "created", data: { id: 43, total: 999999 } } );
const wrongBody = await fetch( BASE_URL + path, {
	method: 'POST',
	headers: {
		'Content-Type': 'application/json',
		'X-Pulsely-Timestamp': ts,
		'X-Pulsely-Signature': signature
	},
	body: tamperedBody
} );
check( 'signature will not cover a swapped payload', wrongBody.status === 401, 'HTTP ' + wrongBody.status );

// The page says timestamps more than 10 minutes out are rejected.
const staleTs = String( Math.floor( Date.now() / 1000 ) - 4000 );
const staleSig = crypto.createHmac( 'sha256', APP_SECRET )
	.update( `POST\n${path}\n${staleTs}\n${hash}` ).digest( 'hex' );
const stale = await fetch( BASE_URL + path, {
	method: 'POST',
	headers: {
		'Content-Type': 'application/json',
		'X-Pulsely-Timestamp': staleTs,
		'X-Pulsely-Signature': staleSig
	},
	body
} );
check( 'stale timestamps are rejected as documented', stale.status === 401, 'HTTP ' + stale.status );

// The page's credentials tab claims the app key is the public one and the app id
// is what goes in the trigger URL.
const mysql = ( sql ) => execFileSync( 'mysql',
	[ '-uroot', '-h127.0.0.1', '-P3306', '-Dpulsely', '-N', '-e', sql ] ).toString().trim();
check( 'app id in the URL matches the apps table',
	mysql( `SELECT LOWER(HEX(id)) FROM apps WHERE app_key='devkey123'` ) === APP_ID, APP_ID );

console.log( `\n${results.filter( Boolean ).length}/${results.length} passed` );
process.exit( results.every( Boolean ) ? 0 : 1 );
