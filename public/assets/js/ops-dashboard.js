/**
 * Drives the app dashboard's live tiles and activity feed.
 *
 * Uses the same public SDK customers use — the dashboard subscribes to the app's
 * reserved `$ops` channel with a short-lived token minted server-side.
 */
( function () {
	'use strict';

	const reveal = document.getElementById( 'revealSecret' );
	if ( reveal ) {
		reveal.addEventListener( 'click', () => {
			const el = document.getElementById( 'appSecret' );
			const hidden = el.textContent.startsWith( '•' );
			el.textContent = hidden ? el.dataset.secret : '••••••••••••••••';
			el.classList.toggle( 'secret', !hidden );
			reveal.textContent = hidden ? 'Hide' : 'Reveal';
		} );
	}

	const config = document.getElementById( 'opsConfig' );
	if ( !config ) return;

	const appKey = config.dataset.appKey;
	const opsToken = config.dataset.opsToken;
	const opsChannel = config.dataset.opsChannel;

	const statusEl = document.getElementById( 'liveStatus' );
	const statusText = statusEl ? statusEl.querySelector( '.live-text' ) : null;
	const tileMessages = document.getElementById( 'tileMessages' );
	const tileConnections = document.getElementById( 'tileConnections' );
	const feed = document.getElementById( 'feed' );

	function setStatus( state, text ) {
		if ( !statusEl ) return;
		statusEl.dataset.state = state;
		if ( statusText ) statusText.textContent = text;
	}

	function flash( el ) {
		if ( !el ) return;
		el.classList.remove( 'flash' );
		// Force reflow so the animation restarts on repeated updates.
		void el.offsetWidth;
		el.classList.add( 'flash' );
	}

	function addFeedItem( { time, channel, event } ) {
		if ( !feed ) return;
		const empty = document.getElementById( 'feedEmpty' );
		if ( empty ) empty.remove();

		const li = document.createElement( 'li' );
		li.className = 'feed-item is-new';
		li.innerHTML =
			'<span class="feed-time"></span>' +
			'<span class="feed-chan"></span>' +
			'<span class="feed-event"></span>';
		li.querySelector( '.feed-time' ).textContent = time;
		li.querySelector( '.feed-chan' ).textContent = channel;
		li.querySelector( '.feed-event' ).textContent = event;

		feed.prepend( li );
		while ( feed.children.length > 30 ) feed.lastElementChild.remove();
	}

	const bp = new Pulsely( appKey, { authToken: opsToken } );

	bp.bind( 'message.published', ( data ) => {
		if ( typeof data.messagesToday === 'number' ) {
			tileMessages.textContent = data.messagesToday.toLocaleString();
			flash( tileMessages );
		}
		addFeedItem( {
			time: data.at || new Date().toLocaleTimeString(),
			channel: data.channel || '',
			event: data.event || ''
		} );
	} );

	bp.bind( 'connections.changed', ( data ) => {
		tileConnections.textContent = Number( data.current || 0 ).toLocaleString();
		flash( tileConnections );
	} );

	// Event-driven rather than a one-shot .then()/.catch(): a dropped connection
	// auto-reconnects (STOMP.js's own retry), and without this the banner would
	// keep reading "Live" forever after the underlying socket actually died.
	bp.connection.bind( 'state_change', ( { current, error } ) => {
		if ( current === 'connecting' ) {
			setStatus( 'connecting', 'Connecting to live feed…' );
		} else if ( current === 'connected' ) {
			setStatus( 'live', 'Live' );
			// The dashboard's own socket is itself a connection, so the first count
			// only arrives once another client connects or disconnects. Seed it.
			if ( tileConnections.textContent === '—' ) tileConnections.textContent = '1';
		} else if ( current === 'unavailable' ) {
			setStatus( error ? 'error' : 'connecting', error ? `Live feed unavailable: ${error}` : 'Reconnecting…' );
		} else if ( current === 'disconnected' ) {
			setStatus( 'error', 'Live feed disconnected.' );
		}
	} );

	// A connect failure is already reflected by the state_change listener above;
	// this catch exists only so the rejection doesn't surface as an unhandled
	// promise rejection in the console.
	bp.connect().then( () => bp.subscribe( opsChannel ) ).catch( () => {} );

	window.addEventListener( 'beforeunload', () => bp.disconnect() );
} )();
