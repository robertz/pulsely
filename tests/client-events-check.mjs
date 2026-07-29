/**
 * Client-published events, end to end.
 *
 * Client publishing is the one path where an untrusted party decides what goes on
 * the wire, so most of this file is about what is *refused*.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const WS_URL = 'ws://127.0.0.1:8085/ws';
const APP_KEY = 'devkey123';
const APP_ID = '22222222222222222222222222222222';
const APP_SECRET = 'devsecret456';
const PORT = 9096;

const mysql = ( sql ) =>
	execFileSync( 'mysql', [ '-uroot', '-h127.0.0.1', '-P3306', '-Dpulsely', '-N', '-e', sql ] ).toString().trim();

const server = http.createServer( ( req, res ) => {
	let body = '';
	req.on( 'data', ( c ) => ( body += c ) );
	req.on( 'end', () => {
		let parsed = {};
		try { parsed = JSON.parse( body ); } catch {}
		res.writeHead( 200, { 'Content-Type': 'application/json' } );
		res.end( JSON.stringify( { authorized: true, user_id: parsed.user_token || 'anon', user_info: {} } ) );
	} );
} );
await new Promise( ( r ) => server.listen( PORT, r ) );

mysql( `INSERT INTO channel_auth_rules (id, app_id, channel_pattern, rule_type, auth_webhook_url)
        VALUES (UNHEX(REPLACE(UUID(),'-','')), UNHEX('${APP_ID}'), 'private-chat*', 'private', 'http://127.0.0.1:${PORT}/auth')
        ON DUPLICATE KEY UPDATE auth_webhook_url = VALUES(auth_webhook_url)` );

const NUL = String.fromCharCode( 0 );
const frame = ( c, h = {}, b = '' ) =>
	c + '\n' + Object.entries( h ).map( ( [ k, v ] ) => `${k}:${v}` ).join( '\n' ) +
	( Object.keys( h ).length ? '\n' : '' ) + '\n' + b + NUL;

function parse( raw ) {
	const clean = raw.split( NUL )[ 0 ];
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

const mintToken = ( userId ) => {
	const expires = Math.floor( Date.now() / 1000 ) + 3600;
	const sig = crypto.createHmac( 'sha256', APP_SECRET )
		.update( `${APP_KEY}:${expires}:${userId}` ).digest( 'hex' );
	return `${expires}.${userId}.${sig}`;
};

function open( userId ) {
	return new Promise( ( resolve ) => {
		const ws = new globalThis.WebSocket( WS_URL );
		const queue = [];
		const waiters = [];
		let connected = false;
		ws.addEventListener( 'error', () => {} );
		ws.addEventListener( 'open', () => ws.send( frame( 'CONNECT', {
			'accept-version': '1.2', host: 'localhost', login: APP_KEY, passcode: mintToken( userId )
		} ) ) );
		ws.addEventListener( 'message', ( ev ) => {
			const text = String( ev.data );
			if ( !text.trim() ) return;
			const f = parse( text );
			if ( f.command === 'CONNECTED' ) { connected = true; return; }
			if ( f.command === 'RECEIPT' ) return;
			const item = f.command === 'ERROR'
				// The detail is in the frame body; the header is only the short title.
				? { kind: 'error', message: ( f.headers.message || '' ) + ' ' + ( f.body || '' ) }
				: { kind: 'message', envelope: ( () => { try { return JSON.parse( f.body ); } catch { return null; } } )() };
			const w = waiters.shift();
			if ( w ) w( item ); else queue.push( item );
		} );
		const api = {
			subscribe: ( dest, id = 's1' ) => ws.send( frame( 'SUBSCRIBE', { id, destination: dest } ) ),
			publish: ( dest, payload ) => ws.send( frame( 'SEND',
				{ destination: dest, 'content-type': 'application/json' }, JSON.stringify( payload ) ) ),
			raw: ( dest, body ) => ws.send( frame( 'SEND', { destination: dest, 'content-type': 'application/json' }, body ) ),
			next: ( ms = 3000 ) => new Promise( ( res ) => {
				if ( queue.length ) return res( queue.shift() );
				const t = setTimeout( () => res( null ), ms );
				waiters.push( ( i ) => { clearTimeout( t ); res( i ); } );
			} ),
			pending: () => queue.length,
			drain: () => queue.splice( 0 ),
			close: () => ws.close()
		};
		const wait = ( n = 0 ) => ( connected || n > 60 ) ? resolve( api ) : setTimeout( () => wait( n + 1 ), 50 );
		wait();
	} );
}

const results = [];
const check = ( label, pass, detail = '' ) => {
	results.push( pass );
	console.log( `${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}` );
};
const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );

const PRIVATE = `${APP_ID}.private-chat`;
const PUBLIC = `${APP_ID}.orders`;

// An ERROR frame closes the connection, so each refusal case gets a fresh socket.
async function subscribed( userId, destination = PRIVATE ) {
	const conn = await open( userId );
	conn.subscribe( destination );
	await sleep( 700 );
	conn.drain();
	return conn;
}

try {
	/* -- disabled by default --------------------------------------------- */
	mysql( `UPDATE apps SET allows_client_events = 0 WHERE id = UNHEX('${APP_ID}')` );

	// Drain any replayed history before publishing, or it is mistaken for the reply.
	let c = await subscribed( 'user-a' );
	c.publish( PRIVATE, { event: 'client-hello', data: { x: 1 } } );
	let res = await c.next();
	check( 'refused while the app has client events off',
		res?.kind === 'error' && /turned off/i.test( res.message ), res?.message?.slice( 0, 60 ) );
	c.close();

	/* -- enabled ---------------------------------------------------------- */
	mysql( `UPDATE apps SET allows_client_events = 1 WHERE id = UNHEX('${APP_ID}')` );

	const a = await open( 'user-a' );
	const b = await open( 'user-b' );
	a.subscribe( PRIVATE );
	b.subscribe( PRIVATE );
	await sleep( 800 );
	a.drain(); b.drain();

	a.publish( PRIVATE, { event: 'client-typing', data: { who: 'a' } } );
	const delivered = await b.next();
	check( 'other subscribers receive the client event',
		delivered?.kind === 'message' && delivered.envelope?.event === 'client-typing'
		&& delivered.envelope?.data?.who === 'a',
		delivered?.envelope?.event ?? delivered?.message );
	check( 'client events are flagged as client-published',
		delivered?.envelope?.client === true, String( delivered?.envelope?.client ) );

	await sleep( 500 );
	check( 'publisher does not receive its own event',
		a.pending() === 0, a.pending() + ' echo(es)' );

	/* -- guardrails ------------------------------------------------------- */
	const prefixConn = await subscribed( 'user-p' );
	prefixConn.publish( PRIVATE, { event: 'order.paid', data: {} } );
	res = await prefixConn.next();
	check( 'refuses an event name without the client- prefix',
		res?.kind === 'error' && /client-/.test( res.message ), res?.message?.slice( 0, 60 ) );
	prefixConn.close();

	const pub = await open( 'user-c' );
	pub.subscribe( PUBLIC );
	await sleep( 600 );
	pub.drain();
	pub.publish( PUBLIC, { event: 'client-spam', data: {} } );
	res = await pub.next();
	check( 'refuses publishing to a public channel',
		res?.kind === 'error' && /private- or presence-/.test( res.message ), res?.message?.slice( 0, 60 ) );
	pub.close();

	const lurker = await open( 'user-d' );
	lurker.publish( PRIVATE, { event: 'client-sneak', data: {} } );
	res = await lurker.next();
	check( 'refuses publishing to a channel it never subscribed to',
		res?.kind === 'error', res?.message?.slice( 0, 60 ) );
	lurker.close();

	const opsAttempt = await open( 'user-e' );
	opsAttempt.publish( `${APP_ID}.$ops`, { event: 'client-spoof', data: {} } );
	res = await opsAttempt.next();
	check( 'refuses publishing to the reserved ops channel', res?.kind === 'error', res?.kind );
	opsAttempt.close();

	const jsonConn = await subscribed( 'user-j' );
	jsonConn.raw( PRIVATE, 'not json at all' );
	res = await jsonConn.next();
	check( 'refuses a non-JSON payload',
		res?.kind === 'error' && /JSON/i.test( res.message ), res?.message?.slice( 0, 60 ) );
	jsonConn.close();

	const bigConn = await subscribed( 'user-o' );
	bigConn.publish( PRIVATE, { event: 'client-big', data: { blob: 'x'.repeat( 11000 ) } } );
	res = await bigConn.next();
	check( 'refuses an oversized payload',
		res?.kind === 'error' && /too large/i.test( res.message ), res?.message?.slice( 0, 60 ) );
	bigConn.close();

	/* -- rate limit -------------------------------------------------------- */
	const flooder = await subscribed( 'user-f' );
	b.drain();
	for ( let i = 0; i < 25; i++ ) {
		flooder.publish( PRIVATE, { event: 'client-flood', data: { i } } );
	}
	await sleep( 1200 );
	const errors = flooder.drain().filter( ( e ) => e.kind === 'error' && /[Rr]ate limit/.test( e.message ) );
	check( 'rate limits a flooding client', errors.length > 0, errors.length + ' rejection(s)' );

	const delivereds = b.drain().filter( ( e ) => e.kind === 'message' ).length;
	check( 'rate limit caps what reaches subscribers',
		delivereds > 0 && delivereds <= 11, delivereds + ' delivered of 25' );

	const historyRows = Number( mysql(
		`SELECT COUNT(*) FROM channel_messages WHERE app_id = UNHEX('${APP_ID}') AND event_name LIKE 'client-%'`
	) );
	check( 'client events are not written to history', historyRows === 0, historyRows + ' row(s)' );

	flooder.close();
	a.close();
	b.close();
} finally {
	mysql( `UPDATE apps SET allows_client_events = 0 WHERE id = UNHEX('${APP_ID}')` );
	mysql( `DELETE FROM channel_auth_rules WHERE app_id = UNHEX('${APP_ID}') AND channel_pattern = 'private-chat*'` );
	server.close();
}

console.log( `\n${results.filter( Boolean ).length}/${results.length} passed` );
process.exit( results.every( Boolean ) ? 0 : 1 );
