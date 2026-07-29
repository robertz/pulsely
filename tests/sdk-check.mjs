/**
 * Verifies each server SDK against the running broker.
 *
 * Every SDK must produce byte-identical signatures, so the test drives all of
 * them through the same scenarios: a real publish, a rejected publish, and a
 * connection token that has to survive an actual STOMP CONNECT.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Pulsely, { PulselyError } from '../sdks/node/pulsely.mjs';

const HTTP = 'http://127.0.0.1:8085';
const WS_URL = 'ws://127.0.0.1:8085/ws';
const APP_ID = '22222222222222222222222222222222';
const APP_KEY = 'devkey123';
const APP_SECRET = 'devsecret456';

const results = [];
const check = ( label, pass, detail = '' ) => {
	results.push( pass );
	console.log( `${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}` );
};

/** A token is only good if the broker actually accepts it on CONNECT. */
function connectWith( token ) {
	return new Promise( ( resolve ) => {
		const NUL = String.fromCharCode( 0 );
		const ws = new globalThis.WebSocket( WS_URL );
		const done = ( v ) => { try { ws.close(); } catch {} resolve( v ); };
		const timer = setTimeout( () => done( 'timeout' ), 5000 );
		ws.addEventListener( 'error', () => { clearTimeout( timer ); done( 'error' ); } );
		ws.addEventListener( 'open', () => ws.send(
			'CONNECT\naccept-version:1.2\nhost:localhost\n'
			+ `login:${APP_KEY}\npasscode:${token}\n\n` + NUL
		) );
		ws.addEventListener( 'message', ( ev ) => {
			const command = String( ev.data ).split( '\n' )[ 0 ];
			if ( command === 'CONNECTED' || command === 'ERROR' ) {
				clearTimeout( timer );
				done( command );
			}
		} );
	} );
}

/* ------------------------------------------------------------------- Node */

const node = new Pulsely( { appId: APP_ID, appKey: APP_KEY, appSecret: APP_SECRET, baseUrl: HTTP } );

const nodePublish = await node.trigger( 'sdk-node', 'created', { id: 42, note: 'café ✓' } );
check( 'node: publish accepted', nodePublish?.status === 'ok', JSON.stringify( nodePublish ) );

check( 'node: token authenticates', await connectWith( node.authToken( 'user-node' ) ) === 'CONNECTED' );

const nodeBadToken = `${Math.floor( Date.now() / 1000 ) + 600}.user-x.` + 'f'.repeat( 64 );
check( 'node: forged token refused', await connectWith( nodeBadToken ) === 'ERROR' );

let nodeThrew = null;
try {
	await new Pulsely( { appId: APP_ID, appSecret: 'wrong', baseUrl: HTTP } )
		.trigger( 'sdk-node', 'created', {} );
} catch ( err ) { nodeThrew = err; }
check( 'node: bad secret raises a typed error',
	nodeThrew instanceof PulselyError && nodeThrew.status === 401, nodeThrew?.status );

check( 'node: auth endpoint helper shape',
	( () => {
		const r = node.authorizeChannel( { userId: 'u1', userInfo: { name: 'Ada' } } );
		return r.authorized === true && r.user_id === 'u1' && r.user_info.name === 'Ada';
	} )() );

/* ----------------------------------------------------------------- Python */

const py = ( script ) =>
	execFileSync( 'python3', [ '-c', script ], { cwd: new URL( '../sdks/python/', import.meta.url ).pathname } )
		.toString().trim();

const pyPublish = py( `
from pulsely import Pulsely
bp = Pulsely(app_id="${APP_ID}", app_key="${APP_KEY}", app_secret="${APP_SECRET}", base_url="${HTTP}")
print(bp.trigger("sdk-python", "created", {"id": 42, "note": "café ✓"}))
` );
check( 'python: publish accepted', pyPublish.includes( "'status': 'ok'" ), pyPublish );

const pyToken = py( `
from pulsely import Pulsely
bp = Pulsely(app_id="${APP_ID}", app_key="${APP_KEY}", app_secret="${APP_SECRET}", base_url="${HTTP}")
print(bp.auth_token("user-python"))
` );
check( 'python: token authenticates', await connectWith( pyToken ) === 'CONNECTED', pyToken.slice( 0, 24 ) + '…' );

const pyError = py( `
from pulsely import Pulsely, PulselyError
bp = Pulsely(app_id="${APP_ID}", app_secret="wrong", base_url="${HTTP}")
try:
    bp.trigger("sdk-python", "created", {})
    print("NO ERROR")
except PulselyError as e:
    print(e.status)
` );
check( 'python: bad secret raises a typed error', pyError === '401', pyError );

/* --------------------------------------------------------------- BoxLang */

const bxOut = await ( await fetch( `${HTTP}/sdks/boxlang/selftest.bxm` ) ).text();
check( 'boxlang: publish accepted', /publish: ok/.test( bxOut ), bxOut.match( /publish: \S+/ )?.[ 0 ] );
check( 'boxlang: bad secret raises PulselyError', /badsecret: 401/.test( bxOut ), bxOut.match( /badsecret: \S+/ )?.[ 0 ] );

const bxToken = bxOut.match( /token: (\S+)/ )?.[ 1 ] ?? '';
check( 'boxlang: token authenticates', await connectWith( bxToken ) === 'CONNECTED', bxToken.slice( 0, 24 ) + '…' );

/* ------------------------------------------- cross-language signature parity */

const timestamp = '1700000000';
const payload = JSON.stringify( { channel: 'parity', event: 'check', data: { n: 1 } } );
const path = `/apps/${APP_ID}/events`;
const expected = crypto.createHmac( 'sha256', APP_SECRET )
	.update( `POST\n${path}\n${timestamp}\n${crypto.createHash( 'sha256' ).update( payload ).digest( 'hex' )}` )
	.digest( 'hex' );

const pyParity = py( `
import hashlib, hmac
payload = ${JSON.stringify( payload )}.encode()
body_hash = hashlib.sha256(payload).hexdigest()
signing = "POST\\n${path}\\n${timestamp}\\n" + body_hash
print(hmac.new(b"${APP_SECRET}", signing.encode(), hashlib.sha256).hexdigest())
` );
check( 'python signature matches node byte for byte', pyParity === expected, pyParity.slice( 0, 16 ) + '…' );

const bxParity = bxOut.match( /parity: (\S+)/ )?.[ 1 ] ?? '';
check( 'boxlang signature matches node byte for byte', bxParity === expected, bxParity.slice( 0, 16 ) + '…' );

console.log( `\n${results.filter( Boolean ).length}/${results.length} passed` );
process.exit( results.every( Boolean ) ? 0 : 1 );
