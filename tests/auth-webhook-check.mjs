/**
 * Verifies the private-channel authorize() path against a stub customer auth
 * endpoint: one channel it approves, one it denies.
 */
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const WS_URL = 'ws://127.0.0.1:8085/ws';
const APP_KEY = 'devkey123';
const APP_ID = '22222222222222222222222222222222';
const PORT = 9099;

const seen = [];
const server = http.createServer( ( req, res ) => {
	let body = '';
	req.on( 'data', ( c ) => ( body += c ) );
	req.on( 'end', () => {
		let parsed = {};
		try { parsed = JSON.parse( body ); } catch {}
		seen.push( parsed );
		const approve = parsed.channel_name === 'private-allowed';
		res.writeHead( 200, { 'Content-Type': 'application/json' } );
		res.end( JSON.stringify( { authorized: approve } ) );
	} );
} );
await new Promise( ( r ) => server.listen( PORT, r ) );

const mysql = ( sql ) =>
	execFileSync( 'mysql', [ '-u', 'root', '-h', '127.0.0.1', '-P', '3306', '-D', 'pulsely', '-e', sql ] );
mysql( `UPDATE channel_auth_rules SET auth_webhook_url='http://127.0.0.1:${PORT}/auth' WHERE app_id=UNHEX('${APP_ID}');` );

const NULL = String.fromCharCode( 0 );
const frame = ( c, h = {}, b = '' ) =>
	c + '\n' + Object.entries( h ).map( ( [ k, v ] ) => `${k}:${v}` ).join( '\n' ) +
	( Object.keys( h ).length ? '\n' : '' ) + '\n' + b + NULL;

function subscribeTo( destination ) {
	return new Promise( ( resolve ) => {
		const ws = new globalThis.WebSocket( WS_URL );
		let connected = false;
		const timer = setTimeout( () => { try { ws.close(); } catch {} resolve( 'timeout' ); }, 6000 );
		ws.addEventListener( 'error', () => {} );
		ws.addEventListener( 'open', () =>
			ws.send( frame( 'CONNECT', { 'accept-version': '1.2', host: 'localhost', login: APP_KEY, passcode: '' } ) ) );
		ws.addEventListener( 'message', ( ev ) => {
			const raw = String( ev.data ).split( NULL )[ 0 ];
			if ( !raw.trim() ) return;
			const command = raw.split( '\n' )[ 0 ];
			if ( command === 'CONNECTED' && !connected ) {
				connected = true;
				ws.send( frame( 'SUBSCRIBE', { id: 's1', destination } ) );
				// No ERROR/subscription_error within this window means it was accepted.
				setTimeout( () => { clearTimeout( timer ); try { ws.close(); } catch {} resolve( 'allowed' ); }, 2000 );
			} else if ( command === 'ERROR' ) {
				// Still how a hard-boundary failure (bad app id, cross-tenant) is
				// reported — not what a private-channel refusal does anymore.
				clearTimeout( timer );
				try { ws.close(); } catch {}
				resolve( 'denied' );
			} else if ( command === 'MESSAGE' ) {
				// A private-/presence- channel refusal is a subscription_error
				// envelope on a connection that stays open, not a connection-fatal
				// ERROR frame — see WebSocket.bx's authorize()/onSubscribe() split.
				const body = raw.split( '\n\n' )[ 1 ] ?? '';
				let payload = null;
				try { payload = JSON.parse( body ); } catch {}
				if ( payload?.event === 'subscription_error' ) {
					clearTimeout( timer );
					try { ws.close(); } catch {}
					resolve( 'denied' );
				}
			}
		} );
	} );
}

const results = [];
const check = ( label, pass, detail ) => {
	results.push( pass );
	console.log( `${pass ? 'PASS' : 'FAIL'}  ${label}  (${detail})` );
};

const allowed = await subscribeTo( `${APP_ID}.private-allowed` );
check( 'webhook-approved private channel', allowed === 'allowed', allowed );

const denied = await subscribeTo( `${APP_ID}.private-denied` );
check( 'webhook-denied private channel', denied === 'denied', denied );

check( 'webhook received channel_name', seen.some( ( s ) => s.channel_name === 'private-allowed' ),
	JSON.stringify( seen[ 0 ] ?? {} ) );

server.close();
console.log( `\n${results.filter( Boolean ).length}/${results.length} passed` );
process.exit( results.every( Boolean ) ? 0 : 1 );
