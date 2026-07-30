/**
 * End-to-end check of the channel-listing API against a real WebSocket
 * subscription, so occupancy reflects an actual live subscriber rather than
 * a mocked broker.
 */
import crypto from 'node:crypto';

const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8085/ws';
const HTTP = process.env.HTTP || 'http://127.0.0.1:8085';
const APP_KEY = 'devkey123';
const APP_ID = '22222222222222222222222222222222';
const APP_SECRET = 'devsecret456';
const CHANNEL = 'chanlist-demo';

const NULL = String.fromCharCode( 0 );
const frame = ( command, headers = {}, body = '' ) =>
	command + '\n' +
	Object.entries( headers ).map( ( [ k, v ] ) => `${k}:${v}` ).join( '\n' ) +
	( Object.keys( headers ).length ? '\n' : '' ) + '\n' + body + NULL;

function open( login ) {
	return new Promise( ( resolve ) => {
		const ws = new globalThis.WebSocket( WS_URL );
		ws.addEventListener( 'error', () => {} );
		ws.addEventListener( 'close', () => {} );
		ws.addEventListener( 'open', () => {
			ws.send( frame( 'CONNECT', { 'accept-version': '1.2', host: 'localhost', login } ) );
		} );
		setTimeout( () => resolve( ws ), 300 );
	} );
}

function sign( method, routePath, body = '' ) {
	const ts = Math.floor( Date.now() / 1000 ).toString();
	const bodyHash = crypto.createHash( 'sha256' ).update( body ).digest( 'hex' );
	const signing = `${method}\n${routePath}\n${ts}\n${bodyHash}`;
	const sig = crypto.createHmac( 'sha256', APP_SECRET ).update( signing ).digest( 'hex' );
	return { ts, sig };
}

async function callGet( path, overrides = {} ) {
	const routePath = path.split( '?' )[ 0 ];
	const { ts, sig } = sign( 'GET', routePath );
	const res = await fetch( `${HTTP}${path}`, {
		headers: {
			'X-Pulsely-Timestamp': overrides.ts ?? ts,
			'X-Pulsely-Signature': overrides.sig ?? sig
		}
	} );
	return { status: res.status, body: await res.json() };
}

const results = [];
const check = ( label, pass, detail = '' ) => {
	results.push( { label, pass, detail } );
	console.log( `${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}` );
};

/* -------------------------------------------------------------- baseline */

const before = await callGet( `/apps/${APP_ID}/channels` );
check( 'not occupied before subscribing', !( CHANNEL in ( before.body.channels || {} ) ), JSON.stringify( before.body ) );

const detailBefore = await callGet( `/apps/${APP_ID}/channels/${CHANNEL}` );
check(
	'single-channel detail reports unoccupied',
	detailBefore.status === 200 && detailBefore.body.occupied === false && detailBefore.body.subscription_count === 0,
	JSON.stringify( detailBefore.body )
);

/* --------------------------------------------------------- occupied path */

const ws = await open( APP_KEY );
ws.send( frame( 'SUBSCRIBE', { id: 'sub-0', destination: `${APP_ID}.${CHANNEL}` } ) );
await new Promise( ( r ) => setTimeout( r, 500 ) );

const during = await callGet( `/apps/${APP_ID}/channels` );
check(
	'appears in the list once subscribed',
	CHANNEL in ( during.body.channels || {} ),
	JSON.stringify( during.body )
);

const detailDuring = await callGet( `/apps/${APP_ID}/channels/${CHANNEL}` );
check(
	'single-channel detail reports occupied with a count',
	detailDuring.status === 200 && detailDuring.body.occupied === true && detailDuring.body.subscription_count === 1,
	JSON.stringify( detailDuring.body )
);

const filtered = await callGet( `/apps/${APP_ID}/channels?filter_by_prefix=presence-` );
check(
	'filter_by_prefix excludes a non-matching channel',
	filtered.status === 200 && !( CHANNEL in ( filtered.body.channels || {} ) ),
	JSON.stringify( filtered.body )
);

ws.close();
await new Promise( ( r ) => setTimeout( r, 500 ) );

const after = await callGet( `/apps/${APP_ID}/channels` );
check(
	'vacates the list once the socket closes',
	!( CHANNEL in ( after.body.channels || {} ) ),
	JSON.stringify( after.body )
);

/* ------------------------------------------------------------ guardrails */

const badSig = await callGet( `/apps/${APP_ID}/channels`, { sig: 'not-a-real-signature' } );
check( 'wrong signature refused', badSig.status === 401, badSig.status );

const staleTs = sign( 'GET', `/apps/${APP_ID}/channels` );
const stale = await callGet( `/apps/${APP_ID}/channels`, { ts: String( Math.floor( Date.now() / 1000 ) - 4000 ), sig: staleTs.sig } );
check( 'stale timestamp refused', stale.status === 401, stale.status );

const unknownApp = await callGet( '/apps/99999999999999999999999999999999/channels' );
check( 'unknown app refused', unknownApp.status === 404, unknownApp.status );

const dotted = await callGet( `/apps/${APP_ID}/channels/a.b` );
check( 'dotted channel name refused', dotted.status === 400, dotted.status );

const reserved = await callGet( `/apps/${APP_ID}/channels/$ops` );
check( 'reserved channel name refused', reserved.status === 400, reserved.status );

const failed = results.filter( ( r ) => !r.pass );
console.log( `\n${results.length - failed.length}/${results.length} passed` );
process.exit( failed.length ? 1 : 0 );
