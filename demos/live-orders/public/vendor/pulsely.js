/**
 * Connection-state observability, shaped like Pusher's `pusher.connection` so
 * app code never has to reach into the underlying STOMP.js client directly to
 * find out whether it's live — reaching into `bp.client` to set callbacks
 * directly is exactly the pattern that caused a page to go silently stale
 * after a refused subscribe (a client-set `onWebSocketClose` shadows the one
 * this SDK needs internally, since STOMP.js callback properties hold a single
 * handler each, not a list).
 *
 * States are 'initialized' (never connected), 'connecting', 'connected',
 * 'unavailable' (dropped or refused; STOMP.js will retry automatically), and
 * 'disconnected' (app code called disconnect() — terminal, no auto-retry).
 */
class PulselyConnection {

	constructor() {
		this.state = 'initialized';
		this._handlers = new Map();
	}

	bind( eventName, callback ) {
		if ( !this._handlers.has( eventName ) ) {
			this._handlers.set( eventName, [] );
		}
		this._handlers.get( eventName ).push( callback );
		return this;
	}

	unbind( eventName, callback ) {
		if ( !this._handlers.has( eventName ) ) {
			return this;
		}
		if ( !callback ) {
			this._handlers.delete( eventName );
			return this;
		}
		this._handlers.set(
			eventName,
			this._handlers.get( eventName ).filter( ( fn ) => fn !== callback )
		);
		return this;
	}

	/**
	 * No-ops when the state hasn't actually changed, so a STOMP ERROR frame
	 * (which classifies as 'unavailable') immediately followed by the socket
	 * close it causes (also 'unavailable') fires listeners once, not twice —
	 * and the error message from the frame is what callers see.
	 */
	_transition( next, extra = {} ) {
		if ( next === this.state ) return;
		const previous = this.state;
		this.state = next;
		if ( Pulsely.logToConsole ) {
			console.log( '[Pulsely] connection:', previous, '->', next, extra );
		}
		for ( const fn of this._handlers.get( 'state_change' ) || [] ) {
			fn( { previous, current: next, ...extra } );
		}
	}

}

/**
 * Pulsely browser SDK.
 *
 * A thin facade over STOMP.js. Customers work in their own channel names; the
 * `{appId}.` destination prefix is added on subscribe and stripped on delivery,
 * so one app's channel names can never collide with another's.
 *
 * Requires @stomp/stompjs to be loaded first.
 *
 *   const bp = new Pulsely('my-app-key', { authToken: '...' });
 *   bp.connection.bind('state_change', ({ previous, current }) => { ... });
 *   await bp.connect();
 *   bp.subscribe('orders');
 *   bp.bind('created', (data) => console.log(data));
 *   bp.bindGlobal((data, meta) => console.log(meta.event, data)); // everything
 *
 * Set Pulsely.logToConsole = true for a running trace of connection state,
 * subscribe/unsubscribe, and every dispatched event. Off by default.
 */
class Pulsely {

	static logToConsole = false;

	constructor( appKey, options = {} ) {
		if ( !appKey ) {
			throw new Error( 'Pulsely: appKey is required.' );
		}

		this.appKey = appKey;
		this.authToken = options.authToken || '';
		this.url = options.url || this._defaultUrl();

		this.appId = null;
		this.client = null;
		this.connection = new PulselyConnection();
		this._deliberateDisconnect = false;
		this.subscriptions = new Map();
		this.handlers = new Map();
		this.globalHandlers = [];
		// Populated on subscription_succeeded / presence.subscription_succeeded,
		// cleared on unsubscribe() — backs isSubscribed().
		this.subscribedChannels = new Set();
		// channelName -> Map(user_id -> member), kept in step with presence events
		// so members() is a local read rather than a round trip.
		this.presence = new Map();
	}

	/**
	 * Current members of a presence channel. Populated once
	 * `presence.subscription_succeeded` arrives, so call it from that handler or
	 * any later presence event.
	 */
	members( channelName ) {
		const roster = this.presence.get( channelName );
		return roster ? Array.from( roster.values() ) : [];
	}

	memberCount( channelName ) {
		const roster = this.presence.get( channelName );
		return roster ? roster.size : 0;
	}

	/**
	 * True once the broker has confirmed the subscribe (subscription_succeeded,
	 * or presence.subscription_succeeded for presence channels) — not merely
	 * "subscribe() was called", which only means it was requested. A refused
	 * private/presence channel never sets this.
	 */
	isSubscribed( channelName ) {
		return this.subscribedChannels.has( channelName );
	}

	_defaultUrl() {
		const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${scheme}//${window.location.host}/ws`;
	}

	_log( ...args ) {
		if ( Pulsely.logToConsole ) {
			console.log( '[Pulsely]', ...args );
		}
	}

