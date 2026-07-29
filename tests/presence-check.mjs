/**
 * End-to-end presence over real WebSockets.
 *
 * Stands up a stub auth endpoint that names each subscriber, then drives several
 * connections to check the member list and the join/leave events — including the
 * multi-tab case, which is where naive presence implementations announce joins
 * and leaves that never happened.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const WS_URL = 'ws://127.0.0.1:8085/ws';
const APP_KEY = 'devkey123';
const APP_ID = '22222222222222222222222222222222';
const APP_SECRET = 'devsecret456';
const PORT = 9098;
const CHANNEL = 'presence-lobby';
const DEST = `${APP_ID}.${CHANNEL}`;

const mysql = ( sql ) =>
	execFileSync( 'mysql', [ '-uroot', '-h127.0.0.1', '-P3306', '-Dpulsely', '-N', '-e', sql ] ).toString().trim();

/* -------------------------------------------------------- stub auth endpoint */

const PROFILES = {
	'user-a': { name: 'Ada',  role: 'admin' },
	'user-b': { name: 'Brin', role: 'member' }
};

const server = http.createServer( ( req, res ) => {
	let body = '';
	req.on( 'data', ( c ) => ( body += c ) );
	req.on( 'end', () => {
		let parsed = {};
		try { parsed = JSON.parse( body ); } catch {}
		// The connection token's identity arrives as user_token; the endpoint is
		// what turns it into a presence identity.
		const userId = parsed.user_token || '';
		res.writeHead( 200, { 'Content-Type': 'application/json' } );
		res.end( JSON.stringify( {
			authorized: !!PROFILES[ userId ],
			user_id: userId,
			user_info: PROFILES[ userId ] || {}
		} ) );
	} );
} );
await new Promise( ( r ) => server.listen( PORT, r ) );

mysql( `INSERT INTO channel_auth_rules (id, app_id, channel_pattern, rule_type, auth_webhook_url)
        VALUES (UNHEX(REPLACE(UUID(),'-','')), UNHEX('${APP_ID}'), 'presence-*', 'presence', 'http://127.0.0.1:${PORT}/auth')
        ON DUPLICATE KEY UPDATE auth_webhook_url = VALUES(auth_webhook_url), rule_type = VALUES(rule_type)` );

/* ------------------------------------------------------------- STOMP client */

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
		const events = [];
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

			// Surface broker errors as events; swallowing them makes a rejected
			// subscribe indistinguishable from silence.
			if ( f.command === 'ERROR' ) {
				const err = { event: 'stomp.error', data: { message: f.headers.message || f.body } };
				const ew = waiters.shift();
				// Deliver to a waiter OR queue it — never both, or the event is
				// handed out once and left behind as a phantom duplicate.
				if ( ew ) ew( err ); else events.push( err );
				return;
			}

			if ( f.command === 'CONNECTED' ) { connected = true; return; }
			if ( f.command !== 'MESSAGE' ) return;

			let envelope = null;
			try { envelope = JSON.parse( f.body ); } catch { return; }

			// subscription_count now fires on every subscribe/unsubscribe/close
			// alongside whatever presence is doing — a real broadcast, not a bug,
			// but orthogonal to what this file tests. Filtered here rather than
			// at every call site, so the presence-specific assertions below (in
			// particular the "no spurious event" checks) don't have to know it
			// exists.
			if ( envelope.event === 'subscription_count' ) return;

			const w = waiters.shift();
			if ( w ) w( envelope ); else events.push( envelope );
		} );
		const api = {
			userId,
			subscribe: ( id = 's1' ) => ws.send( frame( 'SUBSCRIBE', { id, destination: DEST } ) ),
			unsubscribe: ( id = 's1' ) => ws.send( frame( 'UNSUBSCRIBE', { id } ) ),
			next: ( ms = 4000 ) => new Promise( ( res ) => {
				if ( events.length ) return res( events.shift() );
				const t = setTimeout( () => res( null ), ms );
				waiters.push( ( e ) => { clearTimeout( t ); res( e ); } );
			} ),
			drain: () => events.splice( 0 ),
			pending: () => events.length,
			close: () => ws.close()
		};
		const waitForConnect = ( attempts = 0 ) => {
			if ( connected || attempts > 60 ) return resolve( api );
			setTimeout( () => waitForConnect( attempts + 1 ), 50 );
		};
		waitForConnect();
	} );
}

