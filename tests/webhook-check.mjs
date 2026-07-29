/**
 * Outbound event webhooks, end to end.
 *
 * Stands up a receiver, registers it, drives real broker activity, and checks the
 * deliveries that arrive — including that they are signed with the same scheme the
 * server SDKs already verify, and that failures retry rather than vanish.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Pulsely from '../sdks/node/pulsely.mjs';

const HTTP = 'http://127.0.0.1:8085';
const WS_URL = 'ws://127.0.0.1:8085/ws';
const APP_ID = '22222222222222222222222222222222';
const APP_KEY = 'devkey123';
const APP_SECRET = 'devsecret456';
const PORT = 9094;
const FAILING_PORT = 9093;

const mysql = ( sql ) =>
	execFileSync( 'mysql', [ '-uroot', '-h127.0.0.1', '-P3306', '-Dpulsely', '-N', '-e', sql ] ).toString().trim();

const results = [];
const check = ( label, pass, detail = '' ) => {
	results.push( pass );
	console.log( `${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}` );
};
const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );

/* ------------------------------------------------------------- receivers */

const received = [];
const receiver = http.createServer( ( req, res ) => {
	let body = '';
	req.on( 'data', ( c ) => ( body += c ) );
	req.on( 'end', () => {
		received.push( {
			body,
			timestamp: req.headers[ 'x-pulsely-timestamp' ],
			signature: req.headers[ 'x-pulsely-signature' ],
			contentType: req.headers[ 'content-type' ]
		} );
		res.writeHead( 200 ).end( '{"ok":true}' );
	} );
} );
await new Promise( ( r ) => receiver.listen( PORT, r ) );

let failingHits = 0;
const failing = http.createServer( ( req, res ) => {
	failingHits++;
	req.on( 'data', () => {} );
	req.on( 'end', () => res.writeHead( 500 ).end( 'nope' ) );
} );
await new Promise( ( r ) => failing.listen( FAILING_PORT, r ) );

/* ------------------------------------------------------------ STOMP tools */

const NUL = String.fromCharCode( 0 );
const frame = ( c, h = {}, b = '' ) =>
	c + '\n' + Object.entries( h ).map( ( [ k, v ] ) => `${k}:${v}` ).join( '\n' ) +
	( Object.keys( h ).length ? '\n' : '' ) + '\n' + b + NUL;

function open() {
	return new Promise( ( resolve ) => {
		const ws = new globalThis.WebSocket( WS_URL );
		let connected = false;
		ws.addEventListener( 'error', () => {} );
		ws.addEventListener( 'open', () => ws.send( frame( 'CONNECT', {
			'accept-version': '1.2', host: 'localhost', login: APP_KEY, passcode: ''
		} ) ) );
		ws.addEventListener( 'message', ( ev ) => {
			if ( String( ev.data ).split( '\n' )[ 0 ] === 'CONNECTED' ) connected = true;
		} );
		const api = {
			subscribe: ( channel, id = 'w1' ) =>
				ws.send( frame( 'SUBSCRIBE', { id, destination: `${APP_ID}.${channel}` } ) ),
			unsubscribe: ( id = 'w1' ) => ws.send( frame( 'UNSUBSCRIBE', { id } ) ),
			close: () => ws.close()
		};
		const wait = ( n = 0 ) => ( connected || n > 60 ) ? resolve( api ) : setTimeout( () => wait( n + 1 ), 50 );
		wait();
	} );
}

const eventsSeen = () => received.map( ( r ) => JSON.parse( r.body ).event );
const waitFor = async ( predicate, ms = 12000 ) => {
	const deadline = Date.now() + ms;
	while ( Date.now() < deadline ) {
		if ( predicate() ) return true;
		await sleep( 300 );
	}
	return false;
};

