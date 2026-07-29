/**
 * Demo configuration.
 *
 * Defaults are the throwaway credentials from resources/database/seed-dev.sql —
 * they are already committed to this repo and are not secrets. To point the demo
 * at your own app, copy .env.example to .env and fill in the values from
 * /dashboard/app/{appId}. Never commit a real app secret.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname( fileURLToPath( import.meta.url ) );

// Minimal .env reader — the demo stays zero-dependency, like the SDKs.
const envFile = path.join( here, '.env' );
if ( fs.existsSync( envFile ) ) {
	for ( const line of fs.readFileSync( envFile, 'utf8' ).split( '\n' ) ) {
		const m = line.match( /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/ );
		if ( m && !process.env[ m[ 1 ] ] ) {
			process.env[ m[ 1 ] ] = m[ 2 ].replace( /^["']|["']$/g, '' );
		}
	}
}

const env = process.env;

export default {
	appId:     env.PULSELY_APP_ID     || '22222222222222222222222222222222',
	appKey:    env.PULSELY_APP_KEY    || 'devkey123',
	appSecret: env.PULSELY_APP_SECRET || 'devsecret456',

	// Where the Pulsely server itself is running (see server.json).
	baseUrl:   env.PULSELY_BASE_URL   || 'http://127.0.0.1:8085',
	wsUrl:     env.PULSELY_WS_URL     || 'ws://127.0.0.1:8085/ws',

	port:      Number( env.PORT || 3000 ),

	// Channels this demo drives.
	publicChannel:  'orders',
	privateChannel: 'private-ops'
};
