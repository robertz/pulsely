/**
 * Pulsely server SDK for Node.js — zero dependencies.
 *
 *   import Pulsely from './pulsely.mjs';
 *
 *   const bp = new Pulsely( {
 *     appId:     process.env.PULSELY_APP_ID,
 *     appKey:    process.env.PULSELY_APP_KEY,
 *     appSecret: process.env.PULSELY_APP_SECRET,
 *     baseUrl:   'https://pulsely.example.com'
 *   } );
 *
 *   await bp.trigger( 'orders', 'created', { id: 42 } );
 *
 * The app secret must never reach a browser.
 */
import crypto from 'node:crypto';

export class PulselyError extends Error {
	constructor( message, status, body ) {
		super( message );
		this.name = 'PulselyError';
		this.status = status;
		this.body = body;
	}
}

export default class Pulsely {

	constructor( { appId, appKey, appSecret, baseUrl = 'http://127.0.0.1:8085', timeoutMs = 10000 } = {} ) {
		if ( !appId || !appSecret ) {
			throw new PulselyError( 'Pulsely: appId and appSecret are required.' );
		}
		this.appId = appId;
		this.appKey = appKey;
		this.appSecret = appSecret;
		this.baseUrl = baseUrl.replace( /\/+$/, '' );
		this.timeoutMs = timeoutMs;
	}

	/**
	 * Publish an event to a channel.
	 *
	 * @throws {PulselyError} on any non-2xx, carrying status and parsed body.
	 */
	async trigger( channel, event, data = {} ) {
		// Serialize once and send exactly these bytes. Re-serializing for the
		// request risks a different key order and a signature that no longer
		// matches the body — the most common cause of a puzzling 401.
		const payload = JSON.stringify( { channel, event, data } );
		const path = `/apps/${this.appId}/events`;
		const timestamp = String( Math.floor( Date.now() / 1000 ) );  // epoch SECONDS, UTC

		const controller = new AbortController();
		const timer = setTimeout( () => controller.abort(), this.timeoutMs );

		let res;
		try {
			res = await fetch( this.baseUrl + path, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Pulsely-Timestamp': timestamp,
					'X-Pulsely-Signature': this.#sign( path, timestamp, payload )
				},
				body: payload,
				signal: controller.signal
			} );
		} catch ( err ) {
			throw new PulselyError( `Pulsely: request failed — ${err.message}`, 0, null );
		} finally {
			clearTimeout( timer );
		}

		const text = await res.text();
		let body;
		try { body = JSON.parse( text ); } catch { body = text; }

		if ( !res.ok ) {
			throw new PulselyError(
				`Pulsely: publish rejected (${res.status}) — ${body?.error ?? text}`,
				res.status, body
			);
		}
		return body;
	}

	/**
	 * Mint a short-lived connection token for a browser.
	 *
	 * The browser presents this as the STOMP passcode; it establishes the identity
	 * your auth endpoint later sees as `user_token`. Public channels need no token.
	 */
	authToken( userId, ttlSeconds = 3600 ) {
		if ( !this.appKey ) {
			throw new PulselyError( 'Pulsely: appKey is required to mint connection tokens.' );
		}
		const expires = Math.floor( Date.now() / 1000 ) + ttlSeconds;
		const signature = crypto
			.createHmac( 'sha256', this.appSecret )
			.update( `${this.appKey}:${expires}:${userId}` )
			.digest( 'hex' );

		return `${expires}.${userId}.${signature}`;
	}

	/**
	 * Build the response your auth endpoint returns when Pulsely asks whether a
	 * subscriber may join a private or presence channel.
	 *
	 * Presence channels need userId; user_info is echoed to every other member.
	 */
	authorizeChannel( { authorized = true, userId = '', userInfo = {} } = {} ) {
		return { authorized, user_id: String( userId ), user_info: userInfo };
	}

	/**
	 * Verify an inbound event webhook really came from Pulsely.
	 *
	 *   if ( !bp.verifyWebhook( rawBody, req.headers ) ) return res.sendStatus( 401 );
	 *
	 * Pass the RAW request body, not a re-serialized object.
	 */
	verifyWebhook( rawBody, headers = {}, toleranceSeconds = 300 ) {
		const timestamp = headers[ 'x-pulsely-timestamp' ] ?? headers[ 'X-Pulsely-Timestamp' ];
		const signature = headers[ 'x-pulsely-signature' ] ?? headers[ 'X-Pulsely-Signature' ];
		if ( !timestamp || !signature ) return false;

		if ( Math.abs( Math.floor( Date.now() / 1000 ) - Number( timestamp ) ) > toleranceSeconds ) {
			return false;
		}

		const expected = this.#sign( '/webhook', String( timestamp ), rawBody );
		const a = Buffer.from( expected );
		const b = Buffer.from( String( signature ) );
		return a.length === b.length && crypto.timingSafeEqual( a, b );
	}

	#sign( path, timestamp, payload ) {
		const bodyHash = crypto.createHash( 'sha256' ).update( payload ).digest( 'hex' );
		// Joined by real newlines, not the two characters backslash-n.
		const signingString = `POST\n${path}\n${timestamp}\n${bodyHash}`;
		return crypto.createHmac( 'sha256', this.appSecret ).update( signingString ).digest( 'hex' );
	}

}