try {
	mysql( `DELETE FROM webhook_deliveries WHERE app_id = UNHEX('${APP_ID}')` );
	mysql( `DELETE FROM app_webhooks WHERE app_id = UNHEX('${APP_ID}')` );

	/* -- nothing registered: no queue growth ----------------------------- */
	const idle = await open();
	idle.subscribe( 'hook-none' );
	await sleep( 800 );
	idle.close();
	check( 'no endpoints means nothing is queued',
		Number( mysql( `SELECT COUNT(*) FROM webhook_deliveries WHERE app_id = UNHEX('${APP_ID}')` ) ) === 0 );

	/* -- register and drive real activity -------------------------------- */
	mysql( `INSERT INTO app_webhooks (id, app_id, url, events)
	        VALUES (UNHEX(REPLACE(UUID(),'-','')), UNHEX('${APP_ID}'),
	                'http://127.0.0.1:${PORT}/hook', 'channel_occupied,channel_vacated')` );

	const conn = await open();
	conn.subscribe( 'hook-demo' );
	const gotOccupied = await waitFor( () => eventsSeen().includes( 'channel_occupied' ) );
	check( 'channel_occupied is delivered on first subscriber', gotOccupied, eventsSeen().join( ',' ) );

	conn.unsubscribe();
	const gotVacated = await waitFor( () => eventsSeen().includes( 'channel_vacated' ) );
	check( 'channel_vacated is delivered on last unsubscribe', gotVacated, eventsSeen().join( ',' ) );
	conn.close();

	/* -- payload and signature -------------------------------------------- */
	const first = received.find( ( r ) => JSON.parse( r.body ).event === 'channel_occupied' );
	const parsed = JSON.parse( first.body );

	check( 'payload names the app and channel',
		parsed.app_id === APP_ID && parsed.data.channel === 'hook-demo',
		`${parsed.app_id?.slice( 0, 8 )}… / ${parsed.data?.channel}` );
	check( 'delivery is sent as JSON', /application\/json/.test( first.contentType ), first.contentType );

	// Same four-line scheme as the trigger API, so the SDK verifies it unchanged.
	const bodyHash = crypto.createHash( 'sha256' ).update( first.body ).digest( 'hex' );
	const expected = crypto.createHmac( 'sha256', APP_SECRET )
		.update( `POST\n/webhook\n${first.timestamp}\n${bodyHash}` ).digest( 'hex' );
	check( 'signature verifies with the app secret', first.signature === expected,
		first.signature?.slice( 0, 16 ) + '…' );

	// The SDK helpers are what customers will actually use, so verify them against
	// a signature the broker really produced.
	const sdk = new Pulsely( { appId: APP_ID, appSecret: APP_SECRET, baseUrl: HTTP } );
	const headers = {
		'x-pulsely-timestamp': first.timestamp,
		'x-pulsely-signature': first.signature
	};
	check( 'node SDK verifies the delivery', sdk.verifyWebhook( first.body, headers ) === true );
	check( 'node SDK rejects a tampered body',
		sdk.verifyWebhook( first.body + ' ', headers ) === false );
	check( 'node SDK rejects the wrong secret',
		new Pulsely( { appId: APP_ID, appSecret: 'wrong', baseUrl: HTTP } )
			.verifyWebhook( first.body, headers ) === false );

	const pyVerify = execFileSync( 'python3', [ '-c', `
import sys; sys.path.insert(0, "sdks/python")
from pulsely import Pulsely
bp = Pulsely(app_id="${APP_ID}", app_secret="${APP_SECRET}")
body = sys.stdin.buffer.read()
print(bp.verify_webhook(body, {"X-Pulsely-Timestamp": "${first.timestamp}", "X-Pulsely-Signature": "${first.signature}"}))
` ], { input: first.body } ).toString().trim();
	check( 'python SDK verifies the delivery', pyVerify === 'True', pyVerify );

	check( 'signature does not verify with the wrong secret',
		crypto.createHmac( 'sha256', 'wrong' )
			.update( `POST\n/webhook\n${first.timestamp}\n${bodyHash}` ).digest( 'hex' ) !== first.signature );

	/* -- only subscribed events are sent ---------------------------------- */
	check( 'unsubscribed event types are not delivered',
		!eventsSeen().includes( 'member_added' ) && !eventsSeen().includes( 'client_event' ),
		eventsSeen().join( ',' ) );

	/* -- deliveries are marked, not left pending -------------------------- */
	const delivered = Number( mysql(
		`SELECT COUNT(*) FROM webhook_deliveries WHERE app_id = UNHEX('${APP_ID}') AND delivered_at IS NOT NULL` ) );
	check( 'successful deliveries are marked delivered', delivered >= 2, delivered + ' row(s)' );

	/* -- failure retries --------------------------------------------------- */
	mysql( `DELETE FROM app_webhooks WHERE app_id = UNHEX('${APP_ID}')` );
	mysql( `INSERT INTO app_webhooks (id, app_id, url, events)
	        VALUES (UNHEX(REPLACE(UUID(),'-','')), UNHEX('${APP_ID}'),
	                'http://127.0.0.1:${FAILING_PORT}/hook', 'channel_occupied')` );

	const failConn = await open();
	failConn.subscribe( 'hook-fail' );
	await waitFor( () => failingHits >= 1 );
	failConn.close();

	check( 'a failing endpoint is attempted', failingHits >= 1, failingHits + ' hit(s)' );

	const row = mysql( `SELECT attempts, last_status, delivered_at IS NULL
	                    FROM webhook_deliveries
	                    WHERE app_id = UNHEX('${APP_ID}') AND event_type = 'channel_occupied'
	                    ORDER BY created_at DESC LIMIT 1` ).split( /\s+/ );
	check( 'failure is recorded with its status', row[ 1 ] === '500', 'status ' + row[ 1 ] );
	check( 'failed delivery stays undelivered for retry', row[ 2 ] === '1', 'undelivered=' + row[ 2 ] );

	const scheduled = mysql( `SELECT next_attempt_at IS NOT NULL FROM webhook_deliveries
	                          WHERE app_id = UNHEX('${APP_ID}') AND event_type = 'channel_occupied'
	                          ORDER BY created_at DESC LIMIT 1` );
	check( 'a retry is scheduled with backoff', scheduled === '1', 'scheduled=' + scheduled );
} finally {
	mysql( `DELETE FROM webhook_deliveries WHERE app_id = UNHEX('${APP_ID}')` );
	mysql( `DELETE FROM app_webhooks WHERE app_id = UNHEX('${APP_ID}')` );
	receiver.close();
	failing.close();
}

console.log( `\n${results.filter( Boolean ).length}/${results.length} passed` );
process.exit( results.every( Boolean ) ? 0 : 1 );