	/**
	 * The broker returns the resolved app id as a CONNECTED header, which is what
	 * lets the facade build destinations without the customer ever seeing an id.
	 */
	connect() {
		this._deliberateDisconnect = false;
		this.connection._transition( 'connecting' );

		return new Promise( ( resolve, reject ) => {
			this.client = new StompJs.Client( {
				brokerURL: this.url,
				connectHeaders: {
					login: this.appKey,
					passcode: this.authToken
				},
				reconnectDelay: 5000,
				heartbeatIncoming: 10000,
				heartbeatOutgoing: 10000
			} );

			this.client.onConnect = ( frame ) => {
				this.appId = frame.headers[ 'connectionMetadata-appId' ];
				if ( !this.appId ) {
					reject( new Error( 'Pulsely: broker did not return an app id.' ) );
					return;
				}
				// A fresh CONNECT means any subscription handles left over from a
				// previous socket are dead, and the STOMP server has forgotten them
				// too. Clear the handles (keeping the channel names) so the loop
				// below actually resubscribes instead of seeing a stale truthy
				// handle in _openSubscription's guard and silently skipping it —
				// which otherwise leaves a reconnected client receiving nothing.
				for ( const channelName of this.subscriptions.keys() ) {
					this.subscriptions.set( channelName, null );
				}
				this.presence.clear();
				// Confirmed again per-channel by a fresh subscription_succeeded once
				// resubscribed below — not assumed to still hold from before.
				this.subscribedChannels.clear();

				// Re-establish any subscriptions requested before connect, and any
				// that were lost to a reconnect.
				for ( const channelName of this.subscriptions.keys() ) {
					this._openSubscription( channelName );
				}
				this.connection._transition( 'connected' );
				resolve( this );
			};

			// A STOMP ERROR frame (bad app key, or a subscribe an auth webhook
			// refused) precedes the broker closing the socket. Classify it as
			// 'unavailable' here, carrying the message; the onWebSocketClose that
			// follows a beat later is then a same-state no-op, so listeners get
			// the reason once instead of a reason-less close event overwriting it.
			this.client.onStompError = ( frame ) => {
				const message = frame.headers.message || 'Pulsely: connection refused.';
				this.connection._transition( 'unavailable', { error: message } );
				reject( new Error( message ) );
			};

			// A bad URL or an unreachable host never produces a STOMP frame at
			// all — without this, connect() would simply hang forever.
			this.client.onWebSocketError = () => {
				const message = 'Pulsely: could not reach the broker.';
				this.connection._transition( 'unavailable', { error: message } );
				reject( new Error( message ) );
			};

			this.client.onWebSocketClose = () => {
				this.connection._transition(
					this._deliberateDisconnect ? 'disconnected' : 'unavailable'
				);
			};

			this.client.activate();
		} );
	}

	subscribe( channelName ) {
		this._log( 'subscribe requested:', channelName );
		if ( !this.subscriptions.has( channelName ) ) {
			this.subscriptions.set( channelName, null );
		}
		if ( this.client && this.client.connected ) {
			this._openSubscription( channelName );
		}
		return this;
	}

	_openSubscription( channelName ) {
		if ( this.subscriptions.get( channelName ) ) {
			return;
		}
		const handle = this.client.subscribe(
			`${this.appId}.${channelName}`,
			( message ) => this._dispatch( channelName, message )
		);
		this.subscriptions.set( channelName, handle );
	}

	unsubscribe( channelName ) {
		this._log( 'unsubscribe:', channelName );
		const handle = this.subscriptions.get( channelName );
		if ( handle ) {
			handle.unsubscribe();
		}
		this.subscriptions.delete( channelName );
		this.presence.delete( channelName );
		this.subscribedChannels.delete( channelName );
		return this;
	}

	/**
	 * Publish directly from the browser, without a round trip through your server.
	 *
	 * Only works on `private-`/`presence-` channels you are already subscribed to,
	 * on apps with client events enabled, and the event name must start with
	 * `client-`. Other subscribers receive it; you do not get your own back.
	 */
	trigger( channelName, eventName, data = {} ) {
		if ( !this.client || !this.client.connected ) {
			throw new Error( 'Pulsely: connect() before trigger().' );
		}
		if ( !this.subscriptions.get( channelName ) ) {
			throw new Error( `Pulsely: subscribe to "${channelName}" before triggering on it.` );
		}
		if ( !eventName.startsWith( 'client-' ) ) {
			throw new Error( 'Pulsely: client event names must start with "client-".' );
		}

		this.client.publish( {
			destination: `${this.appId}.${channelName}`,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify( { event: eventName, data } )
		} );

		return this;
	}

