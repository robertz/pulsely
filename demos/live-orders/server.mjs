/**
 * Live Orders — a self-contained Pulsely demo.
 *
 *   node server.mjs      →  http://127.0.0.1:3000
 *
 * Plays all three roles a real integration has:
 *
 *   1. the customer backend  — signs and publishes events via the server SDK
 *   2. the token minter      — hands the browser a short-lived connection token
 *   3. the auth endpoint     — answers Pulsely's private/presence auth webhook
 *
 * Zero dependencies, Node 18+.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Pulsely, { PulselyError } from './pulsely.mjs';
import config from './config.mjs';

const here = path.dirname( fileURLToPath( import.meta.url ) );
const webRoot = path.join( here, 'public' );

const bp = new Pulsely( {
	appId:     config.appId,
	appKey:    config.appKey,
	appSecret: config.appSecret,
	baseUrl:   config.baseUrl
} );

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js':   'text/javascript; charset=utf-8',
	'.mjs':  'text/javascript; charset=utf-8',
	'.css':  'text/css; charset=utf-8',
	'.svg':  'image/svg+xml',
	'.ico':  'image/x-icon'
};

const PRODUCTS = [
	[ 'Aeropress Go',        3400 ], [ 'Burr grinder',      12900 ],
	[ 'Ethiopia Yirgacheffe', 1850 ], [ 'Gooseneck kettle',  8900 ],
	[ 'Chemex 6-cup',         4600 ], [ 'Colombia Huila',    1650 ],
	[ 'Scale w/ timer',       5200 ], [ 'Paper filters',      900 ]
];
const CITIES = [ 'Austin', 'Lisbon', 'Osaka', 'Toronto', 'Berlin', 'Bogotá', 'Perth' ];

const pick = ( xs ) => xs[ Math.floor( Math.random() * xs.length ) ];
let orderSeq = 1000;

function makeOrder() {
	const [ item, unit ] = pick( PRODUCTS );
	const qty = 1 + Math.floor( Math.random() * 3 );
	return {
		id:    ++orderSeq,
		item,
		qty,
		total: unit * qty,
		city:  pick( CITIES ),
		at:    new Date().toISOString()
	};
}

function send( res, status, body, type = 'application/json' ) {
	const payload = type.startsWith( 'application/json' ) ? JSON.stringify( body ) : body;
	res.writeHead( status, { 'Content-Type': type, 'Cache-Control': 'no-store' } );
	res.end( payload );
}

function readBody( req ) {
	return new Promise( ( resolve ) => {
		let raw = '';
		req.on( 'data', ( c ) => { raw += c; } );
		req.on( 'end', () => {
			try { resolve( raw ? JSON.parse( raw ) : {} ); } catch { resolve( {} ); }
		} );
	} );
}

/* ------------------------------------------------------------------ static */

function serveStatic( req, res, urlPath ) {
	const rel = urlPath === '/' ? 'index.html' : urlPath.replace( /^\/+/, '' );
	// Resolve then confirm containment, so ../ cannot escape the web root.
	const file = path.resolve( webRoot, rel );
	if ( !file.startsWith( webRoot + path.sep ) ) {
		return send( res, 403, { error: 'Forbidden' } );
	}
	fs.readFile( file, ( err, buf ) => {
		if ( err ) return send( res, 404, { error: 'Not found' } );
		send( res, 200, buf, MIME[ path.extname( file ) ] || 'application/octet-stream' );
	} );
}

/* ------------------------------------------------------------------ routes */

const routes = {

	/**
	 * What the browser is allowed to know: the public app key and the socket URL.
	 * The app secret deliberately never appears here.
	 */
	'GET /api/config': async ( req, res ) => {
		send( res, 200, {
			appKey:         config.appKey,
			wsUrl:          config.wsUrl,
			publicChannel:  config.publicChannel,
			privateChannel: config.privateChannel
		} );
	},

	/**
	 * Role 2: mint a connection token. In a real app this is gated by your own
	 * session — here any caller may claim any name, which is the point of a demo
	 * and exactly what you would not ship.
	 */
	'POST /api/token': async ( req, res ) => {
		const { userId = 'guest' } = await readBody( req );
		send( res, 200, { token: bp.authToken( String( userId ).slice( 0, 40 ), 3600 ) } );
	},

	/**
	 * Role 1: publish. The browser asks for an event; the *server* signs it. A
	 * client can never publish directly — the broker rejects a STOMP SEND.
	 */
	'POST /api/publish': async ( req, res ) => {
		const body = await readBody( req );
		const channel = body.channel === config.privateChannel
			? config.privateChannel
			: config.publicChannel;

		const event = channel === config.privateChannel ? 'note' : 'created';
		const data  = channel === config.privateChannel
			? { text: String( body.text || 'ops ping' ).slice( 0, 200 ), at: new Date().toISOString() }
			: makeOrder();

		try {
			const result = await bp.trigger( channel, event, data );
			send( res, 200, { ok: true, channel, event, data, result } );
		} catch ( err ) {
			// Surfaced verbatim: a 401 here almost always means the app secret in
			// .env does not match the app id, and hiding that wastes an afternoon.
			const status = err instanceof PulselyError && err.status ? err.status : 500;
			send( res, status, { ok: false, error: err.message } );
		}
	},

	/**
	 * Role 3: the auth endpoint Pulsely calls before allowing a subscribe to a
	 * private- or presence- channel. Returning authorized:false is what a real
	 * policy check looks like when it says no.
	 */
	'POST /dev-auth': async ( req, res ) => {
		const body = await readBody( req );
		const userId = body.user_token || body.userId || '';

		// Demo policy: you must have presented a connection token. Anonymous
		// subscribers get a clean, observable refusal.
		if ( !userId ) {
			return send( res, 200, bp.authorizeChannel( { authorized: false } ) );
		}

		send( res, 200, bp.authorizeChannel( {
			authorized: true,
			userId,
			userInfo: { name: userId, joinedAt: new Date().toISOString() }
		} ) );
	}
};

/* ------------------------------------------------------------------ server */

const server = http.createServer( ( req, res ) => {
	const urlPath = new URL( req.url, 'http://localhost' ).pathname;
	const route = routes[ `${req.method} ${urlPath}` ];

	if ( route ) {
		route( req, res ).catch( ( err ) => send( res, 500, { error: err.message } ) );
		return;
	}
	if ( req.method === 'GET' ) return serveStatic( req, res, urlPath );

	send( res, 405, { error: 'Method not allowed' } );
} );

server.listen( config.port, '127.0.0.1', () => {
	console.log( `\n  Live Orders demo   http://127.0.0.1:${config.port}` );
	console.log( `  Pulsely server     ${config.baseUrl}` );
	console.log( `  App id             ${config.appId}` );
	console.log( `  Auth endpoint      http://127.0.0.1:${config.port}/dev-auth\n` );
} );
