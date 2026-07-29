/**
 * End-to-end STOMP check against a running server.
 *
 * Speaks raw STOMP over a WebSocket so it has no npm dependencies. Verifies:
 *   1. CONNECT with a valid app key succeeds and returns the app id
 *   2. CONNECT with a bad app key is rejected
 *   3. SUBSCRIBE to another app's namespace is rejected
 *   4. A trigger-API publish is delivered to a subscriber
 *   5. A client SEND is rejected (trigger API is the only publish path)
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8085/ws';
const HTTP = process.env.HTTP || 'http://127.0.0.1:8085';
const APP_KEY = 'devkey123';
const APP_ID = '22222222222222222222222222222222';
const APP_SECRET = 'devsecret456';

// History for this channel accumulates across runs and is replayed on subscribe.
// Clear it so the live message is not buried behind an unbounded backlog.
execFileSync( 'mysql', [ '-uroot', '-h127.0.0.1', '-P3306', '-Dpulsely', '-N', '-e',
	`DELETE FROM channel_messages WHERE app_id = UNHEX('${APP_ID}') AND channel_name = 'wschan'` ] );

const NULL = String.fromCharCode(0);
const frame = ( command, headers = {}, body = '' ) =>
	command + '\n' +
	Object.entries( headers ).map( ( [ k, v ] ) => `${k}:${v}` ).join( '\n' ) +
	( Object.keys( headers ).length ? '\n' : '' ) + '\n' + body + NULL;

function parse( raw ) {
	const clean = raw.split( NULL )[ 0 ];
	const idx = clean.indexOf( '\n\n' );
	const head = idx === -1 ? clean : clean.slice( 0, idx );
	const body = idx === -1 ? '' : clean.slice( idx + 2 );
	const lines = head.split( '\n' );
	const headers = {};
	for ( const line of lines.slice( 1 ) ) {
		const p = line.indexOf( ':' );
		if ( p > -1 ) headers[ line.slice( 0, p ) ] = line.slice( p + 1 );
	}
	return { command: lines[ 0 ], headers, body };
}

function open( login, passcode = '' ) {
	return new Promise( ( resolve, reject ) => {
		const ws = new globalThis.WebSocket( WS_URL );
		const frames = [];
		const waiters = [];
		ws.addEventListener( 'message', ( ev ) => {
			const text = typeof ev.data === 'string' ? ev.data : '';
			if ( !text.trim() ) return;
			const f = parse( text );
			// Hand straight to a waiting next() rather than also queuing it —
			// otherwise a frame that arrives while a waiter is pending gets
			// delivered twice: once via the waiter, and once left sitting in
			// `frames` for the next unrelated next() call to pick up.
			const w = waiters.shift();
			if ( w ) { w( f ); return; }
			frames.push( f );
		} );
		// The broker closes the socket after an auth rejection, which surfaces here
		// as an error event well after this promise has settled. Swallow it.
		ws.addEventListener( 'error', () => {} );
		ws.addEventListener( 'close', () => {} );
		ws.addEventListener( 'open', () => {
			ws.send( frame( 'CONNECT', { 'accept-version': '1.2', host: 'localhost', login, passcode } ) );
		} );
		const api = {
			ws,
			next: ( ms = 4000 ) => new Promise( ( res ) => {
				if ( frames.length ) return res( frames.shift() );
				const t = setTimeout( () => res( null ), ms );
				waiters.push( ( f ) => { clearTimeout( t ); res( f ); } );
			} ),
			send: ( c, h, b ) => ws.send( frame( c, h, b ) ),
			close: () => ws.close()
		};
		setTimeout( () => resolve( api ), 300 );
	} );
}

async function trigger( channel, event, data ) {
	const body = JSON.stringify( { channel, event, data } );
	const ts = Math.floor( Date.now() / 1000 ).toString();
	const bodyHash = crypto.createHash( 'sha256' ).update( body ).digest( 'hex' );
	const signing = `POST\n/apps/${APP_ID}/events\n${ts}\n${bodyHash}`;
	const sig = crypto.createHmac( 'sha256', APP_SECRET ).update( signing ).digest( 'hex' );
	const res = await fetch( `${HTTP}/apps/${APP_ID}/events`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Pulsely-Timestamp': ts,
			'X-Pulsely-Signature': sig
		},
		body
	} );
	return res.status;
}

const results = [];
const check = ( label, pass, detail = '' ) => {
	results.push( { label, pass, detail } );
	console.log( `${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}` );
};

const conn = await open( APP_KEY );
const connected = await conn.next();
check( 'CONNECT with valid app key', connected?.command === 'CONNECTED', connected?.command );
check(
	'CONNECTED returns app id',
	connected?.headers[ 'connectionMetadata-appId' ] === APP_ID,
	connected?.headers[ 'connectionMetadata-appId' ]
);

const bad = await open( 'no-such-key' );
const badFrame = await bad.next();
check( 'CONNECT with bad app key rejected', badFrame?.command === 'ERROR', badFrame?.command );
bad.close();

// An ERROR frame closes the connection, so each rejection case needs its own socket.
const crossConn = await open( APP_KEY );
await crossConn.next();
crossConn.send( 'SUBSCRIBE', { id: 'sub-x', destination: '11111111111111111111111111111111.orders' } );
const crossTenant = await crossConn.next( 2500 );
check( 'cross-tenant SUBSCRIBE rejected', crossTenant?.command === 'ERROR', crossTenant?.command );
crossConn.close();

conn.send( 'SUBSCRIBE', { id: 'sub-1', destination: `${APP_ID}.wschan` } );
const afterSub = await conn.next( 1500 );
check( 'own-namespace SUBSCRIBE allowed', afterSub === null || afterSub.command !== 'ERROR', afterSub?.command ?? 'no error' );

const status = await trigger( 'wschan', 'ping', { hello: 'world' } );
check( 'trigger API accepted publish', status === 200, 'HTTP ' + status );

// Replayed history, subscription_succeeded, and subscription_count all arrive
// first or interleaved — skip past everything that isn't the live 'ping' itself.
let delivered = null, payload = null, live = false;
for ( let i = 0; i < 25 && !live; i++ ) {
	delivered = await conn.next( 5000 );
	if ( !delivered ) break;
	try { payload = JSON.parse( delivered.body ?? 'null' ); } catch { payload = null; }
	live = delivered.command === 'MESSAGE' && payload?.replayed !== true && payload?.event === 'ping';
}
check(
	'message delivered to subscriber',
	live && payload?.event === 'ping' && payload?.data?.hello === 'world',
	delivered?.command + ' ' + ( delivered?.body ?? '' ).slice( 0, 80 )
);

conn.close();


// "Other App" is on the Sandbox plan, which excludes private channels. The broker
// must refuse regardless of any rule, because the pricing page sells this. Unlike
// a cross-tenant or bad-key rejection, a refused private/presence channel is not
// connection-fatal — it's a subscription_error MESSAGE on the same socket, which
// stays open and usable for everything else. See WebSocket.bx's authorize() and
// authorizeChannelSubscription() for why the split exists.
const OTHER_KEY = 'otherkey789';
const OTHER_APP_ID = '55555555555555555555555555555555';

const planConn = await open( OTHER_KEY );
const planConnected = await planConn.next();
check( 'sandbox app connects normally', planConnected?.command === 'CONNECTED', planConnected?.command );

planConn.send( 'SUBSCRIBE', { id: 'plan', destination: `${OTHER_APP_ID}.private-orders` } );
const planFrame = await planConn.next( 3000 );
let planPayload = null;
try { planPayload = JSON.parse( planFrame?.body ?? 'null' ); } catch { planPayload = null; }
check(
	'private channel refused on a plan without it',
	planFrame?.command === 'MESSAGE' && planPayload?.event === 'subscription_error',
	( planPayload?.data?.reason || planFrame?.command || 'no frame' )
);

// The refusal above must not have taken the connection down with it.
planConn.send( 'SUBSCRIBE', { id: 'plan-pub', destination: `${OTHER_APP_ID}.orders` } );
const planStillAlive = await planConn.next( 1500 );
check(
	'connection survives a refused private channel',
	planStillAlive === null || planStillAlive.command !== 'ERROR',
	planStillAlive?.command ?? 'no error — still open'
);
planConn.close();

const publicConn = await open( OTHER_KEY );
await publicConn.next();
publicConn.send( 'SUBSCRIBE', { id: 'pub', destination: `${OTHER_APP_ID}.orders` } );
const publicFrame = await publicConn.next( 1500 );
check(
	'public channel still allowed on the same plan',
	publicFrame === null || publicFrame.command !== 'ERROR',
	publicFrame?.command ?? 'no error'
);
publicConn.close();

// The dashboard ops feed must not be readable without a backend-minted ops token.
const opsConn = await open( APP_KEY );
await opsConn.next();
opsConn.send( 'SUBSCRIBE', { id: 'ops', destination: `${APP_ID}.$ops` } );
const opsFrame = await opsConn.next( 2500 );
check( 'ops feed denied without ops token', opsFrame?.command === 'ERROR', opsFrame?.command ?? 'no error' );
opsConn.close();

const pubConn = await open( APP_KEY );
await pubConn.next();
pubConn.send( 'SEND', { destination: `${APP_ID}.wschan` }, '{"event":"evil"}' );
const clientPublish = await pubConn.next( 3000 );
check( 'client SEND rejected', clientPublish?.command === 'ERROR', clientPublish?.command );
pubConn.close();
const failed = results.filter( ( r ) => !r.pass );
console.log( `\n${results.length - failed.length}/${results.length} passed` );
process.exit( failed.length ? 1 : 0 );