	/**
	 * Sign in as a specific user, decoupled from the connection's original
	 * identity (the CONNECT-time passcode, if any) — a separate handshake, not
	 * another use of the same channel-auth token flow. `token` is minted the
	 * same way as a connect-time passcode — `{expires}.{userId}.{hmac}` — so
	 * your server's existing token-minting helper (e.g. the Node SDK's
	 * `authToken()`) works unchanged here too.
	 *
	 * Subscribes to the reserved `$signin` destination first if not already,
	 * since that's where the reply arrives — bind `signin.succeeded` /
	 * `signin.failed` before calling this to see the result.
	 */
	signin( token ) {
		if ( !this.client || !this.client.connected ) {
			throw new Error( 'Pulsely: connect() before signin().' );
		}
		this._log( 'signin requested' );
		this.subscribe( '$signin' );
		this.client.publish( {
			destination: `${this.appId}.$signin`,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify( { token } )
		} );
		return this;
	}

	/**
	 * Subscribe to the app-wide watchlist feed — `watchlist.online` /
	 * `watchlist.offline` for every signed-in user, independent of any one
	 * channel. No per-user filtering in this version: every transition for the
	 * whole app, not a chosen subset. Requires the same backend-minted
	 * ops-identity token the dashboard's own `$ops` feed does — an ordinary
	 * end-user connection cannot see who else is online.
	 */
	watch() {
		this.subscribe( '$watchlist' );
		return this;
	}

	bind( eventName, callback ) {
		if ( !this.handlers.has( eventName ) ) {
			this.handlers.set( eventName, [] );
		}
		this.handlers.get( eventName ).push( callback );
		return this;
	}

	unbind( eventName, callback ) {
		if ( !this.handlers.has( eventName ) ) {
			return this;
		}
		if ( !callback ) {
			this.handlers.delete( eventName );
			return this;
		}
		this.handlers.set(
			eventName,
			this.handlers.get( eventName ).filter( ( fn ) => fn !== callback )
		);
		return this;
	}

	/**
	 * Fires for every event on every channel, named or not — for tooling that
	 * doesn't know event names ahead of time (a raw event log, analytics, a
	 * debug console), not something typical app code needs since it usually
	 * knows its own event names upfront. Same (data, meta) shape as bind();
	 * the event name is meta.event rather than a separate first argument, so a
	 * handler can be passed to both bind() and bindGlobal() unchanged.
	 */
	bindGlobal( callback ) {
		this.globalHandlers.push( callback );
		return this;
	}

	unbindGlobal( callback ) {
		if ( !callback ) {
			this.globalHandlers = [];
			return this;
		}
		this.globalHandlers = this.globalHandlers.filter( ( fn ) => fn !== callback );
		return this;
	}

	_dispatch( channelName, message ) {
		let envelope;
		try {
			envelope = JSON.parse( message.body );
		} catch ( e ) {
			return;
		}

		this._log( 'dispatch:', channelName, envelope.event, envelope.data );

		this._trackPresence( channelName, envelope );

		if ( envelope.event === 'subscription_succeeded' || envelope.event === 'presence.subscription_succeeded' ) {
			this.subscribedChannels.add( channelName );
		} else if ( envelope.event === 'subscription_error' ) {
			this.subscribedChannels.delete( channelName );
		}

		const meta = {
			channel: channelName,
			event: envelope.event,
			replayed: envelope.replayed === true,
			// True when another client published this, rather than your server.
			// Treat the payload as untrusted input when it is.
			fromClient: envelope.client === true
		};

		const callbacks = this.handlers.get( envelope.event ) || [];
		for ( const fn of callbacks ) {
			fn( envelope.data, meta );
		}

		for ( const fn of this.globalHandlers ) {
			fn( envelope.data, meta );
		}
	}

	/**
	 * Keeps the local roster in step so handlers can call members() and see the
	 * channel as it is *after* the event they were just told about.
	 */
	_trackPresence( channelName, envelope ) {
		const data = envelope.data || {};

		if ( envelope.event === 'presence.subscription_succeeded' ) {
			const roster = new Map();
			for ( const member of data.members || [] ) {
				roster.set( member.user_id, member );
			}
			this.presence.set( channelName, roster );
			return;
		}

		if ( envelope.event === 'presence.member_added' && data.member ) {
			if ( !this.presence.has( channelName ) ) this.presence.set( channelName, new Map() );
			this.presence.get( channelName ).set( data.member.user_id, data.member );
			return;
		}

		if ( envelope.event === 'presence.member_removed' && data.member ) {
			const roster = this.presence.get( channelName );
			if ( roster ) roster.delete( data.member.user_id );
		}
	}

	disconnect() {
		this._deliberateDisconnect = true;
		if ( this.client ) {
			this.client.deactivate();
		}
		this.subscriptions.clear();
		this.presence.clear();
		this.subscribedChannels.clear();
		return this;
	}

}

if ( typeof module !== 'undefined' && module.exports ) {
	module.exports = Pulsely;
}