const results = [];
const check = ( label, pass, detail = '' ) => {
	results.push( pass );
	console.log( `${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}` );
};
const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );

try {
	/* -- first member ---------------------------------------------------- */
	const a = await open( 'user-a' );
	a.subscribe();
	const aWelcome = await a.next();

	check( 'subscriber receives a roster on join',
		aWelcome?.event === 'presence.subscription_succeeded', aWelcome?.event );
	check( 'roster contains just the first member',
		aWelcome?.data?.members?.length === 1 && aWelcome.data.members[ 0 ].user_id === 'user-a',
		JSON.stringify( aWelcome?.data?.members ) );
	check( 'roster carries the user info from the auth endpoint',
		aWelcome?.data?.members?.[ 0 ]?.user_info?.name === 'Ada',
		aWelcome?.data?.members?.[ 0 ]?.user_info?.name );
	check( 'subscriber is told which member it is',
		aWelcome?.data?.me?.user_id === 'user-a', aWelcome?.data?.me?.user_id );
	check( 'first member is not told about their own arrival',
		a.pending() === 0, a.pending() + ' extra event(s)' );

	/* -- second member --------------------------------------------------- */
	const b = await open( 'user-b' );
	b.subscribe();
	const bWelcome = await b.next();
	check( 'second subscriber sees both members',
		bWelcome?.data?.members?.length === 2,
		JSON.stringify( bWelcome?.data?.members?.map( ( m ) => m.user_id ) ) );

	const aSawJoin = await a.next( 3000 );
	check( 'existing member is told of the arrival',
		aSawJoin?.event === 'presence.member_added' && aSawJoin.data.member.user_id === 'user-b',
		aSawJoin?.event );
	check( 'arrival event carries the member count',
		aSawJoin?.data?.count === 2, aSawJoin?.data?.count );

	/* -- same user, second tab ------------------------------------------- */
	const b2 = await open( 'user-b' );
	b2.subscribe( 's2' );
	await b2.next();
	await sleep( 600 );

	check( 'a second tab does not announce a new arrival',
		a.pending() === 0, a.pending() + ' spurious event(s)' );
	check( 'member count still counts the user once',
		( await ( async () => {
			const c = await open( 'user-a' );
			c.subscribe( 's3' );
			const w = await c.next();
			c.close();
			return w?.data?.count;
		} )() ) === 2, 'distinct members' );

	/* -- closing one of two tabs ----------------------------------------- */
	b2.close();
	await sleep( 900 );
	check( 'closing one tab does not announce a departure',
		a.pending() === 0, a.pending() + ' spurious event(s)' );

	/* -- explicit unsubscribe -------------------------------------------- */
	b.unsubscribe();
	const aSawLeave = await a.next( 4000 );
	check( 'last connection leaving announces the departure',
		aSawLeave?.event === 'presence.member_removed' && aSawLeave.data.member.user_id === 'user-b',
		aSawLeave?.event );
	check( 'departure event carries the updated count',
		aSawLeave?.data?.count === 1, aSawLeave?.data?.count );

	/* -- dropped socket --------------------------------------------------- */
	const d = await open( 'user-b' );
	d.subscribe( 's4' );
	await d.next();
	await a.next( 3000 );

	d.close();
	const aSawDrop = await a.next( 4000 );
	check( 'a dropped socket still announces the departure',
		aSawDrop?.event === 'presence.member_removed' && aSawDrop.data.member.user_id === 'user-b',
		aSawDrop?.event );

	a.close();
	b.close();
} finally {
	mysql( `DELETE FROM channel_auth_rules WHERE app_id = UNHEX('${APP_ID}') AND channel_pattern = 'presence-*'` );
	server.close();
}

console.log( `\n${results.filter( Boolean ).length}/${results.length} passed` );
process.exit( results.every( Boolean ) ? 0 : 1 );
